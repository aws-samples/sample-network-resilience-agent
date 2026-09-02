import { describe, it, expect } from 'vitest';
import { buildGraph } from '../topology-builder';
import { makeEmptyTopology } from './helpers';

function makeMultiVifTopology(vifCount: number) {
  const topo = makeEmptyTopology();
  topo.homeAccountId = '111122223333';
  topo.locations = [
    { locationCode: 'EqDC2', locationName: 'Equinix DC2', region: 'us-east-1', availablePortSpeeds: ['1Gbps'] },
  ];
  topo.connections = [
    { connectionId: 'dxcon-aaa', connectionName: 'Conn-A', connectionState: 'available', location: 'EqDC2', bandwidth: '10Gbps', region: 'us-east-1', awsLogicalDeviceId: 'EqDC2-dev1' },
  ];
  topo.dxGateways = [
    { directConnectGatewayId: 'dxgw-001', directConnectGatewayName: 'DXGW-Prod', directConnectGatewayState: 'available', amazonSideAsn: 64512 },
  ];
  topo.dxGatewayAssociations = [];
  topo.virtualInterfaces = Array.from({ length: vifCount }, (_, i) => ({
    virtualInterfaceId: `dxvif-${String(i).padStart(3, '0')}`,
    virtualInterfaceName: `VIF-${i}`,
    virtualInterfaceType: 'private' as const,
    virtualInterfaceState: 'available',
    connectionId: 'dxcon-aaa',
    directConnectGatewayId: 'dxgw-001',
    vlan: 100 + i,
    asn: 65000,
    bgpPeers: [{ bgpPeerId: `bgp-${i}`, bgpPeerState: 'available', bgpStatus: 'up', asn: 65000, customerAddress: `169.254.${i}.2/30`, amazonAddress: `169.254.${i}.1/30` }],
    region: 'us-east-1',
    awsLogicalDeviceId: 'EqDC2-dev1',
  }));
  return topo;
}

describe('VIF edge aggregation', () => {
  it('single VIF renders as individual edge with vifId', () => {
    const topo = makeMultiVifTopology(1);
    const { edges } = buildGraph(topo, new Set());

    const vifEdges = edges.filter((e) => e.source === 'awsdev-EqDC2-dev1' && e.target === 'dxgw-dxgw-001');
    expect(vifEdges.length).toBe(1);
    expect(vifEdges[0].data?.vifId).toBe('dxvif-000');
    expect(vifEdges[0].data?.aggregatedVifs).toBeUndefined();
  });

  it('single-VIF label carries the VIF name above its ID', () => {
    const topo = makeMultiVifTopology(1);
    const { edges } = buildGraph(topo, new Set());

    const vifEdge = edges.find((e) => e.source === 'awsdev-EqDC2-dev1' && e.target === 'dxgw-dxgw-001');
    expect(vifEdge!.data?.vifName).toBe('VIF-0');
    expect(vifEdge!.data?.label).toBe('Private VIF · VLAN 100\nVIF-0\ndxvif-000');
  });

  it('an unnamed VIF falls back to the ID alone — no blank line', () => {
    const topo = makeMultiVifTopology(1);
    topo.virtualInterfaces[0].virtualInterfaceName = '';
    const { edges } = buildGraph(topo, new Set());

    const vifEdge = edges.find((e) => e.source === 'awsdev-EqDC2-dev1' && e.target === 'dxgw-dxgw-001');
    expect(vifEdge!.data?.vifName).toBeUndefined();
    expect(vifEdge!.data?.label).toBe('Private VIF · VLAN 100\ndxvif-000');
  });

  it('a VIF named after its own ID prints the token once', () => {
    const topo = makeMultiVifTopology(1);
    topo.virtualInterfaces[0].virtualInterfaceName = 'dxvif-000';
    const { edges } = buildGraph(topo, new Set());

    const vifEdge = edges.find((e) => e.source === 'awsdev-EqDC2-dev1' && e.target === 'dxgw-dxgw-001');
    expect(vifEdge!.data?.label).toBe('Private VIF · VLAN 100\ndxvif-000');
  });

  it('multiple VIFs on same path are aggregated into a single edge', () => {
    const topo = makeMultiVifTopology(5);
    const { edges } = buildGraph(topo, new Set());

    const vifEdges = edges.filter((e) => e.source === 'awsdev-EqDC2-dev1' && e.target === 'dxgw-dxgw-001');
    expect(vifEdges.length).toBe(1);
    expect(vifEdges[0].data?.aggregatedVifs).toHaveLength(5);
    expect(vifEdges[0].data?.label).toContain('5 Private VIFs');
  });

  it('aggregated edge shows VLAN range', () => {
    const topo = makeMultiVifTopology(6);
    const { edges } = buildGraph(topo, new Set());

    const vifEdge = edges.find((e) => e.source === 'awsdev-EqDC2-dev1' && e.target === 'dxgw-dxgw-001');
    expect(vifEdge!.data?.label).toContain('VLANs 100–105');
  });

  it('aggregated edge reports status counts when some VIFs are down', () => {
    const topo = makeMultiVifTopology(4);
    topo.virtualInterfaces[1].virtualInterfaceState = 'down';
    topo.virtualInterfaces[2].virtualInterfaceState = 'down';

    const { edges } = buildGraph(topo, new Set());
    const vifEdge = edges.find((e) => e.source === 'awsdev-EqDC2-dev1' && e.target === 'dxgw-dxgw-001');
    expect(vifEdge!.data?.vifState).toBe('2/4 available');
  });

  it('aggregated edge sums utilization across all VIFs', () => {
    const topo = makeMultiVifTopology(3);
    topo.vifUtilization = new Map([
      ['dxvif-000', { ingressBpsPeak: 1e9, egressBpsPeak: 2e9 }],
      ['dxvif-001', { ingressBpsPeak: 0.5e9, egressBpsPeak: 1e9 }],
      ['dxvif-002', { ingressBpsPeak: 0.3e9, egressBpsPeak: 0.5e9 }],
    ]);

    const { edges } = buildGraph(topo, new Set());
    const vifEdge = edges.find((e) => e.source === 'awsdev-EqDC2-dev1' && e.target === 'dxgw-dxgw-001');
    expect(vifEdge!.data?.utilizationIngressBps).toBe(1.8e9);
    expect(vifEdge!.data?.utilizationEgressBps).toBe(3.5e9);
  });

  it('VIFs targeting different gateways are NOT aggregated together', () => {
    const topo = makeMultiVifTopology(4);
    topo.dxGateways.push(
      { directConnectGatewayId: 'dxgw-002', directConnectGatewayName: 'DXGW-DR', directConnectGatewayState: 'available', amazonSideAsn: 64513 },
    );
    // Move 2 VIFs to the second DXGW
    topo.virtualInterfaces[2].directConnectGatewayId = 'dxgw-002';
    topo.virtualInterfaces[3].directConnectGatewayId = 'dxgw-002';

    const { edges } = buildGraph(topo, new Set());

    const edgesToGw1 = edges.filter((e) => e.source === 'awsdev-EqDC2-dev1' && e.target === 'dxgw-dxgw-001');
    const edgesToGw2 = edges.filter((e) => e.source === 'awsdev-EqDC2-dev1' && e.target === 'dxgw-dxgw-002');
    expect(edgesToGw1.length).toBe(1);
    expect(edgesToGw2.length).toBe(1);
    expect(edgesToGw1[0].data?.aggregatedVifs).toHaveLength(2);
    expect(edgesToGw2[0].data?.aggregatedVifs).toHaveLength(2);
  });

  it('aggregated edge preserves individual VIF details in aggregatedVifs array', () => {
    const topo = makeMultiVifTopology(3);
    const { edges } = buildGraph(topo, new Set());

    const vifEdge = edges.find((e) => e.source === 'awsdev-EqDC2-dev1' && e.target === 'dxgw-dxgw-001');
    const agg = vifEdge!.data!.aggregatedVifs!;
    expect(agg[0].vifId).toBe('dxvif-000');
    expect(agg[0].vifName).toBe('VIF-0');
    expect(agg[0].vlan).toBe(100);
    expect(agg[1].vifId).toBe('dxvif-001');
    expect(agg[2].vifId).toBe('dxvif-002');
  });
});
