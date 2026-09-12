import { describe, it, expect } from 'vitest';
import { analyzeTopology } from '../recommendation-engine';
import { getMockTopology } from '../../utils/mock-data';
import type { MockScenario } from '../../utils/shared';

/**
 * Which best-practice findings are stated per DX gateway, and which stay estate-wide.
 *
 * The VIF-subject rules used to run once for the whole account and name every affected
 * VIF in one joined sentence, so "hirohero-poc-summit-sg-02 is at 84% of its quota"
 * landed in an estate-wide list while the gateway that VIF belongs to sat elsewhere with
 * its own card. A finding that names a resource belongs where that resource is.
 *
 * The invariant these tests exist for is the one that is easy to break silently: the
 * per-gateway call site and the global exclusion list are two halves of the same
 * decision, and if a ruleId is added to one and not the other the finding renders
 * TWICE — once per gateway and once estate-wide — with nothing failing.
 */

const SCENARIOS: MockScenario[] = ['noResiliency', 'devTest', 'high', 'maximum', 'crossAccount'];
const view = (s: MockScenario) => analyzeTopology(getMockTopology(s));

/** Rules deliberately graded per gateway. */
const MOVED = [
  'consistent-prefix-advertisement',
  'bgp-route-limit',
  'prefix-churn',
  'bgp-session-stability',
  'dx-failover-testing',
];

/**
 * Rules that must NOT be scoped, each for a reason that would be destroyed by scoping.
 * `shared-logical-device` is the sharpest: it is ABOUT a device shared across gateways,
 * so per-gateway it would either vanish or claim each gateway shares a device with
 * itself. The two `dxGateways`-reading rules would report every gateway on every card,
 * because the scope spreads the topology and does not filter that collection.
 */
const KEPT_GLOBAL = [
  'shared-logical-device',
  'unused-dx-gateway',
  'dxgw-propagation',
  'prefix-pool-exhausted',
  'logical-redundancy',
];

describe('per-DX-gateway best-practice scoping', () => {
  it.each(SCENARIOS)('never states one rule both per gateway and estate-wide (%s)', (scenario) => {
    const a = view(scenario);
    const globalIds = new Set(a.global.bestPractice.recommendations.map((r) => r.ruleId));
    const gwIds = new Set(a.perDxGateway.flatMap((g) => g.recommendations.map((r) => r.ruleId)));
    const both = [...gwIds].filter((id) => globalIds.has(id));
    expect(both, `stated twice: ${both.join(', ')}`).toEqual([]);
  });

  it('grades the VIF-subject rules on the gateway whose VIFs they name', () => {
    // devTest is the scenario where these actually fire.
    const a = view('devTest');
    const gwIds = new Set(a.perDxGateway.flatMap((g) => g.recommendations.map((r) => r.ruleId)));
    const fired = MOVED.filter((id) => gwIds.has(id));
    expect(fired.length, 'no moved rule fired — the fixture cannot prove anything').toBeGreaterThan(3);
    const globalIds = new Set(a.global.bestPractice.recommendations.map((r) => r.ruleId));
    for (const id of MOVED) expect(globalIds.has(id), `${id} is still global`).toBe(false);
  });

  it('grades different verdicts for different gateways on the same rule', () => {
    // The whole point of scoping: one estate-wide emission could only ever carry one
    // verdict, so a healthy gateway and a flagged one were indistinguishable.
    const a = view('devTest');
    const per = a.perDxGateway.map((g) => g.recommendations.map((r) => r.ruleId));
    expect(per.length).toBeGreaterThan(1);
    const flagged = per.filter((ids) => ids.includes('bgp-route-limit'));
    const healthy = per.filter((ids) => ids.includes('bgp-route-limit-ok'));
    expect(flagged.length, 'expected one gateway over the warn band').toBe(1);
    expect(healthy.length, 'expected one gateway under it').toBe(1);
  });

  it.each(SCENARIOS)('keeps cross-gateway and non-VIF rules estate-wide (%s)', (scenario) => {
    const a = view(scenario);
    const gwIds = new Set(a.perDxGateway.flatMap((g) => g.recommendations.map((r) => r.ruleId)));
    for (const id of KEPT_GLOBAL) {
      expect(gwIds.has(id), `${id} must not be scoped to a gateway`).toBe(false);
    }
  });

  it.each(SCENARIOS)('loses no finding to the move (%s)', (scenario) => {
    // The aggregate is what the canvas and the chat context read. Scoping must
    // redistribute findings, never drop them.
    const a = view(scenario);
    const aggregate = a.bestPractice.recommendations.map((r) => r.ruleId);
    const globalIds = a.global.bestPractice.recommendations.map((r) => r.ruleId);
    const gwIds = a.perDxGateway.flatMap((g) =>
      g.recommendations.filter((r) => r.category === 'bestpractice').map((r) => r.ruleId));
    for (const id of [...globalIds, ...gwIds]) expect(aggregate).toContain(id);
  });

  it('still runs the global best-practice pass, which is what carries annotations', () => {
    // Only the moved rules' RECOMMENDATIONS are dropped from the global list; the pass
    // itself still runs, because it is also what produces the canvas node annotations.
    // Asserting on the annotation count would prove nothing here — every stock scenario
    // yields zero, before and after this change (checked) — so the proof is that
    // unmoved global rules still arrive.
    const a = view('devTest');
    const globalIds = a.global.bestPractice.recommendations.map((r) => r.ruleId);
    expect(globalIds.length).toBeGreaterThan(0);
    expect(globalIds).toContain('bfd-guidance');
    expect(a.bestPractice.annotations).toBeDefined();
  });

  it('scopes the per-gateway data the rules need, not just the VIF list', () => {
    // buildDxgwGroupScope spreads the topology, so vifRoutes / bgpStability /
    // vifFailoverTests survive keyed by VIF id. If a future refactor rebuilt the scope
    // field by field instead, these rules would go quietly silent.
    const a = view('devTest');
    const ids = a.perDxGateway.flatMap((g) => g.recommendations.map((r) => r.ruleId));
    // Each of these is backed by a different on-demand map.
    expect(ids).toContain('bgp-route-limit');        // vifRoutes
    expect(ids).toContain('bgp-session-stability');  // bgpStability
    expect(ids).toContain('dx-failover-testing');    // vifFailoverTests
  });

  it('states the trimmed findings without the methodology prose', () => {
    const a = view('devTest');
    const recs = a.perDxGateway.flatMap((g) => g.recommendations);
    const quota = recs.find((r) => r.ruleId === 'bgp-route-limit');
    expect(quota).toBeTruthy();
    // The detail is in the VIF table on the same card now, so the description keeps the
    // fact and the action and drops how the number was measured.
    expect(quota!.description).not.toContain('ListVirtualInterfaceRoutes');
    expect(quota!.description).not.toContain('In use');
    expect(quota!.description).toMatch(/allocation/);
    expect(quota!.description.length).toBeLessThan(400);

    const prefix = recs.find((r) => r.ruleId === 'consistent-prefix-advertisement');
    expect(prefix).toBeTruthy();
    // The table right beneath it lists what each VIF does not carry, and the matrix
    // under that says which sibling carries it — so no "click Route diff" instruction.
    expect(prefix!.description).not.toContain('Click Route diff');
    expect(prefix!.description.length).toBeLessThan(400);
  });
});
