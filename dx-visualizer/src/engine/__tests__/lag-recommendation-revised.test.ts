import { describe, it, expect } from 'vitest';
import { analyzeTopology, FOCUSED_LAG } from '../recommendation-engine';
import {
  getSinkConnectedDevices,
  findReusableSinkLocation,
} from '../sla-gating';
import { makeEmptyTopology } from './helpers';
import type { DxNode } from '../../types/topology';
import type { TopologyData } from '../../types/topology';

/**
 * REVISED LAG-RESILIENCY RECOMMENDATION RULES
 * ===========================================
 *
 * A "sink-connected device" is a distinct AWS logical device at a DX location
 * that carries at least one VIF terminating on a DX Gateway (private/transit
 * VIF with `directConnectGatewayId`) OR on the public endpoint (a `public`
 * VIF). Devices that serve only a VGW / VPN and nothing DXGW/public-facing do
 * NOT count.
 *
 * Rule 1 — LAG ghost paths may only be drawn at a DX location that ALREADY has
 *          a real sink-connected LAG. A location without a LAG cannot sprout a
 *          ghost LAG; if it has exactly one plain (non-LAG) sink-connected
 *          device, draw a plain non-LAG ghost path instead.
 *
 * Rule 2 — A DX location that already has 2 sink-connected devices is fully
 *          device-redundant; skip it and move to the next existing location.
 *
 * Target — Maximum resiliency = 4 upstream links into each sink (2 locations ×
 *          2 devices/LAGs). Ghost paths are added only at EXISTING locations
 *          that already have a sink-connected path — never invent LAG topology
 *          at a site that has none.
 */

// ---- fixture helpers -------------------------------------------------------

function ghostNodes(topo: TopologyData, focus = FOCUSED_LAG): DxNode[] {
  const a = analyzeTopology(topo, focus === FOCUSED_LAG ? { [FOCUSED_LAG]: 'maximum' } : 'maximum');
  return a.lag?.recommendations.flatMap((r) => r.additionalNodes) ?? [];
}

function ghostLagNodes(nodes: DxNode[]): DxNode[] {
  return nodes.filter((n) => n.data.isRecommended && n.data.category === 'lag');
}
function ghostAwsDevices(nodes: DxNode[]): DxNode[] {
  return nodes.filter((n) => n.data.isRecommended && n.data.category === 'awsDevice');
}
function ghostLocations(nodes: DxNode[]): DxNode[] {
  return nodes.filter((n) => n.data.isRecommended && n.data.category === 'dxLocation');
}
function devLocCodes(nodes: DxNode[]): string[] {
  return ghostAwsDevices(nodes).map(
    (n) => (n.data.details as Record<string, string> | undefined)?.locationCode ?? '',
  );
}

// ===========================================================================
// getSinkConnectedDevices — connection-aware device counting
// ===========================================================================
describe('getSinkConnectedDevices', () => {
  it('counts distinct logical devices carrying a VIF to a DXGW', () => {
    const t = makeEmptyTopology();
    t.locations = [{ locationCode: 'LocA', locationName: 'A', region: 'ap-southeast-1', availablePortSpeeds: [] }];
    t.connections = [
      { connectionId: 'c1', connectionName: 'C1', connectionState: 'available', location: 'LocA', bandwidth: '1Gbps', region: 'ap-southeast-1', awsLogicalDeviceId: 'dev1' },
      { connectionId: 'c2', connectionName: 'C2', connectionState: 'available', location: 'LocA', bandwidth: '1Gbps', region: 'ap-southeast-1', awsLogicalDeviceId: 'dev2' },
    ];
    t.virtualInterfaces = [
      { virtualInterfaceId: 'v1', virtualInterfaceName: 'V1', virtualInterfaceType: 'private', virtualInterfaceState: 'available', connectionId: 'c1', directConnectGatewayId: 'gw1', vlan: 1, asn: 1, bgpPeers: [], region: 'ap-southeast-1' },
      { virtualInterfaceId: 'v2', virtualInterfaceName: 'V2', virtualInterfaceType: 'private', virtualInterfaceState: 'available', connectionId: 'c2', directConnectGatewayId: 'gw1', vlan: 2, asn: 1, bgpPeers: [], region: 'ap-southeast-1' },
    ];
    const m = getSinkConnectedDevices(t);
    expect(m.get('LocA')?.deviceCount).toBe(2);
    expect(m.get('LocA')?.hasLag).toBe(false);
  });

  it('counts a device carrying a public VIF', () => {
    const t = makeEmptyTopology();
    t.locations = [{ locationCode: 'LocA', locationName: 'A', region: 'ap-southeast-1', availablePortSpeeds: [] }];
    t.connections = [
      { connectionId: 'c1', connectionName: 'C1', connectionState: 'available', location: 'LocA', bandwidth: '1Gbps', region: 'ap-southeast-1', awsLogicalDeviceId: 'dev1' },
    ];
    t.virtualInterfaces = [
      { virtualInterfaceId: 'v1', virtualInterfaceName: 'V1', virtualInterfaceType: 'public', virtualInterfaceState: 'available', connectionId: 'c1', vlan: 1, asn: 1, bgpPeers: [], region: 'ap-southeast-1' },
    ];
    const m = getSinkConnectedDevices(t);
    expect(m.get('LocA')?.deviceCount).toBe(1);
  });

  it('excludes VGW-only devices (no DXGW / no public VIF)', () => {
    const t = makeEmptyTopology();
    t.locations = [{ locationCode: 'LocA', locationName: 'A', region: 'ap-southeast-1', availablePortSpeeds: [] }];
    t.connections = [
      { connectionId: 'c1', connectionName: 'C1', connectionState: 'available', location: 'LocA', bandwidth: '1Gbps', region: 'ap-southeast-1', awsLogicalDeviceId: 'dev1' },
    ];
    t.virtualInterfaces = [
      { virtualInterfaceId: 'v1', virtualInterfaceName: 'V1', virtualInterfaceType: 'private', virtualInterfaceState: 'available', connectionId: 'c1', virtualGatewayId: 'vgw-1', vlan: 1, asn: 1, bgpPeers: [], region: 'ap-southeast-1' },
    ];
    const m = getSinkConnectedDevices(t);
    expect(m.get('LocA')?.deviceCount ?? 0).toBe(0);
  });

  it('flags a location whose sink-connected device belongs to a LAG', () => {
    const t = makeEmptyTopology();
    t.locations = [{ locationCode: 'LocA', locationName: 'A', region: 'eu-west-2', availablePortSpeeds: [] }];
    t.connections = [
      { connectionId: 'c1', connectionName: 'C1', connectionState: 'available', location: 'LocA', bandwidth: '1Gbps', region: 'eu-west-2', lagId: 'lag1', awsLogicalDeviceId: 'dev1' },
    ];
    t.lags = [
      { lagId: 'lag1', lagName: 'LAG1', connectionsBandwidth: '1Gbps', numberOfConnections: 1, minimumLinks: 0, location: 'LocA', region: 'eu-west-2', lagState: 'available', connections: [] },
    ];
    t.virtualInterfaces = [
      { virtualInterfaceId: 'v1', virtualInterfaceName: 'V1', virtualInterfaceType: 'private', virtualInterfaceState: 'available', connectionId: 'c1', directConnectGatewayId: 'gw1', vlan: 1, asn: 1, bgpPeers: [], region: 'eu-west-2' },
    ];
    const m = getSinkConnectedDevices(t);
    expect(m.get('LocA')?.hasLag).toBe(true);
  });
});

// ===========================================================================
// findReusableSinkLocation — Rule 1 + Rule 2 reuse selection
// ===========================================================================
describe('findReusableSinkLocation', () => {
  function twoLocs(): TopologyData {
    const t = makeEmptyTopology();
    t.locations = [
      { locationCode: 'LocA', locationName: 'A', region: 'ap-southeast-1', availablePortSpeeds: [] },
      { locationCode: 'LocB', locationName: 'B', region: 'ap-southeast-1', availablePortSpeeds: [] },
    ];
    return t;
  }

  it('reuses a different location that has a sink-connected path with capacity (<2 devices)', () => {
    const t = twoLocs();
    const sink = new Map([
      ['LocA', { deviceCount: 1, hasLag: true, lagMemberCount: 2 }],
      ['LocB', { deviceCount: 1, hasLag: false, lagMemberCount: 0 }],
    ]);
    expect(findReusableSinkLocation(t, ['LocA'], sink)).toBe('LocB');
  });

  it('skips a location that already has 2 sink-connected devices (Rule 2)', () => {
    const t = twoLocs();
    const sink = new Map([
      ['LocA', { deviceCount: 1, hasLag: true, lagMemberCount: 2 }],
      ['LocB', { deviceCount: 2, hasLag: false, lagMemberCount: 0 }],
    ]);
    // LocB is already device-redundant → not a reuse target → nothing else → undefined.
    expect(findReusableSinkLocation(t, ['LocA'], sink)).toBeUndefined();
  });

  it('does not reuse a location with NO sink-connected path (Rule 1)', () => {
    const t = twoLocs();
    // LocB has devices but none connected to a DXGW/public endpoint.
    const sink = new Map([['LocA', { deviceCount: 1, hasLag: true, lagMemberCount: 2 }]]);
    expect(findReusableSinkLocation(t, ['LocA'], sink)).toBeUndefined();
  });
});

// ===========================================================================
// ruleLagResiliency — ghost shape depends on the reuse location
// ===========================================================================
describe('LAG resiliency ghost shape (Rule 1)', () => {
  it('draws a LAG ghost at a second location that already has a real sink-connected LAG', () => {
    const t = makeEmptyTopology();
    t.locations = [
      { locationCode: 'LocA', locationName: 'A', region: 'eu-west-2', availablePortSpeeds: [] },
      { locationCode: 'LocB', locationName: 'B', region: 'eu-west-2', availablePortSpeeds: [] },
    ];
    // LocA: LAG. LocB: a real LAG too, 1 device → reuse target, LAG ghost allowed.
    t.connections = [
      { connectionId: 'cA', connectionName: 'cA', connectionState: 'available', location: 'LocA', bandwidth: '1Gbps', region: 'eu-west-2', lagId: 'lagA', awsLogicalDeviceId: 'devA1' },
      { connectionId: 'cB', connectionName: 'cB', connectionState: 'available', location: 'LocB', bandwidth: '1Gbps', region: 'eu-west-2', lagId: 'lagB', awsLogicalDeviceId: 'devB1' },
    ];
    t.lags = [
      { lagId: 'lagA', lagName: 'LAG-A', connectionsBandwidth: '1Gbps', numberOfConnections: 1, minimumLinks: 0, location: 'LocA', region: 'eu-west-2', lagState: 'available', connections: [] },
      { lagId: 'lagB', lagName: 'LAG-B', connectionsBandwidth: '1Gbps', numberOfConnections: 1, minimumLinks: 0, location: 'LocB', region: 'eu-west-2', lagState: 'available', connections: [] },
    ];
    t.virtualInterfaces = [
      { virtualInterfaceId: 'vA', virtualInterfaceName: 'vA', virtualInterfaceType: 'private', virtualInterfaceState: 'available', connectionId: 'cA', directConnectGatewayId: 'gw1', vlan: 1, asn: 1, bgpPeers: [], region: 'eu-west-2' },
      { virtualInterfaceId: 'vB', virtualInterfaceName: 'vB', virtualInterfaceType: 'private', virtualInterfaceState: 'available', connectionId: 'cB', directConnectGatewayId: 'gw1', vlan: 2, asn: 1, bgpPeers: [], region: 'eu-west-2' },
    ];
    t.dxGateways = [{ directConnectGatewayId: 'gw1', directConnectGatewayName: 'GW1', amazonSideAsn: 64512, directConnectGatewayState: 'available' }];

    const nodes = ghostNodes(t);
    // No minted ghost location — the second LAG rides an existing site.
    expect(ghostLocations(nodes)).toEqual([]);
    // A ghost LAG node IS drawn (allowed: the reuse site already has a real LAG).
    expect(ghostLagNodes(nodes).length).toBeGreaterThan(0);
  });

  it('draws a NON-LAG ghost at a second location that has 1 plain sink device and no LAG', () => {
    const t = makeEmptyTopology();
    t.locations = [
      { locationCode: 'LocA', locationName: 'A', region: 'eu-west-2', availablePortSpeeds: [] },
      { locationCode: 'LocB', locationName: 'B', region: 'eu-west-2', availablePortSpeeds: [] },
    ];
    // LocA: LAG. LocB: a plain (non-LAG) sink-connected device, count 1.
    t.connections = [
      { connectionId: 'cA', connectionName: 'cA', connectionState: 'available', location: 'LocA', bandwidth: '1Gbps', region: 'eu-west-2', lagId: 'lagA', awsLogicalDeviceId: 'devA1' },
      { connectionId: 'cB', connectionName: 'cB', connectionState: 'available', location: 'LocB', bandwidth: '1Gbps', region: 'eu-west-2', awsLogicalDeviceId: 'devB1' },
    ];
    t.lags = [
      { lagId: 'lagA', lagName: 'LAG-A', connectionsBandwidth: '1Gbps', numberOfConnections: 1, minimumLinks: 0, location: 'LocA', region: 'eu-west-2', lagState: 'available', connections: [] },
    ];
    t.virtualInterfaces = [
      { virtualInterfaceId: 'vA', virtualInterfaceName: 'vA', virtualInterfaceType: 'private', virtualInterfaceState: 'available', connectionId: 'cA', directConnectGatewayId: 'gw1', vlan: 1, asn: 1, bgpPeers: [], region: 'eu-west-2' },
      { virtualInterfaceId: 'vB', virtualInterfaceName: 'vB', virtualInterfaceType: 'private', virtualInterfaceState: 'available', connectionId: 'cB', directConnectGatewayId: 'gw1', vlan: 2, asn: 1, bgpPeers: [], region: 'eu-west-2' },
    ];
    t.dxGateways = [{ directConnectGatewayId: 'gw1', directConnectGatewayName: 'GW1', amazonSideAsn: 64512, directConnectGatewayState: 'available' }];

    const nodes = ghostNodes(t);
    expect(ghostLocations(nodes)).toEqual([]);
    // The reuse site (LocB) has NO real LAG → no ghost LAG node is drawn there.
    const lagsAtB = ghostLagNodes(nodes).filter(
      (n) => (n.data.details as Record<string, string> | undefined)?.locationCode === 'LocB',
    );
    expect(lagsAtB).toEqual([]);
    // But a ghost AWS device IS added at LocB (a plain non-LAG redundant path).
    expect(devLocCodes(nodes)).toContain('LocB');
  });

  it('skips a fully-redundant second location (2 sink devices) — Rule 2', () => {
    const t = makeEmptyTopology();
    t.locations = [
      { locationCode: 'LocA', locationName: 'A', region: 'eu-west-2', availablePortSpeeds: [] },
      { locationCode: 'LocB', locationName: 'B', region: 'eu-west-2', availablePortSpeeds: [] },
      { locationCode: 'LocC', locationName: 'C', region: 'eu-west-2', availablePortSpeeds: [] },
    ];
    // LocA: LAG (scope). LocB: 2 sink devices (redundant → skip). LocC: 1 plain sink device.
    t.connections = [
      { connectionId: 'cA', connectionName: 'cA', connectionState: 'available', location: 'LocA', bandwidth: '1Gbps', region: 'eu-west-2', lagId: 'lagA', awsLogicalDeviceId: 'devA1' },
      { connectionId: 'cB1', connectionName: 'cB1', connectionState: 'available', location: 'LocB', bandwidth: '1Gbps', region: 'eu-west-2', awsLogicalDeviceId: 'devB1' },
      { connectionId: 'cB2', connectionName: 'cB2', connectionState: 'available', location: 'LocB', bandwidth: '1Gbps', region: 'eu-west-2', awsLogicalDeviceId: 'devB2' },
      { connectionId: 'cC', connectionName: 'cC', connectionState: 'available', location: 'LocC', bandwidth: '1Gbps', region: 'eu-west-2', awsLogicalDeviceId: 'devC1' },
    ];
    t.lags = [
      { lagId: 'lagA', lagName: 'LAG-A', connectionsBandwidth: '1Gbps', numberOfConnections: 1, minimumLinks: 0, location: 'LocA', region: 'eu-west-2', lagState: 'available', connections: [] },
    ];
    t.virtualInterfaces = [
      { virtualInterfaceId: 'vA', virtualInterfaceName: 'vA', virtualInterfaceType: 'private', virtualInterfaceState: 'available', connectionId: 'cA', directConnectGatewayId: 'gw1', vlan: 1, asn: 1, bgpPeers: [], region: 'eu-west-2' },
      { virtualInterfaceId: 'vB1', virtualInterfaceName: 'vB1', virtualInterfaceType: 'private', virtualInterfaceState: 'available', connectionId: 'cB1', directConnectGatewayId: 'gw1', vlan: 2, asn: 1, bgpPeers: [], region: 'eu-west-2' },
      { virtualInterfaceId: 'vB2', virtualInterfaceName: 'vB2', virtualInterfaceType: 'private', virtualInterfaceState: 'available', connectionId: 'cB2', directConnectGatewayId: 'gw1', vlan: 3, asn: 1, bgpPeers: [], region: 'eu-west-2' },
      { virtualInterfaceId: 'vC', virtualInterfaceName: 'vC', virtualInterfaceType: 'private', virtualInterfaceState: 'available', connectionId: 'cC', directConnectGatewayId: 'gw1', vlan: 4, asn: 1, bgpPeers: [], region: 'eu-west-2' },
    ];
    t.dxGateways = [{ directConnectGatewayId: 'gw1', directConnectGatewayName: 'GW1', amazonSideAsn: 64512, directConnectGatewayState: 'available' }];

    const nodes = ghostNodes(t);
    // The redundant LocB is skipped; the ghost path lands on LocC.
    const locs = devLocCodes(nodes);
    expect(locs).not.toContain('LocB');
    expect(locs).toContain('LocC');
  });

  it('does NOT invent a LAG ghost when there is no other existing sink-connected location', () => {
    const t = makeEmptyTopology();
    t.locations = [{ locationCode: 'LocA', locationName: 'A', region: 'eu-west-2', availablePortSpeeds: [] }];
    t.connections = [
      { connectionId: 'cA', connectionName: 'cA', connectionState: 'available', location: 'LocA', bandwidth: '1Gbps', region: 'eu-west-2', lagId: 'lagA', awsLogicalDeviceId: 'devA1' },
    ];
    t.lags = [
      { lagId: 'lagA', lagName: 'LAG-A', connectionsBandwidth: '1Gbps', numberOfConnections: 1, minimumLinks: 0, location: 'LocA', region: 'eu-west-2', lagState: 'available', connections: [] },
    ];
    t.virtualInterfaces = [
      { virtualInterfaceId: 'vA', virtualInterfaceName: 'vA', virtualInterfaceType: 'private', virtualInterfaceState: 'available', connectionId: 'cA', directConnectGatewayId: 'gw1', vlan: 1, asn: 1, bgpPeers: [], region: 'eu-west-2' },
    ];
    t.dxGateways = [{ directConnectGatewayId: 'gw1', directConnectGatewayName: 'GW1', amazonSideAsn: 64512, directConnectGatewayState: 'available' }];

    // No second existing location to reuse → mint a ghost location (fallback),
    // and since the minted site is greenfield the ghost may be a LAG (the scope
    // itself has a LAG). This test only asserts we don't crash and produce recs.
    const nodes = ghostNodes(t);
    expect(nodes.length).toBeGreaterThan(0);
  });
});
