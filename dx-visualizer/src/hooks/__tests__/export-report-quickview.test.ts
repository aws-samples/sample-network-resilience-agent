import { describe, it, expect } from 'vitest';
import { buildHtmlReport } from '../useExportReport';
import { analyzeTopology } from '../../engine/recommendation-engine';
import { getMockTopology } from '../../utils/mock-data';
import { QUICKVIEW_COLUMNS } from '../../engine/report-quickview';
import type { MockScenario } from '../../utils/shared';

const SCENARIOS: MockScenario[] = ['noResiliency', 'devTest', 'high', 'maximum', 'crossAccount'];

function render(scenario: MockScenario, provenance?: Parameters<typeof buildHtmlReport>[4]) {
  const topology = getMockTopology(scenario);
  return buildHtmlReport(topology, analyzeTopology(topology), scenario, 'light', provenance);
}

/** The quick-view table only — asserting on the whole report would catch other sections' links. */
const quickView = (html: string) => {
  const table = html.match(/<div class="qv-wrap">[\s\S]*?<\/table>/)?.[0];
  expect(table, 'quick-view table is missing from the report').toBeTruthy();
  return table as string;
};

/**
 * Deep string rewrite that preserves the containers `TopologyData` uses. A
 * `JSON.parse(JSON.stringify(...))` round-trip turns `vifRoutes` / `vifUtilization`
 * from `Map` into a plain object, and the rules then call `.get()` on it.
 */
function deepRewrite<T>(value: T, f: (s: string) => string): T {
  if (typeof value === 'string') return f(value) as T;
  if (value instanceof Map) {
    return new Map([...value].map(([k, v]) => [deepRewrite(k, f), deepRewrite(v, f)])) as T;
  }
  if (value instanceof Set) return new Set([...value].map((v) => deepRewrite(v, f))) as T;
  if (Array.isArray(value)) return value.map((v) => deepRewrite(v, f)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, deepRewrite(v, f)]),
    ) as T;
  }
  return value;
}

const idsIn = (html: string) => new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const hrefsIn = (frag: string) => [...frag.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
const rowKinds = (t: string) => [...t.matchAll(/<tr class="qv-([a-z]+)"/g)].map((m) => m[1]);

/** The rendered `conn·dev` chips, as `LOC value class`, in document order. */
const linkChips = (frag: string): string[] =>
  [...frag.matchAll(
    /<span class="table-chip link-chip (chip-[a-z]+)"[^>]*>([^<]*)<strong>([^<]*)<\/strong>/g,
  )].map((m) => `${m[2].trim()} ${m[3]} ${m[1]}`);

describe('export report quick view', () => {
  // The table's entire purpose is "each click can navigate to related information".
  // A figure that links nowhere real is worse than a figure with no link: the reader
  // clicks, the page does not move, and they conclude the number is not backed by
  // anything.
  it.each(SCENARIOS)('every cell link resolves to a real anchor (%s)', (scenario) => {
    const html = render(scenario);
    const hrefs = hrefsIn(quickView(html));
    expect(hrefs.length).toBeGreaterThan(0);
    expect(hrefs.filter((h) => !idsIn(html).has(h))).toEqual([]);
  });

  it.each(SCENARIOS)('rows are one per gateway then a single account total, last (%s)', (scenario) => {
    const kinds = rowKinds(quickView(render(scenario)));
    expect(kinds.filter((k) => k === 'total')).toHaveLength(1);
    expect(kinds[kinds.length - 1]).toBe('total');
    // Every gateway the report assessed needs a row, or the table understates the estate.
    expect(kinds.filter((k) => k === 'dxgw').length).toBeGreaterThan(0);
  });

  it('names each gateway in the left column and links it to its own section', () => {
    const html = render('devTest');
    const table = quickView(html);
    expect(table).toContain('>DX-Gateway-Dubai-to-SG</a>');
    expect(table).toContain('>DX-Gateway-Dubai-Staging</a>');
    // Ordinal nav ids, not `dxgw-<hex>`: see the redaction test below for why.
    expect(hrefsIn(table)).toContain('gw1');
    expect(hrefsIn(table)).toContain('gw2');
  });

  it('renders one column per declared theme, plus the gateway name column', () => {
    const table = quickView(render('devTest'));
    const head = table.match(/<thead>[\s\S]*?<\/thead>/)?.[0] ?? '';
    // Scoped to <thead>: body rows open with a `<th class="qv-rowhead">` too, so
    // counting over the whole table would grow with the number of gateways.
    const headers = [...head.matchAll(/<th\b/g)].length;
    // +1 for the row-head column that names the gateway.
    expect(headers).toBe(QUICKVIEW_COLUMNS.length + 1);
    for (const c of QUICKVIEW_COLUMNS) expect(table).toContain(c.label);
  });

  // A count is only actionable if the reader can reach the records behind it. The
  // prefix column deep-links to the worst-first matrix's TOP row, because the next
  // question after "7 of 27" is *which* prefix, and the section heading does not
  // answer it.
  it('deep-links the solo-prefix count to the first flagged prefix row', () => {
    const html = render('devTest');
    const table = quickView(html);
    const deep = [...table.matchAll(/href="#(rt-gw\d+-p\d+)"/g)].map((m) => m[1]);
    expect(deep.length).toBeGreaterThan(0);
    for (const id of deep) expect(idsIn(html).has(id)).toBe(true);
  });

  // A gateway with nothing to link must still say so, rather than rendering an
  // empty cell that reads as a broken table.
  it('marks a not-assessed cell rather than leaving it blank', () => {
    const table = quickView(render('noResiliency'));
    expect(table).toContain('qv-na');
    expect(table).not.toMatch(/<td[^>]*>\s*<\/td>/);
  });

  // Redact mode masks `dxgw-<hex>` wherever it appears, INCLUDING inside `id=` and
  // `href=`. Anchors are therefore ordinal by construction; if anyone switches them
  // back to resource ids, every link in this table breaks only in the redacted
  // export — the one a customer receives.
  it('keeps every link working when the report is redacted', () => {
    // Mock ids are deliberately not hex, so redact() would not touch them and the
    // assertion would prove nothing. Give them real-looking hex first.
    const hexed = deepRewrite(getMockTopology('high'), (v) =>
      v.replace(/\b(dxgw|dxcon|dxvif|tgw|vgw)-[0-9a-z]+/g, (_m, p: string) => `${p}-a1b2c3d4`),
    );
    const html = buildHtmlReport(hexed, analyzeTopology(hexed), null, 'light', {
      kind: 'live',
      scenario: null,
      primaryRegion: 'ap-southeast-1',
      redacted: true,
    });
    // Guard first: if masking did not actually run, everything below passes
    // vacuously and the test proves nothing.
    expect(html).toContain('dxgw-\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022');
    const table = quickView(html);
    const hrefs = hrefsIn(table);
    expect(hrefs.length).toBeGreaterThan(0);
    expect(hrefs.filter((h) => !idsIn(html).has(h))).toEqual([]);
    // No anchor may contain the mask bullet: that is what a resource-id anchor
    // would decay to, and it would resolve to nothing.
    expect(hrefs.filter((h) => h.includes('\u2022'))).toEqual([]);
  });

  it('sits above the per-gateway assessment it links into', () => {
    const html = render('devTest');
    expect(html.indexOf('<div class="qv-wrap">')).toBeLessThan(
      html.indexOf('id="per-dx-gateway"'),
    );
  });

  /**
   * Legibility, not decoration. `td.qv-na .qv-fig` used `var(--border)` — a BORDER
   * colour as text — which put #334155 on a near-black card at roughly 1.5:1, so every
   * `2 / 2` and every em-dash was effectively invisible.
   */
  describe('figure legibility', () => {
    it('never colours a figure with the border variable', () => {
      const html = render('high');
      const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
      expect(css).toContain('td.qv-na .qv-fig { color: var(--muted)');
      // The regression, stated as the thing that must not come back.
      expect(css).not.toMatch(/\.qv-fig \{ color: var\(--border\)/);
    });

    it('treats the scale column as a population rather than an unmeasured cell', () => {
      // `2 / 2` is the denominator every column to its right is counted over. It only
      // ever carried the `na` tint because it has no severity of its own.
      const table = quickView(render('high'));
      const scale = [...table.matchAll(/<td class="([^"]*qv-scale[^"]*)">[\s\S]*?qv-fig">([^<]*)</g)];
      expect(scale.length).toBeGreaterThan(0);
      for (const [, cls, fig] of scale) {
        expect(cls).toContain('qv-scale');
        expect(fig).toMatch(/^\d+ \/ \d+$/);
      }
      const css = render('high').slice(0, render('high').indexOf('</style>'));
      expect(css).toContain('td.qv-scale .qv-fig { color: var(--text)');
    });
  });

  // The `conn·dev` chips folded in from the per-gateway assessment table. The counting
  // rules and the weakest-first order are covered against `buildQuickView` in
  // `engine/__tests__/report-quickview.test.ts`; what is guarded here is the markup.
  describe('per-location link chips', () => {
    it('renders one chip per DX location in the locations column, weakest first', () => {
      const chips = linkChips(quickView(render('crossAccount')));
      expect(chips).toContain('EqTY2 1·1 chip-gap');
      expect(chips).toContain('EqSG2 2·2 chip-ok');
      expect(chips.indexOf('EqTY2 1·1 chip-gap')).toBeLessThan(chips.indexOf('EqSG2 2·2 chip-ok'));
    });

    it('spells each chip out in a tooltip rather than leaving four characters to carry it', () => {
      expect(quickView(render('high'))).toContain(
        'EqSG2: 2 connections on 1 AWS logical device — a device outage cuts this location entirely',
      );
    });

    // The cell is already ONE `a.qv-cell`. A nested anchor is invalid HTML: the browser
    // closes the outer one at the inner open tag, so everything after the first chip
    // stops being a link and the figure above it silently loses its target.
    it('renders the chips as spans inside the existing cell link, never as anchors', () => {
      const table = quickView(render('crossAccount'));
      expect(table).not.toMatch(/<a[^>]*class="[^"]*link-chip/);
      expect(table).toMatch(/<a class="qv-cell"[^>]*><span class="qv-fig">[^<]*<\/span><span class="qv-chips">/);
    });

    it('drops the plain site list the chips replaced, so the cell states it once', () => {
      const table = quickView(render('crossAccount'));
      expect(linkChips(table).length).toBeGreaterThan(0);
      expect(table).not.toContain('EqSG2, EqTY2');
    });

    it('carries chips on the account-total row too, not just the gateway rows', () => {
      const table = quickView(render('high'));
      const total = table.slice(table.lastIndexOf('<tr class="qv-total"'));
      expect(linkChips(total)).toContain('EqSG2 4·1 chip-gap');
    });

    it('leaves a gateway with no connections saying so, with no chips', () => {
      // `maximum` carries an unattached second gateway. An empty cell there would read
      // as a broken table; a chip would invent a site it has no link at.
      const rows = quickView(render('maximum')).split('<tr class="qv-').slice(1);
      const empty = rows.filter((r) => r.includes('no connections'));
      expect(empty, 'maximum should carry an unattached gateway').toHaveLength(1);
      expect(linkChips(empty[0])).toEqual([]);
      // …while the gateway that does have links still gets them.
      expect(linkChips(rows.find((r) => !r.includes('no connections')) ?? '').length)
        .toBeGreaterThan(0);
    });
  });
});
