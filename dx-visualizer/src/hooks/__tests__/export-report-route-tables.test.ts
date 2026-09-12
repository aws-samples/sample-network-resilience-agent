import { describe, it, expect } from 'vitest';
import { buildHtmlReport } from '../useExportReport';
import { analyzeTopology } from '../../engine/recommendation-engine';
import { getMockTopology } from '../../utils/mock-data';
import type { MockScenario } from '../../utils/shared';

/**
 * The route-table appendix: every prefix on every VIF, both directions, with the AS
 * path it arrived by.
 *
 * At the end of the report because it is reference, not analysis — nobody opens the
 * report to read 900 prefixes, but the operator reconciling one against a router needs
 * every row. Folded shut for the same reason, and capped per direction with the omitted
 * count stated rather than silently truncated.
 *
 * The CSV and XLSX downloads this file also covered were removed; the appendix is the
 * in-document form and stands on its own.
 */

const SCENARIOS: MockScenario[] = ['noResiliency', 'devTest', 'high', 'maximum', 'crossAccount'];

const render = (scenario: MockScenario) => {
  const t = getMockTopology(scenario);
  return buildHtmlReport(t, analyzeTopology(t), scenario, 'light');
};

const appendix = (html: string) => {
  const start = html.indexOf('id="route-tables"');
  expect(start, 'route tables appendix is missing').toBeGreaterThan(-1);
  return html.slice(start, html.indexOf('id="inventory"', start));
};

describe('route tables appendix', () => {
  it.each(SCENARIOS)('sits at the end, after the analysis (%s)', (scenario) => {
    const html = render(scenario);
    // Reference, not analysis: nobody opens the report to read 900 prefixes.
    expect(html.indexOf('id="vif-utilization"')).toBeLessThan(html.indexOf('id="route-tables"'));
    expect(html.indexOf('id="route-tables"')).toBeLessThan(html.indexOf('id="inventory"'));
    expect(html).toContain('href="#route-tables"');
  });

  it('gives received and advertised prefixes a table each, folded', () => {
    const section = appendix(render('high'));
    expect(section).toContain('<h3>Received routes</h3>');
    expect(section).toContain('<h3>Advertised routes</h3>');
    // Folded, because the point is that it is long.
    expect(section).toContain('class="fold"');
    for (const col of ['Virtual interface', 'Prefix', 'Family', 'AS path', 'Hops']) {
      expect(section).toContain(`>${col}</th>`);
    }
  });

  it('prints the AS path for every prefix, per VIF', () => {
    const section = appendix(render('high'));
    const rows = [...section.matchAll(/<td class="as-path-cell">([^<]*)</g)].map((m) => m[1]);
    expect(rows.length).toBeGreaterThan(0);
    // Real ASNs, or `direct` for an empty path — never blank, which reads as missing.
    for (const p of rows) expect(p).toMatch(/^(\d+( \d+)*|direct)$/);
  });

  it('says why it is empty rather than rendering nothing', () => {
    const base = getMockTopology('high');
    const { vifRoutes: _drop, ...without } = base;
    const html = buildHtmlReport(without as typeof base, analyzeTopology(without as typeof base), 'high', 'light');
    const section = appendix(html);
    expect(section).toContain('demo scenario carries no route data');
    expect(section).not.toContain('<h3>Received routes</h3>');
  });

  // The report masks its body in ONE `redact()` pass, and `redact()` only masks a
  // LABELLED ASN (`ASN: 65000`). A bare AS path here would ship in the clear in the
  // export a customer actually receives.
  it('masks every ASN when the report is redacted', () => {
    const t = getMockTopology('high');
    const html = buildHtmlReport(t, analyzeTopology(t), null, 'light', {
      kind: 'live', scenario: null, primaryRegion: 'ap-southeast-1', redacted: true,
    });
    const rows = [...appendix(html).matchAll(/<td class="as-path-cell">([^<]*)</g)].map((m) => m[1]);
    expect(rows.length).toBeGreaterThan(0);
    for (const p of rows) {
      expect(p, 'a raw ASN survived redaction').not.toMatch(/\d/);
    }
  });
});

/**
 * The link from a `1(3)` in a route-diff matrix to the appendix row that proves it.
 *
 * The rank and hop count are a summary; "which ASNs" is the reader's next question, and
 * it is 400 rows away. The pairing test is the one that matters — a link that resolves
 * to *some* row looks perfectly healthy while pointing at the wrong prefix.
 */
describe('matrix cell links into the route tables', () => {
  const ids = (html: string) => new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));

  /** Column letter → VIF ID, from the matrix legend. */
  const columnVifs = (html: string) => {
    const legend = html.match(/<ul class="legend">[\s\S]*?<\/ul>/)?.[0] ?? '';
    const out = new Map<string, string>();
    for (const li of legend.match(/<li>[\s\S]*?<\/li>/g) ?? []) {
      const letter = li.match(/class="col-n">([A-Z]+)</)?.[1];
      const vifId = li.match(/class="inline-id">(dxvif-[^<]+)</)?.[1];
      if (letter && vifId) out.set(letter, vifId);
    }
    return out;
  };

  /** The appendix row an `rr-` anchor identifies, as { vifId, prefix }. */
  const rowsByAnchor = (html: string) => {
    const out = new Map<string, { vifId: string; prefix: string }>();
    for (const m of html.matchAll(/<tr id="(rr-\d+)">([\s\S]*?)<\/tr>/g)) {
      const tds = [...m[2].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)]
        .map((t) => t[1].replace(/<[^>]+>/g, ''));
      out.set(m[1], { vifId: tds[1], prefix: tds[5] });
    }
    return out;
  };

  it.each(SCENARIOS)('never links to an anchor the report did not emit (%s)', (scenario) => {
    const html = render(scenario);
    const emitted = ids(html);
    const links = [...html.matchAll(/class="mcell-link" href="#([^"]+)"/g)].map((m) => m[1]);
    expect(links.filter((l) => !emitted.has(l))).toEqual([]);
  });

  it('links each cell to the row for THAT VIF and THAT prefix', () => {
    const html = render('high');
    const cols = columnVifs(html);
    const rows = rowsByAnchor(html);
    expect(cols.size).toBeGreaterThan(1);
    expect(rows.size).toBeGreaterThan(0);

    const matrix = html.match(/<table class="matrix">[\s\S]*?<\/table>/)?.[0] ?? '';
    const letters = [...matrix.matchAll(/<th class="mcol"[^>]*>([A-Z]+)<\/th>/g)].map((m) => m[1]);
    let checked = 0;
    for (const tr of matrix.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) ?? []) {
      const prefix = tr.match(/class="cidr">([^<\s]+)/)?.[1];
      if (!prefix) continue;
      const cells = [...tr.matchAll(/<td class="mcol">([\s\S]*?)<\/td>/g)].map((m) => m[1]);
      cells.forEach((cellHtml, i) => {
        const anchor = cellHtml.match(/href="#(rr-\d+)"/)?.[1];
        if (!anchor) return;
        const target = rows.get(anchor);
        expect(target, `${anchor} has no row`).toBeTruthy();
        expect(target!.prefix).toBe(prefix);
        expect(target!.vifId).toBe(cols.get(letters[i]));
        checked += 1;
      });
    }
    expect(checked, 'no linked cells were checked').toBeGreaterThan(10);
  });

  it('links only the cells where the VIF actually received the prefix', () => {
    const matrix = render('high').match(/<table class="matrix">[\s\S]*?<\/table>/)?.[0] ?? '';
    const cells = [...matrix.matchAll(/<td class="mcol">([\s\S]*?)<\/td>/g)].map((m) => m[1]);
    const linked = cells.filter((c) => c.includes('mcell-link'));
    expect(linked.length).toBeGreaterThan(0);
    // A covered / partial / absent cell has no received row for that prefix on that
    // VIF, so linking it would send the reader to a row that says something else.
    for (const c of cells) {
      const isExact = c.includes('mark-exact') || c.includes('class="mrank');
      expect(c.includes('mcell-link'), c.slice(0, 90)).toBe(isExact);
    }
  });

  it('survives redaction, where a prefix-derived anchor would not', () => {
    // `redact()` masks a CIDR and a dxvif-<hex> inside `id=` and `href=` too, so an
    // anchor built from either decays to bullets and resolves to nothing — in the one
    // export a customer actually receives.
    const t = getMockTopology('high');
    const html = buildHtmlReport(t, analyzeTopology(t), null, 'light', {
      kind: 'live', scenario: null, primaryRegion: 'ap-southeast-1', redacted: true,
    });
    const emitted = ids(html);
    const links = [...html.matchAll(/class="mcell-link" href="#([^"]+)"/g)].map((m) => m[1]);
    expect(links.length).toBeGreaterThan(0);
    expect(links.filter((l) => !emitted.has(l))).toEqual([]);
    expect(links.filter((l) => l.includes('\u2022'))).toEqual([]);
  });

  it('opens the folded appendix a link lands inside', () => {
    // The tables are collapsed, and a browser cannot scroll to a target inside a closed
    // <details>. Not every browser auto-expands, and the failure is silent.
    const html = render('high');
    expect(html).toContain("p.tagName === 'DETAILS'");
    expect(html).toContain("addEventListener('hashchange'");
  });
});
