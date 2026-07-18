import type { TopologyData } from '../../../types/topology';
import { mockRoutesForTgw, mockVpcRouteTables } from '../../../utils/mock-data';

/**
 * Test-only fixture for the VPN-only engine tests. This topology used to ship as
 * a selectable demo scenario ("VPN Only") but was removed from the demo UI; it
 * lives on here purely as a fixture for vpn-only.test.ts.
 *
 * Zero Direct Connect — a Site-to-Site VPN estate terminating on a TGW. Every DX
 * array is intentionally empty so it exercises the dxNotInUse path end-to-end
 * (assessment flag, VPN rules still firing, builder, and the standalone Customer
 * Data Center container layout). All identifiers are synthetic.
 */
export const vpnOnlyTopology: TopologyData = {
  homeAccountId: '123456789012',
  bgpPrefixMetrics: new Map(),
  vifUtilization: new Map(),
  connectionUtilization: new Map(),
  utilizationWindowDays: 30,
  locations: [],
  connections: [],
  virtualInterfaces: [],
  dxGateways: [],
  dxGatewayAssociations: [],
  lags: [],
  vpcs: [
    { vpcId: 'vpc-vpn01', cidrBlock: '10.0.0.0/16', tags: { Name: 'Production-VPC' }, region: 'eu-west-1', state: 'available' },
    { vpcId: 'vpc-vpn02', cidrBlock: '10.1.0.0/16', tags: { Name: 'Shared-Services-VPC' }, region: 'eu-west-1', state: 'available' },
  ],
  vpnGateways: [],
  vpnConnections: [
    {
      vpnConnectionId: 'vpn-primary01',
      transitGatewayId: 'tgw-vpnhub01',
      customerGatewayId: 'cgw-hq01',
      state: 'available',
      type: 'ipsec.1',
      category: 'VPN',
      customerGatewayAddress: '198.51.100.10',
      tunnels: [
        { outsideIpAddress: '52.19.40.1', status: 'UP', acceptedRouteCount: 12, dpdTimeoutSeconds: 30, dpdTimeoutAction: 'clear' },
        { outsideIpAddress: '52.19.40.2', status: 'UP', acceptedRouteCount: 12, dpdTimeoutSeconds: 30, dpdTimeoutAction: 'clear' },
      ],
      tags: { Name: 'VPN-HQ-Primary' },
    },
    {
      vpnConnectionId: 'vpn-secondary01',
      transitGatewayId: 'tgw-vpnhub01',
      customerGatewayId: 'cgw-dr01',
      state: 'available',
      type: 'ipsec.1',
      category: 'VPN',
      customerGatewayAddress: '203.0.113.20',
      tunnels: [
        { outsideIpAddress: '52.19.41.1', status: 'UP', acceptedRouteCount: 8, dpdTimeoutSeconds: 30, dpdTimeoutAction: 'clear' },
        { outsideIpAddress: '52.19.41.2', status: 'DOWN', statusMessage: 'IPSEC IS DOWN', dpdTimeoutSeconds: 30, dpdTimeoutAction: 'clear' },
      ],
      tags: { Name: 'VPN-DR-Site' },
    },
  ],
  customerGateways: [
    {
      customerGatewayId: 'cgw-hq01',
      bgpAsn: '65000',
      ipAddress: '198.51.100.10',
      state: 'available',
      type: 'ipsec.1',
      tags: { Name: 'HQ-VPN-Router' },
    },
    {
      customerGatewayId: 'cgw-dr01',
      bgpAsn: '65001',
      ipAddress: '203.0.113.20',
      state: 'available',
      type: 'ipsec.1',
      tags: { Name: 'DR-Site-VPN-Router' },
    },
  ],
  transitGateways: [
    {
      transitGatewayId: 'tgw-vpnhub01',
      transitGatewayArn: 'arn:aws:ec2:eu-west-1:123456789012:transit-gateway/tgw-vpnhub01',
      state: 'available',
      ownerId: '123456789012',
      description: 'VPN Hub Transit Gateway',
      amazonSideAsn: 64512,
      tags: { Name: 'VPN-Hub-TGW' },
    },
  ],
  transitGatewayAttachments: [
    {
      transitGatewayAttachmentId: 'tgw-attach-vpn01',
      transitGatewayId: 'tgw-vpnhub01',
      resourceType: 'vpc',
      resourceId: 'vpc-vpn01',
      resourceOwnerId: '123456789012',
      state: 'available',
    },
    {
      transitGatewayAttachmentId: 'tgw-attach-vpn02',
      transitGatewayId: 'tgw-vpnhub01',
      resourceType: 'vpc',
      resourceId: 'vpc-vpn02',
      resourceOwnerId: '123456789012',
      state: 'available',
    },
    {
      transitGatewayAttachmentId: 'tgw-attach-vpnconn01',
      transitGatewayId: 'tgw-vpnhub01',
      resourceType: 'vpn',
      resourceId: 'vpn-primary01',
      resourceOwnerId: '123456789012',
      state: 'available',
    },
    {
      transitGatewayAttachmentId: 'tgw-attach-vpnconn02',
      transitGatewayId: 'tgw-vpnhub01',
      resourceType: 'vpn',
      resourceId: 'vpn-secondary01',
      resourceOwnerId: '123456789012',
      state: 'available',
    },
  ],
  transitGatewayPeeringAttachments: [],
  vpcPeerings: [],
  tgwRouteTables: new Map([
    ['tgw-vpnhub01', mockRoutesForTgw('tgw-vpnhub01', ['10.0.0.0/16', '10.1.0.0/16'], ['tgw-attach-vpn01', 'tgw-attach-vpn02'])],
  ]),
  vpcRouteTables: new Map([
    ['vpc-vpn01', mockVpcRouteTables('vpc-vpn01', '10.0.0.0/16', {
      publicSubnetId: 'subnet-pub-vpn01',
      privateSubnetIds: ['subnet-priv-vpn01a', 'subnet-priv-vpn01b'],
      igwId: 'igw-vpn01',
      natGatewayId: 'nat-vpn01',
      tgwId: 'tgw-vpnhub01',
      tgwRoutes: ['10.1.0.0/16', '192.168.0.0/16'],
    })],
    ['vpc-vpn02', mockVpcRouteTables('vpc-vpn02', '10.1.0.0/16', {
      privateSubnetIds: ['subnet-priv-vpn02a'],
      tgwId: 'tgw-vpnhub01',
      tgwRoutes: ['10.0.0.0/16', '192.168.0.0/16'],
    })],
  ]),
  cloudWanCoreNetworks: [],
  cloudWanAttachments: [],
  cloudWanPeerings: [],
  cloudWanRoutes: new Map(),
};
