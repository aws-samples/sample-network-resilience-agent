import { describe, it, expect } from 'vitest';
import { buildGraph } from '../topology-builder';
import type { TopologyData } from '../../types/topology';

function makeMinimalTopology(overrides: Partial<TopologyData> = {}): TopologyData {
  return {
    connections: [],
    virtualInterfaces: [],
    dxGateways: [],
    dxGatewayAssociations: [],
    transitGateways: [],
    transitGatewayAttachments: [],
    transitGatewayPeeringAttachments: [],
    vpnGateways: [],
    vpcs: [],
    vpnConnections: [],
    customerGateways: [],
    locations: [],
    lags: [],
    vpcPeerings: [],
    cloudWanCoreNetworks: [],
    cloudWanAttachments: [],
    cloudWanPeerings: [],
    ...overrides,
  } as unknown as TopologyData;
}

describe('Public VIF visualization', () => {
  it('creates a single consolidated publicResources node', () => {
    const topology = makeMinimalTopology({
      connections: [{
        connectionId: 'dxcon-001',
        connectionName: 'DX-Connection-1',
        connectionState: 'available',
        location: 'EqSG2',
        bandwidth: '1Gbps',
        region: 'ap-southeast-1',
        hasBfd: false,
        awsDeviceV2: 'EqSG2-device1',
        awsLogicalDeviceId: 'EqSG2-lg1',
      }],
      virtualInterfaces: [{
        virtualInterfaceId: 'dxvif-pub01',
        virtualInterfaceName: 'My-Public-VIF',
        virtualInterfaceType: 'public',
        virtualInterfaceState: 'available',
        connectionId: 'dxcon-001',
        vlan: 300,
        asn: 65000,
        addressFamily: 'ipv4',
        mtu: 1500,
        bgpPeers: [
          { bgpPeerId: 'bgp-1', bgpPeerState: 'available', bgpStatus: 'up', asn: 65000, customerAddress: '169.254.0.2/30', amazonAddress: '169.254.0.1/30' },
        ],
        routeFilterPrefixes: [{ cidr: '203.0.113.0/24' }],
        region: 'ap-southeast-1',
        awsDeviceV2: 'EqSG2-device1',
        awsLogicalDeviceId: 'EqSG2-lg1',
      }],
      locations: [{ locationCode: 'EqSG2', locationName: 'Equinix SG2', region: 'ap-southeast-1', availablePortSpeeds: ['1Gbps'] }],
      publicVifResources: [
        { virtualInterfaceId: 'dxvif-pub01', service: 'S3', resourceId: 'arn:aws:s3:::my-bucket', resourceName: 'my-bucket' },
        { virtualInterfaceId: 'dxvif-pub01', service: 'CloudFront', resourceId: 'arn:aws:cloudfront::123:distribution/E1ABC', resourceName: 'E1ABC' },
      ],
    });

    const { nodes } = buildGraph(topology, new Set());

    const pubNode = nodes.find((n) => n.id === 'pub-endpoints');
    expect(pubNode).toBeDefined();
    expect(pubNode!.data.category).toBe('publicResources');
    expect(pubNode!.data.label).toBe('AWS Public Endpoints');
    expect(pubNode!.data.details?.services).toBe('S3: my-bucket | CloudFront: E1ABC');
    expect(pubNode!.data.details?.vifCount).toBe('1');
  });

  it('omits services when no publicVifResources mapped', () => {
    const topology = makeMinimalTopology({
      connections: [{
        connectionId: 'dxcon-001',
        connectionName: 'DX-Connection-1',
        connectionState: 'available',
        location: 'EqSG2',
        bandwidth: '1Gbps',
        region: 'ap-southeast-1',
        hasBfd: false,
        awsDeviceV2: 'EqSG2-device1',
        awsLogicalDeviceId: 'EqSG2-lg1',
      }],
      virtualInterfaces: [{
        virtualInterfaceId: 'dxvif-pub01',
        virtualInterfaceName: 'Public-VIF-No-Resources',
        virtualInterfaceType: 'public',
        virtualInterfaceState: 'available',
        connectionId: 'dxcon-001',
        vlan: 300,
        asn: 65000,
        bgpPeers: [{ bgpPeerId: 'bgp-1', bgpPeerState: 'available', bgpStatus: 'up', asn: 65000, customerAddress: '169.254.0.2/30', amazonAddress: '169.254.0.1/30' }],
        region: 'ap-southeast-1',
        awsDeviceV2: 'EqSG2-device1',
        awsLogicalDeviceId: 'EqSG2-lg1',
      }],
      locations: [{ locationCode: 'EqSG2', locationName: 'Equinix SG2', region: 'ap-southeast-1', availablePortSpeeds: ['1Gbps'] }],
    });

    const { nodes } = buildGraph(topology, new Set());

    const pubNode = nodes.find((n) => n.id === 'pub-endpoints');
    expect(pubNode).toBeDefined();
    expect(pubNode!.data.details?.services).toBeUndefined();
  });

  it('creates edges from all AWS devices to the single publicResources node', () => {
    const topology = makeMinimalTopology({
      connections: [{
        connectionId: 'dxcon-001',
        connectionName: 'DX-Connection-1',
        connectionState: 'available',
        location: 'EqSG2',
        bandwidth: '1Gbps',
        region: 'ap-southeast-1',
        hasBfd: false,
        awsDeviceV2: 'EqSG2-device1',
        awsLogicalDeviceId: 'EqSG2-lg1',
      }],
      virtualInterfaces: [{
        virtualInterfaceId: 'dxvif-pub01',
        virtualInterfaceName: 'My-Public-VIF',
        virtualInterfaceType: 'public',
        virtualInterfaceState: 'available',
        connectionId: 'dxcon-001',
        vlan: 300,
        asn: 65000,
        bgpPeers: [
          { bgpPeerId: 'bgp-1', bgpPeerState: 'available', bgpStatus: 'up', asn: 65000, customerAddress: '169.254.0.2/30', amazonAddress: '169.254.0.1/30' },
        ],
        region: 'ap-southeast-1',
        awsDeviceV2: 'EqSG2-device1',
        awsLogicalDeviceId: 'EqSG2-lg1',
      }],
      locations: [{ locationCode: 'EqSG2', locationName: 'Equinix SG2', region: 'ap-southeast-1', availablePortSpeeds: ['1Gbps'] }],
    });

    const { edges } = buildGraph(topology, new Set());

    const pubEdge = edges.find((e) => e.target === 'pub-endpoints');
    expect(pubEdge).toBeDefined();
    expect(pubEdge!.source).toBe('awsdev-EqSG2-lg1');
    expect(pubEdge!.data?.vifType).toBe('public');
    expect(pubEdge!.data?.vlan).toBe(300);
    expect(pubEdge!.data?.bgpStatus).toBe('up');
    expect(pubEdge!.data?.vifId).toBe('dxvif-pub01');
  });

  it('multiple public VIFs converge on single node with multiple edges', () => {
    const topology = makeMinimalTopology({
      connections: [
        {
          connectionId: 'dxcon-001',
          connectionName: 'DX-Conn-1',
          connectionState: 'available',
          location: 'EqSG2',
          bandwidth: '1Gbps',
          region: 'ap-southeast-1',
          hasBfd: false,
          awsDeviceV2: 'EqSG2-device1',
          awsLogicalDeviceId: 'EqSG2-lg1',
        },
        {
          connectionId: 'dxcon-002',
          connectionName: 'DX-Conn-2',
          connectionState: 'available',
          location: 'EqSG3',
          bandwidth: '1Gbps',
          region: 'ap-southeast-1',
          hasBfd: false,
          awsDeviceV2: 'EqSG3-device2',
          awsLogicalDeviceId: 'EqSG3-lg2',
        },
      ],
      virtualInterfaces: [
        {
          virtualInterfaceId: 'dxvif-pub01',
          virtualInterfaceName: 'Public-VIF-SG2',
          virtualInterfaceType: 'public',
          virtualInterfaceState: 'available',
          connectionId: 'dxcon-001',
          vlan: 300,
          asn: 65000,
          bgpPeers: [{ bgpPeerId: 'bgp-1', bgpPeerState: 'available', bgpStatus: 'up', asn: 65000, customerAddress: '169.254.0.2/30', amazonAddress: '169.254.0.1/30' }],
          region: 'ap-southeast-1',
          awsDeviceV2: 'EqSG2-device1',
          awsLogicalDeviceId: 'EqSG2-lg1',
        },
        {
          virtualInterfaceId: 'dxvif-pub02',
          virtualInterfaceName: 'Public-VIF-SG3',
          virtualInterfaceType: 'public',
          virtualInterfaceState: 'available',
          connectionId: 'dxcon-002',
          vlan: 400,
          asn: 65001,
          bgpPeers: [{ bgpPeerId: 'bgp-2', bgpPeerState: 'available', bgpStatus: 'up', asn: 65001, customerAddress: '169.254.1.2/30', amazonAddress: '169.254.1.1/30' }],
          region: 'ap-southeast-1',
          awsDeviceV2: 'EqSG3-device2',
          awsLogicalDeviceId: 'EqSG3-lg2',
        },
      ],
      locations: [
        { locationCode: 'EqSG2', locationName: 'Equinix SG2', region: 'ap-southeast-1', availablePortSpeeds: ['1Gbps'] },
        { locationCode: 'EqSG3', locationName: 'Equinix SG3', region: 'ap-southeast-1', availablePortSpeeds: ['1Gbps'] },
      ],
    });

    const { nodes, edges } = buildGraph(topology, new Set());

    const pubNodes = nodes.filter((n) => n.data.category === 'publicResources');
    expect(pubNodes).toHaveLength(1);
    expect(pubNodes[0].id).toBe('pub-endpoints');
    expect(pubNodes[0].data.details?.vifCount).toBe('2');

    const pubEdges = edges.filter((e) => e.target === 'pub-endpoints');
    expect(pubEdges).toHaveLength(2);
    expect(pubEdges.map((e) => e.source).sort()).toEqual(['awsdev-EqSG2-lg1', 'awsdev-EqSG3-lg2']);
  });

  it('does not create publicResources nodes for private or transit VIFs', () => {
    const topology = makeMinimalTopology({
      connections: [{
        connectionId: 'dxcon-001',
        connectionName: 'DX-Connection-1',
        connectionState: 'available',
        location: 'EqSG2',
        bandwidth: '1Gbps',
        region: 'ap-southeast-1',
        hasBfd: false,
        awsDeviceV2: 'EqSG2-device1',
        awsLogicalDeviceId: 'EqSG2-lg1',
      }],
      virtualInterfaces: [
        {
          virtualInterfaceId: 'dxvif-priv01',
          virtualInterfaceName: 'Private-VIF',
          virtualInterfaceType: 'private',
          virtualInterfaceState: 'available',
          connectionId: 'dxcon-001',
          directConnectGatewayId: 'dxgw-001',
          vlan: 100,
          asn: 65000,
          bgpPeers: [],
          region: 'ap-southeast-1',
          awsDeviceV2: 'EqSG2-device1',
          awsLogicalDeviceId: 'EqSG2-lg1',
        },
        {
          virtualInterfaceId: 'dxvif-transit01',
          virtualInterfaceName: 'Transit-VIF',
          virtualInterfaceType: 'transit',
          virtualInterfaceState: 'available',
          connectionId: 'dxcon-001',
          directConnectGatewayId: 'dxgw-001',
          vlan: 200,
          asn: 65000,
          bgpPeers: [],
          region: 'ap-southeast-1',
          awsDeviceV2: 'EqSG2-device1',
          awsLogicalDeviceId: 'EqSG2-lg1',
        },
      ],
      dxGateways: [{
        directConnectGatewayId: 'dxgw-001',
        directConnectGatewayName: 'My-DXGW',
        amazonSideAsn: 64512,
        directConnectGatewayState: 'available',
      }],
      locations: [{ locationCode: 'EqSG2', locationName: 'Equinix SG2', region: 'ap-southeast-1', availablePortSpeeds: ['1Gbps'] }],
    });

    const { nodes } = buildGraph(topology, new Set());

    const pubNodes = nodes.filter((n) => n.data.category === 'publicResources');
    expect(pubNodes).toHaveLength(0);
  });

  it('does not create publicResources node for public VIF that has a DXGW', () => {
    const topology = makeMinimalTopology({
      connections: [{
        connectionId: 'dxcon-001',
        connectionName: 'DX-Connection-1',
        connectionState: 'available',
        location: 'EqSG2',
        bandwidth: '1Gbps',
        region: 'ap-southeast-1',
        hasBfd: false,
        awsDeviceV2: 'EqSG2-device1',
        awsLogicalDeviceId: 'EqSG2-lg1',
      }],
      virtualInterfaces: [{
        virtualInterfaceId: 'dxvif-pub01',
        virtualInterfaceName: 'Public-VIF-With-DXGW',
        virtualInterfaceType: 'public',
        virtualInterfaceState: 'available',
        connectionId: 'dxcon-001',
        directConnectGatewayId: 'dxgw-001',
        vlan: 300,
        asn: 65000,
        bgpPeers: [],
        region: 'ap-southeast-1',
        awsDeviceV2: 'EqSG2-device1',
        awsLogicalDeviceId: 'EqSG2-lg1',
      }],
      dxGateways: [{
        directConnectGatewayId: 'dxgw-001',
        directConnectGatewayName: 'DXGW',
        amazonSideAsn: 64512,
        directConnectGatewayState: 'available',
      }],
      locations: [{ locationCode: 'EqSG2', locationName: 'Equinix SG2', region: 'ap-southeast-1', availablePortSpeeds: ['1Gbps'] }],
    });

    const { nodes } = buildGraph(topology, new Set());

    const pubNodes = nodes.filter((n) => n.data.category === 'publicResources');
    expect(pubNodes).toHaveLength(0);
  });

  it('passes BGP prefix metrics on the edge data', () => {
    const topology = makeMinimalTopology({
      connections: [{
        connectionId: 'dxcon-001',
        connectionName: 'DX-Connection-1',
        connectionState: 'available',
        location: 'EqSG2',
        bandwidth: '1Gbps',
        region: 'ap-southeast-1',
        hasBfd: false,
        awsDeviceV2: 'EqSG2-device1',
        awsLogicalDeviceId: 'EqSG2-lg1',
      }],
      virtualInterfaces: [{
        virtualInterfaceId: 'dxvif-pub01',
        virtualInterfaceName: 'Public-VIF-1',
        virtualInterfaceType: 'public',
        virtualInterfaceState: 'available',
        connectionId: 'dxcon-001',
        vlan: 300,
        asn: 65000,
        bgpPeers: [{ bgpPeerId: 'bgp-1', bgpPeerState: 'available', bgpStatus: 'up', asn: 65000, customerAddress: '169.254.0.2/30', amazonAddress: '169.254.0.1/30' }],
        region: 'ap-southeast-1',
        awsDeviceV2: 'EqSG2-device1',
        awsLogicalDeviceId: 'EqSG2-lg1',
      }],
      locations: [{ locationCode: 'EqSG2', locationName: 'Equinix SG2', region: 'ap-southeast-1', availablePortSpeeds: ['1Gbps'] }],
      bgpPrefixMetrics: new Map([['dxvif-pub01', { accepted: 2500, advertised: 10 }]]),
    });

    const { edges } = buildGraph(topology, new Set());

    const pubEdge = edges.find((e) => e.target === 'pub-endpoints');
    expect(pubEdge).toBeDefined();
    expect(pubEdge!.data?.prefixesAccepted).toBe(2500);
    expect(pubEdge!.data?.prefixesAdvertised).toBe(10);
  });
});
