import { describe, it, expect } from 'vitest';
import { ruleSingleDxLocation, ruleSingleConnectionPerLocation } from '../resiliency-rules';
import { analyzeTopology, getRecommendedGraph, FOCUSED_PUBLIC_VIF } from '../recommendation-engine';
import { noResiliencyTopology } from '../../utils/mock-data';
import { makeEmptyTopology } from './helpers';

/**
 * A standalone public VIF is a *sink* on the AWS side (peer of a DX Gateway), not
 * a source of its own infrastructure. When the public VIF rides a connection that
 * also feeds a DXGW (or a LAG), the resiliency fix for that carrier — a redundant
 * second location / device — already provides the redundant path the public VIF
 * needs. So the public VIF must REUSE the carrier's ghost devices (adding a
 * `pub-endpoints` edge) rather than mint its own duplicate `rec-pubvif-*` chain.
 *
 * Ownership priority: LAG > DXGW > standalone public VIF.
 */

// --- DXGW rules can fan their ghost devices to the public-endpoints sink ---

describe('ruleSingleDxLocation with public-VIF sink', () => {
  function singleLocationDxgwTopology() {
    const t = makeEmptyTopology();
    t.connections = [
      { connectionId: 'c1', location: 'EqSG1', connectionState: 'available', bandwidth: '1Gbps', awsLogicalDeviceId: 'lg1', tags: {} } as any,
    ];
    t.dxGateways = [{ directConnectGatewayId: 'gw-1', directConnectGatewayName: 'My-GW', tags: {} } as any];
    return t;
  }

  it('high target: the single ghost AWS device edges to BOTH the DXGW and pub-endpoints', () => {
    const rec = ruleSingleDxLocation(singleLocationDxgwTopology(), 'high', 'gw-1', 'My-GW', true)!;
    const dxgwEdges = rec.additionalEdges.filter((e) => e.target === 'dxgw-gw-1');
    const pubEdges = rec.additionalEdges.filter((e) => e.target === 'pub-endpoints');
    expect(dxgwEdges).toHaveLength(1);
    expect(pubEdges).toHaveLength(1);
    expect(pubEdges[0].data?.label).toBe('Public VIF');
    // Both edges originate from the same ghost AWS device — no separate pubvif chain.
    expect(dxgwEdges[0].source).toBe(pubEdges[0].source);
  });

  it('maximum target: each of the two ghost AWS devices edges to pub-endpoints', () => {
    const rec = ruleSingleDxLocation(singleLocationDxgwTopology(), 'maximum', 'gw-1', 'My-GW', true)!;
    const pubEdges = rec.additionalEdges.filter((e) => e.target === 'pub-endpoints');
    expect(pubEdges).toHaveLength(2);
    expect(pubEdges.every((e) => e.data?.label === 'Public VIF')).toBe(true);
  });

  it('omitting the sink flag produces no pub-endpoints edges (unchanged default)', () => {
    const rec = ruleSingleDxLocation(singleLocationDxgwTopology(), 'high', 'gw-1', 'My-GW')!;
    expect(rec.additionalEdges.filter((e) => e.target === 'pub-endpoints')).toHaveLength(0);
  });

  it('does not mint any rec-pubvif-* nodes even when the sink is requested', () => {
    const rec = ruleSingleDxLocation(singleLocationDxgwTopology(), 'maximum', 'gw-1', 'My-GW', true)!;
    expect(rec.additionalNodes.find((n) => n.id.startsWith('rec-pubvif'))).toBeUndefined();
  });
});

describe('ruleSingleConnectionPerLocation with public-VIF sink', () => {
  it('maximum target: the extra ghost device edges to both the DXGW and pub-endpoints', () => {
    const t = makeEmptyTopology();
    t.connections = [
      { connectionId: 'c1', location: 'EqSG1', connectionState: 'available', bandwidth: '1Gbps', awsLogicalDeviceId: 'lg1', tags: {} } as any,
    ];
    t.locations = [{ locationCode: 'EqSG1', locationName: 'Equinix SG1' } as any];
    t.dxGateways = [{ directConnectGatewayId: 'gw-1', directConnectGatewayName: 'My-GW', tags: {} } as any];
    const recs = ruleSingleConnectionPerLocation(t, 'maximum', 'gw-1', true);
    expect(recs).toHaveLength(1);
    const pubEdges = recs[0].additionalEdges.filter((e) => e.target === 'pub-endpoints');
    const dxgwEdges = recs[0].additionalEdges.filter((e) => e.target === 'dxgw-gw-1');
    expect(pubEdges).toHaveLength(1);
    expect(dxgwEdges).toHaveLength(1);
    expect(pubEdges[0].source).toBe(dxgwEdges[0].source);
  });
});

// --- analyzeTopology reuse / priority behavior ---

/** Public VIF shares a connection with a DXGW's private VIF (the noResiliency shape). */
function sharedConnectionTopology(): ReturnType<typeof makeEmptyTopology> {
  const t = makeEmptyTopology();
  t.connections = [
    { connectionId: 'c1', location: 'EqSG1', connectionState: 'available', bandwidth: '1Gbps', awsLogicalDeviceId: 'lg1', tags: {} } as any,
  ];
  t.virtualInterfaces = [
    { virtualInterfaceId: 'vif-priv', virtualInterfaceType: 'private', directConnectGatewayId: 'gw-1', connectionId: 'c1', location: 'EqSG1', bgpPeers: [], tags: {} } as any,
    { virtualInterfaceId: 'vif-pub', virtualInterfaceType: 'public', connectionId: 'c1', location: 'EqSG1', bgpPeers: [], tags: {} } as any,
  ];
  t.dxGateways = [{ directConnectGatewayId: 'gw-1', directConnectGatewayName: 'My-GW', tags: {} } as any];
  return t;
}

describe('analyzeTopology — DXGW carrier reuse (no LAG)', () => {
  it('still reports a public VIF assessment with its own tier (endpoint POV)', () => {
    const result = analyzeTopology(sharedConnectionTopology());
    expect(result.publicVif).not.toBeNull();
    expect(result.publicVif!.currentLevel).toBe('devtest');
    expect(result.publicVif!.targetLevel).toBe('high');
  });

  it('does NOT mint a standalone rec-pubvif-* ghost chain when a DXGW carries the public VIF', () => {
    const result = analyzeTopology(sharedConnectionTopology());
    const pubNodes = result.publicVif!.recommendations.flatMap((r) => r.additionalNodes);
    expect(pubNodes.find((n) => n.id.startsWith('rec-pubvif'))).toBeUndefined();
  });

  it("adds a pub-endpoints edge onto the carrier DXGW's ghost devices instead", () => {
    const result = analyzeTopology(sharedConnectionTopology());
    const gw = result.perDxGateway.find((g) => g.dxGatewayId === 'gw-1')!;
    const gwEdges = gw.recommendations.flatMap((r) => r.additionalEdges);
    const pubEdges = gwEdges.filter((e) => e.target === 'pub-endpoints');
    expect(pubEdges.length).toBeGreaterThan(0);
    expect(pubEdges.every((e) => e.data?.label === 'Public VIF')).toBe(true);
  });

  it('exposes exactly one pub-endpoints target across the whole recommended graph (single sink)', () => {
    const result = analyzeTopology(sharedConnectionTopology());
    const allEdges = result.resiliency.recommendations.flatMap((r) => r.additionalEdges);
    const pubTargets = allEdges.filter((e) => e.target === 'pub-endpoints');
    // All converge on the one pub-endpoints node; none come from a rec-pubvif device.
    expect(pubTargets.length).toBeGreaterThan(0);
    expect(pubTargets.every((e) => !e.source.startsWith('rec-pubvif'))).toBe(true);
  });
});

describe('analyzeTopology — standalone public VIF (no carrier) keeps its own chain', () => {
  function standaloneOnlyTopology() {
    const t = makeEmptyTopology();
    t.connections = [
      { connectionId: 'c1', location: 'EqSG1', connectionState: 'available', bandwidth: '1Gbps', tags: {} } as any,
    ];
    t.virtualInterfaces = [
      { virtualInterfaceId: 'vif-pub', virtualInterfaceType: 'public', connectionId: 'c1', location: 'EqSG1', bgpPeers: [], tags: {} } as any,
    ];
    return t;
  }

  it('draws its own rec-pubvif-* second-location chain (fallback preserved)', () => {
    const result = analyzeTopology(standaloneOnlyTopology());
    const pubNodes = result.publicVif!.recommendations.flatMap((r) => r.additionalNodes);
    expect(pubNodes.find((n) => n.id.startsWith('rec-pubvif'))).toBeDefined();
    const pubEdges = result.publicVif!.recommendations.flatMap((r) => r.additionalEdges);
    expect(pubEdges.find((e) => e.target === 'pub-endpoints')).toBeDefined();
  });
});

describe('analyzeTopology — LAG owns the public VIF over a DXGW (priority LAG > DXGW)', () => {
  it('suppresses the standalone pubvif chain; LAG recs carry the pub-endpoints edges', () => {
    const t = makeEmptyTopology();
    t.connections = [
      { connectionId: 'c1', location: 'EqSG1', connectionState: 'available', bandwidth: '1Gbps', tags: {} } as any,
    ];
    t.lags = [
      { lagId: 'lag-1', lagName: 'LAG-A', location: 'EqSG1', lagState: 'available', connectionsBandwidth: '1Gbps', numberOfConnections: 2, minimumLinks: 1, connections: [{ connectionId: 'c1' }] } as any,
    ];
    t.locations = [{ locationCode: 'EqSG1', locationName: 'Equinix SG1' } as any];
    t.virtualInterfaces = [
      { virtualInterfaceId: 'vif-pub', virtualInterfaceType: 'public', connectionId: 'c1', location: 'EqSG1', bgpPeers: [], tags: {} } as any,
    ];
    t.dxGateways = [{ directConnectGatewayId: 'gw-1', directConnectGatewayName: 'My-GW', tags: {} } as any];

    const result = analyzeTopology(t);
    const pubNodes = result.publicVif?.recommendations.flatMap((r) => r.additionalNodes) ?? [];
    expect(pubNodes.find((n) => n.id.startsWith('rec-pubvif'))).toBeUndefined();

    const lagPubEdges = (result.lag?.recommendations ?? [])
      .flatMap((r) => r.additionalEdges)
      .filter((e) => e.target === 'pub-endpoints');
    expect(lagPubEdges.length).toBeGreaterThan(0);
  });
});

// --- Pinned to the real demo data behind the "No Resiliency" diagram ---

describe('noResiliencyTopology demo — public VIF reuses the DXGW connection', () => {
  it('mints no rec-pubvif-* ghost nodes (public VIF rides dxgw-001 via dxcon-abc001)', () => {
    const result = analyzeTopology(noResiliencyTopology);
    const pubNodes = (result.publicVif?.recommendations ?? []).flatMap((r) => r.additionalNodes);
    expect(pubNodes.find((n) => n.id.startsWith('rec-pubvif'))).toBeUndefined();
  });

  it("the dxgw-001 ghost devices carry the Public VIF edge to pub-endpoints", () => {
    const result = analyzeTopology(noResiliencyTopology);
    const gw = result.perDxGateway.find((g) => g.dxGatewayId === 'dxgw-001')!;
    const pubEdges = gw.recommendations
      .flatMap((r) => r.additionalEdges)
      .filter((e) => e.target === 'pub-endpoints');
    expect(pubEdges.length).toBeGreaterThan(0);
    expect(pubEdges.every((e) => e.data?.label === 'Public VIF')).toBe(true);
    expect(pubEdges.every((e) => !e.source.startsWith('rec-pubvif'))).toBe(true);
  });

  // Regression: selecting Maximum on the *public VIF* card must escalate the
  // carrier DXGW to Maximum too, so the focused public-VIF graph shows the full
  // ghost chain — not just the carrier's default (High) single device. Before
  // the fix, only clicking Maximum on the DXGW card produced the Max chain.
  it('Maximum on the public VIF escalates the carrier DXGW and shows the full Max chain', () => {
    const high = analyzeTopology(noResiliencyTopology, { [FOCUSED_PUBLIC_VIF]: 'high' });
    const max = analyzeTopology(noResiliencyTopology, { [FOCUSED_PUBLIC_VIF]: 'maximum' });

    // The carrier DXGW picks up the public VIF's requested tier.
    expect(high.perDxGateway.find((g) => g.dxGatewayId === 'dxgw-001')!.targetLevel).toBe('high');
    expect(max.perDxGateway.find((g) => g.dxGatewayId === 'dxgw-001')!.targetLevel).toBe('maximum');

    const pubEdges = (a: typeof max) =>
      getRecommendedGraph(a, FOCUSED_PUBLIC_VIF).edges.filter((e) => e.target === 'pub-endpoints');

    // Maximum yields strictly more pub-endpoints edges (redundant devices) than High.
    expect(pubEdges(max).length).toBeGreaterThan(pubEdges(high).length);
    // And it matches selecting Maximum directly on the DXGW card.
    const viaDxgw = analyzeTopology(noResiliencyTopology, { 'dxgw-001': 'maximum', [FOCUSED_PUBLIC_VIF]: 'maximum' });
    expect(pubEdges(max).length).toBe(pubEdges(viaDxgw).length);
  });

  // Regression: when the DXGW and the co-riding Public VIF are on DIFFERENT tiers
  // (the shared carrier is escalated to max(both)), each FOCUSED view must reflect
  // its OWN row's tier — the escalated carrier must not leak into the other row's
  // focused canvas. This is the exact bug from the 6-step toggle repro on the
  // "No Resiliency" mock: dxgw-001 and pub-endpoints ride the same connection.
  describe('mismatched DXGW / Public VIF tiers — focused view reflects its own tier', () => {
    // The mock has one real public VIF (dxvif-pub001) → one real sink to
    // pub-endpoints that is NOT a recommended edge. Total public sinks =
    // real + ghost, which is the tier-defining invariant (High=2, Max=4).
    const realPubSinks = noResiliencyTopology.virtualInterfaces.filter(
      (v) => v.virtualInterfaceType === 'public',
    ).length;
    const dxgwGhostNodes = (a: ReturnType<typeof analyzeTopology>, focus: string) =>
      getRecommendedGraph(a, focus).nodes.filter((n) => n.data.isRecommended);
    const dxgwEdges = (a: ReturnType<typeof analyzeTopology>, focus: string) =>
      getRecommendedGraph(a, focus).edges.filter((e) => e.target === 'dxgw-dxgw-001');
    const pubGhostEdges = (a: ReturnType<typeof analyzeTopology>, focus: string) =>
      getRecommendedGraph(a, focus).edges.filter((e) => e.target === 'pub-endpoints');
    const totalPubSinks = (a: ReturnType<typeof analyzeTopology>, focus: string) =>
      realPubSinks + pubGhostEdges(a, focus).length;

    // FORWARD LEAK (repro step 5): DXGW=High while Public=Maximum. Focusing the
    // DXGW must show the HIGH chain (a single second-location device), not the
    // Maximum chain the public row escalated the shared carrier to.
    it('DXGW focus shows High even when the public VIF is Maximum (forward leak)', () => {
      const a = analyzeTopology(noResiliencyTopology, { 'dxgw-001': 'high', [FOCUSED_PUBLIC_VIF]: 'maximum' });

      // High = one ghost second-location device feeding the DXGW (1 pub-less edge).
      expect(dxgwEdges(a, 'dxgw-001').length).toBe(1);
      // No public fan-out leaks into the DXGW-focused view.
      expect(pubGhostEdges(a, 'dxgw-001').length).toBe(0);

      // Strictly fewer ghost nodes than the DXGW-at-Maximum baseline.
      const maxBaseline = analyzeTopology(noResiliencyTopology, { 'dxgw-001': 'maximum', [FOCUSED_PUBLIC_VIF]: 'maximum' });
      expect(dxgwGhostNodes(a, 'dxgw-001').length)
        .toBeLessThan(dxgwGhostNodes(maxBaseline, 'dxgw-001').length);
    });

    // The public row is independently still Maximum in that same assessment.
    it('Public focus stays Maximum even when the DXGW is High', () => {
      const a = analyzeTopology(noResiliencyTopology, { 'dxgw-001': 'high', [FOCUSED_PUBLIC_VIF]: 'maximum' });
      // Maximum public target = 4 total upstream links (real + ghost).
      expect(totalPubSinks(a, FOCUSED_PUBLIC_VIF)).toBe(4);
      // And no private DXGW fan-out leaks into the public-focused view.
      expect(dxgwEdges(a, FOCUSED_PUBLIC_VIF).length).toBe(0);
    });

    // REVERSE LEAK (repro step 3): DXGW=Maximum while Public=High. Focusing the
    // public row must show the HIGH public chain (2 total sinks), not the Maximum
    // carrier the DXGW row escalated the shared devices to.
    it('Public focus shows High even when the DXGW is Maximum (reverse leak)', () => {
      const a = analyzeTopology(noResiliencyTopology, { 'dxgw-001': 'maximum', [FOCUSED_PUBLIC_VIF]: 'high' });

      // High public target = 2 total upstream links (real + ghost).
      expect(totalPubSinks(a, FOCUSED_PUBLIC_VIF)).toBe(2);
      // No private DXGW fan-out leaks into the public-focused view.
      expect(dxgwEdges(a, FOCUSED_PUBLIC_VIF).length).toBe(0);

      // Strictly fewer public sinks than the public-at-Maximum baseline.
      const maxBaseline = analyzeTopology(noResiliencyTopology, { 'dxgw-001': 'maximum', [FOCUSED_PUBLIC_VIF]: 'maximum' });
      expect(totalPubSinks(a, FOCUSED_PUBLIC_VIF))
        .toBeLessThan(totalPubSinks(maxBaseline, FOCUSED_PUBLIC_VIF));
    });

    // The DXGW row is independently still Maximum in that same assessment.
    it('DXGW focus stays Maximum even when the public VIF is High', () => {
      const a = analyzeTopology(noResiliencyTopology, { 'dxgw-001': 'maximum', [FOCUSED_PUBLIC_VIF]: 'high' });
      expect(dxgwEdges(a, 'dxgw-001').length).toBe(3); // Max: second-loc pair + existing-loc extra device
      expect(pubGhostEdges(a, 'dxgw-001').length).toBe(0);
    });

    // VIEW-ALL is unchanged: the shared carrier is still drawn at the escalated
    // max(both) tier and fans out to BOTH sinks (no double-render, no under-draw).
    it('view-all still renders the escalated shared carrier to both sinks', () => {
      const a = analyzeTopology(noResiliencyTopology, { 'dxgw-001': 'high', [FOCUSED_PUBLIC_VIF]: 'maximum' });
      const all = getRecommendedGraph(a, null);
      // Escalated to Maximum → 3 devices fan to the DXGW AND 3 to pub-endpoints.
      expect(all.edges.filter((e) => e.target === 'dxgw-dxgw-001').length).toBe(3);
      expect(all.edges.filter((e) => e.target === 'pub-endpoints').length).toBe(3);
    });
  });
});
