import { useState } from 'react';
import { useTopologyStore } from '../store/topology-store';
import { useIsLight } from '../hooks/useTheme';
import type { TopologyData } from '../types/topology';

// Canvas overlay shown when the active topology has no Direct Connect resources
// to visualize. Explains that this is expected behavior (not an error) and
// points the user at the Unattached resources zone where any discovered
// VPCs/TGWs still land. Renders both for a signed-in live account with no DX
// and for a DX-less demo scenario (e.g. the TGW-only mock). Dismissable via the
// X — the dismissal resets whenever the underlying topology changes, so a
// different DX-less scenario / account re-surfaces the notice.
export function EmptyStateBanner({ welcomeDismissed = false }: { welcomeDismissed?: boolean }) {
  const credentials = useTopologyStore((s) => s.credentials);
  const useMock = useTopologyStore((s) => s.useMock);
  const topologyData = useTopologyStore((s) => s.topologyData);
  const isLoading = useTopologyStore((s) => s.isLoading);
  const error = useTopologyStore((s) => s.error);
  const light = useIsLight();

  // Remember *which* topology the notice was dismissed for rather than a bare
  // boolean, so a reference change (scenario switch, sign-in/out, snapshot
  // import) re-surfaces it for the new context instead of staying hidden for
  // the whole session.
  const [dismissedFor, setDismissedFor] = useState<TopologyData | null>(null);
  const dismissed = topologyData != null && dismissedFor === topologyData;

  // An error overlay is already rendered by App.tsx — don't stack a second
  // empty-state on top of it. The loading spinner takes precedence too.
  if (isLoading || error) return null;
  if (dismissed) return null;

  const signedIn = !!credentials && !useMock;
  const hasDx =
    !!topologyData &&
    (topologyData.connections.length > 0 ||
      topologyData.dxGateways.length > 0 ||
      topologyData.virtualInterfaces.length > 0);

  // In demo/mock mode there are no credentials, so the signed-out WelcomeBanner
  // owns this same canvas slot until the user engages with it. Only surface the
  // empty-state for a mock scenario once that welcome has been dismissed — that
  // keeps the two banners mutually exclusive instead of stacking.
  const mockNoDx = useMock && welcomeDismissed;

  // Render for the DX-less live account OR a dismissed-welcome DX-less demo.
  if ((!signedIn && !mockNoDx) || !topologyData || hasDx) return null;

  const hasVpn =
    topologyData.vpnConnections.length > 0 ||
    topologyData.vpnGateways.length > 0 ||
    topologyData.customerGateways.length > 0;
  const hasOtherResources =
    topologyData.vpcs.length > 0 || topologyData.transitGateways.length > 0 || hasVpn;

  return (
    <div
      // Don't block clicks on the underlying canvas — the Unattached resources
      // zone and any rendered VPC/TGW nodes stay interactive behind this card.
      className="absolute inset-x-0 top-6 z-10 flex items-start justify-center px-6 pointer-events-none"
    >
      <div
        className={`pointer-events-auto relative max-w-md w-full rounded-xl border p-5 text-center shadow-xl ${
          light
            ? 'bg-white/95 border-amber-200/80 backdrop-blur-sm shadow-slate-300/40'
            : 'bg-slate-800/95 border-amber-700/40 backdrop-blur-sm shadow-black/30'
        }`}
      >
        <button
          onClick={() => setDismissedFor(topologyData)}
          aria-label="Dismiss notice"
          className={`absolute top-2 right-2 w-6 h-6 flex items-center justify-center rounded transition-colors ${
            light ? 'text-slate-400 hover:text-slate-600 hover:bg-slate-100' : 'text-slate-500 hover:text-slate-300 hover:bg-white/[0.06]'
          }`}
        >
          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
        <div
          className={`w-9 h-9 mx-auto rounded-full flex items-center justify-center mb-2.5 ${
            light ? 'bg-amber-100' : 'bg-amber-500/15'
          }`}
        >
          <svg
            className={`w-4.5 h-4.5 ${light ? 'text-amber-600' : 'text-amber-400'}`}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        </div>
        <h2 className={`text-sm font-semibold mb-1.5 ${light ? 'text-slate-800' : 'text-white'}`}>
          No Direct Connect resources found
        </h2>
        <p className={`text-xs leading-relaxed ${light ? 'text-slate-500' : 'text-slate-400'}`}>
          {hasVpn
            ? 'This account connects via Site-to-Site VPN — your VPN connections, Transit Gateways, and VPCs are shown on the canvas, grouped by region. Resources with no attachments appear in the Unattached resources zone.'
            : hasOtherResources
              ? 'This account has no DX connections, virtual interfaces, or DX gateways — any discovered VPCs and Transit Gateways are shown on the canvas, grouped by region. Resources with no attachments appear in the Unattached resources zone.'
              : 'This account has no DX connections, virtual interfaces, or DX gateways.'}
        </p>
        <p className={`text-[11px] mt-2.5 ${light ? 'text-slate-400' : 'text-slate-500'}`}>
          Sign in to a networking account, or pick a demo scenario from the top bar
          to explore what a fully-configured topology looks like.
        </p>
      </div>
    </div>
  );
}
