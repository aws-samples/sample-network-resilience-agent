import type { TopologyData } from '../../../types/topology';
import { mockVpcRouteTables } from '../../../utils/mock-data';

/**
 * Test-only fixtures for the multi-DXGW engine tests. These topologies used to
 * ship as selectable demo scenarios ("Multi-DXGW" / "Multi-DXGW (Shared VPC)")
 * but were removed from the demo UI; they live on here purely as fixtures for
 * the per-DXGW assessment, AWS-cloud containment, and shared-downstream grouping
 * tests. All identifiers are synthetic.
 */

// Multi-DXGW scenario: a "No Resiliency" posture with TWO DX locations and TWO
// DX Gateways, where each DXGW is fed by exactly ONE location (a single
// connection each). The topology looks multi-site at a glance, but every DXGW
// is single-site on its own — so each independently earns a "second location"
// recommendation. Exercises the per-DXGW assessment loop: overlapping but
// distinctly-scoped ghost zones, one per gateway.
export const multiDxgwTopology: TopologyData = {
  homeAccountId: '123456789012',
  bgpPrefixMetrics: new Map([
    ['dxvif-mdx01', { accepted: 18, advertised: 8 }],
    ['dxvif-mdx02', { accepted: 21, advertised: 8 }],
  ]),
  vifUtilization: new Map([
    ['dxvif-mdx01', { ingressBpsPeak: 180e6, egressBpsPeak: 520e6 }],
    ['dxvif-mdx02', { ingressBpsPeak: 210e6, egressBpsPeak: 480e6 }],
  ]),
  connectionUtilization: new Map([
    ['dxcon-mdx01', { ingressBpsPeak: 200e6, egressBpsPeak: 540e6 }],
    ['dxcon-mdx02', { ingressBpsPeak: 225e6, egressBpsPeak: 500e6 }],
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
      connectionId: 'dxcon-mdx01',
      connectionName: 'DX-SG2-Prod',
      connectionState: 'available',
      location: 'EqSG2',
      bandwidth: '1Gbps',
      region: 'ap-southeast-1',
      hasBfd: false,
      awsDeviceV2: 'EqSG2-1a2b3c4d',
      awsLogicalDeviceId: 'EqSG2-lg1a',
    },
    {
      connectionId: 'dxcon-mdx02',
      connectionName: 'DX-SG3-Corp',
      connectionState: 'available',
      location: 'EqSG3',
      bandwidth: '1Gbps',
      region: 'ap-southeast-1',
      hasBfd: false,
      awsDeviceV2: 'EqSG3-9i0j1k2l',
      awsLogicalDeviceId: 'EqSG3-lg2a',
    },
  ],
  virtualInterfaces: [
    {
      virtualInterfaceId: 'dxvif-mdx01',
      virtualInterfaceName: 'Private-VIF-Prod',
      virtualInterfaceType: 'private',
      virtualInterfaceState: 'available',
      connectionId: 'dxcon-mdx01',
      directConnectGatewayId: 'dxgw-mdx-prod',
      vlan: 100,
      asn: 65000,
      bgpPeers: [
        { bgpPeerId: 'bgp-mdx01', bgpPeerState: 'available', bgpStatus: 'up', asn: 65000, customerAddress: '169.254.10.2/30', amazonAddress: '169.254.10.1/30' },
      ],
      region: 'ap-southeast-1',
      awsDeviceV2: 'EqSG2-1a2b3c4d',
      awsLogicalDeviceId: 'EqSG2-lg1a',
    },
    {
      virtualInterfaceId: 'dxvif-mdx02',
      virtualInterfaceName: 'Private-VIF-Corp',
      virtualInterfaceType: 'private',
      virtualInterfaceState: 'available',
      connectionId: 'dxcon-mdx02',
      directConnectGatewayId: 'dxgw-mdx-corp',
      vlan: 200,
      asn: 65001,
      bgpPeers: [
        { bgpPeerId: 'bgp-mdx02', bgpPeerState: 'available', bgpStatus: 'up', asn: 65001, customerAddress: '169.254.11.2/30', amazonAddress: '169.254.11.1/30' },
      ],
      region: 'ap-southeast-1',
      awsDeviceV2: 'EqSG3-9i0j1k2l',
      awsLogicalDeviceId: 'EqSG3-lg2a',
    },
  ],
  dxGateways: [
    {
      directConnectGatewayId: 'dxgw-mdx-prod',
      directConnectGatewayName: 'DXGW-Prod-SG2',
      amazonSideAsn: 64512,
      directConnectGatewayState: 'available',
    },
    {
      directConnectGatewayId: 'dxgw-mdx-corp',
      directConnectGatewayName: 'DXGW-Corp-SG3',
      amazonSideAsn: 64513,
      directConnectGatewayState: 'available',
    },
  ],
  dxGatewayAssociations: [
    {
      directConnectGatewayId: 'dxgw-mdx-prod',
      associatedGateway: { id: 'vgw-mdx-prod', type: 'virtualPrivateGateway', region: 'ap-southeast-1', ownerAccount: '123456789012' },
      associationState: 'associated',
      allowedPrefixes: ['10.0.0.0/16'],
    },
    {
      directConnectGatewayId: 'dxgw-mdx-corp',
      associatedGateway: { id: 'vgw-mdx-corp', type: 'virtualPrivateGateway', region: 'ap-southeast-1', ownerAccount: '123456789012' },
      associationState: 'associated',
      allowedPrefixes: ['10.1.0.0/16'],
    },
  ],
  lags: [],
  vpcs: [
    { vpcId: 'vpc-mdx-prod', cidrBlock: '10.0.0.0/16', tags: { Name: 'Production-VPC' }, region: 'ap-southeast-1', state: 'available' },
    { vpcId: 'vpc-mdx-corp', cidrBlock: '10.1.0.0/16', tags: { Name: 'Corporate-VPC' }, region: 'ap-southeast-1', state: 'available' },
  ],
  vpnGateways: [
    {
      vpnGatewayId: 'vgw-mdx-prod',
      vpcAttachments: [{ vpcId: 'vpc-mdx-prod', state: 'attached' }],
      type: 'ipsec.1',
      amazonSideAsn: 64512,
      state: 'available',
      tags: { Name: 'vgw-prod' },
    },
    {
      vpnGatewayId: 'vgw-mdx-corp',
      vpcAttachments: [{ vpcId: 'vpc-mdx-corp', state: 'attached' }],
      type: 'ipsec.1',
      amazonSideAsn: 64513,
      state: 'available',
      tags: { Name: 'vgw-corp' },
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
    ['vpc-mdx-prod', mockVpcRouteTables('vpc-mdx-prod', '10.0.0.0/16', {
      privateSubnetIds: ['subnet-mdx-prod-a'],
      tgwId: undefined,
    })],
    ['vpc-mdx-corp', mockVpcRouteTables('vpc-mdx-corp', '10.1.0.0/16', {
      privateSubnetIds: ['subnet-mdx-corp-a'],
      tgwId: undefined,
    })],
  ]),
  cloudWanCoreNetworks: [],
  cloudWanAttachments: [],
  cloudWanPeerings: [],
  cloudWanRoutes: new Map(),
};

/**
 * Multi-DXGW variant where the two DX Gateways CONVERGE onto a single VPC:
 * each DXGW associates to its own Transit Gateway, but BOTH TGWs attach to the
 * same `vpc-mdx-shared`. The VPC holds the real workload, so the two DXGWs form
 * one shared-downstream redundancy group (see groupDxGatewaysBySharedDownstream
 * — terminal-VPC convergence). Contrast with `multiDxgwTopology`, where each
 * DXGW reaches a distinct VPC and the two stay independent.
 */
export const multiDxgwSharedVpcTopology: TopologyData = {
  ...multiDxgwTopology,
  dxGatewayAssociations: [
    {
      directConnectGatewayId: 'dxgw-mdx-prod',
      associatedGateway: { id: 'tgw-mdx-prod', type: 'transitGateway', region: 'ap-southeast-1', ownerAccount: '123456789012' },
      associationState: 'associated',
      allowedPrefixes: ['10.0.0.0/16'],
    },
    {
      directConnectGatewayId: 'dxgw-mdx-corp',
      associatedGateway: { id: 'tgw-mdx-corp', type: 'transitGateway', region: 'ap-southeast-1', ownerAccount: '123456789012' },
      associationState: 'associated',
      allowedPrefixes: ['10.0.0.0/16'],
    },
  ],
  // Single shared VPC — both TGWs attach to it.
  vpcs: [
    { vpcId: 'vpc-mdx-shared', cidrBlock: '10.0.0.0/16', tags: { Name: 'Shared-Workload-VPC' }, region: 'ap-southeast-1', state: 'available' },
  ],
  vpnGateways: [],
  transitGateways: [
    { transitGatewayId: 'tgw-mdx-prod', transitGatewayArn: 'arn:aws:ec2:ap-southeast-1:123456789012:transit-gateway/tgw-mdx-prod', state: 'available', ownerId: '123456789012', description: 'Prod TGW', amazonSideAsn: 64512, tags: { Name: 'tgw-prod' } },
    { transitGatewayId: 'tgw-mdx-corp', transitGatewayArn: 'arn:aws:ec2:ap-southeast-1:123456789012:transit-gateway/tgw-mdx-corp', state: 'available', ownerId: '123456789012', description: 'Corp TGW', amazonSideAsn: 64513, tags: { Name: 'tgw-corp' } },
  ],
  transitGatewayAttachments: [
    { transitGatewayAttachmentId: 'tgw-attach-mdx-prod', transitGatewayId: 'tgw-mdx-prod', resourceType: 'vpc', resourceId: 'vpc-mdx-shared', resourceOwnerId: '123456789012', state: 'available' },
    { transitGatewayAttachmentId: 'tgw-attach-mdx-corp', transitGatewayId: 'tgw-mdx-corp', resourceType: 'vpc', resourceId: 'vpc-mdx-shared', resourceOwnerId: '123456789012', state: 'available' },
  ],
  vpcRouteTables: new Map([
    ['vpc-mdx-shared', mockVpcRouteTables('vpc-mdx-shared', '10.0.0.0/16', {
      privateSubnetIds: ['subnet-mdx-shared-a'],
      tgwId: 'tgw-mdx-prod',
    })],
  ]),
};
