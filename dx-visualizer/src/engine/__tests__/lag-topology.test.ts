import { describe, it, expect } from 'vitest';
import { buildGraph } from '../topology-builder';
import { makeEmptyTopology } from './helpers';

function makeLagTopology() {
  const topo = makeEmptyTopology();
  topo.homeAccountId = '111122223333';
  topo.locations = [
    { locationCode: 'EqLD5', locationName: 'Equinix LD5, Slough, GBR', region: 'eu-west-2', availablePortSpeeds: ['1Gbps', '10Gbps'] },
  ];
  topo.connections = [
    { connectionId: 'dxcon-aaa', connectionName: 'DX102-LAG-P4', connectionState: 'available', location: 'EqLD5', bandwidth: '1Gbps', region: 'eu-west-2', lagId: 'dxlag-001', awsLogicalDeviceId: 'EqLD5-dev1' },
    { connectionId: 'dxcon-bbb', connectionName: 'DX103-LAG-P5', connectionState: 'available', location: 'EqLD5', bandwidth: '1Gbps', region: 'eu-west-2', lagId: 'dxlag-001', awsLogicalDeviceId: 'EqLD5-dev1' },
  ];
  topo.lags = [
    { lagId: 'dxlag-001', lagName: 'LAG-1-DX102-DX103', connectionsBandwidth: '1Gbps', numberOfConnections: 2, minimumLinks: 0, location: 'EqLD5', region: 'eu-west-2', lagState: 'available', connections: topo.connections },
  ];
  topo.virtualInterfaces = [
    { virtualInterfaceId: 'dxvif-aaa', virtualInterfaceName: 'VIF-A', virtualInterfaceType: 'private', virtualInterfaceState: 'available', connectionId: 'dxcon-aaa', directConnectGatewayId: 'dxgw-001', vlan: 100, asn: 65000, bgpPeers: [{ bgpPeerId: 'bgp-1', bgpPeerState: 'available', bgpStatus: 'up', asn: 65000, customerAddress: '169.254.0.2/30', amazonAddress: '169.254.0.1/30' }], region: 'eu-west-2', awsLogicalDeviceId: 'EqLD5-dev1' },
    { virtualInterfaceId: 'dxvif-bbb', virtualInterfaceName: 'VIF-B', virtualInterfaceType: 'private', virtualInterfaceState: 'available', connectionId: 'dxcon-bbb', directConnectGatewayId: 'dxgw-001', vlan: 200, asn: 65000, bgpPeers: [{ bgpPeerId: 'bgp-2', bgpPeerState: 'available', bgpStatus: 'up', asn: 65000, customerAddress: '169.254.1.2/30', amazonAddress: '169.254.1.1/30' }], region: 'eu-west-2', awsLogicalDeviceId: 'EqLD5-dev1' },
  ];
  topo.dxGateways = [
    { directConnectGatewayId: 'dxgw-001', directConnectGatewayName: 'DXGW-Prod', directConnectGatewayState: 'available', amazonSideAsn: 64512 },
  ];
  topo.dxGatewayAssociations = [];
  return topo;
}

describe('LAG topology visualization', () => {
  it('creates a LAG node with correct metadata', () => {
    const topo = makeLagTopology();
    const { nodes } = buildGraph(topo, new Set());

    const lagNode = nodes.find((n) => n.id === 'lag-dxlag-001');
    expect(lagNode).toBeDefined();
    expect(lagNode!.data.category).toBe('lag');
    expect(lagNode!.data.label).toBe('LAG-1-DX102-DX103');
    expect(lagNode!.data.resourceId).toBe('dxlag-001');
    expect(lagNode!.data.details?.state).toBe('available');
    expect(lagNode!.data.details?.bandwidth).toBe('1Gbps');
    expect(lagNode!.data.details?.numberOfConnections).toBe('2');
    expect(lagNode!.data.details?.minimumLinks).toBe('0');
  });

  it('routes single partner node through the LAG node with one edge per member', () => {
    const topo = makeLagTopology();
    const { nodes, edges } = buildGraph(topo, new Set());

    const partnerNodes = nodes.filter((n) => n.data.category === 'dxPartnerDevice');
    expect(partnerNodes.length).toBe(1);
    expect(partnerNodes[0].id).toBe('partner-dxlag-001');

    // One partner → LAG edge per member connection, each labelled individually.
    const partnerToLag = edges.filter((e) => e.source === 'partner-dxlag-001' && e.target === 'lag-dxlag-001');
    expect(partnerToLag.length).toBe(2);
    for (const e of partnerToLag) {
      expect(e.data?.label).toContain('DX Connection');
    }
    expect(partnerToLag.map((e) => e.data?.connectionId).sort()).toEqual(['dxcon-aaa', 'dxcon-bbb']);
  });

  it('bows the member edges apart from a single shared dot on each node', () => {
    const topo = makeLagTopology();
    const { edges } = buildGraph(topo, new Set());

    const partnerToLag = edges.filter((e) => e.source === 'partner-dxlag-001' && e.target === 'lag-dxlag-001');
    // Every member edge has a distinct id (so React Flow renders both)...
    expect(new Set(partnerToLag.map((e) => e.id)).size).toBe(2);
    for (const e of partnerToLag) {
      // ...but they share the node's default dots — no per-edge handle override.
      expect(e.sourceHandle).toBeUndefined();
      expect(e.targetHandle).toBeUndefined();
      // Each carries the parallel-bow metadata CustomEdge uses to arc them apart.
      expect(e.data?.parallelCount).toBe(2);
    }
    expect(partnerToLag.map((e) => e.data?.parallelIndex).sort()).toEqual([0, 1]);
  });

  it('creates a single LAG-to-awsDevice edge', () => {
    const topo = makeLagTopology();
    const { edges } = buildGraph(topo, new Set());

    const lagToAws = edges.filter((e) => e.source === 'lag-dxlag-001' && e.target.startsWith('awsdev-'));
    expect(lagToAws.length).toBe(1);
    expect(lagToAws[0].data?.label).toContain('LAG Bundle');
  });

  it('does not create direct partner-to-awsDevice edges when LAG exists', () => {
    const topo = makeLagTopology();
    const { edges } = buildGraph(topo, new Set());

    const directPartnerToAws = edges.filter(
      (e) => e.source.startsWith('partner-') && e.target.startsWith('awsdev-')
    );
    expect(directPartnerToAws.length).toBe(0);
  });

  it('non-LAG connections still route directly to awsDevice', () => {
    const topo = makeLagTopology();
    topo.connections.push({
      connectionId: 'dxcon-ccc',
      connectionName: 'DX-Standalone',
      connectionState: 'available',
      location: 'EqLD5',
      bandwidth: '10Gbps',
      region: 'eu-west-2',
      awsLogicalDeviceId: 'EqLD5-dev2',
    });
    topo.virtualInterfaces.push({
      virtualInterfaceId: 'dxvif-ccc',
      virtualInterfaceName: 'VIF-Standalone',
      virtualInterfaceType: 'private',
      virtualInterfaceState: 'available',
      connectionId: 'dxcon-ccc',
      directConnectGatewayId: 'dxgw-001',
      vlan: 300,
      asn: 65000,
      bgpPeers: [{ bgpPeerId: 'bgp-3', bgpPeerState: 'available', bgpStatus: 'up', asn: 65000, customerAddress: '169.254.2.2/30', amazonAddress: '169.254.2.1/30' }],
      region: 'eu-west-2',
      awsLogicalDeviceId: 'EqLD5-dev2',
    });

    const { edges } = buildGraph(topo, new Set());

    const directToAws = edges.filter(
      (e) => e.source === 'partner-dxcon-ccc' && e.target.startsWith('awsdev-')
    );
    expect(directToAws.length).toBe(1);
  });

  it('emits one partner-to-LAG edge per member, each labelling its own connection', () => {
    const topo = makeLagTopology();
    const { edges } = buildGraph(topo, new Set());

    const partnerToLag = edges.filter((e) => e.source === 'partner-dxlag-001' && e.target === 'lag-dxlag-001');
    const aaa = partnerToLag.find((e) => e.data?.connectionId === 'dxcon-aaa');
    const bbb = partnerToLag.find((e) => e.data?.connectionId === 'dxcon-bbb');
    expect(aaa).toBeDefined();
    expect(bbb).toBeDefined();
    // Each edge labels only its own connection, not the whole bundle.
    expect(aaa!.data?.label).toContain('dxcon-aaa');
    expect(aaa!.data?.label).not.toContain('dxcon-bbb');
    expect(bbb!.data?.label).toContain('dxcon-bbb');
    expect(bbb!.data?.label).not.toContain('dxcon-aaa');
    // Distinct parallel indices → CustomEdge bows them to separate arcs, so their
    // labels (which ride the arc midpoints) don't stack.
    expect(aaa!.data?.parallelIndex).not.toEqual(bbb!.data?.parallelIndex);
  });
});
