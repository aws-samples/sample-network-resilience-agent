import { describe, it, expect } from 'vitest';
import { buildGraph } from '../topology-builder';
import { analyzeTopology, getRecommendedGraph } from '../recommendation-engine';
import { makeEmptyTopology } from './helpers';
import type { TopologyData } from '../../types/topology';

/**
 * A VPC attached to BOTH a VGW (behind one DX gateway) and a TGW (behind
 * another) is one VPC reachable two ways. That second path is what makes the
 * VGW's single DX site survivable, and it is why the recommendation engine draws
 * no "second location" ghost for that gateway.
 *
 * Builder: when the TGW's VPCs collapse into a group card, the shared VPC is
 * left out of the group and the TGW edges to the VGW-side card instead — before
 * this it appeared twice (card + table row) with nothing tying them together.
 *
 * Engine: the single-site gateway's assessment names the peer gateway and site
 * that cover it, so the card can say why the canvas is empty.
 */
const REGION = 'ap-southeast-1';
const ACCT = '123456789012';

function scenario(): TopologyData {
  const t = makeEmptyTopology();
  t.homeAccountId = ACCT;
  t.locations = [
    { locationCode: 'LocA', locationName: 'Site A', region: REGION, availablePortSpeeds: [] },
    { locationCode: 'LocB', locationName: 'Site B', region: REGION, availablePortSpeeds: [] },
  ];
  t.dxGateways = [
    { directConnectGatewayId: 'gwA', directConnectGatewayName: 'gw-a', amazonSideAsn: 64512, directConnectGatewayState: 'available' },
    { directConnectGatewayId: 'gwB', directConnectGatewayName: 'gw-b', amazonSideAsn: 64512, directConnectGatewayState: 'available' },
  ];
  t.dxGatewayAssociations = [
    {
      directConnectGatewayId: 'gwA',
      associatedGateway: { id: 'vgw-1', type: 'virtualPrivateGateway', region: REGION, ownerAccount: ACCT },
      associationState: 'associated',
      allowedPrefixes: ['192.0.2.0/24'],
    },
    {
      directConnectGatewayId: 'gwB',
      associatedGateway: { id: 'tgw-1', type: 'transitGateway', region: REGION, ownerAccount: ACCT },
      associationState: 'associated',
      allowedPrefixes: ['198.51.100.0/24'],
    },
  ];
  const vif = (gw: string, loc: string, n: number) => {
    const connId = `c-${gw}`;
    t.connections.push({ connectionId: connId, connectionName: connId, connectionState: 'available', location: loc, bandwidth: '1Gbps', region: REGION, awsLogicalDeviceId: `dev-${gw}` });
    t.virtualInterfaces.push({ virtualInterfaceId: `v-${gw}`, virtualInterfaceName: `v-${gw}`, virtualInterfaceType: 'private', virtualInterfaceState: 'available', connectionId: connId, directConnectGatewayId: gw, vlan: n, asn: 65001, bgpPeers: [], region: REGION, location: loc });
  };
  vif('gwA', 'LocA', 1);
  vif('gwB', 'LocB', 2);

  t.vpnGateways = [
    { vpnGatewayId: 'vgw-1', vpcAttachments: [{ vpcId: 'vpc-shared', state: 'attached' }], type: 'ipsec.1', amazonSideAsn: 64512, state: 'available', tags: { Name: 'shared-vgw' } },
  ];
  t.transitGateways = [
    { transitGatewayId: 'tgw-1', transitGatewayArn: `arn:aws:ec2:${REGION}:${ACCT}:transit-gateway/tgw-1`, state: 'available', ownerId: ACCT, description: '', amazonSideAsn: 64513, tags: { Name: 'hub-tgw' } },
  ];
  const vpcIds = ['vpc-shared', 'vpc-2', 'vpc-3', 'vpc-4', 'vpc-5'];
  t.vpcs = vpcIds.map((id, i) => ({
    vpcId: id, cidrBlock: `10.${i}.0.0/16`, region: REGION, ownerAccountId: ACCT, tags: { Name: id === 'vpc-shared' ? 'shared-vpc' : id }, state: 'available',
  }));
  t.transitGatewayAttachments = vpcIds.map((id) => ({
    transitGatewayAttachmentId: `att-${id}`, transitGatewayId: 'tgw-1', resourceType: 'vpc', resourceId: id, resourceOwnerId: ACCT, state: 'available',
  }));
  return t;
}

describe('builder: VPC behind both a VGW and a collapsed TGW group', () => {
  for (const mode of ['card', 'table'] as const) {
    it(`draws the VPC once and edges the TGW to it (${mode} view)`, () => {
      const t = scenario();
      // Card view first; its group key switches the same group to table view.
      const probe = buildGraph(t, new Set());
      const group = probe.nodes.find((n) => n.data.category === 'vpcGroup')!;
      const { nodes, edges } = mode === 'table'
        ? buildGraph(t, new Set(), new Set(), new Map([[group.data.details!.groupKey, 'table' as const]]))
        : probe;

      const g = nodes.find((n) => n.data.category === 'vpcGroup')!;
      expect(g.data.label).toBe('4 VPCs');
      expect(g.data.childCount).toBe(4);
      expect(g.data.separateVpcCount).toBe(1);
      expect(g.data.vpcChildren!.map((c) => c.vpcId)).not.toContain('vpc-shared');
      if (mode === 'table') expect(g.data.computedWidth).toBeDefined();
      else expect(g.data.computedHeight).toBeGreaterThan(0);

      expect(nodes.filter((n) => n.id === 'vpc-vpc-shared')).toHaveLength(1);
      expect(edges.some((e) => e.source === 'vgw-vgw-1' && e.target === 'vpc-vpc-shared')).toBe(true);
      expect(edges.some((e) => e.source === 'tgw-tgw-1' && e.target === 'vpc-vpc-shared')).toBe(true);
    });
  }

  it('leaves the group whole when no VGW draws any of its VPCs', () => {
    const t = scenario();
    t.vpnGateways[0].vpcAttachments = [];
    t.vpnGateways[0].tags = { Name: 'shared-vgw' };
    const { nodes } = buildGraph(t, new Set());
    const g = nodes.find((n) => n.data.category === 'vpcGroup')!;
    expect(g.data.label).toBe('5 VPCs');
    expect(g.data.separateVpcCount).toBeUndefined();
  });
});

describe('engine: single-site gateway covered by a peer', () => {
  it('names the peer, its site and the shared VPC, and mints no second-location rec', () => {
    const a = analyzeTopology(scenario(), 'high');
    const gwA = a.perDxGateway.find((g) => g.dxGatewayId === 'gwA')!;
    expect(gwA.recommendations.filter((r) => r.ruleId === 'single-dx-location')).toEqual([]);
    expect(gwA.siteRedundancyVia).toEqual({
      peers: [{ dxGatewayId: 'gwB', dxGatewayName: 'gw-b', locations: ['Site B'] }],
      sharedDownstream: ['shared-vpc'],
    });
  });

  it('names a shared gateway instead of every VPC behind it', () => {
    const t = scenario();
    t.dxGatewayAssociations[0] = { ...t.dxGatewayAssociations[1], directConnectGatewayId: 'gwA' };
    const gwA = analyzeTopology(t, 'high').perDxGateway.find((g) => g.dxGatewayId === 'gwA')!;
    expect(gwA.siteRedundancyVia?.sharedDownstream).toEqual(['hub-tgw']);
  });

  it('is absent when the peer sits at the same site', () => {
    const t = scenario();
    t.connections[1].location = 'LocA';
    t.virtualInterfaces[1].location = 'LocA';
    const gwA = analyzeTopology(t, 'high').perDxGateway.find((g) => g.dxGatewayId === 'gwA')!;
    expect(gwA.siteRedundancyVia).toBeUndefined();
  });
});

describe('engine: Maximum on a gateway whose second site is a peer', () => {
  // gwA already has two devices at its own site; gwB brings the second site
  // with one device. Maximum wants two devices at BOTH sites.
  function twoDevicesAtA(): TopologyData {
    const t = scenario();
    t.connections.push({ connectionId: 'c-gwA-2', connectionName: 'c-gwA-2', connectionState: 'available', location: 'LocA', bandwidth: '1Gbps', region: REGION, awsLogicalDeviceId: 'dev-gwA-2' });
    t.virtualInterfaces.push({ virtualInterfaceId: 'v-gwA-2', virtualInterfaceName: 'v-gwA-2', virtualInterfaceType: 'private', virtualInterfaceState: 'available', connectionId: 'c-gwA-2', directConnectGatewayId: 'gwA', vlan: 3, asn: 65001, bgpPeers: [], region: REGION, location: 'LocA' });
    return t;
  }
  const ghostDevicesAt = (nodes: { data: { category: string; details?: Record<string, unknown> } }[], loc: string) =>
    nodes.filter((n) => n.data.category === 'awsDevice' && n.data.details?.locationCode === loc);

  it("draws the missing device at the peer's site, fanned into this gateway", () => {
    const a = analyzeTopology(twoDevicesAtA(), { gwA: 'maximum' });
    const { nodes, edges } = getRecommendedGraph(a, 'gwA');
    expect(ghostDevicesAt(nodes, 'LocB')).toHaveLength(1);
    expect(ghostDevicesAt(nodes, 'LocA')).toHaveLength(0);
    expect(edges.some((e) => e.target === 'dxgw-gwA')).toBe(true);
  });

  it('does not double-draw that site in View all when the peer targets Maximum too', () => {
    const a = analyzeTopology(twoDevicesAtA(), { gwA: 'maximum', gwB: 'maximum' });
    expect(ghostDevicesAt(getRecommendedGraph(a, null).nodes, 'LocB')).toHaveLength(1);
  });

  it('draws nothing extra at High', () => {
    const a = analyzeTopology(twoDevicesAtA(), { gwA: 'high' });
    expect(ghostDevicesAt(getRecommendedGraph(a, 'gwA').nodes, 'LocB')).toHaveLength(0);
  });
});
