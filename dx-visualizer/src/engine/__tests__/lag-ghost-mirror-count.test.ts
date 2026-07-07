import { describe, it, expect } from 'vitest';
import { analyzeTopology, FOCUSED_LAG } from '../recommendation-engine';
import { lagDeviceGhost, ghostLagEdges } from '../ghost-chains';
import { getSinkConnectedDevices, lagMemberCount } from '../sla-gating';
import { makeEmptyTopology } from './helpers';
import type { TopologyData, DxEdge } from '../../types/topology';
import type { DxLag, DxConnection, DxVirtualInterface } from '../../types/aws-resources';

/**
 * GHOST LAG SHAPE MIRRORS THE NEIGHBOURING REAL LAG'S CONNECTION COUNT
 * ===================================================================
 *
 * A recommended (ghost) LAG must draw the SAME number of member connections as
 * the real LAG it mirrors — a 4-connection LAG neighbour yields a 4-line ghost,
 * a 2-connection neighbour yields a 2-line ghost. Previously every ghost LAG
 * was hardcoded to 2 connections regardless of the real topology.
 *
 * A ghost LAG has no individual member connections to name, so its count
 * surfaces on the labels of a SINGLE partner→LAG edge ("N DX Connections") and
 * the LAG→awsDevice edge ("LAG Bundle\nN connections") — unlike a real LAG,
 * whose customer side fans into one named line per member.
 */

// ---- fixture helpers -------------------------------------------------------

function conn(id: string, location: string, device: string, lagId?: string): DxConnection {
  return {
    connectionId: id, connectionName: id, connectionState: 'available',
    location, bandwidth: '1Gbps', region: 'ap-southeast-1',
    awsLogicalDeviceId: device, ...(lagId ? { lagId } : {}),
  };
}

function lag(lagId: string, location: string, numberOfConnections: number, members: DxConnection[] = []): DxLag {
  return {
    lagId, lagName: lagId, connectionsBandwidth: '1Gbps', numberOfConnections,
    minimumLinks: 0, location, region: 'ap-southeast-1', lagState: 'available',
    connections: members,
  };
}

function pvif(id: string, connectionId: string, dxGatewayId: string, vlan: number, location: string): DxVirtualInterface {
  return {
    virtualInterfaceId: id, virtualInterfaceName: id, virtualInterfaceType: 'private',
    virtualInterfaceState: 'available', connectionId, directConnectGatewayId: dxGatewayId,
    vlan, asn: 1, bgpPeers: [], region: 'ap-southeast-1', location,
  };
}

/** All ghost edges across every recommendation surface of the assessment. */
function allGhostEdges(a: ReturnType<typeof analyzeTopology>): DxEdge[] {
  const edges: DxEdge[] = [];
  const push = (recs?: { additionalEdges: DxEdge[] }[]) => {
    for (const r of recs ?? []) edges.push(...r.additionalEdges);
  };
  push(a.resiliency?.recommendations);
  push(a.lag?.recommendations);
  push(a.publicVif?.recommendations);
  for (const g of a.perDxGateway ?? []) push(g.recommendations);
  return edges;
}

/**
 * Ghost LAG connection counts keyed by the ghost LAG node id, parsed from the
 * "N DX Connections" label on the single partner→LAG edge into each ghost LAG.
 */
function ghostLagFanCounts(edges: DxEdge[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of edges) {
    if (!e.data?.isRecommended) continue;
    // The customer-side edge targets a ghost `lag` node and is labelled "N DX Connections".
    if (!/(?:^|-)lag-|-lag$/.test(e.target)) continue;
    const m = /^(\d+) DX Connections$/.exec((e.data?.label as string) ?? '');
    if (m) out.set(e.target, Math.max(out.get(e.target) ?? 0, Number(m[1])));
  }
  return out;
}

// ===========================================================================
// ghostLagEdges — the shared builder
// ===========================================================================
describe('ghostLagEdges', () => {
  it('emits ONE grouped partner→LAG edge and a matching bundle label', () => {
    const edges = ghostLagEdges('p', 'l', 'a', 4);
    const fan = edges.filter((e) => e.source === 'p' && e.target === 'l');
    expect(fan).toHaveLength(1);
    expect(fan[0].data?.label).toBe('4 DX Connections');
    expect(fan[0].data?.parallelCount).toBeUndefined(); // no per-member fan
    const bundle = edges.find((e) => e.source === 'l' && e.target === 'a');
    expect(bundle?.data?.label).toBe('LAG Bundle\n4 connections');
  });

  it('clamps a sub-2 count up to 2 (a LAG is at least two connections)', () => {
    const edges = ghostLagEdges('p', 'l', 'a', 1);
    expect(edges.find((e) => e.target === 'l')?.data?.label).toBe('2 DX Connections');
    expect(edges.find((e) => e.source === 'l')?.data?.label).toBe('LAG Bundle\n2 connections');
  });

  it('lagDeviceGhost carries the member count through', () => {
    const { edges } = lagDeviceGhost({ prefix: 'rec', location: 'X', sinks: [], memberCount: 3 });
    const fan = edges.filter((e) => /-lag-/.test(e.target));
    expect(fan).toHaveLength(1);
    expect(fan[0].data?.label).toBe('3 DX Connections');
  });

  it('lagDeviceGhost defaults to 2 when no count is given', () => {
    const { edges } = lagDeviceGhost({ prefix: 'rec', location: 'X', sinks: [] });
    const fan = edges.filter((e) => /-lag-/.test(e.target));
    expect(fan).toHaveLength(1);
    expect(fan[0].data?.label).toBe('2 DX Connections');
  });
});

// ===========================================================================
// sla-gating exposes the mirrored count
// ===========================================================================
describe('getSinkConnectedDevices lagMemberCount', () => {
  it('reports the sink-connected LAG member count per location (largest when several)', () => {
    const t = makeEmptyTopology();
    t.locations = [{ locationCode: 'L', locationName: 'L', region: 'ap-southeast-1', availablePortSpeeds: [] }];
    const m1 = conn('c1', 'L', 'dev1', 'lag4');
    const m2 = conn('c2', 'L', 'dev2', 'lag2');
    t.connections = [m1, m2];
    t.lags = [lag('lag4', 'L', 4, [m1]), lag('lag2', 'L', 2, [m2])];
    t.virtualInterfaces = [pvif('v1', 'c1', 'gw1', 1, 'L'), pvif('v2', 'c2', 'gw1', 2, 'L')];

    const info = getSinkConnectedDevices(t).get('L');
    expect(info?.hasLag).toBe(true);
    expect(info?.lagMemberCount).toBe(4); // largest of {4, 2}
  });

  it('reports 0 for a plain (non-LAG) sink location', () => {
    const t = makeEmptyTopology();
    t.locations = [{ locationCode: 'L', locationName: 'L', region: 'ap-southeast-1', availablePortSpeeds: [] }];
    t.connections = [conn('c1', 'L', 'dev1')];
    t.virtualInterfaces = [pvif('v1', 'c1', 'gw1', 1, 'L')];
    const info = getSinkConnectedDevices(t).get('L');
    expect(info?.hasLag).toBe(false);
    expect(info?.lagMemberCount).toBe(0);
  });

  it('lagMemberCount falls back to member array then 2', () => {
    expect(lagMemberCount(lag('a', 'L', 5))).toBe(5);
    expect(lagMemberCount(lag('a', 'L', 0, [conn('c1', 'L', 'd'), conn('c2', 'L', 'd')]))).toBe(2);
    expect(lagMemberCount(lag('a', 'L', 0, []))).toBe(2);
  });
});

// ===========================================================================
// Device-gap ghost mirrors each location's own LAG count (the demo shape)
// ===========================================================================
describe('device-gap ghost mirrors the location LAG count', () => {
  it('draws a 4-line ghost at the 4-LAG location and a 2-line ghost at the 2-LAG location', () => {
    // Two DX locations, each reaching gw1 via a single LAG of a different size.
    // Maximum target → each location is device-gapped and gets a redundant ghost
    // LAG mirroring its own real LAG's member count.
    const t = makeEmptyTopology();
    t.locations = [
      { locationCode: 'SG2', locationName: 'SG2', region: 'ap-southeast-1', availablePortSpeeds: [] },
      { locationCode: 'SG3', locationName: 'SG3', region: 'ap-southeast-1', availablePortSpeeds: [] },
    ];
    const a1 = conn('a1', 'SG2', 'devSG2', 'lag4');
    const b1 = conn('b1', 'SG3', 'devSG3', 'lag2');
    t.connections = [a1, b1];
    t.lags = [lag('lag4', 'SG2', 4, [a1]), lag('lag2', 'SG3', 2, [b1])];
    t.virtualInterfaces = [pvif('v1', 'a1', 'gw1', 10, 'SG2'), pvif('v2', 'b1', 'gw1', 20, 'SG3')];
    t.dxGateways = [{ directConnectGatewayId: 'gw1', directConnectGatewayName: 'GW1', amazonSideAsn: 64512, directConnectGatewayState: 'available' }];

    const a = analyzeTopology(t, { [FOCUSED_LAG]: 'maximum' });
    const fans = ghostLagFanCounts(allGhostEdges(a));

    const countsByLoc = new Map<string, number>();
    // Ghost LAG ids embed the location: `...-lag-SG2-2` / `...-lag-SG3-2`.
    for (const [lagId, pc] of fans) {
      if (lagId.includes('-lag-SG2')) countsByLoc.set('SG2', pc);
      if (lagId.includes('-lag-SG3')) countsByLoc.set('SG3', pc);
    }
    expect(countsByLoc.get('SG2')).toBe(4);
    expect(countsByLoc.get('SG3')).toBe(2);
  });
});

// ===========================================================================
// Second-location minted ghost mirrors the source location's LAG(s)
// ===========================================================================
describe('minted second-location ghost mirrors the source LAG count', () => {
  function singleLocationTwoLagTopo(): TopologyData {
    // ONE DX location running TWO LAGs (3 and 2 connections). The second
    // location is empty (minted). No other reusable sink location exists.
    const t = makeEmptyTopology();
    t.locations = [{ locationCode: 'LocA', locationName: 'A', region: 'ap-southeast-1', availablePortSpeeds: [] }];
    const c3 = conn('c3', 'LocA', 'devA1', 'lag3');
    const c2 = conn('c2', 'LocA', 'devA2', 'lag2');
    t.connections = [c3, c2];
    t.lags = [lag('lag3', 'LocA', 3, [c3]), lag('lag2', 'LocA', 2, [c2])];
    t.virtualInterfaces = [pvif('v3', 'c3', 'gw1', 1, 'LocA'), pvif('v2', 'c2', 'gw1', 2, 'LocA')];
    t.dxGateways = [{ directConnectGatewayId: 'gw1', directConnectGatewayName: 'GW1', amazonSideAsn: 64512, directConnectGatewayState: 'available' }];
    return t;
  }

  it('HIGH → single ghost LAG at the LARGEST source count (3)', () => {
    const a = analyzeTopology(singleLocationTwoLagTopo(), { [FOCUSED_LAG]: 'high' });
    const counts = [...ghostLagFanCounts(allGhostEdges(a)).values()].sort((x, y) => y - x);
    expect(counts.length).toBeGreaterThan(0);
    expect(counts[0]).toBe(3);        // largest
    expect(counts).not.toContain(2);  // High mints only ONE path (no second-largest)
  });

  it('MAX → two ghost LAGs mirroring BOTH source counts (3 and 2)', () => {
    const a = analyzeTopology(singleLocationTwoLagTopo(), { [FOCUSED_LAG]: 'maximum' });
    const counts = [...ghostLagFanCounts(allGhostEdges(a)).values()].sort((x, y) => y - x);
    expect(counts).toContain(3);
    expect(counts).toContain(2);
  });

  it('single source LAG of 4 → minted second-location ghost draws 4', () => {
    const t = makeEmptyTopology();
    t.locations = [{ locationCode: 'LocA', locationName: 'A', region: 'ap-southeast-1', availablePortSpeeds: [] }];
    const c4 = conn('c4', 'LocA', 'devA1', 'lag4');
    t.connections = [c4];
    t.lags = [lag('lag4', 'LocA', 4, [c4])];
    t.virtualInterfaces = [pvif('v4', 'c4', 'gw1', 1, 'LocA')];
    t.dxGateways = [{ directConnectGatewayId: 'gw1', directConnectGatewayName: 'GW1', amazonSideAsn: 64512, directConnectGatewayState: 'available' }];

    const a = analyzeTopology(t, { [FOCUSED_LAG]: 'high' });
    const counts = [...ghostLagFanCounts(allGhostEdges(a)).values()];
    expect(counts.length).toBeGreaterThan(0);
    expect(counts.every((c) => c === 4)).toBe(true);
  });
});

// ===========================================================================
// Non-LAG shapes are unaffected
// ===========================================================================
describe('mirroring does not disturb plain shapes', () => {
  it('a plain (non-LAG) reuse location stays plain — no ghost LAG fan', () => {
    // LocA runs a LAG (scope); LocB has a single PLAIN sink device to reuse.
    const t = makeEmptyTopology();
    t.locations = [
      { locationCode: 'LocA', locationName: 'A', region: 'ap-southeast-1', availablePortSpeeds: [] },
      { locationCode: 'LocB', locationName: 'B', region: 'ap-southeast-1', availablePortSpeeds: [] },
    ];
    const cA = conn('cA', 'LocA', 'devA1', 'lagA');
    const cB = conn('cB', 'LocB', 'devB1');
    t.connections = [cA, cB];
    t.lags = [lag('lagA', 'LocA', 3, [cA])];
    t.virtualInterfaces = [pvif('vA', 'cA', 'gw1', 1, 'LocA'), pvif('vB', 'cB', 'gw1', 2, 'LocB')];
    t.dxGateways = [{ directConnectGatewayId: 'gw1', directConnectGatewayName: 'GW1', amazonSideAsn: 64512, directConnectGatewayState: 'available' }];

    const a = analyzeTopology(t, { [FOCUSED_LAG]: 'maximum' });
    const edges = allGhostEdges(a);
    // The ghost at LocB is plain: no ghost LAG node exists there, so no edge
    // targets a `-lag-LocB` node and no "N DX Connections" label mentions LocB.
    const locBLagEdges = edges.filter(
      (e) => /-lag-LocB/.test(e.target) || / DX Connections$/.test((e.data?.label as string) ?? '') && e.target.includes('LocB'),
    );
    expect(locBLagEdges).toEqual([]);
  });
});
