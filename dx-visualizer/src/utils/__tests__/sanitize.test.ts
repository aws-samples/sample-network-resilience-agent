import { describe, it, expect } from 'vitest';
import { Sanitizer, sanitizeTopology } from '../sanitize';
import type { TopologyData } from '../../types/topology';

function makeFixture(): TopologyData {
  return {
    connections: [
      {
        connectionId: 'dxcon-abc12345',
        connectionName: 'corp-payroll-prod',
        connectionState: 'available',
        location: 'EqDC2',
        bandwidth: '1Gbps',
        lagId: 'dxlag-xy789012',
        partnerName: 'Equinix',
        region: 'us-east-1',
        awsDeviceV2: 'EqDC2-3jw9w7c4l',
        awsLogicalDeviceId: 'aws-device-x1y2z3',
      },
    ],
    virtualInterfaces: [
      {
        virtualInterfaceId: 'dxvif-deadbeef',
        virtualInterfaceName: 'finance-prod-vif',
        virtualInterfaceType: 'transit',
        virtualInterfaceState: 'available',
        connectionId: 'dxcon-abc12345',
        directConnectGatewayId: '12345678-1234-1234-1234-123456789abc',
        vlan: 100,
        asn: 4200001001,
        bgpPeers: [
          {
            bgpPeerId: 'bgp-peer-001',
            bgpPeerState: 'available',
            bgpStatus: 'up',
            asn: 4200001001,
            customerAddress: '169.254.1.1/30',
            amazonAddress: '169.254.1.2/30',
          },
        ],
        region: 'us-east-1',
        ownerAccount: '111122223333',
      },
    ],
    dxGateways: [
      {
        directConnectGatewayId: '12345678-1234-1234-1234-123456789abc',
        directConnectGatewayName: 'corp-dxgw-prod',
        amazonSideAsn: 64512,
        directConnectGatewayState: 'available',
      },
    ],
    dxGatewayAssociations: [],
    locations: [
      {
        locationCode: 'EqDC2',
        locationName: 'AWS Direct Connect Equinix DC2',
        region: 'us-east-1',
        availablePortSpeeds: ['1Gbps', '10Gbps'],
      },
    ],
    lags: [],
    vpcs: [
      {
        vpcId: 'vpc-0123456789abcdef',
        cidrBlock: '10.0.0.0/16',
        tags: { Name: 'finance-prod', Owner: 'alice@corp.example' },
        region: 'us-east-1',
        state: 'available',
        ownerAccountId: '111122223333',
      },
    ],
    vpnGateways: [],
    vpnConnections: [],
    transitGateways: [
      {
        transitGatewayId: 'tgw-aaaa1111',
        transitGatewayArn: 'arn:aws:ec2:us-east-1:111122223333:transit-gateway/tgw-aaaa1111',
        state: 'available',
        ownerId: '111122223333',
        description: 'Production hub',
        // 4200000123 is in the 32-bit private ASN range, intentionally
        // outside the 64512-65534 pseudo range the sanitizer allocates from
        // so a collision can't mask a missed rewrite.
        amazonSideAsn: 4200000123,
        tags: { Name: 'tgw-prod' },
      },
    ],
    transitGatewayAttachments: [
      {
        transitGatewayAttachmentId: 'tgw-attach-bbbb2222',
        transitGatewayId: 'tgw-aaaa1111',
        resourceType: 'vpc',
        resourceId: 'vpc-0123456789abcdef',
        resourceOwnerId: '111122223333',
        state: 'available',
      },
    ],
    transitGatewayPeeringAttachments: [],
    vpcPeerings: [],
    customerGateways: [
      {
        customerGatewayId: 'cgw-cccc3333',
        bgpAsn: '4200001100',
        ipAddress: '198.18.7.50',
        state: 'available',
        type: 'ipsec.1',
        tags: {},
      },
    ],
    cloudWanCoreNetworks: [],
    cloudWanAttachments: [],
    cloudWanPeerings: [],
    tgwRouteTables: new Map([
      [
        'tgw-aaaa1111',
        [
          {
            routeTable: {
              transitGatewayRouteTableId: 'tgw-rtb-dddd4444',
              transitGatewayId: 'tgw-aaaa1111',
              state: 'available',
              defaultAssociationRouteTable: true,
              defaultPropagationRouteTable: true,
              tags: {},
            },
            routes: [
              {
                destinationCidrBlock: '10.0.0.0/16',
                transitGatewayAttachments: [
                  {
                    transitGatewayAttachmentId: 'tgw-attach-bbbb2222',
                    resourceType: 'vpc',
                    resourceId: 'vpc-0123456789abcdef',
                  },
                ],
                type: 'propagated',
                state: 'active',
              },
              {
                destinationCidrBlock: '0.0.0.0/0',
                transitGatewayAttachments: [],
                type: 'static',
                state: 'blackhole',
              },
            ],
          },
        ],
      ],
    ]),
    vpcRouteTables: new Map([
      [
        'vpc-0123456789abcdef',
        [
          {
            routeTableId: 'rtb-eeee5555',
            vpcId: 'vpc-0123456789abcdef',
            isMain: true,
            associatedSubnetIds: ['subnet-ffff6666'],
            tags: {},
            routes: [
              { destinationCidrBlock: '10.0.0.0/16', gatewayId: 'local', state: 'active' },
              { destinationCidrBlock: '0.0.0.0/0', transitGatewayId: 'tgw-aaaa1111', state: 'active' },
            ],
          },
        ],
      ],
    ]),
    cloudWanRoutes: new Map(),
    vifUtilization: new Map([
      ['dxvif-deadbeef', { ingressBpsPeak: 500_000_000, egressBpsPeak: 250_000_000 }],
    ]),
    connectionUtilization: new Map([
      ['dxcon-abc12345', { ingressBpsPeak: 800_000_000, egressBpsPeak: 400_000_000 }],
    ]),
    utilizationWindowDays: 30,
    homeAccountId: '111122223333',
    regionNames: new Map([['us-east-1', 'US East (N. Virginia)']]),
  };
}

// Strings from the fixture that must NOT appear anywhere in the sanitized
// output. Strategy: inspect by-substring on the full JSON form, including
// Maps (we expand them manually since JSON.stringify renders Maps as `{}`).
const REAL_VALUES_TO_PURGE = [
  // Resource IDs
  'dxcon-abc12345',
  'dxlag-xy789012',
  'dxvif-deadbeef',
  '12345678-1234-1234-1234-123456789abc',
  'vpc-0123456789abcdef',
  'tgw-aaaa1111',
  'tgw-attach-bbbb2222',
  'cgw-cccc3333',
  'tgw-rtb-dddd4444',
  'rtb-eeee5555',
  'subnet-ffff6666',
  // Account IDs
  '111122223333',
  // Free-text & tags
  'corp-payroll-prod',
  'finance-prod-vif',
  'corp-dxgw-prod',
  'tgw-prod',
  'finance-prod',
  'alice@corp.example',
  'Production hub',
  // Location & device leakage
  'EqDC2',
  'EqDC2-3jw9w7c4l',
  'aws-device-x1y2z3',
  // CIDRs and IPs
  '10.0.0.0/16',
  '169.254.1.1/30',
  '169.254.1.2/30',
  '198.18.7.50',
  // ASN
  '4200001001',
  '4200001100',
  '4200000123',
];

function fullJsonInspectable(td: TopologyData): string {
  // Maps stringify as `{}` by default; we expand them so route-table contents
  // and Map-keyed metrics are part of the substring search.
  const replacer = (_key: string, value: unknown) => {
    if (value instanceof Map) return Object.fromEntries(value);
    if (value instanceof Set) return [...value];
    return value;
  };
  return JSON.stringify(td, replacer);
}

describe('sanitize', () => {
  it('purges every fixture identifier from the output', () => {
    const out = sanitizeTopology(makeFixture());
    const json = fullJsonInspectable(out);
    for (const real of REAL_VALUES_TO_PURGE) {
      expect(json, `expected sanitized output to not contain "${real}"`).not.toContain(real);
    }
  });

  it('preserves the 0.0.0.0/0 default-route sentinel inside route tables', () => {
    const out = sanitizeTopology(makeFixture());
    const json = fullJsonInspectable(out);
    // The sentinel must survive because route semantics ("default to 0/0")
    // are different from "default to 203.0.113.0/24".
    expect(json).toContain('0.0.0.0/0');
  });

  it('rewrites Map keys in lockstep with array members', () => {
    const out = sanitizeTopology(makeFixture());
    // The vifUtilization Map must be keyed by the *new* VIF id, not the old.
    const newVifId = out.virtualInterfaces[0].virtualInterfaceId;
    expect(out.vifUtilization?.has(newVifId)).toBe(true);
    expect(out.vifUtilization?.has('dxvif-deadbeef')).toBe(false);

    const newConnId = out.connections[0].connectionId;
    expect(out.connectionUtilization?.has(newConnId)).toBe(true);
    expect(out.connectionUtilization?.has('dxcon-abc12345')).toBe(false);

    // TGW route table is keyed by transitGatewayId.
    const newTgwId = out.transitGateways[0].transitGatewayId;
    expect(out.tgwRouteTables.has(newTgwId)).toBe(true);
    expect(out.tgwRouteTables.has('tgw-aaaa1111')).toBe(false);

    // VPC route table is keyed by vpcId.
    const newVpcId = out.vpcs[0].vpcId;
    expect(out.vpcRouteTables.has(newVpcId)).toBe(true);
    expect(out.vpcRouteTables.has('vpc-0123456789abcdef')).toBe(false);
  });

  it('keeps cross-references resolvable inside the sanitized graph', () => {
    const out = sanitizeTopology(makeFixture());
    const newConnId = out.connections[0].connectionId;
    const newVifConnId = out.virtualInterfaces[0].connectionId;
    expect(newVifConnId).toBe(newConnId);

    const newDxgwId = out.dxGateways[0].directConnectGatewayId;
    const newVifDxgwId = out.virtualInterfaces[0].directConnectGatewayId;
    expect(newVifDxgwId).toBe(newDxgwId);

    const newTgwId = out.transitGateways[0].transitGatewayId;
    const attachTgwId = out.transitGatewayAttachments[0].transitGatewayId;
    const vpcRtTgwId = out.vpcRouteTables.get(out.vpcs[0].vpcId)?.[0].routes[1].transitGatewayId;
    expect(attachTgwId).toBe(newTgwId);
    expect(vpcRtTgwId).toBe(newTgwId);

    const newVpcId = out.vpcs[0].vpcId;
    const attachVpcId = out.transitGatewayAttachments[0].resourceId;
    expect(attachVpcId).toBe(newVpcId);
  });

  it('preserves the local gateway sentinel', () => {
    const out = sanitizeTopology(makeFixture());
    const localRoute = out.vpcRouteTables.get(out.vpcs[0].vpcId)?.[0].routes[0];
    expect(localRoute?.gatewayId).toBe('local');
  });

  it('rewrites ARNs to use pseudo account and resource ids', () => {
    const out = sanitizeTopology(makeFixture());
    const arn = out.transitGateways[0].transitGatewayArn;
    expect(arn).not.toContain('111122223333');
    expect(arn).not.toContain('tgw-aaaa1111');
    expect(arn).toMatch(/^arn:aws:ec2:us-east-1:9\d{11}:transit-gateway\/tgw-\d{8}$/);
  });

  it('is idempotent across two passes with the same Sanitizer', () => {
    const s = new Sanitizer();
    const once = s.sanitizeTopology(makeFixture());
    const twice = s.sanitizeTopology(once);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });

  it('produces deterministic output for the same input', () => {
    const a = sanitizeTopology(makeFixture());
    const b = sanitizeTopology(makeFixture());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
