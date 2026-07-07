import { describe, it, expect } from 'vitest';
import { analyzeTopology, getRecommendedGraph, FOCUSED_LAG, FOCUSED_PUBLIC_VIF } from '../recommendation-engine';
import { makeEmptyTopology } from './helpers';
import type { TopologyData, DxNode, DxEdge } from '../../types/topology';

/**
 * PUBLIC ENDPOINT — multi-site MAX recommendation (EMEALAB shape, bullet 3)
 * ========================================================================
 *
 * The public endpoint currently has ONE real upstream link: the Equinix LD5 LAG
 * device (public VIF VLAN 351 rides a LAG member connection). Digital Realty
 * LHR20 carries zero public links.
 *
 * Maximum target for the public endpoint = 4 total upstream links to
 * `pub-endpoints` across >= 2 DX locations. The three ghost pieces are:
 *   1. mint a NON-LAG path at LHR20 -> pub-endpoints (LHR20's real sink paths
 *      are non-LAG, so the ghost there mirrors that);
 *   2. REUSE the LD5 ghost LAG already minted for the DXGW device-gap fill (it
 *      already fans out to pub-endpoints — no new node);
 *   3. mint a NEW LAG path at LD5 -> pub-endpoints.
 *
 * Net: LHR20 = 1 link, LD5 = real(1) + reused(1) + new(1) = 3 → 4 total across
 * 2 locations. Symmetry across locations is NOT required.
 */

function makeEmealabTopology(): TopologyData {
  const t = makeEmptyTopology();
  t.homeAccountId = '111122223333';
  t.locations = [
    { locationCode: 'LHR20', locationName: 'Digital Realty LHR20, London, GBR', region: 'eu-west-2', availablePortSpeeds: ['10Gbps'] },
    { locationCode: 'EqLD5', locationName: 'Equinix LD5, Slough, GBR', region: 'eu-west-2', availablePortSpeeds: ['1Gbps'] },
  ];
  t.dxGateways = [
    { directConnectGatewayId: 'dxgw-emealab', directConnectGatewayName: '-DND- EMEALAB MGMT', directConnectGatewayState: 'available', amazonSideAsn: 64512 },
  ];
  // LHR20: two plain (non-LAG) DXGW devices.
  t.connections.push(
    { connectionId: 'dxcon-lhr20a', connectionName: 'EMEALAB-DX9', connectionState: 'available', location: 'LHR20', bandwidth: '10Gbps', region: 'eu-west-2', awsLogicalDeviceId: 'LHR20-dev1' },
    { connectionId: 'dxcon-lhr20b', connectionName: 'EMEALAB-DX10', connectionState: 'available', location: 'LHR20', bandwidth: '10Gbps', region: 'eu-west-2', awsLogicalDeviceId: 'LHR20-dev2' },
  );
  t.virtualInterfaces.push(
    { virtualInterfaceId: 'vif-lhr20a', virtualInterfaceName: 'A', virtualInterfaceType: 'private', virtualInterfaceState: 'available', connectionId: 'dxcon-lhr20a', directConnectGatewayId: 'dxgw-emealab', vlan: 114, asn: 65000, bgpPeers: [], region: 'eu-west-2', location: 'LHR20' },
    { virtualInterfaceId: 'vif-lhr20b', virtualInterfaceName: 'B', virtualInterfaceType: 'private', virtualInterfaceState: 'available', connectionId: 'dxcon-lhr20b', directConnectGatewayId: 'dxgw-emealab', vlan: 214, asn: 65000, bgpPeers: [], region: 'eu-west-2', location: 'LHR20' },
  );
  // LD5: a LAG on ONE device carrying a private VIF (to DXGW) and the public VIF.
  t.connections.push(
    { connectionId: 'dxcon-ld5p4', connectionName: 'P4', connectionState: 'available', location: 'EqLD5', bandwidth: '1Gbps', region: 'eu-west-2', lagId: 'dxlag-ld5', awsLogicalDeviceId: 'EqLD5-lagdev' },
    { connectionId: 'dxcon-ld5p5', connectionName: 'P5', connectionState: 'available', location: 'EqLD5', bandwidth: '1Gbps', region: 'eu-west-2', lagId: 'dxlag-ld5', awsLogicalDeviceId: 'EqLD5-lagdev' },
  );
  t.lags.push({
    lagId: 'dxlag-ld5', lagName: 'LAG-1-DX102-DX103', connectionsBandwidth: '1Gbps', numberOfConnections: 2, minimumLinks: 0,
    location: 'EqLD5', region: 'eu-west-2', lagState: 'available',
    connections: [
      { connectionId: 'dxcon-ld5p4', connectionName: 'P4', connectionState: 'available', location: 'EqLD5', bandwidth: '1Gbps', region: 'eu-west-2', lagId: 'dxlag-ld5', awsLogicalDeviceId: 'EqLD5-lagdev' },
      { connectionId: 'dxcon-ld5p5', connectionName: 'P5', connectionState: 'available', location: 'EqLD5', bandwidth: '1Gbps', region: 'eu-west-2', lagId: 'dxlag-ld5', awsLogicalDeviceId: 'EqLD5-lagdev' },
    ],
  });
  t.virtualInterfaces.push(
    { virtualInterfaceId: 'vif-ld5-priv', virtualInterfaceName: 'PRIV', virtualInterfaceType: 'private', virtualInterfaceState: 'available', connectionId: 'dxcon-ld5p4', directConnectGatewayId: 'dxgw-emealab', vlan: 116, asn: 65000, bgpPeers: [], region: 'eu-west-2', location: 'EqLD5' },
    { virtualInterfaceId: 'vif-ld5-pub', virtualInterfaceName: 'PUB', virtualInterfaceType: 'public', virtualInterfaceState: 'available', connectionId: 'dxcon-ld5p5', vlan: 351, asn: 65000, bgpPeers: [], region: 'eu-west-2', location: 'EqLD5' },
  );
  return t;
}

const MAX_TARGET = { [FOCUSED_LAG]: 'maximum', [FOCUSED_PUBLIC_VIF]: 'maximum' } as const;

function pubGraph(t: TopologyData): { nodes: DxNode[]; edges: DxEdge[] } {
  const a = analyzeTopology(t, MAX_TARGET);
  return getRecommendedGraph(a, FOCUSED_PUBLIC_VIF);
}
function pubEndpointEdges(edges: DxEdge[]): DxEdge[] {
  return edges.filter((e) => e.target === 'pub-endpoints');
}
function locOf(n: DxNode): string {
  return (n.data.details as Record<string, string> | undefined)?.locationCode ?? '';
}
// Ghost AWS devices in the focused public graph, by location.
function ghostDevicesByLoc(nodes: DxNode[]): Map<string, DxNode[]> {
  const m = new Map<string, DxNode[]>();
  for (const n of nodes) {
    if (n.data.isRecommended && n.data.category === 'awsDevice') {
      const l = locOf(n);
      (m.get(l) ?? m.set(l, []).get(l)!).push(n);
    }
  }
  return m;
}
function ghostLagLocs(nodes: DxNode[]): string[] {
  return nodes.filter((n) => n.data.isRecommended && n.data.category === 'lag').map(locOf);
}

describe('public endpoint multi-site MAX (EMEALAB shape)', () => {
  it('does not mint a new ghost DX location for the public endpoint', () => {
    const { nodes } = pubGraph(makeEmealabTopology());
    const minted = nodes.filter((n) => n.data.isRecommended && n.data.category === 'dxLocation');
    expect(minted).toEqual([]);
  });

  it('adds three ghost upstream links to pub-endpoints (real 1 + 3 ghosts = 4 total)', () => {
    const { edges } = pubGraph(makeEmealabTopology());
    expect(pubEndpointEdges(edges).length).toBe(3);
  });

  it('spans both existing locations — a link at LHR20 and links at LD5', () => {
    const { nodes } = pubGraph(makeEmealabTopology());
    const byLoc = ghostDevicesByLoc(nodes);
    expect(byLoc.has('LHR20')).toBe(true);
    expect(byLoc.has('EqLD5')).toBe(true);
    // 1 at LHR20 (piece 1), 2 at LD5 (reused DXGW LAG + new LAG).
    expect(byLoc.get('LHR20')!.length).toBe(1);
    expect(byLoc.get('EqLD5')!.length).toBe(2);
  });

  it('the LHR20 public ghost path is NON-LAG; LD5 public ghosts are LAG', () => {
    const { nodes } = pubGraph(makeEmealabTopology());
    const lagLocs = ghostLagLocs(nodes);
    expect(lagLocs).not.toContain('LHR20');
    expect(lagLocs).toContain('EqLD5');
  });
});
