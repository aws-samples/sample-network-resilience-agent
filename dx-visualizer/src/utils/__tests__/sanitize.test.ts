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
        // A public VIF's advertised prefixes — the customer's real routable
        // blocks. Deliberately NOT documentation-reserved ranges, or
        // SPECIAL_CIDRS would pass them through and the leak scan below would
        // prove nothing.
        routeFilterPrefixes: [{ cidr: '52.94.16.0/22' }, { cidr: '104.28.9.0/24' }],
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
              // IPv6 destination — populated from DescribeRouteTables just like
              // the IPv4 field, and previously spread through unmasked.
              { destinationIpv6CidrBlock: '2600:1f18:abcd::/56', transitGatewayId: 'tgw-aaaa1111', state: 'active' },
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
    vifRoutes: new Map([
      ['dxvif-deadbeef', {
        accepted: [
          {
            cidr: '192.168.50.0/24',
            addressFamily: 'ipv4' as const,
            asPath: [{ pathType: 'seq' as const, path: [65000, 65001] }],
            communities: ['65000:100'],
            routeDirection: 'accepted' as const,
            routeInstalledAt: '2026-08-01T09:15:00.000Z',
          },
          {
            // Default route must survive verbatim or route semantics break.
            cidr: '0.0.0.0/0',
            addressFamily: 'ipv4' as const,
            asPath: [{ pathType: 'seq' as const, path: [65000] }],
            communities: [],
            routeDirection: 'accepted' as const,
          },
        ],
        advertised: [{
          cidr: '172.31.0.0/16',
          addressFamily: 'ipv4' as const,
          asPath: [{ pathType: 'seq' as const, path: [64512] }],
          communities: ['7224:8100'],
          routeDirection: 'advertised' as const,
        }],
      }],
    ]),
    // Failover test history. `testId` is a bare dashless AWS token, which is
    // exactly the shape resourceId() passes through untouched — so it needs to
    // be in the fixture for the leak scan to prove it gets rewritten.
    vifFailoverTests: new Map([
      ['dxvif-deadbeef', [{
        testId: '0hm9q4ki',
        virtualInterfaceId: 'dxvif-deadbeef',
        bgpPeers: ['bgp-peer-001'],
        status: 'completed',
        ownerAccount: '111122223333',
        testDurationInMinutes: 30,
        startTime: '2026-06-27T02:00:00.000Z',
        endTime: '2026-06-27T02:30:00.000Z',
      }]],
    ]),
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
  // Public-VIF route filter prefixes — real routable blocks, not doc ranges
  '52.94.16.0/22',
  '104.28.9.0/24',
  // IPv6 (RFC 3849 2001:db8::/32 is the doc range; this is deliberately not it)
  '2600:1f18:abcd::/56',
  // Opaque AWS tokens with no prefix-suffix shape
  '0hm9q4ki',
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

  it('rewrites BGP route CIDRs, AS paths, and community ASNs', () => {
    const out = sanitizeTopology(makeFixture());
    const entries = [...out.vifRoutes!.entries()];
    expect(entries).toHaveLength(1);
    const [key, routes] = entries[0];
    // The map key is a VIF id and must be pseudonymized like any resource id.
    expect(key).not.toBe('dxvif-deadbeef');
    expect(key).toMatch(/^dxvif-\d{8}$/);

    const specific = routes.accepted.find((r) => r.cidr !== '0.0.0.0/0')!;
    expect(specific.cidr).not.toBe('192.168.50.0/24');
    // Real customer ASNs must not survive in the AS path.
    expect(specific.asPath[0].path).not.toContain(65000);
    expect(specific.asPath[0].path).not.toContain(65001);
    expect(specific.asPath[0].path).toHaveLength(2);
    expect(specific.asPath[0].pathType).toBe('seq');
    // Communities are "asn:value" — the ASN half is rewritten, the value kept.
    expect(specific.communities[0]).not.toBe('65000:100');
    expect(specific.communities[0]).toMatch(/^\d+:100$/);

    expect(routes.advertised[0].cidr).not.toBe('172.31.0.0/16');
  });

  it('leaves the default route intact so route semantics survive', () => {
    const out = sanitizeTopology(makeFixture());
    const cidrs = out.vifRoutes!.get([...out.vifRoutes!.keys()][0])!.accepted.map((r) => r.cidr);
    // A pseudonymized default route would read as an ordinary prefix, so the
    // route panels and the DXGW diff would lose the "this is everything" signal
    // on a sanitized snapshot.
    expect(cidrs).toContain('0.0.0.0/0');
  });

  it('maps a route CIDR to the same pseudo as the same CIDR elsewhere in the topology', () => {
    // One Sanitizer shares its cidrMap across the whole topology, so a prefix
    // that appears both as a route and as an allowed-prefix must agree —
    // otherwise the SA sees two unrelated-looking networks.
    const fixture = makeFixture();
    const vpcCidr = fixture.vpcs[0]?.cidrBlock;
    expect(vpcCidr).toBeTruthy();
    fixture.vifRoutes!.get('dxvif-deadbeef')!.accepted.push({
      cidr: vpcCidr!,
      addressFamily: 'ipv4',
      asPath: [{ pathType: 'seq', path: [65000] }],
      communities: [],
      routeDirection: 'accepted',
    });
    const out = sanitizeTopology(fixture);
    const routeCidrs = out.vifRoutes!.get([...out.vifRoutes!.keys()][0])!.accepted.map((r) => r.cidr);
    expect(routeCidrs).toContain(out.vpcs[0].cidrBlock);
  });

  it('masks a public VIF\'s route filter prefixes', () => {
    // These are the customer's real advertised blocks. Every sibling prefix
    // list is masked, and this one was being spread through verbatim.
    const out = sanitizeTopology(makeFixture());
    const prefixes = out.virtualInterfaces[0].routeFilterPrefixes;
    expect(prefixes).toHaveLength(2);
    for (const p of prefixes!) {
      expect(p.cidr).not.toBe('52.94.16.0/22');
      expect(p.cidr).not.toBe('104.28.9.0/24');
      // Rewritten into a documentation-reserved range, mask width preserved.
      expect(p.cidr).toMatch(/^(203\.0\.113|198\.51\.100|192\.0\.2)\.\d+\/\d+$/);
    }
    expect(prefixes![0].cidr.endsWith('/22')).toBe(true);
    expect(prefixes![1].cidr.endsWith('/24')).toBe(true);
  });

  it('masks an IPv6 prefix into IPv6 space, not a mangled IPv4 block', () => {
    // The IPv4 allocator would emit "203.0.113.0/56" — masked, but not a valid
    // prefix, so anything that parses it downstream reads garbage.
    const out = sanitizeTopology(makeFixture());
    const v6 = out.vpcRouteTables.get([...out.vpcRouteTables.keys()][0])![0]
      .routes.find((r) => r.destinationIpv6CidrBlock)!;
    expect(v6.destinationIpv6CidrBlock).not.toBe('2600:1f18:abcd::/56');
    expect(v6.destinationIpv6CidrBlock).toMatch(/^2001:db8:[0-9a-f]+::\/56$/);
  });

  it('rewrites a dashless failover testId, which resourceId() cannot', () => {
    // resourceId() needs a "prefix-suffix" shape and returns bare tokens
    // unchanged by design, so testId needs its own allocator.
    const out = sanitizeTopology(makeFixture());
    // Key is the pseudonymized VIF ID; take the sole entry rather than
    // hardcoding whatever counter value it landed on.
    const entries = [...out.vifFailoverTests!.values()];
    expect(entries).toHaveLength(1);
    const test = entries[0][0];
    expect(test.testId).not.toBe('0hm9q4ki');
    expect(test.testId).toMatch(/^test\d+$/);
    // The account that ran it is still masked, and the VIF key still maps.
    expect(test.ownerAccount).not.toBe('111122223333');
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
