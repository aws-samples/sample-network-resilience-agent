import { useCallback, useMemo, useRef, useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useViewport } from '@xyflow/react';
import type { VifRoute, VifRoutes } from '../../types/aws-resources';
import { useTopologyStore } from '../../store/topology-store';
import { useRedact, useRedactAsn, useRedactCommunity } from '../../utils/redact';
import { parseIpRange, rangeCovers, rangesOverlap, type IpRange } from '../../utils/cidr';

interface VifRoutePanelProps {
  routes: VifRoutes;
  vifId: string;
  onClose: () => void;
  /**
   * Flow-space coordinates of the VIF edge label this panel belongs to. A VIF is
   * an edge, not a node, so there's no node to walk a parent chain from (as
   * TgwRoutePanel does) — CustomEdge already computes its label position, so it
   * hands those coordinates down and we apply the viewport transform here.
   */
  anchorX: number;
  anchorY: number;
}

type Direction = 'accepted' | 'advertised';
type FamilyFilter = 'all' | 'ipv4' | 'ipv6';
type SortKey = 'prefix' | 'age';

// --- Content-derived column widths ------------------------------------------
// Every column is measured from the longest value actually on screen rather than
// being fixed or flex:1. All cell text is monospace, so a character count
// converts to an exact width — no need to measure the DOM. A fixed or flexing
// column either clips its content or reserves space nothing uses (an all-IPv4
// table shouldn't leave room for a full IPv6 address).
const CH_W = 5.6;          // JetBrains Mono advance width at the 9px body size
const CELL_PAD = 8;        // per-column breathing room
const COL_GAP = 5;         // matches the flex gap between cells

// Header labels set a floor: a column can't be narrower than its own heading.
const HEADERS = { prefix: 'Prefix', age: 'Age', family: 'Family', asPath: 'AS path' };
// Headers render ~6.5px uppercase, narrower per char than the 9px body text.
const HEADER_CH_W = 4.6;

function textCol(longestText: string, header: string, chW = CH_W): number {
  return Math.max(longestText.length * chW, header.length * HEADER_CH_W) + CELL_PAD;
}

// An AS path is chips + arrow separators, not plain text, so it's measured from
// its parts: each chip is its digits plus padding, each arrow a fixed gap.
const CHIP_PAD = 7;
const ARROW_W = 9;
function asPathCol(paths: { asn: number; inSet: boolean }[][], header: string): number {
  const widest = paths.reduce((max, chips) => {
    if (!chips.length) return max;
    const chipsW = chips.reduce(
      (a, c) => a + (String(c.asn).length + (c.inSet ? 2 : 0)) * CH_W + CHIP_PAD,
      0,
    );
    return Math.max(max, chipsW + (chips.length - 1) * ARROW_W);
  }, 0);
  return Math.max(widest, header.length * HEADER_CH_W) + CELL_PAD;
}

// Flatten asPath segments into an ordered list of ASNs for chip rendering.
// AS_SET members are unordered, so they're flagged to render inside braces.
function asPathChips(route: VifRoute): { asn: number; inSet: boolean }[] {
  return route.asPath.flatMap((seg) =>
    seg.path.map((asn) => ({ asn, inSet: seg.pathType === 'set' })),
  );
}

// Route age, matching the console's "3mo 2d" / "4mo 8d" style. `now` is passed
// in rather than read here so the value is stable across a render pass.
function formatRouteAge(installedAt: string | undefined, now: number): string {
  if (!installedAt) return '—';
  const then = Date.parse(installedAt);
  if (Number.isNaN(then)) return '—';
  const mins = Math.floor((now - then) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 31) return `${days}d`;
  // Approximate months the way the console does — 30-day months, remainder in days.
  const months = Math.floor(days / 30);
  const remDays = days % 30;
  return remDays > 0 ? `${months}mo ${remDays}d` : `${months}mo`;
}

// Human meaning of the BGP community tags AWS documents for Direct Connect.
// Sources: DX User Guide "Direct Connect routing policies and BGP communities".
// Local-preference tags apply to private/transit VIFs and control AWS's
// return-path preference; scope tags apply to public VIFs.
const COMMUNITY_MEANINGS: Record<string, string> = {
  // Local preference (private + transit VIFs) — what you tag inbound prefixes with.
  '7224:7100': 'Low return-path preference',
  '7224:7200': 'Medium return-path preference',
  '7224:7300': 'High return-path preference',
  // Scope (public VIFs) — how far AWS propagates your prefixes.
  '7224:9100': 'Local AWS Region only',
  '7224:9200': 'All Regions on this continent',
  '7224:9300': 'Global (all public Regions)',
  // Applied BY AWS to routes it advertises to you (public VIFs).
  '7224:8100': 'Originates in this Region',
  '7224:8200': 'Originates on this continent',
};

function communityMeaning(community: string): string | undefined {
  return COMMUNITY_MEANINGS[community] ?? (community === 'NO_EXPORT' ? 'Not re-advertised outside AWS' : undefined);
}

// The verdict line mixes prose with addresses; addresses read as monospace so
// they're distinguishable from the sentence around them.
const MONO = { fontFamily: "'JetBrains Mono', monospace" } as const;
function Mono({ children }: { children: React.ReactNode }) {
  return <span style={MONO}>{children}</span>;
}

export function VifRoutePanel({ routes, vifId, onClose, anchorX, anchorY }: VifRoutePanelProps) {
  const theme = useTopologyStore((s) => s.theme);
  const r = useRedact();
  // AS paths are bare integers and communities are "asn:value" — neither is
  // labelled, so the generic masker can't spot them. Use the ASN-aware variants.
  const rAsn = useRedactAsn();
  const rCommunity = useRedactCommunity();
  const light = theme === 'light';
  const viewport = useViewport();

  const [direction, setDirection] = useState<Direction>('accepted');
  const [family, setFamily] = useState<FamilyFilter>('all');
  const [filterText, setFilterText] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('prefix');
  // Sampled once per mount so every row's age is measured against the same
  // instant (and so ages don't shift mid-render).
  const [now] = useState(() => Date.now());

  // Drag state — offset is the user's drag displacement from the anchor.
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ startX: number; startY: number; startOffX: number; startOffY: number } | null>(null);

  const stopProp = useCallback((e: React.SyntheticEvent) => {
    e.stopPropagation();
  }, []);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!dragRef.current) return;
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      setOffset({ x: dragRef.current.startOffX + dx, y: dragRef.current.startOffY + dy });
    };
    const onUp = () => { dragRef.current = null; };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, []);

  const onDragStart = useCallback((e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startY: e.clientY, startOffX: offset.x, startOffY: offset.y };
  }, [offset]);

  const active = routes[direction];
  const hasV4 = [...routes.accepted, ...routes.advertised].some((rt) => rt.addressFamily === 'ipv4');
  const hasV6 = [...routes.accepted, ...routes.advertised].some((rt) => rt.addressFamily === 'ipv6');
  const showFamilyFilter = hasV4 && hasV6;

  const needle = filterText.trim().toLowerCase();

  // A filter term that is a complete address or block is treated as a range
  // lookup, not a substring: typing a host address inside an advertised block
  // finds the prefix carrying it, which plain text matching can never do
  // ("10.20.5.7" is not a substring of "10.20.0.0/16"). Anything that isn't a
  // full address — a partial prefix, an ASN, a community — parses to null and
  // falls through to the substring path below.
  const query = useMemo(() => parseIpRange(needle), [needle]);
  // Echo the user's own typing, not the lowercased needle, and mask it like any
  // other address on screen so a redacted screenshot stays redacted.
  const queryText = r(filterText.trim());
  const rangeOf = useMemo(() => {
    const m = new Map<string, IpRange | null>();
    for (const rt of [...routes.accepted, ...routes.advertised]) {
      if (!m.has(rt.cidr)) m.set(rt.cidr, parseIpRange(rt.cidr));
    }
    return m;
  }, [routes]);

  const passesFamily = (rt: VifRoute) =>
    !(showFamilyFilter && family !== 'all' && rt.addressFamily !== family);

  const matchesText = (rt: VifRoute) =>
    rt.cidr.toLowerCase().includes(needle)
    || rt.communities.some((c) => c.toLowerCase().includes(needle))
    || asPathChips(rt).some(({ asn }) => String(asn).includes(needle));

  // Overlap, so the lookup reads both ways: a host address finds every prefix
  // that carries it, and a block finds the more-specific prefixes inside it.
  const matchesRange = (rt: VifRoute) => !!query && rangesOverlap(rangeOf.get(rt.cidr), query);

  const filtered = active.filter((rt) => {
    if (!passesFamily(rt)) return false;
    if (!needle) return true;
    return matchesRange(rt) || matchesText(rt);
  });

  const visible = [...filtered].sort((a, b) => {
    if (sortKey === 'age') {
      // Oldest first — a long-installed route is the stable baseline, and recent
      // churn is what stands out at the bottom.
      const ta = a.routeInstalledAt ? Date.parse(a.routeInstalledAt) : Number.POSITIVE_INFINITY;
      const tb = b.routeInstalledAt ? Date.parse(b.routeInstalledAt) : Number.POSITIVE_INFINITY;
      return ta - tb;
    }
    return a.cidr.localeCompare(b.cidr, undefined, { numeric: true });
  });

  // --- Range-lookup summary ---------------------------------------------------
  // Which rows came back because of the range lookup rather than a text match,
  // and which of them actually carries the traffic. Overlapping prefixes are
  // normal on a VIF (an aggregate plus its more specifics) and the forwarding
  // decision is longest-prefix match, so naming the winner is the whole point of
  // looking an address up.
  // Measured against what's on screen, so the address-family tabs still apply —
  // a summary naming a row the user filtered out would contradict the table.
  const rangeMatches = query ? active.filter((rt) => passesFamily(rt) && matchesRange(rt)) : [];
  const longestMatchOf = (list: VifRoute[]) => (query
    ? list.reduce<VifRoute | undefined>((best, rt) => {
        const rr = rangeOf.get(rt.cidr);
        if (!rr || !rangeCovers(rr, query)) return best;
        const br = best ? rangeOf.get(best.cidr) : undefined;
        return !br || rr.prefixLength > br.prefixLength ? rt : best;
      }, undefined)
    : undefined);
  const longestMatch = longestMatchOf(rangeMatches);
  // A route on the other tab is the asymmetry an operator is usually chasing:
  // "AWS advertises it back to me but I never sent it" (or the reverse).
  const otherDirection: Direction = direction === 'accepted' ? 'advertised' : 'accepted';
  const otherMatch = query && !longestMatch
    ? longestMatchOf(routes[otherDirection].filter(passesFamily))
    : undefined;
  // The v4/v6 tab can hide the very routes the query is asking about. Say so
  // rather than reporting a bare "no route covers this" the user would read as a
  // routing gap.
  const familyExcludesQuery = !!query && showFamilyFilter && family !== 'all' && query.family !== family;

  // --- Layout, derived from the rows actually on screen -----------------------
  // Redacted text is what the user sees, so measure that, not the raw values.
  const longestOf = (vals: string[]) => vals.reduce((m, v) => (v.length > m.length ? v : m), '');
  const baseCols = {
    prefix: textCol(longestOf(visible.map((rt) => r(rt.cidr))), HEADERS.prefix),
    age: textCol(longestOf(visible.map((rt) => formatRouteAge(rt.routeInstalledAt, now))), HEADERS.age),
    family: textCol(
      longestOf(visible.map((rt) => (rt.addressFamily === 'ipv6' ? 'IPv6' : rt.addressFamily === 'ipv4' ? 'IPv4' : '—'))),
      HEADERS.family,
    ),
    asPath: asPathCol(visible.map(asPathChips), HEADERS.asPath),
  };

  const MARGIN = 8;
  const BASE_MAX_H = 340;
  const H_PADDING = 20;
  const SCROLLBAR_W = 10;
  // Panel width follows its content: the four columns plus gaps, padding, and
  // room for the scrollbar. A fixed width either wasted space on short data or
  // clipped long AS paths.
  const baseWidth = Math.max(
    // Floor so the tabs, filter box, and footer sentence stay legible on a VIF
    // whose routes are all short.
    380,
    baseCols.prefix + baseCols.age + baseCols.family + baseCols.asPath
      + COL_GAP * 3 + H_PADDING + SCROLLBAR_W,
  );
  // Scales with canvas zoom like the other route panels, but capped so a wide
  // table at high zoom can't exceed the window and push columns off-screen.
  const z = Math.min(
    viewport.zoom,
    (window.innerWidth - MARGIN * 2) / baseWidth,
    (window.innerHeight - MARGIN * 2) / BASE_MAX_H,
  );
  const panelWidth = baseWidth * z;
  const panelMaxHeight = BASE_MAX_H * z;
  // Anchor below the edge label, horizontally centred on it (the label itself is
  // translated -50%/-50% about labelX/labelY in CustomEdge).
  const rawX = anchorX * z + viewport.x - panelWidth / 2 + offset.x;
  const rawY = anchorY * z + viewport.y + 18 * z + offset.y;
  // Keep the panel on screen. A VIF edge near the right or bottom of the canvas
  // would otherwise push it partly out of view with no way to reach it — the
  // drag offset is still honoured, it just can't leave the viewport.
  const clamp = (v: number, max: number) => Math.max(MARGIN, Math.min(v, max - MARGIN));
  const screenX = clamp(rawX, window.innerWidth - panelWidth);
  const screenY = clamp(rawY, window.innerHeight - panelMaxHeight);

  const prefixColW = baseCols.prefix * z;
  const ageColW = baseCols.age * z;
  const familyColW = baseCols.family * z;
  const asPathColW = baseCols.asPath * z;

  const tabStyle = (selected: boolean) => ({
    fontSize: `${8 * z}px`,
    fontWeight: 600,
    padding: `${2 * z}px ${8 * z}px`,
    borderRadius: 4 * z,
    border: 'none',
    cursor: 'pointer',
    backgroundColor: selected
      ? (light ? '#8b5cf6' : '#7c3aed')
      : (light ? 'rgba(139,92,246,0.1)' : 'rgba(139,92,246,0.15)'),
    color: selected ? '#ffffff' : (light ? '#8b5cf6' : '#a78bfa'),
    transition: 'background-color 0.15s, color 0.15s',
  });

  const panelContent = (
    // onClick only isolates the panel from the canvas underneath; it is not an
    // activation target, so role/tabIndex would add a bogus tab stop. The Close
    // button is the keyboard path out.
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
    <div
      className="fixed tgw-route-scroll"
      style={{
        top: screenY,
        left: screenX,
        width: panelWidth,
        maxHeight: panelMaxHeight,
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: light ? '#ffffff' : '#1a0f2e',
        border: `1px solid ${light ? '#e2e5ea' : 'rgba(139,92,246,0.5)'}`,
        borderRadius: 8 * z,
        zIndex: 9999,
        fontSize: `${9 * z}px`,
        boxShadow: light
          ? '0 8px 30px rgba(0,0,0,0.18)'
          : '0 8px 30px rgba(0,0,0,0.8), 0 0 0 1px rgba(139,92,246,0.25)',
        pointerEvents: 'all' as const,
      }}
      onClick={stopProp}
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={stopProp}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 6 * z,
          padding: `${6 * z}px ${10 * z}px`,
          cursor: 'grab',
          borderBottom: `1px solid ${light ? '#e2e5ea' : 'rgba(139,92,246,0.25)'}`,
          flexShrink: 0,
        }}
        onPointerDown={onDragStart}
      >
        <span style={{
          fontSize: `${9.5 * z}px`,
          fontWeight: 600,
          color: light ? '#334155' : '#cbd5e1',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          BGP Routes — {r(vifId)}
        </span>
        <button
          onClick={(e) => { e.stopPropagation(); e.preventDefault(); onClose(); }}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 20 * z,
            height: 20 * z,
            borderRadius: 4 * z,
            border: `1px solid ${light ? '#e2e5ea' : 'rgba(148,163,184,0.25)'}`,
            cursor: 'pointer',
            color: light ? '#64748b' : '#94a3b8',
            backgroundColor: light ? 'rgba(0,0,0,0.04)' : 'rgba(255,255,255,0.06)',
            transition: 'background-color 0.15s, color 0.15s, border-color 0.15s',
            flexShrink: 0,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = light ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.14)';
            e.currentTarget.style.color = light ? '#334155' : '#e2e8f0';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = light ? 'rgba(0,0,0,0.04)' : 'rgba(255,255,255,0.06)';
            e.currentTarget.style.color = light ? '#64748b' : '#94a3b8';
          }}
          onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
          title="Close"
        >
          <svg width={8 * z} height={8 * z} viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="1" y1="1" x2="7" y2="7" />
            <line x1="7" y1="1" x2="1" y2="7" />
          </svg>
        </button>
      </div>

      {/* Direction tabs — accepted = from customer router, advertised = to it */}
      <div style={{
        display: 'flex',
        gap: 4 * z,
        padding: `${6 * z}px ${10 * z}px`,
        borderBottom: `1px solid ${light ? '#e2e5ea' : 'rgba(139,92,246,0.15)'}`,
        flexShrink: 0,
        flexWrap: 'wrap',
      }}>
        <button
          onClick={(e) => { e.stopPropagation(); setDirection('accepted'); }}
          onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
          style={tabStyle(direction === 'accepted')}
          title="Routes AWS received from your router"
        >
          Accepted {routes.accepted.length}
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); setDirection('advertised'); }}
          onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
          style={tabStyle(direction === 'advertised')}
          title="Routes AWS advertises to your router"
        >
          Advertised {routes.advertised.length}
        </button>
        {showFamilyFilter && (['all', 'ipv4', 'ipv6'] as const).map((f) => (
          <button
            key={f}
            onClick={(e) => { e.stopPropagation(); setFamily(f); }}
            onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
            style={{
              ...tabStyle(family === f),
              backgroundColor: family === f
                ? (light ? '#0d9488' : '#0f766e')
                : (light ? 'rgba(13,148,136,0.1)' : 'rgba(13,148,136,0.15)'),
              color: family === f ? '#ffffff' : (light ? '#0d9488' : '#2dd4bf'),
            }}
            title={f === 'all' ? 'All address families' : `${f === 'ipv4' ? 'IPv4' : 'IPv6'} only`}
          >
            {f === 'all' ? 'All' : f === 'ipv4' ? 'v4' : 'v6'}
          </button>
        ))}
      </div>

      {/* Filter box + sort, mirroring the console's "Filter BGP routes" control */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4 * z,
        padding: `${4 * z}px ${10 * z}px`,
        borderBottom: `1px solid ${light ? '#e2e5ea' : 'rgba(139,92,246,0.15)'}`,
        flexShrink: 0,
      }}>
        <input
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          placeholder="Filter or look up an IP — prefix, AS, community"
          aria-label="Filter BGP routes"
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: `${8 * z}px`,
            fontFamily: "'JetBrains Mono', monospace",
            padding: `${2 * z}px ${5 * z}px`,
            borderRadius: 4 * z,
            border: `1px solid ${light ? '#e2e5ea' : 'rgba(148,163,184,0.25)'}`,
            backgroundColor: light ? '#f8fafc' : 'rgba(255,255,255,0.05)',
            color: light ? '#334155' : '#cbd5e1',
            outline: 'none',
          }}
        />
        <button
          onClick={(e) => { e.stopPropagation(); setSortKey(sortKey === 'prefix' ? 'age' : 'prefix'); }}
          onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
          style={{ ...tabStyle(false), whiteSpace: 'nowrap' }}
          title={sortKey === 'prefix' ? 'Sorted by prefix — click to sort by route age' : 'Sorted by route age (oldest first) — click to sort by prefix'}
        >
          {sortKey === 'prefix' ? 'Prefix ▾' : 'Age ▾'}
        </button>
      </div>

      {/* Range-lookup verdict. Only rendered when the filter term parsed as an
          address or block — a substring filter has nothing to resolve. Without
          this line the user sees several overlapping prefixes and still has to
          work out which one wins. */}
      {query && (
        <div
          role="status"
          style={{
            padding: `${4 * z}px ${10 * z}px`,
            borderBottom: `1px solid ${light ? '#e2e5ea' : 'rgba(139,92,246,0.15)'}`,
            fontSize: `${7 * z}px`,
            lineHeight: 1.45,
            flexShrink: 0,
            backgroundColor: rangeMatches.length
              ? (light ? 'rgba(13,148,136,0.07)' : 'rgba(13,148,136,0.12)')
              : (light ? 'rgba(245,158,11,0.08)' : 'rgba(245,158,11,0.12)'),
            color: rangeMatches.length
              ? (light ? '#0f766e' : '#5eead4')
              : (light ? '#b45309' : '#fcd34d'),
          }}
        >
          {longestMatch ? (
            <>
              <Mono>{queryText}</Mono>
              {' is carried by '}
              <strong style={MONO}>{r(longestMatch.cidr)}</strong>
              {' — the longest matching '}{direction}{' prefix'}
              {rangeMatches.length > 1 && ` of ${rangeMatches.length} overlapping`}.
            </>
          ) : rangeMatches.length ? (
            // A block query, or a host address that only overlaps more-specific
            // prefixes — no single route covers the whole query, so don't claim one.
            <>
              <Mono>{queryText}</Mono>
              {` overlaps ${rangeMatches.length} ${direction} prefix${rangeMatches.length === 1 ? '' : 'es'}`}
              {query.isHost ? ', but none covers it entirely.' : '.'}
            </>
          ) : familyExcludesQuery ? (
            <>
              <Mono>{queryText}</Mono>
              {` is ${query.family === 'ipv6' ? 'IPv6' : 'IPv4'} — set the address-family filter to `}
              <strong>All</strong>
              {` (currently ${family === 'ipv6' ? 'IPv6' : 'IPv4'} only) to look it up.`}
            </>
          ) : (
            <>
              {'No '}{direction}{' route covers '}<Mono>{queryText}</Mono>.
              {otherMatch && (
                <>
                  {' It is covered on the '}
                  <strong>{otherDirection}</strong>
                  {' side by '}
                  <Mono>{r(otherMatch.cidr)}</Mono>.
                </>
              )}
            </>
          )}
        </div>
      )}

      {/* Column headers */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 5 * z,
        padding: `${3 * z}px ${10 * z}px`,
        fontSize: `${6.5 * z}px`,
        fontWeight: 700,
        letterSpacing: 0.3,
        textTransform: 'uppercase' as const,
        color: light ? '#94a3b8' : '#64748b',
        borderBottom: `1px solid ${light ? '#f1f5f9' : 'rgba(148,163,184,0.12)'}`,
        flexShrink: 0,
      }}>
        <span style={{ width: prefixColW, flexShrink: 0 }}>{HEADERS.prefix}</span>
        <span style={{ width: ageColW, textAlign: 'right' as const, flexShrink: 0 }}>{HEADERS.age}</span>
        <span style={{ width: familyColW, textAlign: 'right' as const, flexShrink: 0 }}>{HEADERS.family}</span>
        <span style={{ width: asPathColW, textAlign: 'right' as const, flexShrink: 0 }}>{HEADERS.asPath}</span>
        {/* Reserve the scrollbar's width so headers stay aligned with the rows
            beneath them — the body scrolls, this header doesn't. */}
        <span style={{ width: SCROLLBAR_W * z, flexShrink: 0 }} aria-hidden="true" />
      </div>

      {/* Scrollable route list */}
      <div style={{ overflowY: 'auto', padding: `${6 * z}px ${10 * z}px` }}>
        {visible.length === 0 ? (
          <span style={{ color: light ? '#64748b' : '#94a3b8' }}>
            {active.length === 0
              ? `No ${direction} routes`
              : `No ${direction} routes match this filter`}
          </span>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 * z }}>
            {visible.map((route, i) => {
              const chips = asPathChips(route);
              // The winning row, so the verdict line above has something to point
              // at once the result set is longer than a screenful.
              const isBestMatch = route === longestMatch;
              return (
                <div
                  key={`${route.cidr}-${i}`}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 0,
                    borderRadius: 4 * z,
                    padding: `${2.5 * z}px ${4 * z}px`,
                    // Zebra striping keeps five columns readable at low zoom.
                    backgroundColor: isBestMatch
                      ? (light ? 'rgba(13,148,136,0.14)' : 'rgba(13,148,136,0.22)')
                      : i % 2 === 1
                        ? (light ? 'rgba(15,23,42,0.02)' : 'rgba(255,255,255,0.02)')
                        : 'transparent',
                    boxShadow: isBestMatch
                      ? `inset 0 0 0 ${Math.max(1, z)}px ${light ? '#0d9488' : '#2dd4bf'}`
                      : undefined,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5 * z }}>
                    <span
                      style={{
                        fontSize: `${9 * z}px`,
                        fontFamily: "'JetBrains Mono', monospace",
                        width: prefixColW,
                        flexShrink: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        fontWeight: isBestMatch ? 700 : undefined,
                        color: isBestMatch
                          ? (light ? '#0f766e' : '#5eead4')
                          : (light ? '#334155' : '#cbd5e1'),
                      }}
                      title={isBestMatch
                        ? `${r(route.cidr)} — longest prefix matching ${queryText}`
                        : r(route.cidr)}
                    >
                      {r(route.cidr)}
                    </span>
                    <span
                      style={{
                        width: ageColW,
                        textAlign: 'right' as const,
                        fontSize: `${7.5 * z}px`,
                        color: light ? '#64748b' : '#94a3b8',
                        whiteSpace: 'nowrap',
                        flexShrink: 0,
                      }}
                      title={route.routeInstalledAt ? `Installed ${route.routeInstalledAt}` : 'Install time not reported'}
                    >
                      {formatRouteAge(route.routeInstalledAt, now)}
                    </span>
                    <span
                      style={{
                        width: familyColW,
                        textAlign: 'right' as const,
                        fontSize: `${7 * z}px`,
                        color: light ? '#0d9488' : '#2dd4bf',
                        whiteSpace: 'nowrap',
                        flexShrink: 0,
                      }}
                      title={route.addressFamily === 'ipv6' ? 'IPv6' : route.addressFamily === 'ipv4' ? 'IPv4' : 'Address family not reported'}
                    >
                      {route.addressFamily === 'ipv6' ? 'IPv6' : route.addressFamily === 'ipv4' ? 'IPv4' : '—'}
                    </span>
                    {/* AS path as chips with → separators, like the console.
                        Wraps rather than hiding overflow: a clipped right-aligned
                        row silently truncates the FIRST ASN's leading digit. */}
                    <span
                      style={{
                        width: asPathColW,
                        flexShrink: 0,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'flex-end',
                        // Wrap, never overflow:hidden — a right-aligned clip cuts
                        // from the left and would eat the first ASN's digits.
                        flexWrap: 'wrap' as const,
                        rowGap: 1 * z,
                        gap: 2 * z,
                      }}
                      title={chips.length ? `AS path: ${chips.map((c) => rAsn(c.asn)).join(' → ')}` : 'AS path empty (directly connected)'}
                    >
                      {chips.length === 0 ? (
                        <span style={{ fontSize: `${7.5 * z}px`, color: light ? '#94a3b8' : '#64748b' }}>—</span>
                      ) : chips.map((c, ci) => (
                        <span key={ci} style={{ display: 'flex', alignItems: 'center', gap: 2 * z, flexShrink: 0 }}>
                          {ci > 0 && (
                            <span style={{ fontSize: `${6.5 * z}px`, color: light ? '#94a3b8' : '#64748b' }}>→</span>
                          )}
                          <span style={{
                            fontSize: `${7 * z}px`,
                            fontFamily: "'JetBrains Mono', monospace",
                            fontWeight: 600,
                            padding: `0 ${3 * z}px`,
                            borderRadius: 3 * z,
                            backgroundColor: light ? 'rgba(59,130,246,0.12)' : 'rgba(59,130,246,0.22)',
                            color: light ? '#1d4ed8' : '#93c5fd',
                            whiteSpace: 'nowrap',
                          }}>
                            {c.inSet ? `{${rAsn(c.asn)}}` : rAsn(c.asn)}
                          </span>
                        </span>
                      ))}
                    </span>
                  </div>
                  {route.communities.length > 0 && (
                    <div style={{
                      display: 'flex',
                      flexWrap: 'wrap' as const,
                      gap: 3 * z,
                      paddingTop: 1 * z,
                      // Indent to the prefix column so communities read as
                      // belonging to the prefix above them.
                      paddingLeft: prefixColW * 0.06,
                    }}>
                      {route.communities.map((c, ci) => {
                        const meaning = communityMeaning(c);
                        return (
                          <span
                            key={ci}
                            style={{
                              fontSize: `${6.5 * z}px`,
                              fontFamily: "'JetBrains Mono', monospace",
                              padding: `0 ${3 * z}px`,
                              borderRadius: 3 * z,
                              backgroundColor: light ? 'rgba(139,92,246,0.1)' : 'rgba(139,92,246,0.2)',
                              color: light ? '#7c3aed' : '#c4b5fd',
                              whiteSpace: 'nowrap',
                            }}
                            // Decode the documented DX community tags so the
                            // operator doesn't have to memorise 7224:xxxx.
                            title={meaning ? `${rCommunity(c)} — ${meaning}` : rCommunity(c)}
                          >
                            {rCommunity(c)}
                            {meaning && (
                              <span style={{ opacity: 0.75, fontWeight: 400 }}> {meaning}</span>
                            )}
                          </span>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Two distinct points, spelled out — the console's terser wording left
          people unsure whether a blank Communities cell meant "untagged". */}
      <div style={{
        padding: `${5 * z}px ${10 * z}px`,
        borderTop: `1px solid ${light ? '#f1f5f9' : 'rgba(148,163,184,0.12)'}`,
        fontSize: `${6.5 * z}px`,
        lineHeight: 1.5,
        color: light ? '#94a3b8' : '#64748b',
        flexShrink: 0,
      }}>
        <div>
          An empty <strong>Communities</strong> cell means none are visible here —
          not that the route is untagged. AWS strips its own internal communities
          from this API.
        </div>
        <div style={{ paddingTop: 2 * z }}>
          To steer which path AWS uses to send traffic <em>back</em> to you, tag the
          prefixes you advertise on a private or transit VIF:{' '}
          <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>7224:7100</span> low,{' '}
          <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>7224:7200</span> medium,{' '}
          <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>7224:7300</span> high preference.
        </div>
      </div>
    </div>
  );

  return createPortal(panelContent, document.body);
}
