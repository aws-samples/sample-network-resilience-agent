import { describe, it, expect } from 'vitest';
import { buildHtmlReport } from '../useExportReport';
import { analyzeTopology } from '../../engine/recommendation-engine';
import { getMockTopology } from '../../utils/mock-data';
import type { MockScenario } from '../../utils/shared';

/**
 * The per-gateway cards, which are now the ONLY per-gateway prose in the report.
 *
 * There used to be a side-by-side summary table above them carrying a tier badge, a
 * target badge, protection-coverage chips and a next-step line per gateway — every one
 * of which was also stated inside the card below it. Two copies of the same verdict in
 * one document is how the two came to word the same gap differently, so the table was
 * deleted and each fact given exactly one home: the tier pair is in the exposure
 * table's row head (`export-report-quickview.test.ts`), and coverage plus next step are
 * in the card's posture block.
 *
 * What is guarded here is that none of it came back, and that the card still carries
 * everything the table used to.
 */

const SCENARIOS: MockScenario[] = ['noResiliency', 'devTest', 'high', 'maximum', 'crossAccount'];

function render(scenario: MockScenario) {
  const topology = getMockTopology(scenario);
  return buildHtmlReport(topology, analyzeTopology(topology), scenario, 'light');
}

/** The per-gateway band only, so a match elsewhere in the document proves nothing. */
function gatewaySection(html: string): string {
  const start = html.indexOf('id="per-dx-gateway"');
  expect(start).toBeGreaterThan(-1);
  const end = html.indexOf('id="findings"', start);
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}

describe('per-gateway cards', () => {
  it.each(SCENARIOS)('renders one card per assessed gateway (%s)', (scenario) => {
    const section = gatewaySection(render(scenario));
    const gwCount = analyzeTopology(getMockTopology(scenario)).perDxGateway.length;
    const cards = [...section.matchAll(/<summary class="dxgw-section-head" id="gw\d+">/g)];
    expect(cards).toHaveLength(gwCount);
  });

  it.each(SCENARIOS)('no longer prints a side-by-side summary table or its reading guide (%s)', (scenario) => {
    const html = render(scenario);
    expect(html).not.toContain('<table class="dxgw-table">');
    expect(html).not.toContain('class="how-to-read"');
    expect(html).not.toContain('Links by location');
    // The band row that used to head the table must not survive as a dead nav link.
    expect(html).not.toContain('per-dx-gateway-assessment');
  });

  it.each(SCENARIOS)('states protection coverage inside the card, linked to that card\'s findings (%s)', (scenario) => {
    const section = gatewaySection(render(scenario));
    expect(section).toContain('Protection coverage');
    // Either every check passes, or each gap is a chip that opens this gateway's own
    // findings — never a chip pointing at an estate-wide list.
    expect(section).toMatch(/&#10003; Fully covered|class="table-chip chip-gap" href="#gw\d+-findings"/);
  });

  it.each(SCENARIOS)('keeps the next step beside the posture it is derived from (%s)', (scenario) => {
    expect(gatewaySection(render(scenario))).toContain('<strong>Next step:</strong>');
  });

  it('spells the per-location counts out under each gateway, per AWS device', () => {
    const html = render('high');
    // The exposure table's chips compress each site to `2·1` to stay scannable across
    // every gateway at once; this is where the columns are named.
    expect(html).toContain('<th>DX location</th>');
    expect(html).toContain('AWS devices</th>');
    // `high` runs two connections on one device at each location …
    expect(html).toContain('Single device');
    // … and `maximum` is the device-redundant counterpart.
    expect(render('maximum')).toContain('Device-redundant');
  });

  it('carries every SLA figure from the tier table, so prose cannot drift from the badges', () => {
    const section = gatewaySection(render('devTest'));
    // devTest has one gateway at each of two tiers, so both figures must appear in the
    // cards themselves now that the reading guide that used to list all three is gone.
    expect(section).toContain('95% Single Connection SLA');
    expect(section).toContain('99.9% connection SLA');
  });

  it.each(SCENARIOS)('gives every card the four subsections the nav points at (%s)', (scenario) => {
    const html = render(scenario);
    const navIds = [...html.matchAll(/<summary class="dxgw-section-head" id="(gw\d+)">/g)].map((m) => m[1]);
    expect(navIds.length).toBeGreaterThan(0);
    for (const id of navIds) {
      for (const suffix of ['posture', 'vifs', 'findings', 'prefix', 'util']) {
        expect(html).toContain(`id="${id}-${suffix}"`);
      }
    }
  });

  it('says a clean gateway is clean rather than rendering an empty findings block', () => {
    expect(render('maximum')).toContain('No rule flagged anything scoped to this gateway');
  });
});

/**
 * Collapsible subsections, and the quota fraction that had no severity of its own.
 */
describe('gateway card folding', () => {
  it.each(SCENARIOS)('folds the long tables and leaves the verdict open (%s)', (scenario) => {
    const section = gatewaySection(render(scenario));
    const folded = [...section.matchAll(/<summary class="subsection-title gw-fold-s" id="gw\d+-(\w+)"/g)]
      .map((m) => m[1]);
    const open = [...section.matchAll(/<h4 class="subsection-title" id="gw\d+-(\w+)"/g)].map((m) => m[1]);
    // Five gateways x four tables is several screens before the second gateway.
    expect(new Set(folded)).toEqual(new Set(['vifs', 'prefix', 'util']));
    // Posture is the verdict and Findings is the work: a report that hides its findings
    // by default is worse than a long one.
    expect(new Set(open)).toEqual(new Set(['posture', 'findings']));
  });

  it('puts the anchor on the summary, not the wrapper', () => {
    // The nav and the exposure table link to these ids. On the <details> element the
    // target scrolls to a closed block that then has to be opened separately.
    const html = render('high');
    expect(html).toMatch(/<summary class="subsection-title gw-fold-s" id="gw1-vifs"/);
    expect(html).not.toMatch(/<details class="gw-fold" id=/);
    // And every folded id the nav points at must exist.
    for (const m of html.matchAll(/href="#(gw\d+-(?:vifs|prefix|util))"/g)) {
      expect(html).toContain(`id="${m[1]}"`);
    }
  });

  it('badges a fold with its own count so a closed section still warns', () => {
    const section = gatewaySection(render('devTest'));
    const badges = [...section.matchAll(/gw-fold-s" id="gw\d+-(\w+)">[^<]*<span class="gw-fold-n">(\d+)</g)];
    expect(badges.length).toBeGreaterThan(0);
  });

  it('flags an Accepted / Allocated fraction inside the warn band, and links it', () => {
    // The exposure table called this gateway "at risk" while its own card showed a
    // plain, unremarkable 20/24 -- the report contradicting itself across two sections.
    const section = gatewaySection(render('devTest'));
    const banded = [...section.matchAll(/<span class="quota-cell (quota-\w+)"[^>]*>([\s\S]*?)<\/span><\/span>/g)];
    expect(banded.length, 'no fraction landed in a band').toBeGreaterThan(0);
    for (const [, band, body] of banded) {
      expect(['quota-near', 'quota-over']).toContain(band);
      // The percentage is printed only when banded, so the reader can see why.
      expect(body).toMatch(/\d+%/);
    }
    // Linked to the finding, which is now on this same card.
    expect(section).toMatch(/<a class="quota-link" href="#gw\d+-f-DX-CFG-03"/);
  });

  it('leaves a healthy fraction unstyled and unlinked', () => {
    // Making every healthy fraction clickable would bury the two that are not.
    const section = gatewaySection(render('high'));
    const plain = [...section.matchAll(/<span class="quota-cell"[^>]*>/g)];
    expect(plain.length).toBeGreaterThan(0);
    expect(section).not.toMatch(/<a class="quota-link"[^>]*><span class="quota-cell"[^>]*>/);
  });

  it('states DX-CFG-03 on the gateway, not in the estate-wide list', () => {
    const html = render('devTest');
    const gw = gatewaySection(html);
    const estate = html.slice(html.indexOf('id="findings"'), html.indexOf('id="best-practices"'));
    // A full card on the gateway...
    expect(gw).toMatch(/<div id="gw\d+-f-DX-CFG-03" class="finding /);
    // ...and no second full card estate-wide. An index LINK there is expected.
    expect(estate).not.toMatch(/<div id="f-DX-CFG-03[^"]*" class="finding /);
  });
});

/**
 * A finding names a resource; the row proving it is a table away. These link.
 */
describe('values inside a finding link to their record', () => {
  const ids = (html: string) => new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));

  it.each(SCENARIOS)('never links to an anchor the report did not emit (%s)', (scenario) => {
    const html = render(scenario);
    const emitted = ids(html);
    const links = [...html.matchAll(/class="fx-ref" href="#([^"]+)"/g)].map((m) => m[1]);
    expect(links.filter((l) => !emitted.has(l))).toEqual([]);
  });

  it('links a VIF named in a finding to that VIF\'s own row', () => {
    // The pairing is what matters: a link that resolves to SOME row looks healthy while
    // pointing at a different VIF.
    const html = render('devTest');
    const links = [...html.matchAll(/<a class="fx-ref" href="#(gw\d+-v\d+)">([^<]+)<\/a>/g)];
    expect(links.length, 'no VIF label was linked').toBeGreaterThan(0);
    for (const [, anchor, label] of links) {
      const row = html.match(new RegExp(`<tr id="${anchor}">([\\s\\S]*?)</tr>`));
      expect(row, `${anchor} has no row`).toBeTruthy();
      // The row's first cell is the VIF identity, and it must be the one named.
      expect(row![1]).toContain(label);
    }
  });

  it('links a prefix named in a finding into the route tables', () => {
    const html = render('devTest');
    const links = [...html.matchAll(/<a class="fx-ref" href="#(rr-\d+)">([^<]+)<\/a>/g)];
    expect(links.length, 'no prefix was linked').toBeGreaterThan(0);
    for (const [, anchor, cidr] of links) {
      const row = html.match(new RegExp(`<tr id="${anchor}">([\\s\\S]*?)</tr>`));
      expect(row, `${anchor} has no row`).toBeTruthy();
      expect(row![1]).toContain(cidr);
    }
  });

  it('keeps the links working when redacted, where an id-derived anchor would not', () => {
    const t = getMockTopology('devTest');
    const html = buildHtmlReport(t, analyzeTopology(t), null, 'light', {
      kind: 'live', scenario: null, primaryRegion: 'ap-southeast-1', redacted: true,
    });
    const emitted = ids(html);
    const links = [...html.matchAll(/class="fx-ref" href="#([^"]+)"/g)].map((m) => m[1]);
    expect(links.length).toBeGreaterThan(0);
    expect(links.filter((l) => !emitted.has(l))).toEqual([]);
    expect(links.filter((l) => l.includes('\u2022'))).toEqual([]);
  });

  it('does not nest or double-wrap a link', () => {
    // One replace pass over a single alternation: per-label passes would rewrite the
    // href of a link the previous pass inserted, and a short label that is a prefix of
    // a longer one would corrupt it.
    const html = render('devTest');
    expect(html).not.toMatch(/<a class="fx-ref"[^>]*>[^<]*<a /);
    expect(html).not.toMatch(/href="#[^"]*<a /);
  });
});

describe('the whole gateway card collapses', () => {
  it.each(SCENARIOS)('is a details element with the id on its summary (%s)', (scenario) => {
    const html = render(scenario);
    const cards = [...html.matchAll(/<details class="dxgw-section"( open)?>\s*<summary class="dxgw-section-head" id="(gw\d+)">/g)];
    expect(cards.length).toBeGreaterThan(0);
    // On the <details> the target would scroll to a closed block.
    expect(html).not.toMatch(/<details class="dxgw-section"[^>]*id="gw/);
  });

  it('opens a gateway with findings and folds a clean one', () => {
    // A report that hides its findings by default is worse than a long one; a gateway
    // with nothing flagged is the one worth folding.
    const html = render('maximum');
    const cards = [...html.matchAll(/<details class="dxgw-section"( open)?>([\s\S]*?)<\/summary>/g)];
    const open = cards.filter((c) => c[1]);
    const closed = cards.filter((c) => !c[1]);
    expect(open.length).toBeGreaterThan(0);
    expect(closed.length).toBeGreaterThan(0);
    // A closed card still has to say why it is worth opening -- or not.
    for (const c of closed) expect(c[2]).toContain('nothing flagged');
    for (const c of open) expect(c[2]).toMatch(/gw-sum-(crit|warn)/);
  });
});

describe('prefix allocation figures are the documented ones', () => {
  it('calls 100 the default, not the quota, and states the real ceilings', () => {
    // Verified against the Inbound prefix controls page: 100 is the DEFAULT per address
    // family, raisable to 1,000 per VIF, with 10,000 total across a DX gateway. Calling
    // 100 "the quota" told the reader they were at a ceiling they can actually raise.
    // Collapsed, because the template literal wraps the sentence across lines.
    const flat = render('devTest').replace(/\s+/g, ' ');
    expect(flat).toContain('default allocation is <strong>100</strong> per family');
    expect(flat).toContain('raisable to <strong>1,000</strong>');
    expect(flat).toContain('allows <strong>10,000</strong> across all its VIFs');
    expect(flat).toContain('prefix-controls.html');
    // The old wording called the default a quota.
    expect(flat).not.toContain('the quota is 100 each for IPv4 and IPv6');
  });

  it('names the fallback a default in the finding text too', () => {
    const t = getMockTopology('devTest');
    const a = analyzeTopology(t);
    const recs = a.perDxGateway.flatMap((g) => g.recommendations);
    const quota = recs.find((r) => r.ruleId === 'bgp-route-limit');
    if (quota) expect(quota.description).not.toMatch(/quota \d+,/);
  });
});
