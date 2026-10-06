import { useState } from 'react';
import { useTopologyStore } from '../store/topology-store';
import { useIsLight } from '../hooks/useTheme';
import { COLORS } from '../utils/colors';
import { ViewOptionsBadge, ViewOptionsSection } from './ViewOptionsPanel';

/**
 * Canvas-side visibility control for whole connectivity layers.
 *
 * It lives on the canvas rather than in the TopBar because what it changes is
 * the canvas: the TopBar carries account/session chrome and overlays that paint
 * *onto* the graph, while this removes a slice of the graph itself. It is the
 * first section in View options, followed by AWS tags and the Legend.
 *
 * Only Site-to-Site VPN is toggleable today, so the panel renders **only when
 * the account actually has a VPN**. A layer control for something absent from
 * the canvas is a dead control — exactly how `showVpcs` ended up plumbed
 * through the store and snapshot with nothing able to reach it.
 *
 * Every row here is a real switch. An earlier version also listed Direct
 * Connect as a permanently-on row for context, which was worse than leaving it
 * out: it can't be turned off (a DX-less view is a blank canvas), so however it
 * was styled it still read as a switch that ignores clicks. A one-row panel is
 * honest, and the header is what tells you the row is a visibility control.
 */
export function LayersPanel() {
  const light = useIsLight();

  const showVpn = useTopologyStore((s) => s.showVpn);
  const setShowVpn = useTopologyStore((s) => s.setShowVpn);
  const vpnCount = useTopologyStore((s) => s.topologyData?.vpnConnections.length ?? 0);

  // Expanded by default: the panel is the only route to the filter, and a
  // collapsed-by-default control nobody finds is the same as no control. The
  // collapsed header still reports a hidden layer, so folding it away can't
  // leave a suppressed slice of the topology looking like the default view.
  const [expanded, setExpanded] = useState(true);

  if (vpnCount === 0) return null;

  const hiddenCount = showVpn ? 0 : 1;

  return (
    <ViewOptionsSection
      title="Layers"
      toggleLabel="Toggle layers"
      expanded={expanded}
      onToggle={() => setExpanded(!expanded)}
      badge={hiddenCount > 0 ? <ViewOptionsBadge>⚠ {hiddenCount} hidden</ViewOptionsBadge> : undefined}
    >
      <button
        type="button"
        onClick={() => setShowVpn(!showVpn)}
        aria-pressed={showVpn}
        className={`flex w-full items-center gap-2 rounded px-1 py-1 text-left cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 ${
          light ? 'hover:bg-white' : 'hover:bg-white/5'
        } ${showVpn ? '' : light ? 'text-amber-700' : 'text-amber-300'}`}
        title={
          showVpn
            ? `Hide Site-to-Site VPN (${vpnCount}) from the canvas — resiliency findings are unaffected`
            : `${vpnCount} Site-to-Site VPN ${vpnCount === 1 ? 'connection is' : 'connections are'} hidden from the canvas. Resiliency findings still include them.`
        }
      >
        <LayerDot on={showVpn} />
        <span className={showVpn ? '' : 'line-through decoration-1'}>Site-to-Site VPN</span>
        <span className={`ml-auto tabular-nums ${light ? 'text-gray-400' : 'text-slate-500'}`}>
          {vpnCount}
        </span>
      </button>
    </ViewOptionsSection>
  );
}

/** Filled ring = layer on canvas, hollow ring = filtered out. */
function LayerDot({ on }: { on: boolean }) {
  return (
    <span
      className="inline-block w-2.5 h-2.5 rounded-full border-2 shrink-0"
      style={{
        borderColor: on ? COLORS.existing.border : 'currentColor',
        background: on ? COLORS.existing.border : 'transparent',
        opacity: on ? 1 : 0.6,
      }}
    />
  );
}
