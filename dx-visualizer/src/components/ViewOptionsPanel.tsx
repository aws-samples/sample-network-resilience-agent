import { useId, useState, type ReactNode, type Ref } from 'react';
import { useIsLight } from '../hooks/useTheme';
import { useTopologyStore } from '../store/topology-store';

interface ViewOptionsPanelProps {
  children: ReactNode;
  panelRef?: Ref<HTMLDivElement>;
}

/** One canvas control surface; only its body scrolls on short viewports. */
export function ViewOptionsPanel({ children, panelRef }: ViewOptionsPanelProps) {
  const light = useIsLight();
  const [expanded, setExpanded] = useState(true);
  const bodyId = useId();
  const filterCount = useTopologyStore((s) => s.tagFilters.length);
  const vpnHidden = useTopologyStore((s) => !s.showVpn && (s.topologyData?.vpnConnections.length ?? 0) > 0);

  return (
    <div
      ref={panelRef}
      role="region"
      aria-label="View options"
      className={`nodrag nopan nowheel flex min-h-0 min-w-0 max-w-64 flex-col overflow-hidden rounded-xl border text-[11px] font-tech ${
        expanded ? 'w-64' : 'w-auto'
      } ${
        light
          ? 'bg-gray-100/95 border-gray-300 text-gray-600 shadow-sm'
          : 'bg-slate-800/95 border-slate-600 text-slate-300 shadow-lg'
      }`}
    >
      <h2 className="shrink-0">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={bodyId}
          title={expanded ? 'Collapse view options' : 'Expand view options'}
          onClick={(event) => {
            // Keep section state and unfinished tag selections mounted. Moving
            // focus to the header also dismisses any portaled tag dropdown.
            event.currentTarget.focus();
            setExpanded(!expanded);
          }}
          className={`flex w-full items-center gap-1 ${expanded ? 'px-3' : 'px-2.5'} py-2.5 text-left cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-500 ${
            light ? 'bg-white/60 hover:bg-white text-gray-800' : 'bg-slate-900/25 hover:bg-slate-700/50 text-slate-100'
          }`}
        >
          <svg className={`${expanded ? 'w-3.5 h-3.5' : 'w-4 h-4'} shrink-0`} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <path d="M3 5h14M3 10h14M3 15h14" />
            <path d="M7 3v4m6 1v4m-6 1v4" strokeWidth="3" />
          </svg>
          {/* Collapsed, the sliders icon stands in for the title; the badges stay
              so an active filter or hidden layer is still disclosed. */}
          {expanded ? (
            <span className="min-w-0 truncate font-sans text-xs font-semibold">View options</span>
          ) : (
            <span className="sr-only">View options</span>
          )}
          {!expanded && filterCount > 0 && (
            <ViewOptionsBadge>{filterCount} {filterCount === 1 ? 'filter' : 'filters'}</ViewOptionsBadge>
          )}
          {!expanded && vpnHidden && <ViewOptionsBadge>1 hidden</ViewOptionsBadge>}
          {expanded && (
            <svg
              className="w-3.5 h-3.5 shrink-0 ml-auto"
              viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"
            >
              <path d="m8 5 5 5-5 5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </button>
      </h2>
      <div id={bodyId} hidden={!expanded} className="min-h-0 overflow-y-auto overscroll-contain">
        {children}
      </div>
    </div>
  );
}

interface ViewOptionsSectionProps {
  title: string;
  toggleLabel: string;
  expanded: boolean;
  onToggle: () => void;
  badge?: ReactNode;
  children: ReactNode;
}

/** Shared spacing, disclosure control, and divider for every canvas section. */
export function ViewOptionsSection({ title, toggleLabel, expanded, onToggle, badge, children }: ViewOptionsSectionProps) {
  const light = useIsLight();
  const bodyId = useId();

  return (
    <section className={`w-full min-w-0 border-t ${light ? 'border-gray-200' : 'border-slate-700'}`}>
      <h3>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={bodyId}
          aria-label={toggleLabel}
          className={`flex w-full items-center gap-2 px-3 py-2.5 text-left cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-500 ${
            light ? 'hover:bg-white/70' : 'hover:bg-slate-700/50'
          }`}
        >
          <svg
            className={`w-3 h-3 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
            viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"
          >
            <path d="m7 4 6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className={`flex-1 text-xs font-bold ${light ? 'text-gray-800' : 'text-slate-100'}`}>
            {title}
          </span>
          {badge}
        </button>
      </h3>
      <div id={bodyId} hidden={!expanded}>
        {expanded && <div className="px-3 pb-3 pt-0.5">{children}</div>}
      </div>
    </section>
  );
}

export function ViewOptionsBadge({ children }: { children: ReactNode }) {
  const light = useIsLight();
  return (
    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${
      light ? 'bg-amber-100 text-amber-700' : 'bg-amber-500/15 text-amber-300'
    }`}>
      {children}
    </span>
  );
}
