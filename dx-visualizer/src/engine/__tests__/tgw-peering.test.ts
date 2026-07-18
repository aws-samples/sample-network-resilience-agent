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

  it('keeps the Name tag on the edge when the unnamed per-side record is listed first', () => {
    // A single intra-region peering surfaces as two per-side attachment objects;
    // only the requester side carries the Name tag. AWS returns them in
    // arbitrary order — here the unnamed accepter-side record comes first. The
    // edge label must still show the Name (prefer-named dedup), not bare
    // "TGW Peering", and must not flap based on ordering.
    const topo = makePeeringTopology();
    topo.transitGateways.push({
      transitGatewayId: 'tgw-bbbb2222',
      transitGatewayArn: 'arn:aws:ec2:ap-southeast-1:111122223333:transit-gateway/tgw-bbbb2222',
      state: 'available',
      ownerId: '111122223333',
      description: 'Peer TGW',
      amazonSideAsn: 64513,
      tags: { Name: 'Peer-TGW' },
    });
    topo.transitGatewayPeeringAttachments = [
      {
        transitGatewayAttachmentId: 'tgw-attach-accepter',
        requesterTgwInfo: { transitGatewayId: 'tgw-aaaa1111', region: 'ap-southeast-1', ownerId: '111122223333' },
        accepterTgwInfo: { transitGatewayId: 'tgw-bbbb2222', region: 'ap-southeast-1', ownerId: '111122223333' },
        state: 'available',
        tags: {},
      },
      {
        transitGatewayAttachmentId: 'tgw-attach-requester',
        requesterTgwInfo: { transitGatewayId: 'tgw-aaaa1111', region: 'ap-southeast-1', ownerId: '111122223333' },
        accepterTgwInfo: { transitGatewayId: 'tgw-bbbb2222', region: 'ap-southeast-1', ownerId: '111122223333' },
        state: 'available',
        tags: { Name: 'my-tgw-peering' },
      },
    ];

    const { edges } = buildGraph(topo, new Set());
    const peeringEdges = edges.filter((e) => e.data?.label?.includes('TGW Peering'));
    expect(peeringEdges.length).toBe(1);
    expect(peeringEdges[0].data?.label).toContain('my-tgw-peering');
  });

  // Regression: a Cloud WAN↔TGW peering must render only as the "Cloud WAN
  // Peering" edge from the core network — never as a phantom TGW node.
  //
  // DescribeTransitGatewayPeeringAttachments *also* returns Cloud WAN↔TGW
  // peerings, but the Cloud WAN side comes back with an empty TGW id (AWS has
  // no TGW id to give for a core network). The old code only bailed on an empty
  // region, so it synthesized a nameless, id-less "Transit Gateway" node
  // (id `tgw-`) plus a spurious "TGW Peering" edge — a broken duplicate of the
  // Cloud WAN peering that is already drawn correctly. This mirrors the real
  // snapshot: core network `poc-summit-sg-cloudwan01` peered to `sin-tgw-01`.
  function makeCloudWanTgwPeeringTopology() {
    const topo = makePeeringTopology();
    topo.cloudWanCoreNetworks = [
      {
        coreNetworkId: 'core-network-cwan1',
        coreNetworkArn: 'arn:aws:networkmanager::111122223333:core-network/core-network-cwan1',
        globalNetworkId: 'global-network-1',
        description: 'poc-cloudwan01',
        state: 'available',
        edges: [{ edgeLocation: 'ap-southeast-1', asn: 65502, insideCidrBlocks: [] }],
        segments: [{ name: 'Production', edgeLocations: ['ap-southeast-1'], sharedSegments: [] }],
      },
    ];
    // The Cloud WAN peering record — the *correct* representation of the link.
    topo.cloudWanPeerings = [
      {
        peeringId: 'peering-cwan1',
        coreNetworkId: 'core-network-cwan1',
        peeringType: 'TRANSIT_GATEWAY',
        edgeLocation: 'ap-southeast-1',
        resourceArn: 'arn:aws:ec2:ap-southeast-1:111122223333:transit-gateway/tgw-aaaa1111',
        state: 'available',
        tags: { Name: 'poc-cloudwan-tgw' },
      },
    ];
    // The same link as it surfaces via TGW peering attachments: requester side
    // (the core network) has an EMPTY transitGatewayId.
    topo.transitGatewayPeeringAttachments = [
      {
        transitGatewayAttachmentId: 'tgw-attach-cwan',
        requesterTgwInfo: { transitGatewayId: '', region: 'ap-southeast-1', ownerId: '111122223333' },
        accepterTgwInfo: { transitGatewayId: 'tgw-aaaa1111', region: 'ap-southeast-1', ownerId: '111122223333' },
        state: 'available',
        tags: {},
      },
    ];
    return topo;
  }

  it('does not synthesize a phantom TGW node for a Cloud WAN↔TGW peering (empty requester id)', () => {
    const { nodes, edges } = buildGraph(makeCloudWanTgwPeeringTopology(), new Set());
    // No phantom node with the empty-id `tgw-` id.
    expect(nodes.some((n) => n.id === 'tgw-')).toBe(false);
    // No TGW-category node with a blank/empty resourceId.
    expect(nodes.some((n) => n.data.category === 'tgw' && !n.data.resourceId)).toBe(false);
    // No edge anchored to the empty-id node.
    expect(edges.some((e) => e.source === 'tgw-' || e.target === 'tgw-')).toBe(false);
    // No spurious "TGW Peering" edge at all — this link is a Cloud WAN peering.
    expect(edges.some((e) => e.data?.label?.includes('TGW Peering'))).toBe(false);
  });

  it('still renders the correct Cloud WAN peering edge to the real TGW', () => {
    const { nodes, edges } = buildGraph(makeCloudWanTgwPeeringTopology(), new Set());
    // The core network node exists.
    expect(nodes.some((n) => n.id === 'cwan-core-network-cwan1')).toBe(true);
    // The real TGW keeps its full identity (name/id), not a blank card.
    const realTgw = nodes.find((n) => n.id === 'tgw-tgw-aaaa1111');
    expect(realTgw).toBeDefined();
    expect(realTgw!.data.resourceId).toBe('tgw-aaaa1111');
    // The correct Cloud WAN Peering edge from core network → real TGW survives.
    const cwanEdge = edges.find(
      (e) => e.source === 'cwan-core-network-cwan1' && e.target === 'tgw-tgw-aaaa1111',
    );
    expect(cwanEdge).toBeDefined();
    expect(cwanEdge!.data?.label).toContain('Cloud WAN Peering');
    // And the real TGW gets a peering handle so the edge anchors visually.
    expect(realTgw!.data.hasPeeringHandle).toBe(true);
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
