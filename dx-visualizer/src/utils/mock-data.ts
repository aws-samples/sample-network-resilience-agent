import type { TopologyData } from '../types/topology';
import type { TgwRouteTableWithRoutes, VpcRouteTable } from '../types/aws-resources';
import type { MockScenario } from './shared';

export function mockRoutesForTgw(tgwId: string, vpcCidrs: string[], attachmentIds: string[]): TgwRouteTableWithRoutes[] {
  return [{
    routeTable: {
      transitGatewayRouteTableId: `tgw-rtb-${tgwId.slice(-6)}`,
      transitGatewayId: tgwId,
      state: 'available',
      defaultAssociationRouteTable: true,
      defaultPropagationRouteTable: true,
      tags: { Name: `${tgwId}-default-rtb` },
    },
    routes: [
      ...vpcCidrs.map((cidr, i) => ({
        destinationCidrBlock: cidr,
        transitGatewayAttachments: [{ transitGatewayAttachmentId: attachmentIds[i] || `tgw-attach-${tgwId.slice(-4)}-${i}`, resourceType: 'vpc', resourceId: `vpc-${i}` }],
        type: 'propagated' as const,
        state: 'active' as const,
      })),
      {
        destinationCidrBlock: '192.168.0.0/16',
        transitGatewayAttachments: [],
        type: 'static' as const,
        state: 'blackhole' as const,
      },
    ],
  }];
}

/**
 * Synthesize a default + a "private subnets" route table for a VPC. The private
 * route table sends 0.0.0.0/0 to a NAT gateway and propagates a TGW summary.
 * Mocks are intentionally generic so any VPC ID can use this helper.
 */
export function mockVpcRouteTables(
  vpcId: string,
  vpcCidr: string,
  opts: {
    publicSubnetId?: string;
    privateSubnetIds?: string[];
    igwId?: string;
    natGatewayId?: string;
    tgwId?: string;
    tgwRoutes?: string[];
    pcxId?: string;
    pcxRoutes?: string[];
  } = {},
): VpcRouteTable[] {
  const idSuffix = vpcId.slice(-6);
  const tables: VpcRouteTable[] = [
    {
      routeTableId: `rtb-main-${idSuffix}`,
      vpcId,
      isMain: true,
      associatedSubnetIds: opts.publicSubnetId ? [opts.publicSubnetId] : [],
      tags: { Name: `${vpcId}-public-rtb` },
      routes: [
        { destinationCidrBlock: vpcCidr, gatewayId: 'local', origin: 'CreateRouteTable', state: 'active' },
        ...(opts.igwId ? [{ destinationCidrBlock: '0.0.0.0/0', gatewayId: opts.igwId, origin: 'CreateRoute', state: 'active' as const }] : []),
        ...(opts.tgwId ? (opts.tgwRoutes ?? ['10.0.0.0/8']).map((cidr) => ({
          destinationCidrBlock: cidr,
          transitGatewayId: opts.tgwId,
          origin: 'CreateRoute',
          state: 'active' as const,
        })) : []),
      ],
    },
  ];
  if (opts.privateSubnetIds && opts.privateSubnetIds.length > 0) {
    tables.push({
      routeTableId: `rtb-priv-${idSuffix}`,
      vpcId,
      isMain: false,
      associatedSubnetIds: opts.privateSubnetIds,
      tags: { Name: `${vpcId}-private-rtb` },
      routes: [
        { destinationCidrBlock: vpcCidr, gatewayId: 'local', origin: 'CreateRouteTable', state: 'active' },
        ...(opts.natGatewayId ? [{ destinationCidrBlock: '0.0.0.0/0', natGatewayId: opts.natGatewayId, origin: 'CreateRoute', state: 'active' as const }] : []),
        ...(opts.tgwId ? (opts.tgwRoutes ?? ['10.0.0.0/8']).map((cidr) => ({
          destinationCidrBlock: cidr,
          transitGatewayId: opts.tgwId,
          origin: 'EnableVgwRoutePropagation',
          state: 'active' as const,
        })) : []),
        ...(opts.pcxId ? (opts.pcxRoutes ?? []).map((cidr) => ({
          destinationCidrBlock: cidr,
          vpcPeeringConnectionId: opts.pcxId,
          origin: 'CreateRoute',
          state: 'active' as const,
        })) : []),
      ],
    });
  }
  return tables;
}

export const noResiliencyTopology: TopologyData = {
  homeAccountId: '123456789012',
  bgpPrefixMetrics: new Map([
    ['dxvif-001', { accepted: 12, advertised: 5 }],
    ['dxvif-pub001', { accepted: 2200, advertised: 2 }],
  ]),
  vifUtilization: new Map([
    // ~67% of 1Gbps egress, ~22% ingress — single-connection account running hot
    ['dxvif-001', { ingressBpsPeak: 220e6, egressBpsPeak: 670e6 }],
  ]),
  connectionUtilization: new Map([
    // Connection carries the same VIF — port-level numbers ride a hair higher
    // than the VIF (jumbo overhead, BFD/LACP, etc.) so users can spot the gap.
    ['dxcon-abc001', { ingressBpsPeak: 240e6, egressBpsPeak: 690e6 }],
  ]),
  publicVifResources: [
    { virtualInterfaceId: 'dxvif-pub001', service: 'S3', resourceId: 'arn:aws:s3:::prod-data-lake-me-south-1', resourceName: 'prod-data-lake-me-south-1' },
    { virtualInterfaceId: 'dxvif-pub001', service: 'DynamoDB', resourceId: 'arn:aws:dynamodb:me-south-1:123456789012:table/Orders', resourceName: 'Orders' },
  ],
  utilizationWindowDays: 30,
  locations: [
    {
      locationCode: 'DxDXB1',
      locationName: 'AWS Direct Connect Dubai',
      region: 'me-south-1',
      availablePortSpeeds: ['1Gbps', '10Gbps'],
    },
  ],
  connections: [
    {
      connectionId: 'dxcon-abc001',
      connectionName: 'DX-Connection-Dubai',
      connectionState: 'available',
      location: 'DxDXB1',
      bandwidth: '1Gbps',
      region: 'me-south-1',
      hasBfd: false,
      awsDeviceV2: 'DxDXB1-1a2b3c4d',
      awsLogicalDeviceId: 'DxDXB1-lg1a',
    },
  ],
  virtualInterfaces: [
    {
      virtualInterfaceId: 'dxvif-001',
      virtualInterfaceName: 'Private-VIF-1',
      virtualInterfaceType: 'private',
      virtualInterfaceState: 'available',
      connectionId: 'dxcon-abc001',
      directConnectGatewayId: 'dxgw-001',
      vlan: 100,
      asn: 65000,
      bgpPeers: [
        {
          bgpPeerId: 'bgp-001',
          bgpPeerState: 'available',
          bgpStatus: 'down',
          asn: 65000,
          customerAddress: '169.254.0.2/30',
          amazonAddress: '169.254.0.1/30',
        },
      ],
      region: 'me-south-1',
      awsDeviceV2: 'DxDXB1-1a2b3c4d',
      awsLogicalDeviceId: 'DxDXB1-lg1a',
    },
    {
      virtualInterfaceId: 'dxvif-pub001',
      virtualInterfaceName: 'Public-VIF-Dubai',
      virtualInterfaceType: 'public',
      virtualInterfaceState: 'available',
      connectionId: 'dxcon-abc001',
      vlan: 300,
      asn: 65000,
      addressFamily: 'ipv4',
      mtu: 1500,
      bgpPeers: [
        {
          bgpPeerId: 'bgp-pub01',
          bgpPeerState: 'available',
          bgpStatus: 'up',
          asn: 65000,
          customerAddress: '169.254.100.2/30',
          amazonAddress: '169.254.100.1/30',
        },
      ],
      routeFilterPrefixes: [{ cidr: '203.0.113.0/24' }, { cidr: '198.51.100.0/24' }],
      region: 'me-south-1',
      awsDeviceV2: 'DxDXB1-1a2b3c4d',
      awsLogicalDeviceId: 'DxDXB1-lg1a',
    },
  ],
  dxGateways: [
    {
      directConnectGatewayId: 'dxgw-001',
      directConnectGatewayName: 'DX-Gateway-Dubai-to-SG',
      amazonSideAsn: 64512,
      directConnectGatewayState: 'available',
    },
    {
      directConnectGatewayId: 'dxgw-unused01',
      directConnectGatewayName: 'dxgw-legacy-unused',
      amazonSideAsn: 64599,
      directConnectGatewayState: 'available',
    },
  ],
  dxGatewayAssociations: [
    {
      directConnectGatewayId: 'dxgw-001',
      associatedGateway: {
        id: 'vgw-001',
        type: 'virtualPrivateGateway',
        region: 'ap-southeast-1',
        ownerAccount: '123456789012',
      },
      associationState: 'associated',
      allowedPrefixes: ['10.0.0.0/8', '172.16.0.0/12'],
    },
  ],
  lags: [],
  vpcs: [
    {
      vpcId: 'vpc-001',
      cidrBlock: '10.0.0.0/16',
      tags: { Name: 'Production-VPC' },
      region: 'ap-southeast-1',
      state: 'available',
    },
    {
      vpcId: 'vpc-002',
      cidrBlock: '10.1.0.0/16',
      tags: { Name: 'Staging-VPC' },
      region: 'ap-southeast-1',
      state: 'available',
    },
  ],
  vpnGateways: [
    {
      vpnGatewayId: 'vgw-001',
      vpcAttachments: [{ vpcId: 'vpc-001', state: 'attached' }],
      type: 'ipsec.1',
      amazonSideAsn: 64512,
      state: 'available',
      tags: { Name: 'vgw-basic-prod' },
    },
    {
      vpnGatewayId: 'vgw-detached01',
      vpcAttachments: [],
      type: 'ipsec.1',
      amazonSideAsn: 64512,
      state: 'available',
      tags: { Name: 'vgw-dx-bastion' },
    },
  ],
  vpnConnections: [
    {
      vpnConnectionId: 'vpn-basic01',
      vpnGatewayId: 'vgw-001',
      customerGatewayId: 'cgw-basic01',
      state: 'available',
      type: 'ipsec.1',
      category: 'VPN',
      customerGatewayAddress: '198.51.100.5',
      tunnels: [
        { outsideIpAddress: '54.239.10.1', status: 'UP', acceptedRouteCount: 3, dpdTimeoutSeconds: 30, dpdTimeoutAction: 'none' },
        { outsideIpAddress: '54.239.10.2', status: 'DOWN', statusMessage: 'IPSEC IS DOWN', dpdTimeoutSeconds: 30, dpdTimeoutAction: 'clear' },
      ],
      tags: { Name: 'VPN-Backup' },
    },
  ],
  customerGateways: [
    {
      customerGatewayId: 'cgw-basic01',
      bgpAsn: '65000',
      ipAddress: '198.51.100.5',
      state: 'available',
      type: 'ipsec.1',
      tags: { Name: 'OnPrem-VPN-Router' },
    },
  ],
  transitGateways: [],
  transitGatewayAttachments: [],
  transitGatewayPeeringAttachments: [],
  vpcPeerings: [],
  tgwRouteTables: new Map(),
  vpcRouteTables: new Map([
    ['vpc-001', [
      {
        routeTableId: 'rtb-main-001',
        vpcId: 'vpc-001',
        isMain: true,
        associatedSubnetIds: ['subnet-pub-001'],
        tags: { Name: 'vpc-001-public-rtb' },
        routes: [
          { destinationCidrBlock: '10.0.0.0/16', gatewayId: 'local', origin: 'CreateRouteTable', state: 'active' },
          { destinationCidrBlock: '0.0.0.0/0', gatewayId: 'igw-001', origin: 'CreateRoute', state: 'active' },
          { destinationCidrBlock: '198.51.100.0/24', gatewayId: 'vgw-001', origin: 'EnableVgwRoutePropagation', state: 'active' },
        ],
      },
      {
        routeTableId: 'rtb-priv-001',
        vpcId: 'vpc-001',
        isMain: false,
        associatedSubnetIds: ['subnet-priv-001a', 'subnet-priv-001b'],
        tags: { Name: 'vpc-001-private-rtb' },
        routes: [
          { destinationCidrBlock: '10.0.0.0/16', gatewayId: 'local', origin: 'CreateRouteTable', state: 'active' },
          { destinationCidrBlock: '0.0.0.0/0', natGatewayId: 'nat-001', origin: 'CreateRoute', state: 'active' },
          { destinationCidrBlock: '198.51.100.0/24', gatewayId: 'vgw-001', origin: 'EnableVgwRoutePropagation', state: 'active' },
        ],
      },
    ]],
    ['vpc-002', [
      {
        routeTableId: 'rtb-main-002',
        vpcId: 'vpc-002',
        isMain: true,
        associatedSubnetIds: [],
        tags: { Name: 'vpc-002-default' },
        routes: [
          { destinationCidrBlock: '10.1.0.0/16', gatewayId: 'local', origin: 'CreateRouteTable', state: 'active' },
        ],
      },
    ]],
  ]),
  cloudWanCoreNetworks: [],
  cloudWanAttachments: [],
  cloudWanPeerings: [],
  cloudWanRoutes: new Map(),
};

export const devTestTopology: TopologyData = {
  homeAccountId: '123456789012',
  bgpPrefixMetrics: new Map([
    ['dxvif-dt01', { accepted: 25, advertised: 8 }],
    ['dxvif-dt02', { accepted: 25, advertised: 8 }],
  ]),
  vifUtilization: new Map([
    ['dxvif-dt01', { ingressBpsPeak: 95e6, egressBpsPeak: 310e6 }],
    ['dxvif-dt02', { ingressBpsPeak: 88e6, egressBpsPeak: 290e6 }],
  ]),
  connectionUtilization: new Map([
    ['dxcon-dt001', { ingressBpsPeak: 110e6, egressBpsPeak: 330e6 }],
    ['dxcon-dt002', { ingressBpsPeak: 100e6, egressBpsPeak: 305e6 }],
  ]),
  utilizationWindowDays: 30,
  locations: [
    {
      locationCode: 'DxDXB1',
      locationName: 'AWS Direct Connect Dubai',
      region: 'me-south-1',
      availablePortSpeeds: ['1Gbps', '10Gbps'],
    },
  ],
  connections: [
    {
      connectionId: 'dxcon-dt001',
      connectionName: 'DX-Dubai-Primary',
      connectionState: 'available',
      location: 'DxDXB1',
      bandwidth: '1Gbps',
      region: 'me-south-1',
      hasBfd: false,
      awsDeviceV2: 'DxDXB1-1a2b3c4d',
      awsLogicalDeviceId: 'DxDXB1-lg1a',
    },
    {
      connectionId: 'dxcon-dt002',
      connectionName: 'DX-Dubai-Secondary',
      connectionState: 'available',
      location: 'DxDXB1',
      bandwidth: '1Gbps',
      region: 'me-south-1',
      hasBfd: false,
      awsDeviceV2: 'DxDXB1-5e6f7g8h',
      awsLogicalDeviceId: 'DxDXB1-lg1b',
    },
  ],
  virtualInterfaces: [
    {
      virtualInterfaceId: 'dxvif-dt01',
      virtualInterfaceName: 'Private-VIF-Primary',
      virtualInterfaceType: 'private',
      virtualInterfaceState: 'available',
      connectionId: 'dxcon-dt001',
      directConnectGatewayId: 'dxgw-dt01',
      vlan: 100,
      asn: 65000,
      bgpPeers: [
        { bgpPeerId: 'bgp-dt01', bgpPeerState: 'available', bgpStatus: 'up', asn: 65000, customerAddress: '169.254.0.2/30', amazonAddress: '169.254.0.1/30' },
      ],
      region: 'me-south-1',
      awsDeviceV2: 'DxDXB1-1a2b3c4d',
      awsLogicalDeviceId: 'DxDXB1-lg1a',
    },
    {
      virtualInterfaceId: 'dxvif-dt02',
      virtualInterfaceName: 'Private-VIF-Secondary',
      virtualInterfaceType: 'private',
      virtualInterfaceState: 'available',
      connectionId: 'dxcon-dt002',
      directConnectGatewayId: 'dxgw-dt01',
      vlan: 200,
      asn: 65000,
      bgpPeers: [
        { bgpPeerId: 'bgp-dt02', bgpPeerState: 'available', bgpStatus: 'up', asn: 65000, customerAddress: '169.254.1.2/30', amazonAddress: '169.254.1.1/30' },
      ],
      region: 'me-south-1',
      awsDeviceV2: 'DxDXB1-5e6f7g8h',
      awsLogicalDeviceId: 'DxDXB1-lg1b',
    },
  ],
  dxGateways: [
    {
      directConnectGatewayId: 'dxgw-dt01',
      directConnectGatewayName: 'DX-Gateway-Dubai-to-SG',
      amazonSideAsn: 64512,
      directConnectGatewayState: 'available',
    },
  ],
  dxGatewayAssociations: [
    {
      directConnectGatewayId: 'dxgw-dt01',
      associatedGateway: {
        id: 'vgw-dt01',
        type: 'virtualPrivateGateway',
        region: 'ap-southeast-1',
        ownerAccount: '123456789012',
      },
      associationState: 'associated',
      allowedPrefixes: ['10.0.0.0/8', '172.16.0.0/12'],
    },
  ],
  lags: [],
  vpcs: [
    { vpcId: 'vpc-dt01', cidrBlock: '10.0.0.0/16', tags: { Name: 'Production-VPC' }, region: 'ap-southeast-1', state: 'available' },
    { vpcId: 'vpc-dt02', cidrBlock: '10.1.0.0/16', tags: { Name: 'Staging-VPC' }, region: 'ap-southeast-1', state: 'available' },
  ],
  vpnGateways: [
    {
      vpnGatewayId: 'vgw-dt01',
      vpcAttachments: [{ vpcId: 'vpc-dt01', state: 'attached' }],
      type: 'ipsec.1',
      amazonSideAsn: 64512,
      state: 'available',
      tags: { Name: 'vgw-dx-prod' },
    },
  ],
  vpnConnections: [],
  customerGateways: [],
  transitGateways: [],
  transitGatewayAttachments: [],
  transitGatewayPeeringAttachments: [],
  vpcPeerings: [],
  tgwRouteTables: new Map(),
  vpcRouteTables: new Map([
    ['vpc-dt01', mockVpcRouteTables('vpc-dt01', '10.0.0.0/16', {
      publicSubnetId: 'subnet-dt01-pub',
      privateSubnetIds: ['subnet-dt01-prv-a', 'subnet-dt01-prv-b'],
      igwId: 'igw-dt01',
      natGatewayId: 'nat-dt01',
    })],
    ['vpc-dt02', mockVpcRouteTables('vpc-dt02', '10.1.0.0/16', {
      privateSubnetIds: ['subnet-dt02-prv'],
    })],
  ]),
  cloudWanCoreNetworks: [],
  cloudWanAttachments: [],
  cloudWanPeerings: [],
  cloudWanRoutes: new Map(),
};

// Build a demo maintenance event ~14 days from today so the calendar has
// something to show in mock mode. Description mirrors the verbatim Personal
// Health Dashboard notification format so the UI reflects what real AWS
// Health responses look like.
function mockUpcomingMaintenance(): TopologyData['maintenanceEvents'] {
  const start = new Date();
  start.setDate(start.getDate() + 14);
  start.setUTCHours(19, 0, 0, 0);
  const end = new Date(start);
  end.setUTCHours(22, 0, 0, 0);
  return [{
    arn: 'arn:aws:health:us-east-1::event/DIRECTCONNECT/AWS_DIRECTCONNECT_MAINTENANCE_SCHEDULED/mock-event-001',
    eventTypeCode: 'AWS_DIRECTCONNECT_MAINTENANCE_SCHEDULED',
    region: 'ap-southeast-1',
    startTime: start.toISOString(),
    endTime: end.toISOString(),
    statusCode: 'upcoming',
    affectedResourceIds: ['dxcon-high001', 'dxvif-high01'],
    accountId: '123456789012',
    description: `Reminder: AWS Direct Connect Planned Maintenance Notification [AWS Account: 123456789012]  Planned maintenance has been scheduled on an AWS Direct Connect endpoint in Equinix SG2, Singapore from ${start.toUTCString()} to ${end.toUTCString()} for 3 hours. During this maintenance window, your AWS Direct Connect services listed below may become unavailable.

dxvif-high01
dxcon-high001

This maintenance is scheduled to avoid disrupting redundant connections at the same time.

If you encounter any problems with your connection after the end of this maintenance window, please contact AWS Support[1].

[1] https://aws.amazon.com/support`,
  }];
}

export const highResiliencyTopology: TopologyData = {
  homeAccountId: '123456789012',
  bgpPrefixMetrics: new Map([
    ['dxvif-high01', { accepted: 42, advertised: 15 }],
    ['dxvif-high02', { accepted: 38, advertised: 15 }],
    ['dxvif-high-pub01', { accepted: 2800, advertised: 3 }],
    ['dxvif-high-pub02', { accepted: 2800, advertised: 3 }],
  ]),
  vifUtilization: new Map([
    ['dxvif-high01', { ingressBpsPeak: 410e6, egressBpsPeak: 580e6 }],
    ['dxvif-high02', { ingressBpsPeak: 390e6, egressBpsPeak: 540e6 }],
  ]),
  connectionUtilization: new Map([
    ['dxcon-high001', { ingressBpsPeak: 430e6, egressBpsPeak: 610e6 }],
    ['dxcon-high002', { ingressBpsPeak: 405e6, egressBpsPeak: 565e6 }],
  ]),
  publicVifResources: [
    { virtualInterfaceId: 'dxvif-high-pub01', service: 'S3', resourceId: 'arn:aws:s3:::analytics-prod-sg', resourceName: 'analytics-prod-sg' },
    { virtualInterfaceId: 'dxvif-high-pub01', service: 'CloudFront', resourceId: 'arn:aws:cloudfront::123456789012:distribution/E1ABC2DEF3GH4I', resourceName: 'E1ABC2DEF3GH4I' },
    { virtualInterfaceId: 'dxvif-high-pub01', service: 'DynamoDB', resourceId: 'arn:aws:dynamodb:ap-southeast-1:123456789012:table/Sessions', resourceName: 'Sessions' },
    { virtualInterfaceId: 'dxvif-high-pub02', service: 'S3', resourceId: 'arn:aws:s3:::backup-dr-sg', resourceName: 'backup-dr-sg' },
    { virtualInterfaceId: 'dxvif-high-pub02', service: 'Route 53', resourceId: 'arn:aws:route53:::hostedzone/Z0123456789ABCDEFGHIJ', resourceName: 'example.com' },
  ],
  utilizationWindowDays: 30,
  maintenanceEvents: mockUpcomingMaintenance(),
  locations: [
    {
      locationCode: 'EqSG2',
      locationName: 'Equinix SG2 (Singapore)',
      region: 'ap-southeast-1',
      availablePortSpeeds: ['1Gbps', '10Gbps'],
    },
    {
      locationCode: 'EqSG3',
      locationName: 'Global Switch SG (Singapore)',
      region: 'ap-southeast-1',
      availablePortSpeeds: ['1Gbps', '10Gbps'],
    },
  ],
  connections: [
    {
      connectionId: 'dxcon-high001',
      connectionName: 'DX-SG2-Primary',
      connectionState: 'available',
      location: 'EqSG2',
      bandwidth: '1Gbps',
      region: 'ap-southeast-1',
      hasBfd: true,
      awsDeviceV2: 'EqSG2-1a2b3c4d',
      awsLogicalDeviceId: 'EqSG2-lg1a',
      lagId: 'dxlag-high01',
    },
    {
      connectionId: 'dxcon-high003',
      connectionName: 'DX-SG2-Secondary',
      connectionState: 'available',
      location: 'EqSG2',
      bandwidth: '1Gbps',
      region: 'ap-southeast-1',
      hasBfd: true,
      awsDeviceV2: 'EqSG2-1a2b3c4d',
      awsLogicalDeviceId: 'EqSG2-lg1a',
      lagId: 'dxlag-high01',
    },
    {
      connectionId: 'dxcon-high005',
      connectionName: 'DX-SG2-Tertiary',
      connectionState: 'available',
      location: 'EqSG2',
      bandwidth: '1Gbps',
      region: 'ap-southeast-1',
      hasBfd: true,
      awsDeviceV2: 'EqSG2-1a2b3c4d',
      awsLogicalDeviceId: 'EqSG2-lg1a',
      lagId: 'dxlag-high01',
    },
    {
      connectionId: 'dxcon-high006',
      connectionName: 'DX-SG2-Quaternary',
      connectionState: 'available',
      location: 'EqSG2',
      bandwidth: '1Gbps',
      region: 'ap-southeast-1',
      hasBfd: true,
      awsDeviceV2: 'EqSG2-1a2b3c4d',
      awsLogicalDeviceId: 'EqSG2-lg1a',
      lagId: 'dxlag-high01',
    },
    {
      connectionId: 'dxcon-high002',
      connectionName: 'DX-SG3-Primary',
      connectionState: 'available',
      location: 'EqSG3',
      bandwidth: '1Gbps',
      region: 'ap-southeast-1',
      hasBfd: false,
      awsDeviceV2: 'EqSG3-9i0j1k2l',
      awsLogicalDeviceId: 'EqSG3-lg2a',
      lagId: 'dxlag-high02',
    },
    {
      connectionId: 'dxcon-high004',
      connectionName: 'DX-SG3-Secondary',
      connectionState: 'available',
      location: 'EqSG3',
      bandwidth: '1Gbps',
      region: 'ap-southeast-1',
      hasBfd: false,
      awsDeviceV2: 'EqSG3-9i0j1k2l',
      awsLogicalDeviceId: 'EqSG3-lg2a',
      lagId: 'dxlag-high02',
    },
  ],
  virtualInterfaces: [
    {
      virtualInterfaceId: 'dxvif-high01',
      virtualInterfaceName: 'Transit-VIF-SG2',
      virtualInterfaceType: 'transit',
      virtualInterfaceState: 'available',
      connectionId: 'dxcon-high001',
      directConnectGatewayId: 'dxgw-high01',
      vlan: 100,
      asn: 65000,
      bgpPeers: [
        { bgpPeerId: 'bgp-h01', bgpPeerState: 'available', bgpStatus: 'up', asn: 65000, customerAddress: '169.254.0.2/30', amazonAddress: '169.254.0.1/30' },
      ],
      region: 'ap-southeast-1',
      awsDeviceV2: 'EqSG2-1a2b3c4d',
      awsLogicalDeviceId: 'EqSG2-lg1a',
    },
    {
      virtualInterfaceId: 'dxvif-high03',
      virtualInterfaceName: 'Transit-VIF-SG2-B',
      virtualInterfaceType: 'transit',
      virtualInterfaceState: 'available',
      connectionId: 'dxcon-high003',
      directConnectGatewayId: 'dxgw-high01',
      vlan: 300,
      asn: 65000,
      bgpPeers: [
        { bgpPeerId: 'bgp-h03', bgpPeerState: 'available', bgpStatus: 'up', asn: 65000, customerAddress: '169.254.2.2/30', amazonAddress: '169.254.2.1/30' },
      ],
      region: 'ap-southeast-1',
      awsDeviceV2: 'EqSG2-1a2b3c4d',
      awsLogicalDeviceId: 'EqSG2-lg1a',
    },
    {
      virtualInterfaceId: 'dxvif-high02',
      virtualInterfaceName: 'Transit-VIF-SG3',
      virtualInterfaceType: 'transit',
      virtualInterfaceState: 'available',
      connectionId: 'dxcon-high002',
      directConnectGatewayId: 'dxgw-high01',
      vlan: 200,
      asn: 65001,
      bgpPeers: [
        { bgpPeerId: 'bgp-h02', bgpPeerState: 'available', bgpStatus: 'up', asn: 65001, customerAddress: '169.254.1.2/30', amazonAddress: '169.254.1.1/30' },
      ],
      region: 'ap-southeast-1',
      awsDeviceV2: 'EqSG3-9i0j1k2l',
      awsLogicalDeviceId: 'EqSG3-lg2a',
    },
    {
      virtualInterfaceId: 'dxvif-high04',
      virtualInterfaceName: 'Transit-VIF-SG3-B',
      virtualInterfaceType: 'transit',
      virtualInterfaceState: 'available',
      connectionId: 'dxcon-high004',
      directConnectGatewayId: 'dxgw-high01',
      vlan: 400,
      asn: 65001,
      bgpPeers: [
        { bgpPeerId: 'bgp-h04', bgpPeerState: 'available', bgpStatus: 'up', asn: 65001, customerAddress: '169.254.3.2/30', amazonAddress: '169.254.3.1/30' },
      ],
      region: 'ap-southeast-1',
      awsDeviceV2: 'EqSG3-9i0j1k2l',
      awsLogicalDeviceId: 'EqSG3-lg2a',
    },
    {
      virtualInterfaceId: 'dxvif-high-pub01',
      virtualInterfaceName: 'Public-VIF-SG2',
      virtualInterfaceType: 'public',
      virtualInterfaceState: 'available',
      connectionId: 'dxcon-high001',
      vlan: 500,
      asn: 65000,
      addressFamily: 'ipv4',
      mtu: 1500,
      bgpPeers: [
        { bgpPeerId: 'bgp-hpub01', bgpPeerState: 'available', bgpStatus: 'up', asn: 65000, customerAddress: '169.254.200.2/30', amazonAddress: '169.254.200.1/30' },
      ],
      routeFilterPrefixes: [{ cidr: '203.0.113.0/24' }, { cidr: '198.51.100.0/24' }, { cidr: '192.0.2.0/24' }],
      region: 'ap-southeast-1',
      awsDeviceV2: 'EqSG2-1a2b3c4d',
      awsLogicalDeviceId: 'EqSG2-lg1a',
    },
    {
      virtualInterfaceId: 'dxvif-high-pub02',
      virtualInterfaceName: 'Public-VIF-SG3',
      virtualInterfaceType: 'public',
      virtualInterfaceState: 'available',
      connectionId: 'dxcon-high002',
      vlan: 600,
      asn: 65001,
      addressFamily: 'ipv6',
      mtu: 1500,
      bgpPeers: [
        { bgpPeerId: 'bgp-hpub02', bgpPeerState: 'available', bgpStatus: 'up', asn: 65001, customerAddress: '169.254.201.2/30', amazonAddress: '169.254.201.1/30' },
      ],
      routeFilterPrefixes: [{ cidr: '2001:db8::/32' }],
      region: 'ap-southeast-1',
      awsDeviceV2: 'EqSG3-9i0j1k2l',
      awsLogicalDeviceId: 'EqSG3-lg2a',
    },
  ],
  dxGateways: [
    {
      directConnectGatewayId: 'dxgw-high01',
      directConnectGatewayName: 'High-Resiliency-DX-Gateway',
      amazonSideAsn: 64512,
      directConnectGatewayState: 'available',
    },
  ],
  dxGatewayAssociations: [
    {
      directConnectGatewayId: 'dxgw-high01',
      associatedGateway: {
        id: 'tgw-high01',
        type: 'transitGateway',
        region: 'ap-southeast-1',
        ownerAccount: '123456789012',
      },
      associationState: 'associated',
      allowedPrefixes: ['10.0.0.0/8', '172.16.0.0/12'],
    },
    {
      // Second TGW associated to the same DX Gateway — carries the SD-WAN
      // overlay reached via TGW Connect. Allowed prefixes are disjoint from
      // tgw-high01's so the two associations don't overlap on the DXGW.
      directConnectGatewayId: 'dxgw-high01',
      associatedGateway: {
        id: 'tgw-high02',
        type: 'transitGateway',
        region: 'ap-southeast-1',
        ownerAccount: '123456789012',
      },
      associationState: 'associated',
      allowedPrefixes: ['192.168.0.0/16'],
    },
  ],
  lags: [
    {
      lagId: 'dxlag-high01',
      lagName: 'LAG-SG2-Primary',
      connectionsBandwidth: '1Gbps',
      numberOfConnections: 4,
      minimumLinks: 1,
      location: 'EqSG2',
      region: 'ap-southeast-1',
      lagState: 'available',
      connections: [
        { connectionId: 'dxcon-high001', connectionName: 'DX-SG2-Primary', connectionState: 'available', location: 'EqSG2', bandwidth: '1Gbps', region: 'ap-southeast-1', lagId: 'dxlag-high01' },
        { connectionId: 'dxcon-high003', connectionName: 'DX-SG2-Secondary', connectionState: 'available', location: 'EqSG2', bandwidth: '1Gbps', region: 'ap-southeast-1', lagId: 'dxlag-high01' },
        { connectionId: 'dxcon-high005', connectionName: 'DX-SG2-Tertiary', connectionState: 'available', location: 'EqSG2', bandwidth: '1Gbps', region: 'ap-southeast-1', lagId: 'dxlag-high01' },
        { connectionId: 'dxcon-high006', connectionName: 'DX-SG2-Quaternary', connectionState: 'available', location: 'EqSG2', bandwidth: '1Gbps', region: 'ap-southeast-1', lagId: 'dxlag-high01' },
      ],
    },
    {
      lagId: 'dxlag-high02',
      lagName: 'LAG-SG3-Primary',
      connectionsBandwidth: '1Gbps',
      numberOfConnections: 2,
      minimumLinks: 1,
      location: 'EqSG3',
      region: 'ap-southeast-1',
      lagState: 'available',
      connections: [
        { connectionId: 'dxcon-high002', connectionName: 'DX-SG3-Primary', connectionState: 'available', location: 'EqSG3', bandwidth: '1Gbps', region: 'ap-southeast-1', lagId: 'dxlag-high02' },
        { connectionId: 'dxcon-high004', connectionName: 'DX-SG3-Secondary', connectionState: 'available', location: 'EqSG3', bandwidth: '1Gbps', region: 'ap-southeast-1', lagId: 'dxlag-high02' },
      ],
    },
  ],
  vpcs: [
    { vpcId: 'vpc-high01', cidrBlock: '10.0.0.0/16', tags: { Name: 'Production-VPC' }, region: 'ap-southeast-1', state: 'available' },
    { vpcId: 'vpc-high02', cidrBlock: '10.1.0.0/16', tags: { Name: 'Staging-VPC' }, region: 'ap-southeast-1', state: 'available' },
    { vpcId: 'vpc-high03', cidrBlock: '10.2.0.0/16', tags: { Name: 'Dev-VPC' }, region: 'ap-southeast-1', state: 'available' },
  ],
  vpnGateways: [],
  vpnConnections: [
    {
      vpnConnectionId: 'vpn-high01',
      transitGatewayId: 'tgw-high01',
      customerGatewayId: 'cgw-high01',
      state: 'available',
      type: 'ipsec.1',
      category: 'VPN',
      customerGatewayAddress: '203.0.113.10',
      tunnels: [
        { outsideIpAddress: '52.46.128.1', status: 'UP', acceptedRouteCount: 5, dpdTimeoutSeconds: 30, dpdTimeoutAction: 'restart' },
        { outsideIpAddress: '52.46.128.2', status: 'UP', acceptedRouteCount: 5, dpdTimeoutSeconds: 30, dpdTimeoutAction: 'restart' },
      ],
      tags: { Name: 'VPN-Backup-Primary' },
    },
  ],
  customerGateways: [
    {
      customerGatewayId: 'cgw-high01',
      bgpAsn: '65100',
      ipAddress: '203.0.113.10',
      state: 'available',
      type: 'ipsec.1',
      tags: { Name: 'OnPrem-Router-VPN' },
    },
  ],
  transitGateways: [
    {
      transitGatewayId: 'tgw-high01',
      transitGatewayArn: 'arn:aws:ec2:ap-southeast-1:123456789012:transit-gateway/tgw-high01',
      state: 'available',
      ownerId: '123456789012',
      description: 'Production Transit Gateway',
      amazonSideAsn: 64512,
      tags: { Name: 'Prod-TGW' },
    },
    {
      transitGatewayId: 'tgw-high02',
      transitGatewayArn: 'arn:aws:ec2:ap-southeast-1:123456789012:transit-gateway/tgw-high02',
      state: 'available',
      ownerId: '123456789012',
      description: 'SD-WAN Overlay Transit Gateway',
      amazonSideAsn: 64513,
      tags: { Name: 'SDWAN-TGW' },
    },
  ],
  transitGatewayAttachments: [
    { transitGatewayAttachmentId: 'tgw-attach-h01', transitGatewayId: 'tgw-high01', resourceType: 'vpc', resourceId: 'vpc-high01', resourceOwnerId: '', state: 'available' },
    { transitGatewayAttachmentId: 'tgw-attach-h02', transitGatewayId: 'tgw-high01', resourceType: 'vpc', resourceId: 'vpc-high02', resourceOwnerId: '', state: 'available' },
    { transitGatewayAttachmentId: 'tgw-attach-h03', transitGatewayId: 'tgw-high01', resourceType: 'vpc', resourceId: 'vpc-high03', resourceOwnerId: '', state: 'available' },
    { transitGatewayAttachmentId: 'tgw-attach-hdx', transitGatewayId: 'tgw-high01', resourceType: 'direct-connect-gateway', resourceId: 'dxgw-high01', resourceOwnerId: '', state: 'available' },
    { transitGatewayAttachmentId: 'tgw-attach-hvpn', transitGatewayId: 'tgw-high01', resourceType: 'vpn', resourceId: 'vpn-high01', resourceOwnerId: '', state: 'available' },
    // Second TGW: reaches on-prem via the same DX Gateway, then carries three
    // redundant TGW Connect (GRE + BGP) peers to an SD-WAN appliance cluster.
    { transitGatewayAttachmentId: 'tgw-attach-h2dx', transitGatewayId: 'tgw-high02', resourceType: 'direct-connect-gateway', resourceId: 'dxgw-high01', resourceOwnerId: '', state: 'available' },
    { transitGatewayAttachmentId: 'tgw-attach-h2c1', transitGatewayId: 'tgw-high02', resourceType: 'connect', resourceId: 'tgw-attach-h2dx', resourceOwnerId: '', state: 'available', name: 'SDWAN-Connect-Primary' },
    { transitGatewayAttachmentId: 'tgw-attach-h2c2', transitGatewayId: 'tgw-high02', resourceType: 'connect', resourceId: 'tgw-attach-h2dx', resourceOwnerId: '', state: 'available', name: 'SDWAN-Connect-Secondary' },
    { transitGatewayAttachmentId: 'tgw-attach-h2c3', transitGatewayId: 'tgw-high02', resourceType: 'connect', resourceId: 'tgw-attach-h2dx', resourceOwnerId: '', state: 'available', name: 'SDWAN-Connect-Tertiary' },
  ],
  transitGatewayPeeringAttachments: [],
  vpcPeerings: [
    {
      vpcPeeringConnectionId: 'pcx-high01',
      state: 'active',
      requesterVpc: { vpcId: 'vpc-high01', cidrBlock: '10.0.0.0/16', ownerId: '123456789012', region: 'ap-southeast-1' },
      accepterVpc: { vpcId: 'vpc-high02', cidrBlock: '10.1.0.0/16', ownerId: '123456789012', region: 'ap-southeast-1' },
      tags: { Name: 'Prod-to-Staging' },
    },
    {
      vpcPeeringConnectionId: 'pcx-high02',
      state: 'active',
      requesterVpc: { vpcId: 'vpc-high03', cidrBlock: '10.2.0.0/16', ownerId: '123456789012', region: 'ap-southeast-1' },
      accepterVpc: { vpcId: 'vpc-shared01', cidrBlock: '172.16.0.0/16', ownerId: '999999999999', region: 'ap-southeast-1' },
      tags: { Name: 'Dev-to-SharedServices' },
    },
  ],
  tgwRouteTables: new Map([
    ['tgw-high01', mockRoutesForTgw('tgw-high01', ['10.0.0.0/16', '10.1.0.0/16', '10.2.0.0/16'], ['tgw-attach-h01', 'tgw-attach-h02', 'tgw-attach-h03'])],
    ['tgw-high02', mockRoutesForTgw('tgw-high02', ['192.168.10.0/24', '192.168.20.0/24', '192.168.30.0/24'], ['tgw-attach-h2c1', 'tgw-attach-h2c2', 'tgw-attach-h2c3'])],
  ]),
  vpcRouteTables: new Map([
    ['vpc-high01', mockVpcRouteTables('vpc-high01', '10.0.0.0/16', {
      publicSubnetId: 'subnet-h01-pub',
      privateSubnetIds: ['subnet-h01-prv-a', 'subnet-h01-prv-b'],
      igwId: 'igw-high01',
      natGatewayId: 'nat-high01',
      tgwId: 'tgw-high01',
      tgwRoutes: ['10.0.0.0/8', '172.16.0.0/12'],
      pcxId: 'pcx-high01',
      pcxRoutes: ['10.1.0.0/16'],
    })],
    ['vpc-high02', mockVpcRouteTables('vpc-high02', '10.1.0.0/16', {
      publicSubnetId: 'subnet-h02-pub',
      privateSubnetIds: ['subnet-h02-prv'],
      igwId: 'igw-high02',
      natGatewayId: 'nat-high02',
      tgwId: 'tgw-high01',
      pcxId: 'pcx-high01',
      pcxRoutes: ['10.0.0.0/16'],
    })],
    ['vpc-high03', mockVpcRouteTables('vpc-high03', '10.2.0.0/16', {
      privateSubnetIds: ['subnet-h03-prv'],
      tgwId: 'tgw-high01',
      pcxId: 'pcx-high02',
      pcxRoutes: ['172.16.0.0/16'],
    })],
  ]),
  cloudWanCoreNetworks: [],
  cloudWanAttachments: [],
  cloudWanPeerings: [],
  cloudWanRoutes: new Map(),
};

export const maximumResiliencyTopology: TopologyData = {
  homeAccountId: '123456789012',
  bgpPrefixMetrics: new Map([
    ['dxvif-001', { accepted: 87, advertised: 24 }],
    ['dxvif-002', { accepted: 85, advertised: 24 }],
    ['dxvif-003', { accepted: 91, advertised: 24 }],
    ['dxvif-004', { accepted: 89, advertised: 24 }],
  ]),
  vifUtilization: new Map([
    ['dxvif-001', { ingressBpsPeak: 1.2e9, egressBpsPeak: 3.4e9 }],
    ['dxvif-002', { ingressBpsPeak: 1.1e9, egressBpsPeak: 3.1e9 }],
    ['dxvif-003', { ingressBpsPeak: 980e6, egressBpsPeak: 2.8e9 }],
    ['dxvif-004', { ingressBpsPeak: 920e6, egressBpsPeak: 2.7e9 }],
  ]),
  connectionUtilization: new Map([
    ['dxcon-abc001', { ingressBpsPeak: 1.25e9, egressBpsPeak: 3.5e9 }],
    ['dxcon-abc002', { ingressBpsPeak: 1.15e9, egressBpsPeak: 3.2e9 }],
    ['dxcon-abc003', { ingressBpsPeak: 1.0e9, egressBpsPeak: 2.85e9 }],
    ['dxcon-abc004', { ingressBpsPeak: 950e6, egressBpsPeak: 2.75e9 }],
  ]),
  utilizationWindowDays: 30,
  locations: [
    {
      locationCode: 'EqSG2',
      locationName: 'Equinix SG2 (Singapore)',
      region: 'ap-southeast-1',
      availablePortSpeeds: ['1Gbps', '10Gbps'],
    },
    {
      locationCode: 'EqSG3',
      locationName: 'Global Switch SG (Singapore)',
      region: 'ap-southeast-1',
      availablePortSpeeds: ['1Gbps', '10Gbps'],
    },
  ],
  connections: [
    {
      connectionId: 'dxcon-abc001',
      connectionName: 'DX-SG2-Primary',
      connectionState: 'available',
      location: 'EqSG2',
      bandwidth: '10Gbps',
      region: 'ap-southeast-1',
      hasBfd: true,
      awsDeviceV2: 'EqSG2-1a2b3c4d',
      awsLogicalDeviceId: 'EqSG2-lg1a',
    },
    {
      connectionId: 'dxcon-abc002',
      connectionName: 'DX-SG2-Secondary',
      connectionState: 'available',
      location: 'EqSG2',
      bandwidth: '10Gbps',
      region: 'ap-southeast-1',
      hasBfd: true,
      awsDeviceV2: 'EqSG2-5e6f7g8h',
      awsLogicalDeviceId: 'EqSG2-lg1b',
    },
    {
      connectionId: 'dxcon-abc003',
      connectionName: 'DX-SG3-Primary',
      connectionState: 'available',
      location: 'EqSG3',
      bandwidth: '10Gbps',
      region: 'ap-southeast-1',
      hasBfd: false,
      awsDeviceV2: 'EqSG3-9i0j1k2l',
      awsLogicalDeviceId: 'EqSG3-lg2a',
    },
    {
      connectionId: 'dxcon-abc004',
      connectionName: 'DX-SG3-Secondary',
      connectionState: 'available',
      location: 'EqSG3',
      bandwidth: '10Gbps',
      region: 'ap-southeast-1',
      hasBfd: false,
      awsDeviceV2: 'EqSG3-3m4n5o6p',
      awsLogicalDeviceId: 'EqSG3-lg2b',
    },
  ],
  virtualInterfaces: [
    {
      virtualInterfaceId: 'dxvif-001',
      virtualInterfaceName: 'Transit-VIF-SG2-1',
      virtualInterfaceType: 'transit',
      virtualInterfaceState: 'available',
      connectionId: 'dxcon-abc001',
      directConnectGatewayId: 'dxgw-001',
      vlan: 100,
      asn: 65000,
      bgpPeers: [
        {
          bgpPeerId: 'bgp-001',
          bgpPeerState: 'available',
          bgpStatus: 'up',
          asn: 65000,
          customerAddress: '169.254.0.2/30',
          amazonAddress: '169.254.0.1/30',
        },
      ],
      region: 'ap-southeast-1',
      awsDeviceV2: 'EqSG2-1a2b3c4d',
      awsLogicalDeviceId: 'EqSG2-lg1a',
    },
    {
      virtualInterfaceId: 'dxvif-002',
      virtualInterfaceName: 'Transit-VIF-SG2-2',
      virtualInterfaceType: 'transit',
      virtualInterfaceState: 'available',
      connectionId: 'dxcon-abc002',
      directConnectGatewayId: 'dxgw-001',
      vlan: 200,
      asn: 65000,
      bgpPeers: [
        {
          bgpPeerId: 'bgp-002',
          bgpPeerState: 'available',
          bgpStatus: 'up',
          asn: 65000,
          customerAddress: '169.254.1.2/30',
          amazonAddress: '169.254.1.1/30',
        },
      ],
      region: 'ap-southeast-1',
      awsDeviceV2: 'EqSG2-5e6f7g8h',
      awsLogicalDeviceId: 'EqSG2-lg1b',
    },
    {
      virtualInterfaceId: 'dxvif-003',
      virtualInterfaceName: 'Transit-VIF-SG3-1',
      virtualInterfaceType: 'transit',
      virtualInterfaceState: 'available',
      connectionId: 'dxcon-abc003',
      directConnectGatewayId: 'dxgw-001',
      vlan: 300,
      asn: 65001,
      bgpPeers: [
        {
          bgpPeerId: 'bgp-003',
          bgpPeerState: 'available',
          bgpStatus: 'up',
          asn: 65001,
          customerAddress: '169.254.2.2/30',
          amazonAddress: '169.254.2.1/30',
        },
      ],
      region: 'ap-southeast-1',
      awsDeviceV2: 'EqSG3-9i0j1k2l',
      awsLogicalDeviceId: 'EqSG3-lg2a',
    },
    {
      virtualInterfaceId: 'dxvif-004',
      virtualInterfaceName: 'Transit-VIF-SG3-2',
      virtualInterfaceType: 'transit',
      virtualInterfaceState: 'available',
      connectionId: 'dxcon-abc004',
      directConnectGatewayId: 'dxgw-001',
      vlan: 400,
      asn: 65001,
      bgpPeers: [
        {
          bgpPeerId: 'bgp-004',
          bgpPeerState: 'available',
          bgpStatus: 'up',
          asn: 65001,
          customerAddress: '169.254.3.2/30',
          amazonAddress: '169.254.3.1/30',
        },
      ],
      region: 'ap-southeast-1',
      awsDeviceV2: 'EqSG3-3m4n5o6p',
      awsLogicalDeviceId: 'EqSG3-lg2b',
    },
  ],
  dxGateways: [
    {
      directConnectGatewayId: 'dxgw-001',
      directConnectGatewayName: 'Production-DX-Gateway',
      amazonSideAsn: 64512,
      directConnectGatewayState: 'available',
    },
    {
      directConnectGatewayId: 'dxgw-002',
      directConnectGatewayName: 'Non-Prod-DX-Gateway',
      amazonSideAsn: 64520,
      directConnectGatewayState: 'available',
    },
  ],
  dxGatewayAssociations: [
    // dxgw-001 → 4 Production TGWs
    {
      directConnectGatewayId: 'dxgw-001',
      associatedGateway: { id: 'tgw-001', type: 'transitGateway', region: 'ap-southeast-1', ownerAccount: '123456789012' },
      associationState: 'associated',
      allowedPrefixes: ['10.0.0.0/16', '10.1.0.0/16'],
    },
    {
      directConnectGatewayId: 'dxgw-001',
      associatedGateway: { id: 'tgw-002', type: 'transitGateway', region: 'ap-southeast-1', ownerAccount: '123456789012' },
      associationState: 'associated',
      allowedPrefixes: ['10.2.0.0/16', '10.3.0.0/16'],
    },
    {
      directConnectGatewayId: 'dxgw-001',
      associatedGateway: { id: 'tgw-003', type: 'transitGateway', region: 'ap-southeast-1', ownerAccount: '123456789012' },
      associationState: 'associated',
      allowedPrefixes: ['10.4.0.0/16', '10.5.0.0/16'],
    },
    {
      directConnectGatewayId: 'dxgw-001',
      associatedGateway: { id: 'tgw-004', type: 'transitGateway', region: 'ap-southeast-1', ownerAccount: '123456789012' },
      associationState: 'associated',
      allowedPrefixes: ['10.6.0.0/16', '10.7.0.0/16'],
    },
    // dxgw-002 → 4 Non-Prod TGWs
    {
      directConnectGatewayId: 'dxgw-002',
      associatedGateway: { id: 'tgw-005', type: 'transitGateway', region: 'ap-southeast-1', ownerAccount: '123456789012' },
      associationState: 'associated',
      allowedPrefixes: ['10.8.0.0/16', '10.9.0.0/16'],
    },
    {
      directConnectGatewayId: 'dxgw-002',
      associatedGateway: { id: 'tgw-006', type: 'transitGateway', region: 'ap-southeast-1', ownerAccount: '123456789012' },
      associationState: 'associated',
      allowedPrefixes: ['10.10.0.0/16', '10.11.0.0/16'],
    },
    {
      directConnectGatewayId: 'dxgw-002',
      associatedGateway: { id: 'tgw-007', type: 'transitGateway', region: 'ap-southeast-1', ownerAccount: '123456789012' },
      associationState: 'associated',
      allowedPrefixes: ['10.12.0.0/16', '10.13.0.0/16'],
    },
    {
      directConnectGatewayId: 'dxgw-002',
      associatedGateway: { id: 'tgw-008', type: 'transitGateway', region: 'ap-southeast-1', ownerAccount: '123456789012' },
      associationState: 'associated',
      allowedPrefixes: ['10.14.0.0/16', '10.15.0.0/16'],
    },
  ],
  lags: [],
  vpcs: [
    { vpcId: 'vpc-001', cidrBlock: '10.0.0.0/16', tags: { Name: 'Production-VPC' }, region: 'ap-southeast-1', state: 'available' },
    { vpcId: 'vpc-002', cidrBlock: '10.1.0.0/16', tags: { Name: 'Staging-VPC' }, region: 'ap-southeast-1', state: 'available' },
    { vpcId: 'vpc-003', cidrBlock: '10.2.0.0/16', tags: { Name: 'Dev-VPC' }, region: 'ap-southeast-1', state: 'available' },
    { vpcId: 'vpc-004', cidrBlock: '10.3.0.0/16', tags: { Name: 'Shared-Services-VPC' }, region: 'ap-southeast-1', state: 'available' },
    { vpcId: 'vpc-005', cidrBlock: '10.4.0.0/16', tags: { Name: 'Data-VPC' }, region: 'ap-southeast-1', state: 'available' },
    { vpcId: 'vpc-006', cidrBlock: '10.5.0.0/16', tags: { Name: 'Analytics-VPC' }, region: 'ap-southeast-1', state: 'available' },
    { vpcId: 'vpc-007', cidrBlock: '10.6.0.0/16', tags: { Name: 'Security-VPC' }, region: 'ap-southeast-1', state: 'available' },
    { vpcId: 'vpc-008', cidrBlock: '10.7.0.0/16', tags: { Name: 'Management-VPC' }, region: 'ap-southeast-1', state: 'available' },
    { vpcId: 'vpc-009', cidrBlock: '10.8.0.0/16', tags: { Name: 'Monitoring-VPC' }, region: 'ap-southeast-1', state: 'available' },
    { vpcId: 'vpc-010', cidrBlock: '10.9.0.0/16', tags: { Name: 'Logging-VPC' }, region: 'ap-southeast-1', state: 'available' },
    { vpcId: 'vpc-011', cidrBlock: '10.10.0.0/16', tags: { Name: 'CI-CD-VPC' }, region: 'ap-southeast-1', state: 'available' },
    { vpcId: 'vpc-012', cidrBlock: '10.11.0.0/16', tags: { Name: 'Testing-VPC' }, region: 'ap-southeast-1', state: 'available' },
    { vpcId: 'vpc-013', cidrBlock: '10.12.0.0/16', tags: { Name: 'DR-VPC' }, region: 'ap-southeast-1', state: 'available' },
    { vpcId: 'vpc-014', cidrBlock: '10.13.0.0/16', tags: { Name: 'Backup-VPC' }, region: 'ap-southeast-1', state: 'available' },
    { vpcId: 'vpc-015', cidrBlock: '10.14.0.0/16', tags: { Name: 'Compliance-VPC' }, region: 'ap-southeast-1', state: 'available' },
    { vpcId: 'vpc-016', cidrBlock: '10.15.0.0/16', tags: { Name: 'Audit-VPC' }, region: 'ap-southeast-1', state: 'available' },
  ],
  vpnGateways: [],
  vpnConnections: [],
  customerGateways: [],
  transitGateways: [
    // Production group (dxgw-001)
    {
      transitGatewayId: 'tgw-001',
      transitGatewayArn: 'arn:aws:ec2:ap-southeast-1:123456789012:transit-gateway/tgw-001',
      state: 'available', ownerId: '123456789012', description: 'Production Transit Gateway',
      amazonSideAsn: 64512, tags: { Name: 'Prod-TGW' },
    },
    {
      transitGatewayId: 'tgw-002',
      transitGatewayArn: 'arn:aws:ec2:ap-southeast-1:123456789012:transit-gateway/tgw-002',
      state: 'available', ownerId: '123456789012', description: 'Development Transit Gateway',
      amazonSideAsn: 64513, tags: { Name: 'Dev-TGW' },
    },
    {
      transitGatewayId: 'tgw-003',
      transitGatewayArn: 'arn:aws:ec2:ap-southeast-1:123456789012:transit-gateway/tgw-003',
      state: 'available', ownerId: '123456789012', description: 'Data Platform Transit Gateway',
      amazonSideAsn: 64514, tags: { Name: 'Data-TGW' },
    },
    {
      transitGatewayId: 'tgw-004',
      transitGatewayArn: 'arn:aws:ec2:ap-southeast-1:123456789012:transit-gateway/tgw-004',
      state: 'available', ownerId: '123456789012', description: 'Security Transit Gateway',
      amazonSideAsn: 64515, tags: { Name: 'Security-TGW' },
    },
    // Non-Prod group (dxgw-002)
    {
      transitGatewayId: 'tgw-005',
      transitGatewayArn: 'arn:aws:ec2:ap-southeast-1:123456789012:transit-gateway/tgw-005',
      state: 'available', ownerId: '123456789012', description: 'Monitoring Transit Gateway',
      amazonSideAsn: 64516, tags: { Name: 'Monitoring-TGW' },
    },
    {
      transitGatewayId: 'tgw-006',
      transitGatewayArn: 'arn:aws:ec2:ap-southeast-1:123456789012:transit-gateway/tgw-006',
      state: 'available', ownerId: '123456789012', description: 'CI/CD Transit Gateway',
      amazonSideAsn: 64517, tags: { Name: 'CI-CD-TGW' },
    },
    {
      transitGatewayId: 'tgw-007',
      transitGatewayArn: 'arn:aws:ec2:ap-southeast-1:123456789012:transit-gateway/tgw-007',
      state: 'available', ownerId: '123456789012', description: 'DR Transit Gateway',
      amazonSideAsn: 64518, tags: { Name: 'DR-TGW' },
    },
    {
      transitGatewayId: 'tgw-008',
      transitGatewayArn: 'arn:aws:ec2:ap-southeast-1:123456789012:transit-gateway/tgw-008',
      state: 'available', ownerId: '123456789012', description: 'Compliance Transit Gateway',
      amazonSideAsn: 64519, tags: { Name: 'Compliance-TGW' },
    },
  ],
  transitGatewayAttachments: [
    // Production TGWs → VPCs
    { transitGatewayAttachmentId: 'tgw-attach-001', transitGatewayId: 'tgw-001', resourceType: 'vpc', resourceId: 'vpc-001', resourceOwnerId: '', state: 'available' },
    { transitGatewayAttachmentId: 'tgw-attach-002', transitGatewayId: 'tgw-001', resourceType: 'vpc', resourceId: 'vpc-002', resourceOwnerId: '', state: 'available' },
    { transitGatewayAttachmentId: 'tgw-attach-003', transitGatewayId: 'tgw-002', resourceType: 'vpc', resourceId: 'vpc-003', resourceOwnerId: '', state: 'available' },
    { transitGatewayAttachmentId: 'tgw-attach-004', transitGatewayId: 'tgw-002', resourceType: 'vpc', resourceId: 'vpc-004', resourceOwnerId: '', state: 'available' },
    { transitGatewayAttachmentId: 'tgw-attach-005', transitGatewayId: 'tgw-003', resourceType: 'vpc', resourceId: 'vpc-005', resourceOwnerId: '', state: 'available' },
    { transitGatewayAttachmentId: 'tgw-attach-006', transitGatewayId: 'tgw-003', resourceType: 'vpc', resourceId: 'vpc-006', resourceOwnerId: '', state: 'available' },
    { transitGatewayAttachmentId: 'tgw-attach-007', transitGatewayId: 'tgw-004', resourceType: 'vpc', resourceId: 'vpc-007', resourceOwnerId: '', state: 'available' },
    { transitGatewayAttachmentId: 'tgw-attach-008', transitGatewayId: 'tgw-004', resourceType: 'vpc', resourceId: 'vpc-008', resourceOwnerId: '', state: 'available' },
    // Non-Prod TGWs → VPCs
    { transitGatewayAttachmentId: 'tgw-attach-009', transitGatewayId: 'tgw-005', resourceType: 'vpc', resourceId: 'vpc-009', resourceOwnerId: '', state: 'available' },
    { transitGatewayAttachmentId: 'tgw-attach-010', transitGatewayId: 'tgw-005', resourceType: 'vpc', resourceId: 'vpc-010', resourceOwnerId: '', state: 'available' },
    { transitGatewayAttachmentId: 'tgw-attach-011', transitGatewayId: 'tgw-006', resourceType: 'vpc', resourceId: 'vpc-011', resourceOwnerId: '', state: 'available' },
    { transitGatewayAttachmentId: 'tgw-attach-012', transitGatewayId: 'tgw-006', resourceType: 'vpc', resourceId: 'vpc-012', resourceOwnerId: '', state: 'available' },
    { transitGatewayAttachmentId: 'tgw-attach-013', transitGatewayId: 'tgw-007', resourceType: 'vpc', resourceId: 'vpc-013', resourceOwnerId: '', state: 'available' },
    { transitGatewayAttachmentId: 'tgw-attach-014', transitGatewayId: 'tgw-007', resourceType: 'vpc', resourceId: 'vpc-014', resourceOwnerId: '', state: 'available' },
    { transitGatewayAttachmentId: 'tgw-attach-015', transitGatewayId: 'tgw-008', resourceType: 'vpc', resourceId: 'vpc-015', resourceOwnerId: '', state: 'available' },
    { transitGatewayAttachmentId: 'tgw-attach-016', transitGatewayId: 'tgw-008', resourceType: 'vpc', resourceId: 'vpc-016', resourceOwnerId: '', state: 'available' },
    // DX Gateway attachments
    { transitGatewayAttachmentId: 'tgw-attach-dx1', transitGatewayId: 'tgw-001', resourceType: 'direct-connect-gateway', resourceId: 'dxgw-001', resourceOwnerId: '', state: 'available' },
    { transitGatewayAttachmentId: 'tgw-attach-dx2', transitGatewayId: 'tgw-002', resourceType: 'direct-connect-gateway', resourceId: 'dxgw-001', resourceOwnerId: '', state: 'available' },
    { transitGatewayAttachmentId: 'tgw-attach-dx3', transitGatewayId: 'tgw-003', resourceType: 'direct-connect-gateway', resourceId: 'dxgw-001', resourceOwnerId: '', state: 'available' },
    { transitGatewayAttachmentId: 'tgw-attach-dx4', transitGatewayId: 'tgw-004', resourceType: 'direct-connect-gateway', resourceId: 'dxgw-001', resourceOwnerId: '', state: 'available' },
    { transitGatewayAttachmentId: 'tgw-attach-dx5', transitGatewayId: 'tgw-005', resourceType: 'direct-connect-gateway', resourceId: 'dxgw-002', resourceOwnerId: '', state: 'available' },
    { transitGatewayAttachmentId: 'tgw-attach-dx6', transitGatewayId: 'tgw-006', resourceType: 'direct-connect-gateway', resourceId: 'dxgw-002', resourceOwnerId: '', state: 'available' },
    { transitGatewayAttachmentId: 'tgw-attach-dx7', transitGatewayId: 'tgw-007', resourceType: 'direct-connect-gateway', resourceId: 'dxgw-002', resourceOwnerId: '', state: 'available' },
    { transitGatewayAttachmentId: 'tgw-attach-dx8', transitGatewayId: 'tgw-008', resourceType: 'direct-connect-gateway', resourceId: 'dxgw-002', resourceOwnerId: '', state: 'available' },
  ],
  transitGatewayPeeringAttachments: [],
  vpcPeerings: [],
  tgwRouteTables: new Map([
    ['tgw-001', mockRoutesForTgw('tgw-001', ['10.0.0.0/16', '10.1.0.0/16'], ['tgw-attach-001', 'tgw-attach-002'])],
    ['tgw-002', mockRoutesForTgw('tgw-002', ['10.2.0.0/16', '10.3.0.0/16'], ['tgw-attach-003', 'tgw-attach-004'])],
    ['tgw-003', mockRoutesForTgw('tgw-003', ['10.4.0.0/16', '10.5.0.0/16'], ['tgw-attach-005', 'tgw-attach-006'])],
    ['tgw-004', mockRoutesForTgw('tgw-004', ['10.6.0.0/16', '10.7.0.0/16'], ['tgw-attach-007', 'tgw-attach-008'])],
    ['tgw-005', mockRoutesForTgw('tgw-005', ['10.8.0.0/16', '10.9.0.0/16'], ['tgw-attach-009', 'tgw-attach-010'])],
    ['tgw-006', mockRoutesForTgw('tgw-006', ['10.10.0.0/16', '10.11.0.0/16'], ['tgw-attach-011', 'tgw-attach-012'])],
    ['tgw-007', mockRoutesForTgw('tgw-007', ['10.12.0.0/16', '10.13.0.0/16'], ['tgw-attach-013', 'tgw-attach-014'])],
    ['tgw-008', mockRoutesForTgw('tgw-008', ['10.14.0.0/16', '10.15.0.0/16'], ['tgw-attach-015', 'tgw-attach-016'])],
  ]),
  vpcRouteTables: new Map([
    ['vpc-001', mockVpcRouteTables('vpc-001', '10.0.0.0/16', { privateSubnetIds: ['subnet-001-a'], tgwId: 'tgw-001' })],
    ['vpc-002', mockVpcRouteTables('vpc-002', '10.1.0.0/16', { privateSubnetIds: ['subnet-002-a'], tgwId: 'tgw-001' })],
    ['vpc-003', mockVpcRouteTables('vpc-003', '10.2.0.0/16', { privateSubnetIds: ['subnet-003-a'], tgwId: 'tgw-002' })],
    ['vpc-004', mockVpcRouteTables('vpc-004', '10.3.0.0/16', { privateSubnetIds: ['subnet-004-a'], tgwId: 'tgw-002' })],
    ['vpc-005', mockVpcRouteTables('vpc-005', '10.4.0.0/16', { privateSubnetIds: ['subnet-005-a'], tgwId: 'tgw-003' })],
  ]),
  cloudWanCoreNetworks: [],
  cloudWanAttachments: [],
  cloudWanPeerings: [],
  cloudWanRoutes: new Map(),
};

export const crossAccountTopology: TopologyData = {
  homeAccountId: '111111111111',
  locations: [
    {
      locationCode: 'EqSG2',
      locationName: 'Equinix SG2 (Singapore)',
      region: 'ap-southeast-1',
      availablePortSpeeds: ['1Gbps', '10Gbps'],
    },
    {
      locationCode: 'EqTY2',
      locationName: 'Equinix TY2 (Tokyo)',
      region: 'ap-northeast-1',
      availablePortSpeeds: ['1Gbps', '10Gbps'],
    },
  ],
  connections: [
    {
      connectionId: 'dxcon-hub001',
      connectionName: 'DX-Hub-SG-Primary',
      connectionState: 'available',
      location: 'EqSG2',
      bandwidth: '10Gbps',
      region: 'ap-southeast-1',
      hasBfd: true,
      awsDeviceV2: 'EqSG2-1a2b3c4d',
      awsLogicalDeviceId: 'EqSG2-lg1a',
    },
    {
      connectionId: 'dxcon-hub002',
      connectionName: 'DX-Hub-SG-Secondary',
      connectionState: 'available',
      location: 'EqSG2',
      bandwidth: '10Gbps',
      region: 'ap-southeast-1',
      hasBfd: true,
      awsDeviceV2: 'EqSG2-5e6f7g8h',
      awsLogicalDeviceId: 'EqSG2-lg1b',
    },
    {
      connectionId: 'dxcon-hub003',
      connectionName: 'DX-Hub-TY-Primary',
      connectionState: 'available',
      location: 'EqTY2',
      bandwidth: '10Gbps',
      region: 'ap-northeast-1',
      hasBfd: true,
      awsDeviceV2: 'EqTY2-9a0b1c2d',
      awsLogicalDeviceId: 'EqTY2-lg1a',
    },
  ],
  virtualInterfaces: [
    {
      virtualInterfaceId: 'dxvif-hub01',
      virtualInterfaceName: 'Transit-VIF-Primary',
      virtualInterfaceType: 'transit',
      virtualInterfaceState: 'available',
      connectionId: 'dxcon-hub001',
      directConnectGatewayId: 'dxgw-hub01',
      vlan: 100,
      asn: 65000,
      bgpPeers: [
        { bgpPeerId: 'bgp-h01', bgpPeerState: 'available', bgpStatus: 'up', asn: 65000, customerAddress: '169.254.0.2/30', amazonAddress: '169.254.0.1/30' },
      ],
      region: 'ap-southeast-1',
      awsDeviceV2: 'EqSG2-1a2b3c4d',
      awsLogicalDeviceId: 'EqSG2-lg1a',
    },
    {
      virtualInterfaceId: 'dxvif-hub02',
      virtualInterfaceName: 'Transit-VIF-Secondary',
      virtualInterfaceType: 'transit',
      virtualInterfaceState: 'available',
      connectionId: 'dxcon-hub002',
      directConnectGatewayId: 'dxgw-hub01',
      vlan: 200,
      asn: 65000,
      bgpPeers: [
        { bgpPeerId: 'bgp-h02', bgpPeerState: 'available', bgpStatus: 'up', asn: 65000, customerAddress: '169.254.1.2/30', amazonAddress: '169.254.1.1/30' },
      ],
      region: 'ap-southeast-1',
      awsDeviceV2: 'EqSG2-5e6f7g8h',
      awsLogicalDeviceId: 'EqSG2-lg1b',
    },
    {
      virtualInterfaceId: 'dxvif-hub03',
      virtualInterfaceName: 'Transit-VIF-Tokyo',
      virtualInterfaceType: 'transit',
      virtualInterfaceState: 'available',
      connectionId: 'dxcon-hub003',
      directConnectGatewayId: 'dxgw-hub01',
      vlan: 300,
      asn: 65000,
      bgpPeers: [
        { bgpPeerId: 'bgp-h03', bgpPeerState: 'available', bgpStatus: 'up', asn: 65000, customerAddress: '169.254.2.2/30', amazonAddress: '169.254.2.1/30' },
      ],
      region: 'ap-northeast-1',
      awsDeviceV2: 'EqTY2-9a0b1c2d',
      awsLogicalDeviceId: 'EqTY2-lg1a',
    },
  ],
  dxGateways: [
    {
      directConnectGatewayId: 'dxgw-hub01',
      directConnectGatewayName: 'Hub-DX-Gateway',
      amazonSideAsn: 64512,
      directConnectGatewayState: 'available',
    },
  ],
  dxGatewayAssociations: [
    // Hub account's own TGW
    {
      directConnectGatewayId: 'dxgw-hub01',
      associatedGateway: {
        id: 'tgw-hub01',
        type: 'transitGateway',
        region: 'ap-southeast-1',
        ownerAccount: '111111111111',
      },
      associationState: 'associated',
      allowedPrefixes: ['10.0.0.0/8', '172.16.0.0/12'],
    },
    // Spoke account A - TGW in a different region (cross-account via RAM)
    {
      directConnectGatewayId: 'dxgw-hub01',
      associatedGateway: {
        id: 'tgw-spoke-a',
        type: 'transitGateway',
        region: 'us-east-1',
        ownerAccount: '222222222222',
      },
      associationState: 'associated',
      allowedPrefixes: ['10.0.0.0/8', '172.16.0.0/12'],
    },
    // Spoke account B - VGW (cross-account via RAM)
    {
      directConnectGatewayId: 'dxgw-hub01',
      associatedGateway: {
        id: 'vgw-spoke-b',
        type: 'virtualPrivateGateway',
        region: 'eu-west-1',
        ownerAccount: '333333333333',
      },
      associationState: 'associated',
      allowedPrefixes: ['10.0.0.0/8', '172.16.0.0/12'],
    },
    // Spoke account C - TGW in Tokyo (cross-account via RAM)
    {
      directConnectGatewayId: 'dxgw-hub01',
      associatedGateway: {
        id: 'tgw-spoke-c',
        type: 'transitGateway',
        region: 'ap-northeast-1',
        ownerAccount: '444444444444',
      },
      associationState: 'associated',
      allowedPrefixes: ['10.0.0.0/8', '172.16.0.0/12'],
    },
  ],
  lags: [],
  // Only hub account's VPCs are visible — spoke VPCs are discovered via TGW attachment resourceOwnerId
  vpcs: [
    { vpcId: 'vpc-hub01', cidrBlock: '10.0.0.0/16', tags: { Name: 'Hub-Network-VPC' }, region: 'ap-southeast-1', state: 'available' },
    { vpcId: 'vpc-hub02', cidrBlock: '10.1.0.0/16', tags: { Name: 'Hub-Shared-Services' }, region: 'ap-southeast-1', state: 'available' },
  ],
  vpnGateways: [],
  vpnConnections: [],
  customerGateways: [],
  transitGateways: [
    // Only the hub's TGW is in EC2 DescribeTransitGateways — spoke TGWs won't appear
    {
      transitGatewayId: 'tgw-hub01',
      transitGatewayArn: 'arn:aws:ec2:ap-southeast-1:111111111111:transit-gateway/tgw-hub01',
      state: 'available',
      ownerId: '111111111111',
      description: 'Hub Transit Gateway',
      amazonSideAsn: 64512,
      tags: { Name: 'Hub-TGW' },
    },
  ],
  transitGatewayAttachments: [
    // Hub account's own VPCs
    { transitGatewayAttachmentId: 'tgw-attach-h01', transitGatewayId: 'tgw-hub01', resourceType: 'vpc', resourceId: 'vpc-hub01', resourceOwnerId: '111111111111', state: 'available' },
    { transitGatewayAttachmentId: 'tgw-attach-h02', transitGatewayId: 'tgw-hub01', resourceType: 'vpc', resourceId: 'vpc-hub02', resourceOwnerId: '111111111111', state: 'available' },
    { transitGatewayAttachmentId: 'tgw-attach-dx', transitGatewayId: 'tgw-hub01', resourceType: 'direct-connect-gateway', resourceId: 'dxgw-hub01', resourceOwnerId: '111111111111', state: 'available' },
    // Cross-account spoke VPCs attached to the hub TGW (visible via DescribeTransitGatewayAttachments)
    { transitGatewayAttachmentId: 'tgw-attach-spoke-a1', transitGatewayId: 'tgw-hub01', resourceType: 'vpc', resourceId: 'vpc-spoke-a1', resourceOwnerId: '222222222222', state: 'available' },
    { transitGatewayAttachmentId: 'tgw-attach-spoke-a2', transitGatewayId: 'tgw-hub01', resourceType: 'vpc', resourceId: 'vpc-spoke-a2', resourceOwnerId: '222222222222', state: 'available' },
    { transitGatewayAttachmentId: 'tgw-attach-spoke-b1', transitGatewayId: 'tgw-hub01', resourceType: 'vpc', resourceId: 'vpc-spoke-b1', resourceOwnerId: '333333333333', state: 'available' },
    // TGW Peering: hub SG ↔ spoke-c Tokyo
    { transitGatewayAttachmentId: 'tgw-attach-peering-hub', transitGatewayId: 'tgw-hub01', resourceType: 'peering', resourceId: 'tgw-spoke-c', resourceOwnerId: '111111111111', state: 'available' },
  ],
  transitGatewayPeeringAttachments: [
    {
      transitGatewayAttachmentId: 'tgw-attach-peering-hub',
      requesterTgwInfo: {
        transitGatewayId: 'tgw-hub01',
        region: 'ap-southeast-1',
        ownerId: '111111111111',
      },
      accepterTgwInfo: {
        transitGatewayId: 'tgw-spoke-c',
        region: 'ap-northeast-1',
        ownerId: '444444444444',
      },
      state: 'available',
      tags: { Name: 'Hub-SG-to-Spoke-TY-Peering' },
    },
  ],
  vpcPeerings: [],
  tgwRouteTables: new Map([
    ['tgw-hub01', mockRoutesForTgw('tgw-hub01', ['10.0.0.0/16', '10.1.0.0/16', '172.16.0.0/12'], ['tgw-attach-h01', 'tgw-attach-h02', 'tgw-attach-spoke-a1'])],
  ]),
  vpcRouteTables: new Map([
    ['vpc-hub01', mockVpcRouteTables('vpc-hub01', '10.0.0.0/16', {
      publicSubnetId: 'subnet-hub01-pub',
      privateSubnetIds: ['subnet-hub01-prv-a', 'subnet-hub01-prv-b'],
      igwId: 'igw-hub01',
      natGatewayId: 'nat-hub01',
      tgwId: 'tgw-hub01',
      tgwRoutes: ['10.0.0.0/8', '172.16.0.0/12'],
    })],
    ['vpc-hub02', mockVpcRouteTables('vpc-hub02', '10.1.0.0/16', {
      privateSubnetIds: ['subnet-hub02-prv'],
      tgwId: 'tgw-hub01',
    })],
  ]),
  cloudWanCoreNetworks: [],
  cloudWanAttachments: [],
  cloudWanPeerings: [],
  cloudWanRoutes: new Map(),
};

export type { MockScenario } from './shared';

export function getMockTopology(scenario: MockScenario = 'noResiliency'): TopologyData {
  switch (scenario) {
    case 'devTest': return devTestTopology;
    case 'high': return highResiliencyTopology;
    case 'maximum': return maximumResiliencyTopology;
    case 'crossAccount': return crossAccountTopology;
    default: return noResiliencyTopology;
  }
}
