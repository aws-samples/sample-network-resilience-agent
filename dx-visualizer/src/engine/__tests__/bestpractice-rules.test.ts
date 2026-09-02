import { describe, it, expect } from 'vitest';
import {
  ruleBfdGuidance,
  ruleVifDown,
  ruleConnectionNotAvailable,
  ruleNoVpnBackup,
  ruleSlaAwareness,
  ruleResiliencyToolkit,
  ruleConsistentPrefixAdvertisement,
  ruleVifRouteSymmetry,
  ruleVifRateLimitOversubscription,
  ruleBgpRouteLimit,
  ruleVpnTunnelRedundancy,
  ruleVpnStaticRoutesOnly,
  ruleBgpSessionStability,
  ruleDxgwPropagationEnabled,
  ruleBlackholeRoutes,
  ruleVpcNoHybridRoute,
  ruleCgwRedundancy,
  ruleDxPartnerDiversity,
  ruleVpnDpd,
  ruleDxLocationRedundancy,
  ruleBgpTimersFallback,
  ruleDxFailoverTesting,
  ruleFailoverRunbooks,
  getAllBestPracticeResults,
} from '../bestpractice-rules';
import { makeEmptyTopology } from './helpers';

describe('ruleBfdGuidance', () => {
  it('returns no recommendation when no connections or VIFs', () => {
    const result = ruleBfdGuidance(makeEmptyTopology());
    expect(result.recommendation).toBeNull();
  });

  it('returns BFD guidance when connections exist', () => {
    const t = makeEmptyTopology();
    t.connections = [{ connectionId: 'c1', connectionState: 'available', tags: {} } as any];
    const result = ruleBfdGuidance(t);
    expect(result.recommendation).not.toBeNull();
    expect(result.recommendation!.ruleId).toBe('bfd-guidance');
  });

  it('returns BFD guidance when only VIFs exist', () => {
    const t = makeEmptyTopology();
    t.virtualInterfaces = [{ virtualInterfaceId: 'v1', bgpPeers: [], tags: {} } as any];
    const result = ruleBfdGuidance(t);
    expect(result.recommendation).not.toBeNull();
  });
});

describe('ruleVifDown', () => {
  it('returns no recommendation when all VIFs are available', () => {
    const t = makeEmptyTopology();
    t.virtualInterfaces = [
      { virtualInterfaceId: 'v1', virtualInterfaceName: 'vif-1', virtualInterfaceState: 'available', bgpPeers: [{ bgpStatus: 'up' }], tags: {} } as any,
    ];
    expect(ruleVifDown(t).recommendation).toBeNull();
  });

  it('detects VIF in non-available state', () => {
    const t = makeEmptyTopology();
    t.virtualInterfaces = [
      { virtualInterfaceId: 'v1', virtualInterfaceName: 'vif-down', virtualInterfaceState: 'down', bgpPeers: [], tags: {} } as any,
    ];
    const result = ruleVifDown(t);
    expect(result.recommendation).not.toBeNull();
    expect(result.recommendation!.severity).toBe('critical');
    expect(result.recommendation!.description).toContain('vif-down');
  });

  it('detects VIF with all BGP peers down', () => {
    const t = makeEmptyTopology();
    t.virtualInterfaces = [
      {
        virtualInterfaceId: 'v1',
        virtualInterfaceName: 'vif-bgp-down',
        virtualInterfaceState: 'available',
        bgpPeers: [{ bgpStatus: 'down' }, { bgpStatus: 'down' }],
        tags: {},
      } as any,
    ];
    const result = ruleVifDown(t);
    expect(result.recommendation).not.toBeNull();
    expect(result.recommendation!.description).toContain('vif-bgp-down');
  });
});

describe('ruleConnectionNotAvailable', () => {
  it('returns no recommendation when all connections are available', () => {
    const t = makeEmptyTopology();
    t.connections = [{ connectionId: 'c1', connectionName: 'conn-1', connectionState: 'available', tags: {} } as any];
    expect(ruleConnectionNotAvailable(t).recommendation).toBeNull();
  });

  it('detects connection in non-available state', () => {
    const t = makeEmptyTopology();
    t.connections = [{ connectionId: 'c1', connectionName: 'bad-conn', connectionState: 'down', tags: {} } as any];
    const result = ruleConnectionNotAvailable(t);
    expect(result.recommendation).not.toBeNull();
    expect(result.recommendation!.severity).toBe('critical');
    expect(result.recommendation!.description).toContain('bad-conn');
  });
});

describe('ruleNoVpnBackup', () => {
  it('returns no recommendation when no DX infrastructure exists', () => {
    expect(ruleNoVpnBackup(makeEmptyTopology()).recommendation).toBeNull();
  });

  it('returns recommendation when DX exists but no VPN backup', () => {
    const t = makeEmptyTopology();
    t.connections = [{ connectionId: 'c1', connectionState: 'available', tags: {} } as any];
    const result = ruleNoVpnBackup(t);
    expect(result.recommendation).not.toBeNull();
    expect(result.recommendation!.ruleId).toBe('no-vpn-backup');
    expect(result.recommendation!.severity).toBe('warning');
  });

  it('returns no recommendation when VPN connections exist', () => {
    const t = makeEmptyTopology();
    t.connections = [{ connectionId: 'c1', connectionState: 'available', tags: {} } as any];
    t.vpnConnections = [{ vpnConnectionId: 'vpn-1', tags: {} } as any];
    expect(ruleNoVpnBackup(t).recommendation).toBeNull();
  });
});

describe('ruleSlaAwareness', () => {
  it('returns no recommendation for empty topology', () => {
    expect(ruleSlaAwareness(makeEmptyTopology()).recommendation).toBeNull();
  });

  it('returns info-level SLA awareness recommendation when DX exists', () => {
    const t = makeEmptyTopology();
    t.connections = [{ connectionId: 'c1', connectionState: 'available', tags: {} } as any];
    const result = ruleSlaAwareness(t);
    expect(result.recommendation).not.toBeNull();
    expect(result.recommendation!.ruleId).toBe('sla-awareness');
    expect(result.recommendation!.severity).toBe('info');
    expect(result.recommendation!.description).toContain('aws.amazon.com/directconnect/sla');
  });
});

describe('ruleResiliencyToolkit', () => {
  it('returns no recommendation for empty topology', () => {
    expect(ruleResiliencyToolkit(makeEmptyTopology()).recommendation).toBeNull();
  });

  it('returns info recommendation when DX exists', () => {
    const t = makeEmptyTopology();
    t.virtualInterfaces = [{ virtualInterfaceId: 'v1', bgpPeers: [], tags: {} } as any];
    const result = ruleResiliencyToolkit(t);
    expect(result.recommendation).not.toBeNull();
    expect(result.recommendation!.ruleId).toBe('resiliency-toolkit');
    expect(result.recommendation!.description).toContain('resiliency_toolkit');
  });
});

describe('ruleConsistentPrefixAdvertisement', () => {
  it('returns no recommendation when fewer than 2 VIFs', () => {
    const t = makeEmptyTopology();
    t.virtualInterfaces = [{ virtualInterfaceId: 'v1', bgpPeers: [], tags: {} } as any];
    expect(ruleConsistentPrefixAdvertisement(t).recommendation).toBeNull();
  });

  it('returns recommendation when 2 or more VIFs exist', () => {
    const t = makeEmptyTopology();
    t.virtualInterfaces = [
      { virtualInterfaceId: 'v1', bgpPeers: [], tags: {} } as any,
      { virtualInterfaceId: 'v2', bgpPeers: [], tags: {} } as any,
    ];
    const result = ruleConsistentPrefixAdvertisement(t);
    expect(result.recommendation).not.toBeNull();
    expect(result.recommendation!.ruleId).toBe('consistent-prefix-advertisement');
  });
});

describe('ruleBgpRouteLimit', () => {
  const makeVif = (id: string, type: 'private' | 'transit' | 'public' = 'private') =>
    ({
      virtualInterfaceId: id,
      virtualInterfaceName: id,
      virtualInterfaceType: type,
      bgpPeers: [],
      tags: {},
    }) as any;

  it('returns no recommendation without applicable VIFs', () => {
    expect(ruleBgpRouteLimit(makeEmptyTopology()).recommendation).toBeNull();
  });

  it('ignores public VIFs (1000-prefix limit does not apply)', () => {
    const t = makeEmptyTopology();
    t.virtualInterfaces = [makeVif('v-pub', 'public')];
    expect(ruleBgpRouteLimit(t).recommendation).toBeNull();
  });

  it('falls back to info guidance when CloudWatch metrics are missing', () => {
    const t = makeEmptyTopology();
    t.virtualInterfaces = [makeVif('v1')];
    const result = ruleBgpRouteLimit(t);
    expect(result.recommendation).not.toBeNull();
    expect(result.recommendation!.ruleId).toBe('bgp-route-limit');
    expect(result.recommendation!.severity).toBe('info');
    expect(result.recommendation!.description).toContain('limits.html');
  });

  it('confirms met when all VIFs are well under the limit', () => {
    const t = makeEmptyTopology();
    t.virtualInterfaces = [makeVif('v1'), makeVif('v2', 'transit')];
    t.bgpPrefixMetrics = new Map([
      ['v1', { accepted: 12, advertised: 5 }],
      ['v2', { accepted: 34, advertised: 8 }],
    ]);
    const result = ruleBgpRouteLimit(t);
    expect(result.recommendation).not.toBeNull();
    expect(result.recommendation!.ruleId).toBe('bgp-route-limit-ok');
    expect(result.recommendation!.severity).toBe('info');
    expect(result.recommendation!.description).toContain('peak observed is 34');
  });

  it('warns when a VIF is within 20 prefixes of the limit', () => {
    const t = makeEmptyTopology();
    t.virtualInterfaces = [makeVif('v-near')];
    t.bgpPrefixMetrics = new Map([['v-near', { accepted: 85 }]]);
    const result = ruleBgpRouteLimit(t);
    expect(result.recommendation).not.toBeNull();
    expect(result.recommendation!.severity).toBe('warning');
    expect(result.recommendation!.description).toContain('v-near');
    expect(result.recommendation!.description).toContain('85');
  });

  it('flags critical when a VIF is at or over 100 prefixes', () => {
    const t = makeEmptyTopology();
    t.virtualInterfaces = [makeVif('v-over')];
    t.bgpPrefixMetrics = new Map([['v-over', { accepted: 102 }]]);
    const result = ruleBgpRouteLimit(t);
    expect(result.recommendation).not.toBeNull();
    expect(result.recommendation!.severity).toBe('critical');
    expect(result.recommendation!.description).toContain('v-over');
    expect(result.recommendation!.description).toContain('102 accepted');
  });

  it('prefers the exact route count over the CloudWatch metric', () => {
    const t = makeEmptyTopology();
    t.virtualInterfaces = [makeVif('v1')];
    // Metric says healthy; routes say the session is over the hard limit. The
    // exact count must win — it is a real count of installed prefixes, while the
    // metric is a 5-minute average that can lag or under-report.
    t.bgpPrefixMetrics = new Map([['v1', { accepted: 10 }]]);
    t.vifRoutes = new Map([['v1', routes(makeCidrs(105), [])]]);
    const result = ruleBgpRouteLimit(t);
    expect(result.recommendation!.severity).toBe('critical');
    expect(result.recommendation!.description).toContain('105 accepted');
  });

  // The quota is "100 each for IPv4 and IPv6", so the count is per address
  // family. Pooling used to break this rule in BOTH directions.
  describe('address-family bucketing', () => {
    const v6Route = (cidr: string) => ({
      cidr,
      addressFamily: 'ipv6' as const,
      asPath: [{ pathType: 'seq' as const, path: [65000] }],
      communities: [],
      routeDirection: 'accepted' as const,
    });

    it('stays healthy when neither family exceeds its own budget', () => {
      const t = makeEmptyTopology();
      t.virtualInterfaces = [makeVif('v-dual')];
      // 60 v4 + 60 v6 = 120 pooled, which used to read CRITICAL. Both families
      // are comfortably inside their own 100-prefix budget.
      t.vifRoutes = new Map([
        ['v-dual', {
          accepted: [
            ...makeCidrs(60).map((c) => route(c, 'accepted')),
            ...Array.from({ length: 60 }, (_, i) => v6Route(`2001:db8:${i}::/64`)),
          ],
          advertised: [],
        }],
      ] as any);
      const result = ruleBgpRouteLimit(t);
      expect(result.recommendation!.ruleId).toBe('bgp-route-limit-ok');
      expect(result.recommendation!.severity).toBe('info');
      expect(result.recommendation!.description).toContain('peak observed is 60');
    });

    it('flags a family that is near its own limit even when the pool looks fine', () => {
      const t = makeEmptyTopology();
      t.virtualInterfaces = [makeVif('v-dual')];
      // 95 v4 + 3 v6: pooled 98 read "well under" while IPv4 sat 5 prefixes
      // from teardown.
      t.vifRoutes = new Map([
        ['v-dual', {
          accepted: [
            ...makeCidrs(95).map((c) => route(c, 'accepted')),
            ...Array.from({ length: 3 }, (_, i) => v6Route(`2001:db8:${i}::/64`)),
          ],
          advertised: [],
        }],
      ] as any);
      const result = ruleBgpRouteLimit(t);
      expect(result.recommendation!.severity).toBe('warning');
      // Dual-stack VIFs name the offending family so the reader knows which
      // side to summarize.
      expect(result.recommendation!.description).toContain('95 accepted on IPv4');
    });

    it('flags an over-limit IPv6 family', () => {
      const t = makeEmptyTopology();
      t.virtualInterfaces = [makeVif('v-dual')];
      t.vifRoutes = new Map([
        ['v-dual', {
          accepted: [
            ...makeCidrs(10).map((c) => route(c, 'accepted')),
            ...Array.from({ length: 101 }, (_, i) => v6Route(`2001:db8:${i}::/64`)),
          ],
          advertised: [],
        }],
      ] as any);
      const result = ruleBgpRouteLimit(t);
      expect(result.recommendation!.severity).toBe('critical');
      expect(result.recommendation!.description).toContain('101 accepted on IPv6');
    });

    it('buckets the CloudWatch metric by its IpAddressFamily dimension', () => {
      const t = makeEmptyTopology();
      t.virtualInterfaces = [makeVif('v-dual')];
      t.bgpPrefixMetrics = new Map([
        ['v-dual', {
          accepted: 150,
          byFamily: { ipv4: { accepted: 90 }, ipv6: { accepted: 60 } },
        }],
      ]);
      const result = ruleBgpRouteLimit(t);
      // Pooled 150 would have been critical; IPv4 at 90 is a caution.
      expect(result.recommendation!.severity).toBe('warning');
      expect(result.recommendation!.description).toContain('90 accepted on IPv4');
    });

    it('treats a pooled-only metric as IPv4 so old snapshots still score', () => {
      const t = makeEmptyTopology();
      t.virtualInterfaces = [makeVif('v-old')];
      t.bgpPrefixMetrics = new Map([['v-old', { accepted: 102 }]]);
      const result = ruleBgpRouteLimit(t);
      expect(result.recommendation!.severity).toBe('critical');
      expect(result.recommendation!.description).toContain('102 accepted');
    });

    it('counts routes with no addressFamily as IPv4', () => {
      const t = makeEmptyTopology();
      t.virtualInterfaces = [makeVif('v-nofam')];
      t.vifRoutes = new Map([
        ['v-nofam', {
          accepted: makeCidrs(101).map((c) => ({
            cidr: c,
            asPath: [],
            communities: [],
            routeDirection: 'accepted' as const,
          })),
          advertised: [],
        }],
      ] as any);
      const result = ruleBgpRouteLimit(t);
      expect(result.recommendation!.severity).toBe('critical');
      expect(result.recommendation!.description).toContain('101 accepted');
    });
  });
});

// --- BGP route-backed rules (ListVirtualInterfaceRoutes) ---------------------

const route = (cidr: string, direction: 'accepted' | 'advertised' = 'accepted') => ({
  cidr,
  addressFamily: 'ipv4' as const,
  asPath: [{ pathType: 'seq' as const, path: [65000] }],
  communities: [],
  routeDirection: direction,
});

const routes = (acceptedCidrs: string[], advertisedCidrs: string[]) => ({
  accepted: acceptedCidrs.map((c) => route(c, 'accepted')),
  advertised: advertisedCidrs.map((c) => route(c, 'advertised')),
});

const makeCidrs = (n: number, second = 20) =>
  Array.from({ length: n }, (_, i) => `10.${second}.${i}.0/24`);

// Two redundant VIFs on the same DXGW — the shape every symmetry rule keys on.
const makeRedundantPair = () => {
  const t = makeEmptyTopology();
  t.virtualInterfaces = [
    { virtualInterfaceId: 'v1', virtualInterfaceName: 'v1', virtualInterfaceType: 'transit', directConnectGatewayId: 'dxgw-1', bgpPeers: [], tags: {} },
    { virtualInterfaceId: 'v2', virtualInterfaceName: 'v2', virtualInterfaceType: 'transit', directConnectGatewayId: 'dxgw-1', bgpPeers: [], tags: {} },
  ] as any;
  return t;
};

describe('ruleConsistentPrefixAdvertisement (route-backed)', () => {
  it('falls back to guidance when no route data is present', () => {
    const t = makeRedundantPair();
    const rec = ruleConsistentPrefixAdvertisement(t).recommendation!;
    expect(rec.severity).toBe('info');
    expect(rec.description).toContain('BGP Routes overlay');
    // The old claim that this is unavailable via API must be gone.
    expect(rec.description).not.toContain('not available via the AWS API');
  });

  it('warns with the actual differing prefixes when accepted sets diverge', () => {
    const t = makeRedundantPair();
    t.vifRoutes = new Map([
      ['v1', routes(['10.0.0.0/24', '10.0.1.0/24'], [])],
      ['v2', routes(['10.0.0.0/24'], [])],
    ]);
    const rec = ruleConsistentPrefixAdvertisement(t).recommendation!;
    expect(rec.severity).toBe('warning');
    expect(rec.description).toContain('10.0.1.0/24');
    // Names the VIF that lacks the prefix, so the reader knows which router to
    // fix — an undirected "v1 vs v2: 10.0.1.0/24" left that ambiguous.
    expect(rec.description).toContain('v2 is missing');
    expect(rec.description).not.toContain('v1 is missing');
  });

  it('blames only the deficient VIF, not every sibling of the reference', () => {
    // The shape that made real output unreadable: the first VIF (used as the
    // star reference) is the one short on prefixes, so a pairwise comparison
    // emitted one line per sibling — N-1 findings describing a single problem.
    const t = makeRedundantPair();
    t.virtualInterfaces.push(
      { virtualInterfaceId: 'v3', virtualInterfaceName: 'v3', virtualInterfaceType: 'transit', directConnectGatewayId: 'dxgw-1', bgpPeers: [], tags: {} } as never,
      { virtualInterfaceId: 'v4', virtualInterfaceName: 'v4', virtualInterfaceType: 'transit', directConnectGatewayId: 'dxgw-1', bgpPeers: [], tags: {} } as never,
    );
    const full = ['10.0.0.0/24', '10.0.1.0/24', '10.0.2.0/24'];
    t.vifRoutes = new Map([
      ['v1', routes(['10.0.0.0/24'], [])],
      ['v2', routes(full, [])],
      ['v3', routes(full, [])],
      ['v4', routes(full, [])],
    ]);
    const rec = ruleConsistentPrefixAdvertisement(t).recommendation!;
    expect(rec.description).toContain('v1 is missing 2 of 3');
    for (const healthy of ['v2 is missing', 'v3 is missing', 'v4 is missing']) {
      expect(rec.description).not.toContain(healthy);
    }
  });

  it('resolves the routing domain to the gateway name, not a bare UUID', () => {
    const t = makeRedundantPair();
    t.dxGateways = [{
      directConnectGatewayId: 'dxgw-1',
      directConnectGatewayName: 'prod-hybrid-dxgw',
      amazonSideAsn: 64512,
      directConnectGatewayState: 'available',
    }];
    t.vifRoutes = new Map([
      ['v1', routes(['10.0.0.0/24', '10.0.1.0/24'], [])],
      ['v2', routes(['10.0.0.0/24'], [])],
    ]);
    const rec = ruleConsistentPrefixAdvertisement(t).recommendation!;
    expect(rec.description).toContain('prod-hybrid-dxgw');
  });

  it('confirms verified-matching when both VIFs accept identical sets', () => {
    const t = makeRedundantPair();
    t.vifRoutes = new Map([
      ['v1', routes(['10.0.0.0/24'], [])],
      ['v2', routes(['10.0.0.0/24'], [])],
    ]);
    const rec = ruleConsistentPrefixAdvertisement(t).recommendation!;
    expect(rec.severity).toBe('info');
    expect(rec.title).toContain('matching prefix sets');
  });

  it('does not compare VIFs on different gateways', () => {
    const t = makeRedundantPair();
    (t.virtualInterfaces[1] as any).directConnectGatewayId = 'dxgw-2';
    t.vifRoutes = new Map([
      ['v1', routes(['10.0.0.0/24'], [])],
      ['v2', routes(['192.168.0.0/24'], [])],
    ]);
    // Separate routing domains legitimately carry different prefixes.
    const rec = ruleConsistentPrefixAdvertisement(t).recommendation!;
    expect(rec.description).toContain('BGP Routes overlay');
  });
});

describe('ruleVifRouteSymmetry (route-backed)', () => {
  it('falls back to guidance without route data', () => {
    const t = makeRedundantPair();
    const rec = ruleVifRouteSymmetry(t).recommendation!;
    expect(rec.severity).toBe('info');
    expect(rec.description).not.toContain('not available via the AWS API');
  });

  it('flags prefixes already covered by a less-specific prefix', () => {
    const t = makeRedundantPair();
    t.vifRoutes = new Map([['v1', routes(['10.0.0.0/16', '10.0.1.0/24', '10.0.2.0/24'], [])]]);
    const rec = ruleVifRouteSymmetry(t).recommendation!;
    expect(rec.severity).toBe('warning');
    expect(rec.description).toContain('10.0.1.0/24');
    expect(rec.description).toContain('10.0.2.0/24');
  });

  it('stays guidance when prefixes are already summarized', () => {
    const t = makeRedundantPair();
    t.vifRoutes = new Map([['v1', routes(['10.0.0.0/16', '10.1.0.0/16'], [])]]);
    expect(ruleVifRouteSymmetry(t).recommendation!.severity).toBe('info');
  });

  it('does not treat a default route as a covering prefix', () => {
    const t = makeRedundantPair();
    t.vifRoutes = new Map([['v1', routes(['0.0.0.0/0', '10.0.1.0/24'], [])]]);
    // Everything is "inside" 0.0.0.0/0 — that would flag every route as
    // redundant, which is wrong: a default route doesn't make specifics useless.
    expect(ruleVifRouteSymmetry(t).recommendation!.severity).toBe('info');
  });
});

describe('ruleVpnTunnelRedundancy', () => {
  it('returns no recommendation when no VPN connections', () => {
    expect(ruleVpnTunnelRedundancy(makeEmptyTopology()).recommendation).toBeNull();
  });

  it('returns no recommendation when all VPNs have 2 tunnels UP', () => {
    const t = makeEmptyTopology();
    t.vpnConnections = [{
      vpnConnectionId: 'vpn-1',
      customerGatewayId: 'cgw-1',
      tunnels: [{ status: 'UP' }, { status: 'UP' }],
      tags: {},
    } as any];
    expect(ruleVpnTunnelRedundancy(t).recommendation).toBeNull();
  });

  it('detects VPN with a down tunnel', () => {
    const t = makeEmptyTopology();
    t.vpnConnections = [{
      vpnConnectionId: 'vpn-degraded',
      customerGatewayId: 'cgw-1',
      tunnels: [{ status: 'UP' }, { status: 'DOWN' }],
      tags: {},
    } as any];
    const result = ruleVpnTunnelRedundancy(t);
    expect(result.recommendation).not.toBeNull();
    expect(result.recommendation!.severity).toBe('warning');
    expect(result.recommendation!.description).toContain('vpn-degraded');
  });

  it('reports how long a tunnel has been down (VgwTelemetry.LastStatusChange)', () => {
    const t = makeEmptyTopology();
    const sixDaysAgo = new Date(Date.now() - 6 * 86_400_000).toISOString();
    t.vpnConnections = [{
      vpnConnectionId: 'vpn-stale',
      customerGatewayId: 'cgw-1',
      tunnels: [{ status: 'UP' }, { status: 'DOWN', lastStatusChange: sixDaysAgo }],
      tags: {},
    } as any];
    const result = ruleVpnTunnelRedundancy(t);
    // "DOWN" alone reads as transient; six days reads as an abandoned backup.
    expect(result.recommendation!.description).toContain('down 6 days');
  });

  it('omits the duration when LastStatusChange is absent or in the future', () => {
    const t = makeEmptyTopology();
    t.vpnConnections = [{
      vpnConnectionId: 'vpn-nodate',
      customerGatewayId: 'cgw-1',
      tunnels: [
        { status: 'DOWN' },
        { status: 'DOWN', lastStatusChange: new Date(Date.now() + 86_400_000).toISOString() },
      ],
      tags: {},
    } as any];
    const result = ruleVpnTunnelRedundancy(t);
    expect(result.recommendation!.description).toContain('0/2 tunnels UP)');
    expect(result.recommendation!.description).not.toContain('down ');
  });
});

describe('ruleDxFailoverTesting (test-history-backed)', () => {
  const vif = (id: string) =>
    ({ virtualInterfaceId: id, virtualInterfaceName: id, virtualInterfaceType: 'private', bgpPeers: [], tags: {} }) as any;
  const test_ = (over: Record<string, unknown> = {}) =>
    ({ testId: 't1', virtualInterfaceId: 'v1', bgpPeers: ['peer-1'], status: 'completed', ...over }) as any;
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

  it('falls back to generic guidance when history was never fetched', () => {
    const t = makeEmptyTopology();
    t.virtualInterfaces = [vif('v1')];
    const result = ruleDxFailoverTesting(t);
    // Must not imply the customer never tested just because we could not look.
    expect(result.recommendation!.ruleId).toBe('dx-failover-testing');
    expect(result.recommendation!.severity).toBe('info');
    expect(result.recommendation!.description).not.toContain('no failover test is on record');
  });

  it('warns when AWS has no test on record for a VIF', () => {
    const t = makeEmptyTopology();
    t.virtualInterfaces = [vif('v1')];
    t.vifFailoverTests = new Map([['v1', []]]);
    const result = ruleDxFailoverTesting(t);
    expect(result.recommendation!.severity).toBe('warning');
    expect(result.recommendation!.description).toContain('no failover test is on record');
    // Manual router-side tests are invisible to this API — say so, so nobody
    // reads "no record" as "definitely never tested".
    expect(result.recommendation!.description).toContain('AWS only records failover tests started through its own API');
    expect(result.recommendation!.description).toContain('rather than proof you have never tested');
  });

  it('warns with a date when the newest test is over a year old', () => {
    const t = makeEmptyTopology();
    t.virtualInterfaces = [vif('v1')];
    t.vifFailoverTests = new Map([['v1', [test_({ endTime: daysAgo(400) })]]]);
    const result = ruleDxFailoverTesting(t);
    expect(result.recommendation!.severity).toBe('warning');
    expect(result.recommendation!.description).toContain('400 days ago');
  });

  it('confirms met for a recent successful test', () => {
    const t = makeEmptyTopology();
    t.virtualInterfaces = [vif('v1')];
    t.vifFailoverTests = new Map([['v1', [test_({ endTime: daysAgo(30) })]]]);
    const result = ruleDxFailoverTesting(t);
    expect(result.recommendation!.ruleId).toBe('dx-failover-testing-ok');
    expect(result.recommendation!.description).toContain('30 days ago');
  });

  it('escalates to critical when a recorded test failed', () => {
    const t = makeEmptyTopology();
    t.virtualInterfaces = [vif('v1')];
    t.vifFailoverTests = new Map([['v1', [test_({ status: 'failed', endTime: daysAgo(5) })]]]);
    const result = ruleDxFailoverTesting(t);
    expect(result.recommendation!.severity).toBe('critical');
    expect(result.recommendation!.description).toContain('v1');
  });

  it('ignores VIFs that were not queried at all', () => {
    const t = makeEmptyTopology();
    t.virtualInterfaces = [vif('v1'), vif('v-unqueried')];
    t.vifFailoverTests = new Map([['v1', [test_({ endTime: daysAgo(10) })]]]);
    const result = ruleDxFailoverTesting(t);
    // v-unqueried has no entry, so it must not count as "never tested".
    expect(result.recommendation!.ruleId).toBe('dx-failover-testing-ok');
  });
});

describe('ruleBlackholeRoutes', () => {
  it('stays silent with no route tables', () => {
    expect(ruleBlackholeRoutes(makeEmptyTopology()).recommendation).toBeNull();
  });

  it('stays silent when every route is active', () => {
    const t = makeEmptyTopology();
    t.tgwRouteTables = new Map([['tgw-1', [{
      routeTable: { transitGatewayRouteTableId: 'rtb-1', transitGatewayId: 'tgw-1', state: 'available', defaultAssociationRouteTable: true, defaultPropagationRouteTable: true, tags: {} },
      routes: [{ destinationCidrBlock: '10.0.0.0/8', transitGatewayAttachments: [], type: 'propagated', state: 'active' }],
    }]]] as any);
    expect(ruleBlackholeRoutes(t).recommendation).toBeNull();
  });

  it('flags blackholed TGW routes and names the prefixes', () => {
    const t = makeEmptyTopology();
    t.tgwRouteTables = new Map([['tgw-1', [{
      routeTable: { transitGatewayRouteTableId: 'rtb-1', transitGatewayId: 'tgw-1', state: 'available', defaultAssociationRouteTable: true, defaultPropagationRouteTable: true, tags: { Name: 'prod-rtb' } },
      routes: [
        { destinationCidrBlock: '10.99.0.0/16', transitGatewayAttachments: [], type: 'static', state: 'blackhole' },
        { destinationCidrBlock: '10.0.0.0/8', transitGatewayAttachments: [], type: 'propagated', state: 'active' },
      ],
    }]]] as any);
    const result = ruleBlackholeRoutes(t);
    expect(result.recommendation!.severity).toBe('warning');
    expect(result.recommendation!.description).toContain('prod-rtb');
    expect(result.recommendation!.description).toContain('10.99.0.0/16');
  });

  it('flags blackholed VPC routes', () => {
    const t = makeEmptyTopology();
    t.vpcRouteTables = new Map([['vpc-1', [{
      routeTableId: 'rtb-v1', vpcId: 'vpc-1', isMain: true, associatedSubnetIds: [], tags: {},
      routes: [{ destinationCidrBlock: '192.168.0.0/16', state: 'blackhole' }],
    }]]] as any);
    const result = ruleBlackholeRoutes(t);
    expect(result.recommendation!.description).toContain('192.168.0.0/16');
  });
});

describe('ruleVpcNoHybridRoute', () => {
  const withDx = () => {
    const t = makeEmptyTopology();
    t.connections = [{ connectionId: 'dxcon-1', tags: {} } as any];
    return t;
  };

  it('stays silent without hybrid connectivity', () => {
    const t = makeEmptyTopology();
    t.vpcRouteTables = new Map([['vpc-1', [{
      routeTableId: 'rtb-1', vpcId: 'vpc-1', isMain: true, associatedSubnetIds: [], tags: {}, routes: [],
    }]]] as any);
    expect(ruleVpcNoHybridRoute(t).recommendation).toBeNull();
  });

  it('stays silent when the table routes to a TGW', () => {
    const t = withDx();
    t.vpcRouteTables = new Map([['vpc-1', [{
      routeTableId: 'rtb-1', vpcId: 'vpc-1', isMain: true, associatedSubnetIds: [], tags: {},
      routes: [{ destinationCidrBlock: '10.0.0.0/8', transitGatewayId: 'tgw-1', state: 'active' }],
    }]]] as any);
    expect(ruleVpcNoHybridRoute(t).recommendation).toBeNull();
  });

  it('accepts a vgw- gatewayId as a hybrid target but not an igw-', () => {
    const t = withDx();
    t.vpcRouteTables = new Map([['vpc-1', [{
      routeTableId: 'rtb-vgw', vpcId: 'vpc-1', isMain: true, associatedSubnetIds: [], tags: {},
      routes: [{ destinationCidrBlock: '10.0.0.0/8', gatewayId: 'vgw-1', state: 'active' }],
    }]]] as any);
    expect(ruleVpcNoHybridRoute(t).recommendation).toBeNull();

    const t2 = withDx();
    t2.vpcRouteTables = new Map([['vpc-1', [{
      routeTableId: 'rtb-igw', vpcId: 'vpc-1', isMain: true, associatedSubnetIds: [], tags: {},
      routes: [{ destinationCidrBlock: '0.0.0.0/0', gatewayId: 'igw-1', state: 'active' }],
    }]]] as any);
    expect(ruleVpcNoHybridRoute(t2).recommendation).not.toBeNull();
  });

  it('ignores orphaned tables with no associations and not main', () => {
    const t = withDx();
    t.vpcRouteTables = new Map([['vpc-1', [{
      routeTableId: 'rtb-orphan', vpcId: 'vpc-1', isMain: false, associatedSubnetIds: [], tags: {}, routes: [],
    }]]] as any);
    // Routes nothing, so it cannot strand traffic.
    expect(ruleVpcNoHybridRoute(t).recommendation).toBeNull();
  });
});

describe('ruleDxgwPropagationEnabled', () => {
  const transitVif = () =>
    ({ virtualInterfaceId: 'v-t', virtualInterfaceName: 'v-t', virtualInterfaceType: 'transit', bgpPeers: [], tags: {} }) as any;

  const table = (id: string, propagations?: unknown) =>
    ({
      routeTable: {
        transitGatewayRouteTableId: id,
        transitGatewayId: 'tgw-1',
        state: 'available',
        defaultAssociationRouteTable: true,
        defaultPropagationRouteTable: true,
        tags: {},
      },
      routes: [],
      propagations,
    }) as any;

  it('stays silent without a transit VIF', () => {
    const t = makeEmptyTopology();
    t.tgwRouteTables = new Map([['tgw-1', [table('tgw-rtb-1', [])]]]);
    expect(ruleDxgwPropagationEnabled(t).recommendation).toBeNull();
  });

  it('stays silent when propagations were never fetched (permission or opt-out)', () => {
    const t = makeEmptyTopology();
    t.virtualInterfaces = [transitVif()];
    // undefined means "unknown" — must not be read as "nothing propagates".
    t.tgwRouteTables = new Map([['tgw-1', [table('tgw-rtb-1', undefined)]]]);
    expect(ruleDxgwPropagationEnabled(t).recommendation).toBeNull();
  });

  it('warns when no DX gateway attachment propagates into the table', () => {
    const t = makeEmptyTopology();
    t.virtualInterfaces = [transitVif()];
    t.tgwRouteTables = new Map([['tgw-1', [table('tgw-rtb-1', [
      { transitGatewayAttachmentId: 'tgw-attach-1', resourceId: 'vpc-1', resourceType: 'vpc', state: 'enabled' },
    ])]]]);
    const result = ruleDxgwPropagationEnabled(t);
    expect(result.recommendation!.severity).toBe('warning');
    expect(result.recommendation!.description).toContain('tgw-rtb-1');
  });

  it('warns when DX propagation exists but is not yet enabled', () => {
    const t = makeEmptyTopology();
    t.virtualInterfaces = [transitVif()];
    t.tgwRouteTables = new Map([['tgw-1', [table('tgw-rtb-1', [
      { transitGatewayAttachmentId: 'tgw-attach-2', resourceId: 'dxgw-1', resourceType: 'direct-connect-gateway', state: 'enabling' },
    ])]]]);
    const result = ruleDxgwPropagationEnabled(t);
    expect(result.recommendation!.severity).toBe('warning');
    expect(result.recommendation!.description).toContain('enabling');
  });

  it('confirms met when DX propagation is enabled', () => {
    const t = makeEmptyTopology();
    t.virtualInterfaces = [transitVif()];
    t.tgwRouteTables = new Map([['tgw-1', [table('tgw-rtb-1', [
      { transitGatewayAttachmentId: 'tgw-attach-2', resourceId: 'dxgw-1', resourceType: 'direct-connect-gateway', state: 'enabled' },
    ])]]]);
    const result = ruleDxgwPropagationEnabled(t);
    expect(result.recommendation!.ruleId).toBe('dxgw-propagation-ok');
    expect(result.recommendation!.severity).toBe('info');
  });
});

describe('ruleBgpSessionStability', () => {
  const makeVif = (id: string) =>
    ({ virtualInterfaceId: id, virtualInterfaceName: id, virtualInterfaceType: 'private', bgpPeers: [], tags: {} }) as any;

  it('stays silent when the metric was never fetched', () => {
    const t = makeEmptyTopology();
    t.virtualInterfaces = [makeVif('v1')];
    // Billed per metric retrieved, so absence is the norm — never imply
    // stability we did not measure.
    expect(ruleBgpSessionStability(t).recommendation).toBeNull();
  });

  it('confirms stability and bounds the claim to the sampled window', () => {
    const t = makeEmptyTopology();
    t.virtualInterfaces = [makeVif('v1')];
    t.bgpStability = new Map([
      ['v1', { flapCount: 0, downPeriods: 0, totalPeriods: 2016, windowDays: 7 }],
    ]);
    const result = ruleBgpSessionStability(t);
    expect(result.recommendation!.ruleId).toBe('bgp-session-stability-ok');
    expect(result.recommendation!.description).toContain('7 days');
    expect(result.recommendation!.description).toContain('63 days');
  });

  it('warns when a VIF flapped repeatedly, naming the count and date', () => {
    const t = makeEmptyTopology();
    t.virtualInterfaces = [makeVif('v-flappy')];
    t.bgpStability = new Map([
      ['v-flappy', {
        flapCount: 11, downPeriods: 14, totalPeriods: 2016, windowDays: 7,
        lastFlapAt: '2026-08-09T04:15:00.000Z',
      }],
    ]);
    const result = ruleBgpSessionStability(t);
    expect(result.recommendation!.severity).toBe('warning');
    expect(result.recommendation!.description).toContain('11 drops in 7d');
    expect(result.recommendation!.description).toContain('2026-08-09');
  });

  it('keeps a single blip at info severity', () => {
    const t = makeEmptyTopology();
    t.virtualInterfaces = [makeVif('v-blip')];
    t.bgpStability = new Map([
      ['v-blip', { flapCount: 1, downPeriods: 1, totalPeriods: 2016, windowDays: 7 }],
    ]);
    const result = ruleBgpSessionStability(t);
    expect(result.recommendation!.severity).toBe('info');
    expect(result.recommendation!.description).toContain('1 drop in 7d');
  });

  it('ignores stability entries for VIFs not in the topology', () => {
    const t = makeEmptyTopology();
    t.virtualInterfaces = [makeVif('v1')];
    t.bgpStability = new Map([
      ['v1', { flapCount: 0, downPeriods: 0, totalPeriods: 100, windowDays: 7 }],
      ['v-gone', { flapCount: 9, downPeriods: 9, totalPeriods: 100, windowDays: 7 }],
    ]);
    const result = ruleBgpSessionStability(t);
    expect(result.recommendation!.ruleId).toBe('bgp-session-stability-ok');
  });
});

describe('ruleVpnStaticRoutesOnly', () => {
  it('stays silent when no VPN reports the flag', () => {
    const t = makeEmptyTopology();
    t.vpnConnections = [{ vpnConnectionId: 'vpn-1', customerGatewayId: 'cgw-1', tunnels: [], tags: {} } as any];
    expect(ruleVpnStaticRoutesOnly(t).recommendation).toBeNull();
  });

  it('stays silent for a BGP (dynamic) VPN', () => {
    const t = makeEmptyTopology();
    t.vpnConnections = [{
      vpnConnectionId: 'vpn-bgp', customerGatewayId: 'cgw-1', tunnels: [], staticRoutesOnly: false, tags: {},
    } as any];
    expect(ruleVpnStaticRoutesOnly(t).recommendation).toBeNull();
  });

  it('warns for a static-routes-only VPN', () => {
    const t = makeEmptyTopology();
    t.vpnConnections = [{
      vpnConnectionId: 'vpn-static', customerGatewayId: 'cgw-1', tunnels: [], staticRoutesOnly: true, tags: {},
    } as any];
    const result = ruleVpnStaticRoutesOnly(t);
    expect(result.recommendation!.severity).toBe('warning');
    expect(result.recommendation!.description).toContain('vpn-static');
  });

  it('calls out the DX-backup implication when DX is present', () => {
    const t = makeEmptyTopology();
    t.connections = [{ connectionId: 'c1', tags: {} } as any];
    t.vpnConnections = [{
      vpnConnectionId: 'vpn-static', customerGatewayId: 'cgw-1', tunnels: [], staticRoutesOnly: true, tags: {},
    } as any];
    const result = ruleVpnStaticRoutesOnly(t);
    expect(result.recommendation!.description).toContain('not a working backup');
  });
});

describe('ruleCgwRedundancy', () => {
  it('returns no recommendation without VPN connections', () => {
    expect(ruleCgwRedundancy(makeEmptyTopology()).recommendation).toBeNull();
  });

  it('fires when all VPNs share the same CGW', () => {
    const t = makeEmptyTopology();
    t.vpnConnections = [
      { vpnConnectionId: 'vpn-1', customerGatewayId: 'cgw-1', tunnels: [], tags: {} } as any,
      { vpnConnectionId: 'vpn-2', customerGatewayId: 'cgw-1', tunnels: [], tags: {} } as any,
    ];
    const result = ruleCgwRedundancy(t);
    expect(result.recommendation).not.toBeNull();
    expect(result.recommendation!.severity).toBe('warning');
  });

  it('returns no recommendation when 2+ CGWs are used', () => {
    const t = makeEmptyTopology();
    t.vpnConnections = [
      { vpnConnectionId: 'vpn-1', customerGatewayId: 'cgw-1', tunnels: [], tags: {} } as any,
      { vpnConnectionId: 'vpn-2', customerGatewayId: 'cgw-2', tunnels: [], tags: {} } as any,
    ];
    expect(ruleCgwRedundancy(t).recommendation).toBeNull();
  });
});

describe('ruleDxPartnerDiversity', () => {
  it('returns no recommendation with fewer than 2 connections', () => {
    const t = makeEmptyTopology();
    t.connections = [{ connectionId: 'c1', partnerName: 'Equinix', tags: {} } as any];
    expect(ruleDxPartnerDiversity(t).recommendation).toBeNull();
  });

  it('stays silent when no partner names are populated', () => {
    const t = makeEmptyTopology();
    t.connections = [
      { connectionId: 'c1', tags: {} } as any,
      { connectionId: 'c2', tags: {} } as any,
    ];
    expect(ruleDxPartnerDiversity(t).recommendation).toBeNull();
  });

  it('fires when all connections share a partner', () => {
    const t = makeEmptyTopology();
    t.connections = [
      { connectionId: 'c1', partnerName: 'Equinix', tags: {} } as any,
      { connectionId: 'c2', partnerName: 'Equinix', tags: {} } as any,
    ];
    const result = ruleDxPartnerDiversity(t);
    expect(result.recommendation).not.toBeNull();
    expect(result.recommendation!.description).toContain('Equinix');
  });

  it('names the real alternate providers at the occupied location', () => {
    const t = makeEmptyTopology();
    t.connections = [
      { connectionId: 'c1', partnerName: 'Equinix', location: 'EqDC2', tags: {} } as any,
      { connectionId: 'c2', partnerName: 'Equinix', location: 'EqDC2', tags: {} } as any,
    ];
    t.locations = [
      { locationCode: 'EqDC2', locationName: 'Equinix DC2', region: 'us-east-1', availablePortSpeeds: ['1Gbps'],
        availableProviders: ['Equinix', 'Megaport', 'Lumen'] },
      // A location the customer does not occupy must not leak into the advice.
      { locationCode: 'CoreSite-NY', locationName: 'CoreSite NY', region: 'us-east-1', availablePortSpeeds: ['1Gbps'],
        availableProviders: ['ShouldNotAppear'] },
    ];
    const result = ruleDxPartnerDiversity(t);
    expect(result.recommendation!.description).toContain('Megaport');
    expect(result.recommendation!.description).toContain('Lumen');
    expect(result.recommendation!.description).not.toContain('ShouldNotAppear');
  });

  it('keeps the generic advice when the location lists no providers', () => {
    const t = makeEmptyTopology();
    t.connections = [
      { connectionId: 'c1', partnerName: 'Equinix', location: 'EqDC2', tags: {} } as any,
      { connectionId: 'c2', partnerName: 'Equinix', location: 'EqDC2', tags: {} } as any,
    ];
    t.locations = [
      { locationCode: 'EqDC2', locationName: 'Equinix DC2', region: 'us-east-1', availablePortSpeeds: ['1Gbps'] },
    ];
    const result = ruleDxPartnerDiversity(t);
    expect(result.recommendation!.description).toContain('Equinix');
    expect(result.recommendation!.description).not.toContain('Other providers available');
  });

  it('returns no recommendation when partners differ', () => {
    const t = makeEmptyTopology();
    t.connections = [
      { connectionId: 'c1', partnerName: 'Equinix', tags: {} } as any,
      { connectionId: 'c2', partnerName: 'Megaport', tags: {} } as any,
    ];
    expect(ruleDxPartnerDiversity(t).recommendation).toBeNull();
  });
});

describe('ruleVpnDpd', () => {
  it('returns no recommendation without VPN connections', () => {
    expect(ruleVpnDpd(makeEmptyTopology()).recommendation).toBeNull();
  });

  it('returns info attestation when every tunnel has a DPD action configured', () => {
    const t = makeEmptyTopology();
    t.vpnConnections = [{
      vpnConnectionId: 'vpn-1',
      customerGatewayId: 'cgw-1',
      tunnels: [
        { status: 'UP', dpdTimeoutAction: 'restart' },
        { status: 'UP', dpdTimeoutAction: 'clear' },
      ],
      tags: {},
    } as any];
    const result = ruleVpnDpd(t);
    expect(result.recommendation).not.toBeNull();
    expect(result.recommendation!.ruleId).toBe('vpn-dpd');
    expect(result.recommendation!.severity).toBe('info');
  });

  it('warns when a tunnel has DpdTimeoutAction set to none', () => {
    const t = makeEmptyTopology();
    t.vpnConnections = [{
      vpnConnectionId: 'vpn-lax',
      customerGatewayId: 'cgw-1',
      tunnels: [
        { status: 'UP', outsideIpAddress: '1.2.3.4', dpdTimeoutAction: 'none' },
        { status: 'UP', outsideIpAddress: '1.2.3.5', dpdTimeoutAction: 'restart' },
      ],
      tags: {},
    } as any];
    const result = ruleVpnDpd(t);
    expect(result.recommendation).not.toBeNull();
    expect(result.recommendation!.severity).toBe('warning');
    expect(result.recommendation!.description).toContain('vpn-lax');
    expect(result.recommendation!.description).toContain('1.2.3.4');
  });

  it('falls back to info attestation when DPD config is not yet populated', () => {
    const t = makeEmptyTopology();
    t.vpnConnections = [{
      vpnConnectionId: 'vpn-unknown',
      customerGatewayId: 'cgw-1',
      tunnels: [{ status: 'UP' }, { status: 'UP' }],
      tags: {},
    } as any];
    const result = ruleVpnDpd(t);
    expect(result.recommendation).not.toBeNull();
    expect(result.recommendation!.severity).toBe('info');
  });
});

describe('ruleDxLocationRedundancy', () => {
  it('returns no recommendation for empty topology', () => {
    expect(ruleDxLocationRedundancy(makeEmptyTopology()).recommendation).toBeNull();
  });

  it('returns info recommendation when DX exists', () => {
    const t = makeEmptyTopology();
    t.connections = [{ connectionId: 'c1', tags: {} } as any];
    const result = ruleDxLocationRedundancy(t);
    expect(result.recommendation).not.toBeNull();
    expect(result.recommendation!.description).toContain('Metro');
    expect(result.recommendation!.description).toContain('Geographic');
  });
});

describe('ruleBgpTimersFallback', () => {
  it('returns no recommendation without VIFs', () => {
    expect(ruleBgpTimersFallback(makeEmptyTopology()).recommendation).toBeNull();
  });

  it('returns info recommendation when VIFs exist', () => {
    const t = makeEmptyTopology();
    t.virtualInterfaces = [{ virtualInterfaceId: 'v1', bgpPeers: [], tags: {} } as any];
    const result = ruleBgpTimersFallback(t);
    expect(result.recommendation).not.toBeNull();
    expect(result.recommendation!.ruleId).toBe('bgp-timers-fallback');
  });
});

describe('ruleDxFailoverTesting', () => {
  it('returns no recommendation for empty topology', () => {
    expect(ruleDxFailoverTesting(makeEmptyTopology()).recommendation).toBeNull();
  });

  it('returns info recommendation when DX exists', () => {
    const t = makeEmptyTopology();
    t.connections = [{ connectionId: 'c1', tags: {} } as any];
    const result = ruleDxFailoverTesting(t);
    expect(result.recommendation).not.toBeNull();
    expect(result.recommendation!.description).toContain('72 hours');
  });
});

describe('ruleFailoverRunbooks', () => {
  it('returns no recommendation for empty topology', () => {
    expect(ruleFailoverRunbooks(makeEmptyTopology()).recommendation).toBeNull();
  });

  it('returns info recommendation when DX exists', () => {
    const t = makeEmptyTopology();
    t.connections = [{ connectionId: 'c1', tags: {} } as any];
    const result = ruleFailoverRunbooks(t);
    expect(result.recommendation).not.toBeNull();
    expect(result.recommendation!.ruleId).toBe('failover-runbooks');
  });
});

describe('getAllBestPracticeResults', () => {
  it('returns recommendations sorted by severity (critical > warning > info)', () => {
    const t = makeEmptyTopology();
    t.connections = [{ connectionId: 'c1', connectionName: 'bad', connectionState: 'down', tags: {} } as any];
    const { recommendations } = getAllBestPracticeResults(t);
    // Critical: connection-not-available. Warning: no-vpn-backup.
    // Info: bfd, sla-awareness, resiliency-toolkit, bgp-route-limit, vpn-dpd×0,
    //   dx-location-redundancy, bgp-timers-fallback×0, dx-failover-testing, failover-runbooks.
    // Only VIF-dependent info rules (consistent-prefix-advertisement, bgp-route-limit,
    //   bgp-timers-fallback) need VIFs — we have none here, so they shouldn't fire.
    const severities = recommendations.map((r) => r.severity);
    expect(severities[0]).toBe('critical');
    expect(severities).toContain('warning');
    expect(severities.filter((s) => s === 'info').length).toBeGreaterThan(0);
    // Severity order invariant
    const order = { critical: 0, warning: 1, info: 2 };
    for (let i = 1; i < severities.length; i++) {
      expect(order[severities[i]]).toBeGreaterThanOrEqual(order[severities[i - 1]]);
    }
  });

  it('returns empty for empty topology', () => {
    const { recommendations, annotations } = getAllBestPracticeResults(makeEmptyTopology());
    expect(recommendations).toHaveLength(0);
    expect(annotations).toHaveLength(0);
  });
});

describe('ruleVifRateLimitOversubscription', () => {
  const conn = (id: string, bandwidth: string) =>
    ({ connectionId: id, connectionName: id, connectionState: 'available', bandwidth, location: 'X', region: 'r', tags: {} }) as any;
  const rlVif = (id: string, connectionId: string, rateLimit?: string) =>
    ({ virtualInterfaceId: id, virtualInterfaceName: id, virtualInterfaceType: 'private',
       virtualInterfaceState: 'available', connectionId, rateLimit, bgpPeers: [], tags: {} }) as any;

  it('is silent when no VIF carries a rate limit', () => {
    const t = makeEmptyTopology();
    t.connections = [conn('dxcon-1', '1Gbps')];
    t.virtualInterfaces = [rlVif('v1', 'dxcon-1'), rlVif('v2', 'dxcon-1')];
    expect(ruleVifRateLimitOversubscription(t).recommendation).toBeNull();
  });

  it('is silent when the committed total fits inside the port', () => {
    const t = makeEmptyTopology();
    t.connections = [conn('dxcon-1', '1Gbps')];
    t.virtualInterfaces = [rlVif('v1', 'dxcon-1', '400Mbps'), rlVif('v2', 'dxcon-1', '500Mbps')];
    expect(ruleVifRateLimitOversubscription(t).recommendation).toBeNull();
  });

  it('flags a port whose VIF rate limits sum above its bandwidth', () => {
    const t = makeEmptyTopology();
    t.connections = [conn('dxcon-1', '1Gbps')];
    t.virtualInterfaces = [rlVif('v1', 'dxcon-1', '800Mbps'), rlVif('v2', 'dxcon-1', '600Mbps')];
    const rec = ruleVifRateLimitOversubscription(t).recommendation!;
    expect(rec.severity).toBe('info');
    expect(rec.description).toContain('140%');
    expect(rec.description).toContain('dxcon-1');
  });

  it('skips a port that has any uncapped VIF', () => {
    // An uncapped VIF can already use the whole port, so "committed vs port" is
    // not a meaningful comparison there.
    const t = makeEmptyTopology();
    t.connections = [conn('dxcon-1', '1Gbps')];
    t.virtualInterfaces = [rlVif('v1', 'dxcon-1', '800Mbps'), rlVif('v2', 'dxcon-1', '600Mbps'), rlVif('v3', 'dxcon-1')];
    expect(ruleVifRateLimitOversubscription(t).recommendation).toBeNull();
  });

  it('needs at least two VIFs on the port to over-subscribe it', () => {
    // AWS enforces rateLimit <= port for a single VIF, so one VIF can never
    // exceed its own port.
    const t = makeEmptyTopology();
    t.connections = [conn('dxcon-1', '1Gbps')];
    t.virtualInterfaces = [rlVif('v1', 'dxcon-1', '1Gbps')];
    expect(ruleVifRateLimitOversubscription(t).recommendation).toBeNull();
  });

  it('evaluates each connection independently', () => {
    const t = makeEmptyTopology();
    t.connections = [conn('dxcon-ok', '10Gbps'), conn('dxcon-over', '1Gbps')];
    t.virtualInterfaces = [
      rlVif('a1', 'dxcon-ok', '1Gbps'), rlVif('a2', 'dxcon-ok', '1Gbps'),
      rlVif('b1', 'dxcon-over', '900Mbps'), rlVif('b2', 'dxcon-over', '900Mbps'),
    ];
    const rec = ruleVifRateLimitOversubscription(t).recommendation!;
    expect(rec.description).toContain('dxcon-over');
    expect(rec.description).not.toContain('dxcon-ok');
  });
});
