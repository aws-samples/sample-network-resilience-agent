import type { TopologyData } from '../../../types/topology';

/** Shared hub with prod/stage VPCs, a second hub, and two VIFs sharing one port. */
export function makeTaggedTopology(): TopologyData {
  const region = 'ap-southeast-1';
  return {
    homeAccountId: '111111111111',
    connections: ['a', 'b'].map((id) => ({
      connectionId: `dxcon-${id}`, connectionName: `Connection ${id}`,
      connectionState: 'available', location: `Location-${id}`, bandwidth: '1Gbps', region,
      awsLogicalDeviceId: `device-${id}`, tags: {},
    })),
    virtualInterfaces: [
      { id: 'primary', connection: 'a', gateway: 'a' },
      { id: 'backup', connection: 'b', gateway: 'a' },
      { id: 'other', connection: 'a', gateway: 'b' },
    ].map(({ id, connection, gateway }) => ({
      virtualInterfaceId: `dxvif-${id}`, virtualInterfaceName: id,
      virtualInterfaceType: 'transit', virtualInterfaceState: 'available',
      connectionId: `dxcon-${connection}`, directConnectGatewayId: `dxgw-${gateway}`,
      vlan: 100, asn: 65000, bgpPeers: [], region, location: `Location-${connection}`,
      tags: { Path: id },
    })),
    dxGateways: ['a', 'b'].map((id) => ({
      directConnectGatewayId: `dxgw-${id}`, directConnectGatewayName: `Gateway ${id}`,
      amazonSideAsn: 64512, directConnectGatewayState: 'available', tags: { Gateway: id },
    })),
    dxGatewayAssociations: ['a', 'b'].map((id) => ({
      directConnectGatewayId: `dxgw-${id}`, associationState: 'associated', allowedPrefixes: [],
      associatedGateway: { id: `tgw-${id}`, type: 'transitGateway', region, ownerAccount: '111111111111' },
    })),
    locations: ['a', 'b'].map((id) => ({
      locationCode: `Location-${id}`, locationName: `Location ${id}`, region, availablePortSpeeds: ['1Gbps'],
    })),
    lags: [],
    vpcs: [
      { vpcId: 'vpc-prod', cidrBlock: '10.0.0.0/16', tags: { Name: 'Production', Environment: 'prod', Team: 'payments', Empty: '' }, region, state: 'available' },
      { vpcId: 'vpc-stage', cidrBlock: '10.1.0.0/16', tags: { Name: 'Staging', Environment: 'stage', Team: 'payments' }, region, state: 'available' },
      { vpcId: 'vpc-other', cidrBlock: '10.2.0.0/16', tags: { Name: 'Other', Environment: 'test', Team: 'support' }, region, state: 'available' },
    ],
    transitGateways: ['a', 'b'].map((id) => ({
      transitGatewayId: `tgw-${id}`,
      transitGatewayArn: `arn:aws:ec2:${region}:111111111111:transit-gateway/tgw-${id}`,
      state: 'available', ownerId: '111111111111', description: '', amazonSideAsn: 64512,
      tags: { Name: `Hub ${id}` },
    })),
    transitGatewayAttachments: [
      { id: 'prod', gateway: 'a' }, { id: 'stage', gateway: 'a' }, { id: 'other', gateway: 'b' },
    ].map(({ id, gateway }) => ({
      transitGatewayAttachmentId: `tgw-attach-${id}`, transitGatewayId: `tgw-${gateway}`,
      resourceType: 'vpc', resourceId: `vpc-${id}`, resourceOwnerId: '111111111111', state: 'available',
      tags: { Attachment: id },
    })),
    vpnGateways: [],
    vpnConnections: [{
      vpnConnectionId: 'vpn-backup', transitGatewayId: 'tgw-a', customerGatewayId: 'cgw-backup',
      state: 'available', type: 'ipsec.1', category: 'VPN', customerGatewayAddress: '192.0.2.1',
      tunnels: [], tags: { Name: 'Backup VPN' },
    }],
    customerGateways: [{
      customerGatewayId: 'cgw-backup', bgpAsn: '65000', ipAddress: '192.0.2.1',
      state: 'available', type: 'ipsec.1', tags: { Router: 'backup' },
    }],
    transitGatewayPeeringAttachments: [],
    vpcPeerings: [],
    cloudWanCoreNetworks: [],
    cloudWanAttachments: [],
    cloudWanPeerings: [],
    tgwRouteTables: new Map(),
    vpcRouteTables: new Map(),
    cloudWanRoutes: new Map(),
  };
}
