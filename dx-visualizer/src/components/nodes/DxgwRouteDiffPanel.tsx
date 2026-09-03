import { useCallback, useMemo, useRef, useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useReactFlow, useViewport } from '@xyflow/react';
import type { DxgwRouteDiff, DiffRow, DiffVif } from '../../engine/vif-route-diff';
import { computeDxgwRouteDiff } from '../../engine/vif-route-diff';
import { useTopologyStore } from '../../store/topology-store';
import { useRedact } from '../../utils/redact';
import { parseIpRange, rangeCovers, rangesOverlap, type IpRange } from '../../utils/cidr';

interface DxgwRouteDiffPanelProps {
  /** Gateway-wide comparison: every VIF on the gateway. The baseline a narrowed
   *  selection departs from, and the source of the full column list. */
  diff: DxgwRouteDiff;
  gatewayName: string;
  onClose: () => void;
  nodeId: string;
  /** Needed to recompute the comparison when the user narrows it to a subset. */
  dxGatewayId: string;
}

type FamilyFilter = 'all' | 'ipv4' | 'ipv6';

// Content-derived column widths, same approach as VifRoutePanel: every cell is
// monospace, so a character count converts to an exact width without measuring
// the DOM. A fixed width either clips IPv6 or wastes space on an all-IPv4 table.
const CH_W = 5.6;
const CELL_PAD = 8;
const HEADER_CH_W = 4.6;
const PREFIX_HEADER = 'Prefix';
const INDEX_HEADER = '#';
// One matrix cell holds a check, a tilde, a half-circle, or a dot — one glyph
// plus breathing room. Sized for the column NUMBER above it rather than the
// glyph: those numbers tie a column to a tab, so they have to stay legible at
// zoom < 1.
const CELL_W = 24;
const MARK_GAP = 3;
// Space reserved inside the prefix column for a shared-fate chip (`⚡ 1 device`).
// It has to live *inside* that column, not after it: the matrix columns are
// aligned to the header row by width, so a chip between the prefix and the first
// mark would shift every row it appears on out of alignment with the headers.
// Added to the column width only when a visible row actually carries a chip.
const FATE_CHIP_W = 58;

function textCol(longest: string, header: string): number {
  return Math.max(longest.length * CH_W, header.length * HEADER_CH_W) + CELL_PAD;
}

// Addresses stay monospace inside prose, as in VifRoutePanel — a proportional
// "100.0.0.1" beside a monospace table column reads as a different value.
const MONO = { fontFamily: "'JetBrains Mono', monospace" } as const;
function Mono({ children }: { children: React.ReactNode }) {
  return <span style={MONO}>{children}</span>;
}

export function DxgwRouteDiffPanel({ diff, gatewayName, onClose, nodeId, dxGatewayId }: DxgwRouteDiffPanelProps) {
  const theme = useTopologyStore((s) => s.theme);
  const r = useRedact();
  const light = theme === 'light';
  const { getNode } = useReactFlow();
  const viewport = useViewport();
  const topologyData = useTopologyStore((s) => s.topologyData);
  const setRouteDiffPickedVifIds = useTopologyStore((s) => s.setRouteDiffPickedVifIds);

  // WHICH VIFs ARE IN PLAY — one multi-select tab bar, and its meaning scales
  // with the count:
  //   none → ALL: every prefix on the gateway, graded gateway-wide.
  //   one  → that VIF's own prefixes as rows, still graded gateway-wide.
  //   2+   → compare just those, regraded, rows = the union of theirs.
  // It was two controls (tabs filtered rows, numbered column headers picked the
  // comparison) because the two jobs are genuinely different. But the second
  // selector was a row of bare numerals that read as static column labels, so the
  // comparison was undiscoverable — a worse failure than one gesture whose
  // meaning scales. Columns never change: every VIF on the gateway keeps its
  // column, so the table holds its shape and a prefix missing from the selected
  // VIF stays visible.
  const [selectedVifIds, setSelectedVifIds] = useState<Set<string>>(new Set());
  const [family, setFamily] = useState<FamilyFilter>('all');
  const [filterText, setFilterText] = useState('');
  const [warnFirst, setWarnFirst] = useState(true);

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

  // A pair is the smallest set that answers "if I lose one of these, does the
  // other cover me?", so one selected VIF is a row filter, not a comparison.
  const isNarrowed = selectedVifIds.size >= 2;

  // The active comparison. When narrowed, regrade over just the selected VIFs so
  // a prefix carried by an unselected VIF no longer counts as having a backup —
  // the whole reason for narrowing.
  // Only the VIFs that HAVE route data get a tab or a column, so any two selected
  // recompute to a real comparison — the fallback to the gateway-wide `diff` is a
  // type-level guard, not a state a click can reach.
  const activeDiff = useMemo(() => {
    if (!isNarrowed || !topologyData) return diff;
    return computeDxgwRouteDiff(topologyData, dxGatewayId, selectedVifIds) ?? diff;
  }, [isNarrowed, topologyData, dxGatewayId, selectedVifIds, diff]);

  // The full column list never changes — out-of-scope VIFs stay on screen (dimmed)
  // so the table keeps its shape and column numbers.
  const columns = diff.vifs;
  const inScope = useCallback(
    (vifId: string) => !isNarrowed || selectedVifIds.has(vifId),
    [isNarrowed, selectedVifIds],
  );

  // One phrasing for "which VIF is this", used by every tooltip in the panel.
  // Spells out VIF vs connection because on a hosted-VIF account they can share
  // a name: `fetch-topology.ts` names an inferred connection after its VIF, so
  // the same string appears on the DX Connection edge label and here.
  // Placement is part of the identity here, not trivia: two tabs that look like a
  // redundant pair are only a redundant pair if they sit on different hardware.
  // Omitted rather than printed as "unknown" when unresolved — the grading treats
  // unknown as not-shared, so naming it would invite the opposite reading.
  const vifIdentity = useCallback(
    (v: DiffVif) => `VIF ${r(v.label)} (${r(v.vifId)}, ${v.vifType})${
      v.connectionId ? ` on connection ${r(v.connectionId)}` : ''}${
      v.device ? `, device ${r(v.device)}` : ''}${
      v.site ? `, location ${r(v.site)}` : ''}`,
    [r],
  );

  const toggleVif = useCallback((vifId: string) => {
    setSelectedVifIds((prev) => {
      const next = new Set(prev);
      if (next.has(vifId)) next.delete(vifId);
      else next.add(vifId);
      return next;
    });
  }, []);

  // Publish the selection to the store so CustomEdge can light up the matching
  // VIF edges. Every selected VIF is lit, including a lone one: the tab bar means
  // "which VIFs are in play", and one in play is still a claim worth showing on
  // the canvas. ALL (nothing selected) lights nothing.
  useEffect(() => {
    setRouteDiffPickedVifIds(selectedVifIds);
  }, [selectedVifIds, setRouteDiffPickedVifIds]);

  // Clearing the highlight is the panel's job on unmount; the store also clears
  // it when the last panel closes, but an unmount for any other reason (topology
  // refresh re-rendering the node) must not leave edges lit.
  useEffect(() => () => setRouteDiffPickedVifIds([]), [setRouteDiffPickedVifIds]);

  // Exactly one VIF selected: rows narrow to its own prefixes. With two or more
  // the engine has already scoped the union to them, so there is nothing left to
  // filter — the rows ARE the comparison.
  const soloVifId = selectedVifIds.size === 1 ? [...selectedVifIds][0] : null;
  const selectedVif = soloVifId
    ? activeDiff.vifs.find((v) => v.vifId === soloVifId) ?? null
    : null;

  const scoped = useMemo(
    () => (selectedVif
      ? activeDiff.rows.filter((row) => row.cells.get(selectedVif.vifId)?.state === 'exact')
      : activeDiff.rows),
    [activeDiff.rows, selectedVif],
  );

  const hasV4 = scoped.some((row) => row.addressFamily === 'ipv4');
  const hasV6 = scoped.some((row) => row.addressFamily === 'ipv6');
  const showFamilyFilter = hasV4 && hasV6;

  const needle = filterText.trim().toLowerCase();

  // A filter term that is a complete address or block becomes a RANGE LOOKUP, not
  // a substring match — the same behaviour the per-VIF BGP Routes panel has. Typing
  // a host address is how an operator asks "which prefix carries this, and does it
  // have a second path?", and plain text matching can never answer it:
  // "100.0.0.1" is not a substring of "100.0.0.0/24", so the search returned "no
  // prefixes match" for an address the gateway demonstrably carries. Anything that
  // is not a full address — a partial prefix being typed, a stray digit — parses to
  // null and falls through to the substring path.
  const query = useMemo(() => parseIpRange(needle), [needle]);
  // Echo the user's own typing, not the lowercased needle, and mask it like any
  // other address on screen so a redacted screenshot stays redacted.
  const queryText = r(filterText.trim());
  // Parsed from the gateway-wide row set so the map survives narrowing, and once
  // per prefix rather than once per keystroke per row.
  const rangeOf = useMemo(() => {
    const m = new Map<string, IpRange | null>();
    for (const row of diff.rows) if (!m.has(row.cidr)) m.set(row.cidr, parseIpRange(row.cidr));
    return m;
  }, [diff.rows]);

  const passesFamily = useCallback(
    (row: DiffRow) => !(showFamilyFilter && family !== 'all' && row.addressFamily !== family),
    [showFamilyFilter, family],
  );

  const visible = useMemo(() => {
    const rows = scoped.filter((row) => {
      if (!passesFamily(row)) return false;
      if (!needle) return true;
      // Overlap, so the lookup reads both ways: a host address finds every prefix
      // carrying it, and a block finds the more specific prefixes inside it.
      return rangesOverlap(rangeOf.get(row.cidr), query) || row.cidr.toLowerCase().includes(needle);
    });
    // Severity order, worst first: no path anywhere → only part of the block
    // reachable → every carrier on one logical device → every carrier in one DX
    // location → covered whole but by a coarser route → genuinely redundant.
    //
    // Shared fate outranks `covered` because `covered` still reaches the
    // destination today, whereas a single-device row loses the prefix outright the
    // next time AWS takes that device down for maintenance. Fate is checked before
    // the verdict since a `covered` row can carry one too.
    const rank = (row: DiffRow) => (
      row.verdict === 'solo' ? 0
        : row.verdict === 'partial' ? 1
          : row.fate?.scope === 'device' ? 2
            : row.fate?.scope === 'site' ? 3
              : row.verdict === 'covered' ? 4
                : 5
    );
    // `diff.rows` is already prefix-sorted, so a stable sort by rank alone keeps
    // prefix order inside each rank.
    return warnFirst ? [...rows].sort((a, b) => rank(a) - rank(b)) : rows;
  }, [scoped, passesFamily, needle, warnFirst, query, rangeOf]);

  const shownSolo = visible.filter((row) => row.verdict === 'solo').length;
  const shownPartial = visible.filter((row) => row.verdict === 'partial').length;
  const shownLoose = visible.filter((row) => row.verdict === 'covered').length;
  // Counted separately from the three above because these rows are NOT in them:
  // a shared-fate row's verdict reads safe. It is the verdict being wrong about
  // what safe means that the count is reporting.
  const shownSharedDevice = visible.filter((row) => row.fate?.scope === 'device').length;
  const shownSharedSite = visible.filter((row) => row.fate?.scope === 'site').length;

  // --- Range-lookup summary ---------------------------------------------------
  // Overlapping prefixes are normal on a gateway (an aggregate plus its more
  // specifics) and forwarding picks the longest match, so naming the winner is the
  // whole point of looking an address up. Measured over the in-scope rows with the
  // family filter applied, so the summary can never name a row the table is hiding.
  const rangeMatches = useMemo(
    () => (query ? scoped.filter((row) => passesFamily(row) && rangesOverlap(rangeOf.get(row.cidr), query)) : []),
    [query, scoped, passesFamily, rangeOf],
  );
  const longestMatch = useMemo(
    () => (query
      ? rangeMatches.reduce<DiffRow | undefined>((best, row) => {
        const rr = rangeOf.get(row.cidr);
        if (!rr || !rangeCovers(rr, query)) return best;
        const br = best ? rangeOf.get(best.cidr) : undefined;
        return !br || rr.prefixLength > br.prefixLength ? row : best;
      }, undefined)
      : undefined),
    [query, rangeMatches, rangeOf],
  );
  // The v4/v6 tabs can hide the very rows the query asks about. Say so, rather than
  // reporting a bare "nothing covers this" the reader would take for a routing gap.
  const familyExcludesQuery = !!query && showFamilyFilter && family !== 'all' && query.family !== family;
  // Column numbers, not names: the matrix is numbered and the tab bar is its legend,
  // so numbers point at the columns the reader is about to scan.
  const carriersOf = useCallback(
    (row: DiffRow) => columns
      .filter((c) => {
        const state = row.cells.get(c.vifId)?.state;
        return state === 'exact' || state === 'covered';
      })
      .map((c) => c.index),
    [columns],
  );

  // Gateway-wide rows keyed by prefix — used to render out-of-scope columns with
  // that VIF's real relationship to the prefix (dimmed), rather than a bare "·"
  // that would falsely read as "cannot reach". `activeDiff` rows only carry cells
  // for in-scope VIFs when narrowed.
  const gatewayRowByCidr = useMemo(() => {
    const m = new Map<string, DiffRow>();
    for (const row of diff.rows) m.set(row.cidr, row);
    return m;
  }, [diff.rows]);

  const node = getNode(nodeId);
  if (!node) return null;

  // Absolute flow position by walking the parent chain, as TgwRoutePanel does.
  let absX = node.position.x;
  let absY = node.position.y;
  let current = node;
  while (current.parentId) {
    const parent = getNode(current.parentId);
    if (!parent) break;
    absX += parent.position.x;
    absY += parent.position.y;
    current = parent as typeof current;
  }
  const nodeWidth = node.measured?.width ?? node.width ?? 160;

  const longestOf = (vals: string[]) => vals.reduce((m, v) => (v.length > m.length ? v : m), '');
  // Both columns are sized off the GATEWAY-WIDE row set, never off `visible`.
  // Sizing off what is on screen made the panel resize under the cursor: typing
  // two characters into the address lookup dropped the long prefixes from view,
  // the column shrank to fit whatever was left, and the whole panel (and every
  // matrix column with it) jumped mid-keystroke. The gateway-wide set is a
  // superset of any tab subset's rows and of any filtered view, so this is the
  // widest the column ever needs to be and it never changes while the reader
  // narrows. Same for the chip allowance — reserved whenever a shared-fate row
  // exists anywhere in scope, checked against the unfiltered totals so hiding
  // the last chipped row doesn't reclaim the space.
  const prefixColBase = textCol(longestOf(diff.rows.map((row) => r(row.cidr))), PREFIX_HEADER)
    + (diff.totalSharedDevice + diff.totalSharedSite
      + activeDiff.totalSharedDevice + activeDiff.totalSharedSite > 0 ? FATE_CHIP_W : 0);
  // Row numbers are 1-based, so the widest is the row count.
  const indexColBase = textCol(String(diff.rows.length), INDEX_HEADER);

  const MARGIN = 8;
  const BASE_MAX_H = 400;
  const H_PADDING = 20;
  const SCROLLBAR_W = 10;
  const matrixBase = columns.length * (CELL_W + MARK_GAP);
  const baseWidth = Math.max(
    // Floor keeps the tab bar, filter row, and legend legible on a gateway whose
    // prefixes are all short.
    400,
    indexColBase + prefixColBase + matrixBase + H_PADDING + SCROLLBAR_W,
  );
  // Scale with zoom like the sibling panels, but capped so a wide matrix at high
  // zoom can't push columns off-screen.
  const z = Math.min(
    viewport.zoom,
    (window.innerWidth - MARGIN * 2) / baseWidth,
    (window.innerHeight - MARGIN * 2) / BASE_MAX_H,
  );
  const panelWidth = baseWidth * z;
  const panelMaxHeight = BASE_MAX_H * z;
  // Beside the gateway, not under it. The sibling route panels right-align under
  // their node, which works for TGW/VPC in the rightmost columns — but the DXGW
  // sits mid-graph, so the same math drops the widest panel of the set straight
  // over the gateway and the VIF edges entering it from the left. Those edges are
  // exactly what this panel is about (and what it lights up on a pick), so it
  // opens to the RIGHT of the node with tops aligned, keeping both visible.
  // Flips to the left only when the right side genuinely can't hold it; the drag
  // offset still applies either way, and clamping is the last resort.
  const GAP = 12 * z;
  const nodeRightX = (absX + nodeWidth) * z + viewport.x;
  const nodeLeftX = absX * z + viewport.x;
  const rightX = nodeRightX + GAP;
  const fitsRight = rightX + panelWidth <= window.innerWidth - MARGIN;
  const rawX = (fitsRight ? rightX : nodeLeftX - panelWidth - GAP) + offset.x;
  const rawY = absY * z + viewport.y + offset.y;
  const clampPos = (v: number, max: number) => Math.max(MARGIN, Math.min(v, max - MARGIN));
  const screenX = clampPos(rawX, window.innerWidth - panelWidth);
  const screenY = clampPos(rawY, window.innerHeight - panelMaxHeight);

  const prefixColW = prefixColBase * z;
  const indexColW = indexColBase * z;
  const cellW = CELL_W * z;

  const tabStyle = (isSelected: boolean) => ({
    fontSize: `${8 * z}px`,
    fontWeight: 600,
    padding: `${2 * z}px ${8 * z}px`,
    borderRadius: 4 * z,
    border: 'none',
    cursor: 'pointer',
    backgroundColor: isSelected
      ? (light ? '#8b5cf6' : '#7c3aed')
      : (light ? 'rgba(139,92,246,0.1)' : 'rgba(139,92,246,0.15)'),
    color: isSelected ? '#ffffff' : (light ? '#8b5cf6' : '#a78bfa'),
    transition: 'background-color 0.15s, color 0.15s',
  });

  const warnColor = light ? '#b45309' : '#fcd34d';
  const dangerColor = light ? '#b91c1c' : '#f87171';
  const okColor = light ? '#15803d' : '#4ade80';

  const totalGaps = activeDiff.totalSolo + activeDiff.totalPartial;

  // Shared fate gets its OWN chips rather than joining `⚠ N`. It is a different
  // claim — ⚠ means "a prefix has no second path", ⚡/⚑ means "the second path
  // exists but dies with the first" — and one combined number would make a
  // gateway with real blackholes read the same as one whose redundancy is merely
  // undiverse. The fixes differ too: one needs a new prefix on a peer, the other
  // needs the existing peer moved.
  const dangerBg = light ? 'rgba(185,28,28,0.12)' : 'rgba(248,113,113,0.2)';
  const warnBg = light ? 'rgba(180,83,9,0.12)' : 'rgba(252,211,77,0.2)';
  const badgeStyle = (isSelected: boolean, color: string, bg: string) => ({
    fontSize: `${7 * z}px`,
    fontWeight: 700,
    borderRadius: 3 * z,
    padding: `0 ${3 * z}px`,
    backgroundColor: isSelected ? 'rgba(255,255,255,0.25)' : bg,
    color: isSelected ? '#ffffff' : color,
  });
  // One sentence per shared-fate kind, reused by the tab tooltips.
  const fateNote = (device: number, site: number, subject: string) => [
    device > 0
      ? `${device} of ${subject} read as redundant but every carrier terminates on one AWS logical device (⚡) — one DX maintenance event leaves them with no path`
      : '',
    site > 0
      ? `${site} of ${subject} have all carriers in one DX location (⚑) — they survive device maintenance but not a site failure`
      : '',
  ].filter(Boolean).join('. ');

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
          Route differences — {r(gatewayName)}
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
            flexShrink: 0,
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

      {/* ALL + one tab per VIF: the single selector. Tabs are a MULTI-select —
          one narrows the rows, two or more narrow the comparison. The columns
          below never change, so the table keeps its shape across clicks, and the
          tab bar doubles as the column legend since headers are numbers. */}
      <div style={{
        display: 'flex',
        gap: 4 * z,
        padding: `${6 * z}px ${10 * z}px`,
        borderBottom: `1px solid ${light ? '#e2e5ea' : 'rgba(139,92,246,0.15)'}`,
        flexShrink: 0,
        flexWrap: 'wrap',
      }}>
        {/* ALL is the deselect-everything button, not a peer of the VIF tabs: the
            gateway-wide answer is the reason the panel opens, so it is where the
            selection returns to. */}
        <button
          onClick={(e) => { e.stopPropagation(); setSelectedVifIds(new Set()); }}
          onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
          style={{ ...tabStyle(selectedVifIds.size === 0), display: 'flex', alignItems: 'center', gap: 3 * z }}
          title={`${isNarrowed
            ? `Compare all ${columns.length} VIFs on this gateway again (${diff.rows.length} prefixes)`
            : `Every prefix on this gateway (${diff.rows.length})`}${
            activeDiff.totalSharedDevice > 0 || activeDiff.totalSharedSite > 0
              ? `. ${fateNote(activeDiff.totalSharedDevice, activeDiff.totalSharedSite, 'them')}`
              : ''}`}
        >
          ALL
          {totalGaps > 0 && (
            <span style={badgeStyle(selectedVifIds.size === 0, dangerColor, dangerBg)}>
              ⚠ {totalGaps}
            </span>
          )}
          {activeDiff.totalSharedDevice > 0 && (
            <span style={badgeStyle(selectedVifIds.size === 0, warnColor, warnBg)}>
              ⚡ {activeDiff.totalSharedDevice}
            </span>
          )}
          {activeDiff.totalSharedSite > 0 && (
            <span style={badgeStyle(selectedVifIds.size === 0, warnColor, warnBg)}>
              ⚑ {activeDiff.totalSharedSite}
            </span>
          )}
        </button>
        {diff.vifs.map((v) => {
          const scopedIn = inScope(v.vifId);
          // Badge reflects the ACTIVE comparison: an in-scope VIF's gaps are as
          // graded now (narrowed or not); an out-of-scope VIF isn't in the
          // comparison, so it carries no gap count and reads dimmed.
          const vd = scopedIn ? activeDiff.byVif.get(v.vifId) : undefined;
          const isSelected = selectedVifIds.has(v.vifId);
          const gaps = vd ? vd.soloCount + vd.partialCount : 0;
          // Scoped to "this VIF's own prefixes", and deliberately not additive
          // across tabs: a shared-fate row has two or more carriers, so it is
          // counted on each of their tabs. `⚠` counts do sum; these do not.
          const fateText = vd && (vd.sharedDeviceCount > 0 || vd.sharedSiteCount > 0)
            ? `. ${fateNote(vd.sharedDeviceCount, vd.sharedSiteCount, 'its prefixes')}`
            : '';
          const counts = vd
            ? `${vd.rowCount} prefix${vd.rowCount === 1 ? '' : 'es'}, ${vd.soloCount} with no other path${vd.partialCount > 0 ? `, ${vd.partialCount} only partly carried elsewhere` : ''}${fateText}`
            : 'not in the current comparison';
          return (
            <button
              key={v.vifId}
              // Every tab toggles, in or out of scope: a dimmed tab is how its VIF
              // gets added back, so the selector never sends the reader elsewhere.
              onClick={(e) => { e.stopPropagation(); toggleVif(v.vifId); }}
              onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
              style={{
                ...tabStyle(isSelected),
                display: 'flex',
                alignItems: 'center',
                gap: 3 * z,
                opacity: scopedIn ? 1 : 0.4,
              }}
              title={`${v.index}. ${vifIdentity(v)} — ${counts}. ${
                isSelected
                  ? (isNarrowed
                    ? 'In the comparison; click to remove'
                    : 'Showing its prefixes; click another tab to compare the two')
                  : 'Click to add it to the comparison'}`}
            >
              <span style={{ opacity: 0.7 }}>{v.index}.</span>
              {r(v.label)}
              {/* The VIF ID, not decoration: a hosted-VIF account's inferred
                  connection carries the VIF's own name, so the name alone can't
                  say whether a tab is a VIF or a connection. Suppressed when the
                  name already *is* the ID (unnamed VIF) to avoid printing it
                  twice. */}
              {r(v.label) !== r(v.vifId) && (
                <span className="font-tech" style={{ opacity: 0.45, fontSize: `${7 * z}px` }}>
                  {r(v.vifId)}
                </span>
              )}
              {gaps > 0 && (
                <span style={badgeStyle(isSelected, dangerColor, dangerBg)}>
                  ⚠ {gaps}
                </span>
              )}
              {vd && vd.sharedDeviceCount > 0 && (
                <span style={badgeStyle(isSelected, warnColor, warnBg)}>
                  ⚡ {vd.sharedDeviceCount}
                </span>
              )}
              {vd && vd.sharedSiteCount > 0 && (
                <span style={badgeStyle(isSelected, warnColor, warnBg)}>
                  ⚑ {vd.sharedSiteCount}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Selection state, directly under the control it describes. One gesture
          whose meaning scales needs to say which stage it is in: a single
          selected tab changes the rows but not the verdicts, so without this the
          reader can't tell a filter from a comparison. */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 6 * z,
        padding: `${4 * z}px ${10 * z}px`,
        fontSize: `${7.5 * z}px`,
        color: isNarrowed
          ? (light ? '#7c3aed' : '#a78bfa')
          : (light ? '#64748b' : '#94a3b8'),
        backgroundColor: isNarrowed
          ? (light ? 'rgba(139,92,246,0.06)' : 'rgba(139,92,246,0.1)')
          : 'transparent',
        borderBottom: `1px solid ${light ? '#f1f5f9' : 'rgba(148,163,184,0.12)'}`,
        flexShrink: 0,
      }}>
        <span>
          {isNarrowed
            ? <>Comparing <strong>{selectedVifIds.size}</strong> of {columns.length} VIFs — click a tab to add or remove one, or <strong>ALL</strong> to reset</>
            : selectedVif
              ? <><strong>{r(selectedVif.label)}</strong>&apos;s prefixes, graded against all {columns.length} VIFs — click a second tab to compare just those two</>
              : <>Click a VIF tab for its own prefixes, or two or more to compare just those</>}
        </span>
        {selectedVifIds.size > 0 && (
          <button
            onClick={(e) => { e.stopPropagation(); setSelectedVifIds(new Set()); }}
            onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
            style={{
              fontSize: `${7.5 * z}px`,
              fontWeight: 700,
              padding: `${1 * z}px ${5 * z}px`,
              borderRadius: 3 * z,
              border: 'none',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              backgroundColor: light ? 'rgba(139,92,246,0.1)' : 'rgba(139,92,246,0.15)',
              color: light ? '#8b5cf6' : '#a78bfa',
            }}
            title="Compare all VIFs on this gateway again"
          >
            × clear
          </button>
        )}
      </div>

      {/* Filters */}
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
          placeholder="Filter or look up an IP — prefix or address"
          aria-label="Filter prefixes or look up an IP"
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
        <button
          onClick={(e) => { e.stopPropagation(); setWarnFirst(!warnFirst); }}
          onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
          style={{ ...tabStyle(warnFirst), whiteSpace: 'nowrap' }}
          title={warnFirst
            ? 'Unprotected prefixes first — click to sort by prefix only'
            : 'Sorted by prefix — click to float unprotected prefixes to the top'}
        >
          {warnFirst ? '⚠ first' : 'Prefix ▾'}
        </button>
      </div>

      {/* Range-lookup verdict. Only rendered when the term parsed as an address or
          block — a substring filter has nothing to resolve. Without it the reader
          gets several overlapping rows and still has to work out which one wins,
          and on this panel the follow-up question ("does it have a second path?")
          is answered by naming the columns that carry it. */}
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
              : warnColor,
          }}
        >
          {longestMatch ? (
            <>
              <Mono>{queryText}</Mono>
              {' is carried by '}
              <strong style={MONO}>{r(longestMatch.cidr)}</strong>
              {' — the longest matching accepted prefix'}
              {rangeMatches.length > 1 && ` of ${rangeMatches.length} overlapping`}
              {'. '}
              {/* Which columns hold it, and therefore whether losing one VIF costs
                  this address its path. The row's own marks say the same thing, but
                  only after the reader has found the row among the others. */}
              {(() => {
                const cols = carriersOf(longestMatch);
                if (cols.length === 0) return 'No VIF in the comparison reaches it.';
                if (cols.length === 1) {
                  return `Only column ${cols[0]} reaches it — no second path here.`;
                }
                return `Reachable from columns ${cols.join(', ')}.`;
              })()}
            </>
          ) : rangeMatches.length ? (
            // A block query, or a host address that only overlaps more specific
            // prefixes — no single row covers the whole query, so don't claim one.
            <>
              <Mono>{queryText}</Mono>
              {` overlaps ${rangeMatches.length} prefix${rangeMatches.length === 1 ? '' : 'es'} on this gateway`}
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
              {'No accepted prefix '}
              {selectedVif ? <>on <strong>{r(selectedVif.label)}</strong> </> : 'on this gateway '}
              {'covers '}<Mono>{queryText}</Mono>.
            </>
          )}
        </div>
      )}

      {/* Verdict for the rows currently in scope */}
      <div
        role="status"
        style={{
          padding: `${4 * z}px ${10 * z}px`,
          borderBottom: `1px solid ${light ? '#e2e5ea' : 'rgba(139,92,246,0.15)'}`,
          fontSize: `${7 * z}px`,
          lineHeight: 1.45,
          flexShrink: 0,
          // Shared fate joins `covered` in tinting the strip amber: a gateway whose
          // every prefix has a second path is still not all-clear if those paths
          // share a device, and a teal strip over an amber finding is the false
          // reassurance this whole feature exists to remove.
          backgroundColor: shownSolo > 0 || shownPartial > 0
            ? (light ? 'rgba(185,28,28,0.07)' : 'rgba(185,28,28,0.16)')
            : shownLoose > 0 || shownSharedDevice > 0 || shownSharedSite > 0
              ? (light ? 'rgba(245,158,11,0.08)' : 'rgba(245,158,11,0.12)')
              : (light ? 'rgba(13,148,136,0.07)' : 'rgba(13,148,136,0.12)'),
          color: shownSolo > 0 || shownPartial > 0
            ? dangerColor
            : shownLoose > 0 || shownSharedDevice > 0 || shownSharedSite > 0
              ? warnColor
              : (light ? '#0f766e' : '#5eead4'),
        }}
      >
        {shownSolo > 0 ? (
          <>
            <strong>{shownSolo}</strong>
            {` of ${visible.length} prefix${visible.length === 1 ? '' : 'es'} `}
            {selectedVif
              ? <>{'on '}<strong>{r(selectedVif.label)}</strong>{' cannot be reached from any other VIF'}</>
              : 'on this gateway sit on a single VIF with no other path'}
            {'. If that VIF drops, the traffic has nowhere to go.'}
            {shownPartial > 0 && ` A further ${shownPartial} ${shownPartial === 1 ? 'is' : 'are'} only partly carried elsewhere (◐).`}
          </>
        ) : shownPartial > 0 ? (
          <>
            <strong>{shownPartial}</strong>
            {` of ${visible.length} prefix${visible.length === 1 ? '' : 'es'} ${shownPartial === 1 ? 'is' : 'are'} only partly carried by another VIF (◐)`}
            {selectedVif ? <>{' from '}<strong>{r(selectedVif.label)}</strong></> : ''}
            {'. Addresses outside the pieces a sibling carries lose their path.'}
          </>
        ) : shownLoose > 0 ? (
          <>
            {`Every prefix has another path, but ${shownLoose} `}
            {shownLoose === 1 ? 'is' : 'are'}
            {' only covered by a less specific route (~). Failover works, at coarser granularity.'}
          </>
        ) : shownSharedDevice > 0 || shownSharedSite > 0 ? (
          // "Carried by two or more VIFs" full stop would be the false all-clear.
          `All ${visible.length} prefix${visible.length === 1 ? '' : 'es'} ${visible.length === 1 ? 'is' : 'are'} carried by two or more VIFs — but not by independent ones:`
        ) : (
          `All ${visible.length} prefix${visible.length === 1 ? '' : 'es'} ${visible.length === 1 ? 'is' : 'are'} carried by two or more VIFs.`
        )}
        {(shownSharedDevice > 0 || shownSharedSite > 0) && (
          <div style={{ paddingTop: 2 * z, color: warnColor, fontWeight: 600 }}>
            {shownSharedDevice > 0 && (
              <>
                {'⚡ '}
                {/* One sentence at every count: only the number and its agreement
                    move. An "ALL" that appeared once the flagged count reached the
                    visible total made one finding read as two different warnings and
                    made the line rewrite itself under a filter. The count carries
                    that information already, beside the visible total in the
                    verdict line above. */}
                <strong>{shownSharedDevice}</strong>
                {` prefix${shownSharedDevice === 1 ? '' : 'es'} ${shownSharedDevice === 1 ? 'has' : 'have'} NO AWS Logical Device resiliency - Direct Connect maintenance may impact ${shownSharedDevice === 1 ? 'it' : 'them'}.`}
              </>
            )}
            {shownSharedDevice > 0 && shownSharedSite > 0 && ' '}
            {shownSharedSite > 0 && (
              <>
                {'⚑ '}
                <strong>{shownSharedSite}</strong>
                {` prefix${shownSharedSite === 1 ? '' : 'es'} ${shownSharedSite === 1 ? 'has' : 'have'} NO location resiliency - a DX site event may impact ${shownSharedSite === 1 ? 'it' : 'them'}.`}
              </>
            )}
          </div>
        )}
      </div>

      {/* Column headers — one per VIF, numbered to match the tab bar. Names on
          one gateway share prefixes and suffixes, so no abbreviation is safe, and
          the tab bar is the legend. Labels only: selection lives on the tabs. */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        padding: `${3 * z}px ${10 * z}px`,
        fontSize: `${6.5 * z}px`,
        fontWeight: 700,
        letterSpacing: 0.3,
        textTransform: 'uppercase' as const,
        color: light ? '#94a3b8' : '#64748b',
        borderBottom: `1px solid ${light ? '#f1f5f9' : 'rgba(148,163,184,0.12)'}`,
        flexShrink: 0,
      }}>
        <span style={{ width: indexColW, flexShrink: 0, textAlign: 'right' as const, paddingRight: 4 * z }}>
          {INDEX_HEADER}
        </span>
        <span style={{ width: prefixColW, flexShrink: 0 }}>{PREFIX_HEADER}</span>
        {columns.map((c) => {
          const scopedIn = inScope(c.vifId);
          const isSelected = selectedVifIds.has(c.vifId);
          return (
            <span
              key={c.vifId}
              style={{
                width: cellW,
                marginLeft: MARK_GAP * z,
                textAlign: 'center' as const,
                flexShrink: 0,
                // Dim columns not in the comparison; tint a selected VIF's column
                // so its tab and its column read as the same thing.
                opacity: scopedIn ? 1 : 0.35,
                color: isSelected
                  ? (light ? '#8b5cf6' : '#a78bfa')
                  : (light ? '#94a3b8' : '#64748b'),
              }}
              title={`Column ${c.index} — ${vifIdentity(c)}${
                scopedIn ? '' : '. Not in the current comparison; click its tab above to add it'}`}
            >
              {c.index}
            </span>
          );
        })}
        <span style={{ width: SCROLLBAR_W * z, flexShrink: 0 }} aria-hidden="true" />
      </div>

      {/* Matrix rows */}
      <div style={{ overflowY: 'auto', padding: `${6 * z}px ${10 * z}px` }}>
        {visible.length === 0 ? (
          <span style={{ color: light ? '#64748b' : '#94a3b8' }}>
            {scoped.length === 0 ? 'No accepted routes' : 'No prefixes match this filter'}
          </span>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 * z }}>
            {visible.map((row, i) => {
              const isSolo = row.verdict === 'solo';
              const isPartial = row.verdict === 'partial';
              const flagged = isSolo || isPartial;
              // A fate row's verdict is `redundant` or `covered`, so it is never
              // also `flagged` — the two markings can't collide on one row.
              const fate = row.fate;
              const fateCarriers = fate
                ? fate.vifIds
                  .map((id) => columns.find((v) => v.vifId === id))
                  .map((v) => (v ? `${v.index}. ${r(v.label)}` : ''))
                  .filter(Boolean)
                  .join(', ')
                : '';
              return (
                <div
                  key={row.cidr}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    borderRadius: 4 * z,
                    padding: `${2.5 * z}px ${4 * z}px`,
                    backgroundColor: flagged
                      ? (light ? 'rgba(185,28,28,0.09)' : 'rgba(127,29,29,0.32)')
                      : row.verdict === 'covered' || fate
                        ? (light ? 'rgba(245,158,11,0.08)' : 'rgba(245,158,11,0.12)')
                        : i % 2 === 1
                          ? (light ? 'rgba(15,23,42,0.02)' : 'rgba(255,255,255,0.02)')
                          : 'transparent',
                    // Solid outline for a total gap; a partial gap keeps the red
                    // wash but not the outline. Shared fate gets an amber outline
                    // for the same reason solo gets a red one — the row looks
                    // ordinary otherwise, since every mark in it is a ✓.
                    boxShadow: isSolo
                      ? `inset 0 0 0 ${Math.max(1, z)}px ${dangerColor}`
                      : fate
                        ? `inset 0 0 0 ${Math.max(1, z)}px ${warnColor}`
                        : undefined,
                  }}
                >
                  {/* Row number over the visible rows, so it always reads 1..N
                      top to bottom whatever the sort and filter are. Muted and
                      never red: it locates a row when someone reads the table
                      out, and must not compete with the ⚠ that carries meaning. */}
                  <span
                    style={{
                      fontSize: `${8 * z}px`,
                      fontFamily: "'JetBrains Mono', monospace",
                      width: indexColW,
                      flexShrink: 0,
                      textAlign: 'right' as const,
                      paddingRight: 4 * z,
                      fontVariantNumeric: 'tabular-nums',
                      color: light ? '#94a3b8' : '#64748b',
                    }}
                  >
                    {i + 1}
                  </span>
                  <span
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 3 * z,
                      fontSize: `${9 * z}px`,
                      fontFamily: "'JetBrains Mono', monospace",
                      width: prefixColW,
                      flexShrink: 0,
                      overflow: 'hidden',
                      whiteSpace: 'nowrap',
                      fontWeight: flagged || fate ? 700 : undefined,
                      color: flagged ? dangerColor : fate ? warnColor : (light ? '#334155' : '#cbd5e1'),
                    }}
                    title={isSolo
                      ? `${r(row.cidr)} — carried only by ${row.owners.map((id) => r(diff.vifs.find((v) => v.vifId === id)!.label)).join(', ')}, with no other path on this gateway`
                      : isPartial
                        ? `${r(row.cidr)} — only part of this block is reachable from another VIF`
                        : fate
                          ? `${r(row.cidr)} — carried by ${fate.vifIds.length} VIFs (${fateCarriers}), but all of them ${
                            fate.scope === 'device'
                              ? `terminate on AWS logical device ${r(fate.id)}. A Direct Connect maintenance event on that device takes every path to this prefix at once.`
                              : `sit in DX location ${r(fate.id)}. Device maintenance is survivable; losing that location leaves this prefix with no path.`}`
                          : `${r(row.cidr)} — carried by ${row.exactCount} VIF${row.exactCount === 1 ? '' : 's'}`}
                  >
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {flagged && '⚠ '}
                      {r(row.cidr)}
                    </span>
                    {/* The chip states which domain, in the row, next to the
                        prefix — a colour alone would say "something is off here"
                        without saying whether the fix is a maintenance window or a
                        second site. */}
                    {fate && (
                      <span
                        style={{
                          flexShrink: 0,
                          fontSize: `${6.5 * z}px`,
                          fontWeight: 700,
                          letterSpacing: 0.2,
                          borderRadius: 3 * z,
                          padding: `0 ${3 * z}px`,
                          backgroundColor: warnBg,
                          color: warnColor,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {fate.scope === 'device' ? '⚡ 1 device' : '⚑ 1 site'}
                      </span>
                    )}
                  </span>
                  {columns.map((c) => {
                    const scopedIn = inScope(c.vifId);
                    // In-scope cells come from the active (possibly narrowed)
                    // comparison. Out-of-scope columns aren't graded here, so read
                    // their relationship to this prefix from the gateway-wide diff
                    // and render it dimmed — a bare "·" would read as "cannot
                    // reach" when the VIF may well carry it.
                    const cell = scopedIn
                      ? row.cells.get(c.vifId)
                      : gatewayRowByCidr.get(row.cidr)?.cells.get(c.vifId);
                    const mark = cell?.state === 'exact'
                      ? '✓'
                      : cell?.state === 'covered'
                        ? '~'
                        : cell?.state === 'partial'
                          ? '◐'
                          : '·';
                    // The ✓ stays green on a shared-fate row. It used to read amber,
                    // which carried nothing: `fate.vifIds` is every `exact`-or-
                    // `covered` cell and `gradeFate` only returns a fate when ALL of
                    // them share one domain, so every in-scope ✓ on a flagged row was
                    // amber — a row-level boolean repainted across the data cells,
                    // already said by the chip (which names the domain), the amber
                    // prefix text, the row wash and the row outline. It also misled
                    // on a narrowed comparison: `scopedIn` left a dimmed column's ✓
                    // green beside amber siblings, reading as "that one is safe" when
                    // it only meant "not in this comparison". The per-cell tooltip
                    // below still names the shared domain — that part IS per column.
                    const isFateCarrier = !!fate && scopedIn && fate.vifIds.includes(c.vifId);
                    const baseColor = cell?.state === 'exact'
                      ? okColor
                      : cell?.state === 'covered'
                        ? warnColor
                        : cell?.state === 'partial'
                          ? dangerColor
                          : (light ? '#cbd5e1' : '#475569');
                    // The partial tooltip names the pieces this VIF does carry —
                    // without them "partly reachable" gives nothing to act on.
                    // Capped so one aggregate against 25 /24s stays readable.
                    const insideList = cell?.inside ?? [];
                    const insideShown = insideList.slice(0, 6).map(r).join(', ');
                    const insideMore = insideList.length > 6 ? `, +${insideList.length - 6} more` : '';
                    const scopeNote = scopedIn ? '' : ' (not in comparison)';
                    const fateNoteCell = isFateCarrier
                      ? ` — but so do all the other carriers, from the same ${
                        fate!.scope === 'device' ? `logical device ${r(fate!.id)}` : `DX location ${r(fate!.id)}`}`
                      : '';
                    const title = cell?.state === 'exact'
                      ? `${r(c.label)} accepts ${r(row.cidr)}${fateNoteCell}${scopeNote}`
                      : cell?.state === 'covered'
                        ? `${r(c.label)} does not have ${r(row.cidr)}, but covers it via ${r(cell.via!)}${scopeNote}`
                        : cell?.state === 'partial'
                          ? `${r(c.label)} carries only part of ${r(row.cidr)}: ${insideShown}${insideMore}. Addresses outside those blocks are not reachable via this VIF.${scopeNote}`
                          : `${r(c.label)} cannot reach ${r(row.cidr)}${scopeNote}`;
                    return (
                      <span
                        key={c.vifId}
                        style={{
                          width: cellW,
                          marginLeft: MARK_GAP * z,
                          flexShrink: 0,
                          textAlign: 'center' as const,
                          fontSize: `${9 * z}px`,
                          fontWeight: 700,
                          color: baseColor,
                          opacity: scopedIn ? 1 : 0.3,
                        }}
                        title={title}
                      >
                        {mark}
                      </span>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Legend — four marks, the two shared-fate chips, and one caveat that
          changes how a ✓ should be read */}
      <div style={{
        padding: `${5 * z}px ${10 * z}px`,
        borderTop: `1px solid ${light ? '#f1f5f9' : 'rgba(148,163,184,0.12)'}`,
        fontSize: `${6.5 * z}px`,
        lineHeight: 1.5,
        color: light ? '#94a3b8' : '#64748b',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', gap: 8 * z, flexWrap: 'wrap' as const }}>
          <span><strong style={{ color: okColor }}>✓</strong> accepts this prefix</span>
          <span><strong style={{ color: warnColor }}>~</strong> covered by a less specific route</span>
          <span><strong style={{ color: dangerColor }}>◐</strong> only part of the block</span>
          <span><strong style={{ color: dangerColor }}>·</strong> not reachable</span>
          <span><strong style={{ color: warnColor }}>⚡</strong> all carriers, one device</span>
          <span><strong style={{ color: warnColor }}>⚑</strong> all carriers, one site</span>
        </div>

        {/* Two facts, and only the two a reader cannot get from the matrix itself:
            what the numbered column headers stand for, and which direction the
            routes travel. Everything cut is stated closer to where it applies — the
            ⚡/⚑ meanings in the glyph row above and in each row's tooltip, and the
            "a solo prefix may be deliberate" hedge in the Disclaimer's "if required"
            below. "tabs narrow the rows" went because it was true of only ONE of the
            tab bar's three stages and wrong about the consequential one: two or more
            tabs narrow the COMPARISON and regrade, so a prefix that reads safe
            gateway-wide can flip to `solo` inside a pair. The strip directly under
            the tab bar already names whichever stage is active and updates live,
            which a static footer sentence cannot beat. */}
        <div style={{ paddingTop: 2 * z }}>
          Columns are VIFs. Accepted routes only (on-premises → AWS).
        </div>

        {/* Closing disclaimer. Unconditional and last: the notes above name the
            specific gateways at risk, and this says what to do about any of them
            without asserting that it is the right call here — "if required" is
            load-bearing, since a single-VIF prefix can be deliberate traffic
            engineering. Kept as prose at the foot of the panel, matching the
            shared-fate notes, rather than as a per-row chip. */}
        <div
          style={{
            marginTop: 4 * z,
            paddingTop: 4 * z,
            borderTop: `1px solid ${light ? '#f1f5f9' : 'rgba(148,163,184,0.12)'}`,
            fontStyle: 'italic' as const,
          }}
        >
          <strong style={{ fontStyle: 'normal' as const }}>Disclaimer:</strong>
          {' If required, please consider adding the missing prefixes from VIF on '}
          {'different logical device, DX location for resiliency improvement.'}
        </div>
      </div>
    </div>
  );

  return createPortal(panelContent, document.body);
}
