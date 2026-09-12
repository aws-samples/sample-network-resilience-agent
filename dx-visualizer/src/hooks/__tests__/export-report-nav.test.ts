import { describe, it, expect } from 'vitest';
import { buildHtmlReport } from '../useExportReport';
import { analyzeTopology } from '../../engine/recommendation-engine';
import { getMockTopology } from '../../utils/mock-data';
import type { MockScenario } from '../../utils/shared';

const SCENARIOS: MockScenario[] = ['noResiliency', 'devTest', 'high', 'maximum', 'crossAccount'];

function render(scenario: MockScenario, provenance?: Parameters<typeof buildHtmlReport>[4]) {
  const topology = getMockTopology(scenario);
  const assessment = analyzeTopology(topology);
  return buildHtmlReport(topology, assessment, scenario, 'light', provenance);
}

const navHrefs = (html: string) =>
  [...html.matchAll(/<nav id="toc">([\s\S]*?)<\/nav>/g)]
    .flatMap((m) => [...m[1].matchAll(/href="#([^"]+)"/g)].map((h) => h[1]));

const idsIn = (html: string) => new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));

describe('export report navigation', () => {
  it.each(SCENARIOS)('every sidebar link resolves to a real section (%s)', (scenario) => {
    const html = render(scenario);
    const hrefs = navHrefs(html);
    expect(hrefs.length).toBeGreaterThan(0);
    const ids = idsIn(html);
    // A link to a section that was not rendered is worse than no link at all.
    expect(hrefs.filter((h) => !ids.has(h))).toEqual([]);
  });

  // `extraSections` exists for the `nwra-skill` skill, which renders a Mermaid
  // topology diagram and a data-gaps list the app itself cannot produce. The nav is
  // built from the same list as the body, so an extra section must not be able to
  // become a dead link — and omitting the parameter must change nothing.
  describe('caller-supplied extra sections', () => {
    const EXTRAS = [
      { id: 'topology', title: 'Topology', html: '<div class="mermaid">flowchart LR\n  A-->B</div>' },
      { id: 'data-gaps', title: 'Data gaps', html: '<p>None.</p>' },
    ];
    const renderWithExtras = (scenario: MockScenario) => {
      const topology = getMockTopology(scenario);
      return buildHtmlReport(topology, analyzeTopology(topology), scenario, 'light', undefined, EXTRAS);
    };

    it('renders each extra section and links it from the nav', () => {
      const html = renderWithExtras('high');
      const ids = idsIn(html);
      const hrefs = navHrefs(html);
      for (const s of EXTRAS) {
        expect(ids.has(s.id)).toBe(true);
        expect(hrefs).toContain(s.id);
        expect(html).toContain(s.html);
      }
      expect(hrefs.filter((h) => !ids.has(h))).toEqual([]);
    });

    it('places them after the executive summary and before the per-gateway assessment', () => {
      const html = renderWithExtras('high');
      expect(html.indexOf('id="executive-summary"')).toBeLessThan(html.indexOf('id="topology"'));
      expect(html.indexOf('id="topology"')).toBeLessThan(html.indexOf('id="per-dx-gateway"'));
    });

    it('omitting the parameter leaves the report byte-identical', () => {
      const topology = getMockTopology('high');
      const assessment = analyzeTopology(topology);
      const withDefault = buildHtmlReport(topology, assessment, 'high', 'light');
      const withEmpty = buildHtmlReport(topology, assessment, 'high', 'light', undefined, []);
      expect(withEmpty).toBe(withDefault);
      expect(withDefault).not.toContain('id="topology"');
    });

    it('escapes the id and title but not the caller-owned html', () => {
      const topology = getMockTopology('high');
      const html = buildHtmlReport(topology, analyzeTopology(topology), 'high', 'light', undefined, [
        { id: 'x"y', title: 'A & B <script>', html: '<em>kept</em>' },
      ]);
      expect(html).toContain('A &amp; B &lt;script&gt;');
      expect(html).toContain('<em>kept</em>');
    });
  });

  it('renders the sidebar chrome and its controls', () => {
    const html = render('high');
    expect(html).toContain('id="toc"');
    expect(html).toContain('id="toc-grip"');
    expect(html).toContain('id="toc-hide"');
    expect(html).toContain('id="toc-show"');
    // width and offset must come from one variable, or they can drift apart
    expect(html).toContain('--toc-w');
    expect(html).toContain('padding-left: calc(var(--toc-w) + 24px)');
  });

  it('groups findings under per-severity anchors that the badges point at', () => {
    const html = render('devTest');
    for (const sev of ['critical', 'warning', 'info']) {
      expect(html).toContain(`id="findings-${sev}"`);
      expect(html).toContain(`href="#findings-${sev}"`);
    }
  });

  it('labels a mock export as mock, never as a live read', () => {
    const html = render('high', {
      kind: 'mock', scenario: 'high', primaryRegion: null, redacted: false,
    });
    expect(html).toContain('class="prov mock"');
    expect(html).toContain('mock scenario');
    expect(html).not.toContain('class="prov live"');
    // no credentials in mock mode, so the region is unknown rather than guessed
    expect(html).toContain('Primary region not recorded');
  });

  it('labels an imported snapshot as imported', () => {
    const html = render('high', {
      kind: 'imported', scenario: null, primaryRegion: null, redacted: false,
    });
    expect(html).toContain('class="prov imported"');
    expect(html).toContain('imported snapshot');
  });

  it('does not chip a live read as live — the kind chip is for abnormal provenance', () => {
    const html = render('high', {
      kind: 'live', scenario: null, primaryRegion: 'ap-southeast-1', redacted: false,
    });
    expect(html).not.toContain('class="prov live"');
    expect(html).not.toContain('live AWS read');
    expect(html).toContain('Primary region ap-southeast-1');
  });

  it('warns an unredacted live report that it carries real identifiers', () => {
    // The reader of the file did not click Export and never saw the confirmation
    // dialog, so this chip is the only notice they get.
    const html = render('high', {
      kind: 'live', scenario: null, primaryRegion: 'ap-southeast-1', redacted: false,
    });
    expect(html).toContain('class="prov unmasked"');
    expect(html).toContain('not redacted');
  });

  it('chips no redaction state on a mock export — there is nothing to protect', () => {
    const html = render('high', {
      kind: 'mock', scenario: 'high', primaryRegion: null, redacted: false,
    });
    expect(html).not.toContain('class="prov unmasked"');
    expect(html).not.toContain('class="prov redacted"');
  });

  it('says what a redacted report does and does not mask', () => {
    const html = render('high', {
      kind: 'live', scenario: null, primaryRegion: 'ap-southeast-1', redacted: true,
    });
    expect(html).toContain('class="prov redacted"');
    // Overclaiming here is the failure mode: names, descriptions and tags survive,
    // exactly as they do in the app's redact mode.
    expect(html).toContain('names are not');
    expect(html).not.toContain('class="prov unmasked"');
    expect(html).toContain('Primary region ap-southeast-1');
  });

  it('keeps the sidebar out of print output', () => {
    const html = render('devTest');
    const printBlock = html.slice(html.indexOf('@media print'));
    expect(printBlock).toContain('#toc, #toc-grip, #toc-show, .toc-btn { display: none !important; }');
  });
});

describe('executive summary', () => {
  it('appears with a nav link on every scenario', () => {
    for (const s of SCENARIOS) {
      const html = render(s);
      expect(html).toContain('id="executive-summary"');
      expect(html).toContain('href="#executive-summary"');
    }
  });

  it('agrees in number with the data it describes', () => {
    for (const s of SCENARIOS) {
      const text = render(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      expect(text).not.toMatch(/All 1 assessed scope sit /);
      expect(text).not.toMatch(/There are 1 critical finding\b/);
      expect(text).not.toMatch(/There is \d\d+ critical/);
    }
  });

  it('refuses a single headline tier when scopes disagree', () => {
    // crossAccount has several gateways; if their tiers differ the summary must
    // say so rather than quoting one figure for the whole account.
    const html = render('crossAccount');
    const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    expect(text).toMatch(/assessed scopes? sits? at|Resilience is uneven across scopes|no scope to tier/);
  });
});

/**
 * The sidebar's primary axis is the DX gateway: one collapsible group per gateway,
 * between a "Per DX gateway" band and an "Estate-wide" one. The properties worth
 * guarding are the ones a reader would notice breaking — every anchor resolves (the
 * suite-wide test above), no id is emitted twice now that findings appear in two
 * places, and the nav order matches the body order or the scroll-spy highlights the
 * wrong row.
 */
describe('per-DX-gateway sidebar', () => {
  const nav = (html: string) => html.slice(html.indexOf('<nav id="toc">'), html.indexOf('</nav>'));

  it('bands the tree into per-gateway and estate-wide halves', () => {
    const n = nav(render('maximum'));
    expect(n).toContain('class="toc-band">Per DX gateway<');
    expect(n).toContain('class="toc-band">Estate-wide<');
    expect(n.indexOf('Per DX gateway')).toBeLessThan(n.indexOf('Estate-wide'));
  });

  it('gives every gateway a collapsible group with its own subsections', () => {
    const html = render('maximum');
    const n = nav(html);
    const groups = [...n.matchAll(/class="toc-group" id="grp-(gw\d+)"/g)].map((m) => m[1]);
    expect(groups.length).toBe(2); // maximum has two DX gateways
    for (const g of groups) {
      for (const child of ['-posture', '-findings', '-util']) {
        expect(n).toContain(`href="#${g}${child}"`);
        expect(html).toContain(`id="${g}${child}"`);
      }
    }
    // The accordion is inline JS + localStorage, like the width and hidden state.
    expect(html).toContain('dxr-toc-gw');
  });

  it('orders the nav groups exactly as the body sections appear', () => {
    for (const s of SCENARIOS) {
      const html = render(s);
      const navOrder = [...nav(html).matchAll(/id="grp-(gw\d+)"/g)].map((m) => m[1]);
      const bodyOrder = [...html.matchAll(/class="dxgw-section-head" id="(gw\d+)"/g)].map((m) => m[1]);
      expect(bodyOrder, s).toEqual(navOrder);
    }
  });

  it('puts the worst-exposed gateway first, not the alphabetically first', () => {
    // noResiliency has one gateway with a critical finding and one unused gateway.
    const n = nav(render('noResiliency'));
    const first = n.slice(n.indexOf('id="grp-gw1"'), n.indexOf('id="grp-gw2"'));
    expect(first).toContain('class="b-crit"');
  });

  it('emits no id twice, now that a finding appears per gateway and estate-wide', () => {
    for (const s of SCENARIOS) {
      const ids = [...render(s).matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
      const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
      expect(dupes, s).toEqual([]);
    }
  });

  it('anchors each route-diff matrix so the gateway group can link to it', () => {
    const html = render('high');
    const n = nav(html);
    for (const m of [...n.matchAll(/href="#(rt-gw\d+)"/g)]) {
      expect(html).toContain(`id="${m[1]}"`);
      // The matrix now lives INSIDE the gateway card it describes, so its anchor has to
      // fall between that card and the next section — not in a separate estate-wide
      // section. Asserting against the old section's indexOf silently passed once that
      // section was deleted, because indexOf returns -1.
      const gw = m[1].slice(3);
      const cardStart = html.indexOf(`<summary class="dxgw-section-head" id="${gw}">`);
      expect(cardStart, gw).toBeGreaterThan(-1);
      expect(html.indexOf(`id="${m[1]}"`)).toBeGreaterThan(cardStart);
      expect(html.indexOf(`id="${m[1]}"`)).toBeLessThan(html.indexOf('id="findings"'));
    }
  });

  it('collects gateway-less VIFs into their own group rather than dropping them', () => {
    // `high` has VIFs outside any DX gateway.
    const html = render('high');
    expect(nav(html)).toMatch(/No DX gateway \(\d+ VIFs?\)/);
    expect(html).toContain('id="gw-other"');
    // and says why a tier and a prefix comparison do not apply to them
    expect(html.replace(/\s+/g, ' ')).toContain('both computed per DX Gateway, so neither applies');
  });
});

describe('per-gateway prefix consistency', () => {
  it('lists every missing prefix, with no truncation', () => {
    // The DX-CFG-07 prose truncates at five; the table is the untruncated form, because
    // the reader's next action is to reconfigure a router from it.
    const html = render('high');
    const section = html.slice(html.indexOf('id="per-dx-gateway"'), html.indexOf('id="findings"'));
    if (section.includes('class="prefix-table"')) {
      expect(section).not.toMatch(/\+\d+ more|and \d+ others/);
      expect(section).toContain('class="prefix-chip"');
      // the three marks have to carry a legend, or the glyphs are unreadable
      expect(section).toContain('covered by a less specific route on');
    }
  });

  // A gateway finding is now rendered ONCE, on its own gateway card, and the card
  // carries the anchor. It used to be listed here and again in an estate-wide "All
  // findings" section, so the id chip had to link out to that second copy; there is no
  // second copy to link to any more, and `Estate-wide findings` deliberately excludes
  // anything a gateway owns.
  it('anchors each gateway finding on its own card, scoped so four gateways cannot collide', () => {
    const html = render('noResiliency');
    const section = html.slice(html.indexOf('id="per-dx-gateway"'), html.indexOf('id="findings"'));
    const ids = [...section.matchAll(/<div id="(gw\d+-f-[^"]+)" class="finding /g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(0);
    // Unique, and every one prefixed by the gateway that owns it.
    expect(new Set(ids).size).toBe(ids.length);
    // The old cross-copy link must be gone, or it points at an id nothing emits.
    expect(section).not.toContain('class="finding-id-link"');
  });

  it('does not list a gateway-scoped finding in the estate-wide section as well', () => {
    const html = render('noResiliency');
    const gwPart = html.slice(html.indexOf('id="per-dx-gateway"'), html.indexOf('id="findings"'));
    const estatePart = html.slice(html.indexOf('id="findings"'), html.indexOf('id="best-practices"'));
    const titles = (frag: string) =>
      [...frag.matchAll(/<div id="[^"]*" class="finding severity-[a-z]+">\s*<div class="finding-head">[\s\S]*?<h4>([^<]+)<\/h4>/g)]
        .map((m) => m[1]);
    const gwTitles = new Set(titles(gwPart));
    expect(gwTitles.size).toBeGreaterThan(0);
    for (const t of titles(estatePart)) expect(gwTitles.has(t)).toBe(false);
  });

  it('says a clean gateway is clean rather than rendering an empty block', () => {
    const html = render('maximum');
    expect(html).toContain('No rule flagged anything scoped to this gateway');
  });
});

/**
 * The route diff moved out of one estate-wide "BGP route analysis" section and into
 * each gateway's own card. A prefix×VIF grid is only meaningful against the VIFs of
 * the gateway it belongs to, and the old arrangement split every verdict from its grid
 * — each per-gateway summary sentence ended in "see the route-diff matrix".
 */
describe('per-gateway route diff', () => {
  const gwPart = (html: string) =>
    html.slice(html.indexOf('id="per-dx-gateway"'), html.indexOf('id="findings"'));

  it('is gone as an estate-wide section, with no nav row left pointing at one', () => {
    for (const s of SCENARIOS) {
      const html = render(s);
      expect(html).not.toContain('id="bgp-route-analysis"');
      expect(html).not.toContain('href="#bgp-route-analysis"');
    }
  });

  it('renders one matrix per gateway, inside that gateway card', () => {
    const html = render('high');
    const section = gwPart(html);
    expect(section).toMatch(/class="matrix"|No cross-VIF comparison/);
    if (section.includes('class="matrix"')) {
      expect(section).toMatch(/chip-pill v-(solo|partial|covered|redundant)/);
      // The four cell marks must carry a legend beside them, or the glyphs are
      // unreadable — that is why the legend moved into the card too.
      expect(section).toContain('covered by a less specific route');
      // Anchored per gateway, and the nav row for it must resolve.
      const anchors = [...section.matchAll(/id="(rt-gw\d+)"/g)].map((m) => m[1]);
      expect(anchors.length).toBeGreaterThan(0);
      for (const a of anchors) expect(html).toContain(`href="#${a}"`);
    }
  });

  /**
   * `rank(hops)` cells and letter columns.
   *
   * A full AS path is too wide for a matrix cell, but the reader still needs to know
   * which VIF the router prefers for a prefix. Shortest AS path wins, so the rank IS
   * the preference — and VIFs sharing a rank share a path length, which is the ECMP
   * case stated without a second column.
   */
  describe('route-diff preference ranks', () => {
    /** Give each VIF on the gateway a chosen AS path length for every prefix. */
    const withHops = (hopsByVif: Record<string, number>) => {
      const base = getMockTopology('high');
      const routes = new Map(base.vifRoutes);
      for (const [vifId, hops] of Object.entries(hopsByVif)) {
        const entry = routes.get(vifId);
        if (!entry) throw new Error(`fixture has no ${vifId}`);
        routes.set(vifId, {
          ...entry,
          accepted: entry.accepted.map((r) => ({
            ...r,
            asPath: [{ pathType: 'seq' as const, path: Array.from({ length: hops }, (_, i) => 65000 + i) }],
          })),
        });
      }
      return { ...base, vifRoutes: routes };
    };

    const matrixOf = (html: string) =>
      html.match(/<table class="matrix">[\s\S]*?<\/table>/)?.[0] ?? '';

    const rowCells = (matrix: string, cidr: string) => {
      const tr = [...matrix.matchAll(/<tr[^>]*>[\s\S]*?<\/tr>/g)]
        .map((m) => m[0])
        .find((r) => r.includes(`>${cidr}`));
      expect(tr, `row ${cidr} is missing`).toBeTruthy();
      return [...tr!.matchAll(/<td class="mcol">([\s\S]*?)<\/td>/g)].map((m) => {
        const rank = m[1].match(/class="mrank[^"]*"[^>]*>(\d+)<span class="mhops">\((\d+)\)/);
        return rank ? `${rank[1]}(${rank[2]})` : 'mark';
      });
    };

    it('labels the columns A B C D, not #1 #2 #3', () => {
      const matrix = matrixOf(render('high'));
      const heads = [...matrix.matchAll(/<th class="mcol"[^>]*>([^<]+)<\/th>/g)].map((m) => m[1]);
      expect(heads).toEqual(['A', 'B', 'C', 'D']);
      // A numbered header beside a numeric cell invites the reader to match the digits.
      expect(matrix).not.toMatch(/<th class="mcol"[^>]*>#\d/);
    });

    it('ranks by AS path length and shares a rank between equal-cost VIFs', () => {
      // Two VIFs at two hops, two at three: the shape the notation exists to express.
      const t = withHops({
        'dxvif-high01': 2, 'dxvif-high03': 2, 'dxvif-high02': 3, 'dxvif-high04': 3,
      });
      const cells = rowCells(matrixOf(buildHtmlReport(t, analyzeTopology(t), 'high', 'light')), '10.40.0.0/24');
      expect(cells).toEqual(['1(2)', '1(2)', '2(3)', '2(3)']);
    });

    it('gives every VIF rank 1 when all paths are the same length', () => {
      const t = withHops({
        'dxvif-high01': 2, 'dxvif-high03': 2, 'dxvif-high02': 2, 'dxvif-high04': 2,
      });
      const cells = rowCells(matrixOf(buildHtmlReport(t, analyzeTopology(t), 'high', 'light')), '10.40.0.0/24');
      expect(cells).toEqual(['1(2)', '1(2)', '1(2)', '1(2)']);
    });

    it('orders ranks so the shortest path is rank 1', () => {
      const t = withHops({
        'dxvif-high01': 5, 'dxvif-high03': 1, 'dxvif-high02': 3, 'dxvif-high04': 3,
      });
      const cells = rowCells(matrixOf(buildHtmlReport(t, analyzeTopology(t), 'high', 'light')), '10.40.0.0/24');
      // 1 hop -> rank 1, 3 hops -> rank 2 (shared), 5 hops -> rank 3.
      expect(cells).toEqual(['3(5)', '1(1)', '2(3)', '2(3)']);
    });

    it('keeps the tick when only one VIF accepts the prefix', () => {
      // A lone rank would imply a runner-up that does not exist.
      const matrix = matrixOf(render('devTest'));
      const solo = [...matrix.matchAll(/<tr[^>]*>[\s\S]*?<\/tr>/g)]
        .map((m) => m[0])
        .filter((r) => r.includes('v-solo'));
      expect(solo.length).toBeGreaterThan(0);
      for (const r of solo) expect(r).not.toContain('class="mrank');
    });

    it('keeps the tick when the AS path is unknown', () => {
      // Routes present, asPath stripped: ranking on absent data would invent an order.
      const base = getMockTopology('high');
      const routes = new Map(base.vifRoutes);
      for (const [id, e] of routes) {
        routes.set(id, { ...e, accepted: e.accepted.map((r) => ({ ...r, asPath: [] })) });
      }
      const t = { ...base, vifRoutes: routes };
      const matrix = matrixOf(buildHtmlReport(t, analyzeTopology(t), 'high', 'light'));
      // Every path is length 0, which is a known length — so ranks still render, all 1.
      const cells = rowCells(matrix, '10.40.0.0/24');
      expect(cells).toEqual(['1(0)', '1(0)', '1(0)', '1(0)']);
    });

    it('explains the notation with a worked example, where the notation is', () => {
      const html = render('high');
      expect(html).toContain('is rank(hops)');
      expect(html).toContain('1(2) 1(2) 2(3) 2(3)');
      expect(html).toContain('Shortest');
      // Four concrete paths, two lengths, two ranks — the pairing is the whole point,
      // and prose hides it, so it is a list.
      expect(html).toContain('class="rank-eg"');
      for (const path of ['65006 65010', '65005 65010', '65006 65006 65010', '65005 65005 65010']) {
        expect(html).toContain(path);
      }
      expect(html).toContain('ECMP with A');
      expect(html).toContain('ECMP with C');
    });
  });

  /**
   * AS paths are NOT in the matrix legend.
   *
   * They were, and it failed: on a real gateway a VIF learns a dozen different paths, so
   * four VIFs produced forty chips of near-identical digits wedged between the matrix and
   * its legend — burying the one thing that list is for, which letter is which VIF. The
   * hop count in each cell is what belongs inline; full paths are in the appendix.
   */
  describe('matrix legend', () => {
    it.each(SCENARIOS)('is a column key only, with no AS-path chips (%s)', (scenario) => {
      const section = gwPart(render(scenario));
      const legend = section.match(/<ul class="legend">[\s\S]*?<\/ul>/)?.[0];
      if (!legend) return;
      expect(legend).not.toContain('class="as-path"');
      expect(legend).not.toContain('class="as-paths"');
      // Still names each column and its VIF.
      expect(legend).toMatch(/<span class="col-n">[A-Z]+<\/span>/);
    });

    it('points at the appendix for the full paths instead', () => {
      const section = gwPart(render('high'));
      expect(section).toContain('href="#route-tables"');
    });
  });


  it('cites the API it reads and states that advertised routes are not compared', () => {
    const html = render('maximum');
    expect(html).toContain('directconnect:ListVirtualInterfaceRoutes');
    // Advertised prefixes come from allowedPrefixes and are identical across a
    // gateway's VIFs by construction — comparing them would be noise.
    expect(html).toContain('advertised\n  routes are not compared');
  });

  it('reports missing route data per gateway as not assessed, never as a pass', () => {
    const topology = getMockTopology('high');
    const assessment = analyzeTopology(topology);
    const { vifRoutes: _dropped, ...withoutRoutes } = topology;
    const html = buildHtmlReport(withoutRoutes as typeof topology, assessment, 'high', 'light');
    const section = gwPart(html);
    expect(section).toContain('No cross-VIF comparison');
    // The permission is the actionable fact, and it is a List* the Describe* wildcard
    // does not cover — so it must survive into the per-gateway wording.
    expect(section).toContain('directconnect:ListVirtualInterfaceRoutes');
    expect(section).not.toContain('class="matrix"');
  });
});

describe('VIF utilization', () => {
  it('appears with a nav link on every scenario', () => {
    for (const s of SCENARIOS) {
      const html = render(s);
      expect(html).toContain('id="vif-utilization"');
      expect(html).toContain('href="#vif-utilization"');
    }
  });

  it('names the CloudWatch metrics, statistic, and window behind the numbers', () => {
    const topology = getMockTopology('high');
    const html = render('high');
    const section = html.slice(html.indexOf('id="vif-utilization"'), html.indexOf('id="inventory"'));
    expect(section).toContain('AWS/DX');
    expect(section).toContain('VirtualInterfaceBpsIngress');
    expect(section).toContain('VirtualInterfaceBpsEgress');
    expect(section).toContain('Stat: Average');
    expect(section).toContain('Period: 3600');
    // the window length is data, not a guess — it travels on the topology
    expect(section).toContain(`last <strong>${topology.utilizationWindowDays} days</strong>`);
    expect(section).toMatch(/\d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}/);
  });

  it('labels the bands as this report\'s convention, not an AWS figure', () => {
    const section = render('high');
    expect(section).toContain("this report's operating convention, not AWS-published figures");
    expect(section).toMatch(/chip-pill band-(over|elevated|normal|under|unknown)/);
  });

  it('keeps N-1 headroom vocabulary distinct from the utilization bands', () => {
    const html = render('maximum');
    const section = html.slice(html.indexOf('id="vif-utilization"'), html.indexOf('id="inventory"'));
    expect(section).toContain('Failover headroom (N-1)');
    expect(section).toMatch(/ample headroom|tight but fits|would congest|would not fit|no failover path|indeterminate/);
    // the aggregate assumption has to be stated, or the verdict reads as a guarantee
    expect(section).toContain('BGP does not guarantee');
  });

  it('dates an imported snapshot\'s window to its export, not to today', () => {
    const html = render('high', {
      kind: 'imported', scenario: null, primaryRegion: null, redacted: false,
      dataAsOf: '2026-01-15T00:00:00.000Z',
    });
    const section = html.slice(html.indexOf('id="vif-utilization"'), html.indexOf('id="inventory"'));
    expect(section).toContain('2026-01-15');
    expect(section).toContain('ending when this snapshot was exported');
  });

  it('reports missing metrics as not assessed and names the fetch', () => {
    const topology = getMockTopology('high');
    const assessment = analyzeTopology(topology);
    const { vifUtilization: _v, connectionUtilization: _c, ...noMetrics } = topology;
    const html = buildHtmlReport(noMetrics as typeof topology, assessment, 'high', 'light');
    const section = html.slice(html.indexOf('id="vif-utilization"'), html.indexOf('id="inventory"'));
    expect(section).toContain('Not assessed');
    expect(section).toContain('cloudwatch:GetMetricData');
    expect(section).not.toContain('Failover headroom');
  });

  it('names the statistic the fetch actually used, not a fixed one', () => {
    const html = render('high', {
      kind: 'live', scenario: null, primaryRegion: 'ap-northeast-1', redacted: false,
      fetchedForReport: true, metricStat: 'Maximum',
    });
    const section = html.slice(html.indexOf('id="vif-utilization"'), html.indexOf('id="inventory"'));
    expect(section).toContain('Stat: Maximum');
    expect(section).not.toContain('Stat: Average');
  });

  it('does not blame missing credentials when it fetched and CloudWatch returned nothing', () => {
    const topology = getMockTopology('high');
    const assessment = analyzeTopology(topology);
    const { vifUtilization: _v, connectionUtilization: _c, ...noMetrics } = topology;
    const html = buildHtmlReport(noMetrics as typeof topology, assessment, 'high', 'light', {
      kind: 'live', scenario: null, primaryRegion: 'ap-northeast-1', redacted: false,
      fetchedForReport: true, utilizationError: null,
    });
    const section = html.slice(html.indexOf('id="vif-utilization"'), html.indexOf('id="inventory"'));
    expect(section).toContain('queried CloudWatch successfully and it returned no datapoints');
    expect(section).not.toContain('without AWS credentials');
  });

  // A partner-hosted VIF routinely publishes VirtualInterfaceUtilization* and NOTHING
  // for VirtualInterfaceBps*. Before these fields existed, such an account rendered the
  // whole section as "not assessed" while AWS had in fact answered for every VIF.
  describe('AWS-reported utilization percentage (no Bps datapoints)', () => {
    const pctOnly = () => {
      const topology = getMockTopology('high');
      const vifUtilization = new Map(topology.virtualInterfaces.map((v, i) => [
        v.virtualInterfaceId, { ingressUtilPctPeak: 0.18 + i, egressUtilPctPeak: 0.16 },
      ]));
      const next = { ...topology, vifUtilization, connectionUtilization: undefined };
      return buildHtmlReport(next, analyzeTopology(next), 'high', 'light', {
        kind: 'live', scenario: null, primaryRegion: 'ap-northeast-1', redacted: false,
        fetchedForReport: true, metricStat: 'Maximum',
      });
    };
    const sectionOf = (html: string) =>
      html.slice(html.indexOf('id="vif-utilization"'), html.indexOf('id="inventory"'));

    it('renders the table instead of "not assessed"', () => {
      const section = sectionOf(pctOnly());
      expect(section).not.toContain('Not assessed');
      expect(section).toContain('0.18%');
    });

    it('names the metric and says why those rows are not graded', () => {
      const section = sectionOf(pctOnly());
      expect(section).toContain('VirtualInterfaceUtilizationIngress');
      expect(section).toContain('undocumented');
      expect(section).toContain('not graded');
      // Never banded off AWS's percentage: its denominator is not ours to claim.
      expect(section).not.toMatch(/chip-pill band-(over|elevated|normal|under)\b/);
      expect(section).toContain('chip-pill band-unknown');
    });

    it('leaves the bps columns empty rather than inventing throughput', () => {
      const section = sectionOf(pctOnly());
      const firstRow = section.slice(section.indexOf('<tr>'), section.indexOf('</tr>'));
      expect(firstRow).not.toMatch(/\d+\s*(Mbps|Gbps|Kbps)/);
    });

    it('does not add the AWS-% provenance row when Bps datapoints exist', () => {
      const section = sectionOf(render('high'));
      expect(section).not.toContain('AWS-reported %');
    });

    it('shows a derived hosted physical port without grading it as contracted capacity', () => {
      const topology = getMockTopology('high');
      const hostedId = topology.virtualInterfaces[0].connectionId;
      const connections = topology.connections.map((connection) =>
        connection.connectionId === hostedId
          ? {
              ...connection,
              bandwidth: '',
              isInferred: true,
              derivedPhysicalPortBps: 10_000_000_000,
            }
          : connection);
      const next = { ...topology, connections };
      const section = sectionOf(buildHtmlReport(
        next,
        analyzeTopology(next),
        'high',
        'light',
        {
          kind: 'live',
          scenario: null,
          primaryRegion: 'ap-northeast-1',
          redacted: false,
          fetchedForReport: true,
          metricStat: 'Maximum',
        },
      ));

      expect(section).toContain('10.00 Gbps');
      expect(section).toContain('derived physical port; contracted capacity unknown');
      expect(section).toContain('excluded from failover-headroom capacity calculations');
      expect(section).toContain('physical-port %, contracted capacity unknown');
    });
  });
});

describe('executive summary', () => {
  // The summary used to end in a generic "Next steps" list built from
  // `nextStepsFor`. It is gone: the same advice already appears in the ranked plan
  // and per gateway under "How to Improve", so it was a third copy. The summary's
  // job is the tier posture plus the most material findings by name.
  // `nextStepsFor` itself still backs the per-gateway list, which is why it stayed.
  it('does not reintroduce a generic next-steps list', () => {
    for (const s of SCENARIOS) {
      const html = render(s);
      const summary = html.slice(
        html.indexOf('id="executive-summary"'),
        // The section that used to follow the summary is gone; slicing to its indexOf
        // returned -1, which made every assertion below run against an empty string.
        html.indexOf('id="per-dx-gateway"'),
      );
      expect(summary.length, s).toBeGreaterThan(0);
      expect(summary).not.toContain('<ol class="steps">');
      // The advice that replaced it must be scope-named, never account-wide:
      // "Your setup" reads as the whole estate when only one gateway is weak.
      expect(summary).not.toContain('Your setup');
      expect(summary).not.toContain('You have connections at');
    }
  });
});
