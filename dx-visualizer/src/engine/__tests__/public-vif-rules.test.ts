import { describe, it, expect } from 'vitest';
import {
  rulePublicVifSingleLocation,
  rulePublicVifSingleConnectionPerLocation,
  rulePublicVifCarriedMaxGap,
} from '../public-vif-rules';
import { analyzeTopology } from '../recommendation-engine';
import { makeEmptyTopology } from './helpers';
import type { DxNode, TopologyData } from '../../types/topology';

const locOf = (n: DxNode): string =>
  (n.data.details as Record<string, string> | undefined)?.locationCode ?? '';

describe('rulePublicVifSingleLocation', () => {
  it('returns null when no connections or VIFs exist', () => {
    expect(rulePublicVifSingleLocation(makeEmptyTopology())).toBeNull();
  });

  it('returns recommendation when only one location is used', () => {
    const t = makeEmptyTopology();
    t.connections = [
      { connectionId: 'c1', connectionName: 'conn-1', location: 'EqSG1', connectionState: 'available', bandwidth: '1Gbps', tags: {} } as any,
    ];
    const rec = rulePublicVifSingleLocation(t);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('pubvif-single-dx-location');
    expect(rec!.severity).toBe('info');
    expect(rec!.title).toContain('Public VIF');
    expect(rec!.additionalNodes.length).toBeGreaterThan(0);
  });

  it('returns null when two locations are used', () => {
    const t = makeEmptyTopology();
    t.connections = [
      { connectionId: 'c1', location: 'EqSG1', connectionState: 'available', bandwidth: '1Gbps', tags: {} } as any,
      { connectionId: 'c2', location: 'EqSG2', connectionState: 'available', bandwidth: '1Gbps', tags: {} } as any,
    ];
    expect(rulePublicVifSingleLocation(t)).toBeNull();
  });

  it('falls back to VIF locations when connections have no location', () => {
    const t = makeEmptyTopology();
    t.virtualInterfaces = [
      { virtualInterfaceId: 'v1', location: 'EqSG1', bgpPeers: [], tags: {} } as any,
    ];
    const rec = rulePublicVifSingleLocation(t);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('pubvif-single-dx-location');
  });

  it('ghost edges point to pub-endpoints node', () => {
    const t = makeEmptyTopology();
    t.connections = [
      { connectionId: 'c1', location: 'EqSG1', connectionState: 'available', bandwidth: '1Gbps', tags: {} } as any,
    ];
    const rec = rulePublicVifSingleLocation(t)!;
    const edgeToPub = rec.additionalEdges.find((e) => e.target === 'pub-endpoints');
    expect(edgeToPub).toBeDefined();
    expect(edgeToPub!.data?.label).toBe('Public VIF');
  });

  it('for high target, second location gets 1 connection (3 ghost nodes)', () => {
    const t = makeEmptyTopology();
    t.connections = [
      { connectionId: 'c1', location: 'EqSG1', connectionState: 'available', bandwidth: '1Gbps', tags: {} } as any,
    ];
    const rec = rulePublicVifSingleLocation(t, 'high')!;
    // dxLocation + partner + awsdev = 3 (chain starts at the partner device).
    expect(rec.additionalNodes).toHaveLength(3);
    expect(rec.additionalNodes.find((n) => n.id === 'rec-pubvif-custsite-B')).toBeUndefined();
    expect(rec.additionalNodes.find((n) => n.id === 'rec-pubvif-onprem-B')).toBeUndefined();
  });

  it('for maximum target, second location gets 2 connections (5 ghost nodes)', () => {
    const t = makeEmptyTopology();
    t.connections = [
      { connectionId: 'c1', location: 'EqSG1', connectionState: 'available', bandwidth: '1Gbps', tags: {} } as any,
    ];
    const rec = rulePublicVifSingleLocation(t, 'maximum')!;
    expect(rec.additionalNodes).toHaveLength(5);
    expect(rec.additionalNodes.find((n) => n.id === 'rec-pubvif-partner-B-2')).toBeDefined();
    expect(rec.additionalNodes.find((n) => n.id === 'rec-pubvif-awsdev-B-2')).toBeDefined();
    // Both extra edges should also point to pub-endpoints
    const pubEdges = rec.additionalEdges.filter((e) => e.target === 'pub-endpoints');
    expect(pubEdges).toHaveLength(2);
  });
});

describe('rulePublicVifSingleConnectionPerLocation', () => {
  it('returns empty array for high target', () => {
    const t = makeEmptyTopology();
    t.connections = [
      { connectionId: 'c1', location: 'EqSG1', connectionState: 'available', bandwidth: '1Gbps', tags: {} } as any,
    ];
    expect(rulePublicVifSingleConnectionPerLocation(t, 'high')).toEqual([]);
  });

  it('returns empty array when no connections exist', () => {
    expect(rulePublicVifSingleConnectionPerLocation(makeEmptyTopology(), 'maximum')).toEqual([]);
  });

  it('returns recommendation for location with single connection (maximum target)', () => {
    const t = makeEmptyTopology();
    t.connections = [
      { connectionId: 'c1', location: 'EqSG1', connectionState: 'available', bandwidth: '1Gbps', tags: {} } as any,
    ];
    t.locations = [{ locationCode: 'EqSG1', locationName: 'Equinix SG1' } as any];
    const recs = rulePublicVifSingleConnectionPerLocation(t, 'maximum');
    expect(recs).toHaveLength(1);
    expect(recs[0].title).toContain('Equinix SG1');
    expect(recs[0].title).toContain('Public VIF');
    expect(recs[0].ruleId).toBe('pubvif-single-connection-per-location');
  });

  it('returns no recommendation for location with two devices', () => {
    const t = makeEmptyTopology();
    t.connections = [
      { connectionId: 'c1', location: 'EqSG1', connectionState: 'available', bandwidth: '1Gbps', awsLogicalDeviceId: 'dev-1', tags: {} } as any,
      { connectionId: 'c2', location: 'EqSG1', connectionState: 'available', bandwidth: '1Gbps', awsLogicalDeviceId: 'dev-2', tags: {} } as any,
    ];
    expect(rulePublicVifSingleConnectionPerLocation(t, 'maximum')).toEqual([]);
  });

  it('ghost edges point to pub-endpoints node', () => {
    const t = makeEmptyTopology();
    t.connections = [
      { connectionId: 'c1', location: 'EqSG1', connectionState: 'available', bandwidth: '1Gbps', tags: {} } as any,
    ];
    t.locations = [{ locationCode: 'EqSG1', locationName: 'Equinix SG1' } as any];
    const recs = rulePublicVifSingleConnectionPerLocation(t, 'maximum');
    const edgeToPub = recs[0].additionalEdges.find((e) => e.target === 'pub-endpoints');
    expect(edgeToPub).toBeDefined();
  });

  it('returns one recommendation per single-device location', () => {
    const t = makeEmptyTopology();
    t.connections = [
      { connectionId: 'c1', location: 'EqSG1', connectionState: 'available', bandwidth: '1Gbps', tags: {} } as any,
      { connectionId: 'c2', location: 'EqSG2', connectionState: 'available', bandwidth: '1Gbps', tags: {} } as any,
    ];
    const recs = rulePublicVifSingleConnectionPerLocation(t, 'maximum');
    expect(recs).toHaveLength(2);
  });
});

describe('analyzeTopology with public VIFs', () => {
  it('produces publicVif assessment when standalone public VIFs exist', () => {
    const t = makeEmptyTopology();
    t.connections = [
      { connectionId: 'c1', location: 'EqSG1', connectionState: 'available', bandwidth: '1Gbps', tags: {} } as any,
    ];
    t.virtualInterfaces = [
      {
        virtualInterfaceId: 'vif-1',
        virtualInterfaceType: 'public',
        connectionId: 'c1',
        location: 'EqSG1',
        bgpPeers: [],
        tags: {},
      } as any,
    ];
    const result = analyzeTopology(t);
    expect(result.publicVif).not.toBeNull();
    expect(result.publicVif!.currentLevel).toBe('devtest');
    expect(result.publicVif!.locationCount).toBe(1);
    expect(result.publicVif!.recommendations.length).toBeGreaterThan(0);
  });

  it('publicVif is null when no standalone public VIFs exist', () => {
    const t = makeEmptyTopology();
    t.connections = [
      { connectionId: 'c1', location: 'EqSG1', connectionState: 'available', bandwidth: '1Gbps', tags: {} } as any,
    ];
    t.virtualInterfaces = [
      {
        virtualInterfaceId: 'vif-1',
        virtualInterfaceType: 'private',
        directConnectGatewayId: 'dxgw-1',
        connectionId: 'c1',
        location: 'EqSG1',
        bgpPeers: [],
        tags: {},
      } as any,
    ];
    t.dxGateways = [{ directConnectGatewayId: 'dxgw-1', directConnectGatewayName: 'my-gw', tags: {} } as any];
    t.dxGatewayAssociations = [];
    const result = analyzeTopology(t);
    expect(result.publicVif).toBeNull();
  });

  it('publicVif is null when public VIF has a DXGW', () => {
    const t = makeEmptyTopology();
    t.connections = [
      { connectionId: 'c1', location: 'EqSG1', connectionState: 'available', bandwidth: '1Gbps', tags: {} } as any,
    ];
    t.virtualInterfaces = [
      {
        virtualInterfaceId: 'vif-1',
        virtualInterfaceType: 'public',
        directConnectGatewayId: 'dxgw-1',
        connectionId: 'c1',
        location: 'EqSG1',
        bgpPeers: [],
        tags: {},
      } as any,
    ];
    t.dxGateways = [{ directConnectGatewayId: 'dxgw-1', directConnectGatewayName: 'my-gw', tags: {} } as any];
    t.dxGatewayAssociations = [];
    const result = analyzeTopology(t);
    expect(result.publicVif).toBeNull();
  });

  it('achieves high resiliency with 2 locations', () => {
    const t = makeEmptyTopology();
    t.connections = [
      { connectionId: 'c1', location: 'EqSG1', connectionState: 'available', bandwidth: '1Gbps', tags: {} } as any,
      { connectionId: 'c2', location: 'EqSG2', connectionState: 'available', bandwidth: '1Gbps', tags: {} } as any,
    ];
    t.virtualInterfaces = [
      { virtualInterfaceId: 'vif-1', virtualInterfaceType: 'public', connectionId: 'c1', location: 'EqSG1', bgpPeers: [], tags: {} } as any,
      { virtualInterfaceId: 'vif-2', virtualInterfaceType: 'public', connectionId: 'c2', location: 'EqSG2', bgpPeers: [], tags: {} } as any,
    ];
    const result = analyzeTopology(t);
    expect(result.publicVif).not.toBeNull();
    expect(result.publicVif!.currentLevel).toBe('high');
  });

  it('achieves maximum resiliency with 2 locations and 2 devices each', () => {
    const t = makeEmptyTopology();
    t.connections = [
      { connectionId: 'c1', location: 'EqSG1', connectionState: 'available', bandwidth: '1Gbps', awsLogicalDeviceId: 'dev-1', tags: {} } as any,
      { connectionId: 'c2', location: 'EqSG1', connectionState: 'available', bandwidth: '1Gbps', awsLogicalDeviceId: 'dev-2', tags: {} } as any,
      { connectionId: 'c3', location: 'EqSG2', connectionState: 'available', bandwidth: '1Gbps', awsLogicalDeviceId: 'dev-3', tags: {} } as any,
      { connectionId: 'c4', location: 'EqSG2', connectionState: 'available', bandwidth: '1Gbps', awsLogicalDeviceId: 'dev-4', tags: {} } as any,
    ];
    t.virtualInterfaces = [
      { virtualInterfaceId: 'vif-1', virtualInterfaceType: 'public', connectionId: 'c1', location: 'EqSG1', bgpPeers: [], tags: {} } as any,
      { virtualInterfaceId: 'vif-2', virtualInterfaceType: 'public', connectionId: 'c2', location: 'EqSG1', bgpPeers: [], tags: {} } as any,
      { virtualInterfaceId: 'vif-3', virtualInterfaceType: 'public', connectionId: 'c3', location: 'EqSG2', bgpPeers: [], tags: {} } as any,
      { virtualInterfaceId: 'vif-4', virtualInterfaceType: 'public', connectionId: 'c4', location: 'EqSG2', bgpPeers: [], tags: {} } as any,
    ];
    const result = analyzeTopology(t);
    expect(result.publicVif).not.toBeNull();
    expect(result.publicVif!.currentLevel).toBe('maximum');
    expect(result.publicVif!.recommendations).toHaveLength(0);
  });

  it('includes public VIF recommendations in aggregate resiliency list', () => {
    const t = makeEmptyTopology();
    t.connections = [
      { connectionId: 'c1', location: 'EqSG1', connectionState: 'available', bandwidth: '1Gbps', tags: {} } as any,
    ];
    t.virtualInterfaces = [
      { virtualInterfaceId: 'vif-1', virtualInterfaceType: 'public', connectionId: 'c1', location: 'EqSG1', bgpPeers: [], tags: {} } as any,
    ];
    const result = analyzeTopology(t);
    const pubRec = result.resiliency.recommendations.find((r) => r.ruleId === 'pubvif-single-dx-location');
    expect(pubRec).toBeDefined();
  });
});

describe('rulePublicVifCarriedMaxGap — candidate priority by target', () => {
  // A DXGW-carried public VIF: one public VIF rides the DXGW connection at LocA,
  // and a SECOND real DX location (LocB) feeds the DXGW but carries no public VIF
  // yet. The public endpoint is at High/devtest and needs a redundant path.
  function makeCarriedTopology(): TopologyData {
    const t = makeEmptyTopology();
    t.locations = [
      { locationCode: 'LocA', locationName: 'Location A' } as any,
      { locationCode: 'LocB', locationName: 'Location B' } as any,
    ];
    t.dxGateways = [{ directConnectGatewayId: 'dxgw-1', directConnectGatewayName: 'gw', tags: {} } as any];
    t.dxGatewayAssociations = [];
    t.connections = [
      { connectionId: 'cA', location: 'LocA', connectionState: 'available', bandwidth: '1Gbps', awsLogicalDeviceId: 'devA', tags: {} } as any,
      { connectionId: 'cB', location: 'LocB', connectionState: 'available', bandwidth: '1Gbps', awsLogicalDeviceId: 'devB', tags: {} } as any,
    ];
    t.virtualInterfaces = [
      // LocA carries both a DXGW private VIF and the public VIF (public is carried).
      { virtualInterfaceId: 'vA-priv', virtualInterfaceType: 'private', directConnectGatewayId: 'dxgw-1', connectionId: 'cA', location: 'LocA', bgpPeers: [], tags: {} } as any,
      { virtualInterfaceId: 'vA-pub', virtualInterfaceType: 'public', connectionId: 'cA', location: 'LocA', bgpPeers: [], tags: {} } as any,
      // LocB carries only a DXGW private VIF — no public path here yet.
      { virtualInterfaceId: 'vB-priv', virtualInterfaceType: 'private', directConnectGatewayId: 'dxgw-1', connectionId: 'cB', location: 'LocB', bgpPeers: [], tags: {} } as any,
    ];
    return t;
  }

  // The reported bug: a High shortfall of 1 must pick the SECOND location (LocB),
  // not a same-location device path at LocA. Site redundancy is the High-tier goal.
  it('a High shortfall of 1 mints a path at the SECOND location, not a same-site device', () => {
    const recs = rulePublicVifCarriedMaxGap(makeCarriedTopology(), 'high', 1);
    expect(recs).toHaveLength(1);
    const locs = recs[0].additionalNodes.map(locOf).filter(Boolean);
    expect(locs.every((l) => l === 'LocB')).toBe(true);
    expect(locs).not.toContain('LocA');
    // Description reflects the High tier (not a hardcoded Maximum) and the site goal.
    expect(recs[0].description).toContain('High Resiliency (99.9% SLA)');
    expect(recs[0].description).toContain('second Direct Connect location');
  });

  // Toggling High → Max → High must land back on the exact same High result — the
  // engine is pure per-call, so the round-trip is byte-identical.
  it('High is stable across a High→Max→High toggle', () => {
    const t = makeCarriedTopology();
    const high1 = rulePublicVifCarriedMaxGap(t, 'high', 1);
    rulePublicVifCarriedMaxGap(t, 'maximum', 3); // intervening Max evaluation
    const high2 = rulePublicVifCarriedMaxGap(t, 'high', 1);
    expect(high2.map((r) => r.id)).toEqual(high1.map((r) => r.id));
    expect(high2[0].additionalNodes.map(locOf).filter(Boolean)).toContain('LocB');
  });

  // At Max the shortfall covers both the second-site AND same-location device
  // paths, so both locations must appear regardless of ordering.
  it('Max spans both the second location and same-site device redundancy', () => {
    const recs = rulePublicVifCarriedMaxGap(makeCarriedTopology(), 'maximum', 2);
    const locs = new Set(recs.flatMap((r) => r.additionalNodes.map(locOf).filter(Boolean)));
    expect(locs.has('LocA')).toBe(true);
    expect(locs.has('LocB')).toBe(true);
  });
});
