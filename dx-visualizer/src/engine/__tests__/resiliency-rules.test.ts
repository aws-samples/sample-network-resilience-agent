import { describe, it, expect } from 'vitest';
import {
  ruleSingleDxLocation,
  ruleSingleConnectionPerLocation,
  ruleNoTgw,
  ruleSingleVgw,
  ruleNoLag,
  ruleLagResiliency,
} from '../resiliency-rules';
import { makeEmptyTopology } from './helpers';

describe('ruleSingleDxLocation', () => {
  it('returns null when no connections or VIFs exist', () => {
    expect(ruleSingleDxLocation(makeEmptyTopology())).toBeNull();
  });

  it('returns recommendation when only one location is used', () => {
    const t = makeEmptyTopology();
    t.connections = [
      { connectionId: 'c1', connectionName: 'conn-1', location: 'EqDC2', connectionState: 'available', bandwidth: '1Gbps', tags: {} } as any,
    ];
    const rec = ruleSingleDxLocation(t);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('single-dx-location');
    // Tier-gap recommendations are advisory — upgrading to High/Max is a
    // product decision. Only actual faults (VIF/connection down) stay 'critical'.
    expect(rec!.severity).toBe('info');
    expect(rec!.additionalNodes.length).toBeGreaterThan(0);
  });

  it('returns null when two locations are used', () => {
    const t = makeEmptyTopology();
    t.connections = [
      { connectionId: 'c1', connectionName: 'conn-1', location: 'EqDC2', connectionState: 'available', bandwidth: '1Gbps', tags: {} } as any,
      { connectionId: 'c2', connectionName: 'conn-2', location: 'EqDC6', connectionState: 'available', bandwidth: '1Gbps', tags: {} } as any,
    ];
    expect(ruleSingleDxLocation(t)).toBeNull();
  });

  it('falls back to VIF locations when connections have no location', () => {
    const t = makeEmptyTopology();
    t.virtualInterfaces = [
      { virtualInterfaceId: 'v1', virtualInterfaceName: 'vif-1', location: 'EqDC2', bgpPeers: [], tags: {} } as any,
    ];
    const rec = ruleSingleDxLocation(t);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('single-dx-location');
  });

  it('adds edge to DX Gateway when one exists', () => {
    const t = makeEmptyTopology();
    t.connections = [
      { connectionId: 'c1', connectionName: 'conn-1', location: 'EqDC2', connectionState: 'available', bandwidth: '1Gbps', tags: {} } as any,
    ];
    t.dxGateways = [{ directConnectGatewayId: 'gw-123', directConnectGatewayName: 'my-gw', tags: {} } as any];
    const rec = ruleSingleDxLocation(t)!;
    const edgeToGw = rec.additionalEdges.find((e) => e.target === 'dxgw-gw-123');
    expect(edgeToGw).toBeDefined();
  });
});

describe('ruleSingleConnectionPerLocation', () => {
  it('returns empty array for "high" target (only Maximum needs redundant connections)', () => {
    const t = makeEmptyTopology();
    t.connections = [
      { connectionId: 'c1', location: 'EqDC2', connectionState: 'available', bandwidth: '1Gbps', tags: {} } as any,
    ];
    expect(ruleSingleConnectionPerLocation(t, 'high')).toEqual([]);
  });

  it('returns empty array when no connections exist', () => {
    expect(ruleSingleConnectionPerLocation(makeEmptyTopology(), 'maximum')).toEqual([]);
  });

  it('returns recommendation for location with single connection (maximum target)', () => {
    const t = makeEmptyTopology();
    t.connections = [
      { connectionId: 'c1', connectionName: 'conn-1', location: 'EqDC2', connectionState: 'available', bandwidth: '1Gbps', tags: {} } as any,
    ];
    t.locations = [{ locationCode: 'EqDC2', locationName: 'Equinix DC2' } as any];
    const recs = ruleSingleConnectionPerLocation(t, 'maximum');
    expect(recs).toHaveLength(1);
    expect(recs[0].title).toContain('Equinix DC2');
  });

  it('returns no recommendation for location with two connections', () => {
    const t = makeEmptyTopology();
    t.connections = [
      { connectionId: 'c1', connectionName: 'conn-1', location: 'EqDC2', connectionState: 'available', bandwidth: '1Gbps', tags: {} } as any,
      { connectionId: 'c2', connectionName: 'conn-2', location: 'EqDC2', connectionState: 'available', bandwidth: '1Gbps', tags: {} } as any,
    ];
    expect(ruleSingleConnectionPerLocation(t, 'maximum')).toEqual([]);
  });

  it('returns one recommendation per single-connection location (maximum target)', () => {
    const t = makeEmptyTopology();
    t.connections = [
      { connectionId: 'c1', location: 'EqDC2', connectionState: 'available', bandwidth: '1Gbps', tags: {} } as any,
      { connectionId: 'c2', location: 'EqDC6', connectionState: 'available', bandwidth: '1Gbps', tags: {} } as any,
    ];
    const recs = ruleSingleConnectionPerLocation(t, 'maximum');
    expect(recs).toHaveLength(2);
  });
});

describe('ruleSingleDxLocation with target', () => {
  it('for high target, second location gets 1 connection (3 ghost nodes)', () => {
    const t = makeEmptyTopology();
    t.connections = [
      { connectionId: 'c1', location: 'EqDC2', connectionState: 'available', bandwidth: '1Gbps', tags: {} } as any,
    ];
    const rec = ruleSingleDxLocation(t, 'high')!;
    // dxLocation + partner + awsdev = 3 (chain starts at the partner device;
    // no customerSite / onPremise ghost is minted).
    expect(rec.additionalNodes).toHaveLength(3);
  });

  it('for maximum target, second location gets 2 connections (5 ghost nodes)', () => {
    const t = makeEmptyTopology();
    t.connections = [
      { connectionId: 'c1', location: 'EqDC2', connectionState: 'available', bandwidth: '1Gbps', tags: {} } as any,
    ];
    const rec = ruleSingleDxLocation(t, 'maximum')!;
    // Base 3 + second partner + second awsdev = 5
    expect(rec.additionalNodes).toHaveLength(5);
    expect(rec.additionalNodes.find((n) => n.id === 'rec-partner-B-2')).toBeDefined();
    expect(rec.additionalNodes.find((n) => n.id === 'rec-awsdev-B-2')).toBeDefined();
  });
});

describe('ruleNoTgw', () => {
  it('returns null when TGWs exist', () => {
    const t = makeEmptyTopology();
    t.transitGateways = [{ transitGatewayId: 'tgw-1', tags: {} } as any];
    expect(ruleNoTgw(t)).toBeNull();
  });

  it('returns null when no VGWs exist (nothing to recommend)', () => {
    expect(ruleNoTgw(makeEmptyTopology())).toBeNull();
  });

  it('returns recommendation when VGWs exist but no TGWs', () => {
    const t = makeEmptyTopology();
    t.vpnGateways = [{ vpnGatewayId: 'vgw-1', tags: {} } as any];
    const rec = ruleNoTgw(t);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('no-tgw');
    expect(rec!.severity).toBe('warning');
  });
});

describe('ruleSingleVgw', () => {
  it('returns null when no VGWs exist', () => {
    expect(ruleSingleVgw(makeEmptyTopology())).toBeNull();
  });

  it('returns recommendation when exactly one VGW and no TGW', () => {
    const t = makeEmptyTopology();
    t.vpnGateways = [{ vpnGatewayId: 'vgw-1', tags: {} } as any];
    const rec = ruleSingleVgw(t);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('single-vgw');
  });

  it('returns null when TGW exists alongside VGW', () => {
    const t = makeEmptyTopology();
    t.vpnGateways = [{ vpnGatewayId: 'vgw-1', tags: {} } as any];
    t.transitGateways = [{ transitGatewayId: 'tgw-1', tags: {} } as any];
    expect(ruleSingleVgw(t)).toBeNull();
  });

  it('returns null when multiple VGWs exist', () => {
    const t = makeEmptyTopology();
    t.vpnGateways = [
      { vpnGatewayId: 'vgw-1', tags: {} } as any,
      { vpnGatewayId: 'vgw-2', tags: {} } as any,
    ];
    expect(ruleSingleVgw(t)).toBeNull();
  });
});

describe('ruleNoLag', () => {
  it('returns null when LAGs exist', () => {
    const t = makeEmptyTopology();
    t.lags = [{ lagId: 'lag-1', tags: {} } as any];
    expect(ruleNoLag(t)).toBeNull();
  });

  it('returns null when fewer than 2 connections', () => {
    const t = makeEmptyTopology();
    t.connections = [
      { connectionId: 'c1', location: 'EqDC2', connectionState: 'available', bandwidth: '1Gbps', tags: {} } as any,
    ];
    expect(ruleNoLag(t)).toBeNull();
  });

  it('returns recommendation when 2+ connections at same location and no LAGs', () => {
    const t = makeEmptyTopology();
    t.connections = [
      { connectionId: 'c1', location: 'EqDC2', connectionState: 'available', bandwidth: '1Gbps', tags: {} } as any,
      { connectionId: 'c2', location: 'EqDC2', connectionState: 'available', bandwidth: '1Gbps', tags: {} } as any,
    ];
    const rec = ruleNoLag(t);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('no-lag');
    expect(rec!.severity).toBe('info');
  });

  it('returns null when connections are at different locations (no location has 2+)', () => {
    const t = makeEmptyTopology();
    t.connections = [
      { connectionId: 'c1', location: 'EqDC2', connectionState: 'available', bandwidth: '1Gbps', tags: {} } as any,
      { connectionId: 'c2', location: 'EqDC6', connectionState: 'available', bandwidth: '1Gbps', tags: {} } as any,
    ];
    expect(ruleNoLag(t)).toBeNull();
  });
});

describe('ruleLagResiliency', () => {
  it('returns empty array when no LAGs exist', () => {
    const t = makeEmptyTopology();
    t.connections = [
      { connectionId: 'c1', location: 'EqDC2', connectionState: 'available', bandwidth: '1Gbps', tags: {} } as any,
    ];
    expect(ruleLagResiliency(t, 'high')).toEqual([]);
  });

  it('returns recommendation when LAGs exist at only one location (high target)', () => {
    const t = makeEmptyTopology();
    t.lags = [
      { lagId: 'lag-1', lagName: 'LAG-A', location: 'EqDC2', lagState: 'available', connectionsBandwidth: '1Gbps', numberOfConnections: 2, minimumLinks: 1, connections: [] } as any,
    ];
    t.locations = [{ locationCode: 'EqDC2', locationName: 'Equinix DC2' } as any];
    const recs = ruleLagResiliency(t, 'high');
    expect(recs).toHaveLength(1);
    expect(recs[0].ruleId).toBe('lag-single-location');
    expect(recs[0].severity).toBe('info');
    // dxLocation + partner + lag + awsdev = 4 ghost nodes
    expect(recs[0].additionalNodes).toHaveLength(4);
  });

  it('returns recommendation with extra nodes for maximum target at single location', () => {
    const t = makeEmptyTopology();
    t.lags = [
      { lagId: 'lag-1', lagName: 'LAG-A', location: 'EqDC2', lagState: 'available', connectionsBandwidth: '1Gbps', numberOfConnections: 2, minimumLinks: 1, connections: [] } as any,
    ];
    t.locations = [{ locationCode: 'EqDC2', locationName: 'Equinix DC2' } as any];
    const recs = ruleLagResiliency(t, 'maximum');
    expect(recs).toHaveLength(1);
    expect(recs[0].ruleId).toBe('lag-single-location');
    // Maximum from single loc: dxLoc + partner1 + lag1 + awsdev1 + partner2 + lag2 + awsdev2
    // + existing loc second LAG: partner + lag + awsdev = 10
    expect(recs[0].additionalNodes).toHaveLength(10);
  });

  it('returns empty for high target when LAGs exist at 2+ locations', () => {
    const t = makeEmptyTopology();
    t.lags = [
      { lagId: 'lag-1', lagName: 'LAG-A', location: 'EqDC2', lagState: 'available', connectionsBandwidth: '1Gbps', numberOfConnections: 2, minimumLinks: 1, connections: [] } as any,
      { lagId: 'lag-2', lagName: 'LAG-B', location: 'EqDC6', lagState: 'available', connectionsBandwidth: '1Gbps', numberOfConnections: 2, minimumLinks: 1, connections: [] } as any,
    ];
    const recs = ruleLagResiliency(t, 'high');
    expect(recs).toEqual([]);
  });

  it('recommends second LAG per location for maximum when 2+ locations with 1 LAG each', () => {
    const t = makeEmptyTopology();
    t.lags = [
      { lagId: 'lag-1', lagName: 'LAG-A', location: 'EqDC2', lagState: 'available', connectionsBandwidth: '1Gbps', numberOfConnections: 2, minimumLinks: 1, connections: [] } as any,
      { lagId: 'lag-2', lagName: 'LAG-B', location: 'EqDC6', lagState: 'available', connectionsBandwidth: '1Gbps', numberOfConnections: 2, minimumLinks: 1, connections: [] } as any,
    ];
    t.locations = [
      { locationCode: 'EqDC2', locationName: 'Equinix DC2' } as any,
      { locationCode: 'EqDC6', locationName: 'Equinix DC6' } as any,
    ];
    const recs = ruleLagResiliency(t, 'maximum');
    expect(recs).toHaveLength(2);
    expect(recs[0].ruleId).toBe('lag-redundancy-per-location');
    expect(recs[1].ruleId).toBe('lag-redundancy-per-location');
    // Each adds: partner + lag + awsdev = 3 ghost nodes
    expect(recs[0].additionalNodes).toHaveLength(3);
    expect(recs[1].additionalNodes).toHaveLength(3);
  });

  it('returns empty when 2+ locations with 2+ LAGs each (maximum already met)', () => {
    const t = makeEmptyTopology();
    t.lags = [
      { lagId: 'lag-1', lagName: 'LAG-A', location: 'EqDC2', lagState: 'available', connectionsBandwidth: '1Gbps', numberOfConnections: 2, minimumLinks: 1, connections: [] } as any,
      { lagId: 'lag-2', lagName: 'LAG-B', location: 'EqDC2', lagState: 'available', connectionsBandwidth: '1Gbps', numberOfConnections: 2, minimumLinks: 1, connections: [] } as any,
      { lagId: 'lag-3', lagName: 'LAG-C', location: 'EqDC6', lagState: 'available', connectionsBandwidth: '1Gbps', numberOfConnections: 2, minimumLinks: 1, connections: [] } as any,
      { lagId: 'lag-4', lagName: 'LAG-D', location: 'EqDC6', lagState: 'available', connectionsBandwidth: '1Gbps', numberOfConnections: 2, minimumLinks: 1, connections: [] } as any,
    ];
    const recs = ruleLagResiliency(t, 'maximum');
    expect(recs).toEqual([]);
  });

  it('adds edge to DX Gateway when one exists', () => {
    const t = makeEmptyTopology();
    t.lags = [
      { lagId: 'lag-1', lagName: 'LAG-A', location: 'EqDC2', lagState: 'available', connectionsBandwidth: '1Gbps', numberOfConnections: 2, minimumLinks: 1, connections: [] } as any,
    ];
    t.dxGateways = [{ directConnectGatewayId: 'gw-123', directConnectGatewayName: 'my-gw', tags: {} } as any];
    const recs = ruleLagResiliency(t, 'high', 'gw-123');
    expect(recs).toHaveLength(1);
    const edgeToGw = recs[0].additionalEdges.find((e) => e.target === 'dxgw-gw-123');
    expect(edgeToGw).toBeDefined();
  });

  it('fans out edges to multiple DX Gateways when array is passed', () => {
    const t = makeEmptyTopology();
    t.lags = [
      { lagId: 'lag-1', lagName: 'LAG-A', location: 'EqDC2', lagState: 'available', connectionsBandwidth: '1Gbps', numberOfConnections: 2, minimumLinks: 1, connections: [] } as any,
    ];
    t.dxGateways = [
      { directConnectGatewayId: 'gw-1', directConnectGatewayName: 'GW-1', tags: {} } as any,
      { directConnectGatewayId: 'gw-2', directConnectGatewayName: 'GW-2', tags: {} } as any,
    ];
    const recs = ruleLagResiliency(t, 'high', ['gw-1', 'gw-2']);
    expect(recs).toHaveLength(1);
    const edgesToGw1 = recs[0].additionalEdges.filter((e) => e.target === 'dxgw-gw-1');
    const edgesToGw2 = recs[0].additionalEdges.filter((e) => e.target === 'dxgw-gw-2');
    expect(edgesToGw1.length).toBeGreaterThan(0);
    expect(edgesToGw2.length).toBeGreaterThan(0);
  });

  it('only recommends for locations with fewer LAGs than required (maximum, partial coverage)', () => {
    const t = makeEmptyTopology();
    t.lags = [
      { lagId: 'lag-1', lagName: 'LAG-A', location: 'EqDC2', lagState: 'available', connectionsBandwidth: '1Gbps', numberOfConnections: 2, minimumLinks: 1, connections: [] } as any,
      { lagId: 'lag-2', lagName: 'LAG-B', location: 'EqDC2', lagState: 'available', connectionsBandwidth: '1Gbps', numberOfConnections: 2, minimumLinks: 1, connections: [] } as any,
      { lagId: 'lag-3', lagName: 'LAG-C', location: 'EqDC6', lagState: 'available', connectionsBandwidth: '1Gbps', numberOfConnections: 2, minimumLinks: 1, connections: [] } as any,
    ];
    t.locations = [
      { locationCode: 'EqDC2', locationName: 'Equinix DC2' } as any,
      { locationCode: 'EqDC6', locationName: 'Equinix DC6' } as any,
    ];
    const recs = ruleLagResiliency(t, 'maximum');
    // Only EqDC6 needs a second LAG
    expect(recs).toHaveLength(1);
    expect(recs[0].title).toContain('Equinix DC6');
  });

  it('adds Public VIF edges to pub-endpoints when topology has public VIFs', () => {
    const t = makeEmptyTopology();
    t.lags = [
      { lagId: 'lag-1', lagName: 'LAG-A', location: 'EqDC2', lagState: 'available', connectionsBandwidth: '1Gbps', numberOfConnections: 2, minimumLinks: 1, connections: [] } as any,
      { lagId: 'lag-2', lagName: 'LAG-B', location: 'EqDC6', lagState: 'available', connectionsBandwidth: '1Gbps', numberOfConnections: 2, minimumLinks: 1, connections: [] } as any,
    ];
    t.locations = [
      { locationCode: 'EqDC2', locationName: 'Equinix DC2' } as any,
      { locationCode: 'EqDC6', locationName: 'Equinix DC6' } as any,
    ];
    t.virtualInterfaces = [
      { virtualInterfaceId: 'vif-pub1', virtualInterfaceType: 'public', connectionId: 'c1', bgpPeers: [], tags: {} } as any,
    ];
    const recs = ruleLagResiliency(t, 'maximum');
    const allEdges = recs.flatMap((r) => r.additionalEdges);
    const pubEdges = allEdges.filter((e) => e.target === 'pub-endpoints');
    expect(pubEdges.length).toBeGreaterThan(0);
    expect(pubEdges.every((e) => e.data?.label === 'Public VIF')).toBe(true);
  });

  it('does not add pub-endpoints edges when no public VIFs exist', () => {
    const t = makeEmptyTopology();
    t.lags = [
      { lagId: 'lag-1', lagName: 'LAG-A', location: 'EqDC2', lagState: 'available', connectionsBandwidth: '1Gbps', numberOfConnections: 2, minimumLinks: 1, connections: [] } as any,
      { lagId: 'lag-2', lagName: 'LAG-B', location: 'EqDC6', lagState: 'available', connectionsBandwidth: '1Gbps', numberOfConnections: 2, minimumLinks: 1, connections: [] } as any,
    ];
    t.locations = [
      { locationCode: 'EqDC2', locationName: 'Equinix DC2' } as any,
      { locationCode: 'EqDC6', locationName: 'Equinix DC6' } as any,
    ];
    const recs = ruleLagResiliency(t, 'maximum');
    const allEdges = recs.flatMap((r) => r.additionalEdges);
    const pubEdges = allEdges.filter((e) => e.target === 'pub-endpoints');
    expect(pubEdges).toHaveLength(0);
  });
});
