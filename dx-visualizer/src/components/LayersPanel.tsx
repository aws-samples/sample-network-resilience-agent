import { useState } from 'react';
import { useTopologyStore } from '../store/topology-store';
import { useIsLight } from '../hooks/useTheme';
import { COLORS } from '../utils/colors';

/**
 * Canvas-side visibility control for whole connectivity layers.
 *
 * It lives on the canvas rather than in the TopBar because what it changes is
 * the canvas: the TopBar carries account/session chrome and overlays that paint
 * *onto* the graph, while this removes a slice of the graph itself. Stacking it
 * under the Legend also puts "what the shapes mean" and "which shapes are on
 * screen" in one corner.
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
    <div
      className={`rounded-lg text-[10px] font-tech ${
        light
          ? 'bg-gray-100/90 border border-gray-300 text-gray-600 shadow-sm'
          : 'bg-slate-800/90 border border-slate-600 text-slate-300 shadow-lg'
      }`}
    >
      <button
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        aria-label="Toggle layers"
        className={`flex items-center gap-1.5 w-full px-3 py-1.5 cursor-pointer ${
          light ? 'hover:bg-gray-50' : 'hover:bg-slate-700/50'
        } ${expanded ? 'rounded-t-lg' : 'rounded-lg'}`}
      >
        <span className="font-semibold">Layers</span>
        {hiddenCount > 0 && (
          <span
            className={`ml-1 rounded px-1 py-[1px] font-semibold ${
              light ? 'bg-amber-100 text-amber-700' : 'bg-amber-500/15 text-amber-300'
            }`}
          >
            ⚠ {hiddenCount} hidden
          </span>
        )}
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          className={`w-3 h-3 ml-auto transition-transform ${expanded ? '' : '-rotate-90'}`}
        >
          <path
            fillRule="evenodd"
            d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
            clipRule="evenodd"
          />
        </svg>
      </button>
      {expanded && (
        <div
          className={`flex flex-col gap-1 px-2 pb-2 pt-1 ${
            light ? 'border-t border-gray-100' : 'border-t border-slate-700'
          }`}
          style={{ minWidth: 168 }}
        >
          <button
            onClick={() => setShowVpn(!showVpn)}
            aria-pressed={showVpn}
            className={`flex items-center gap-2 px-1 py-[3px] rounded text-left ${
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
        </div>
      )}
    </div>
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
