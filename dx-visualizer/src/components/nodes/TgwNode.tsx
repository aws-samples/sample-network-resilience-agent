import { useCallback, useMemo } from 'react';
import type { NodeProps } from '@xyflow/react';
import { Handle, Position } from '@xyflow/react';
import type { DxNodeData } from '../../types/topology';
import { BaseNode } from './BaseNode';
import { LiveStatusDot } from './LiveStatusDot';
import { TransitGatewayIcon } from './aws-icons';
import { useTopologyStore } from '../../store/topology-store';
import { useRedact } from '../../utils/redact';
import { TgwRoutePanel } from './TgwRoutePanel';
import { DxgwRouteDiffPanel } from './DxgwRouteDiffPanel';
import { assessTgwRouteResilience } from '../../engine/tgw-route-resilience';
import { COLORS } from '../../utils/colors';

export function TgwNode({ id, data }: NodeProps) {
  const d = data as DxNodeData;
  const r = useRedact();
  const showLiveStatus = useTopologyStore((s) => s.showLiveStatus);
  const theme = useTopologyStore((s) => s.theme);
  const isExpanded = useTopologyStore((s) => s.expandedTgwRoutePanels.has(d.resourceId ?? ''));
  const togglePanel = useTopologyStore((s) => s.toggleTgwRoutePanel);
  const routeTables = useTopologyStore((s) => s.topologyData?.tgwRouteTables.get(d.resourceId ?? ''));
  const isCrossAccount = d.details?.crossAccount === 'true';
  const state = d.details?.state;
  const accountColor = theme === 'light' ? '#d97706' : '#fbbf24';

  // Route resilience: every on-prem prefix reaching this TGW, graded across all
  // the transit VIFs of every DX gateway feeding it. Live-gated like the DX
  // gateway's Route diff, and reads the same vifRoutes — no API call of its own.
  const tgwId = d.resourceId;
  const topologyData = useTopologyStore((s) => s.topologyData);
  const feeders = useTopologyStore((s) => s.assessment?.perTgw.find((t) => t.tgwId === tgwId));
  const vifRoutesFetched = useTopologyStore((s) => s.vifRoutesCache != null);
  const vifRoutesLoading = useTopologyStore((s) => s.vifRoutesLoading);
  const vifRoutesError = useTopologyStore((s) => s.vifRoutesError);
  const loadVifRoutes = useTopologyStore((s) => s.loadVifRoutes);
  const toggleResilience = useTopologyStore((s) => s.toggleTgwRouteDiffPanel);
  const isResilienceOpen = useTopologyStore((s) => tgwId != null && s.expandedTgwRouteDiffPanels.has(tgwId));
  const feederIds = useMemo(() => new Set(feeders?.dxGatewayIds ?? []), [feeders]);
  // The same assessment the report and the chat context state, so the badge
  // can never count differently from them.
  const resilience = useMemo(
    () => (topologyData && vifRoutesFetched && tgwId && feederIds.size > 0
      ? assessTgwRouteResilience(topologyData, tgwId, feederIds)
      : null),
    [topologyData, vifRoutesFetched, tgwId, feederIds],
  );
  const diff = resilience?.diff ?? null;
  const belowHigh = resilience?.belowHigh ?? 0;
  const gatewayName = useCallback(
    (id: string) => topologyData?.dxGateways.find((g) => g.directConnectGatewayId === id)?.directConnectGatewayName || id,
    [topologyData],
  );
  const onResilienceClick = useCallback(async () => {
    if (!tgwId) return;
    if (!useTopologyStore.getState().vifRoutesCache) {
      await loadVifRoutes();
      if (!useTopologyStore.getState().vifRoutesCache) return;
    }
    toggleResilience(tgwId);
  }, [tgwId, loadVifRoutes, toggleResilience]);
  // Needs two transit VIFs to compare; one is already the TGW card's
  // `tgw-single-transit-vif` finding. Once fetched, defer to the diff.
  const showResilience = showLiveStatus
    && !d.isRecommended
    && (feeders?.transitVifCount ?? 0) >= 2
    && (vifRoutesFetched ? diff != null : true);

  return (
    <div className="relative">
    <BaseNode
      nodeId={id}
      label={d.label}
      subtitle="Transit Gateway"
      icon={<TransitGatewayIcon />}
      isRecommended={d.isRecommended}
      accent={isCrossAccount ? 'crossAccount' : 'default'}
      bgColor="#1e1033"
      badges={d.badges}
      targetHandleIds={d.targetHandleIds}
      // Gated on hasPeeringHandle: React Flow picks a left source handle over
      // the default Right for unqualified outbound edges (e.g. TGW→VPC), so
      // only render these when an edge actually targets them.
      extraLeftHandles={d.hasPeeringHandle ? [
        { id: 'peering-left', type: 'source', background: '#8b5cf6' },
        { id: 'peering-left-target', type: 'target', background: '#8b5cf6' },
      ] : undefined}
    >
      {d.resourceId && d.resourceId !== d.label && (
        <span className="text-[9px] text-slate-500 font-tech">{r(d.resourceId)}</span>
      )}
      {d.details?.asn && (
        <span className="text-[9px] text-slate-400 font-tech">{r(`ASN: ${d.details.asn}`)}</span>
      )}
      {!d.resourceId && d.details?.dxGatewayId && (
        <span className="text-[9px] text-slate-400 font-tech" title="Parent Direct Connect Gateway">DXGW: {r(d.details.dxGatewayId)}</span>
      )}
      {!d.resourceId && d.details?.associationId && (
        <span className="text-[9px] text-slate-500 font-tech" title="Association ID">Assoc: {r(d.details.associationId)}</span>
      )}
      {isCrossAccount && d.details?.ownerAccount && (
        <span className="text-[9px] font-tech whitespace-nowrap" style={{ color: accountColor }}>{r(`Account: ${d.details.ownerAccount}`)}</span>
      )}
      {showLiveStatus && <LiveStatusDot state={state} upPattern={/^(available|associated)$/i} />}
      {routeTables && routeTables.length > 0 && (
        <button
          onClick={(e) => { e.stopPropagation(); togglePanel(d.resourceId!); }}
          onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
          onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
          className="text-[8px] text-violet-400 hover:text-violet-300 mt-0.5 flex items-center gap-0.5 cursor-pointer self-end nodrag"
          title="View route tables"
        >
          <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
            <path d="M0 2a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V2zm2 0v3h5V1H2a1 1 0 0 0-1 1zm6-1v4h7V2a1 1 0 0 0-1-1H8zM1 6v4h6V6H1zm7 0v4h7V6H8zM1 11v3a1 1 0 0 0 1 1h5v-4H1zm7 4h6a1 1 0 0 0 1-1v-3H8v4z"/>
          </svg>
          Routes {isExpanded ? '▴' : '▾'}
        </button>
      )}
      {isExpanded && routeTables && (
        <TgwRoutePanel routeTables={routeTables} onClose={() => togglePanel(d.resourceId!)} nodeId={id} />
      )}
      {showResilience && (
        <button
          onClick={(e) => { e.stopPropagation(); void onResilienceClick(); }}
          onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
          onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
          disabled={vifRoutesLoading}
          className="text-[8px] mt-0.5 flex items-center gap-0.5 self-end nodrag"
          style={{
            color: vifRoutesError && !vifRoutesFetched
              ? COLORS.severity.warning
              : belowHigh > 0 ? COLORS.severity.critical : '#a78bfa',
            cursor: vifRoutesLoading ? 'wait' : 'pointer',
          }}
          title={vifRoutesError && !vifRoutesFetched
            ? `BGP routes unavailable: ${vifRoutesError}`
            : !vifRoutesFetched
              ? `Grade every on-prem prefix reaching this TGW across its ${feeders?.transitVifCount ?? 0} transit VIFs (fetches BGP routes)`
              : belowHigh > 0
                ? `${belowHigh} prefix${belowHigh === 1 ? '' : 'es'} would not survive a DX location failure`
                : 'Every prefix reaching this TGW survives a DX location failure'}
        >
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
            <line x1="2" y1="3.5" x2="10" y2="3.5" />
            <line x1="2" y1="6" x2="7" y2="6" />
            <line x1="2" y1="8.5" x2="10" y2="8.5" />
          </svg>
          Route resilience
          {vifRoutesLoading ? (
            <span className="opacity-70">…</span>
          ) : vifRoutesFetched ? (
            belowHigh > 0 ? <span className="font-bold">⚠ {belowHigh}</span> : <span className="opacity-70">✓</span>
          ) : null}
          {vifRoutesFetched && <span>{isResilienceOpen ? '▴' : '▾'}</span>}
        </button>
      )}
      {isResilienceOpen && diff && tgwId && (
        <DxgwRouteDiffPanel
          diff={diff}
          gatewayName={d.label}
          nodeId={id}
          dxGatewayId={feederIds}
          onClose={() => toggleResilience(tgwId)}
          tgw={{
            tgwId, sinkNodeId: id, routeTables, gatewayName,
            asn: resilience?.asn, isRejected: resilience?.isRejected, foreignOwner: resilience?.foreignOwner,
            mismatchedCidrs: new Set(resilience?.rows.filter((row) => row.mismatch).map((row) => row.cidr)),
          }}
        />
      )}
    </BaseNode>
    {/* Top handle — only rendered when a VPN Connection targets this TGW,
        otherwise an unconnected dot would show on top of the node. MUST
        render after BaseNode so BaseNode's default left target handle is
        the first match for edges that don't specify a targetHandle; otherwise
        ReactFlow picks this top handle and DX-GW → TGW edges route top-down. */}
    {d.hasTopHandle && (
      <Handle id="top" type="target" position={Position.Top} style={{ background: isCrossAccount ? accountColor : '#8b5cf6', width: 6, height: 6 }} />
    )}
    </div>
  );
}
