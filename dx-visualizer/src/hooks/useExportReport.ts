import { useCallback } from 'react';
import { useTopologyStore } from '../store/topology-store';
import type { TopologyData } from '../types/topology';
import type { DxConnection, DxVirtualInterface, VifRoute } from '../types/aws-resources';
import type { CombinedAssessment, Recommendation, ResiliencyLevel } from '../types/recommendations';
import { getLocationDeviceCounts, getLocationLinkCounts } from '../engine/sla-gating';
import { summariseIssues, guidanceFor } from '../utils/fetch-issues';
import { analyzeTopology } from '../engine/recommendation-engine';
import {
  computeDxgwRouteDiff,
  uniqueByCidr,
  type CellState,
  type DxgwRouteDiff,
  type RowVerdict,
} from '../engine/vif-route-diff';
import { prefixQuotaFor, PREFIX_UTILIZATION_WARN } from '../engine/bestpractice-rules';
import { parseBandwidthToBps, formatBps } from '../utils/shared';
import { redact, redactAsn } from '../utils/redact';
import { metaFor } from '../engine/rule-metadata';
import { buildQuickView, DOC, QUICKVIEW_COLUMNS, type DocRef, type QuickView, type QuickViewCell, type QuickViewChip, type QuickViewColumnId, type QuickViewSeverity, type QuickViewTier } from '../engine/report-quickview';

const TIER_LABELS: Record<ResiliencyLevel, string> = {
  none: 'No Resiliency',
  devtest: 'Development & Testing',
  high: 'High Resiliency',
  maximum: 'Maximum Resiliency',
};

const TIER_SLA: Record<ResiliencyLevel, string> = {
  none: 'No SLA — no connection detected',
  devtest: '95% Single Connection SLA',
  high: '99.9% connection SLA',
  maximum: '99.99% connection SLA',
};

const TIER_SUMMARY: Record<ResiliencyLevel, string> = {
  none: 'No Direct Connect connections detected.',
  devtest: 'Single Direct Connect location — covered by the AWS Single Connection SLA (95%), but not resilient to location failure.',
  high: 'Connections across multiple locations — resilient to location failure.',
  maximum: 'Multiple connections at each of multiple locations — highest redundancy tier.',
};

const TIER_BADGE_COLOR: Record<ResiliencyLevel, string> = {
  none: '#ef4444',
  devtest: '#f59e0b',
  high: '#22c55e',
  maximum: '#06b6d4',
};

const SEVERITY_COLOR: Record<string, string> = {
  critical: '#ef4444',
  warning: '#f59e0b',
  info: '#3b82f6',
  ok: '#22c55e',
};

/**
 * Row tints for the impact table, as low-alpha overlays rather than opaque fills so
 * one pair of values works on both the light and dark backgrounds — an opaque tint
 * would need a per-theme override and the two would drift.
 */
const SEVERITY_TINT: Record<string, string> = {
  critical: 'rgba(239, 68, 68, .10)',
  warning: 'rgba(245, 158, 11, .10)',
};

/**
 * An AWS documentation citation. Always a new tab: the report is a saved single file a
 * reader works through, and navigating it away to docs.aws.amazon.com loses their place.
 */
function docLink(d: DocRef): string {
  return `<a href="${d.url}" target="_blank" rel="noreferrer">${escapeHtml(d.label)}</a>`;
}

/**
 * The AWS pages the impact table is graded against, deduplicated across its columns
 * and rendered once under the table's heading. Sourced from the column definitions
 * so a new column's reference cannot be left out of the header line.
 */
const QUICKVIEW_DOC_LINE = [...new Map(
  QUICKVIEW_COLUMNS.flatMap((c) => c.docs ?? []).map((d) => [d.url, d]),
).values()]
  .map(docLink)
  .join(' &middot; ');

const SEVERITY_LABEL: Record<string, string> = {
  critical: 'Critical',
  warning: 'Warning',
  info: 'Advisory',
};

/** Where the report's data came from — rendered as a header chip, never omitted. */
export type Provenance = {
  kind: 'live' | 'mock' | 'imported';
  scenario: string | null;
  /** null in mock and imported-snapshot mode: the store has no credentials then. */
  primaryRegion: string | null;
  redacted: boolean;
  /**
   * When the underlying data was read, if that is knowable — the snapshot's
   * `exportedAt` for an imported view, null otherwise. The CloudWatch window in
   * the utilization section is measured backwards from here, so an imported
   * snapshot dates its metrics to the fetch rather than to today.
   */
  dataAsOf?: string | null;
  /**
   * Whatever the on-demand fetches reported, verbatim. A section with no data has
   * to distinguish "never asked" from "asked and AWS said no" — the second is a
   * permission or account fact the reader can act on, and paraphrasing it as
   * "not fetched" hides it.
   */
  routesError?: string | null;
  utilizationError?: string | null;
  /** True when the export fetched (or tried to fetch) the on-demand datasets itself. */
  fetchedForReport?: boolean;
  /**
   * The CloudWatch statistic behind the hourly datapoints, named because it differs by
   * producer: the app asks for `Average` (`api/cloudwatch-utilization.ts`) and the
   * skill's CLI sweep asks for `Maximum`. Stating one unconditionally made the
   * utilization section's provenance contradict the fetch that produced it.
   */
  metricStat?: 'Average' | 'Maximum';
};

/**
 * A count chip on a nav entry. `ok` is the "nothing wrong here" tick and is a
 * deliberate state rather than an empty badge: a gateway that renders with no
 * marking at all is indistinguishable from one whose counts failed to compute.
 */
type NavBadge = { critical?: number; warning?: number; info?: number; ok?: boolean; text?: string };

/** One navigable section. The sidebar is built from this list, so a section that
 *  is not rendered can never leave a dead link behind.
 *
 *  `children` renders an indented sub-list. When `group` is set the entry becomes a
 *  collapsible per-gateway group — the report's primary axis is the DX gateway, and a
 *  flat list of every gateway's every subsection would be forty-odd rows deep. */
type Section = {
  id: string;
  title: string;
  /** Non-clickable band label rendered directly above this entry. */
  band?: string;
  badge?: NavBadge;
  children?: Section[];
  group?: boolean;
};

/** Nav count chips. Order is fixed (critical → warning → info) so two gateways are
 *  comparable at a glance; a zero is omitted rather than shown as `0`. */
function navBadge(b: NavBadge | undefined): string {
  if (!b) return '';
  const parts: string[] = [];
  if (b.critical) parts.push(`<span class="b-crit">&#9940;${b.critical}</span>`);
  if (b.warning) parts.push(`<span class="b-warn">&#9888;${b.warning}</span>`);
  if (b.info) parts.push(`<span class="b-info">&#9432;${b.info}</span>`);
  if (b.text) parts.push(`<span class="b-warn">&#9888; ${escapeHtml(b.text)}</span>`);
  if (!parts.length && b.ok) parts.push(`<span class="b-ok">&#10003;</span>`);
  if (!parts.length) return '';
  return `<span class="bx">${parts.join('')}</span>`;
}

function renderNav(sections: Section[], account: string, day: string): string {
  const leaf = (s: Section, cls: string) =>
    `<a class="${cls}" href="#${s.id}"><span class="t">${escapeHtml(s.title)}</span>${navBadge(s.badge)}</a>`;

  const entry = (s: Section): string => {
    const band = s.band ? `<div class="toc-band">${escapeHtml(s.band)}</div>` : '';
    if (!s.children?.length) return band + leaf(s, 'lv1');
    if (!s.group) return band + leaf(s, 'lv1') + s.children.map((c) => leaf(c, 'sub')).join('');
    // A group's caret toggles without navigating; the label does both, so the
    // gateway you clicked is the one left open.
    return band + `<div class="toc-group" id="grp-${s.id}">
      <a class="lv1 gw" href="#${s.id}"><button class="caret" type="button" aria-label="Toggle">&#9656;</button><span class="t">${escapeHtml(s.title)}</span>${navBadge(s.badge)}</a>
      <div class="kids">${s.children.map((c) => leaf(c, 'sub')).join('')}</div>
    </div>`;
  };

  return `<nav id="toc">
  <button class="toc-btn" id="toc-hide" title="Hide sidebar">&#8249;</button>
  <div class="toc-h">DX Resilience Report</div>
  <div class="toc-sub">${account ? `Account ${escapeHtml(account)} &middot; ` : ''}${escapeHtml(day)}</div>
  ${sections.map(entry).join('\n  ')}
</nav>
<div id="toc-grip" title="Drag to resize &middot; double-click to reset"></div>
<button id="toc-show" title="Show sidebar">&#9776;</button>`;
}

const NAV_CSS = `
  :root { --toc-w: 232px; }
  body { padding-left: calc(var(--toc-w) + 24px); }
  h2, h3 { scroll-margin-top: 16px; }
  #toc { position: fixed; top: 0; left: 0; width: var(--toc-w); height: 100vh; overflow-y: auto;
         overflow-x: hidden; background: var(--card); border-right: 1px solid var(--border);
         padding: 22px 14px; font-size: 13px; z-index: 10; }
  #toc .toc-h { font-weight: 600; font-size: 13px; margin: 0 8px 2px; padding-right: 28px; }
  #toc .toc-sub { color: var(--muted); font-size: 11px; margin: 0 8px 14px; padding-bottom: 12px;
                  border-bottom: 1px solid var(--border); }
  #toc a { display: flex; justify-content: space-between; gap: 8px; padding: 5px 8px;
           border-radius: 6px; color: var(--muted); text-decoration: none; white-space: nowrap;
           overflow: hidden; text-overflow: ellipsis; }
  #toc a:hover, #toc a.active { background: var(--bg); color: var(--text); }
  #toc a.active { font-weight: 600; }
  #toc a.sub { margin-left: 12px; font-size: 12px; }
  #toc a .n { color: var(--muted); font-variant-numeric: tabular-nums; flex: none; }
  #toc a .t { overflow: hidden; text-overflow: ellipsis; }
  /* Band labels split the pane into estate-level and per-gateway reading. They are
     labels, not links — the report has no "per DX gateway" page to jump to. */
  #toc .toc-band { color: var(--muted); font-size: 10px; font-weight: 700; letter-spacing: .06em;
                   margin: 14px 8px 4px; padding-top: 10px; border-top: 1px solid var(--border); }
  #toc .bx { display: flex; gap: 5px; flex: none; font-variant-numeric: tabular-nums;
             font-size: 11px; font-weight: 700; }
  #toc .b-crit { color: ${SEVERITY_COLOR.critical}; }
  #toc .b-warn { color: ${SEVERITY_COLOR.warning}; }
  #toc .b-info { color: var(--muted); }
  #toc .b-ok { color: ${TIER_BADGE_COLOR.high}; }
  #toc .caret { flex: none; width: 13px; margin-left: -3px; border: 0; background: none; padding: 0;
                color: var(--muted); cursor: pointer; font: 11px/1 inherit; transition: transform .12s; }
  #toc .toc-group.open .caret { transform: rotate(90deg); }
  #toc .toc-group .kids { display: none; }
  #toc .toc-group.open .kids { display: block; }
  #toc a.gw { gap: 5px; }
  .toc-btn { position: absolute; top: 16px; right: 10px; width: 22px; height: 22px; display: flex;
             align-items: center; justify-content: center; border: 1px solid var(--border);
             border-radius: 5px; background: var(--bg); color: var(--muted); cursor: pointer;
             font: 13px/1 inherit; padding: 0; }
  .toc-btn:hover { color: var(--text); border-color: var(--muted); }
  #toc-show { display: none; position: fixed; top: 12px; left: 12px; z-index: 11; width: 30px;
              height: 30px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg);
              color: var(--muted); cursor: pointer; font: 14px/1 inherit; align-items: center;
              justify-content: center; }
  #toc-show:hover { color: var(--text); border-color: var(--muted); }
  html.toc-hidden #toc { display: none; }
  html.toc-hidden body { padding-left: 48px; }
  html.toc-hidden #toc-show { display: flex; }
  #toc-grip { position: fixed; top: 0; left: calc(var(--toc-w) - 3px); width: 7px; height: 100vh;
              cursor: col-resize; z-index: 11; background: transparent; }
  #toc-grip:hover, html.toc-resizing #toc-grip { background: var(--accent); opacity: .35; }
  html.toc-resizing { cursor: col-resize; user-select: none; }
  html.toc-hidden #toc-grip { display: none; }
  .prov { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px;
          font-weight: 700; border: 1px solid currentColor; margin-left: 6px; }
  .prov.mock, .prov.imported, .prov.unmasked { color: ${SEVERITY_COLOR.warning}; }
  /* Redacted is the safe state, so it reads as a note rather than as a warning —
     amber here would put the loudest colour on the file that needs it least. */
  .prov.redacted { color: var(--muted); }
  @media (max-width: 900px) {
    #toc { position: static; width: auto; height: auto; border-right: none;
           border-bottom: 1px solid var(--border); }
    body { padding-left: 24px; }
    #toc-grip { display: none; }
  }
  /* ---------- impact table (report-quickview.ts) ---------- */
  /* Horizontal scroll rather than a squeezed last column: the tier column is the
     only prose one, so flex gives its space away first and it silently vanishes. */
  .qv-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: 8px; margin: 10px 0 8px; }
  table.qv { width: 100%; min-width: 100%; border-collapse: collapse; font-size: 13px; }
  table.qv thead th { background: var(--panel); text-align: left; padding: 9px 11px; font-size: 10.5px;
    text-transform: uppercase; letter-spacing: .05em; color: var(--muted); font-weight: 700;
    vertical-align: top; border-bottom: 1px solid var(--border); }
  table.qv thead th.qv-num { text-align: right; }
  .qv-u { display: block; font-weight: 400; text-transform: none; letter-spacing: 0; font-size: 10.5px;
    color: var(--muted); margin-top: 3px; max-width: 15em; }
  table.qv thead th.qv-num .qv-u { margin-left: auto; }
  table.qv td, table.qv th.qv-rowhead { padding: 9px 11px; vertical-align: top;
    border-bottom: 1px solid var(--border); }
  table.qv tbody tr:last-child td, table.qv tbody tr:last-child th { border-bottom: none; }
  th.qv-rowhead { text-align: left; font-weight: 600; }
  .qv-sub { display: block; font-weight: 400; font-size: 11px; color: var(--muted);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; margin-top: 2px; }
  td.qv-num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .qv-fig { display: block; font-weight: 600; font-size: 14px; }
  .qv-of { display: block; font-size: 11px; color: var(--muted); font-weight: 400; margin-top: 2px;
    white-space: normal; }
  /* The link chips ARE the locations cell's detail line, standing in for .qv-of.
     td.qv-num sets white-space: nowrap so a figure like "12 of 40" never breaks
     mid-phrase; a multi-chip cell has to opt back out of it, or two chips push
     .qv-wrap into horizontal scroll on every row. Right-aligned to sit under the
     count they belong to, and each chip keeps .link-chip's own nowrap so "2 dot 1"
     cannot split across lines. */
  .qv-chips { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 3px;
    white-space: normal; margin-top: 4px; }
  .qv-chips .table-chip { margin: 0; font-size: 10.5px; padding: 1px 6px; }
  /* A chip's own 13%-alpha wash disappears on top of a 10% row tint, and this cell is
     tinted whenever the gateway is single-location. Deepened here only, so a chip
     still reads as a chip on a coloured row. */
  .qv-chips .table-chip.chip-ok { background: ${TIER_BADGE_COLOR.high}33; }
  .qv-chips .table-chip.chip-gap { background: ${SEVERITY_COLOR.warning}33; }
  /* Tier badges in the row head. Wrapping, because a climbing gateway shows two
     badges plus an arrow and the row head is the narrowest thing holding them. */
  .qv-tier { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin-top: 7px; }
  .qv-tier .tier-badge { font-size: 10px; padding: 2px 8px; }
  .qv-tier-arrow { color: var(--muted); font-size: 11px; }
  .qv-tier-note { flex: 1 0 100%; font-size: 10.5px; color: var(--muted); }
  .qv-tier-none { font-size: 10.5px; color: var(--muted); font-style: italic; }
  a.qv-tier-link { text-decoration: none; color: inherit; display: block; }
  a.qv-tier-link:hover .tier-badge { filter: brightness(1.12); }
  a.qv-cell { text-decoration: none; color: inherit; display: block; }
  a.qv-cell:hover .qv-fig { text-decoration: underline; }
  /* Severity is a tint plus an inset rule, not coloured text: the figure has to stay
     readable, and a 2px bar survives greyscale printing where a tint does not. */
  td.qv-crit { background: ${SEVERITY_TINT.critical}; box-shadow: inset 2px 0 0 ${SEVERITY_COLOR.critical}; }
  td.qv-warn { background: ${SEVERITY_TINT.warning}; box-shadow: inset 2px 0 0 ${SEVERITY_COLOR.warning}; }
  td.qv-crit .qv-fig { color: ${SEVERITY_COLOR.critical}; }
  td.qv-warn .qv-fig { color: ${SEVERITY_COLOR.warning}; }
  td.qv-ok .qv-fig { color: ${SEVERITY_COLOR.ok}; }
  /* --border is a BORDER colour; using it as text put #334155 on a near-black card,
     about 1.5:1, so every "2 / 2" and every em-dash was effectively unreadable.
     --muted is the legible secondary (about 7:1 dark, 4.8:1 light). */
  td.qv-na .qv-fig { color: var(--muted); font-weight: 500; }
  /* The scale column is not a verdict at all — it is the population every column to
     its right is counted over, so it reads as ordinary text rather than as an
     unmeasured cell. It only carried the na tint because it has no severity. */
  td.qv-scale .qv-fig { color: var(--text); font-weight: 600; }
  tr.qv-total th, tr.qv-total td { border-top: 2px solid var(--muted); }
  tr.qv-total th.qv-rowhead { font-weight: 700; }
  .qv-band { font-size: 12px; color: var(--muted); margin: 0 0 10px; line-height: 1.6; }
  .qv-doc { font-size: 11px; white-space: nowrap; }
  .qv-doc + .qv-doc { margin-left: 6px; }
  .qv-chip { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 11px;
    font-weight: 600; border: 1px solid; margin: 0 4px; }
  .qv-chip-c { color: ${SEVERITY_COLOR.critical}; border-color: ${SEVERITY_COLOR.critical}; }
  .qv-bandnote { display: block; margin-top: 4px; }
  /* Flash the rows a figure was computed from, so a link into a 40-row table says
     which rows it meant. Animation only — no layout shift, nothing to undo.
     Held long, and with a left rule for the duration: at 1.9s with a tint alone the
     highlight was reported as appearing and vanishing before the smooth scroll had
     even settled, which reads as a rendering glitch rather than as an answer. */
  @keyframes qvflash {
    0%, 100% { background: transparent; box-shadow: none; }
    6%, 78% { background: ${SEVERITY_TINT.warning}; box-shadow: inset 3px 0 0 ${SEVERITY_COLOR.warning}; }
  }
  .qv-flash { animation: qvflash 4.5s ease-in-out 1; }

  @media print {
    #toc, #toc-grip, #toc-show, .toc-btn { display: none !important; }
    body { padding-left: 16px; }
  }`;

const NAV_JS = `
  (function () {
    var root = document.documentElement, DEF = 232, MIN = 150, MAX = 560;
    function store(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
    function load(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
    function setWidth(px) {
      px = Math.max(MIN, Math.min(MAX, px));
      root.style.setProperty('--toc-w', px + 'px');
      store('dxr-toc-w', px);
    }
    function setHidden(on) {
      root.classList.toggle('toc-hidden', !!on);
      store('dxr-toc-hidden', on ? '1' : '0');
    }
    var w = parseInt(load('dxr-toc-w'), 10);
    if (w) setWidth(w);
    if (load('dxr-toc-hidden') === '1') setHidden(true);
    var hide = document.getElementById('toc-hide'), show = document.getElementById('toc-show');
    if (hide) hide.addEventListener('click', function () { setHidden(true); });
    if (show) show.addEventListener('click', function () { setHidden(false); });
    var grip = document.getElementById('toc-grip'), dragging = false;
    if (grip) {
      grip.addEventListener('mousedown', function (e) {
        dragging = true; root.classList.add('toc-resizing'); e.preventDefault();
      });
      grip.addEventListener('dblclick', function () { setWidth(DEF); });
    }
    document.addEventListener('mousemove', function (e) { if (dragging) setWidth(e.clientX); });
    document.addEventListener('mouseup', function () {
      dragging = false; root.classList.remove('toc-resizing');
    });
    // ---- per-gateway groups -------------------------------------------------
    // One open at a time. Several gateways expanded at once is how the pane grows
    // past a screen, which is the thing the grouping was meant to fix.
    var groups = [].slice.call(document.querySelectorAll('#toc .toc-group'));
    function openGroup(g, remember) {
      groups.forEach(function (o) { o.classList.toggle('open', o === g); });
      if (remember) store('dxr-toc-gw', g ? g.id : '');
    }
    groups.forEach(function (g) {
      var head = g.querySelector('a.gw'), caret = g.querySelector('.caret');
      if (caret) caret.addEventListener('click', function (e) {
        // Toggle only — the caret must not navigate, or there is no way to peek at
        // a gateway's subsections without leaving the section you are reading.
        e.preventDefault(); e.stopPropagation();
        var wasOpen = g.classList.contains('open');
        openGroup(wasOpen ? null : g, true);
      });
      if (head) head.addEventListener('click', function () { openGroup(g, true); });
    });
    var remembered = document.getElementById(load('dxr-toc-gw') || '');
    // Default: the first group, which is the worst-exposed gateway (the body and the
    // pane share one ordering). Opening none would hide the tree on first read.
    openGroup(remembered && remembered.classList.contains('toc-group') ? remembered : groups[0], false);

    var links = [].slice.call(document.querySelectorAll('#toc a'));
    var targets = links.map(function (a) { return document.getElementById(a.getAttribute('href').slice(1)); });
    function sync() {
      var best = 0;
      for (var i = 0; i < targets.length; i++) {
        if (targets[i] && targets[i].getBoundingClientRect().top <= 80) best = i;
      }
      links.forEach(function (a, i) { a.classList.toggle('active', i === best); });
      // Follow the reader: scrolling into a gateway's section opens its group, so the
      // active row is never hidden inside a collapsed one. Not remembered — only a
      // click is a choice.
      var host = links[best] && links[best].closest ? links[best].closest('.toc-group') : null;
      if (host && !host.classList.contains('open')) openGroup(host, false);
    }
    document.addEventListener('scroll', sync, { passive: true });
    sync();
  })();`;

function download(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Narrow a topology to the connections/VIFs/locations that feed a specific
 * DX Gateway. Matches the scoping logic in `recommendation-engine.buildDxgwScope`
 * so report figures line up with the per-DXGW resilience cards in the UI.
 */
function scopeTopologyForDxgw(topology: TopologyData, dxGatewayId: string): TopologyData {
  const scopedVifs = topology.virtualInterfaces.filter((v) => v.directConnectGatewayId === dxGatewayId);
  const scopedConnIds = new Set(scopedVifs.map((v) => v.connectionId).filter(Boolean) as string[]);
  const scopedConns = topology.connections.filter((c) => scopedConnIds.has(c.connectionId));
  const scopedLocationCodes = new Set<string>();
  for (const c of scopedConns) if (c.location) scopedLocationCodes.add(c.location);
  for (const v of scopedVifs) if (v.location) scopedLocationCodes.add(v.location);
  const scopedLocations = topology.locations.filter((l) => scopedLocationCodes.has(l.locationCode));
  return {
    ...topology,
    connections: scopedConns,
    virtualInterfaces: scopedVifs,
    locations: scopedLocations,
  };
}

function collectTopologyStats(topology: TopologyData) {
  // Counts distinct AWS logical devices per location — same gating as the
  // tier engine. Two connections sharing a logical device count as one.
  const locationConns = getLocationDeviceCounts(topology);
  // Same locations, both numbers. `locationConns` alone cannot describe an
  // asymmetric estate — see `getLocationLinkCounts`.
  const locationLinks = getLocationLinkCounts(topology);

  const dxRegions = new Set<string>();
  for (const c of topology.connections) if (c.region) dxRegions.add(c.region);
  for (const vif of topology.virtualInterfaces) if (vif.region) dxRegions.add(vif.region);

  const resourceRegions = new Set<string>();
  for (const v of topology.vpcs) if (v.region) resourceRegions.add(v.region);
  for (const tgw of topology.transitGateways) {
    const r = tgw.transitGatewayArn?.split(':')[3];
    if (r) resourceRegions.add(r);
  }

  return {
    locationConns,
    locationLinks,
    dxRegions: [...dxRegions].sort(),
    resourceRegions: [...resourceRegions].sort(),
    connectionCount: topology.connections.length,
    vifCount: topology.virtualInterfaces.length,
    vpnCount: topology.vpnConnections.length,
    vpcCount: topology.vpcs.length,
    tgwCount: topology.transitGateways.length,
    vgwCount: topology.vpnGateways.length,
    dxGatewayCount: topology.dxGateways.length,
  };
}

type TopologyStats = ReturnType<typeof collectTopologyStats>;

type UpgradeOption = { level: ResiliencyLevel; step: string };

function upgradeOptionsFor(level: ResiliencyLevel, stats: TopologyStats): UpgradeOption[] {
  const underprovisioned = [...stats.locationConns.entries()].filter(([, c]) => c < 2).map(([loc]) => loc);

  if (level === 'none') {
    return [
      { level: 'high', step: 'Provision Direct Connect at 2 separate locations (2 connections total).' },
      { level: 'maximum', step: 'Provision 2 connections at 2 separate locations (4 connections total).' },
    ];
  }
  if (level === 'devtest') {
    return [
      { level: 'high', step: 'Add a connection at a second location.' },
      { level: 'maximum', step: 'Add a second location with 2 connections.' },
    ];
  }
  if (level === 'high') {
    const list = underprovisioned.length === 1
      ? underprovisioned[0]
      : underprovisioned.length === 2
        ? underprovisioned.join(' and ')
        : `${underprovisioned.slice(0, -1).join(', ')}, and ${underprovisioned[underprovisioned.length - 1]}`;
    return [{ level: 'maximum', step: `Add a connection on a separate AWS logical device at ${list}.` }];
  }
  return [];
}

/**
 * `subject` names the scope these steps apply to. Without it the prose says "Your
 * setup", which reads as the whole account — actively misleading on an estate where
 * only one gateway is single-location and the others already span two.
 */
function nextStepsFor(level: ResiliencyLevel, stats: TopologyStats, subject?: string): string[] {
  const steps: string[] = [];
  const subj = subject ?? 'Your setup';
  const subjHas = subject ? `${subject} has` : 'You have';
  const locCount = stats.locationConns.size;
  const locName = locCount === 1 ? [...stats.locationConns.keys()][0] : '';
  const underprovisioned = [...stats.locationConns.entries()].filter(([, c]) => c < 2).map(([loc]) => loc);

  switch (level) {
    case 'none':
      steps.push('Provision at least one Direct Connect connection to begin.');
      steps.push('A single connection is covered by the AWS Single Connection SLA (95%) — add a connection at a second DX location to reach High Resiliency (99.9% SLA).');
      steps.push('Add a second connection at each location to reach Maximum Resiliency (99.99% SLA).');
      break;
    case 'devtest':
      steps.push(`${subj} terminates at a single Direct Connect location${locName ? ` (${locName})` : ''}, covered by the Single Connection SLA (95%). Add Direct Connect connections at a second location to protect against a location-wide outage.`);
      steps.push('The High Resiliency tier qualifies for the 99.9% connection SLA.');
      steps.push('Final step: ensure each location has at least 2 connections on separate devices to reach Maximum Resiliency (99.99% SLA).');
      break;
    case 'high':
      steps.push(`${subjHas} connections at ${locCount} locations. To reach Maximum Resiliency, each location needs at least 2 connections terminating on separate AWS logical devices.`);
      if (underprovisioned.length > 0) {
        steps.push(`Locations still on a single AWS logical device: ${underprovisioned.join(', ')}. Add a connection on a separate device at each of these (multiple connections sharing one device don't provide device redundancy).`);
      }
      steps.push('Once every location has at least 2 connections on separate AWS logical devices, you qualify for the 99.99% Direct Connect SLA.');
      break;
    case 'maximum':
      steps.push(`${subj} is at the highest tier (Maximum Resiliency, 99.99% SLA).`);
      steps.push('Review the operational best practices below to maintain and strengthen your resilience posture.');
      break;
  }
  return steps;
}

const SEVERITY_RANK: Record<string, number> = { critical: 3, warning: 2, info: 1 };

/**
 * Collapse emissions that describe the same condition into one row, keeping every
 * distinct description rather than only the first.
 *
 * Most rules run per-DX-gateway, so a topology-wide condition (`single-dx-location`,
 * `enterprise-support-required`) lands in the aggregate list once per gateway with
 * identical wording. The report has always deduped those — but it deduped the
 * best-practice list on `ruleId` alone, which also discarded emissions that were
 * genuinely different: `bgp-route-limit` reports "at teardown" for one VIF and
 * "approaching the limit" for another under one id, and only the first reached the
 * customer's copy. Keying on `ruleId` + `title` keeps those apart, and merging the
 * descriptions of a true duplicate keeps each gateway's evidence.
 *
 * The surviving row takes the group's WORST severity, so gateway iteration order
 * cannot decide whether a condition reads as critical or as advice.
 */
function mergeOccurrences(recs: Recommendation[]): Recommendation[] {
  const groups = new Map<string, Recommendation[]>();
  for (const r of recs) {
    const key = `${r.ruleId}::${r.title}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.values()].map((group) => {
    if (group.length === 1) return group[0];
    const worst = group.reduce((w, r) =>
      SEVERITY_RANK[r.severity] > SEVERITY_RANK[w.severity] ? r : w, group[0]);
    const descriptions = [...new Set(group.map((r) => r.description))];
    return { ...worst, description: descriptions.join(' ') };
  });
}

function recsByCategory(recs: Recommendation[]) {
  return {
    critical: recs.filter((r) => r.severity === 'critical'),
    warning: recs.filter((r) => r.severity === 'warning'),
    info: recs.filter((r) => r.severity === 'info'),
  };
}

type ReferenceStatus = 'applied' | 'gap' | 'attest';

type ClassifyResult = { status: ReferenceStatus; evidence?: string[] };

type BpRowStatus = 'alert' | 'gap' | 'applied' | 'verify';
type BpCategory = 'architecture' | 'configuration' | 'operations';
/**
 * `anchor` is set only for a row that came from a live rule, because those rows are
 * the ones whose full text is already printed as a finding card under All findings.
 * The row then links there instead of restating `detail` — the same prose twice in
 * one document is what made this section read as filler. Reference-only rows have
 * no card, so they keep their detail: it is the only place they are described.
 */
type BpRow = { practice: string; status: BpRowStatus; detail: string; evidence?: string[]; category: BpCategory; anchor?: string };

// Reference items covered by §1 resilience tier — don't duplicate into best practices.
const TIER_REF_TITLES = new Set([
  'Two DX locations minimum',
  'Two connections per location on separate DX devices',
]);

// Op-rule ruleIds that have a ref-item equivalent — keep the ref row, skip the op.
const OP_RULES_WITH_REF_EQUIVALENT = new Set([
  'bfd-guidance',
  'no-vpn-backup',
]);

/**
 * Which best-practice group a rule belongs to.
 *
 * This used to be a hand-kept table here, and it had drifted to 18 of the 42 rules
 * the engine can emit — the other 24 fell through a `?? 'configuration'` fallback
 * and were filed under Configuration regardless of what they are, so "Add a second
 * Direct Connect location" appeared as a configuration item. `RULE_META` carries
 * the category for every rule and a test fails when a new rule arrives without one,
 * which is the property the local table could not have.
 */
function categoryFor(ruleId: string): BpCategory {
  // Kept as a fallback rather than an assertion: an unrated rule must still appear
  // in the report. `rule-metadata.test.ts` is what makes this branch unreachable.
  return metaFor(ruleId)?.category ?? 'configuration';
}

type ReferenceItem = {
  title: string;
  detail: string;
  category: BpCategory;
  classify: (stats: TopologyStats, uncoveredRegions: string[], topology: TopologyData) => ClassifyResult;
};

const REFERENCE_ITEMS: ReferenceItem[] = [
  {
    title: 'Two DX locations minimum',
    detail: 'Protects against location-wide outages. Required for the 99.9% Direct Connect SLA.',
    category: 'architecture',
    classify: (s) => {
      if (s.locationConns.size === 0) return { status: 'attest' };
      if (s.locationConns.size < 2) return { status: 'gap' };
      return { status: 'applied', evidence: [...s.locationConns.keys()].sort() };
    },
  },
  {
    title: 'Two connections per location on separate DX devices',
    detail: 'Protects against hardware failure at a single location. Required for the 99.99% Direct Connect SLA.',
    category: 'architecture',
    classify: (s) => {
      if (s.locationConns.size === 0) return { status: 'attest' };
      const entries = [...s.locationConns.entries()].sort();
      if (!entries.every(([, c]) => c >= 2)) return { status: 'gap' };
      return { status: 'applied', evidence: entries.map(([loc, c]) => `${loc}: ${c} AWS logical devices`) };
    },
  },
  {
    title: 'Enable Bidirectional Forwarding Detection (BFD)',
    detail: 'Configure on the customer router for sub-second failover detection. BFD state is not visible via the AWS API — verify from your router.',
    category: 'configuration',
    classify: () => ({ status: 'attest' }),
  },
  {
    title: 'Configure a Site-to-Site VPN backup',
    detail: 'Provides an internet-based fallback path if all Direct Connect paths are unavailable.',
    category: 'architecture',
    classify: (s, _u, t) => {
      if (s.connectionCount === 0 && s.vifCount === 0) return { status: 'attest' };
      if (s.vpnCount === 0) return { status: 'gap' };
      const ids = t.vpnConnections.map((v) => v.vpnConnectionId).filter(Boolean);
      return { status: 'applied', evidence: ids };
    },
  },
  {
    title: 'Continuous monitoring of VIF BGP state and connection state',
    detail: 'Use CloudWatch metrics and alarms on BGP sessions and connection availability.',
    category: 'operations',
    classify: () => ({ status: 'attest' }),
  },
  {
    title: 'Regularly test failover',
    detail: 'Simulate link loss and confirm traffic re-routes to the backup path automatically.',
    category: 'operations',
    classify: () => ({ status: 'attest' }),
  },
  {
    title: 'Use a Direct Connect Gateway',
    detail: 'Share Direct Connect connections across regions and accounts using a DX Gateway.',
    category: 'architecture',
    classify: (s, _u, t) => {
      if (s.dxGatewayCount === 0) return { status: 'attest' };
      const ids = t.dxGateways.map((g) =>
        g.directConnectGatewayName ? `${g.directConnectGatewayName} (${g.directConnectGatewayId})` : g.directConnectGatewayId
      );
      return { status: 'applied', evidence: ids };
    },
  },
  {
    title: 'Stay within BGP advertisement limits',
    detail: 'Private VIFs accept up to 100 prefixes; public VIFs up to 1000. Summarise routes where possible.',
    category: 'configuration',
    classify: () => ({ status: 'attest' }),
  },
  {
    title: 'Document and maintain a fail-over runbook',
    detail: 'Keep the runbook in sync with topology changes and train on-call staff regularly.',
    category: 'operations',
    classify: () => ({ status: 'attest' }),
  },
];

/**
 * Reference-grade material, folded shut.
 *
 * The report is read once for a decision and kept as a record, and those two want
 * opposite lengths. Deleting the record half is not an option — the inventory and
 * the informational findings are what make a figure above checkable — so the long
 * blocks collapse instead: the document reads at decision length and every byte is
 * one click away, with the count on the summary so a fold never hides how much.
 *
 * `summary` is HTML and carries the section's own heading, keeping its `id` a live
 * anchor target. Two scripts at the foot of the document make that safe: one opens
 * a fold's ancestors when something links into it (a closed `<details>` otherwise
 * swallows the jump silently), and one opens every fold before printing, since a
 * PDF has no clicks and CSS alone cannot reliably force a `<details>` open.
 */
function fold(summary: string, body: string, count?: number): string {
  const n = count === undefined ? '' : `<span class="fold-n">${count}</span>`;
  return `<details class="fold">
    <summary class="fold-s">${summary}${n}</summary>
    <div class="fold-b">${body}</div>
  </details>`;
}

/**
 * The severity-grouped finding cards.
 *
 * Each card carries its published id as both anchor and visible label, so a row in
 * the ranked table links here and the reader can see they arrived at the right one.
 * The anchors previously marked only the first card of each severity, which meant
 * nothing outside this section could point at an individual finding.
 */
function renderRecListHtml(recs: Recommendation[], anchors: Map<string, string>): string {
  if (recs.length === 0) return '';
  return recs.map((r) => {
    const anchor = anchors.get(`${r.ruleId}::${r.title}`);
    const meta = metaFor(r.ruleId);
    return `
    <div${anchor ? ` id="${anchor}"` : ''} class="finding severity-${r.severity}">
      <div class="finding-head">
        <span class="severity-tag" style="background:${SEVERITY_COLOR[r.severity]}20;color:${SEVERITY_COLOR[r.severity]};border:1px solid ${SEVERITY_COLOR[r.severity]}50">${SEVERITY_LABEL[r.severity]}</span>
        <h4>${escapeHtml(r.title)}</h4>
        ${meta ? `<code class="finding-id">${escapeHtml(meta.publishedId)}</code>` : ''}
      </div>
      <p>${escapeHtml(r.description)}</p>
    </div>
  `;
  }).join('');
}

const TIER_RANK: Record<ResiliencyLevel, number> = { none: 0, devtest: 1, high: 2, maximum: 3 };

/**
 * Short, factual executive summary. Deliberately templated, not narrative: the
 * export has to work offline with no model available, so it states what the data
 * says and points at the sections rather than trying to interpret across them.
 *
 * The one judgement it does make is refusing a single headline tier. Scopes are
 * assessed independently, so an estate with gateways at 99.99% and 95% has no
 * one posture — quoting either overstates half of it.
 */
function renderExecutiveSummary(
  assessment: CombinedAssessment,
  stats: TopologyStats,
  counts: { critical: number; warning: number; info: number },
  worst: { critical: Recommendation[]; warning: Recommendation[] },
): string {
  type Scope = { name: string; level: ResiliencyLevel; dxgwId?: string };
  const scopes: Scope[] = [
    ...assessment.perDxGateway
      .filter((g) => !g.isUnattached)
      .map((g) => ({ name: g.dxGatewayName || g.dxGatewayId, level: g.currentLevel, dxgwId: g.dxGatewayId })),
    ...(assessment.perVgw ?? []).map((v) => ({ name: v.vgwName || v.vgwId, level: v.currentLevel })),
  ];

  const byTier = new Map<ResiliencyLevel, string[]>();
  for (const s of scopes) byTier.set(s.level, [...(byTier.get(s.level) ?? []), s.name]);
  const tiersPresent = [...byTier.keys()].sort((a, b) => TIER_RANK[b] - TIER_RANK[a]);

  const estate = [
    `${stats.connectionCount} connection${stats.connectionCount === 1 ? '' : 's'}`,
    `${stats.vifCount} virtual interface${stats.vifCount === 1 ? '' : 's'}`,
    `${stats.dxGatewayCount} DX gateway${stats.dxGatewayCount === 1 ? '' : 's'}`,
    `${stats.locationConns.size} DX location${stats.locationConns.size === 1 ? '' : 's'}`,
  ].join(', ');

  const posture = scopes.length === 0
    ? `<p>No Direct Connect gateway or DX-reached virtual private gateway was found, so there is no scope to tier.</p>`
    : tiersPresent.length === 1
      ? `<p>${scopes.length === 1 ? 'The single assessed scope sits' : `All ${scopes.length} assessed scopes sit`} at <strong>${TIER_LABELS[tiersPresent[0]]}</strong> — ${escapeHtml(TIER_SLA[tiersPresent[0]])}.</p>`
      : `<p><strong>Resilience is uneven across scopes, so there is no single figure for this
         account.</strong> ${tiersPresent.map((t) =>
        `${byTier.get(t)!.length} at ${TIER_LABELS[t]}`).join(', ')} — the weakest is
         <em>${escapeHtml(byTier.get(tiersPresent[tiersPresent.length - 1])![0])}</em>
         at ${escapeHtml(TIER_SLA[tiersPresent[tiersPresent.length - 1]])}. Quoting the best tier
         would overstate ${scopes.length - byTier.get(tiersPresent[0])!.length} of them.</p>`;

  // "is 1 critical finding" / "are 2 critical findings" / "are no critical findings"
  const isAre = counts.critical === 1 ? 'is' : 'are';
  const headline = counts.critical > 0
    ? `<strong>${counts.critical} critical finding${counts.critical === 1 ? '' : 's'}</strong> breaking the data plane today`
    : `<strong>no critical findings</strong>`;

  const top = [...worst.critical, ...worst.warning].slice(0, 3);
  const whatsWrong = top.length
    ? `<p>There ${isAre} ${headline}, and ${counts.warning} warning${counts.warning === 1 ? '' : 's'}. The most material:
       ${top.map((r) => `<em>${escapeHtml(r.title)}</em>`).join('; ')}. Full detail, with the AWS field
       behind each, is under Findings; Best practices below covers the same rule set including the
       checks that passed.</p>`
    : `<p>There ${isAre} ${headline} and no warnings. Best practices below lists every check that was evaluated, including the passes.</p>`;

  // Deliberately no "Next steps" list here. It used to repeat `nextStepsFor` for the
  // weakest scope, which is the same prose the Per-DX Gateway assessment already
  // prints under "How to Improve" for *every* scope, and the ranked plan prints in
  // priority order — three lists of the same advice, the shortest of them account-wide
  // and therefore the least accurate. The summary's own contribution is the tier
  // posture plus the three most material findings by name; "What to do first" ranks.
  return `${posture}
    <p class="meta">Estate: ${escapeHtml(estate)}${stats.vpnCount
      ? `, ${stats.vpnCount} Site-to-Site VPN${stats.vpnCount === 1 ? '' : 's'}`
      : ', no Site-to-Site VPN backup'}.</p>
    ${whatsWrong}`;
}

/**
 * The three severity counts as a scannable strip at the top of the report.
 *
 * Severity, not impact, on purpose: this strip answers "what is in the Findings
 * section" and its cards jump straight there, so it has to count the same thing the
 * section groups by and the sidebar badges show. Impact and effort — which is what
 * you act on — drive "What to do first" and the ranked table below it. Mixing the
 * two vocabularies in one strip would make the numbers fail to add up against
 * either section.
 */
function renderFindingsStrip(counts: { critical: number; warning: number; info: number }): string {
  const CARDS = [
    { sev: 'critical', hint: 'breaking the data plane today' },
    { sev: 'warning', hint: 'degraded, or resilience already lost' },
    { sev: 'info', hint: 'advice and checks that passed' },
  ] as const;
  return `<div class="findings-strip">${CARDS.map(({ sev, hint }) => {
    const n = counts[sev];
    return `<a class="finding-card clickable f-${sev}${n === 0 ? ' zero' : ''}" href="#findings-${sev}">
      <span class="count">${n}</span>
      <div class="caption">
        <div class="name">${SEVERITY_LABEL[sev]}</div>
        <div class="hint">${escapeHtml(hint)}</div>
      </div>
    </a>`;
  }).join('')}</div>`;
}

/**
 * The four verdicts a prefix×VIF cell can carry. Printed under every gateway's own
 * matrix rather than once estate-wide, because the matrix moved into the gateway
 * cards and a glyph legend a section away from its glyphs is not a legend.
 */
/**
 * `2026-09-01 14:32 UTC`. Explicitly UTC and fixed-width, because the reader is
 * correlating this against a CloudWatch console and a change record — a
 * locale-formatted local time turns that into arithmetic. Deliberately absolute, not
 * "3 days ago": the file is read weeks after it is written, and a relative age decays
 * silently into a wrong statement.
 */
function formatUtcStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} `
    + `${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

const ROUTE_DIFF_LEGEND = `<p class="meta">
  <span class="chip-pill v-solo">solo</span> one VIF carries it, no failover path &middot;
  <span class="chip-pill v-partial">partial</span> a sibling covers only fragments inside the
  block &middot; <span class="chip-pill v-covered">covered</span> a sibling holds a less specific
  route that still reaches it &mdash; healthy &middot;
  <span class="chip-pill v-redundant">redundant</span> two or more VIFs carry it exactly.
  Accepted routes only, from <code>directconnect:ListVirtualInterfaceRoutes</code>; advertised
  routes are not compared, being identical across a gateway's VIFs by construction. A flagged
  prefix may be deliberate traffic engineering &mdash; confirm before changing a router.
  Reference: ${docLink(DOC.routing)}</p>`;

const ROUTE_COLUMNS = [
  'Virtual interface', 'VIF ID', 'Type', 'Connection', 'Terminates on',
  'Prefix', 'Family', 'AS path', 'Hops',
] as const;

/**
 * One prefix on one VIF. Values are display-ready and masked.
 *
 * `direction` sits outside `cells` because it partitions the output rather than
 * appearing in it — each direction gets its own table and its own workbook sheet, so a
 * column repeating "Received" down 900 rows would carry no information.
 */
interface RouteTableRow {
  direction: 'Received' | 'Advertised';
  cells: Record<(typeof ROUTE_COLUMNS)[number], string | number>;
}

/**
 * Every prefix on every VIF, both directions, flat.
 *
 * Flat and per-prefix on purpose: this is the sheet an operator diffs against their
 * router, so one row per (VIF, direction, prefix) is the shape that sorts and filters.
 * The per-gateway matrices answer "is there a failover path"; this answers "what
 * exactly is on the wire", which no aggregate can.
 *
 * AS paths are masked HERE with `redactAsn()`, per hop. The report's single `mask()`
 * pass uses `redact()`, which only masks a *labelled* ASN (`ASN: 65000`) — a bare
 * `65006 65010` would ship in the clear in a redacted export, silently.
 */
function buildRouteTableRows(topology: TopologyData, redacted: boolean): RouteTableRow[] {
  const vifRoutes = topology.vifRoutes;
  if (!vifRoutes || vifRoutes.size === 0) return [];
  const connById = new Map(topology.connections.map((c) => [c.connectionId, c]));
  const gwName = new Map(topology.dxGateways.map((g) =>
    [g.directConnectGatewayId, g.directConnectGatewayName || g.directConnectGatewayId]));

  const rows: RouteTableRow[] = [];
  const vifs = [...topology.virtualInterfaces]
    .sort((a, b) => vifLabel(a).localeCompare(vifLabel(b), undefined, { numeric: true }));

  for (const vif of vifs) {
    const entry = vifRoutes.get(vif.virtualInterfaceId);
    if (!entry) continue;
    const conn = connById.get(vif.connectionId);
    const terminates = vif.directConnectGatewayId
      ? `DXGW ${gwName.get(vif.directConnectGatewayId) ?? vif.directConnectGatewayId}`
      : vif.virtualGatewayId
        ? `VGW ${vif.virtualGatewayId}`
        : vif.virtualInterfaceType === 'public'
          ? 'AWS public network'
          : 'not recorded';

    for (const [direction, routes] of [
      ['Received', entry.accepted],
      ['Advertised', entry.advertised],
    ] as const) {
      for (const r of routes ?? []) {
        const hops = (r.asPath ?? []).flatMap((seg) => seg.path ?? []);
        rows.push({
          direction,
          cells: {
            'Virtual interface': vifLabel(vif),
            'VIF ID': vif.virtualInterfaceId,
            Type: vif.virtualInterfaceType,
            Connection: conn?.connectionId ?? vif.connectionId,
            'Terminates on': terminates,
            Prefix: r.cidr,
            // The rules count a route with no family as IPv4, so the sheet must not
            // print "ipv4" for something AWS never actually said.
            Family: r.addressFamily ?? 'not reported',
            // `direct` rather than blank: an empty AS path means the prefix originates
            // on the attached peer, which is an answer — a blank reads as missing data.
            'AS path': hops.length
              ? hops.map((asn) => redactAsn(asn, redacted)).join(' ')
              : 'direct',
            Hops: hops.length,
          },
        });
      }
    }
  }
  return rows;
}




/**
 * The report embeds its rows and builds the file in the browser, so a colleague who
 * was sent only the HTML can still get the CSV — without the app, without AWS
 * credentials, straight off a local disk.
 *
 * JSON rather than a pre-built CSV string because the escaping then happens once, in
 * one place, at download time. `<` is escaped to `<` so a rule description can
 * never close the script element early.
 */
/** Rows printed per direction before the appendix says what it omitted. */
const ROUTE_TABLE_MAX_ROWS = 400;

/** Identity of one received prefix on one VIF, for anchoring and looking it up. */
const routeRowKey = (vifId: string, cidr: string) => `${vifId}|${cidr}`;

/**
 * Anchor ids for the Received-routes rows the appendix will actually print, so a
 * `1(3)` in a route-diff matrix can link to the row that proves it.
 *
 * Assigned here, up front, rather than while rendering the appendix: the matrices are
 * built earlier in the document than the appendix they point into, so the ids have to
 * exist before either is emitted. `renderRouteTables` then reads the SAME map instead
 * of numbering rows again — two independent numberings of one list is how a link comes
 * to land on the wrong row.
 *
 * Ordinal (`rr-12`), never the prefix or the VIF id. `redact()` masks a CIDR and a
 * `dxvif-<hex>` wherever they appear, INCLUDING inside `id=` and `href=`, so an anchor
 * built from either would decay to bullets in a redacted export and resolve to nothing
 * — the one export a customer actually receives.
 *
 * Capped to the rows that get printed: the appendix defers past
 * `ROUTE_TABLE_MAX_ROWS` to the workbook, and a link into a row that was cut is a dead
 * link.
 */
function receivedRouteAnchors(rows: RouteTableRow[]): Map<string, string> {
  const out = new Map<string, string>();
  rows
    .filter((r) => r.direction === 'Received')
    .slice(0, ROUTE_TABLE_MAX_ROWS)
    .forEach((r, i) => {
      const key = routeRowKey(String(r.cells['VIF ID']), String(r.cells.Prefix));
      // First wins: a VIF returns a prefix once per logical device, and the appendix
      // prints every copy, so the link goes to the first — which is the one the reader
      // lands on and can then read the duplicates below.
      if (!out.has(key)) out.set(key, `rr-${i + 1}`);
    });
  return out;
}

/**
 * The full route tables, as an appendix.
 *
 * At the end because it is reference, not analysis: nobody opens the report to read
 * 900 prefixes, but the operator who has to reconcile one against a router needs every
 * row. Folded shut for the same reason.
 *
 * The HTML is capped per direction and says by how much; the workbook export is not
 * capped, which is the whole reason it exists. A silent truncation here would read as
 * "this is all your routes".
 */
function renderRouteTables(
  rows: RouteTableRow[],
  routesMissing: string,
  anchors: Map<string, string>,
): string {
  if (rows.length === 0) {
    return `<p class="meta">${routesMissing}</p>`;
  }
  const table = (direction: RouteTableRow['direction']) => {
    const all = rows.filter((r) => r.direction === direction);
    if (all.length === 0) {
      return `<p class="meta">No ${direction.toLowerCase()} prefixes were returned for any VIF.</p>`;
    }
    const shown = all.slice(0, ROUTE_TABLE_MAX_ROWS);
    const body = shown.map((r) => {
      // Read from the shared map rather than numbered again here — see
      // `receivedRouteAnchors` for why one numbering has to serve both ends.
      const id = anchors.get(routeRowKey(String(r.cells['VIF ID']), String(r.cells.Prefix)));
      return `<tr${id ? ` id="${id}"` : ''}>${ROUTE_COLUMNS.map((c) => {
        const v = r.cells[c];
        const cls = c === 'Hops' ? ' class="num"' : c === 'AS path' ? ' class="as-path-cell"' : '';
        return `<td${cls}>${escapeHtml(String(v))}</td>`;
      }).join('')}</tr>`;
    }).join('');
    const cut = all.length - shown.length;
    return `<table class="route-table">
        <thead><tr>${ROUTE_COLUMNS.map((c) =>
          `<th${c === 'Hops' ? ' style="text-align:right"' : ''}>${escapeHtml(c)}</th>`).join('')}</tr></thead>
        <tbody>${body}</tbody>
      </table>
      ${cut > 0
        ? `<p class="meta">Showing ${shown.length} of ${all.length} ${direction.toLowerCase()}
           prefixes &mdash; ${cut} not listed here. The gateway's Route diff panel in the
           app lists every one.</p>`
        : ''}`;
  };
  const counts = (d: RouteTableRow['direction']) => rows.filter((r) => r.direction === d).length;
  return `<p class="meta">Every prefix on every VIF, with the AS path it arrived by.
    <strong>Received</strong> is what on-premises advertises to AWS;
    <strong>Advertised</strong> is what AWS sends back. <code>direct</code> means an empty
    AS path &mdash; originated by the attached peer. Reference: ${docLink(DOC.routing)}</p>
    ${fold('<h3>Received routes</h3>', table('Received'), counts('Received'))}
    ${fold('<h3>Advertised routes</h3>', table('Advertised'), counts('Advertised'))}`;
}




/**
 * Open any collapsed `<details>` the URL fragment points inside, then scroll to it.
 *
 * The Route tables appendix is folded shut — it is 400 rows of reference — so a matrix
 * cell linking to a row inside it lands on a target the browser cannot scroll to while
 * its ancestor is closed. Recent Chrome, Safari and Firefox auto-expand for fragment
 * navigation, but not every browser a customer opens this file in does, and the failure
 * is silent: the click appears to do nothing.
 *
 * Runs on load and on every hash change, because the reader clicks several of these.
 */
const FOLD_JS = `
  (function () {
    function reveal() {
      var id = decodeURIComponent((location.hash || '').slice(1));
      if (!id) return;
      var el = document.getElementById(id);
      if (!el) return;
      var opened = false;
      for (var p = el.parentElement; p; p = p.parentElement) {
        if (p.tagName === 'DETAILS' && !p.open) { p.open = true; opened = true; }
      }
      // Only re-scroll when something was opened: the browser has already positioned
      // the page otherwise, and scrolling again fights a smooth scroll in progress.
      if (opened) el.scrollIntoView({ block: 'center' });
    }
    window.addEventListener('hashchange', reveal);
    // Deferred: on first load the target may still be inside a closed element when
    // the browser makes its own scroll attempt.
    if (location.hash) setTimeout(reveal, 0);
  })();`;


/**
 * The numeric impact table. See `report-quickview.ts` for why it exists beside the
 * theme matrix rather than replacing it.
 *
 * Cells link into the section holding their records, and carry `data-focus` so the
 * small script at the foot of the report can flash the matching rows on arrival —
 * a figure that lands the reader in a 40-row table without saying which rows it
 * came from has only moved the work, not done it.
 */
const QV_SEV_CLASS: Record<QuickViewSeverity, string> = {
  critical: 'qv-crit',
  warning: 'qv-warn',
  ok: 'qv-ok',
  na: 'qv-na',
};

/** Amber for both fault states: a site that cannot confirm redundancy and a site
 *  that demonstrably lacks it are the same instruction to the reader. */
const QV_CHIP_CLASS: Record<QuickViewChip['state'], string> = {
  ok: 'chip-ok',
  weak: 'chip-gap',
  unknown: 'chip-gap',
};

/**
 * Per-location `conn·dev` chips for the locations cell.
 *
 * `<span>`, never `<a>`: `renderQuickViewCell` already wraps the whole cell body in
 * one `a.qv-cell`, and a nested anchor is invalid HTML — the browser closes the
 * outer one early and the rest of the cell stops being a link. The chips these
 * replaced (in the per-gateway assessment table) were each their own anchor, which
 * is exactly what must not be copied across.
 */
function renderQuickViewChips(chips: QuickViewChip[]): string {
  return `<span class="qv-chips">${chips
    .map((c) => `<span class="table-chip link-chip ${QV_CHIP_CLASS[c.state]}" title="${escapeHtml(c.title)}">`
      + `${escapeHtml(c.label)} <strong>${escapeHtml(c.value)}</strong></span>`)
    .join(' ')}</span>`;
}

function renderQuickViewCell(
  cell: QuickViewCell,
  numeric: boolean,
  gwNavIds: Map<string, string>,
  targetId: string | undefined,
  columnId: QuickViewColumnId,
  /** Gateway id → anchor of the first flagged row in its route-diff matrix. */
  gwPrefixAnchors: Map<string, string>,
): string {
  const body = `<span class="qv-fig">${escapeHtml(cell.figure)}</span>${
    cell.chips?.length
      ? renderQuickViewChips(cell.chips)
      : cell.detail ? `<span class="qv-of">${escapeHtml(cell.detail)}</span>` : ''
  }`;

  let href: string | undefined;
  // The three gateway variants differ only in which subsection of the card they open.
  // Landing the reader on the card's heading and making them scan for the table that
  // backs the figure they clicked is the same work they came here to avoid.
  if (cell.section === 'gateway' || cell.section === 'gateway-posture' || cell.section === 'gateway-vifs') {
    const nav = targetId ? gwNavIds.get(targetId) : undefined;
    const suffix = cell.section === 'gateway-posture'
      ? '-posture'
      : cell.section === 'gateway-vifs' ? '-vifs' : '';
    href = nav ? `#${nav}${suffix}` : '#per-dx-gateway';
  } else if (cell.section === 'route-analysis') {
    // "3 of 223 · 3 solo" lands on the first prefix it counted, not on a section
    // heading — the reader's next question is *which* prefix, and the matrix is
    // ordered worst-first so that row is the top one. Only the prefix column: the
    // quota column counts VIFs, whose rows are the gateway's VIF inventory.
    const prefixRow = columnId === 'soloPrefixes' && targetId
      ? gwPrefixAnchors.get(targetId)
      : undefined;
    if (prefixRow) {
      href = prefixRow.startsWith('#') ? prefixRow : `#${prefixRow}`;
    } else {
      // The matrices live inside the gateway cards now, so a row with no flagged
      // prefix falls back to its own gateway rather than to an estate-wide section
      // that no longer exists. The account-total row has no gateway, hence the
      // section heading as the last resort.
      const nav = targetId ? gwNavIds.get(targetId) : undefined;
      href = nav ? `#${nav}-prefix` : '#per-dx-gateway';
    }
  } else if (cell.section === 'inventory') {
    href = '#inventory';
  } else if (cell.section === 'findings') {
    href = '#findings';
  } else if (cell.section === 'best-practices') {
    href = '#best-practices';
  }

  const focus = cell.focusIds && cell.focusIds.length
    ? ` data-focus="${escapeHtml(cell.focusIds.join(' '))}"`
    : '';
  const inner = href ? `<a class="qv-cell" href="${href}"${focus}>${body}</a>` : body;
  const scale = columnId === 'scale' ? ' qv-scale' : '';
  return `<td class="${numeric ? 'qv-num ' : ''}${QV_SEV_CLASS[cell.severity]}${scale}">${inner}</td>`;
}

/**
 * The row's tier, as badges under the gateway name in the row head.
 *
 * It was a column of its own, and the row head had a name, an id and then blank
 * space beneath them — two things wrong at once. A tier is not a count over a
 * population like every other column here, so as a cell it broke the grid's one
 * rule; and putting it in the row head fills the space that made every row look
 * unfinished. The badges use `TIER_BADGE_COLOR`, the same palette the gateway cards
 * use, so a reader matching a row to a card is matching on colour as well as name.
 */
function renderRowTier(tier: QuickViewTier, nav: string | undefined): string {
  const label = (level: ResiliencyLevel, compact: boolean) =>
    `<span class="tier-badge" style="background:${TIER_BADGE_COLOR[level]}">${
      escapeHtml(compact ? TIER_LABELS[level].replace(' Resiliency', '') : TIER_LABELS[level])
    }</span>`;
  if (!tier.currentLevel) {
    return `<span class="qv-tier"><span class="qv-tier-none">${escapeHtml(tier.note)}</span></span>`;
  }
  const badges = tier.targetLevel
    ? `${label(tier.currentLevel, true)}<span class="qv-tier-arrow">&rarr;</span>${label(tier.targetLevel, true)}`
    : label(tier.currentLevel, false);
  const body = `<span class="qv-tier">${badges}<span class="qv-tier-note">${escapeHtml(tier.note)}</span></span>`;
  // Linked to the gateway's posture card, which is where the tier is derived — the
  // badge states a verdict, and the checklist behind it is one section down.
  return nav ? `<a class="qv-tier-link" href="#${nav}-posture">${body}</a>` : body;
}

function renderQuickView(
  qv: QuickView,
  gwNavIds: Map<string, string>,
  gwPrefixAnchors: Map<string, string>,
): string {
  /**
   * Floor widths per column, so the table's proportions come from what each column
   * has to SAY rather than from whatever its longest header word happens to be.
   *
   * Keyed by column, not by index: the gateway `<th>` is emitted separately below, so
   * index 0 here is `scale`. It used to get 150px through exactly that off-by-one,
   * which handed the widest floor in the table to the one column whose content is
   * always four characters (`2 / 2`) and left the three count columns beside it so
   * narrow that `LINKS ON ONE DEVICE` stacked one word per line.
   *
   * The counts are `0 of 22`, so ~96px fits the figure and lets the two-word headers
   * break in two rather than five. `locations` is wider because it carries chips.
   * `lastDown` holds a `2026-09-01 14:32 UTC` stamp, which must not wrap.
   */
  const QV_MIN_WIDTH: Record<QuickViewColumnId, string> = {
    scale: '76px',
    locations: '124px',
    sharedDevice: '96px',
    soloPrefixes: '96px',
    prefixQuota: '104px',
    lastDown: '146px',
  };
  const head = qv.columns
    .map((c) => `<th class="${c.numeric ? 'qv-num' : ''}" style="min-width:${QV_MIN_WIDTH[c.id]}">`
      + `${escapeHtml(c.label)}<span class="qv-u">${escapeHtml(c.sublabel)}</span></th>`)
    .join('');

  const rows = qv.rows.map((row) => {
    const nav = row.targetId ? gwNavIds.get(row.targetId) : undefined;
    const label = nav
      ? `<a href="#${nav}">${escapeHtml(row.label)}</a>`
      : escapeHtml(row.label);
    const cells = qv.columns
      .map((c) => {
        const cell = row.cells.get(c.id);
        if (!cell) return `<td class="${c.numeric ? 'qv-num ' : ''}qv-na"><span class="qv-fig">&mdash;</span></td>`;
        return renderQuickViewCell(cell, c.numeric, gwNavIds, row.targetId, c.id, gwPrefixAnchors);
      })
      .join('');
    return `<tr class="qv-${row.kind}">
      <th class="qv-rowhead">${label}${row.sublabel ? `<span class="qv-sub">${escapeHtml(row.sublabel)}</span>` : ''}${renderRowTier(row.tier, nav)}</th>
      ${cells}
    </tr>`;
  }).join('');

  const legend = qv.columns
    .map((c) => {
      const refs = (c.docs ?? [])
        .map((d) => ` <span class="qv-doc">${docLink(d)}</span>`)
        .join('');
      return `<li><strong>${escapeHtml(c.label)}</strong> — ${escapeHtml(c.blurb)}${refs}</li>`;
    })
    .join('');

  return `<div class="qv-wrap">
    <table class="qv">
      <thead><tr><th class="qv-rowhead" style="min-width:196px">Direct Connect gateway
        <span class="qv-u">Name, ID and resiliency tier</span></th>${head}</tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
  <p class="qv-band">Prefix quota, per VIF per address family:
    <span class="qv-chip qv-chip-c">&gt;100% &mdash; BGP session could drop</span></p>
  <details class="cmatrix-key">
    <summary>Column definitions</summary>
    <ul class="col-key">${legend}</ul>
  </details>`;
}

/**
 * A VIF's display identity. Never the connection name: on a hosted-VIF account
 * `fetch-topology.ts` names an *inferred* connection after the VIF that revealed
 * it, so the two strings collide — the ID beside the name is what separates them.
 */
function vifLabel(v: DxVirtualInterface): string {
  return v.virtualInterfaceName || v.virtualInterfaceId;
}

function nameWithId(name: string, id: string): string {
  return name && name !== id
    ? `${escapeHtml(name)} <code class="inline-id">${escapeHtml(id)}</code>`
    : `<code class="inline-id">${escapeHtml(id)}</code>`;
}

/* ---------------------------------------------------------------------------
 * BGP route analysis
 *
 * Same data and the same grading rule as the canvas's DXGW "Route diff" panel
 * (`computeDxgwRouteDiff`) — no new API call, it re-reads `topology.vifRoutes`.
 * Only ACCEPTED routes are compared: advertised prefixes come from the
 * gateway association's `allowedPrefixes`, identical across a gateway's VIFs by
 * construction, so comparing them can only surface convergence noise.
 * ------------------------------------------------------------------------- */

/**
 * Rows per gateway matrix before the report switches to flagged-only. A
 * 100-prefix gateway would otherwise bury its findings under a wall of ✓ — and
 * whatever is dropped is always stated, never silently truncated.
 */
const ROUTE_MATRIX_MAX_ROWS = 60;

/**
 * The four marks are the `&#10003;`/`&#9675;`/`&#9651;`/`&#215;` rating convention, chosen so the
 * states differ by OUTLINE rather than by fill. Fill-based pairs (`&#9679;` vs `&#9680;`, and
 * worse `&#9679;` vs `&#9682;`) share a silhouette, so at the 11px these actually render
 * at, they separate only by colour — which fails in greyscale, in print, and for a
 * red/green colour-blind reader. Circle vs triangle survives all three, leaving colour
 * as reinforcement instead of the sole cue.
 *
 * Every glyph is exactly ONE monospace cell wide, which the matrix grid depends on for
 * its columns to line up. That rules out `&#12295;` U+3007, the ideographic zero: it is a
 * CJK codepoint, so it falls out of this stack into a CJK font and measures 1.66 cells
 * (44.0px against 26.5px at 44px) — visibly oversized, and a tofu box on a machine with
 * no CJK font at all.
 *
 * `&#215;` U+00D7 is Latin-1, so it has the widest font coverage of anything here. It
 * replaced `&middot;`, a period doing a glyph's job: it painted a quarter of the ink and
 * was indistinguishable from the `&middot;` this file uses ~40 times as a plain separator.
 *
 * Colour is severity, NOT degree of coverage: `covered` is healthy (see `.mark-covered`),
 * so it must not share the amber of a real warning.
 */
const CELL_MARK: Record<CellState, { glyph: string; cls: string; title: string }> = {
  exact: { glyph: '&#10003;', cls: 'mark-exact', title: 'accepts this prefix' },
  covered: { glyph: '&#9675;', cls: 'mark-covered', title: 'covered by a less specific route' },
  partial: { glyph: '&#9651;', cls: 'mark-partial', title: 'carries only part of the block' },
  absent: { glyph: '&#215;', cls: 'mark-absent', title: 'cannot reach any part of this prefix' },
};

/** Worst first — the same order the interactive panel uses. */
const ROW_ORDER: Record<RowVerdict, number> = { solo: 0, partial: 1, covered: 2, redundant: 3 };

const VERDICT_STYLE: Record<RowVerdict, { label: string; cls: string }> = {
  solo: { label: 'solo', cls: 'v-solo' },
  partial: { label: 'partial', cls: 'v-partial' },
  covered: { label: 'covered', cls: 'v-covered' },
  redundant: { label: 'redundant', cls: 'v-redundant' },
};

/** "12" or "12 (v4 10 · v6 2)" — the quota is per address family, so the split matters. */
/**
 * Distinct prefixes, per family — never route entries.
 *
 * ListVirtualInterfaceRoutes returns the same prefix once per AWS logical device
 * it is installed on, so counting entries doubles the figure on a redundant
 * gateway. `acceptedByFamily` in the engine already dedupes; this cell is the
 * number the reader compares against the allocation two columns over, so it has
 * to agree with it.
 */
function routeCountCell(routes: VifRoute[]): string {
  routes = uniqueByCidr(routes);
  let v4 = 0;
  let v6 = 0;
  let unset = 0;
  for (const rt of routes) {
    if (rt.addressFamily === 'ipv6') v6++;
    else if (rt.addressFamily === 'ipv4') v4++;
    else unset++;
  }
  if (v6 === 0 && unset === 0) return `${routes.length}`;
  const parts: string[] = [];
  if (v4) parts.push(`v4 ${v4}`);
  if (v6) parts.push(`v6 ${v6}`);
  if (unset) parts.push(`family unset ${unset}`);
  return `${routes.length} <span class="sub">(${parts.join(' &middot; ')})</span>`;
}

/**
 * Accepted prefixes over the allocation they are enforced against, per family.
 *
 * One column, not two: the pair is a fraction. The reader's question is how close
 * this VIF is to its ceiling, and an accepted count sitting two columns from its
 * denominator makes them do the division by eye.
 *
 * Families are listed separately because the quota is enforced per family — 100
 * each for IPv4 and IPv6, not 100 pooled — so a single combined fraction would be
 * the wrong number for both. 60/100 (ipv4) beside 55/100 (ipv6) is healthy; the
 * same data pooled reads 115/100 and looks like imminent teardown.
 *
 * The three allocation states must not collapse: a number, the fixed public-VIF
 * session limit, and "not reported" for an allocation AWS never returned, which is
 * UNKNOWN and never a ceiling of 0.
 */
function acceptedOverAllocationCell(vif: DxVirtualInterface, accepted: VifRoute[]): string {
  const unique = uniqueByCidr(accepted);
  // A route with no addressFamily counts as IPv4, matching `acceptedByFamily` and
  // the over-allocation check. Two answers to "how many prefixes is this VIF
  // accepting" would disagree the moment one of them changed.
  const inFamily = (family: 'ipv4' | 'ipv6') => unique.filter((r) =>
    family === 'ipv6' ? r.addressFamily === 'ipv6' : r.addressFamily !== 'ipv6');
  const unset = unique.filter((r) => !r.addressFamily).length;
  // Only worth saying when AWS left the family off, and it is a caveat on the
  // IPv4 line rather than a row of its own: that is where the routes were counted.
  const unsetNote = unset > 0
    ? ` title="${unset} of these prefixes ${unset === 1 ? 'has' : 'have'} no address family`
      + ` reported by AWS and ${unset === 1 ? 'is' : 'are'} counted as IPv4, the same as the`
      + ` finding does."`
    : '';

  if (vif.virtualInterfaceType === 'public') {
    // Prefix controls are documented as not applicable to public VIFs; the fixed
    // per-session limit is the real ceiling, so it is the honest denominator.
    return `${unique.length}/1,000 <span class="sub">(per session)</span>`;
  }

  const lines: string[] = [];
  for (const family of ['ipv4', 'ipv6'] as const) {
    const used = inFamily(family).length;
    const allocated = family === 'ipv6'
      ? vif.prefixPool?.allocatedIpv6
      : vif.prefixPool?.allocatedIpv4;
    // A family with neither routes nor an allocation has nothing to report; a row
    // of `0/not reported` for it would be noise, not a measurement.
    if (used === 0 && !allocated) continue;
    // `undefined` and 0 are both UNKNOWN, never a ceiling of zero: a hosted
    // connection, an older SDK, mock data and a v1 snapshot all land here, and
    // `prefixQuotaFor` likewise declines to treat either as an allocation.
    const denom = allocated ? `${allocated}` : `<span class="sub">not reported</span>`;
    const note = family === 'ipv4' ? unsetNote : '';
    // Threshold from PREFIX_UTILIZATION_WARN, never a literal: the cell and the rule
    // have to agree, and a second copy of 0.8 is how they stop agreeing.
    const ratio = allocated ? used / allocated : 0;
    const band = !allocated ? '' : ratio > 1 ? ' quota-over' : ratio >= PREFIX_UTILIZATION_WARN ? ' quota-near' : '';
    const pctText = allocated ? ` <span class="sub">${Math.round(ratio * 100)}%</span>` : '';
    lines.push(`<span class="quota-cell${band}"${note}>${used}/${denom} <span class="sub">(${family})</span>${
      band ? pctText : ''}</span>`);
  }
  // No allocation in either family, so there is no fraction to print — but the
  // accepted count is still a measurement and must not be dropped.
  if (lines.length === 0) {
    return `${unique.length}/<span class="sub">not reported</span>`;
  }
  return lines.join('<br>');
}

/**
 * More distinct accepted prefixes than the VIF's own reported allocation, in
 * either address family. Graded on the counts alone: over the allocation is over
 * the allocation, and AWS can drive the session into an idle state for it.
 */
function prefixCountsOverAllocation(vif: DxVirtualInterface, accepted: VifRoute[]): boolean {
  const unique = uniqueByCidr(accepted);
  for (const family of ['ipv4', 'ipv6'] as const) {
    const used = unique.filter((r) =>
      family === 'ipv6' ? r.addressFamily === 'ipv6' : r.addressFamily !== 'ipv6').length;
    if (used === 0) continue;
    const { limit, source } = prefixQuotaFor(vif, family);
    if (source === 'allocation' && used > limit) return true;
  }
  return false;
}

/**
 * Anchor for the Nth flagged row of a gateway's matrix (`rt-gw1-p1`), or
 * `undefined` when this render has no per-gateway anchor base to hang it on.
 *
 * Ordinal, like every other anchor in this file: `redact()` masks a CIDR wherever
 * it appears, `id=` attributes included, so an anchor carrying the prefix itself
 * would be rewritten in a masked report and every link to it would go dead.
 */
function flaggedRowAnchor(anchorBase: string | undefined, n: number): string | undefined {
  return anchorBase ? `${anchorBase}-p${n}` : undefined;
}

/** The gateway's headline. Mirrors the wording of the panel's status strip. */
function routeVerdictLine(diff: DxgwRouteDiff, anchorBase?: string): { cls: string; html: string } {
  const n = diff.rows.length;
  const pfx = (k: number) => `prefix${k === 1 ? '' : 'es'}`;
  // The figure links to the first row it is counting — worst first is the matrix's
  // own order, so row 1 is a solo row whenever there is one.
  const first = flaggedRowAnchor(anchorBase, 1);
  const fig = (k: number) => (first ? `<a href="#${first}"><strong>${k}</strong></a>` : `<strong>${k}</strong>`);
  if (diff.totalSolo > 0) {
    return {
      cls: 'rv-bad',
      html: `${fig(diff.totalSolo)} of ${n} ${pfx(n)} on this gateway sit on a single VIF
        with no other path. If that VIF drops, the traffic has nowhere to go.`
        + (diff.totalPartial > 0
          ? ` A further ${diff.totalPartial} ${diff.totalPartial === 1 ? 'is' : 'are'} only partly
             carried elsewhere (&#9651;).`
          : ''),
    };
  }
  if (diff.totalPartial > 0) {
    return {
      cls: 'rv-bad',
      html: `${fig(diff.totalPartial)} of ${n} ${pfx(n)}
        ${diff.totalPartial === 1 ? 'is' : 'are'} only partly carried by another VIF (&#9651;).
        Addresses outside the pieces a sibling carries lose their path.`,
    };
  }
  if (diff.totalLoose > 0) {
    return {
      cls: 'rv-warn',
      html: `Every prefix has another path, but ${fig(diff.totalLoose)}
        ${diff.totalLoose === 1 ? 'is' : 'are'} only covered by a less specific route (&#9675;).
        Failover works, at coarser granularity.`,
    };
  }
  return {
    cls: 'rv-ok',
    html: `All ${n} ${pfx(n)} ${n === 1 ? 'is' : 'are'} carried by two or more VIFs.`,
  };
}

/**
 * @param anchorBase `rt-<navId>`, when this gateway has a section anchor. Every
 *   flagged row then gets `${anchorBase}-p<n>` in matrix order, so a figure
 *   elsewhere in the report can land the reader on the prefix it counted rather
 *   than at the top of a 60-row table. Rows carried by two or more VIFs get no
 *   anchor — nothing links to them.
 */
/**
 * Column labels are LETTERS, not `#1`.
 *
 * The cells now carry digits (`1(2)`), and a numbered column header beside a numeric
 * cell reads as though the two are the same kind of thing — "#2 … 2(3)" invites the
 * reader to match the 2s. Letters make the header unmistakably an identifier and the
 * cell unmistakably a measurement.
 */
function colLetter(index: number): string {
  let n = index - 1;
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/**
 * @param hopsOf (vifId, cidr) → AS path length for that exact prefix on that VIF, or
 *   `undefined` where it is not known. Hop COUNTS, never the ASNs themselves, so this
 *   one needs no masking — a path length identifies nobody.
 * @param routeAnchor (vifId, cidr) → the id of that received route's row in the Route
 *   tables appendix, or `undefined` if the appendix did not print it.
 */
function renderRouteMatrix(
  diff: DxgwRouteDiff,
  anchorBase?: string,
  hopsOf?: (vifId: string, cidr: string) => number | undefined,
  routeAnchor?: (vifId: string, cidr: string) => string | undefined,
): string {
  const byId = new Map(diff.vifs.map((v) => [v.vifId, v]));
  const identity = (vifId: string) => {
    const v = byId.get(vifId);
    return v ? `VIF ${v.label} (${v.vifId}, ${v.vifType})` : vifId;
  };

  const ordered = [...diff.rows].sort(
    (a, b) => ROW_ORDER[a.verdict] - ROW_ORDER[b.verdict]
      || a.cidr.localeCompare(b.cidr, undefined, { numeric: true }),
  );
  const flagged = ordered.filter((r) => r.verdict !== 'redundant');

  let shown = ordered;
  let capNote = '';
  if (ordered.length > ROUTE_MATRIX_MAX_ROWS) {
    if (flagged.length === 0) {
      // Nothing is flagged, so the cut hides no finding — but show a sample
      // anyway: the marks are the evidence for the "all redundant" claim above.
      shown = ordered.slice(0, ROUTE_MATRIX_MAX_ROWS);
      capNote = `<p class="meta">Showing the first ${shown.length} of ${ordered.length} prefixes in
        prefix order. No prefix on this gateway is flagged, so the cut hides no gap — the app's
        Route diff panel lists them all.</p>`;
    } else {
      shown = flagged.slice(0, ROUTE_MATRIX_MAX_ROWS);
      const hiddenFlagged = flagged.length - shown.length;
      const hiddenRedundant = ordered.length - flagged.length;
      const omitted: string[] = [];
      if (hiddenFlagged > 0) {
        omitted.push(`${hiddenFlagged} further flagged prefix${hiddenFlagged === 1 ? '' : 'es'}`);
      }
      if (hiddenRedundant > 0) {
        omitted.push(`${hiddenRedundant} prefix${hiddenRedundant === 1 ? '' : 'es'} carried by two or`
          + ` more VIFs`);
      }
      capNote = `<p class="meta">Showing ${shown.length} of ${ordered.length} prefixes, worst first
        &mdash; ${omitted.join(' and ')} not listed. Open the DX Gateway's Route diff panel in the app
        for the full matrix.</p>`;
    }
  }

  const head = diff.vifs.map((v) =>
    `<th class="mcol" title="Column ${colLetter(v.index)} &mdash; ${escapeHtml(identity(v.vifId))}${
      v.connectionId ? ` on connection ${escapeHtml(v.connectionId)}` : ''}">${colLetter(v.index)}</th>`).join('');

  let flaggedSeen = 0;
  const body = shown.map((row) => {
    const anchor = row.verdict === 'redundant'
      ? undefined
      : flaggedRowAnchor(anchorBase, ++flaggedSeen);

    /**
     * Preference rank per prefix, from AS path length — shortest path wins, which is
     * the BGP rule the router is actually applying.
     *
     * Computed PER ROW, not per VIF: two prefixes on one VIF can arrive by different
     * length paths, so a per-VIF rank would be wrong for at least one of them.
     *
     * VIFs sharing a length share a rank, and that is the point: equal rank means equal
     * AS path length, which is the ECMP case. `1(2)` on A and B says "joint best, two
     * hops"; `2(3)` on C and D says "second choice, three hops, ECMP with each other".
     */
    const exactVifs = diff.vifs.filter((v) => row.cells.get(v.vifId)?.state === 'exact');
    const hopsFor = new Map<string, number>();
    for (const v of exactVifs) {
      const h = hopsOf?.(v.vifId, row.cidr);
      if (h !== undefined) hopsFor.set(v.vifId, h);
    }
    // Ranks only mean something when there is a choice to rank, and only when the AS
    // path is actually known. One carrier, or no path data, keeps the plain tick — a
    // lone `1(2)` would imply a runner-up that does not exist.
    const rankByHops = new Map<number, number>();
    if (exactVifs.length > 1 && hopsFor.size === exactVifs.length) {
      [...new Set(hopsFor.values())]
        .sort((a, b) => a - b)
        .forEach((len, i) => rankByHops.set(len, i + 1));
    }

    const cells = diff.vifs.map((v) => {
      const cell = row.cells.get(v.vifId);
      const mark = CELL_MARK[cell?.state ?? 'absent'];
      let title = `${identity(v.vifId)} ${mark.title}`;
      if (cell?.state === 'covered' && cell.via) title += ` (via ${cell.via})`;
      if (cell?.state === 'partial' && cell.inside?.length) title += ` (carries ${cell.inside.join(', ')})`;

      // Every cell that says this VIF actually received the prefix links to the row in
      // the Route tables appendix carrying its full AS path — rank and hop count are a
      // summary, and "which ASNs" is the reader's next question. `undefined` for a
      // prefix the appendix cut, so the link is never dead.
      //
      // The `exact` test is belt-and-braces today: `routeAnchor` only indexes RECEIVED
      // rows, so a covered / partial / absent cell finds nothing anyway. It stays
      // because that is a property of the map, not of this call — widen the map to
      // advertised rows and a `covered` cell would silently start linking to a row
      // saying the opposite of what the cell says.
      const rowAnchor = cell?.state === 'exact'
        ? routeAnchor?.(v.vifId, row.cidr)
        : undefined;
      const linked = (inner: string, hint: string) => (rowAnchor
        ? `<a class="mcell-link" href="#${rowAnchor}" title="${escapeHtml(`${hint} — open its AS path in Route tables`)}">${inner}</a>`
        : `<span title="${escapeHtml(hint)}">${inner}</span>`);

      const hops = hopsFor.get(v.vifId);
      const rank = hops === undefined ? undefined : rankByHops.get(hops);
      if (rank === undefined) {
        return `<td class="mcol">${linked(
          `<span class="mark ${mark.cls}">${mark.glyph}</span>`, title,
        )}</td>`;
      }
      const peers = exactVifs
        .filter((o) => o.vifId !== v.vifId && hopsFor.get(o.vifId) === hops)
        .map((o) => colLetter(o.index));
      const rankTitle = `${title}. AS path ${hops} hop${hops === 1 ? '' : 's'}`
        + ` — preference ${rank} of ${rankByHops.size} for this prefix`
        + (peers.length
          ? `, equal-cost with ${peers.join(', ')}`
          : rank === 1 ? ', the shortest path on this gateway' : '');
      return `<td class="mcol">${linked(
        `<span class="mrank${rank === 1 ? ' mrank-best' : ''}">${rank}<span class="mhops">(${hops})</span></span>`,
        rankTitle,
      )}</td>`;
    }).join('');
    const vs = VERDICT_STYLE[row.verdict];
    return `<tr${anchor ? ` id="${anchor}"` : ''}><td class="cidr">${escapeHtml(row.cidr)}`
      + (row.addressFamily === 'ipv6' ? ` <span class="sub">v6</span>` : '')
      + `</td><td><span class="chip-pill ${vs.cls}">${vs.label}</span></td>${cells}</tr>`;
  }).join('');

  // Just the column key. Listing each VIF's distinct AS paths here was tried and
  // removed: on a real gateway a VIF learns a dozen different paths, so four VIFs
  // produced forty chips of near-identical digits between the matrix and its legend,
  // burying the one thing this list is for — which letter is which VIF. The hop count
  // in each cell is what the reader needs inline; the full paths are in the
  // Route tables appendix, and in the workbook export.
  const legend = diff.vifs.map((v) =>
    `<li><span class="col-n">${colLetter(v.index)}</span> ${nameWithId(v.label, v.vifId)}
      <span class="sub">${escapeHtml(v.vifType)}${
        v.connectionId ? ` on ${escapeHtml(v.connectionId)}` : ''}</span></li>`).join('');

  return `${capNote}
    <table class="matrix">
      <thead><tr><th>Prefix</th><th>Verdict</th>${head}</tr></thead>
      <tbody>${body}</tbody>
    </table>
    <ul class="legend">${legend}</ul>
    <p class="meta"><strong><span class="mrank mrank-best">1<span class="mhops">(2)</span></span>
      is rank(hops)</strong> &mdash; AS path length, and the preference it earns. Shortest
      path wins; equal length is ECMP, so equal rank means equal cost.
      <code>1(2) 1(2) 2(3) 2(3)</code> is:</p>
    <ul class="rank-eg">
      <li><span class="col-n">A</span> <code>65006 65010</code> &mdash; 2 hops
        <span class="sub">rank 1</span></li>
      <li><span class="col-n">B</span> <code>65005 65010</code> &mdash; 2 hops
        <span class="sub">rank 1, ECMP with A</span></li>
      <li><span class="col-n">C</span> <code>65006 65006 65010</code> &mdash; 3 hops
        <span class="sub">rank 2</span></li>
      <li><span class="col-n">D</span> <code>65005 65005 65010</code> &mdash; 3 hops
        <span class="sub">rank 2, ECMP with C</span></li>
    </ul>
    <p class="meta">One carrier, or no AS path on record, keeps
      <span class="mark mark-exact">&#10003;</span> &mdash; a lone rank would imply a
      runner-up. <code>(0)</code> is an empty path: originated by the attached peer.
      Full paths per prefix are in <a href="#route-tables">Route tables</a>.</p>
    <p class="meta"><span class="mark mark-exact">&#10003;</span> accepts this prefix &middot;
      <span class="mark mark-covered">&#9675;</span> covered by a less specific route &middot;
      <span class="mark mark-partial">&#9651;</span> only part of the block &middot;
      <span class="mark mark-absent">&#215;</span> not reachable</p>`;
}

/* ---------------------------------------------------------------------------
 * VIF utilization
 *
 * Bands are THIS report's operating convention, not AWS-published figures. 70%
 * is a resilience line rather than a cost one: two paths sharing a load must
 * each be able to absorb the other's traffic on failover.
 * ------------------------------------------------------------------------- */

type UtilBandKey = 'over' | 'elevated' | 'normal' | 'under' | 'unknown';

const UTIL_BAND: Record<UtilBandKey, { label: string; cls: string }> = {
  over: { label: 'over-utilised', cls: 'band-over' },
  elevated: { label: 'elevated', cls: 'band-elevated' },
  normal: { label: 'normal', cls: 'band-normal' },
  under: { label: 'under-utilised', cls: 'band-under' },
  unknown: { label: 'unknown', cls: 'band-unknown' },
};

function utilBandOf(pct: number | null): UtilBandKey {
  if (pct == null) return 'unknown';
  if (pct >= 70) return 'over';
  if (pct >= 40) return 'elevated';
  if (pct >= 5) return 'normal';
  return 'under';
}

/**
 * N-1 vocabulary is deliberately separate from the utilization bands: "elevated"
 * says nothing about whether the surviving path copes.
 */
type HeadroomKey = 'ample' | 'tight' | 'congest' | 'nofit' | 'none' | 'unknown' | 'na';

const HEADROOM: Record<HeadroomKey, { label: string; cls: string }> = {
  ample: { label: 'ample headroom', cls: 'hr-ample' },
  tight: { label: 'tight but fits', cls: 'hr-tight' },
  congest: { label: 'would congest', cls: 'hr-congest' },
  nofit: { label: 'would not fit', cls: 'hr-nofit' },
  none: { label: 'no failover path', cls: 'hr-none' },
  unknown: { label: 'indeterminate', cls: 'hr-unknown' },
  // A port with no VIFs carries nothing, so it has nothing to fail over. Grading
  // that as "no failover path" would print a red verdict for an idle cable.
  na: { label: 'n/a', cls: 'hr-unknown' },
};

function peakOf(u?: { ingressBpsPeak?: number; egressBpsPeak?: number }): number | null {
  if (!u) return null;
  const vals = [u.ingressBpsPeak, u.egressBpsPeak].filter((n): n is number => n != null);
  return vals.length ? Math.max(...vals) : null;
}

/**
 * AWS's own utilization percentage for the VIF, worst direction. Deliberately NOT
 * converted into bps and NOT graded into a band: `VirtualInterfaceUtilization*` is
 * undocumented, so which capacity it divides by (the VIF's rate limit or the
 * partner's physical port) is not something this code can assert. Those two readings
 * differ by orders of magnitude on a hosted VIF, so inventing a band from the
 * percentage would print a confident verdict on an unverified denominator. Showing
 * the number and withholding the verdict is the honest half.
 */
function utilPctPeakOf(u?: { ingressUtilPctPeak?: number; egressUtilPctPeak?: number }): number | null {
  if (!u) return null;
  const vals = [u.ingressUtilPctPeak, u.egressUtilPctPeak].filter((n): n is number => n != null);
  return vals.length ? Math.max(...vals) : null;
}

/**
 * A VIF's ceiling is its own `rateLimit` when one is set, not the parent port's
 * bandwidth — measuring a 50Mbps-limited VIF against a 10Gbps port reports a
 * saturated VIF as 0.5%. AWS guarantees `rateLimit <= port`, but take the min
 * defensively so a bad value cannot inflate the denominator.
 */
function capacityOf(
  v: DxVirtualInterface,
  conn?: DxConnection,
): { bps: number | null; source: string; gradable: boolean } {
  const portBps = parseBandwidthToBps(conn?.bandwidth) ?? null;
  const rateBps = parseBandwidthToBps(v.rateLimit) ?? null;
  if (rateBps != null && (portBps == null || rateBps <= portBps)) {
    return { bps: rateBps, source: 'VIF rate limit', gradable: true };
  }
  if (portBps != null) return { bps: portBps, source: 'port bandwidth', gradable: true };
  if (conn?.derivedPhysicalPortBps != null && conn.derivedPhysicalPortBps > 0) {
    return {
      bps: conn.derivedPhysicalPortBps,
      source: 'derived physical port; contracted capacity unknown',
      gradable: false,
    };
  }
  // Deliberately narrow: the app does not fetch AWS/DX VirtualInterfaceUtilization*,
  // so "no denominator here" is a statement about this data, not a claim that AWS
  // publishes nothing for the VIF. A partner-hosted VIF is exactly the case that
  // looks unreadable and is not.
  return { bps: null, source: 'no rate limit or port bandwidth recorded', gradable: false };
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The provenance of the numbers — what metric, what statistic, what window. */
function renderUtilSource(topology: TopologyData, prov: Provenance, hasData: boolean,
                          hasAwsPct = false): string {
  const windowDays = topology.utilizationWindowDays;
  const asOf = prov.dataAsOf ? new Date(prov.dataAsOf) : null;
  const validAsOf = asOf && !Number.isNaN(asOf.getTime()) ? asOf : null;
  const end = validAsOf ?? new Date();
  const stat = prov.metricStat ?? 'Average';
  const rows: Array<[string, string]> = [
    ['Source', `Amazon CloudWatch, namespace <code>AWS/DX</code> &mdash; metrics
      <code>VirtualInterfaceBpsIngress</code> and <code>VirtualInterfaceBpsEgress</code>
      (<code>Stat: ${escapeHtml(stat)}</code>, <code>Period: 3600</code>). Ingress is traffic
      <em>into</em> AWS, egress is traffic <em>out of</em> AWS. Connection figures are the same
      streams re-bucketed by their <code>ConnectionId</code> dimension &mdash; AWS publishes no
      separate port metric, so they exclude non-VIF overhead such as LACP and BFD keepalives.`],
  ];
  if (hasAwsPct) {
    rows.push(['AWS-reported %', `where <code>VirtualInterfaceBps*</code> published nothing, the
      <strong>%</strong> column carries <code>VirtualInterfaceUtilizationIngress</code> /
      <code>VirtualInterfaceUtilizationEgress</code> instead &mdash; the only capacity signal a
      <strong>partner-hosted</strong> VIF often has, and it requires both the
      <code>VirtualInterfaceId</code> and <code>ConnectionId</code> dimensions. That metric is
      <strong>undocumented</strong>, so the capacity it divides by is not something this report can
      state; those rows therefore show the percentage and are left
      <strong>ungraded</strong> rather than banded against a denominator we would be guessing at.`]);
  }
  if (topology.connections.some((c) => c.derivedPhysicalPortBps != null)) {
    rows.push(['Hosted physical port', `a paired <code>VirtualInterfaceBps*</code> and
      <code>VirtualInterfaceUtilization*</code> sample can reveal the parent partner port.
      That derived physical-port figure is shown in the capacity column, but it is
      <strong>not</strong> the customer's contracted hosted-VIF sub-rate. Those rows remain
      ungraded and are excluded from failover-headroom capacity calculations.`]);
  }
  if (windowDays != null) {
    const start = new Date(end.getTime() - windowDays * 24 * 60 * 60 * 1000);
    rows.push(['Window', `last <strong>${windowDays} days</strong> of 1-hour datapoints
      &mdash; approximately ${isoDay(start)} to ${isoDay(end)}`
      + (validAsOf
        ? `, ending when this snapshot was exported (${escapeHtml(validAsOf.toISOString())})`
        : `, ending when the metrics were fetched in the app &mdash; at or shortly before this
           report was generated`)]);
  } else if (hasData) {
    rows.push(['Window', 'not recorded in this data — the figures are peaks over the window that was '
      + 'selected in the app when they were fetched (30, 60, or 90 days)']);
  }
  rows.push(['Figure shown', `the single highest hour in the window, not an average. A peak of hourly
    averages is a <strong>floor</strong> on the true instantaneous peak, so &ldquo;under-utilised&rdquo;
    means &ldquo;not congested at the hour scale&rdquo; &mdash; never &ldquo;safe to downsize&rdquo;.`]);
  rows.push(['Bands', `<strong>this report's operating convention, not AWS-published figures</strong>:
    over-utilised &ge;70%, elevated 40&ndash;70%, normal 5&ndash;40%, under-utilised &lt;5%, unknown
    where no capacity denominator is recorded. 70% is a resilience line rather than a cost one
    &mdash; two paths sharing a load must each absorb the other's traffic on failover.`]);
  rows.push(['Denominator', `the VIF's own <code>rateLimit</code> when one is set (a 50Mbps VIF on a
    10Gbps port is measured against 50Mbps), else the parent port bandwidth &mdash; named per row,
    because it varies. <em>Unknown</em> means neither is in this data; the app does not query
    <code>AWS/DX VirtualInterfaceUtilization*</code>, so it is not a claim that AWS publishes no
    figure for that VIF.`]);
  if (prov.kind === 'mock') {
    rows.push(['Caveat', `<strong>Demo scenario</strong> &mdash; the figures below are bundled mock
      data, not CloudWatch reads.`]);
  }
  return `<div class="datasource"><dl>${rows
    .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl></div>`;
}

function renderUtilization(topology: TopologyData, prov: Provenance): string {
  const vifUtil = topology.vifUtilization;
  const connUtil = topology.connectionUtilization;
  // A VIF with only AWS's utilization percentage still has data. Keying "has data" on
  // bps alone made a partner-hosted account — which routinely publishes the percentage
  // and nothing else — read as entirely unmeasured.
  const utilValues = vifUtil ? [...vifUtil.values()] : [];
  const hasBps = utilValues.some((u) => peakOf(u) != null);
  const hasAwsPct = utilValues.some((u) => utilPctPeakOf(u) != null);
  const hasData = hasBps || hasAwsPct;
  const source = renderUtilSource(topology, prov, hasData, hasAwsPct);

  if (!hasData) {
    const reason = prov.fetchedForReport && prov.utilizationError
      ? `this report requested them and CloudWatch returned none:
         <code>${escapeHtml(prov.utilizationError)}</code>`
      : prov.fetchedForReport
        // Asked, nothing failed, nothing came back. Distinct from every other branch:
        // there is no permission to grant and no snapshot to blame, so saying the
        // report "could not fetch without credentials" would be simply false.
        ? 'this report queried CloudWatch successfully and it returned no datapoints for any VIF'
          + ' in the window'
        : prov.kind === 'imported'
          ? 'no datapoints travelled with this snapshot &mdash; the app that exported it had fetched'
            + ' none for this window'
          : prov.kind === 'mock'
            ? 'this demo scenario carries no metrics'
            : 'no datapoints were available, and the report could not fetch any without AWS'
              + ' credentials';
    return `${source}
      <p class="meta"><strong>Not assessed:</strong> ${reason}. The fetch needs
      <code>cloudwatch:ListMetrics</code> and <code>cloudwatch:GetMetricData</code>; a VIF that has
      never passed traffic also publishes no datapoints. An unmeasured VIF is not a quiet one.</p>`;
  }

  const connById = new Map(topology.connections.map((c) => [c.connectionId, c]));
  const windowDays = topology.utilizationWindowDays;
  const windowLabel = windowDays != null ? `${windowDays}d peak` : 'peak';

  type Row = {
    vif: DxVirtualInterface;
    conn?: DxConnection;
    cap: { bps: number | null; source: string; gradable: boolean };
    ingress: number | null;
    egress: number | null;
    pct: number | null;
    /** AWS's own percentage, shown only when `pct` could not be computed from bps. */
    awsPct: number | null;
  };

  // Every VIF, including the ones with no datapoints — a missing row would read
  // as "nothing to report" when it means "never measured".
  const rows: Row[] = topology.virtualInterfaces.map((v) => {
    const conn = connById.get(v.connectionId);
    const cap = capacityOf(v, conn);
    const u = vifUtil?.get(v.virtualInterfaceId);
    const ingress = u?.ingressBpsPeak ?? null;
    const egress = u?.egressBpsPeak ?? null;
    const worst = peakOf(u);
    const measuredPct = cap.bps != null && cap.bps > 0 && worst != null
      ? (worst / cap.bps) * 100
      : null;
    const pct = cap.gradable ? measuredPct : null;
    // Only a fallback: a bps-derived percentage is measured against a denominator this
    // report can name, so it always wins where both exist.
    const awsPct = pct == null ? (utilPctPeakOf(u) ?? measuredPct) : null;
    return { vif: v, conn, cap, ingress, egress, pct, awsPct };
  });
  // Busiest first, whichever percentage a row has — a VIF is not "less interesting"
  // because its number came from AWS's metric instead of ours.
  const sortKey = (r: Row) => r.pct ?? r.awsPct;
  rows.sort((a, b) => {
    const ka = sortKey(a);
    const kb = sortKey(b);
    if (ka == null && kb == null) return vifLabel(a.vif).localeCompare(vifLabel(b.vif));
    if (ka == null) return 1;
    if (kb == null) return -1;
    return kb - ka;
  });

  const fmtPct = (pct: number | null) => pct == null
    ? '<span class="sub">&mdash;</span>'
    : `${pct < 1 ? pct.toFixed(2) : pct.toFixed(1)}%`;

  const vifRows = rows.map((r) => {
    const band = UTIL_BAND[utilBandOf(r.pct)];
    const why = r.pct != null
      ? ''
      // An AWS-reported row is ungraded on purpose (see utilPctPeakOf) — labelling it
      // "unknown" with no reason reads as a fetch failure, which is the opposite of
      // what happened: AWS answered, and only the denominator is unverifiable.
      : r.awsPct != null
        ? r.cap.bps != null && !r.cap.gradable
          ? ' <span class="sub">physical-port %, contracted capacity unknown &mdash; not graded</span>'
          : ' <span class="sub">AWS-reported %, denominator undocumented &mdash; not graded</span>'
        : r.ingress == null && r.egress == null
          ? ' <span class="sub">no datapoints</span>'
          : ` <span class="sub">capacity ${escapeHtml(r.cap.source)}</span>`;
    return `<tr>
      <td>${nameWithId(vifLabel(r.vif), r.vif.virtualInterfaceId)}</td>
      <td>${escapeHtml(r.vif.virtualInterfaceType)}</td>
      <td>${r.conn ? nameWithId(r.conn.connectionName, r.conn.connectionId) : escapeHtml(r.vif.connectionId)}</td>
      <td>${r.cap.bps != null
        ? `${escapeHtml(formatBps(r.cap.bps))} <span class="sub">${escapeHtml(r.cap.source)}</span>`
        : `<span class="sub">${escapeHtml(r.cap.source)}</span>`}</td>
      <td class="num">${r.ingress != null ? escapeHtml(formatBps(r.ingress)) : '<span class="sub">&mdash;</span>'}</td>
      <td class="num">${r.egress != null ? escapeHtml(formatBps(r.egress)) : '<span class="sub">&mdash;</span>'}</td>
      <td class="num">${r.pct != null
        ? fmtPct(r.pct)
        : r.awsPct != null
          ? `${fmtPct(r.awsPct)} <span class="sub">AWS</span>`
          : fmtPct(null)}</td>
      <td><span class="chip-pill ${band.cls}">${band.label}</span>${why}</td>
    </tr>`;
  }).join('');

  // ---- N-1 failover headroom, per connection --------------------------------
  // "Survivors" are the connections that share a gateway (or the public-VIF
  // path) with this one — those are the paths BGP can actually move the traffic
  // to. The sum is an aggregate: it assumes traffic redistributes across all
  // survivors, which BGP does not guarantee.
  const groupsOf = (c: DxConnection): string[] => {
    const keys = new Set<string>();
    for (const v of topology.virtualInterfaces) {
      if (v.connectionId !== c.connectionId) continue;
      if (v.directConnectGatewayId) keys.add(`dxgw:${v.directConnectGatewayId}`);
      else if (v.virtualGatewayId) keys.add(`vgw:${v.virtualGatewayId}`);
      else if (v.virtualInterfaceType === 'public') keys.add('public');
    }
    return [...keys];
  };
  const connGroups = new Map(topology.connections.map((c) => [c.connectionId, groupsOf(c)]));

  /**
   * A connection's peak load. `ConnectionBps*` is the direct measure, but AWS does not
   * publish it for every account — where it is absent, every row degraded to
   * "indeterminate" and the whole N-1 table said nothing, even with full per-VIF data
   * in hand. Falling back to the sum of the connection's VIF peaks answers the question
   * instead. It is an over-estimate (two VIFs need not peak in the same hour), which is
   * the safe direction for a headroom check: it can call a fit tight, never call a
   * genuine overload ample. Returns the source so the row can say which one it used.
   */
  const loadOf = (connId: string): { bps: number | null; derived: boolean } => {
    const direct = peakOf(connUtil?.get(connId));
    if (direct != null) return { bps: direct, derived: false };
    const parts = topology.virtualInterfaces
      .filter((v) => v.connectionId === connId)
      .map((v) => peakOf(vifUtil?.get(v.virtualInterfaceId)))
      .filter((n): n is number => n != null);
    return parts.length
      ? { bps: parts.reduce((s, n) => s + n, 0), derived: true }
      : { bps: null, derived: false };
  };

  const headroomRows = topology.connections.map((c) => {
    const capBps = parseBandwidthToBps(c.bandwidth) ?? null;
    const own = loadOf(c.connectionId);
    const load = own.bps;
    const mine = connGroups.get(c.connectionId) ?? [];
    const peers = topology.connections.filter((o) =>
      o.connectionId !== c.connectionId
      && (connGroups.get(o.connectionId) ?? []).some((k) => mine.includes(k)));

    let key: HeadroomKey;
    let detail: string;
    let postPct: number | null = null;
    if (mine.length === 0) {
      key = 'na';
      detail = 'no virtual interfaces on this connection — it carries nothing to fail over';
    } else if (peers.length === 0) {
      key = 'none';
      detail = 'no other connection reaches the same gateway';
    } else {
      const peerCaps = peers.map((p) => parseBandwidthToBps(p.bandwidth) ?? null);
      const peerLoadInfo = peers.map((p) => loadOf(p.connectionId));
      const peerLoads = peerLoadInfo.map((l) => l.bps);
      if (load == null || peerCaps.some((x) => x == null) || peerLoads.some((x) => x == null)) {
        key = 'unknown';
        detail = load == null
          ? 'no datapoints for this connection'
          : peerCaps.some((x) => x == null)
            // Naming the actual blocker matters: an unreadable *bandwidth* is a
            // partner-hosted port, which no permission or metric will ever supply,
            // whereas missing datapoints can be re-fetched.
            ? 'a surviving connection is partner-hosted with no readable bandwidth'
            : 'a surviving connection has no datapoints';
      } else {
        const survivorCap = (peerCaps as number[]).reduce((s, x) => s + x, 0);
        const survivorLoad = (peerLoads as number[]).reduce((s, x) => s + x, 0);
        postPct = survivorCap > 0 ? ((survivorLoad + load) / survivorCap) * 100 : null;
        key = postPct == null ? 'unknown'
          : postPct > 100 ? 'nofit'
          : postPct >= 70 ? 'congest'
          : postPct >= 40 ? 'tight'
          : 'ample';
        const derived = own.derived || peerLoadInfo.some((l) => l.derived);
        detail = `${peers.length} surviving connection${peers.length === 1 ? '' : 's'}, `
          + `${formatBps(survivorCap)} capacity carrying ${formatBps(survivorLoad)} today`
          + (derived ? ' (load summed from per-VIF peaks — an over-estimate)' : '');
      }
    }
    const hr = HEADROOM[key];
    return `<tr>
      <td>${nameWithId(c.connectionName, c.connectionId)}</td>
      <td>${escapeHtml(c.location || '—')}</td>
      <td>${capBps != null ? escapeHtml(formatBps(capBps)) : `<span class="sub">${escapeHtml(c.bandwidth || 'unknown')}</span>`}</td>
      <td class="num">${load != null ? escapeHtml(formatBps(load)) : '<span class="sub">&mdash;</span>'}</td>
      <td class="num">${fmtPct(postPct)}</td>
      <td><span class="chip-pill ${hr.cls}">${hr.label}</span> <span class="sub">${escapeHtml(detail)}</span></td>
    </tr>`;
  }).join('');

  return `${source}
    <table>
      <thead><tr><th>Virtual interface</th><th>Type</th><th>Connection</th><th>Capacity</th>
        <th style="text-align:right">${escapeHtml(windowLabel)} in</th>
        <th style="text-align:right">${escapeHtml(windowLabel)} out</th>
        <th style="text-align:right">Of capacity</th><th>Band</th></tr></thead>
      <tbody>${vifRows || `<tr><td colspan="8" class="empty">No virtual interfaces.</td></tr>`}</tbody>
    </table>

    <h3>Failover headroom (N-1)</h3>
    <p class="meta">Per connection, against the other connections reaching the same gateway, at the
      peaks above. The survivor figure is an <strong>aggregate</strong> and assumes traffic
      redistributes evenly across surviving paths &mdash; BGP does not guarantee that, so read it as
      the optimistic case.</p>
    <table>
      <thead><tr><th>Connection</th><th>Location</th><th>Capacity</th>
        <th style="text-align:right">Peak load</th>
        <th style="text-align:right">Survivors after failover</th><th>Verdict</th></tr></thead>
      <tbody>${headroomRows || `<tr><td colspan="6" class="empty">No Direct Connect connections.</td></tr>`}</tbody>
    </table>`;
}

/** Exported for tests: the nav-to-section contract is worth asserting directly. */
/**
 * An extra section supplied by the caller, rendered after the executive summary and
 * given a nav entry like any built-in section. This exists so a caller that can
 * produce something the app cannot — the `nwra-skill` skill renders a Mermaid
 * topology diagram and a data-gaps list from its own CLI fetch — does not have to
 * fork the whole report to add it. The app itself passes none, so its output is
 * unchanged. `html` is inserted verbatim: the caller owns escaping.
 */
export type ExtraSection = { id: string; title: string; html: string };

/**
 * Warn, inside the report itself, that the topology it was computed from was
 * incomplete.
 *
 * The on-screen banner already says "exported reports may be inaccurate", and
 * that sentence was a promise this file did not keep: the report is the artifact
 * that gets emailed to a customer and pasted into a review deck, and it left the
 * app carrying no trace of the warning. Anyone reading the HTML — which is most
 * readers, since they never see the app — got a clean-looking review.
 *
 * It is placed immediately under the header, before section 1, because the
 * scores are the thing not to be trusted and a caveat printed after them has
 * already been read past. Deliberately not collapsible and not styled as a
 * footnote.
 */
export function renderIncompleteDataNoticeHtml(topology: TopologyData): string {
  const issues = topology.fetchIssues ?? [];
  if (issues.length === 0) return '';

  const counts = summariseIssues(issues);

  const rows = issues
    .map(
      (i) =>
        `<li><code>${escapeHtml(i.label)}</code> — ${i.kind === 'truncated' ? 'incomplete' : 'failed'}: ${escapeHtml(i.message)}</li>`,
    )
    .join('\n      ');

  return `
  <section class="incomplete-data" role="alert">
    <h2 style="margin-top:0">&#9888; This review is based on incomplete data</h2>
    <p><strong>${escapeHtml(counts)}.</strong> A resource that failed to load is
    indistinguishable from one that does not exist, so some checks below may
    report no finding where the correct answer is <em>unknown</em>. Scores and
    counts in this report may therefore be optimistic.</p>
    <ul>
      ${rows}
    </ul>
    ${guidanceFor(issues)
      .map((line) => `<p class="meta">${escapeHtml(line)}</p>`)
      .join('\n    ')}
  </section>`;
}

export function buildHtmlReport(topology: TopologyData, assessment: CombinedAssessment, scenario: string | null, initialTheme: 'light' | 'dark' = 'light', provenance?: Provenance, extraSections: ExtraSection[] = []): string {
  const stats = collectTopologyStats(topology);
  const resilRecs = mergeOccurrences(assessment.resiliency.recommendations);
  const bpRecs = mergeOccurrences(assessment.bestPractice.recommendations);
  /**
   * Every finding is now rendered in exactly ONE place — under its DX gateway, or in
   * the estate-wide section for the rules that are not gateway-scoped — so the anchor
   * is minted where the card lands rather than by a separate ranked table.
   *
   * That ranked table used to own the anchors, and deleting it would have left every
   * `DX-ARC-01` chip on a gateway card pointing at an id nothing emitted. Scoping the
   * gateway anchors by `navId` is what makes them unique: one rule fires on four
   * gateways, and four cards cannot share `f-DX-ARC-01`.
   */
  const findingAnchors = new Map<string, string>();
  const recKey = (r: Recommendation) => `${r.ruleId}::${r.title}`;
  const gwRecKeys = new Set(
    assessment.perDxGateway.flatMap((g) => g.recommendations).map(recKey),
  );
  /** Findings no DX gateway owns: estate-wide rules, plus VGW / public-VIF / LAG scopes. */
  const estateRecs = [...resilRecs, ...bpRecs].filter((r) => !gwRecKeys.has(recKey(r)));
  const estateByCat = recsByCategory(estateRecs);
  {
    const used = new Set<string>();
    const mint = (base: string) => {
      let id = base;
      for (let n = 2; used.has(id); n += 1) id = `${base}-${n}`;
      used.add(id);
      return id;
    };
    for (const r of estateRecs) {
      const meta = metaFor(r.ruleId);
      findingAnchors.set(recKey(r), mint(meta ? `f-${meta.publishedId}` : 'f-unrated'));
    }
  }
  /**
   * The first gateway card carrying this rule, for cross-references that have no
   * gateway of their own to prefer — the Best practices table lists a rule once even
   * when four gateways triggered it, and linking to any one of the four is better than
   * linking to none. Gateway anchors are registered by `renderScopedFindings` as the
   * cards render, so this is only ever called after the body is built.
   */
  const firstGatewayAnchorFor = (r: Recommendation): string | undefined => {
    for (const v of gwViews) {
      const hit = findingAnchors.get(`${v.navId}::${recKey(r)}`);
      if (hit) return hit;
    }
    return undefined;
  };

  const locationRows = [...stats.locationConns.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([loc, n]) => `<tr><td>${escapeHtml(loc)}</td><td class="num">${n}</td></tr>`)
    .join('') || `<tr><td colspan="2" class="empty">No Direct Connect locations detected.</td></tr>`;

  const uncoveredRegions = stats.resourceRegions.filter((r) => !stats.dxRegions.includes(r));

  type ClassifiedItem = { item: ReferenceItem; evidence?: string[] };
  const classified: Record<ReferenceStatus, ClassifiedItem[]> = { applied: [], gap: [], attest: [] };
  for (const item of REFERENCE_ITEMS) {
    const result = item.classify(stats, uncoveredRegions, topology);
    classified[result.status].push({ item, evidence: result.evidence });
  }

  const when = new Date().toLocaleString();

  // The sidebar badges and the Findings sections are counted from the SAME list, so
  // the nav can never disagree with the body. Only sections that are actually
  // rendered get a nav entry — a link to a section that does not exist is worse
  // than no link.
  const allByCat = recsByCategory([...resilRecs, ...bpRecs]);
  const findingCounts = {
    critical: allByCat.critical.length,
    warning: allByCat.warning.length,
    info: allByCat.info.length,
  };
  /**
   * Per-gateway view model — the report's primary axis.
   *
   * Built once and used for BOTH the sidebar tree and the body sections, in the same
   * order, because the scroll-spy pairs a nav row with a document position: two
   * orderings would make the highlighted row lag the page. Worst-exposed first, so
   * the reader's first expanded group is the one that matters.
   *
   * Anchor ids are ORDINAL (`gw1`), never derived from the gateway id. `redact()`
   * masks `dxgw-<hex>` wherever it appears, including inside an `id=` or `href=`
   * attribute, and `export-report-redaction.test.ts` asserts the markup is
   * byte-identical between a masked and an unmasked render — an id carrying the real
   * gateway id would fail there, and would silently change every anchor in a
   * customer-facing masked report.
   */
  type GwView = {
    navId: string;
    gw: (typeof assessment.perDxGateway)[number];
    scoped: TopologyData;
    scopedStats: ReturnType<typeof collectTopologyStats>;
    recs: Recommendation[];
    counts: { critical: number; warning: number; info: number };
    diff: ReturnType<typeof computeDxgwRouteDiff>;
    /** VIFs that do not carry every prefix their gateway receives. */
    gaps: { vifId: string; label: string; vifType: string; missing: { cidr: string; state: CellState }[] }[];
    unionSize: number;
    /** Prefixes with no full failover path anywhere on the gateway (solo + partial). */
    flagged: number;
    vifs: DxVirtualInterface[];
  };

  const gwViews: GwView[] = assessment.perDxGateway
    .map((gw) => {
      const scoped = scopeTopologyForDxgw(topology, gw.dxGatewayId);
      const recs = mergeOccurrences(gw.recommendations);
      const diff = computeDxgwRouteDiff(topology, gw.dxGatewayId);
      const vifs = topology.virtualInterfaces.filter((v) => v.directConnectGatewayId === gw.dxGatewayId);
      // "Missing" is `state !== 'exact'` — the same set the DX-CFG-07 rule counts, so
      // the table and the finding can never quote different numbers. `covered` and
      // `partial` are kept as states rather than dropped: a prefix reachable via a
      // less specific route is not a hole, and telling someone to add it to a router
      // that already reaches it is a wasted change window.
      const gaps = diff
        ? diff.vifs.map((v) => ({
            vifId: v.vifId,
            label: v.label,
            vifType: v.vifType,
            missing: diff.rows
              .filter((row) => (row.cells.get(v.vifId)?.state ?? 'absent') !== 'exact')
              .map((row) => ({ cidr: row.cidr, state: row.cells.get(v.vifId)?.state ?? 'absent' })),
          })).filter((g) => g.missing.length > 0)
        : [];
      return {
        navId: '',
        gw,
        scoped,
        scopedStats: collectTopologyStats(scoped),
        recs,
        counts: {
          critical: recs.filter((r) => r.severity === 'critical').length,
          warning: recs.filter((r) => r.severity === 'warning').length,
          info: recs.filter((r) => r.severity === 'info').length,
        },
        diff,
        gaps,
        unionSize: diff?.rows.length ?? 0,
        flagged: diff ? diff.totalSolo + diff.totalPartial : 0,
        vifs,
      };
    })
    .sort((a, b) =>
      b.counts.critical - a.counts.critical
      || b.counts.warning - a.counts.warning
      || b.flagged - a.flagged
      || a.gw.dxGatewayName.localeCompare(b.gw.dxGatewayName, undefined, { numeric: true }))
    .map((v, i) => ({ ...v, navId: `gw${i + 1}` }));

  const gwNavIds = new Map(gwViews.map((v) => [v.gw.dxGatewayId, v.navId]));

  /**
   * Why the prefix comparisons below may be empty, stated ONCE above the cards.
   *
   * "Asked and AWS said no" is a different fact from "never asked", and only the first
   * is something the reader can act on — so the error is quoted verbatim rather than
   * summarised. This used to live in the estate-wide route section; it has to survive
   * that section's deletion, because a permission denial silently rendering as "no
   * comparison available" on five cards is exactly the failure it guards against.
   */
  /**
   * Why the Route tables appendix is empty, in its own words.
   *
   * Same distinction the per-gateway note draws: "asked and AWS denied" is a permission
   * the reader can grant, "never asked" is not, and only the first is worth quoting.
   */
  const routesMissingNote = () => {
    if (prov.fetchedForReport && prov.routesError) {
      return `This report requested BGP routes and the call did not return any:
        <code>${escapeHtml(prov.routesError)}</code>. The action is
        <code>directconnect:ListVirtualInterfaceRoutes</code>, a <code>List*</code> the
        <code>directconnect:Describe*</code> wildcard does not cover.`;
    }
    if (prov.kind === 'imported') {
      return 'No route data travelled with this snapshot — the app that exported it had not '
        + 'fetched any.';
    }
    if (prov.kind === 'mock') return 'This demo scenario carries no route data.';
    return 'No route data was available, and the report could not fetch it without AWS credentials.';
  };

  const routeDataNote = () => {
    if (topology.vifRoutes?.size) {
      // Provenance travels with the data. A demo export whose prefix matrices look
      // like a live audit is the exact failure the no-fabrication rule guards against.
      return prov.kind === 'mock'
        ? `<p class="meta"><strong>Demo scenario</strong> &mdash; the prefixes in every matrix
           below are bundled mock data, not a Direct Connect read.</p>`
        : '';
    }
    const reason = prov.fetchedForReport && prov.routesError
      ? `this report requested them and the call did not return any:
         <code>${escapeHtml(prov.routesError)}</code>`
      : prov.kind === 'imported'
        ? 'no route data travelled with this snapshot &mdash; the app that exported it had not'
          + ' fetched any'
        : prov.kind === 'mock'
          ? 'this demo scenario carries no route data'
          : 'no route data was available, and the report could not fetch it without AWS'
            + ' credentials';
    return `<p class="meta"><strong>Prefix consistency is not assessed on any gateway</strong>
      &mdash; ${reason}. The action is
      <code>directconnect:ListVirtualInterfaceRoutes</code>, a <code>List*</code> call that the
      <code>directconnect:Describe*</code> wildcard does <em>not</em> cover, so it needs its own
      policy entry. An unfetched comparison is not a clean one: nothing below says whether your
      prefixes have a failover path.</p>`;
  };

  /**
   * Gateway-scoped findings at one severity, as links into the cards that describe
   * them.
   *
   * This is what keeps the executive summary's counts honest. The findings strip counts
   * every finding in the account, and its three cards link here by severity — so if
   * this section listed only the estate-scoped ones, a strip reading "14 informational"
   * would land the reader on a list of two. An index rather than a second set of cards:
   * the description belongs beside the resources it names, and duplicating it is the
   * failure the whole restructure was meant to remove.
   *
   * Must be called AFTER the gateway cards are rendered — they mint the anchors.
   */
  const gatewayIndexFor = (severity: Recommendation['severity']): string => {
    const rows = gwViews.flatMap((v) =>
      v.recs
        .filter((r) => r.severity === severity)
        .map((r) => {
          const meta = metaFor(r.ruleId);
          const anchor = findingAnchors.get(`${v.navId}::${recKey(r)}`);
          const id = meta ? `<code class="finding-id">${escapeHtml(meta.publishedId)}</code>` : '';
          const title = anchor
            ? `<a href="#${anchor}">${escapeHtml(r.title)}</a>`
            : escapeHtml(r.title);
          return `<tr><td>${id}</td><td>${title}</td>
            <td><a href="#${v.navId}">${escapeHtml(v.gw.dxGatewayName || v.gw.dxGatewayId)}</a></td></tr>`;
        }),
    );
    if (rows.length === 0) return '';
    return `<p class="meta">${rows.length} further ${SEVERITY_LABEL[severity].toLowerCase()}
      finding${rows.length === 1 ? '' : 's'} ${rows.length === 1 ? 'is' : 'are'} scoped to a single
      DX gateway and described on its card:</p>
      <table class="gw-index">
        <thead><tr><th>ID</th><th>Finding</th><th>On gateway</th></tr></thead>
        <tbody>${rows.join('')}</tbody>
      </table>`;
  };

  /**
   * Gateway id → the anchor of the FIRST flagged row in its route-diff matrix.
   *
   * Only for gateways whose matrix is actually rendered: `renderRouteAnalysis`
   * walks `topology.dxGateways`, so a gateway the assessment knows about but the
   * topology does not would otherwise get a link to an id nobody emitted, and
   * `export-report-redaction.test.ts` asserts every in-document href resolves.
   */
  const renderedGwIds = new Set(topology.dxGateways.map((g) => g.directConnectGatewayId));
  const gwPrefixAnchors = new Map<string, string>(
    gwViews
      .filter((v) => renderedGwIds.has(v.gw.dxGatewayId)
        && !!v.diff?.rows.some((r) => r.verdict !== 'redundant'))
      .map((v) => [v.gw.dxGatewayId, `rt-${v.navId}-p1`]),
  );

  const quickView = buildQuickView(
    topology,
    assessment,
    gwViews.map((v) => v.gw.dxGatewayId),
  );

  /** VIFs on no DX gateway. They are assessed by the estate-wide rules only, so the
   *  group exists to say so rather than to leave them unaccounted for. */
  const orphanVifs = topology.virtualInterfaces.filter((v) => !v.directConnectGatewayId);

  const SECTIONS: Section[] = [
    { id: 'check-matrix', title: 'Resiliency exposure' },
    { id: 'executive-summary', title: 'Executive summary' },
    // Caller-supplied sections sit directly after the summary, in the order given,
    // and are nav-linked from here so no extra section can become a dead link.
    ...extraSections.map((s) => ({ id: s.id, title: s.title })),
    // Heads the band rather than sitting above it, and stays a row of its own: without
    // it the scroll-spy has no entry to highlight while the reader is on the section's
    // own intro, between the exposure table and the first gateway card.
    { id: 'per-dx-gateway', title: 'Overview', band: 'Per DX gateway' },
    ...gwViews.map((v) => ({
      id: v.navId,
      title: v.gw.dxGatewayName,
      group: true,
      badge: {
        critical: v.counts.critical || undefined,
        warning: v.counts.warning || undefined,
        // A gateway with no critical/warning finding still shows a tick, so "nothing
        // wrong" is legible without expanding it.
        ok: v.counts.critical + v.counts.warning === 0,
      },
      children: [
        { id: `${v.navId}-posture`, title: 'Posture & coverage' },
        {
          id: `${v.navId}-vifs`,
          title: 'Virtual interfaces',
          badge: { text: `${v.vifs.length} VIF${v.vifs.length === 1 ? '' : 's'}` },
        },
        { id: `${v.navId}-findings`, title: 'Findings', badge: { info: v.recs.length || undefined } },
        // Always present, even with no route data: the subsection then explains WHY
        // there is no comparison, which is the actionable half (the permission is a
        // `List*` the `Describe*` wildcard does not cover). A missing row would read
        // as "this gateway has no prefixes".
        {
          id: `${v.navId}-prefix`,
          title: 'Prefix consistency',
          badge: !v.diff
            ? { text: 'n/a' }
            : v.gaps.length
              ? { text: `${v.gaps.length} VIF${v.gaps.length === 1 ? '' : 's'}` }
              : { ok: true },
        },
        // The matrix now sits inside Prefix consistency, under the gateway it
        // describes, rather than in a separate estate-wide section this row used to
        // link out to. It keeps its own row because the grid is what most readers came
        // for and it is a long scroll below the summary above it.
        ...(v.diff ? [{
          id: `rt-${v.navId}`,
          title: 'Route diff',
          badge: v.flagged ? { text: String(v.flagged) } : { ok: true },
        }] : []),
        { id: `${v.navId}-util`, title: 'VIF utilization' },
      ],
    })),
    ...(orphanVifs.length ? [{
      id: 'gw-other',
      title: `No DX gateway (${orphanVifs.length} VIF${orphanVifs.length === 1 ? '' : 's'})`,
    }] : []),
    {
      id: 'findings',
      // The account total, matching the findings strip: the section accounts for every
      // finding, stating the estate-scoped ones in full and indexing the
      // gateway-scoped ones as links into their cards.
      title: 'All findings by severity',
      band: 'Estate-wide',
      badge: {
        critical: findingCounts.critical || undefined,
        warning: findingCounts.warning || undefined,
        info: findingCounts.info || undefined,
      },
      children: (['critical', 'warning', 'info'] as const).map((sev) => ({
        id: `findings-${sev}`,
        title: SEVERITY_LABEL[sev],
        badge: { info: findingCounts[sev] || undefined },
      })),
    },
    { id: 'best-practices', title: 'Best practices' },
    { id: 'vif-utilization', title: 'VIF utilization' },
    { id: 'route-tables', title: 'Route tables' },
    { id: 'inventory', title: 'Inventory' },
  ];

  const prov: Provenance = provenance
    ?? { kind: scenario ? 'mock' : 'live', scenario, primaryRegion: null, redacted: false };
  /**
   * Masks account IDs, resource IDs, IPs and CIDRs when the app's redact mode is on.
   *
   * Applied ONCE, over the finished body HTML, rather than threaded through the
   * thirty-odd render functions above. That is safe here because the maskers in
   * `utils/redact.ts` are token-shaped — `dxvif-<hex>`, a 12-digit account number,
   * an IPv4 address, a CIDR — so they match the data and not the markup: no class
   * name, element id or CSS value in this file has the `<prefix>-<hex>` shape they
   * look for (checked, and the redaction test asserts the markup survives). The
   * alternative was a masker argument on every renderer and every `escapeHtml`
   * call site, where a single one missed is a leak that looks exactly like a pass.
   *
   * Region names, resource names, descriptions and tags are deliberately NOT masked
   * — that matches what redact mode does on the canvas, and the report says so in
   * its provenance chip rather than implying a stronger guarantee than it gives.
   *
   * `redact()` alone is NOT enough for every value: it masks a *labelled* ASN
   * (`ASN: 65000`) and nothing else. The route-diff legend prints bare AS paths, so it
   * calls `redactAsn()` itself, per hop, where it builds them — see `asPaths` in
   * `renderPrefixConsistency`. Any new section printing an AS path or a BGP community
   * must do the same with `redactAsn()` / `redactCommunity()`; this pass will not catch
   * them, and the failure is silent.
   */
  const mask = (s: string) => redact(s, prov.redacted);

  // After `prov`, because the AS paths in these rows are masked per hop at build time —
  // the body-wide `mask()` pass cannot catch a bare ASN.
  const routeRows = buildRouteTableRows(topology, prov.redacted);
  const routeAnchors = receivedRouteAnchors(routeRows);
  const routeAnchorFor = (vifId: string, cidr: string) =>
    routeAnchors.get(routeRowKey(vifId, cidr));

  const provRegion = prov.primaryRegion
    ? ` &middot; Primary region ${escapeHtml(prov.primaryRegion)}`
    : ' &middot; Primary region not recorded';
  const provRegions = stats.dxRegions.length
    ? ` &middot; Regions covered ${escapeHtml(stats.dxRegions.join(', '))}`
    : '';
  // Only abnormal provenance is chipped. A live read is the expected case and a
  // green "live AWS read" pill on every real report is noise; mock, imported and
  // redact-mode are the states a reader must not miss.
  const PROV_TEXT: Partial<Record<Provenance['kind'], string>> = {
    mock: 'mock scenario', imported: 'imported snapshot',
  };
  const provLabel = PROV_TEXT[prov.kind];
  // Redaction is chipped in BOTH directions, because both states mislead in silence.
  // With it on, a reader who does not know why every ID is a row of bullets reads the
  // file as corrupt or incomplete, and the chip also has to be honest that names are
  // untouched. With it off, the file carries real account and resource IDs — and the
  // person it gets forwarded to never clicked Export and never saw the confirmation
  // dialog, so this line is their only notice. Mock data gets neither chip: there is
  // nothing to protect, and the scenario chip already says the numbers are synthetic.
  const redactChip = prov.redacted
    ? ` <span class="prov redacted">redacted &middot; account IDs, resource IDs, IPs and CIDRs masked; names are not</span>`
    : prov.kind === 'mock'
      ? ''
      : ` <span class="prov unmasked">not redacted &middot; contains real account IDs, resource IDs, IPs and CIDRs</span>`;
  const provChip = (provLabel
    ? ` <span class="prov ${prov.kind}">${provLabel}`
      + (prov.scenario ? `: ${escapeHtml(prov.scenario)}` : '')
      + `</span>`
    : '')
    + redactChip;

  const coverageCard = (covered: boolean, title: string, desc: string) =>
    `<li class="coverage-card ${covered ? 'covered' : 'gap'}">
      <!-- Not &#9675;: the route-diff marks now use it for "covered by a less specific
           route", i.e. healthy, and this badge means the opposite — an uncovered gap.
           Same shape, opposite verdict, one document. The exclamation matches the
           reference list's own gap icon, so the two agree rather than inventing a
           third symbol for the same idea. -->
      <span class="coverage-icon">${covered ? '&#10003;' : '!'}</span>
      <div class="coverage-body">
        <div class="coverage-title">${escapeHtml(title)}</div>
        <div class="coverage-desc">${escapeHtml(desc)}</div>
      </div>
    </li>`;

  // Per-DXGW sections render as repeated "posture + coverage" blocks so each
  // gateway reports against its own target independently. When a topology has
  // no DXGWs (edge case / test fixtures) we fall back to the aggregate view.
  const renderPostureBlock = (
    scopeStats: ReturnType<typeof collectTopologyStats>,
    postureLevel: ResiliencyLevel,
    targetLevel: ResiliencyLevel,
  ): string => {
    const tint = TIER_BADGE_COLOR[postureLevel];
    // User's chosen target defines the "next target" column; also include any
    // other upgrade options computed from the current tier so the reader sees
    // the full upgrade path.
    const allOptions = upgradeOptionsFor(postureLevel, scopeStats);
    const targetOption = allOptions.find((o) => o.level === targetLevel);
    const orderedOptions = targetOption
      ? [targetOption, ...allOptions.filter((o) => o.level !== targetLevel)]
      : allOptions;
    return `<div class="posture-card">
      <div class="posture-flow">
        <div class="posture-block posture-current" style="--tier-tint:${tint}22">
          <div class="label">Current Posture</div>
          <div class="tier-value"><span class="tier-badge" style="background:${tint}">${escapeHtml(TIER_LABELS[postureLevel])}</span></div>
          <div class="sla-value">${escapeHtml(TIER_SLA[postureLevel])}</div>
        </div>
        ${orderedOptions.length === 0
          ? `<div class="posture-block posture-next">
              <div class="label">Next Target</div>
              <div class="tier-value"><span style="color:${SEVERITY_COLOR.info}">At highest tier</span></div>
              <div class="sla-value">Maintain operational best practices</div>
            </div>`
          : orderedOptions.map((opt, i) => {
              const optColor = TIER_BADGE_COLOR[opt.level];
              const header = i === 0
                ? 'Selected Target'
                : orderedOptions.length > 1
                  ? 'Alternative'
                  : 'Next Target';
              return `<div class="posture-block posture-option" style="--option-color:${optColor}">
                <div class="label">${escapeHtml(header)}</div>
                <div class="tier-value"><span class="arrow">&rarr;</span><span class="tier-badge" style="background:${optColor}">${escapeHtml(TIER_LABELS[opt.level])}</span></div>
                <div class="sla-value"><strong style="color:var(--text)">${escapeHtml(TIER_SLA[opt.level])}</strong><br>${escapeHtml(opt.step)}</div>
              </div>`;
            }).join('')}
      </div>
      <p class="posture-summary">${escapeHtml(TIER_SUMMARY[postureLevel])}</p>
    </div>`;
  };

  const renderCoverageBlock = (scopeStats: ReturnType<typeof collectTopologyStats>): string => {
    const hasMultiLoc = scopeStats.locationConns.size >= 2;
    const locationEntries = [...scopeStats.locationConns.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    // Device redundancy is only "covered" in the SLA-tier sense when there
    // are 2+ locations AND every location has 2+ connections. Same-site
    // device redundancy (1 loc × 2 conns) doesn't qualify for a named tier,
    // so it must render as a gap — otherwise the report contradicts the
    // "DEV/TEST — 95%" posture badge shown directly above.
    let deviceCards: string;
    if (locationEntries.length === 0) {
      deviceCards = coverageCard(false, 'Device redundancy', 'No connections detected');
    } else if (locationEntries.length === 1) {
      const [loc, count] = locationEntries[0];
      deviceCards = coverageCard(
        false,
        `Device redundancy at ${loc}`,
        count >= 2
          ? `${count} AWS logical devices at a single location — protects against local device failure but doesn't qualify for the 99.9%/99.99% SLA. Add a second location first.`
          : `Only ${count} AWS logical device — a device outage cuts this location entirely`,
      );
    } else {
      deviceCards = locationEntries.map(([loc, count]) =>
        coverageCard(
          count >= 2,
          `Device redundancy at ${loc}`,
          count >= 2
            ? `${count} AWS logical devices — a device outage is survivable at this location`
            : `Only ${count} AWS logical device — a device outage cuts this location entirely`,
        )
      ).join('');
    }
    return `<ul class="coverage-list">
      ${coverageCard(
        hasMultiLoc,
        'Location redundancy',
        hasMultiLoc
          ? `${scopeStats.locationConns.size} DX locations — an outage at one still leaves the other available`
          : scopeStats.locationConns.size === 1
            ? 'Only 1 DX location — a location-wide outage takes down all connectivity'
            : 'No DX locations detected',
      )}
      ${deviceCards}
    </ul>`;
  };

  const renderImprovementSteps = (
    scopeStats: ReturnType<typeof collectTopologyStats>,
    postureLevel: ResiliencyLevel,
  ): string => {
    const steps = nextStepsFor(postureLevel, scopeStats);
    return `<ol class="steps">${steps.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ol>`;
  };

  // Protection-coverage check list for a scoped stats snapshot. Returns a short
  // human-readable list of gaps plus a "covered" boolean the table uses to
  // pick a chip color. Mirrors the logic in renderCoverageBlock but emits a
  // compact string list instead of card markup.
  const coverageSummary = (
    scopeStats: ReturnType<typeof collectTopologyStats>,
  ): { covered: boolean; gaps: string[] } => {
    const gaps: string[] = [];
    const locCount = scopeStats.locationConns.size;
    if (locCount < 2) {
      gaps.push(locCount === 0 ? 'No DX locations' : 'Single-location only');
    }
    // `locationConns` counts DEVICES, so the chip has to say device. It read
    // "1 conn @ X" while sitting next to a links column reporting two
    // connections at that same location — the two numbers are both right and
    // the report looked like it contradicted itself.
    for (const [loc, n] of [...scopeStats.locationConns.entries()].sort()) {
      if (n < 2) gaps.push(`1 device @ ${loc}`);
    }
    return { covered: gaps.length === 0, gaps };
  };

  // One-line upgrade headline. Picks the user-selected target step if present,
  // otherwise the first remaining option, otherwise calls out that we're at the ceiling.
  const nextStepHeadline = (
    scopeStats: ReturnType<typeof collectTopologyStats>,
    postureLevel: ResiliencyLevel,
    targetLevel: ResiliencyLevel,
  ): { label: string; step: string } => {
    const options = upgradeOptionsFor(postureLevel, scopeStats);
    if (options.length === 0) {
      return { label: 'At highest tier', step: 'Maintain operational best practices.' };
    }
    const chosen = options.find((o) => o.level === targetLevel) ?? options[0];
    return { label: TIER_LABELS[chosen.level], step: chosen.step };
  };

  // Per-DXGW sections: summary table for multi-DXGW, card for no-DXGW fallback.
  // Each DXGW gets a row with scope, current/target tiers, coverage gaps, and
  // the selected upgrade step so readers can scan all gateways at a glance
  // instead of scrolling through repeated card blocks.
  /**
   * A gateway's own findings, linked back to the estate-wide Findings section rather
   * than re-anchored here: the same finding must not carry the same `id` twice, or
   * every link to it lands on whichever copy the browser found first.
   */
  /**
   * A gateway's own findings, and the ONLY place they are rendered.
   *
   * They used to be listed here and again in an estate-wide "All findings" section and
   * again as a row in a ranked table — the same wording three times, none of which
   * said which connection or VIF it was about. Now the card is the finding: it carries
   * the anchor, it names the impacted resources, and `DX-ARC-01` is a plain chip
   * rather than a link, because the reader is already looking at the thing it cites.
   */
  const renderScopedFindings = (recs: Recommendation[], v: GwView): string => {
    const navId = v.navId;
    if (recs.length === 0) {
      return `<p class="meta">No rule flagged anything scoped to this gateway. Checks that are not
        gateway-scoped still apply &mdash; see
        <a href="#findings">Estate-wide findings</a>.</p>`;
    }
    const order = { critical: 0, warning: 1, info: 2 } as const;
    return [...recs]
      .sort((a, b) => order[a.severity] - order[b.severity])
      .map((r) => {
        const meta = metaFor(r.ruleId);
        const anchor = `${navId}-${meta ? `f-${meta.publishedId}` : 'f-unrated'}`;
        findingAnchors.set(`${navId}::${recKey(r)}`, anchor);
        return `<div id="${anchor}" class="finding severity-${r.severity}">
          <div class="finding-head">
            <span class="severity-tag" style="background:${SEVERITY_COLOR[r.severity]}20;color:${SEVERITY_COLOR[r.severity]};border:1px solid ${SEVERITY_COLOR[r.severity]}50">${SEVERITY_LABEL[r.severity]}</span>
            <h4>${escapeHtml(r.title)}</h4>
            ${meta ? `<code class="finding-id">${escapeHtml(meta.publishedId)}</code>` : ''}
          </div>
          <p>${linkifyFinding(v, escapeHtml(r.description))}</p>
        </div>`;
      }).join('');
  };

  /**
   * Which prefixes each VIF does not carry exactly — the table form of DX-CFG-07,
   * whose prose truncates the list at five. Every prefix is listed: the reader's next
   * action is to reconfigure a router, and a truncated list cannot be worked from.
   *
   * "Missing" is `state !== 'exact'`, the same set the rule counts, and the marker
   * says what the VIF does have instead: `&#9675;` a less specific route that already
   * reaches the destination (no change needed), `&#9651;` fragments inside the block
   * (partly covered), `&#215;` nothing.
   */
  const renderPrefixConsistency = (v: GwView): string => {
    // The count of prefixes with no path anywhere jumps to the first of them, not to
    // the top of the matrix — see `flaggedRowAnchor`.
    const firstFlagged = gwPrefixAnchors.get(v.gw.dxGatewayId);
    if (!v.diff) {
      const onGw = v.vifs.length;
      const covered = v.vifs.filter((x) => topology.vifRoutes?.has(x.virtualInterfaceId)).length;
      const why = onGw === 0
        ? 'no VIFs are attached to this gateway.'
        : !topology.vifRoutes
          ? 'no BGP route data was available. <code>directconnect:ListVirtualInterfaceRoutes</code>'
            + ' is a <code>List*</code> action that the <code>directconnect:Describe*</code> wildcard'
            + ' does <em>not</em> cover, so it needs its own policy entry.'
          : `${covered} of ${onGw} VIF${onGw === 1 ? '' : 's'} on this gateway`
            + ` ${covered === 1 ? 'has' : 'have'} route data, and a comparison needs at least two.`
            + (onGw === 1
              ? ' A gateway reached by a single VIF is a single point of failure in its own'
                + ' right — see Findings above.'
              : '');
      return `<p class="meta">No cross-VIF comparison &mdash; ${why}</p>`;
    }
    const line = routeVerdictLine(v.diff, `rt-${v.navId}`);
    /**
     * Distinct AS paths per VIF, worst-case first (longest path = most hops).
     *
     * Masked HERE rather than by the report's one `mask()` pass over the body: that
     * pass uses `redact()`, which masks a *labelled* ASN (`ASN: 65000`) and nothing
     * else, so a bare AS path would have shipped in the clear in a redacted export.
     * Same trap `redactCommunity` exists for.
     */
    /**
     * AS path LENGTH per (VIF, prefix), which is what the matrix ranks on.
     *
     * Shortest per prefix where a VIF returns it more than once: the API returns a
     * prefix once per AWS logical device it is installed on, and if those copies
     * disagree the router prefers the shortest — so taking the first would rank on
     * whichever copy happened to come back first.
     */
    const hopCount = new Map<string, number>();
    const hopKey = (vifId: string, cidr: string) => `${vifId}|${cidr}`;
    for (const dv of v.diff.vifs) {
      for (const r of topology.vifRoutes?.get(dv.vifId)?.accepted ?? []) {
        const hops = (r.asPath ?? []).flatMap((seg) => seg.path ?? []).length;
        const key = hopKey(dv.vifId, r.cidr);
        const prev = hopCount.get(key);
        if (prev === undefined || hops < prev) hopCount.set(key, hops);
      }
    }
    const hopsOf = (vifId: string, cidr: string) => hopCount.get(hopKey(vifId, cidr));
    const gapRows = v.gaps.map((g) => `<tr>
      <td>${nameWithId(g.label, g.vifId)}<div class="sub">${escapeHtml(g.vifType)}</div></td>
      <td class="num">${g.missing.length} of ${v.unionSize}</td>
      <td class="prefix-cell">${g.missing.map((m) => {
        const mark = CELL_MARK[m.state];
        return `<span class="prefix-chip" title="${escapeHtml(mark.title)}"><span class="mark ${mark.cls}">${mark.glyph}</span>${escapeHtml(m.cidr)}</span>`;
      }).join('')}</td>
    </tr>`).join('');
    const summary = v.gaps.length === 0
      ? `<p class="meta">All ${v.unionSize} prefix${v.unionSize === 1 ? '' : 'es'} on this gateway
          ${v.unionSize === 1 ? 'is' : 'are'} accepted by every one of its
          ${v.diff.vifs.length} VIFs.</p>`
      : `<p class="meta">${v.gaps.length} of this gateway's ${v.diff.vifs.length} VIFs
          ${v.gaps.length === 1 ? 'does' : 'do'} not accept every prefix the gateway receives, out of
          ${v.unionSize} distinct prefix${v.unionSize === 1 ? '' : 'es'}. That is only a failover gap
          where no sibling VIF covers the prefix &mdash; ${v.flagged === 0
            ? 'none of these is in that state on this gateway'
            : firstFlagged
              ? `<a href="#${firstFlagged}">${v.flagged} ${v.flagged === 1 ? 'is' : 'are'}</a>`
              : `${v.flagged} ${v.flagged === 1 ? 'is' : 'are'}`}.</p>
        <table class="prefix-table">
          <thead><tr><th>Virtual interface</th><th style="text-align:right">Not accepted</th>
            <th>Prefixes</th></tr></thead>
          <tbody>${gapRows}</tbody>
        </table>
        <p class="meta"><span class="mark mark-covered">&#9675;</span> covered by a less specific route on
          this VIF &mdash; failover works, no change needed &middot;
          <span class="mark mark-partial">&#9651;</span> only part of the block &middot;
          <span class="mark mark-absent">&#215;</span> not reachable via this VIF</p>`;
    // The matrix is here, under the gateway it describes, rather than in a separate
    // estate-wide section it used to be linked into. One gateway's prefix×VIF grid is
    // only meaningful against that gateway's own VIFs, and splitting the verdict from
    // the grid meant every summary sentence ended in "see the route-diff matrix".
    return `${summary}
      <h5 class="rt-h" id="rt-${v.navId}">Route diff &mdash; which VIF carries each prefix</h5>
      <p class="route-verdict ${line.cls}">${line.html}</p>
      ${renderRouteMatrix(v.diff, `rt-${v.navId}`, hopsOf, routeAnchorFor)}
      ${ROUTE_DIFF_LEGEND}`;
  };

  /**
   * The gateway's own VIFs, worst first. Methodology, bands and the estate-wide
   * comparison stay in the single VIF utilization section — repeating the source
   * table per gateway would be the same numbers four times.
   */
  const renderScopedUtilization = (v: GwView): string => {
    const connById = new Map(topology.connections.map((c) => [c.connectionId, c]));
    const rows = v.vifs.map((vif) => {
      const conn = connById.get(vif.connectionId);
      const cap = capacityOf(vif, conn);
      const u = topology.vifUtilization?.get(vif.virtualInterfaceId);
      const worst = peakOf(u);
      const measured = cap.bps != null && cap.bps > 0 && worst != null ? (worst / cap.bps) * 100 : null;
      const pct = cap.gradable ? measured : null;
      const awsPct = pct == null ? (utilPctPeakOf(u) ?? measured) : null;
      return { vif, cap, worst, pct, awsPct };
    }).sort((a, b) => (b.pct ?? b.awsPct ?? -1) - (a.pct ?? a.awsPct ?? -1));

    if (rows.length === 0) return `<p class="meta">This gateway has no virtual interfaces.</p>`;
    if (rows.every((r) => r.pct == null && r.awsPct == null)) {
      return `<p class="meta">No CloudWatch datapoints for any VIF on this gateway &mdash; see
        <a href="#vif-utilization">VIF utilization</a> for whether they were fetched. An unmeasured
        VIF is not a quiet one.</p>`;
    }
    const body = rows.map((r) => {
      const band = UTIL_BAND[utilBandOf(r.pct)];
      const shown = r.pct ?? r.awsPct;
      return `<tr>
        <td>${nameWithId(vifLabel(r.vif), r.vif.virtualInterfaceId)}</td>
        <td>${r.cap.bps != null
          ? `${escapeHtml(formatBps(r.cap.bps))} <span class="sub">${escapeHtml(r.cap.source)}</span>`
          : `<span class="sub">${escapeHtml(r.cap.source)}</span>`}</td>
        <td class="num">${r.worst != null ? escapeHtml(formatBps(r.worst)) : '<span class="sub">&mdash;</span>'}</td>
        <td class="num">${shown == null
          ? '<span class="sub">&mdash;</span>'
          : `${shown < 1 ? shown.toFixed(2) : shown.toFixed(1)}%`}</td>
        <td>${r.pct != null
          ? `<span class="chip-pill ${band.cls}">${band.label}</span>`
          : `<span class="chip-pill band-unknown">not graded</span>`}</td>
      </tr>`;
    }).join('');
    return `<table>
        <thead><tr><th>Virtual interface</th><th>Capacity</th>
          <th style="text-align:right">Peak</th><th style="text-align:right">%</th>
          <th>Band</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
      <p class="meta">Peak of hourly averages, banded by this report's convention. Metric names,
      window and denominators are in <a href="#vif-utilization">VIF utilization</a>.</p>`;
  };

  /**
   * The gateway's posture as numbers: two tier badges, one next-step line, and a row
   * per DX location.
   *
   * Replaces the posture card and the four protection-coverage cards that used to be
   * repeated verbatim under every gateway. Those said the same three paragraphs on
   * each of four gateways, so the parts that actually differ — which location is
   * short a device, and by how much — were the least prominent thing on the page.
   * What is left here is per-gateway fact; the shared explanation of the notation
   * lives once in the exposure table's column definitions.
   *
   * The per-location rows are not redundant with the exposure table's link chips at
   * the top of the report: those compress to `2&middot;1` to stay scannable across
   * every gateway at once, and this is where a reader who stopped at one gateway gets
   * it spelled out. They are also computed differently, and on one estate they will
   * disagree — this table counts devices via `getLocationLinkCounts`, which treats a
   * link with no `awsLogicalDeviceId` as a device of its own, whereas the chips report
   * that link as `2&middot;?` rather than assert redundancy AWS never confirmed. Read
   * together that is the whole story: this table says how many links there are, the
   * chip says whether their independence is established.
   */
  const renderGatewayPosture = (v: GwView): string => {
    const gw = v.gw;
    const currentColor = TIER_BADGE_COLOR[gw.currentLevel];
    const targetColor = TIER_BADGE_COLOR[gw.targetLevel];
    const atCeiling = gw.currentLevel === 'maximum';
    const next = nextStepHeadline(v.scopedStats, gw.currentLevel, gw.targetLevel);
    // Moved here when the side-by-side summary table was deleted. It belongs in the
    // card headed "Posture & coverage" more than in a row of a table that had to
    // compress it, and the chips can now link into this gateway's own findings.
    const coverage = coverageSummary(v.scopedStats);
    const entries = [...v.scopedStats.locationLinks.entries()].sort(
      (a, b) =>
        a[1].devices - b[1].devices
        || a[1].connections - b[1].connections
        || a[0].localeCompare(b[0]),
    );
    const locRows = entries.length === 0
      ? `<tr><td colspan="4"><span class="table-muted">No Direct Connect connections on this gateway.</span></td></tr>`
      : entries.map(([loc, l]) => `<tr>
          <td><code class="inline-id">${escapeHtml(loc)}</code></td>
          <td class="num">${l.connections}</td>
          <td class="num">${l.devices}</td>
          <td>${l.devices >= 2
            ? `<span class="chip-pill band-normal">Device-redundant</span>`
            : `<span class="chip-pill band-elevated">Single device</span>`}</td>
        </tr>`).join('');

    return `<div class="gw-posture">
      <div class="gw-posture-tiers">
        <span class="tier-badge" style="background:${currentColor}">${escapeHtml(TIER_LABELS[gw.currentLevel])}</span>
        <span class="table-sla">${escapeHtml(TIER_SLA[gw.currentLevel])}</span>
        ${atCeiling
          ? `<span class="table-muted">&mdash; highest tier</span>`
          : `<span class="arrow">&rarr;</span>
             <span class="tier-badge" style="background:${targetColor}">${escapeHtml(TIER_LABELS[gw.targetLevel])}</span>
             <span class="table-sla">${escapeHtml(TIER_SLA[gw.targetLevel])}</span>`}
      </div>
      <p class="gw-posture-coverage"><span class="gw-posture-k">Protection coverage</span>
        ${coverage.covered
          ? `<span class="table-chip chip-ok" title="Every protection check passes for this gateway">&#10003; Fully covered</span>`
          : coverage.gaps
              .map((g) => `<a class="table-chip chip-gap" href="#${v.navId}-findings" title="${escapeHtml(`${g} — open this gateway's findings`)}">${escapeHtml(g)}</a>`)
              .join(' ')}</p>
      <p class="meta"><strong>Next step:</strong> ${escapeHtml(atCeiling ? 'Maintain operational best practices.' : next.step)}</p>
      <table>
        <thead><tr><th>DX location</th><th style="text-align:right">Connections</th>
          <th style="text-align:right">AWS devices</th><th>Device redundancy</th></tr></thead>
        <tbody>${locRows}</tbody>
      </table>
    </div>`;
  };

  /**
   * The gateway's inventory: one row per VIF, naming the IDs an operator has to
   * type into the console or a support case.
   *
   * The rest of this gateway's card grades things — tiers, findings, bands — and
   * every one of those verdicts is about a VIF the reader cannot yet identify: the
   * posture table counts connections per location, and the utilization table names
   * the VIF but not the connection carrying it. So this is deliberately flat, with
   * no verdict of its own beyond the two states AWS reports (VIF state, BGP status)
   * and the prefix count against the allocation, which is the one number the
   * findings above can cite without saying where to look it up.
   *
   * Rendered even when the gateway has no VIFs: the summary table's "N VIFs" link
   * points here for every gateway, and the redaction test requires every href to
   * resolve to an emitted id.
   */
  /**
   * When this VIF's BGP session last dropped.
   *
   * Three states that must stay distinct, because collapsing any two of them makes the
   * column lie: not fetched (`bgpStability` absent — it is billed per metric, so this
   * is the common case), fetched but no stream for this VIF, and sampled with either a
   * timestamp or a clean window. A blank cell would read as "never dropped", which is
   * the one claim the data cannot support when nobody asked CloudWatch.
   */
  const lastDownCellFor = (vif: DxVirtualInterface): string => {
    const stability = topology.bgpStability;
    if (!stability || stability.size === 0) {
      return `<span class="sub" title="BGP history is a billed CloudWatch read and was not fetched for this report">not fetched</span>`;
    }
    const s = stability.get(vif.virtualInterfaceId);
    if (!s) {
      return `<span class="sub" title="CloudWatch returned no VirtualInterfaceBgpStatus stream for this VIF">no stream</span>`;
    }
    if (!s.lastFlapAt) {
      return `<span class="chip-pill band-normal" title="${escapeHtml(`No up→down transition in the ${s.windowDays} days sampled. CloudWatch retention bounds the window, so this is not "never".`)}">no drop &middot; ${s.windowDays}d</span>`;
    }
    const when = formatUtcStamp(s.lastFlapAt);
    return `<span class="chip-pill band-elevated" title="${escapeHtml(`${s.flapCount} up→down transition${s.flapCount === 1 ? '' : 's'} in the ${s.windowDays} days sampled; ${s.downPeriods} of ${s.totalPeriods} sampled intervals were down for at least part of the interval.`)}">${escapeHtml(when)}</span>
      <div class="sub">${s.flapCount} drop${s.flapCount === 1 ? '' : 's'} / ${s.windowDays}d</div>`;
  };

  /**
   * Wrap a flagged Accepted/Allocated cell in a link to the finding that explains it.
   *
   * Only when the cell is actually banded, and only when this gateway carries the
   * finding: `bgp-route-limit` is now graded per gateway, so the card holding the
   * number also holds the card explaining it — the link is a short in-page jump rather
   * than a trip to an estate-wide list. An unbanded cell is left alone; making every
   * healthy fraction clickable would bury the two that are not.
   */
  const quotaLink = (v: GwView, cell: string): string => {
    if (!cell.includes('quota-near') && !cell.includes('quota-over')) return cell;
    const rec = v.recs.find((r) => r.ruleId === 'bgp-route-limit');
    const anchor = rec ? findingAnchors.get(`${v.navId}::${recKey(rec)}`) : undefined;
    return anchor
      ? `<a class="quota-link" href="#${anchor}" title="At or above the allocation — open the finding for this gateway">${cell}</a>`
      : cell;
  };

  /** Any VIF on this gateway accepting more distinct prefixes than its allocation. */
  const anyOverAllocation = (v: GwView): boolean =>
    v.vifs.some((vif) => {
      const rts = topology.vifRoutes?.get(vif.virtualInterfaceId);
      return !!rts && prefixCountsOverAllocation(vif, rts.accepted);
    });

  const renderGatewayVifs = (v: GwView): string => {
    if (v.vifs.length === 0) {
      return `<p class="meta">No virtual interfaces are attached to this DX Gateway. It carries no
        traffic until one is created and associated.</p>`;
    }
    const connById = new Map(topology.connections.map((c) => [c.connectionId, c]));
    const rows = gwVifOrder(v)
      .map((vif) => {
        const conn = connById.get(vif.connectionId);
        const lag = conn?.lagId ? topology.lags.find((l) => l.lagId === conn.lagId) : undefined;
        const rts = topology.vifRoutes?.get(vif.virtualInterfaceId);
        const over = rts ? prefixCountsOverAllocation(vif, rts.accepted) : false;
        const peers = vif.bgpPeers ?? [];
        const up = peers.filter((p) => p.bgpStatus?.toLowerCase() === 'up').length;
        // "1 of 2 up" and "1 of 1 up" are different facts, so the denominator stays
        // even when there is only one peer — a dual-stack VIF has two.
        const bgp = peers.length === 0
          ? `<span class="chip-pill band-unknown">not reported</span>`
          : `<span class="chip-pill ${up === peers.length ? 'band-normal' : up === 0 ? 'band-over' : 'band-elevated'}">${up} of ${peers.length} up</span>`;
        const state = vif.virtualInterfaceState.toLowerCase();
        const stateCls = state === 'available' ? 'band-normal'
          : state === 'down' || state === 'deleting' || state === 'deleted' || state === 'rejected'
            ? 'band-over'
            : 'band-elevated';
        const connSub = [
          conn?.bandwidth,
          conn?.location ?? vif.location,
          lag ? `LAG ${lag.lagId}` : undefined,
          conn?.isInferred ? 'hosted &mdash; inferred' : undefined,
        ].filter(Boolean).map((s) => escapeHtml(String(s))).join(' &middot; ');
        return `<tr id="${vifRowAnchors(v).get(vif.virtualInterfaceId)}">
          <td>${nameWithId(vifLabel(vif), vif.virtualInterfaceId)}
            <div class="sub">${escapeHtml(vif.virtualInterfaceType)} &middot; VLAN ${vif.vlan}</div></td>
          <td>${conn
            ? nameWithId(conn.connectionName, conn.connectionId)
            : `<code class="inline-id">${escapeHtml(vif.connectionId)}</code>`}
            ${connSub ? `<div class="sub">${connSub}</div>` : ''}</td>
          <td class="num">${rts
            ? `${quotaLink(v, acceptedOverAllocationCell(vif, rts.accepted))}${over
              ? ` <span class="chip-pill v-solo" title="More distinct accepted prefixes than this VIF's allocation — the BGP session can be driven into an idle state.">&gt; allocation</span>`
              : ''}`
            : `<span class="sub">not fetched</span>`}</td>
          <td class="num">${rts ? routeCountCell(rts.advertised) : `<span class="sub">not fetched</span>`}</td>
          <td>${bgp}</td>
          <td>${lastDownCellFor(vif)}</td>
          <td><span class="chip-pill ${stateCls}">${escapeHtml(vif.virtualInterfaceState)}</span></td>
        </tr>`;
      }).join('');
    const detail = v.diff
      ? `<a href="#${v.navId}-prefix">this gateway's prefix consistency</a>`
      : `<a href="#${v.navId}-prefix">Prefix consistency</a>`;
    return `<table>
        <thead><tr><th>Virtual interface</th><th>On connection</th>
          <th style="text-align:right">Accepted / Allocated</th>
          <th style="text-align:right">Advertised</th>
          <th>BGP</th><th>Last down</th><th>VIF state</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="meta"><strong>Accepted / Allocated</strong> &mdash; distinct prefixes accepted from
      on-premises over this VIF's own allocation, <strong>per address family</strong>. The default
      allocation is <strong>100</strong> per family, raisable to <strong>1,000</strong>; a DX gateway
      allows <strong>10,000</strong> across all its VIFs. Advertise past the allocation and AWS puts
      the BGP session into an idle state. <em>not reported</em> is unknown, not zero; a public VIF
      keeps a fixed 1,000 and is not managed by prefix controls. Reference:
      ${docLink(DOC.prefixControls)}.
      <strong>Advertised</strong> &mdash; what AWS sends on the session.
      <strong>Last down</strong> &mdash; most recent BGP up&rarr;down transition;
      <strong>BGP</strong> beside it is the state <em>now</em>, so a session up today that dropped
      four times last week reads healthy in one column and not the other.
      Per-prefix failover cover is in ${detail}.</p>
      ${anyOverAllocation(v)
        ? `<p class="meta"><strong>Accepted above the allocation</strong> on the VIFs marked
           <span class="chip-pill v-solo">&gt; allocation</span>. AWS drops the excess prefixes and
           can drive a VIF advertising past its allocated count into an idle state, so the BGP
           session could go down. Summarize or filter the on-premises advertisement, or raise the
           allocation &mdash; and check <em>In use</em> of <em>Allocated</em> in the Direct Connect
           console, which is the figure AWS enforces. Reference:
           ${docLink(DOC.prefixControls)}</p>`
        : ''}`;
  };

  /**
   * The gateway's VIFs in table order. ONE sort, shared by the table that renders them
   * and the anchor map that addresses them — number the rows separately and a link
   * silently points at a different VIF.
   */
  const gwVifOrder = (v: GwView) => [...v.vifs]
    .sort((a, b) => vifLabel(a).localeCompare(vifLabel(b), undefined, { numeric: true }));

  /**
   * VIF id -> the anchor of its row in this gateway's Virtual interfaces table.
   *
   * Ordinal (`gw1-v2`), never the VIF id: `redact()` masks `dxvif-<hex>` inside `id=`
   * and `href=` too, so an id-derived anchor resolves to nothing in a redacted export.
   *
   * Memoised because it is called from both the table and the finding linkifier, and
   * those run in either order depending on where they sit in the card template.
   */
  const vifAnchorCache = new Map<string, Map<string, string>>();
  const vifRowAnchors = (v: GwView): Map<string, string> => {
    const hit = vifAnchorCache.get(v.navId);
    if (hit) return hit;
    const map = new Map(gwVifOrder(v).map((vif, i) => [vif.virtualInterfaceId, `${v.navId}-v${i + 1}`]));
    vifAnchorCache.set(v.navId, map);
    return map;
  };

  /** CIDR -> a Route tables row carrying it, for any VIF. */
  const cidrAnchors = (() => {
    const out = new Map<string, string>();
    for (const [key, anchor] of routeAnchors) {
      const cidr = key.slice(key.indexOf('|') + 1);
      if (!out.has(cidr)) out.set(cidr, anchor);
    }
    return out;
  })();

  /**
   * Turn the resource names a finding mentions into links to the rows that hold them.
   *
   * A finding says "Private-VIF-Secondary (20 accepted, allocation 24, 83%)" and the row
   * proving it is a table away; the reader should not have to search for it. VIF labels
   * link to that VIF's row in this gateway's inventory, prefixes to the Route tables
   * appendix.
   *
   * Runs on the ESCAPED description, and matches escaped labels, so a name containing
   * `&` still matches what was rendered. ONE `replace` pass over a single alternation,
   * longest match first: replacing per-label would let a second pass rewrite the `href`
   * of a link the first pass just inserted, and a short label that is a prefix of a
   * longer one (`sg-05` inside `sg-051`) would corrupt it.
   */
  const linkifyFinding = (v: GwView, escaped: string): string => {
    const targets = new Map<string, string>();
    for (const vif of v.vifs) {
      const anchor = vifRowAnchors(v).get(vif.virtualInterfaceId);
      if (!anchor) continue;
      targets.set(escapeHtml(vifLabel(vif)), anchor);
      targets.set(escapeHtml(vif.virtualInterfaceId), anchor);
    }
    for (const [cidr, anchor] of cidrAnchors) targets.set(escapeHtml(cidr), anchor);
    if (targets.size === 0) return escaped;

    const alternation = [...targets.keys()]
      .filter((t) => t.length > 2)
      .sort((a, b) => b.length - a.length)
      .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|');
    if (!alternation) return escaped;
    return escaped.replace(new RegExp(`(${alternation})`, 'g'), (match) => {
      const anchor = targets.get(match);
      return anchor ? `<a class="fx-ref" href="#${anchor}">${match}</a>` : match;
    });
  };

  /**
   * A collapsible subsection of a gateway card.
   *
   * Five gateways × (a VIF inventory, a prefix table, a prefix×VIF matrix and a
   * utilization table) is several screens of scrolling before the reader reaches the
   * second gateway. Posture and Findings stay open — they are the verdict and the work,
   * and a report that hides its findings by default is worse than a long one.
   *
   * The `id` goes on the `<summary>`, not the `<details>`: the nav and the exposure
   * table both link to these ids, and a target on the wrapper scrolls to the top of a
   * closed block that then has to be opened separately. `FOLD_JS` opens any ancestor
   * `<details>` on arrival, which is what makes a link into a folded table work at all.
   */
  const gwFold = (id: string, title: string, body: string, count?: number): string =>
    `<details class="gw-fold">
      <summary class="subsection-title gw-fold-s" id="${id}">${escapeHtml(title)}${
        count ? `<span class="gw-fold-n">${count}</span>` : ''}</summary>
      <div class="gw-fold-b">${body}</div>
    </details>`;

  /**
   * A whole gateway, collapsible.
   *
   * Only the subsections folded before, so the reader still scrolled past five
   * gateways' posture and findings to reach the sixth. The card itself is now a
   * `<details>` — but **open whenever the gateway has a critical or warning finding**,
   * because a report that hides its findings by default is worse than a long one. A
   * gateway with nothing flagged starts closed: its posture is still one click away and
   * the summary line carries the counts, so nothing is lost by folding a clean one.
   *
   * The `id` stays on the `<summary>` for the same reason it does on `gwFold` — the nav
   * and the exposure table link to it, and a target on the `<details>` scrolls to a
   * closed block. `FOLD_JS` opens ancestors on arrival, so a deep link into a closed
   * gateway still lands.
   */
  const renderGatewayCard = (v: GwView): string => {
    const gw = v.gw;
    const vifCount = v.vifs.length;
    const flaggedCount = v.counts.critical + v.counts.warning;
    return `<details class="dxgw-section"${flaggedCount > 0 ? ' open' : ''}>
      <summary class="dxgw-section-head" id="${v.navId}">
        <div class="dxgw-section-title">
          <span class="dxgw-chip">DX Gateway</span>
          <span class="dxgw-name">${escapeHtml(gw.dxGatewayName)}</span>
          ${gw.dxGatewayName !== gw.dxGatewayId
            ? `<code class="dxgw-id">${escapeHtml(gw.dxGatewayId)}</code>` : ''}
          ${v.counts.critical
            ? `<span class="gw-sum-badge gw-sum-crit">${v.counts.critical} critical</span>` : ''}
          ${v.counts.warning
            ? `<span class="gw-sum-badge gw-sum-warn">${v.counts.warning} warning</span>` : ''}
          ${flaggedCount === 0
            ? `<span class="gw-sum-badge gw-sum-ok">&#10003; nothing flagged</span>` : ''}
        </div>
        <div class="dxgw-section-meta">${gw.locationCount} location${gw.locationCount === 1 ? '' : 's'}
          &middot; ${gw.connectionCount} connection${gw.connectionCount === 1 ? '' : 's'}
          &middot; ${vifCount} VIF${vifCount === 1 ? '' : 's'}</div>
      </summary>
      <h4 class="subsection-title" id="${v.navId}-posture">Posture &amp; coverage</h4>
      ${renderGatewayPosture(v)}
      <h4 class="subsection-title" id="${v.navId}-findings">Findings</h4>
      ${renderScopedFindings(v.recs, v)}
      ${gwFold(`${v.navId}-vifs`, 'Virtual interfaces', renderGatewayVifs(v), vifCount)}
      ${gwFold(`${v.navId}-prefix`, 'Prefix consistency', renderPrefixConsistency(v),
        v.diff ? v.flagged || undefined : undefined)}
      ${gwFold(`${v.navId}-util`, 'VIF utilization', renderScopedUtilization(v))}
    </details>`;
  };

  /** Rendered in BOTH branches below: the nav lists it whenever such a VIF exists, and
   *  a link the fallback branch does not answer is a dead link. */
  const orphanSection = orphanVifs.length
    ? `<section class="dxgw-section" id="gw-other">
        <div class="dxgw-section-head">
          <div class="dxgw-section-title">
            <span class="dxgw-chip">No DX Gateway</span>
            <span class="dxgw-name">${orphanVifs.length} virtual interface${orphanVifs.length === 1 ? '' : 's'}</span>
          </div>
        </div>
        <p class="meta">These VIFs terminate on a virtual private gateway, or are public VIFs with
        no gateway at all. SLA tiers and the cross-VIF prefix comparison are both computed per DX
        Gateway, so neither applies to them &mdash; they are covered by
        <a href="#findings">Estate-wide findings</a> and
        <a href="#best-practices">Best practices</a>. Their route counts are here because there is
        no gateway card to carry them.</p>
        <table>
          <thead><tr><th>Virtual interface</th><th>Type</th><th>Connection</th>
            <th>Terminates on</th>
            <th style="text-align:right">Accepted / Allocated</th>
            <th style="text-align:right">Advertised</th>
            <th>Last down</th></tr></thead>
          <tbody>${orphanVifs.map((v) => {
            const rts = topology.vifRoutes?.get(v.virtualInterfaceId);
            return `<tr>
            <td>${nameWithId(vifLabel(v), v.virtualInterfaceId)}</td>
            <td>${escapeHtml(v.virtualInterfaceType)}</td>
            <td><code class="inline-id">${escapeHtml(v.connectionId)}</code></td>
            <td>${v.virtualGatewayId
              ? `VGW <code class="inline-id">${escapeHtml(v.virtualGatewayId)}</code>`
              : v.virtualInterfaceType === 'public'
                ? 'the AWS public network'
                : '<span class="sub">not recorded</span>'}</td>
            <td class="num">${rts ? acceptedOverAllocationCell(v, rts.accepted) : '<span class="sub">not fetched</span>'}</td>
            <td class="num">${rts ? routeCountCell(rts.advertised) : '<span class="sub">not fetched</span>'}</td>
            <td>${lastDownCellFor(v)}</td>
          </tr>`;
          }).join('')}</tbody>
        </table>
      </section>`
    : '';

  const hasPerDxgw = assessment.perDxGateway.length > 0;
  // No side-by-side summary table. It carried a tier badge, a target badge, coverage
  // chips and a next-step line per gateway — and every one of those now has exactly
  // one home: the tier pair is in the exposure table's row head, and the coverage
  // chips and next step are in the gateway's own posture card. Printing them twice is
  // how the two copies came to word the same gap differently.
  const perDxgwSections = hasPerDxgw
    ? `${gwViews.map(renderGatewayCard).join('\n')}
        ${orphanSection}`
    : (() => {
        const fallbackLevel = assessment.resiliency.currentLevel;
        const fallbackTarget = assessment.resiliency.targetLevel;
        // Zero DX footprint: tiers don't apply, so swap the red failure
        // posture for a neutral card and frame the upgrade options as
        // getting-started guidance instead of remediation.
        if (assessment.dxNotInUse) {
          const neutral = '#6b7280';
          const options = upgradeOptionsFor('none', stats);
          return `
    <section class="dxgw-section">
      <div class="posture-card">
        <div class="posture-flow">
          <div class="posture-block posture-current" style="--tier-tint:${neutral}22">
            <div class="label">Current Posture</div>
            <div class="tier-value"><span class="tier-badge" style="background:${neutral}">Direct Connect not in use</span></div>
            <div class="sla-value">DX SLA tiers not applicable</div>
          </div>
          ${options.map((opt) => {
            const optColor = TIER_BADGE_COLOR[opt.level];
            return `<div class="posture-block posture-option" style="--option-color:${optColor}">
              <div class="label">Getting started with Direct Connect</div>
              <div class="tier-value"><span class="arrow">&rarr;</span><span class="tier-badge" style="background:${optColor}">${escapeHtml(TIER_LABELS[opt.level])}</span></div>
              <div class="sla-value"><strong style="color:var(--text)">${escapeHtml(TIER_SLA[opt.level])}</strong><br>${escapeHtml(opt.step)}</div>
            </div>`;
          }).join('')}
        </div>
        <p class="posture-summary">This account has no Direct Connect connections, virtual interfaces, or DX gateways — it connects via VPN / Transit Gateway. VPN and Transit Gateway posture is assessed under Best Practices below.</p>
      </div>
      <h4 class="subsection-title">Getting Started</h4>
      ${renderImprovementSteps(stats, 'none')}
    </section>
    ${orphanSection}`;
        }
        return `
    <section class="dxgw-section">
      ${renderPostureBlock(stats, fallbackLevel, fallbackTarget)}
      <h4 class="subsection-title">Protection Coverage</h4>
      <p class="coverage-subtitle">Independent checks — each protects against a different failure mode.</p>
      <div class="coverage-section">${renderCoverageBlock(stats)}</div>
      <h4 class="subsection-title">How to Improve</h4>
      ${renderImprovementSteps(stats, fallbackLevel)}
    </section>
    ${orphanSection}`;
      })();

  return `<!DOCTYPE html>
<html lang="en" data-theme="${initialTheme}">
<head>
<meta charset="UTF-8">
<title>Network Resilience Review (Direct Connect)</title>
<style>
  :root, [data-theme="light"] {
    --bg: #ffffff;
    --card: #f8fafc;
    --border: #e2e8f0;
    --text: #0f172a;
    --muted: #64748b;
    --accent: #2563eb;
    --shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
  }
  [data-theme="dark"] {
    --bg: #0f172a;
    --card: #1e293b;
    --border: #334155;
    --text: #e2e8f0;
    --muted: #94a3b8;
    --accent: #60a5fa;
    --shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
  }
  * { box-sizing: border-box; }
  html, body { background: var(--bg); }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: var(--text); margin: 0; padding: 40px 24px; -webkit-font-smoothing: antialiased; transition: background-color 0.2s ease, color 0.2s ease; }
  .container { max-width: 960px; margin: 0 auto; }
  header.page-header { border-bottom: 1px solid var(--border); padding-bottom: 20px; margin-bottom: 28px; display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
  header.page-header .title-block { flex: 1; min-width: 0; }
  h1 { margin: 0 0 6px 0; font-size: 26px; letter-spacing: -0.01em; }
  h2 { margin: 36px 0 14px; font-size: 18px; letter-spacing: -0.01em; border-bottom: 1px solid var(--border); padding-bottom: 8px; }
  h3 { margin: 20px 0 10px; font-size: 14px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }
  h4 { margin: 0; font-size: 14px; }
  p { line-height: 1.55; color: var(--text); }
  code { background: var(--card); padding: 1px 6px; border-radius: 4px; font-size: 0.9em; }
  .meta { color: var(--muted); font-size: 12px; }
  /* Amber, matching the app's severity.warning. Inlined rather than imported
     from COLORS because this stylesheet ships inside a standalone HTML file with
     no access to the app's modules. */
  .incomplete-data {
    border: 1px solid #F59E0B;
    border-left-width: 4px;
    border-radius: 6px;
    padding: 12px 16px;
    margin: 20px 0 4px;
    background: rgba(245, 158, 11, 0.08);
  }
  .incomplete-data h2 { font-size: 15px; }
  .incomplete-data ul { margin: 8px 0; }
  .incomplete-data code { font-size: 12px; }
  /* Must survive printing to PDF, which is how this report usually reaches a
     customer — a background-only warning would vanish and the border is what
     carries it. Keep it off a page break too. */
  @media print { .incomplete-data { break-inside: avoid; } }
  .posture-card { border: 1px solid var(--border); border-radius: 10px; background: var(--card); box-shadow: var(--shadow); overflow: hidden; }
  .posture-flow { display: flex; align-items: stretch; gap: 0; flex-wrap: wrap; }
  .posture-block { flex: 1; min-width: 200px; padding: 16px 20px; position: relative; }
  .posture-block + .posture-block { border-left: 1px solid var(--border); }
  .posture-block .label { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600; margin-bottom: 10px; }
  .posture-block .tier-value { font-size: 17px; font-weight: 600; line-height: 1.3; margin-bottom: 6px; }
  .posture-block .sla-value { font-size: 12px; color: var(--muted); line-height: 1.5; }
  .posture-current { background: linear-gradient(135deg, var(--tier-tint) 0%, transparent 55%); }
  .posture-next .arrow { display: inline-block; color: var(--muted); margin-right: 6px; font-weight: 400; }
  .posture-option { position: relative; }
  .posture-option::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: var(--option-color); }
  .posture-option .arrow { display: inline-block; color: var(--muted); margin-right: 6px; font-weight: 400; }
  .posture-option .sla-value strong { font-weight: 600; }
  .posture-summary { margin: 0; padding: 12px 20px; border-top: 1px solid var(--border); background: var(--bg); color: var(--muted); font-size: 12px; line-height: 1.55; }
  .tier-badge { display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 11px; font-weight: 600; color: white; letter-spacing: 0.01em; }
  .findings-strip { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
  .finding-card { border: 1px solid var(--border); border-left: 3px solid var(--border); border-radius: 8px; padding: 14px 16px; background: var(--card); box-shadow: var(--shadow); display: flex; align-items: center; gap: 16px; text-decoration: none; color: inherit; transition: transform 0.1s ease, border-color 0.15s ease, box-shadow 0.15s ease; }
  a.finding-card.clickable { cursor: pointer; }
  a.finding-card.clickable:hover { transform: translateY(-1px); border-color: var(--accent); box-shadow: 0 2px 8px rgba(15, 23, 42, 0.08); }
  a.finding-card.clickable:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  :target.finding { animation: flash 1.2s ease-out; }
  @keyframes flash { 0% { background: var(--accent); background: color-mix(in srgb, var(--accent) 15%, var(--card)); } 100% { background: var(--card); } }
  /* A deep link lands the reader ON one matrix row among sixty near-identical ones.
     The row keeps a left rule after the flash decays, because the flash is over by
     the time a smooth scroll finishes on a long matrix. */
  tr:target > td { animation: flash-row 1.6s ease-out; }
  tr:target > td:first-child { box-shadow: inset 3px 0 0 var(--accent); }
  @keyframes flash-row { 0% { background: color-mix(in srgb, var(--accent) 18%, var(--card)); } 100% { background: transparent; } }
  html { scroll-behavior: smooth; scroll-padding-top: 16px; }
  .finding-card.f-critical { border-left-color: ${SEVERITY_COLOR.critical}; }
  .finding-card.f-warning  { border-left-color: ${SEVERITY_COLOR.warning}; }
  .finding-card.f-info     { border-left-color: ${SEVERITY_COLOR.info}; }
  .finding-card .count { font-size: 28px; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1; min-width: 32px; }
  .finding-card.f-critical .count { color: ${SEVERITY_COLOR.critical}; }
  .finding-card.f-warning  .count { color: ${SEVERITY_COLOR.warning}; }
  .finding-card.f-info     .count { color: ${SEVERITY_COLOR.info}; }
  .finding-card.zero .count { color: var(--muted); }
  .finding-card .caption { flex: 1; min-width: 0; }
  .finding-card .caption .name { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
  .finding-card .caption .hint { font-size: 11px; color: var(--muted); margin-top: 3px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 8px; }
  table th, table td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--border); }
  table th { background: var(--card); font-weight: 600; font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.03em; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  /* These two were scoped under table.dxgw-table, which was deleted — but the gateway
     posture card uses both, so the scoping left the SLA text and the "highest tier"
     note unstyled. Unscoped rather than re-nested: there is no outer table any more. */
  .table-sla { font-size: 11px; color: var(--muted); margin-top: 4px; }
  .table-muted { color: var(--muted); font-size: 12px; }
  .finding-id-link { text-decoration: none; }
  table.prefix-table td { vertical-align: top; }
  table.prefix-table .prefix-cell { line-height: 1.9; }
  .prefix-chip { display: inline-block; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; background: var(--card); border: 1px solid var(--border); border-radius: 4px; padding: 1px 6px; margin: 0 4px 2px 0; white-space: nowrap; }
  .prefix-chip .mark { margin-right: 4px; }
  .table-chip { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; margin: 1px 2px 1px 0; letter-spacing: 0.01em; }
  .table-chip.chip-ok { background: ${TIER_BADGE_COLOR.high}22; color: ${TIER_BADGE_COLOR.high}; border: 1px solid ${TIER_BADGE_COLOR.high}55; }
  .table-chip.chip-gap { background: ${SEVERITY_COLOR.warning}22; color: ${SEVERITY_COLOR.warning}; border: 1px solid ${SEVERITY_COLOR.warning}55; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  /* Location code + conn·dev pair. Monospaced and tabular so the numbers line up
     down the column even though the location codes in front of them differ in width. */
  .table-chip.link-chip { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .table-chip.link-chip strong { font-weight: 700; }
  /* Chips and badges are links now, and must not read as one: the format and colour
     carry the meaning, and blue underlined text in six columns would bury it. The
     affordance is the cursor plus a hover border, same as .finding-card. */
  a.table-chip, a.tier-badge { text-decoration: none; cursor: pointer; transition: filter 0.15s ease, box-shadow 0.15s ease; }
  a.table-chip:hover { box-shadow: 0 0 0 2px var(--accent); }
  a.tier-badge { color: white; }
  a.tier-badge:hover { filter: brightness(1.12); box-shadow: 0 0 0 2px var(--accent); }
  a.table-chip:focus-visible, a.tier-badge:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .gw-posture { margin-bottom: 6px; }
  .gw-posture-tiers { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
  .gw-posture-tiers .table-sla { font-size: 11px; color: var(--muted); }
  .gw-posture-tiers .table-muted { color: var(--muted); font-size: 12px; }
  .gw-posture-tiers .arrow { color: var(--muted); }
  .dxgw-section { border: 1px solid var(--border); border-radius: 10px; padding: 18px 20px; margin: 14px 0; background: var(--bg); }
  .dxgw-section + .dxgw-section { margin-top: 18px; }
  .dxgw-section-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 14px; padding-bottom: 10px; border-bottom: 1px solid var(--border); }
  .dxgw-section-title { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; min-width: 0; }
  .dxgw-chip { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, transparent); border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent); padding: 2px 8px; border-radius: 999px; }
  .dxgw-name { font-size: 15px; font-weight: 600; color: var(--text); }
  .dxgw-id { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; color: var(--muted); background: var(--card); padding: 1px 6px; border-radius: 4px; }
  .dxgw-section-meta { font-size: 12px; color: var(--muted); }
  /* The gateway card is a <details> now, so its head is a <summary>. It keeps the same
     flex layout, plus a caret and a clickable cursor. Both list-style:none AND the
     WebKit pseudo-element matter: Safari draws its own triangle from the second one. */
  summary.dxgw-section-head { cursor: pointer; list-style: none; }
  summary.dxgw-section-head::-webkit-details-marker { display: none; }
  summary.dxgw-section-head::before { content: '\\25B8'; color: var(--muted); font-size: 11px;
    margin-right: 2px; transition: transform 0.15s ease; align-self: center; }
  details.dxgw-section[open] > summary.dxgw-section-head::before { transform: rotate(90deg); }
  summary.dxgw-section-head:hover .dxgw-name { color: var(--accent); }
  summary.dxgw-section-head:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
  /* A closed card has to say what is inside it, or folding hides the reason to open. */
  .gw-sum-badge { font-size: 10.5px; font-weight: 600; border-radius: 999px; padding: 1px 8px;
    white-space: nowrap; }
  .gw-sum-crit { color: ${SEVERITY_COLOR.critical}; background: ${SEVERITY_COLOR.critical}22; }
  .gw-sum-warn { color: ${SEVERITY_COLOR.warning}; background: ${SEVERITY_COLOR.warning}22; }
  .gw-sum-ok { color: ${SEVERITY_COLOR.ok}; background: ${SEVERITY_COLOR.ok}1a; }
  /* A collapsed card must not keep the head's bottom rule — it reads as a cut-off table. */
  details.dxgw-section:not([open]) > summary.dxgw-section-head { margin-bottom: 0; padding-bottom: 0; border-bottom: none; }
  .subsection-title { font-size: 13px; font-weight: 600; color: var(--text); margin: 18px 0 6px; text-transform: uppercase; letter-spacing: 0.04em; }
  .coverage-section { margin: 10px 0 16px; }
  .coverage-subtitle { color: var(--muted); font-size: 13px; margin: 0 0 14px; line-height: 1.5; }
  .coverage-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 8px; }
  .coverage-card { display: flex; gap: 14px; align-items: flex-start; padding: 14px 16px; border: 1px solid var(--border); border-radius: 8px; background: var(--card); }
  .coverage-icon { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 50%; font-size: 14px; font-weight: 700; flex-shrink: 0; margin-top: 1px; }
  .coverage-card.covered .coverage-icon { background: ${TIER_BADGE_COLOR.high}22; color: ${TIER_BADGE_COLOR.high}; }
  .coverage-card.gap .coverage-icon { background: ${SEVERITY_COLOR.warning}22; color: ${SEVERITY_COLOR.warning}; border: 1.5px solid ${SEVERITY_COLOR.warning}50; }
  .coverage-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
  .coverage-title { font-size: 14px; font-weight: 600; }
  .coverage-card.covered .coverage-title { color: var(--text); }
  .coverage-card.gap .coverage-title { color: ${SEVERITY_COLOR.warning}; }
  .coverage-desc { font-size: 12px; color: var(--muted); line-height: 1.45; }
  .impact-h { margin: 26px 0 4px; font-size: 15px; }
  /* Same look as .impact-h, deliberately NOT the same class: the executive summary's
     impact block is located by a search for its class attribute, and this heading sits
     earlier in the document, so sharing the class resolves that lookup here instead. */
  .qv-coverage-h { margin: 26px 0 4px; font-size: 15px; }
  .impact-scope { border: 1px solid var(--border); border-radius: 10px; padding: 14px 18px 6px; margin: 12px 0; background: var(--bg); }
  .impact-scope-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 10px; padding-bottom: 10px; border-bottom: 1px solid var(--border); }
  .impact-scope-title { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; min-width: 0; }
  .impact-scope-meta { font-size: 12px; color: var(--muted); }
  ol.impact-drivers { list-style: none; margin: 0; padding: 0; }
  .impact-driver { padding: 12px 0 12px 14px; border-left: 3px solid var(--border); margin: 10px 0; }
  .impact-driver.i-impact { border-left-color: ${SEVERITY_COLOR.warning}; }
  .impact-driver.i-clear { border-left-color: ${TIER_BADGE_COLOR.high}; }
  .impact-driver.i-unknown { border-left-color: var(--border); }
  .impact-driver-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; }
  .impact-num { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; border-radius: 50%; background: var(--card); border: 1px solid var(--border); font-size: 11px; font-weight: 700; color: var(--muted); flex-shrink: 0; }
  .impact-driver-title { font-size: 13px; font-weight: 600; }
  .impact-status { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; padding: 2px 8px; border-radius: 999px; }
  .i-impact .impact-status { background: ${SEVERITY_COLOR.warning}22; color: ${SEVERITY_COLOR.warning}; border: 1px solid ${SEVERITY_COLOR.warning}55; }
  .i-clear .impact-status { background: ${TIER_BADGE_COLOR.high}22; color: ${TIER_BADGE_COLOR.high}; border: 1px solid ${TIER_BADGE_COLOR.high}55; }
  .i-unknown .impact-status { background: var(--card); color: var(--muted); border: 1px solid var(--border); }
  .impact-headline { margin: 5px 0 0; font-size: 12px; color: var(--muted); line-height: 1.5; }
  ul.impact-vifs { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  ul.impact-vifs > li { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.3fr); gap: 2px 14px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--card); font-size: 12px; align-items: baseline; }
  .impact-vif { font-weight: 600; }
  .impact-vif-meta { font-size: 11px; color: var(--muted); grid-column: 1; }
  .impact-why { grid-column: 2; grid-row: 1 / span 2; color: var(--text); line-height: 1.45; }
  .impact-note { margin: 8px 0 0; font-size: 11px; color: var(--muted); line-height: 1.5; }
  ol.steps { padding-left: 20px; }
  ol.steps li { margin-bottom: 8px; line-height: 1.55; }
  .finding { border: 1px solid var(--border); border-left: 4px solid var(--border); border-radius: 6px; padding: 12px 16px; margin-bottom: 10px; background: var(--card); }
  .finding.severity-critical { border-left-color: ${SEVERITY_COLOR.critical}; }
  .finding.severity-warning  { border-left-color: ${SEVERITY_COLOR.warning}; }
  .finding.severity-info     { border-left-color: ${SEVERITY_COLOR.info}; }
  .finding .finding-head { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
  .finding p { margin: 0; font-size: 13px; color: var(--muted); line-height: 1.5; }
  .severity-tag { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; padding: 2px 7px; border-radius: 4px; }
  .finding .finding-id { margin-left: auto; flex: none; font-size: 11px; color: var(--muted); }
  .empty { color: var(--muted); font-style: italic; font-size: 13px; }
  /* Remediation plan. Impact has four levels against severity's three, so it gets
     its own scale: the two vocabularies mean different things and sharing a palette
     would imply a mapping that does not exist. */
  .pri-chip { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 11px; font-weight: 600; letter-spacing: 0.01em; white-space: nowrap; }
  .pri-chip.imp-critical { background: ${SEVERITY_COLOR.critical}22; color: ${SEVERITY_COLOR.critical}; border: 1px solid ${SEVERITY_COLOR.critical}55; }
  .pri-chip.imp-high     { background: ${SEVERITY_COLOR.warning}22;  color: ${SEVERITY_COLOR.warning};  border: 1px solid ${SEVERITY_COLOR.warning}55; }
  .pri-chip.imp-medium   { background: ${SEVERITY_COLOR.info}22;     color: ${SEVERITY_COLOR.info};     border: 1px solid ${SEVERITY_COLOR.info}55; }
  .pri-chip.imp-low      { background: var(--card); color: var(--muted); border: 1px solid var(--border); }
  .pri-id { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; font-weight: 600; white-space: nowrap; color: var(--accent); text-decoration: none; }
  a.pri-id:hover { text-decoration: underline; }
  .plan-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; margin: 14px 0 8px; }
  .plan-card { border: 1px solid var(--border); border-top: 3px solid var(--border); border-radius: 10px; background: var(--card); box-shadow: var(--shadow); padding: 14px 16px; }
  .plan-card.risks { border-top-color: ${SEVERITY_COLOR.critical}; }
  .plan-card.wins { border-top-color: ${TIER_BADGE_COLOR.high}; }
  .plan-card-h { display: flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin-bottom: 10px; }
  .plan-n { display: inline-flex; align-items: center; justify-content: center; min-width: 20px; height: 20px; padding: 0 6px; border-radius: 10px; background: var(--bg); border: 1px solid var(--border); color: var(--text); font-size: 11px; font-variant-numeric: tabular-nums; }
  .plan-empty { margin: 0; font-size: 12px; color: var(--muted); line-height: 1.5; }
  ol.plan-list, ul.phase-list { margin: 0; padding: 0; list-style: none; }
  ol.plan-list > li, ul.phase-list > li { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; padding: 8px 0; border-top: 1px solid var(--border); }
  ol.plan-list > li:first-child, ul.phase-list > li:first-child { border-top: none; padding-top: 0; }
  .plan-title { font-size: 13px; line-height: 1.4; }
  .plan-sub { grid-column: 2; display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--muted); }
  .phase { margin: 18px 0; }
  h3.phase-h { display: flex; align-items: center; gap: 8px; margin: 0 0 4px; font-size: 13px; text-transform: none; letter-spacing: 0; color: var(--text); }
  .phase-blurb { margin: 0 0 8px; }
  ul.advisory-list > li { opacity: 0.8; }
  .bp-group-title { display: flex; align-items: center; gap: 8px; margin: 22px 0 10px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: none; padding: 0; color: var(--text); }
  .bp-group-title .bp-count { display: inline-flex; align-items: center; justify-content: center; min-width: 22px; height: 22px; padding: 0 7px; border-radius: 11px; font-size: 12px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .bp-group-applied { color: ${TIER_BADGE_COLOR.high}; }
  .bp-group-applied .bp-count { background: ${TIER_BADGE_COLOR.high}22; color: ${TIER_BADGE_COLOR.high}; }
  .bp-group-alert { color: ${SEVERITY_COLOR.critical}; }
  .bp-group-alert .bp-count { background: ${SEVERITY_COLOR.critical}22; color: ${SEVERITY_COLOR.critical}; }
  .bp-group-gap { color: ${SEVERITY_COLOR.warning}; }
  .bp-group-gap .bp-count { background: ${SEVERITY_COLOR.warning}22; color: ${SEVERITY_COLOR.warning}; }
  .bp-group-attest { color: var(--muted); }
  .bp-group-attest .bp-count { background: var(--card); color: var(--muted); border: 1px solid var(--border); }
  ul.bp-list { list-style: none; padding: 0; margin: 0 0 6px; }
  .bp-item { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; margin-bottom: 6px; border: 1px solid var(--border); border-left: 3px solid var(--border); border-radius: 6px; background: var(--card); font-size: 13px; }
  .bp-item-applied { border-left-color: ${TIER_BADGE_COLOR.high}; }
  .bp-item-alert { border-left-color: ${SEVERITY_COLOR.critical}; }
  .bp-item-gap { border-left-color: ${SEVERITY_COLOR.warning}; }
  .bp-item-attest { border-left-color: var(--border); }
  .bp-item .bp-icon { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; border-radius: 50%; font-size: 12px; font-weight: 700; flex-shrink: 0; margin-top: 1px; }
  .bp-item-applied .bp-icon { background: ${TIER_BADGE_COLOR.high}22; color: ${TIER_BADGE_COLOR.high}; }
  .bp-item-alert .bp-icon { background: ${SEVERITY_COLOR.critical}22; color: ${SEVERITY_COLOR.critical}; }
  .bp-item-gap .bp-icon { background: ${SEVERITY_COLOR.warning}22; color: ${SEVERITY_COLOR.warning}; }
  .bp-item-attest .bp-icon { background: var(--bg); color: var(--muted); border: 1px solid var(--border); }
  .bp-item .bp-body { display: flex; flex-direction: column; gap: 4px; min-width: 0; flex: 1; }
  .bp-item .bp-detail { color: var(--muted); font-size: 12px; line-height: 1.45; }
  .bp-evidence { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 2px; }
  .bp-evidence-chip { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; padding: 2px 7px; border-radius: 4px; background: ${TIER_BADGE_COLOR.high}14; color: ${TIER_BADGE_COLOR.high}; border: 1px solid ${TIER_BADGE_COLOR.high}40; }
  .region-chip { display: inline-block; padding: 2px 8px; border: 1px solid var(--border); border-radius: 4px; font-family: ui-monospace, monospace; font-size: 11px; margin-right: 4px; }
  footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid var(--border); font-size: 11px; color: var(--muted); }
  a { color: var(--accent); }

  .theme-toggle {
    display: inline-flex; align-items: center; gap: 6px;
    background: var(--card); border: 1px solid var(--border); color: var(--text);
    padding: 6px 10px; border-radius: 8px; cursor: pointer; font-size: 12px;
    font-family: inherit; transition: background 0.15s ease, border-color 0.15s ease;
    flex-shrink: 0;
  }
  .theme-toggle:hover { border-color: var(--accent); }
  .theme-toggle svg { width: 14px; height: 14px; }
  /* Index of gateway-scoped findings under each severity heading. Tighter than a
     finding card on purpose — it is a pointer, not a restatement. */
  table.gw-index { font-size: 12px; margin: 6px 0 18px; }
  table.gw-index td, table.gw-index th { padding: 5px 10px; }
  table.gw-index .finding-id { font-size: 10.5px; }
  .theme-toggle .icon-light, [data-theme="dark"] .theme-toggle .icon-dark { display: none; }
  [data-theme="dark"] .theme-toggle .icon-light { display: inline-block; }
  .theme-toggle .label-light, [data-theme="dark"] .theme-toggle .label-dark { display: none; }
  [data-theme="dark"] .theme-toggle .label-light { display: inline; }

  @media (max-width: 640px) {
    .findings-strip { grid-template-columns: 1fr; }
    .posture-block + .posture-block { border-left: none; border-top: 1px solid var(--border); }
  }

  /* Route analysis + utilization: chips, marks, and the data-source card. */
  .datasource { border: 1px solid var(--border); border-left: 3px solid var(--accent); border-radius: 8px; background: var(--card); padding: 12px 16px; margin: 12px 0 16px; font-size: 12px; color: var(--muted); line-height: 1.5; }
  .datasource dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 14px; margin: 0; }
  .datasource dt { font-weight: 600; color: var(--text); }
  .datasource dd { margin: 0; }
  .datasource strong { color: var(--text); }
  /* A resource ID is rendered verbatim: the surrounding h3 upper-cases its text,
     and "DXGW-002" is not the ID the console will accept. */
  .inline-id { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; color: var(--muted); text-transform: none; white-space: nowrap; }
  h3.scope-h { text-transform: none; letter-spacing: 0; font-size: 13px; color: var(--text); margin-top: 24px; }
  .sub { color: var(--muted); font-size: 11px; }
  .chip-pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; letter-spacing: 0.01em; border: 1px solid currentColor; white-space: nowrap; }
  .v-solo, .v-partial, .band-over, .hr-congest, .hr-nofit, .hr-none { color: ${SEVERITY_COLOR.critical}; }
  .v-covered, .band-elevated, .hr-tight { color: ${SEVERITY_COLOR.warning}; }
  .v-redundant, .band-normal, .hr-ample { color: ${TIER_BADGE_COLOR.high}; }
  .band-under { color: ${SEVERITY_COLOR.info}; }
  .band-unknown, .hr-unknown { color: var(--muted); }
  .route-verdict { border-radius: 8px; padding: 10px 14px; margin: 10px 0; font-size: 13px; line-height: 1.5; border: 1px solid currentColor; }
  .route-verdict strong { font-weight: 700; }
  .rv-bad { color: ${SEVERITY_COLOR.critical}; background: ${SEVERITY_COLOR.critical}12; }
  .rv-warn { color: ${SEVERITY_COLOR.warning}; background: ${SEVERITY_COLOR.warning}12; }
  .rv-ok { color: ${TIER_BADGE_COLOR.high}; background: ${TIER_BADGE_COLOR.high}12; }
  table.matrix td.cidr { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; white-space: nowrap; }
  table.matrix th.mcol, table.matrix td.mcol { text-align: center; width: 42px; }
  .mark { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-weight: 700; }
  /* All four marks share one font-size on purpose — do NOT add per-glyph optical
     scaling here. It was tried: measured ink boxes at 88px bold in this stack are
     &#9675; 53x54 and &#9651; 53x54 (the two agree natively), against &#10003; 41x42 and
     &#215; 44x44, so the tick and cross looked a touch smaller. Scaling those two up to
     match by font-size equalised the ink and broke everything else — font-size grows
     the whole glyph, so at 1.28em/1.23em the tick and cross rendered in a 9.25x18 box
     against the circle's 7.23x14, with proportionally heavier strokes, reading as
     BIGGER rather than equal. The residual difference is ordinary typography (a tick
     and a cross are drawn to about x-height, geometric shapes to cap height) and is
     consistent within each pair, which is what actually matters in a column. */
  .mark-exact { color: ${TIER_BADGE_COLOR.high}; }
  /* Full contrast, not amber: a prefix reachable via a less specific route is healthy
     and needs no change window, so it must not wear the colour of a real warning. Via
     var(--text) rather than a literal #fff, or it vanishes in the light theme. */
  .mark-covered { color: var(--text); }
  .mark-partial { color: ${SEVERITY_COLOR.critical}; }
  .mark-absent { color: var(--muted); }
  ul.legend { list-style: none; padding: 0; margin: 8px 0 4px; display: flex; flex-wrap: wrap; gap: 6px 18px; font-size: 12px; color: var(--muted); }
  ul.legend .col-n { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-weight: 700; color: var(--text); }
  /* AS paths sit on their own line under the VIF they belong to: a path can be several
     ASNs wide, and inline they pushed the VIF id off the end of the row. */
  /* rank(hops) in a matrix cell. Tabular so the ranks line up down a column even
     though the hop counts beside them differ in width, and the rank is what carries
     the weight — the reader scans for 1s, then reads the hop count. */
  .mrank { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-variant-numeric: tabular-nums; font-size: 11px; font-weight: 600;
    color: var(--muted); white-space: nowrap; }
  .mrank-best { color: ${SEVERITY_COLOR.ok}; }
  .mrank .mhops { font-weight: 400; opacity: 0.75; margin-left: 1px; }
  /* The worked example under the matrix. A list, not a sentence: the point is that four
     paths of two different lengths produce two ranks, and prose hides the pairing. */
  ul.rank-eg { list-style: none; padding: 0; margin: 4px 0 10px; font-size: 12px; color: var(--muted); }
  ul.rank-eg li { margin-bottom: 3px; }
  ul.rank-eg .col-n { display: inline-block; min-width: 1.6em; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-weight: 700; color: var(--text); }
  ul.rank-eg code { font-size: 11px; }
  ul.rank-eg .sub { margin-left: 6px; }
  /* Route tables appendix. Dense by design — it is reference, read one row at a time. */
  table.route-table { font-size: 11.5px; }
  table.route-table td, table.route-table th { padding: 4px 8px; }
  /* A fraction inside the warn band was rendered as plain text, so a gateway the
     exposure table called "at risk" showed an unremarkable 21/25 on its own card. */
  .quota-cell.quota-near { color: ${SEVERITY_COLOR.warning}; font-weight: 600; }
  .quota-cell.quota-over { color: ${SEVERITY_COLOR.critical}; font-weight: 600; }
  .quota-cell.quota-near .sub, .quota-cell.quota-over .sub { color: inherit; opacity: 0.8; }
  a.quota-link { text-decoration: none; }
  a.quota-link:hover .quota-cell { text-decoration: underline; }
  /* A resource name inside a finding, linked to the row that holds it. Dotted rather
     than a full underline: a description can name four VIFs and three prefixes, and
     seven blue underlines in one paragraph would read as a link farm. */
  a.fx-ref { color: inherit; text-decoration: none; border-bottom: 1px dotted var(--accent); }
  a.fx-ref:hover { color: var(--accent); border-bottom-style: solid; }
  a.fx-ref:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  table.route-table .as-path-cell { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; }
  /* Collapsible subsections of a gateway card. The marker is a rotating caret so a
     closed section reads as "there is more here" rather than as the end of the card. */
  details.gw-fold { margin: 0; }
  summary.gw-fold-s { cursor: pointer; list-style: none; display: flex; align-items: center; gap: 7px; }
  summary.gw-fold-s::-webkit-details-marker { display: none; }
  summary.gw-fold-s::before { content: '\\25B8'; color: var(--muted); font-size: 10px;
    transition: transform 0.15s ease; }
  details.gw-fold[open] > summary.gw-fold-s::before { transform: rotate(90deg); }
  summary.gw-fold-s:hover { color: var(--accent); }
  summary.gw-fold-s:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .gw-fold-n { font-size: 10.5px; font-weight: 600; color: ${SEVERITY_COLOR.warning};
    background: ${SEVERITY_COLOR.warning}22; border-radius: 999px; padding: 0 6px;
    font-variant-numeric: tabular-nums; }
  .gw-fold-b { padding-top: 2px; }
  /* A matrix cell links into the appendix row carrying its full AS path. Deliberately
     not styled as a link: the rank colour is the meaning, and blue underlines in four
     columns across forty rows would bury it. The affordance is the cursor and the
     hover, same as the exposure table's chips. */
  a.mcell-link { text-decoration: none; color: inherit; cursor: pointer; }
  a.mcell-link:hover .mrank, a.mcell-link:hover .mark { text-decoration: underline; }
  a.mcell-link:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  /* The reader arrives in a 400-row table, so the row has to say it is the one meant:
     the :target pseudo-class alone is too quiet against a dense monospace table. */
  table.route-table tr:target > td { background: ${SEVERITY_TINT.warning}; }
  table.route-table tr:target > td:first-child { box-shadow: inset 3px 0 0 ${SEVERITY_COLOR.warning}; }

  /* Opening compliance matrix: target x check-theme. */
  table.cmatrix { table-layout: fixed; }
  table.cmatrix th.rowhead { text-align: left; width: auto; min-width: 190px; font-weight: 600; vertical-align: middle; }
  table.cmatrix th.rowhead .sub { display: block; font-weight: 400; margin-top: 2px; }
  table.cmatrix th.rowhead a { color: var(--text); text-decoration: none; border-bottom: 1px solid var(--border); }
  table.cmatrix th.rowhead a:hover { border-bottom-color: var(--accent); }
  /* Abbreviated headers: the full name is in the tooltip and spelled out in the key
     below, so twelve columns fit without a sideways scroll on a laptop. */
  table.cmatrix th.ccol { width: 40px; text-align: center; padding: 8px 2px; }
  table.cmatrix th.ccol .ccol-l { font-size: 10px; letter-spacing: 0.02em; }
  table.cmatrix td.ccol { text-align: center; padding: 6px 2px; }
  table.cmatrix td.ccol a { text-decoration: none; }
  table.cmatrix tr.mrow-estate th.rowhead { font-style: italic; }
  .cm { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-weight: 700; font-size: 13px; display: inline-block; min-width: 18px; }
  .cm-critical { color: ${SEVERITY_COLOR.critical}; }
  .cm-warning { color: ${SEVERITY_COLOR.warning}; }
  .cm-info { color: ${SEVERITY_COLOR.info}; }
  .cm-ok { color: ${TIER_BADGE_COLOR.high}; }
  /* A cell nothing graded is deliberately the quietest thing in the table: it must
     not read as either a pass or a problem. */
  .cm-na { color: var(--border); }
  td.ccol a:hover .cm { text-decoration: underline; }
  details.cmatrix-key { margin: 4px 0 8px; font-size: 12px; color: var(--muted); }
  details.cmatrix-key summary { cursor: pointer; color: var(--text); font-weight: 600; }

  /* A folded reference block. The summary carries the section's own h3, so the
     heading has to sit inline with the marker and lose its own margins. */
  details.fold { margin: 8px 0 16px; }
  details.fold > summary.fold-s { cursor: pointer; display: flex; align-items: baseline; gap: 8px; }
  details.fold > summary.fold-s h3 { margin: 0; }
  details.fold > summary.fold-s:hover h3 { color: var(--accent); }
  .fold-n {
    font-size: 11px; font-weight: 600; color: var(--muted);
    border: 1px solid var(--border); border-radius: 999px; padding: 1px 7px;
  }
  /* "Show" / "Hide" beats a bare triangle: the fold holds the report's longest
     blocks, and a reader who does not notice the marker concludes they are gone. */
  details.fold > summary.fold-s::after { content: 'Show'; font-size: 11px; color: var(--accent); }
  details.fold[open] > summary.fold-s::after { content: 'Hide'; }
  .fold-b { padding-top: 8px; }
  .bp-body strong a { color: inherit; text-decoration: none; border-bottom: 1px solid var(--border); }
  .bp-body strong a:hover { border-bottom-color: var(--accent); }
  ul.col-key { list-style: none; padding: 0; margin: 8px 0 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 4px 20px; line-height: 1.5; }
  ul.col-key .col-n { display: inline-block; min-width: 2.4em; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-weight: 700; color: var(--text); }

  @media print {
    body { padding: 0; background: white; color: black; }
    .container { max-width: 100%; }
    .theme-toggle { display: none; }
    h2 { page-break-after: avoid; }
    .posture-card, .finding-card, .impact-driver { break-inside: avoid; }
    h2.appendix { page-break-before: always; }
    table.matrix { font-size: 11px; }
    table.cmatrix { break-inside: avoid; }
  }
${NAV_CSS}
</style>
</head>
<body>
${renderNav(SECTIONS, mask(topology.homeAccountId ?? ''), new Date().toISOString().slice(0, 10))}
${mask(`<div class="container">
  <header class="page-header">
    <div class="title-block">
      <h1>Network Resilience Review (Direct Connect)</h1>
      <div class="meta">Generated ${escapeHtml(when)}${topology.homeAccountId ? ` &middot; Account ${escapeHtml(topology.homeAccountId)}` : ''}${provRegion}${provRegions}${provChip}</div>
    </div>
    <button type="button" class="theme-toggle" id="theme-toggle" aria-label="Toggle theme">
      <svg class="icon-light" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="5"></circle>
        <line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line>
        <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
        <line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line>
        <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
      </svg>
      <svg class="icon-dark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
      </svg>
      <span class="label-light">Light</span>
      <span class="label-dark">Dark</span>
    </button>
  </header>
  ${renderIncompleteDataNoticeHtml(topology)}

  <h2 id="check-matrix">Resiliency exposure by Direct Connect gateway</h2>
  <p class="meta"><b>Rows</b> &mdash; each Direct Connect gateway, then the account total.
  <b>Cells</b> &mdash; affected count over population assessed; <code class="inline-id">&mdash;</code>
  means not assessed, not passed. Every figure links to its records.
  <b>Scope</b> &mdash; conditions that can interrupt traffic. Non-disruptive checks (MTU, BGP
  authentication, support tier, tagging, AWS Health history) are under Best practices.
  <b>Reference</b> &mdash; ${QUICKVIEW_DOC_LINE}</p>
  ${renderQuickView(quickView, gwNavIds, gwPrefixAnchors)}

  <h2 id="executive-summary">Executive summary</h2>
  ${renderFindingsStrip(findingCounts)}
  <div class="posture-card" style="padding: 16px 20px">
    ${renderExecutiveSummary(assessment, stats, findingCounts, { critical: allByCat.critical, warning: allByCat.warning })}
  </div>

  ${extraSections.map((s) => `<h2 id="${escapeHtml(s.id)}">${escapeHtml(s.title)}</h2>\n${s.html}`).join('\n')}

  <h2 id="per-dx-gateway">Per-DX Gateway assessment</h2>
  ${hasPerDxgw
    ? `<p class="meta">One card per gateway, and the only place its findings are stated &mdash; each
      names the connections and virtual interfaces it is about. Tiers and exposure counts for every
      gateway side by side are in
      <a href="#check-matrix">Resiliency exposure</a>. Reference:
      ${docLink(DOC.toolkit)} &middot;
      ${docLink(DOC.sla)}</p>
      ${routeDataNote()}`
    : `<p class="meta">Current tier and the gap to the target. No DX Gateways were detected, so a
      single combined view is shown. Reference:
      ${docLink(DOC.toolkit)} &middot;
      ${docLink(DOC.sla)}</p>`}
  ${perDxgwSections}

  <h2 id="findings">All findings by severity</h2>
  <p class="meta">Every finding in the account, at every severity. A finding scoped to one DX
  gateway is described in full on that gateway's card above, where the impacted resources are
  named, and appears here as a link rather than a second copy &mdash; the same wording twice is how
  two copies come to disagree. Findings that belong to no gateway (VPN, MTU, tagging, support tier,
  AWS Health, and anything scoped to a virtual private gateway, a public VIF or a LAG) are stated
  here in full, because nothing else states them. Best practices below covers the same rules,
  including those that passed.</p>
  <h3 id="findings-critical">Critical</h3>
  ${estateByCat.critical.length || gatewayIndexFor('critical')
    ? `${renderRecListHtml(estateByCat.critical, findingAnchors)}${gatewayIndexFor('critical')}`
    : '<p class="meta">None.</p>'}
  <h3 id="findings-warning">Warning</h3>
  ${estateByCat.warning.length || gatewayIndexFor('warning')
    ? `${renderRecListHtml(estateByCat.warning, findingAnchors)}${gatewayIndexFor('warning')}`
    : '<p class="meta">None.</p>'}
  ${estateByCat.info.length || gatewayIndexFor('info')
    ? fold(
        '<h3 id="findings-info">Informational</h3>',
        `${renderRecListHtml(estateByCat.info, findingAnchors)}${gatewayIndexFor('info')}`,
        findingCounts.info,
      )
    : '<h3 id="findings-info">Informational</h3><p class="meta">None.</p>'}

  <h2 id="best-practices">Best practices</h2>
  <p class="meta">Every check that ran, including the ones that passed &mdash; this is the coverage
  list. A linked title has a finding card under All findings; an unlinked one is described here
  because nothing else describes it. Location and device redundancy are graded above. Reference:
  ${docLink(DOC.toolkit)} &middot;
  ${docLink(DOC.maintenance)} &middot;
  ${docLink(DOC.quotas)}</p>

  ${(() => {
    const rows: BpRow[] = [];

    // 1. Live op-rule findings.
    for (const r of bpRecs) {
      if (OP_RULES_WITH_REF_EQUIVALENT.has(r.ruleId)) continue;
      let status: BpRowStatus;
      if (r.severity === 'critical' || r.severity === 'warning') status = 'alert';
      // An `-ok` attestation is a check AWS data confirmed, so it reads as applied
      // (✓) rather than as something the reader still has to go and verify (○).
      // Every `info` emission used to land in `verify`, which put "BGP prefix count
      // is well within the limit" on the reader's to-do list.
      else if (metaFor(r.ruleId)?.isPass) status = 'applied';
      else status = 'verify';
      rows.push({
        practice: r.title,
        status,
        detail: r.description,
        category: categoryFor(r.ruleId),
        // A rule that fired per gateway has its card under that gateway, not in the
        // estate-wide list, so the link has to resolve against BOTH sets of anchors.
        // Falling back to the estate key alone left every gateway-scoped best-practice
        // row unlinked, which reads as "nothing describes this" when four cards do.
        anchor: findingAnchors.get(`${r.ruleId}::${r.title}`) ?? firstGatewayAnchorFor(r),
      });
    }

    // 2. Reference items (minus the two tier items covered by §1).
    const pushRefRow = (items: ClassifiedItem[], status: BpRowStatus) => {
      for (const c of items) {
        if (TIER_REF_TITLES.has(c.item.title)) continue;
        rows.push({ practice: c.item.title, status, detail: c.item.detail, evidence: c.evidence, category: c.item.category });
      }
    };
    pushRefRow(classified.applied, 'applied');
    pushRefRow(classified.gap, 'gap');
    pushRefRow(classified.attest, 'verify');

    // Sort within each category: critical → warning → info/verify → applied
    const statusRank = (s: BpRowStatus) => s === 'alert' ? 0 : s === 'gap' ? 1 : s === 'verify' ? 2 : 3;
    rows.sort((a, b) => statusRank(a.status) - statusRank(b.status));

    const categories: Array<{ category: BpCategory; label: string }> = [
      { category: 'architecture', label: 'Architecture' },
      { category: 'configuration', label: 'Configuration' },
      { category: 'operations', label: 'Operations' },
    ];

    return categories.map((g) => {
      const groupRows = rows.filter((r) => r.category === g.category);
      if (groupRows.length === 0) return '';
      const body = `<ul class="bp-list">${groupRows.map((r) => {
            // '?' not &#9675;, freed for the route-diff marks where it means "covered by a
            // less specific route" — healthy. This row is the opposite kind of claim:
            // 'verify' is an attestation the report cannot confirm from any API field,
            // so a question mark states that directly rather than leaning on a shape.
            const icon = r.status === 'applied' ? '&#10003;'
              : r.status === 'alert' ? '!'
              : r.status === 'gap' ? '!'
              : '?';
            const cls = r.status === 'alert' ? 'bp-item-alert'
              : r.status === 'gap' ? 'bp-item-gap'
              : r.status === 'applied' ? 'bp-item-applied'
              : 'bp-item-attest';
            const evidenceHtml = r.evidence && r.evidence.length > 0
              ? `<div class="bp-evidence">${r.evidence.map((e) => `<code class="bp-evidence-chip">${escapeHtml(e)}</code>`).join('')}</div>`
              : '';
            // An applied row normally hides its boilerplate detail because the
            // evidence chips say more. A rule-derived pass has no chips — its detail
            // IS the evidence ("42 prefixes across 3 VIFs") — so it keeps it.
            // A row with a finding card shows neither: the card holds the same text
            // plus the AWS field behind it, and the title links straight to it.
            const showDetail = !r.anchor && (r.status !== 'applied' || !r.evidence?.length);
            const name = r.anchor
              ? `<a href="#${r.anchor}">${escapeHtml(r.practice)}</a>`
              : escapeHtml(r.practice);
            return `<li class="bp-item ${cls}">
              <span class="bp-icon" aria-hidden="true">${icon}</span>
              <div class="bp-body">
                <strong>${name}</strong>
                ${showDetail ? `<span class="bp-detail">${escapeHtml(r.detail)}</span>` : ''}
                ${evidenceHtml}
              </div>
            </li>`;
          }).join('')}</ul>`;
      // The chip counts OPEN items and takes its colour from the worst one, so a
      // group whose every check passed reads green with its pass count. It used to
      // be a hardcoded amber chip showing `groupRows.length` — total rows — which
      // said "3" in amber over three green ticks.
      const open = groupRows.filter((r) => r.status !== 'applied');
      const worst: BpRowStatus = open.some((r) => r.status === 'alert') ? 'alert'
        : open.some((r) => r.status === 'gap') ? 'gap'
        : open.length > 0 ? 'verify'
        : 'applied';
      const chipClass = worst === 'alert' ? 'bp-group-alert'
        : worst === 'gap' ? 'bp-group-gap'
        : worst === 'verify' ? 'bp-group-attest'
        : 'bp-group-applied';
      const count = worst === 'applied' ? groupRows.length : open.length;
      const countTitle = worst === 'applied'
        ? `${groupRows.length} check${groupRows.length === 1 ? '' : 's'}, all passing`
        : `${open.length} of ${groupRows.length} still open`;
      return `<h3 class="bp-group-title ${chipClass}">
        <span class="bp-count" title="${escapeHtml(countTitle)}">${count}</span> ${escapeHtml(g.label)}
      </h3>
      ${body}`;
    }).join('');
  })()}

  <h2 id="vif-utilization">VIF utilization</h2>
  ${renderUtilization(topology, prov)}

  <h2 class="appendix" id="route-tables">Route tables &middot; AS paths per VIF</h2>
  ${renderRouteTables(routeRows, routesMissingNote(), routeAnchors)}

  <h2 class="appendix" id="inventory">Inventory &middot; Topology Snapshot</h2>
  <p class="meta">Discovered from AWS APIs when this report was generated.</p>
  ${fold(`<h3>Resources and DX locations</h3>`, `
  <table>
    <thead><tr><th>Resource</th><th style="text-align:right">Count</th></tr></thead>
    <tbody>
      <tr><td>Direct Connect connections</td><td class="num">${stats.connectionCount}</td></tr>
      <tr><td>Virtual Interfaces (VIFs)</td><td class="num">${stats.vifCount}</td></tr>
      <tr><td>DX Gateways</td><td class="num">${stats.dxGatewayCount}</td></tr>
      <tr><td>Transit Gateways</td><td class="num">${stats.tgwCount}</td></tr>
      <tr><td>Virtual Private Gateways</td><td class="num">${stats.vgwCount}</td></tr>
      <tr><td>VPCs</td><td class="num">${stats.vpcCount}</td></tr>
      <tr><td>Site-to-Site VPN connections</td><td class="num">${stats.vpnCount}</td></tr>
    </tbody>
  </table>

  <h3>Direct Connect Locations (${stats.locationConns.size})</h3>
  <table>
    <thead><tr><th>Location</th><th style="text-align:right">AWS Logical Devices</th></tr></thead>
    <tbody>${locationRows}</tbody>
  </table>`)}

  <footer>
    Generated by the Network Resilience Agent. Verify SLA tiers and numbers against the
    <a href="https://docs.aws.amazon.com/directconnect/latest/UserGuide/" target="_blank" rel="noreferrer">AWS Direct Connect documentation</a>.
  </footer>
</div>`)}
<script>
  (function () {
    var KEY = 'dx-report-theme';
    var root = document.documentElement;
    var toggle = document.getElementById('theme-toggle');

    function apply(theme) {
      root.setAttribute('data-theme', theme);
      try { localStorage.setItem(KEY, theme); } catch (e) {}
    }

    var saved = null;
    try { saved = localStorage.getItem(KEY); } catch (e) {}
    var initial = root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    apply(saved || initial);

    if (toggle) {
      toggle.addEventListener('click', function () {
        var current = root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
        apply(current === 'dark' ? 'light' : 'dark');
      });
    }
  })();
</script>
<script>
  /* A figure in the impact table links into the section holding its records; this
     flashes the specific rows once the jump has landed. Matching is by substring on
     the row's text because the target tables key on resource ids that already
     appear in them, so no extra markup is needed on the receiving side. */
  (function () {
    function flash(ids) {
      var hit = 0;
      var rows = document.querySelectorAll('table tr, li, .vif-row, .posture-card');
      for (var i = 0; i < rows.length; i++) {
        var text = rows[i].textContent || '';
        for (var j = 0; j < ids.length; j++) {
          if (ids[j] && text.indexOf(ids[j]) !== -1) {
            rows[i].classList.remove('qv-flash');
            void rows[i].offsetWidth;
            rows[i].classList.add('qv-flash');
            hit++;
            break;
          }
        }
        if (hit > 60) break;
      }
    }
    var cells = document.querySelectorAll('a.qv-cell[data-focus]');
    for (var i = 0; i < cells.length; i++) {
      cells[i].addEventListener('click', function (e) {
        var ids = (e.currentTarget.getAttribute('data-focus') || '').split(/\\s+/);
        setTimeout(function () { flash(ids); }, 420);
      });
    }
  })();
</script>
<script>
  /* Folds hold the report's reference material, and two things have to reach inside
     one that is shut: a link from the summary tables, and the printer. A closed
     details element is not scrolled to and not laid out, so without this a figure
     that links to a folded finding lands nowhere and a PDF loses the appendix
     entirely. CSS cannot do either job: the UA hides the contents with
     content-visibility, which display and height overrides do not defeat. */
  (function () {
    function reveal(hash) {
      if (!hash || hash.length < 2) return;
      var el = document.getElementById(hash.slice(1));
      while (el) {
        if (el.tagName === 'DETAILS') el.open = true;
        el = el.parentElement;
      }
      // Re-aim the jump: the browser measured the position while it was collapsed.
      var target = document.getElementById(hash.slice(1));
      if (target) target.scrollIntoView();
    }
    window.addEventListener('hashchange', function () { reveal(location.hash); });
    if (location.hash) setTimeout(function () { reveal(location.hash); }, 0);
    // Delegated so it also covers links inside a fold that was opened later.
    document.addEventListener('click', function (e) {
      var a = e.target && e.target.closest ? e.target.closest('a[href^="#"]') : null;
      if (a) setTimeout(function () { reveal(a.getAttribute('href')); }, 0);
    });

    var forced = [];
    window.addEventListener('beforeprint', function () {
      forced = [];
      var all = document.querySelectorAll('details');
      for (var i = 0; i < all.length; i++) {
        if (!all[i].open) { all[i].open = true; forced.push(all[i]); }
      }
    });
    // Restore afterwards, or printing silently expands the document on screen too.
    window.addEventListener('afterprint', function () {
      for (var i = 0; i < forced.length; i++) forced[i].open = false;
      forced = [];
    });
  })();
</script>
<script>
${NAV_JS}
</script>
<script>
${FOLD_JS}
</script>
</body>
</html>`;
}

export function useExportReport() {
  return useCallback(async () => {
    let state = useTopologyStore.getState();
    if (!state.topologyData) return;

    const scenario = state.useMock ? state.mockScenario : null;
    const isLive = !!state.credentials && !state.useMock && !state.importedSnapshot;

    // The report is a document, so the two on-demand datasets are fetched FOR it
    // rather than assumed present. Without this the BGP route and utilization
    // sections read "not assessed" on every export by a user who never happened to
    // toggle Live Status — technically honest, and useless next to a skill-generated
    // report that fetches its own data. Both loaders soft-fail into
    // `vifRoutesError` / `utilizationError`, which the sections then quote, so a
    // denied permission still produces a report that says exactly what is missing.
    if (isLive) {
      const td = state.topologyData;
      const hasMetrics = !!(td.vifUtilization?.size || td.connectionUtilization?.size)
        || state.utilizationCache.size > 0;
      const hasRoutes = !!(td.vifRoutes?.size) || !!state.vifRoutesCache;
      const hasStability = !!(td.bgpStability?.size) || !!state.bgpStabilityCache;
      // Sequential, not parallel: both write `topologyData` through
      // `set({ topologyData: { ...latest } })`, so concurrent completions race and
      // the loser's map is dropped from the object the winner spread.
      if (!hasMetrics) {
        try {
          await state.loadUtilization(state.utilizationWindowDays);
        } catch (err) {
          console.warn('Report export: utilization fetch failed', err);
        }
        state = useTopologyStore.getState();
      }
      if (!hasRoutes) {
        try {
          await state.loadVifRoutes();
        } catch (err) {
          console.warn('Report export: BGP route fetch failed', err);
        }
        state = useTopologyStore.getState();
      }
      // BGP flap history, for the "Last down" column on every VIF and per gateway.
      // Unlike the two above, this one is BILLED — GetMetricData charges per metric
      // retrieved — so it is worth being explicit that the report opts in: without it
      // the column reads "not fetched" on every row of every export, which is exactly
      // the useless-but-honest state the route and utilization fetches exist to avoid.
      // The volume is one ListMetrics sweep plus one GetMetricData per region, over the
      // account's VIFs, once per report.
      if (!hasStability) {
        try {
          await state.loadBgpStability();
        } catch (err) {
          console.warn('Report export: BGP stability fetch failed', err);
        }
        state = useTopologyStore.getState();
      }
    }

    const td = state.topologyData;
    if (!td) return;

    // Hydrate from the store caches the same way snapshot export does: the user may
    // have fetched a window or the routes at some point without them being stamped
    // onto the current topology object.
    const activeWindow = state.utilizationWindowDays;
    const cached = state.utilizationCache.get(activeWindow);
    const topology: TopologyData = {
      ...td,
      vifUtilization: td.vifUtilization ?? cached?.vif,
      connectionUtilization: td.connectionUtilization ?? cached?.connection,
      utilizationWindowDays: td.utilizationWindowDays ?? (cached ? activeWindow : undefined),
      vifRoutes: td.vifRoutes ?? state.vifRoutesCache ?? undefined,
      bgpStability: td.bgpStability ?? state.bgpStabilityCache ?? undefined,
    };

    // Re-analyzed against the topology that is actually going into the file. The
    // store's assessment was computed before the fetches above, so route-backed
    // rules would otherwise report on data the same document contradicts.
    const assessment = analyzeTopology(topology, state.resiliencyTargets);

    // Where the data came from has to travel with the report. A demo export that
    // looks like a live audit is exactly the failure the no-fabrication rule guards
    // against, and `credentials` is null in both mock and imported-snapshot mode —
    // so the region is genuinely unknown there rather than defaultable.
    const provenance: Provenance = {
      kind: scenario ? 'mock' : state.importedSnapshot ? 'imported' : 'live',
      scenario,
      primaryRegion: state.credentials?.region ?? null,
      redacted: state.redactMode,
      // An imported snapshot's CloudWatch window ended when it was exported, not
      // today — dating it to "now" would move a 30-day window off the data.
      dataAsOf: state.importedSnapshot?.exportedAt ?? null,
      routesError: state.vifRoutesError,
      utilizationError: state.utilizationError,
      fetchedForReport: isLive,
    };
    const html = buildHtmlReport(topology, assessment, scenario, state.theme, provenance);
    const account = topology.homeAccountId || 'unknown-account';
    const day = new Date().toISOString().slice(0, 10);
    download(html, `dx-resilience-report-${account}-${day}.html`, 'text/html;charset=utf-8');
  }, []);
}
