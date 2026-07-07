import { describe, it, expect } from 'vitest';
import { buildGraph } from '../topology-builder';
import { makeEmptyTopology } from './helpers';

function makePeeringTopology() {
  const topo = makeEmptyTopology();
  topo.homeAccountId = '111122223333';

  topo.transitGateways = [
    {
      transitGatewayId: 'tgw-aaaa1111',
      transitGatewayArn: 'arn:aws:ec2:ap-southeast-1:111122223333:transit-gateway/tgw-aaaa1111',
      state: 'available',
      ownerId: '111122223333',
      description: 'Home TGW',
      amazonSideAsn: 64512,
      tags: { Name: 'Home-TGW' },
    },
  ];

  topo.transitGatewayAttachments = [
    {
      transitGatewayAttachmentId: 'tgw-attach-vpc1',
      transitGatewayId: 'tgw-aaaa1111',
      resourceType: 'vpc',
      resourceId: 'vpc-home1',
      resourceOwnerId: '111122223333',
      state: 'available',
    },
  ];

  topo.vpcs = [
    { vpcId: 'vpc-home1', cidrBlock: '10.0.0.0/16', region: 'ap-southeast-1', ownerAccountId: '111122223333', tags: { Name: 'Home-VPC' }, state: 'available' },
  ];

  topo.dxGateways = [
    { directConnectGatewayId: 'dxgw-001', directConnectGatewayName: 'DXGW-Prod', directConnectGatewayState: 'available', amazonSideAsn: 64512 },
  ];
  topo.dxGatewayAssociations = [
    { directConnectGatewayId: 'dxgw-001', associatedGateway: { id: 'tgw-aaaa1111', type: 'transitGateway', region: 'ap-southeast-1', ownerAccount: '111122223333' }, associationState: 'associated', allowedPrefixes: ['10.0.0.0/8'] },
  ];
  topo.connections = [
    { connectionId: 'dxcon-001', connectionName: 'DX-1', connectionState: 'available', location: 'EqSG2', bandwidth: '1Gbps', region: 'ap-southeast-1' },
  ];
  topo.virtualInterfaces = [
    { virtualInterfaceId: 'dxvif-001', virtualInterfaceName: 'VIF-1', virtualInterfaceType: 'private', virtualInterfaceState: 'available', connectionId: 'dxcon-001', directConnectGatewayId: 'dxgw-001', vlan: 100, asn: 65000, bgpPeers: [{ bgpPeerId: 'bgp-1', bgpPeerState: 'available', bgpStatus: 'up', asn: 65000, customerAddress: '169.254.0.2/30', amazonAddress: '169.254.0.1/30' }], region: 'ap-southeast-1', awsLogicalDeviceId: 'EqSG2-dev1' },
  ];
  topo.locations = [
    { locationCode: 'EqSG2', locationName: 'Equinix SG2, Singapore', region: 'ap-southeast-1', availablePortSpeeds: ['1Gbps', '10Gbps'] },
  ];

  return topo;
}

describe('TGW cross-account peering', () => {
  it('synthesizes a peer TGW node when it does not exist in topology', () => {
    const topo = makePeeringTopology();
    topo.transitGatewayPeeringAttachments = [
      {
        transitGatewayAttachmentId: 'tgw-attach-peer1',
        requesterTgwInfo: { transitGatewayId: 'tgw-aaaa1111', region: 'ap-southeast-1', ownerId: '111122223333' },
        accepterTgwInfo: { transitGatewayId: 'tgw-bbbb2222', region: 'us-east-1', ownerId: '999988887777' },
        state: 'available',
        tags: { Name: 'SG-to-US-Peering' },
      },
    ];

    const { nodes } = buildGraph(topo, new Set());
    const peerNode = nodes.find((n) => n.id === 'tgw-tgw-bbbb2222');
    expect(peerNode).toBeDefined();
    expect(peerNode!.data.category).toBe('tgw');
    expect(peerNode!.data.resourceId).toBe('tgw-bbbb2222');
    expect(peerNode!.data.details?.crossAccount).toBe('true');
    expect(peerNode!.data.details?.ownerAccount).toBe('999988887777');
    expect(peerNode!.data.details?.region).toBe('us-east-1');
  });

  it('draws a peering edge between home TGW and cross-account peer TGW', () => {
    const topo = makePeeringTopology();
    topo.transitGatewayPeeringAttachments = [
      {
        transitGatewayAttachmentId: 'tgw-attach-peer1',
        requesterTgwInfo: { transitGatewayId: 'tgw-aaaa1111', region: 'ap-southeast-1', ownerId: '111122223333' },
        accepterTgwInfo: { transitGatewayId: 'tgw-bbbb2222', region: 'us-east-1', ownerId: '999988887777' },
        state: 'available',
        tags: { Name: 'SG-to-US-Peering' },
      },
    ];

    const { edges } = buildGraph(topo, new Set());
    const peeringEdge = edges.find(
      (e) => (e.source === 'tgw-tgw-aaaa1111' && e.target === 'tgw-tgw-bbbb2222')
        || (e.source === 'tgw-tgw-bbbb2222' && e.target === 'tgw-tgw-aaaa1111'),
    );
    expect(peeringEdge).toBeDefined();
    expect(peeringEdge!.data?.label).toContain('TGW Peering');
    expect(peeringEdge!.data?.label).toContain('SG-to-US-Peering');
  });

  it('sets hasPeeringHandle on both nodes', () => {
    const topo = makePeeringTopology();
    topo.transitGatewayPeeringAttachments = [
      {
        transitGatewayAttachmentId: 'tgw-attach-peer1',
        requesterTgwInfo: { transitGatewayId: 'tgw-aaaa1111', region: 'ap-southeast-1', ownerId: '111122223333' },
        accepterTgwInfo: { transitGatewayId: 'tgw-bbbb2222', region: 'ap-southeast-2', ownerId: '999988887777' },
        state: 'available',
        tags: {},
      },
    ];

    const { nodes } = buildGraph(topo, new Set());
    const homeNode = nodes.find((n) => n.id === 'tgw-tgw-aaaa1111');
    const peerNode = nodes.find((n) => n.id === 'tgw-tgw-bbbb2222');
    expect(homeNode!.data.hasPeeringHandle).toBe(true);
    expect(peerNode!.data.hasPeeringHandle).toBe(true);
  });

  it('does not duplicate node when peer TGW already exists in topology', () => {
    const topo = makePeeringTopology();
    topo.transitGateways.push({
      transitGatewayId: 'tgw-bbbb2222',
      transitGatewayArn: 'arn:aws:ec2:us-east-1:999988887777:transit-gateway/tgw-bbbb2222',
      state: 'available',
      ownerId: '999988887777',
      description: 'Peer TGW',
      amazonSideAsn: 64513,
      tags: { Name: 'Peer-TGW-US' },
    });
    topo.transitGatewayPeeringAttachments = [
      {
        transitGatewayAttachmentId: 'tgw-attach-peer1',
        requesterTgwInfo: { transitGatewayId: 'tgw-aaaa1111', region: 'ap-southeast-1', ownerId: '111122223333' },
        accepterTgwInfo: { transitGatewayId: 'tgw-bbbb2222', region: 'us-east-1', ownerId: '999988887777' },
        state: 'available',
        tags: {},
      },
    ];

    const { nodes } = buildGraph(topo, new Set());
    const peerNodes = nodes.filter((n) => n.id === 'tgw-tgw-bbbb2222');
    expect(peerNodes.length).toBe(1);
  });

  it('creates a region container for the peer TGW when region is new', () => {
    const topo = makePeeringTopology();
    topo.transitGatewayPeeringAttachments = [
      {
        transitGatewayAttachmentId: 'tgw-attach-peer1',
        requesterTgwInfo: { transitGatewayId: 'tgw-aaaa1111', region: 'ap-southeast-1', ownerId: '111122223333' },
        accepterTgwInfo: { transitGatewayId: 'tgw-cccc3333', region: 'eu-west-1', ownerId: '444455556666' },
        state: 'available',
        tags: {},
      },
    ];

    const { nodes } = buildGraph(topo, new Set());
    const regionNode = nodes.find((n) => n.id === 'region-eu-west-1');
    expect(regionNode).toBeDefined();
    expect(regionNode!.data.category).toBe('region');
  });

  it('deduplicates peering edges for the same TGW pair', () => {
    const topo = makePeeringTopology();
    topo.transitGatewayPeeringAttachments = [
      {
        transitGatewayAttachmentId: 'tgw-attach-peer1',
        requesterTgwInfo: { transitGatewayId: 'tgw-aaaa1111', region: 'ap-southeast-1', ownerId: '111122223333' },
        accepterTgwInfo: { transitGatewayId: 'tgw-bbbb2222', region: 'us-east-1', ownerId: '999988887777' },
        state: 'available',
        tags: {},
      },
      {
        transitGatewayAttachmentId: 'tgw-attach-peer2',
        requesterTgwInfo: { transitGatewayId: 'tgw-bbbb2222', region: 'us-east-1', ownerId: '999988887777' },
        accepterTgwInfo: { transitGatewayId: 'tgw-aaaa1111', region: 'ap-southeast-1', ownerId: '111122223333' },
        state: 'available',
        tags: {},
      },
    ];

    const { edges } = buildGraph(topo, new Set());
    const peeringEdges = edges.filter((e) => e.data?.label?.includes('TGW Peering'));
    expect(peeringEdges.length).toBe(1);
  });

  it('marks synthesized same-account peer TGW without crossAccount flag', () => {
    const topo = makePeeringTopology();
    topo.transitGatewayPeeringAttachments = [
      {
        transitGatewayAttachmentId: 'tgw-attach-peer1',
        requesterTgwInfo: { transitGatewayId: 'tgw-aaaa1111', region: 'ap-southeast-1', ownerId: '111122223333' },
        accepterTgwInfo: { transitGatewayId: 'tgw-dddd4444', region: 'us-west-2', ownerId: '111122223333' },
        state: 'available',
        tags: {},
      },
    ];

    const { nodes } = buildGraph(topo, new Set());
    const peerNode = nodes.find((n) => n.id === 'tgw-tgw-dddd4444');
    expect(peerNode).toBeDefined();
    expect(peerNode!.data.details?.crossAccount).toBeUndefined();
  });
});
