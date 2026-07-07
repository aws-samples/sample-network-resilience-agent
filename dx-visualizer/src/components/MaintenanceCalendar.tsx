import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import type { ReactNode } from 'react';
import { useTopologyStore } from '../store/topology-store';
import { useIsLight } from '../hooks/useTheme';
import type { DxMaintenanceEvent } from '../types/aws-resources';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];
const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const EMPTY_EVENTS: DxMaintenanceEvent[] = [];
const DAY_MS = 24 * 60 * 60 * 1000;

function startOfMonthUtc(year: number, month: number): Date {
  return new Date(Date.UTC(year, month, 1));
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function sameUtcDay(a: Date, b: Date): boolean {
  return a.getUTCFullYear() === b.getUTCFullYear()
    && a.getUTCMonth() === b.getUTCMonth()
    && a.getUTCDate() === b.getUTCDate();
}

/** Does event `e` intersect the UTC day of `day`? */
function eventHitsDay(e: DxMaintenanceEvent, day: Date): boolean {
  if (!e.startTime) return false;
  const start = new Date(e.startTime);
  const end = e.endTime ? new Date(e.endTime) : start;
  // Day window in UTC
  const dayStart = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000 - 1);
  return end >= dayStart && start <= dayEnd;
}

export function MaintenanceCalendar({ iconBtnClass }: { iconBtnClass: (active?: boolean) => string }) {
  // IMPORTANT: select the underlying reference, not a fallback literal — using
  // `?? []` here returns a new array each render and triggers Zustand's infinite
  // re-render guard.
  const rawEvents = useTopologyStore((s) => s.topologyData?.maintenanceEvents);
  const events: DxMaintenanceEvent[] = rawEvents ?? EMPTY_EVENTS;
  const currentNodes = useTopologyStore((s) => s.currentNodes);
  const currentEdges = useTopologyStore((s) => s.currentEdges);
  const setSpotlightNode = useTopologyStore((s) => s.setSpotlightNode);
  const setSpotlightEdge = useTopologyStore((s) => s.setSpotlightEdge);
  const light = useIsLight();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Resolve a raw AWS resource ID (dxcon-*, dxvif-*, dxgw-*) to either a graph
  // node ID or an edge ID so hovering the chip can spotlight the matching
  // element on the canvas.
  //  - dxgw-*: node IDs are `dxgw-${id}` verbatim → node spotlight
  //  - dxcon-*: no dedicated node — spotlight the AWS device terminating that
  //    connection (carries `resourceId === connectionId`) → node spotlight
  //  - dxvif-*: VIFs live on edges — spotlight the edge itself, not the DXGW
  //    it terminates on, so the user is pointed at the actual maintenance target
  const resolveSpotlight = useCallback((resourceId: string): SpotlightTarget | null => {
    const byNode = currentNodes.find((n) => n.id === resourceId || n.data?.resourceId === resourceId);
    if (byNode) return { kind: 'node', id: byNode.id };
    if (resourceId.startsWith('dxvif-')) {
      const byEdge = currentEdges.find((e) => e.data?.vifId === resourceId);
      if (byEdge) return { kind: 'edge', id: byEdge.id };
    }
    const byEdge = currentEdges.find(
      (e) => e.data?.connectionId === resourceId || e.data?.vifId === resourceId,
    );
    if (byEdge) return { kind: 'node', id: byEdge.target };
    return null;
  }, [currentNodes, currentEdges]);

  // Anchor the calendar on today's month so it opens on the user's current
  // context — not jumping them straight into the future. A separate
  // "next activity" control lets them fast-forward to the upcoming event.
  const todayAnchor = useMemo(() => {
    const now = new Date();
    return { year: now.getUTCFullYear(), month: now.getUTCMonth() };
  }, []);

  const [viewYear, setViewYear] = useState(todayAnchor.year);
  const [viewMonth, setViewMonth] = useState(todayAnchor.month);
  const [selectedDay, setSelectedDay] = useState<Date | null>(null);

  // Reset to today's month whenever the panel closes so reopening always
  // lands on "now" rather than wherever the user last navigated.
  useEffect(() => {
    if (!open) {
      setViewYear(todayAnchor.year);
      setViewMonth(todayAnchor.month);
      setSelectedDay(null);
    }
  }, [open, todayAnchor.year, todayAnchor.month]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Hide entirely when there are no events — per user spec.
  if (events.length === 0) return null;

  const firstDay = startOfMonthUtc(viewYear, viewMonth);
  const offset = firstDay.getUTCDay(); // 0-6
  const totalDays = daysInMonth(viewYear, viewMonth);
  const today = new Date();

  // Build calendar cells (null = blank leading cell)
  const cells: (Date | null)[] = [];
  for (let i = 0; i < offset; i++) cells.push(null);
  for (let d = 1; d <= totalDays; d++) {
    cells.push(new Date(Date.UTC(viewYear, viewMonth, d)));
  }
  // Pad to full weeks
  while (cells.length % 7 !== 0) cells.push(null);

  const selectedGroups = selectedDay
    ? groupEventsByWindow(events.filter((e) => eventHitsDay(e, selectedDay)))
    : [];

  const goPrev = () => {
    if (viewMonth === 0) { setViewMonth(11); setViewYear((y) => y - 1); }
    else setViewMonth((m) => m - 1);
  };
  const goNext = () => {
    if (viewMonth === 11) { setViewMonth(0); setViewYear((y) => y + 1); }
    else setViewMonth((m) => m + 1);
  };

  // Find the next event start at/after the given instant. Used to jump
  // forward from today, or from the currently selected day, to the next
  // scheduled maintenance window.
  const nextEventAfter = (from: Date): Date | null => {
    const threshold = from.getTime();
    const upcoming = events
      .map((e) => (e.startTime ? new Date(e.startTime) : null))
      .filter((d): d is Date => !!d && d.getTime() >= threshold)
      .sort((a, b) => a.getTime() - b.getTime());
    return upcoming[0] ?? null;
  };

  // Anchor for the "jump" button: if the user has selected a day that
  // already has an event, look for the next one *after* that day; otherwise
  // look for the next event from today onwards.
  const jumpFrom = selectedDay
    ? new Date(selectedDay.getTime() + DAY_MS)
    : new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const nextEvent = nextEventAfter(jumpFrom);

  const jumpToNextEvent = () => {
    if (!nextEvent) return;
    setViewYear(nextEvent.getUTCFullYear());
    setViewMonth(nextEvent.getUTCMonth());
    setSelectedDay(new Date(Date.UTC(
      nextEvent.getUTCFullYear(),
      nextEvent.getUTCMonth(),
      nextEvent.getUTCDate(),
    )));
  };

  const goToday = () => {
    setViewYear(today.getUTCFullYear());
    setViewMonth(today.getUTCMonth());
    setSelectedDay(null);
  };

  const viewIsCurrentMonth = viewYear === today.getUTCFullYear() && viewMonth === today.getUTCMonth();

  const upcomingCount = events.filter((e) => e.statusCode === 'upcoming' || e.statusCode === 'open').length;

  const daysUntilNext = nextEvent
    ? Math.max(0, Math.round(
        (Date.UTC(nextEvent.getUTCFullYear(), nextEvent.getUTCMonth(), nextEvent.getUTCDate())
        - Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())) / DAY_MS,
      ))
    : null;

  return (
    <div ref={containerRef} className="relative">
      <button
        data-tour="maintenance"
        onClick={() => setOpen((v) => !v)}
        className={iconBtnClass(open)}
        title={`Planned maintenance (${upcomingCount})`}
        aria-label="Planned maintenance calendar"
        aria-expanded={open}
      >
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
          <line x1="16" y1="2" x2="16" y2="6" />
          <line x1="8" y1="2" x2="8" y2="6" />
          <line x1="3" y1="10" x2="21" y2="10" />
        </svg>
        {upcomingCount > 0 && (
          <span
            className={`absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] px-1 rounded-full text-[9px] font-semibold leading-[14px] text-center ${
              light ? 'bg-amber-500 text-white' : 'bg-amber-500 text-slate-900'
            }`}
            aria-hidden="true"
          >
            {upcomingCount}
          </span>
        )}
      </button>

      {open && (
        <div
          className={`absolute top-full right-0 mt-1 rounded-lg shadow-lg border z-50 w-[340px] ${
            light
              ? 'bg-white border-gray-200 shadow-gray-200/50'
              : 'bg-slate-800 border-slate-700 shadow-black/40'
          }`}
        >
          {/* Header */}
          <div className={`flex items-center justify-between px-3 py-2 border-b ${light ? 'border-gray-100' : 'border-slate-700/60'}`}>
            <button
              onClick={goPrev}
              className={`p-1 rounded transition-colors ${light ? 'hover:bg-gray-100 text-gray-600' : 'hover:bg-white/[0.06] text-slate-400'}`}
              aria-label="Previous month"
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
            </button>
            <div className={`text-[12px] font-semibold ${light ? 'text-gray-800' : 'text-slate-200'}`}>
              {MONTHS[viewMonth]} {viewYear}
            </div>
            <button
              onClick={goNext}
              className={`p-1 rounded transition-colors ${light ? 'hover:bg-gray-100 text-gray-600' : 'hover:bg-white/[0.06] text-slate-400'}`}
              aria-label="Next month"
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
            </button>
          </div>

          {/* Context banner: if the user has navigated away from the current
              month, offer a quick return to today. Otherwise, surface the
              next upcoming event. The two cases share the same "Go to"
              pattern so the action is predictable wherever it appears. */}
          {!viewIsCurrentMonth ? (
            <button
              onClick={goToday}
              className={`w-full flex items-center justify-between gap-2 px-3 py-1.5 text-[11px] border-b transition-colors text-left ${
                light
                  ? 'bg-blue-50 hover:bg-blue-100 border-blue-100 text-blue-700'
                  : 'bg-blue-500/10 hover:bg-blue-500/15 border-blue-500/20 text-blue-300'
              }`}
              aria-label="Return to current date"
            >
              <span className="inline-flex items-center gap-1.5 min-w-0">
                <svg className="w-3 h-3 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                <span className="truncate">
                  Today: {MONTHS_SHORT[today.getUTCMonth()]} {today.getUTCDate()}, {today.getUTCFullYear()}
                </span>
              </span>
              <span className="inline-flex items-center gap-0.5 font-medium flex-shrink-0">
                Return to current date
                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </span>
            </button>
          ) : nextEvent ? (
            <button
              onClick={jumpToNextEvent}
              className={`w-full flex items-center justify-between gap-2 px-3 py-1.5 text-[11px] border-b transition-colors text-left ${
                light
                  ? 'bg-amber-50 hover:bg-amber-100 border-amber-100 text-amber-800'
                  : 'bg-amber-500/10 hover:bg-amber-500/15 border-amber-500/20 text-amber-300'
              }`}
              aria-label={`Go to next maintenance on ${nextEvent.toUTCString().slice(0, 16)} UTC`}
            >
              <span className="inline-flex items-center gap-1.5 min-w-0">
                <svg className="w-3 h-3 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                </svg>
                <span className="truncate">
                  Next Activity - {MONTHS_SHORT[nextEvent.getUTCMonth()]} {nextEvent.getUTCDate()}
                  {daysUntilNext !== null && (
                    <span className={light ? 'text-amber-600/80' : 'text-amber-300/70'}>
                      {' '}· {daysUntilNext === 0 ? 'today' : daysUntilNext === 1 ? 'in 1 day' : `in ${daysUntilNext} days`}
                    </span>
                  )}
                </span>
              </span>
              <span className="inline-flex items-center gap-0.5 font-medium flex-shrink-0">
                Go to
                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </span>
            </button>
          ) : null}

          {/* Grid */}
          <div className="px-3 pt-2 pb-3">
            <div className={`grid grid-cols-7 gap-1 mb-1 text-center text-[9px] uppercase tracking-wide font-semibold ${light ? 'text-gray-400' : 'text-slate-500'}`}>
              {WEEKDAYS.map((d, i) => <div key={i}>{d}</div>)}
            </div>
            <div className="grid grid-cols-7 gap-1">
              {cells.map((day, i) => {
                if (!day) return <div key={`blank-${i}`} className="h-8" />;
                const isToday = sameUtcDay(day, today);
                const hit = events.some((e) => eventHitsDay(e, day));
                const isSelected = selectedDay && sameUtcDay(day, selectedDay);
                const todayRing = isToday && !isSelected
                  ? light
                    ? 'ring-1 ring-blue-400'
                    : 'ring-1 ring-blue-400/70'
                  : '';
                return (
                  <button
                    key={day.toISOString()}
                    onClick={() => setSelectedDay(day)}
                    className={`relative h-8 rounded text-[11px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${todayRing} ${
                      isSelected
                        ? 'bg-blue-500 text-white'
                        : hit
                          ? light
                            ? 'bg-amber-100 text-amber-800 hover:bg-amber-200'
                            : 'bg-amber-500/20 text-amber-300 hover:bg-amber-500/30'
                          : isToday
                            ? light
                              ? 'text-blue-600 font-semibold hover:bg-gray-50'
                              : 'text-blue-400 font-semibold hover:bg-white/[0.04]'
                            : light
                              ? 'text-gray-700 hover:bg-gray-50'
                              : 'text-slate-300 hover:bg-white/[0.04]'
                    }`}
                    aria-label={`${day.toUTCString()}${isToday ? ' — today' : ''}${hit ? ' — maintenance scheduled' : ''}`}
                    aria-pressed={!!isSelected}
                  >
                    {day.getUTCDate()}
                    {hit && !isSelected && (
                      <span
                        className={`absolute bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full ${light ? 'bg-amber-500' : 'bg-amber-400'}`}
                        aria-hidden="true"
                      />
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Details panel */}
          <div className={`border-t ${light ? 'border-gray-100 bg-gray-50/60' : 'border-slate-700/60 bg-black/20'} rounded-b-lg`}>
            {selectedDay && selectedGroups.length > 0 ? (
              <div className="max-h-[300px] overflow-y-auto px-3 py-2.5 space-y-3">
                {selectedGroups.map((g) => (
                  <MaintenanceDetail
                    key={g.canonical.arn}
                    group={g}
                    light={light}
                    resolveSpotlight={resolveSpotlight}
                    setSpotlightNode={setSpotlightNode}
                    setSpotlightEdge={setSpotlightEdge}
                  />
                ))}
              </div>
            ) : selectedDay ? (
              <div className={`px-3 py-3 text-[11px] ${light ? 'text-gray-500' : 'text-slate-500'}`}>
                No maintenance scheduled on {selectedDay.toUTCString().slice(0, 16)} UTC.
              </div>
            ) : (
              <div className={`px-3 py-3 text-[11px] ${light ? 'text-gray-500' : 'text-slate-500'}`}>
                Select a highlighted date to see details.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Events sharing the same maintenance window — identical start, end, and
 * affected resource set. AWS emits multiple PHD reminders for a single
 * maintenance (e.g. T-14 / T-7 / T-1); we render one card per window and
 * expose every source notification in a disclosure so the auditor can still
 * trace each original PHD entry.
 */
type MaintenanceGroup = {
  canonical: DxMaintenanceEvent;
  sources: DxMaintenanceEvent[];
};

function groupEventsByWindow(events: DxMaintenanceEvent[]): MaintenanceGroup[] {
  const byKey = new Map<string, DxMaintenanceEvent[]>();
  const ungrouped: DxMaintenanceEvent[] = [];

  for (const e of events) {
    // Fingerprint requires all three fields — missing any, we treat the event
    // as its own group so we never silently merge things that may not match.
    if (!e.startTime || !e.endTime || e.affectedResourceIds.length === 0) {
      ungrouped.push(e);
      continue;
    }
    const key = `${e.startTime}|${e.endTime}|${[...e.affectedResourceIds].sort().join(',')}`;
    const list = byKey.get(key) ?? [];
    list.push(e);
    byKey.set(key, list);
  }

  const groups: MaintenanceGroup[] = [];
  for (const list of byKey.values()) {
    const sorted = [...list].sort((a, b) => {
      const ta = a.lastUpdatedTime ? new Date(a.lastUpdatedTime).getTime() : 0;
      const tb = b.lastUpdatedTime ? new Date(b.lastUpdatedTime).getTime() : 0;
      return tb - ta;
    });
    groups.push({ canonical: sorted[0], sources: sorted });
  }
  for (const e of ungrouped) {
    groups.push({ canonical: e, sources: [e] });
  }
  return groups;
}

/**
 * Split a Personal Health Dashboard description into its header and body
 * using the pattern AWS actually emits:
 *   "<Title> [AWS Account: <id>]  <body...>"
 * (note the double-space separator after the closing bracket).
 *
 * If the description doesn't match this PHD shape, we return no header and
 * keep the whole string as body — the UI never invents text that isn't in
 * the original message.
 */
function splitPhdDescription(description: string): { header: string | null; body: string } {
  const match = description.match(/^([^\n]*?\[AWS Account:[^\]]*\])\s{2,}([\s\S]+)$/);
  if (match) {
    return { header: match[1].trim(), body: match[2].trim() };
  }
  return { header: null, body: description };
}

type SpotlightTarget = { kind: 'node' | 'edge'; id: string };

function MaintenanceDetail({
  group,
  light,
  resolveSpotlight,
  setSpotlightNode,
  setSpotlightEdge,
}: {
  group: MaintenanceGroup;
  light: boolean;
  resolveSpotlight: (resourceId: string) => SpotlightTarget | null;
  setSpotlightNode: (id: string | null) => void;
  setSpotlightEdge: (id: string | null) => void;
}) {
  // Canonical event = the PHD reminder with the newest lastUpdatedTime in the
  // group. Its description is rendered verbatim; we never synthesize text.
  const e = group.canonical;
  const raw = e.description?.trim() ?? '';
  let header: string | null = null;
  let body: string;

  if (raw) {
    const split = splitPhdDescription(raw);
    header = split.header;
    body = split.body;
  } else {
    body = [
      `Event type: ${e.eventTypeCode || 'unknown'}`,
      `Region: ${e.region || 'unknown'}`,
      e.startTime ? `Start: ${e.startTime}` : null,
      e.endTime ? `End: ${e.endTime}` : null,
      e.affectedResourceIds.length ? `Affected: ${e.affectedResourceIds.join(', ')}` : null,
    ].filter(Boolean).join('\n');
  }

  const extraCount = group.sources.length - 1;

  return (
    <div className="space-y-1.5">
      {header && (
        <div className={`text-[12px] font-semibold leading-snug ${light ? 'text-gray-800' : 'text-slate-100'}`}>
          {header}
        </div>
      )}
      <div
        className={`text-[11px] leading-relaxed whitespace-pre-wrap break-words font-sans m-0 ${
          light ? 'text-gray-700' : 'text-slate-300'
        }`}
      >
        {renderBodyWithResourceChips(body, resolveSpotlight, setSpotlightNode, setSpotlightEdge, light)}
      </div>
      {extraCount > 0 && (
        <details className="group">
          <summary
            className={`cursor-pointer list-none text-[10px] font-medium tracking-wide uppercase select-none ${
              light ? 'text-gray-500 hover:text-gray-700' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <span className="inline-flex items-center gap-1">
              <svg
                className="w-3 h-3 transition-transform group-open:rotate-90"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <polyline points="9 18 15 12 9 6" />
              </svg>
              {group.sources.length} PHD notifications for this window
            </span>
          </summary>
          <ul className={`mt-1.5 space-y-1 text-[10px] font-mono ${light ? 'text-gray-500' : 'text-slate-500'}`}>
            {group.sources.map((s) => (
              <li key={s.arn} className="break-all">
                <span className={light ? 'text-gray-700' : 'text-slate-300'}>{s.arn}</span>
                {s.lastUpdatedTime && (
                  <span className="ml-1">· updated {s.lastUpdatedTime}</span>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

// AWS DX resource IDs embedded in PHD descriptions. Matches: dxcon-*, dxvif-*,
// dxgw-* on word boundaries so surrounding punctuation doesn't get absorbed.
const DX_RESOURCE_ID_RE = /\b(dx(?:con|vif|gw)-[A-Za-z0-9]+)\b/g;

/** Tokenize body text, wrapping DX resource IDs in hoverable chips that
 *  spotlight the matching node or edge. Unmatched runs render as plain text
 *  so the original PHD wording is preserved verbatim. */
function renderBodyWithResourceChips(
  body: string,
  resolveSpotlight: (resourceId: string) => SpotlightTarget | null,
  setSpotlightNode: (id: string | null) => void,
  setSpotlightEdge: (id: string | null) => void,
  light: boolean,
): ReactNode[] {
  const parts: ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  DX_RESOURCE_ID_RE.lastIndex = 0;
  while ((match = DX_RESOURCE_ID_RE.exec(body)) !== null) {
    if (match.index > last) parts.push(body.slice(last, match.index));
    const resourceId = match[1];
    const target = resolveSpotlight(resourceId);
    parts.push(
      <ResourceChip
        key={`chip-${i++}-${match.index}`}
        resourceId={resourceId}
        target={target}
        light={light}
        setSpotlightNode={setSpotlightNode}
        setSpotlightEdge={setSpotlightEdge}
      />,
    );
    last = match.index + resourceId.length;
  }
  if (last < body.length) parts.push(body.slice(last));
  return parts;
}

function ResourceChip({
  resourceId,
  target,
  light,
  setSpotlightNode,
  setSpotlightEdge,
}: {
  resourceId: string;
  target: SpotlightTarget | null;
  light: boolean;
  setSpotlightNode: (id: string | null) => void;
  setSpotlightEdge: (id: string | null) => void;
}) {
  const resolvable = target != null;
  const enter = () => {
    if (!target) return;
    if (target.kind === 'edge') setSpotlightEdge(target.id);
    else setSpotlightNode(target.id);
  };
  const leave = () => {
    setSpotlightNode(null);
    setSpotlightEdge(null);
  };
  return (
    <button
      type="button"
      onMouseEnter={enter}
      onMouseLeave={leave}
      onFocus={enter}
      onBlur={leave}
      disabled={!resolvable}
      title={resolvable ? `Highlight ${resourceId} on canvas` : `${resourceId} (not in current topology)`}
      className={`inline font-mono text-[10.5px] px-1 py-[1px] rounded border align-baseline transition-colors ${
        resolvable
          ? light
            ? 'bg-amber-50 border-amber-200 text-amber-800 hover:bg-amber-100 hover:border-amber-300 cursor-pointer'
            : 'bg-amber-500/10 border-amber-500/30 text-amber-300 hover:bg-amber-500/20 hover:border-amber-500/50 cursor-pointer'
          : light
            ? 'bg-gray-100 border-gray-200 text-gray-500 cursor-default'
            : 'bg-slate-700/40 border-slate-600/40 text-slate-400 cursor-default'
      }`}
    >
      {resourceId}
    </button>
  );
}
