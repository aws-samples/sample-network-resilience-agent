import { useCallback, useMemo } from 'react';
import type { NodeProps } from '@xyflow/react';
import type { DxNodeData } from '../../types/topology';
import { BaseNode } from './BaseNode';
import { LiveStatusDot } from './LiveStatusDot';
import { DxgwRouteDiffPanel } from './DxgwRouteDiffPanel';
import { DxGatewayIcon } from './aws-icons';
import { useTopologyStore } from '../../store/topology-store';
import { useRedact } from '../../utils/redact';
import { COLORS } from '../../utils/colors';
import { computeDxgwRouteDiff } from '../../engine/vif-route-diff';

export function DxGatewayNode({ id, data }: NodeProps) {
  const d = data as DxNodeData;
  const r = useRedact();
  const showLiveStatus = useTopologyStore((s) => s.showLiveStatus);
  const state = d.details?.state;
  const dxGatewayId = d.resourceId;

  // Cross-VIF route comparison. Reads the same vifRoutes the per-VIF Routes panel
  // uses — no extra API call of its own — and lives inside the live-status layer,
  // which is what triggers that fetch. The `⚠ N` gap count therefore appears with
  // live mode; the click below only has to run the fetch itself when the automatic
  // one was skipped or had not finished.
  const topologyData = useTopologyStore((s) => s.topologyData);
  const vifRoutesFetched = useTopologyStore((s) => s.vifRoutesCache != null);
  const vifRoutesLoading = useTopologyStore((s) => s.vifRoutesLoading);
  const vifRoutesError = useTopologyStore((s) => s.vifRoutesError);
  const loadVifRoutes = useTopologyStore((s) => s.loadVifRoutes);
  const toggleDxgwRouteDiffPanel = useTopologyStore((s) => s.toggleDxgwRouteDiffPanel);
  const isDiffOpen = useTopologyStore(
    (s) => dxGatewayId != null && s.expandedDxgwRouteDiffPanels.has(dxGatewayId),
  );

  // Recommended (ghost) gateways describe infrastructure that does not exist, so
  // they have no routes to compare.
  const comparable = !d.isRecommended && dxGatewayId != null;
  // Before routes are fetched there is nothing to compare, but the button must
  // still appear so the click can trigger the fetch — the same shape as the
  // per-VIF Routes button. Gate it on the gateway actually having redundant VIFs,
  // which is knowable without route data.
  const redundantVifCount = useMemo(() => {
    if (!comparable || !topologyData) return 0;
    return topologyData.virtualInterfaces.filter((v) => v.directConnectGatewayId === dxGatewayId).length;
  }, [comparable, topologyData, dxGatewayId]);

  const diff = useMemo(
    () => (comparable && topologyData && vifRoutesFetched
      ? computeDxgwRouteDiff(topologyData, dxGatewayId)
      : null),
    [comparable, topologyData, vifRoutesFetched, dxGatewayId],
  );

  const onDiffClick = useCallback(async () => {
    if (!dxGatewayId) return;
    if (!useTopologyStore.getState().vifRoutesCache) {
      await loadVifRoutes();
      // Nothing came back (permission denied, no routes) — opening an empty
      // panel would look broken.
      if (!useTopologyStore.getState().vifRoutesCache) return;
    }
    toggleDxgwRouteDiffPanel(dxGatewayId);
  }, [dxGatewayId, loadVifRoutes, toggleDxgwRouteDiffPanel]);

  // Only worth a button when two or more VIFs share the gateway: a single-VIF
  // gateway has nothing to compare against, and the resiliency rules already
  // flag it as a single point of failure in its own right. Once routes are
  // fetched, defer to the diff — fewer than two VIFs returned routes means the
  // comparison is genuinely unavailable, not merely unfetched.
  const showDiffButton =
    showLiveStatus
    && comparable
    && redundantVifCount >= 2
    && (vifRoutesFetched ? diff != null : true);

  // Both counts are gaps in failover coverage, so the badge adds them: a "✓" on a
  // gateway with a partly-covered aggregate would assert redundancy the routes
  // don't show. The panel keeps them distinct because the fix differs.
  const soloCount = diff?.totalSolo ?? 0;
  const partialCount = diff?.totalPartial ?? 0;
  const gapCount = soloCount + partialCount;

  return (
    <BaseNode
      nodeId={id}
      label={d.label}
      subtitle="Direct Connect Gateway"
      icon={<DxGatewayIcon />}
      isRecommended={d.isRecommended}
      borderColor="#8B5CF6"
      bgColor="#1e1033"
      badges={d.badges}
    >
      {d.isOrphan && (
        <span
          className="inline-block rounded-sm px-1 py-0 text-[8px] font-bold uppercase tracking-wide text-white"
          style={{ backgroundColor: COLORS.severity.warning }}
        >
          Unattached
        </span>
      )}
      {d.resourceId && (
        <span
          className="text-[9px] text-slate-500 font-tech block max-w-full overflow-hidden text-ellipsis whitespace-nowrap"
          title={r(d.resourceId)}
        >
          {r(d.resourceId)}
        </span>
      )}
      {d.details?.asn && (
        <span className="text-[9px] text-slate-400 font-tech">{r(`ASN: ${d.details.asn}`)}</span>
      )}
      {showLiveStatus && <LiveStatusDot state={state} />}
      {showDiffButton && (
        <button
          onClick={(e) => { e.stopPropagation(); void onDiffClick(); }}
          onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
          onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
          disabled={vifRoutesLoading}
          className="text-[8px] mt-0.5 flex items-center gap-0.5 self-end nodrag"
          style={{
            color: vifRoutesError && !vifRoutesFetched
              ? COLORS.severity.warning
              : gapCount > 0
                ? COLORS.severity.critical
                : '#a78bfa',
            cursor: vifRoutesLoading ? 'wait' : 'pointer',
          }}
          title={
            vifRoutesError && !vifRoutesFetched
              ? `BGP routes unavailable: ${vifRoutesError}`
              : !vifRoutesFetched
                ? `Compare accepted prefixes across the ${redundantVifCount} VIFs on this gateway (fetches BGP routes)`
                : gapCount > 0
                  ? [
                      soloCount > 0
                        ? `${soloCount} prefix${soloCount === 1 ? '' : 'es'} carried by only one VIF — no backup path`
                        : null,
                      partialCount > 0
                        ? `${partialCount} prefix${partialCount === 1 ? '' : 'es'} only partly carried by another VIF`
                        : null,
                    ].filter(Boolean).join('; ')
                  : 'Every prefix on this gateway is carried by more than one VIF'
          }
        >
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
            <line x1="2" y1="3.5" x2="10" y2="3.5" />
            <line x1="2" y1="6" x2="7" y2="6" />
            <line x1="2" y1="8.5" x2="10" y2="8.5" />
          </svg>
          Route diff
          {vifRoutesLoading ? (
            <span className="opacity-70">…</span>
          ) : vifRoutesFetched ? (
            gapCount > 0 ? <span className="font-bold">⚠ {gapCount}</span> : <span className="opacity-70">✓</span>
          ) : null}
          {vifRoutesFetched && <span>{isDiffOpen ? '▴' : '▾'}</span>}
        </button>
      )}
      {isDiffOpen && diff && dxGatewayId && (
        <DxgwRouteDiffPanel
          diff={diff}
          gatewayName={d.label}
          nodeId={id}
          dxGatewayId={dxGatewayId}
          onClose={() => toggleDxgwRouteDiffPanel(dxGatewayId)}
        />
      )}
    </BaseNode>
  );
}
