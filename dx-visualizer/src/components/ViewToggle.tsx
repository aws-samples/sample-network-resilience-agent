import { useTopologyStore } from '../store/topology-store';
import { useIsLight } from '../hooks/useTheme';
import { TargetTierPicker } from './TargetTierPicker';
import { BulkTargetTierPicker } from './BulkTargetTierPicker';
import { FOCUSED_PUBLIC_VIF } from '../engine/recommendation-engine';

export function ViewToggle() {
  const viewMode = useTopologyStore((s) => s.viewMode);
  const dxGateways = useTopologyStore((s) => s.topologyData?.dxGateways) ?? [];
  const focusedDxGatewayId = useTopologyStore((s) => s.focusedDxGatewayId);
  const setFocusedDxGatewayId = useTopologyStore((s) => s.setFocusedDxGatewayId);
  const assessment = useTopologyStore((s) => s.assessment);
  const light = useIsLight();

  // The global target picker only makes sense for single-DXGW topologies
  // whose current posture is below High — i.e. where the user can still
  // meaningfully choose between High and Maximum. Once a DXGW already meets
  // High, the engine auto-escalates the target to Maximum, so offering a
  // High/Max dropdown is a false choice. Maximum is the ceiling, nothing to pick.
  // Multi-DXGW accounts pick targets per-gateway from the ResiliencyScoreCard
  // or directly on each ghost customer-site zone in the canvas.
  const singleDxgwId = dxGateways[0]?.directConnectGatewayId;
  const singleDxgwLevel = singleDxgwId
    ? assessment?.perDxGateway.find((g) => g.dxGatewayId === singleDxgwId)?.currentLevel
    : undefined;
  const hasMeaningfulTargetChoice =
    singleDxgwLevel === 'none' || singleDxgwLevel === 'devtest';
  const showTargetMenu =
    viewMode === 'recommended' && dxGateways.length === 1 && hasMeaningfulTargetChoice;

  // Multi-DXGW topologies get a bulk picker that applies the chosen tier to
  // every gateway at once. Hide when everything already sits at Maximum —
  // there's no higher tier to move to, so the dropdown would be a no-op.
  // Also hide when a single DXGW is focused, since the per-gateway card and
  // the customer-site ghost already offer the right-scoped picker.
  // Ignore unattached DXGWs — they have no traffic path and SLA tiering
  // doesn't apply, so they should neither keep the picker open nor count
  // toward a "multi-DXGW" topology for the purpose of this control.
  const attachedDxgws = assessment?.perDxGateway.filter((g) => !g.isUnattached) ?? [];
  const everyDxgwAtMax = attachedDxgws.length > 0 &&
    attachedDxgws.every((g) => g.currentLevel === 'maximum');
  const showBulkTargetMenu =
    viewMode === 'recommended' &&
    attachedDxgws.length > 1 &&
    !focusedDxGatewayId &&
    !everyDxgwAtMax;

  // Only meaningful when the canvas is in Recommended mode AND a specific row's
  // ghosts are in focus — i.e. the user clicked High/Max on one row's upgrade
  // card. Clearing focus restores ghosts for every row. Each DXGW, the LAG row,
  // and the Public VIF row are independently focusable, so "View all" should
  // appear whenever more than one such row exists — including a single-DXGW
  // topology that also has a LAG and/or Public VIF row (focusing the DXGW there
  // hides the others, so the user needs a way back).
  const focusableRowCount =
    attachedDxgws.length +
    (assessment?.lag ? 1 : 0) +
    (assessment?.publicVif ? 1 : 0);
  const showViewAll = viewMode === 'recommended' && !!focusedDxGatewayId && focusableRowCount > 1;
  const focusedGateway = focusedDxGatewayId && focusedDxGatewayId !== FOCUSED_PUBLIC_VIF
    ? dxGateways.find((g) => g.directConnectGatewayId === focusedDxGatewayId)
    : undefined;
  const focusedName = focusedDxGatewayId === FOCUSED_PUBLIC_VIF
    ? 'Public VIF'
    : (focusedGateway?.directConnectGatewayName || focusedGateway?.directConnectGatewayId);

  return (
    <div className="flex items-center gap-1.5">
      {showTargetMenu && singleDxgwId && (
        <TargetTierPicker dxGatewayId={singleDxgwId} />
      )}

      {showBulkTargetMenu && <BulkTargetTierPicker />}

      {showViewAll && (
        <button
          type="button"
          onClick={() => setFocusedDxGatewayId(null)}
          title={focusedName ? `Showing only ${focusedName} — click to view all recommendations` : undefined}
          className={`px-2.5 py-1.5 text-xs font-semibold rounded-md border-2 transition-all ${
            light
              ? 'bg-emerald-50 border-emerald-500 text-emerald-700 hover:bg-emerald-100 shadow-sm'
              : 'bg-emerald-500/10 border-emerald-400 text-emerald-300 hover:bg-emerald-500/20'
          }`}
        >
          View all
        </button>
      )}
    </div>
  );
}
