import { describe, it, expect } from 'vitest';
import {
  acceptedByFamily,
  prefixQuotaFor,
  ruleBgpRouteLimit,
  ruleBgpPrefixChurn,
  ruleWeakestPrefixAllocation,
  ruleConnectionPrefixPoolExhausted,
} from '../bestpractice-rules';
import { makeEmptyTopology } from './helpers';
import type { TopologyData } from '../../types/topology';
import type { DxVirtualInterface, VifRoute } from '../../types/aws-resources';

const vif = (
  id: string,
  over: Partial<DxVirtualInterface> = {},
): DxVirtualInterface => ({
  virtualInterfaceId: id,
  virtualInterfaceName: id,
  virtualInterfaceType: 'private',
  virtualInterfaceState: 'available',
  connectionId: 'c1',
  directConnectGatewayId: 'dxgw-1',
  vlan: 100,
  asn: 65000,
  bgpPeers: [],
  region: 'ap-southeast-1',
  ...over,
});

const accepted = (cidrs: string[], family: 'ipv4' | 'ipv6' = 'ipv4'): VifRoute[] =>
  cidrs.map((cidr) => ({
    cidr,
    addressFamily: family,
    routeDirection: 'accepted' as const,
    asPath: [],
    communities: [],
  }));

const v4 = (count: number, second = 0): string[] =>
  Array.from({ length: count }, (_, i) => `10.${second}.${i}.0/24`);

function withRoutes(t: TopologyData, entries: Record<string, VifRoute[]>): void {
  t.vifRoutes = new Map(Object.entries(entries).map(([id, a]) => [id, { accepted: a, advertised: [] }]));
}

describe('prefixQuotaFor', () => {
  it('prefers the VIF\'s own allocation over the documented default', () => {
    expect(prefixQuotaFor(vif('v1', { prefixPool: { allocatedIpv4: 20 } }), 'ipv4'))
      .toEqual({ limit: 20, source: 'allocation' });
  });

  it('grades each address family against its own allocation', () => {
    const v = vif('v1', { prefixPool: { allocatedIpv4: 20, allocatedIpv6: 8 } });
    expect(prefixQuotaFor(v, 'ipv6').limit).toBe(8);
  });

  it('falls back to 100 per family when AWS reported no allocation', () => {
    expect(prefixQuotaFor(vif('v1'), 'ipv4')).toEqual({ limit: 100, source: 'default' });
    // Zero is not a ceiling anyone could be under — treat it as unreported.
    expect(prefixQuotaFor(vif('v1', { prefixPool: { allocatedIpv4: 0 } }), 'ipv4').source).toBe('default');
  });

  it('keeps the documented public-VIF limit, which pools do not apply to', () => {
    const v = vif('v-pub', { virtualInterfaceType: 'public', prefixPool: { allocatedIpv4: 20 } });
    expect(prefixQuotaFor(v, 'ipv4')).toEqual({ limit: 1000, source: 'public' });
  });
});

describe('acceptedByFamily', () => {
  it('counts a prefix returned on two logical devices once', () => {
    const t = makeEmptyTopology();
    // Same three prefixes, duplicated — the shape that produced "2200 of 1000".
    withRoutes(t, { v1: accepted([...v4(3), ...v4(3)]) });
    expect(acceptedByFamily(t, 'v1')).toEqual({ ipv4: 3 });
  });

  it('splits by address family and prefers routes over the metric', () => {
    const t = makeEmptyTopology();
    withRoutes(t, { v1: [...accepted(v4(4)), ...accepted(['2001:db8::/64'], 'ipv6')] });
    t.bgpPrefixMetrics = new Map([['v1', { accepted: 99 }]]);
    expect(acceptedByFamily(t, 'v1')).toEqual({ ipv4: 4, ipv6: 1 });
  });

  it('reads a pooled-only metric as IPv4 so old snapshots still score', () => {
    const t = makeEmptyTopology();
    t.bgpPrefixMetrics = new Map([['v1', { accepted: 42 }]]);
    expect(acceptedByFamily(t, 'v1')).toEqual({ ipv4: 42 });
  });

  it('returns undefined when neither source has data', () => {
    expect(acceptedByFamily(makeEmptyTopology(), 'v1')).toBeUndefined();
  });
});

describe('ruleBgpRouteLimit against the per-VIF allocation', () => {
  it('warns at 90% of a 20-prefix allocation that a fixed 100 would read as 18%', () => {
    const t = makeEmptyTopology();
    t.virtualInterfaces = [vif('v1', { prefixPool: { allocatedIpv4: 20 } })];
    withRoutes(t, { v1: accepted(v4(18)) });
    const rec = ruleBgpRouteLimit(t).recommendation!;
    expect(rec.severity).toBe('warning');
    expect(rec.description).toContain('18 accepted, allocation 20, 90%');
  });

  it('stays green on the same 18 prefixes when the allocation is the default 100', () => {
    const t = makeEmptyTopology();
    t.virtualInterfaces = [vif('v1')];
    withRoutes(t, { v1: accepted(v4(18)) });
    const rec = ruleBgpRouteLimit(t).recommendation!;
    expect(rec.ruleId).toBe('bgp-route-limit-ok');
    expect(rec.description).toContain('18 of 100');
  });

  it('is critical only at or over the ceiling, not at a fraction of it', () => {
    const t = makeEmptyTopology();
    t.virtualInterfaces = [vif('v1', { prefixPool: { allocatedIpv4: 20 } }), vif('v2', { prefixPool: { allocatedIpv4: 20 } })];
    withRoutes(t, { v1: accepted(v4(19)), v2: accepted(v4(20, 1)) });
    expect(ruleBgpRouteLimit(t).recommendation!.severity).toBe('critical');

    const under = makeEmptyTopology();
    under.virtualInterfaces = [vif('v1', { prefixPool: { allocatedIpv4: 20 } })];
    withRoutes(under, { v1: accepted(v4(19)) });
    expect(ruleBgpRouteLimit(under).recommendation!.severity).toBe('warning');
  });

  // At or over the allocation is one verdict, whatever BGP is currently doing. An
  // earlier version split it: above a *reported* allocation with the session UP was
  // reported as the two counts disagreeing (distinct routes on the wire vs the
  // pool's In use counter, which no released SDK exposes) rather than as a breach.
  // That asked the reader to reason about measurement provenance before acting on a
  // number sitting at its ceiling either way, so the rule now says the same thing in
  // both states: AWS can drive a VIF past its allocation into an idle state, so the
  // session could go down.
  describe('accepted count at or above the allocation', () => {
    const up = (id: string, allocated: number) =>
      vif(id, {
        prefixPool: { allocatedIpv4: allocated },
        bgpPeers: [{
          bgpPeerId: `${id}-p`, bgpPeerState: 'available', bgpStatus: 'up',
          asn: 65000, customerAddress: '169.254.0.1/30', amazonAddress: '169.254.0.2/30',
        }],
      });

    it('is critical above the allocation even while the session is UP', () => {
      const t = makeEmptyTopology();
      t.virtualInterfaces = [up('v1', 20)];
      withRoutes(t, { v1: accepted(v4(21)) });
      const rec = ruleBgpRouteLimit(t).recommendation!;
      expect(rec.severity).toBe('critical');
      expect(rec.title).toContain('could go down');
      expect(rec.description).toContain('21 accepted, allocation 20, 105%');
    });

    it('is critical when the session is DOWN, with the same wording', () => {
      const t = makeEmptyTopology();
      t.virtualInterfaces = [vif('v1', {
        prefixPool: { allocatedIpv4: 20 },
        bgpPeers: [{
          bgpPeerId: 'p', bgpPeerState: 'available', bgpStatus: 'down',
          asn: 65000, customerAddress: '169.254.0.1/30', amazonAddress: '169.254.0.2/30',
        }],
      })];
      withRoutes(t, { v1: accepted(v4(21)) });
      const rec = ruleBgpRouteLimit(t).recommendation!;
      expect(rec.severity).toBe('critical');
      expect(rec.description).toContain('105%');
    });

    it('is critical exactly AT the allocation, where one more prefix tears it down', () => {
      const t = makeEmptyTopology();
      t.virtualInterfaces = [up('v1', 20)];
      withRoutes(t, { v1: accepted(v4(20)) });
      const rec = ruleBgpRouteLimit(t).recommendation!;
      expect(rec.severity).toBe('critical');
      expect(rec.description).toContain('20 accepted, allocation 20, 100%');
    });

    it('is critical over the documented default when AWS reported no allocation', () => {
      const t = makeEmptyTopology();
      t.virtualInterfaces = [vif('v1', {
        bgpPeers: [{
          bgpPeerId: 'p', bgpPeerState: 'available', bgpStatus: 'up',
          asn: 65000, customerAddress: '169.254.0.1/30', amazonAddress: '169.254.0.2/30',
        }],
      })];
      withRoutes(t, { v1: accepted(v4(105)) });
      expect(ruleBgpRouteLimit(t).recommendation!.severity).toBe('critical');
    });

    it('names the merely-near sibling alongside the one over the allocation', () => {
      const t = makeEmptyTopology();
      t.virtualInterfaces = [up('v1', 20), up('v2', 20)];
      withRoutes(t, { v1: accepted(v4(21)), v2: accepted(v4(18, 1)) });
      const rec = ruleBgpRouteLimit(t).recommendation!;
      expect(rec.severity).toBe('critical');
      expect(rec.description).toContain('v1');
      expect(rec.description).toContain('v2');
      expect(rec.description).toContain('90%');
    });
  });

  it('names the allocation as the basis so the reader knows the denominator', () => {
    const t = makeEmptyTopology();
    t.virtualInterfaces = [vif('v1', { prefixPool: { allocatedIpv4: 40 } })];
    withRoutes(t, { v1: accepted(v4(12)) });
    expect(ruleBgpRouteLimit(t).recommendation!.description)
      .toContain("each VIF's allocated inbound prefix count");
  });
});

describe('ruleBgpPrefixChurn', () => {
  const churning = (over: Record<string, unknown>): TopologyData => {
    const t = makeEmptyTopology();
    t.virtualInterfaces = [vif('v1')];
    t.bgpPrefixMetrics = new Map([['v1', { accepted: 27, acceptedFloor: 19, samples: 12, ...over } as never]]);
    return t;
  };

  it('flags a count that moved across the sampled window', () => {
    const rec = ruleBgpPrefixChurn(churning({})).recommendation!;
    expect(rec.ruleId).toBe('prefix-churn');
    expect(rec.severity).toBe('warning');
    expect(rec.description).toContain('(19–27 prefixes)');
  });

  it('stays silent on a single reading, which cannot show movement', () => {
    expect(ruleBgpPrefixChurn(churning({ samples: 1 })).recommendation).toBeNull();
  });

  it('stays silent when the swing is small in both absolute and relative terms', () => {
    // 1 prefix on 27 is noise, not churn.
    expect(ruleBgpPrefixChurn(churning({ acceptedFloor: 26 })).recommendation).toBeNull();
    // 20 of 100 is a fifth of the table, so it still counts.
    expect(ruleBgpPrefixChurn(churning({ accepted: 100, acceptedFloor: 80 })).recommendation).not.toBeNull();
  });

  it('stays silent when the fold never ran (pre-fold snapshot)', () => {
    const t = makeEmptyTopology();
    t.virtualInterfaces = [vif('v1')];
    t.bgpPrefixMetrics = new Map([['v1', { accepted: 27 }]]);
    expect(ruleBgpPrefixChurn(t).recommendation).toBeNull();
  });
});

describe('ruleWeakestPrefixAllocation', () => {
  const pair = (a: number | undefined, b: number | undefined, peak = 20): TopologyData => {
    const t = makeEmptyTopology();
    t.virtualInterfaces = [
      vif('v1', a === undefined ? {} : { prefixPool: { allocatedIpv4: a } }),
      vif('v2', b === undefined ? {} : { prefixPool: { allocatedIpv4: b } }),
    ];
    withRoutes(t, { v1: accepted(v4(peak)), v2: accepted(v4(peak)) });
    return t;
  };

  it('flags the sibling whose ceiling cannot absorb the domain\'s peak', () => {
    const rec = ruleWeakestPrefixAllocation(pair(40, 24, 27)).recommendation!;
    expect(rec.ruleId).toBe('prefix-allocation-skew');
    // A negative headroom is the point of the rule, and "-3 spare" reads as a typo.
    expect(rec.description).toContain('24 IPv4 prefixes against 27 in use');
    expect(rec.description).toContain('3 short of that peak');
    expect(rec.description).not.toContain('-3 spare');
  });

  it('says "spare" while the weakest path still has headroom under 20%', () => {
    expect(ruleWeakestPrefixAllocation(pair(100, 24, 20)).recommendation!.description)
      .toContain('4 spare');
  });

  it('stays silent when the allocations match', () => {
    expect(ruleWeakestPrefixAllocation(pair(40, 40, 39)).recommendation).toBeNull();
  });

  it('stays silent when the weakest path has room to spare', () => {
    expect(ruleWeakestPrefixAllocation(pair(100, 60, 20)).recommendation).toBeNull();
  });

  it('stays silent when any sibling\'s allocation is unreported — partial coverage is unknown', () => {
    expect(ruleWeakestPrefixAllocation(pair(40, undefined, 39)).recommendation).toBeNull();
  });

  it('stays silent for a lone VIF, which is not a redundancy claim', () => {
    const t = makeEmptyTopology();
    t.virtualInterfaces = [vif('v1', { prefixPool: { allocatedIpv4: 20 } })];
    withRoutes(t, { v1: accepted(v4(19)) });
    expect(ruleWeakestPrefixAllocation(t).recommendation).toBeNull();
  });

  it('grades each routing domain separately', () => {
    const t = pair(40, 24, 27);
    t.virtualInterfaces.push(
      vif('v3', { directConnectGatewayId: 'dxgw-2', prefixPool: { allocatedIpv4: 100 } }),
      vif('v4', { directConnectGatewayId: 'dxgw-2', prefixPool: { allocatedIpv4: 100 } }),
    );
    const rec = ruleWeakestPrefixAllocation(t).recommendation!;
    expect(rec.description).toContain('dxgw-1');
    expect(rec.description).not.toContain('dxgw-2');
  });
});

describe('ruleConnectionPrefixPoolExhausted', () => {
  const conn = (over: Record<string, unknown> = {}) => ({
    connectionId: 'c1',
    connectionName: 'DX-Primary',
    connectionState: 'available',
    location: 'EqSG2',
    bandwidth: '1Gbps',
    region: 'ap-southeast-1',
    ...over,
  }) as never;

  it('flags a port with no unallocated prefixes left, naming the family', () => {
    const t = makeEmptyTopology();
    t.connections = [conn({ prefixPool: { sizeIpv4: 64, unallocatedIpv4: 0, unallocatedIpv6: 8 } })];
    const rec = ruleConnectionPrefixPoolExhausted(t).recommendation!;
    expect(rec.ruleId).toBe('prefix-pool-exhausted');
    expect(rec.description).toContain('DX-Primary at EqSG2 (IPv4)');
  });

  it('treats an unreported pool as unknown, never as zero', () => {
    const t = makeEmptyTopology();
    // Hosted connections and interconnects report nothing here by documentation.
    t.connections = [conn(), conn({ connectionId: 'c2', prefixPool: {} })];
    expect(ruleConnectionPrefixPoolExhausted(t).recommendation).toBeNull();
  });

  it('ignores connections inferred from hosted VIFs, whose pool we never saw', () => {
    const t = makeEmptyTopology();
    t.connections = [conn({ isInferred: true, prefixPool: { unallocatedIpv4: 0 } })];
    expect(ruleConnectionPrefixPoolExhausted(t).recommendation).toBeNull();
  });

  it('stays silent while capacity remains', () => {
    const t = makeEmptyTopology();
    t.connections = [conn({ prefixPool: { sizeIpv4: 64, unallocatedIpv4: 24 } })];
    expect(ruleConnectionPrefixPoolExhausted(t).recommendation).toBeNull();
  });
});
