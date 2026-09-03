import { describe, it, expect } from 'vitest';
import { compareDxGateways } from '../dxgw-compare';
import { makeEmptyTopology } from './helpers';
import type { TopologyData } from '../../types/topology';
import type { VifRoute } from '../../types/aws-resources';

/**
 * TWO-GATEWAY COMPARISON
 * ======================
 *
 * The comparison itself is arithmetic over prefix sets; the thing worth testing
 * is the guard around it. A prefix on gateway A and not on gateway B is a
 * failover gap ONLY when both gateways serve the same downstream. When they do
 * not, the same arithmetic describes two deliberately separate routing domains,
 * and reporting it as a gap sends someone to reconfigure a working router.
 *
 * So these tests pin, in order: the relationship verdict (including the hidden-
 * association case, where the honest answer is "cannot tell"), the always-
 * available allowedPrefixes diff, and the route diff's degradation when
 * ListVirtualInterfaceRoutes was never called.
 */

function route(cidr: string): VifRoute {
  return {
    cidr,
    addressFamily: cidr.includes(':') ? 'ipv6' : 'ipv4',
    asPath: [{ path: [65000], pathType: 'seq' }],
    communities: [],
    routeDirection: 'accepted',
  };
}

function gw(id: string, name: string) {
  return {
    directConnectGatewayId: id,
    directConnectGatewayName: name,
    amazonSideAsn: 64512,
    ownerAccount: '123456789012',
    directConnectGatewayState: 'available',
  } as never;
}

function tgwAssoc(dxgwId: string, tgwId: string, allowedPrefixes: string[] = []) {
  return {
    directConnectGatewayId: dxgwId,
    associatedGateway: { id: tgwId, type: 'transitGateway' as const, region: 'ap-southeast-1', ownerAccount: '123456789012' },
    associationState: 'associated',
    allowedPrefixes,
  } as never;
}

interface Opts {
  /** dxgwId → tgwId it associates to. */
  assoc?: Record<string, string>;
  /** dxgwId → allowedPrefixes on that association. */
  allowed?: Record<string, string[]>;
  /** vifId → { dxgw, accepted }. Omit `accepted` for a VIF with no route data. */
  vifs?: Record<string, { dxgw: string; accepted?: string[] }>;
  /** Add a redacted (prefix-pool stub) association to this gateway. */
  hiddenOn?: string;
  /** Skip creating the vifRoutes map entirely — nothing was ever fetched. */
  noRouteFetch?: boolean;
}

function build(opts: Opts): TopologyData {
  const t = makeEmptyTopology();
  t.dxGateways = [gw('dxgw-a', 'primary-dxgw'), gw('dxgw-b', 'secondary-dxgw')];

  t.dxGatewayAssociations = Object.entries(opts.assoc ?? {}).map(([dxgwId, tgwId]) =>
    tgwAssoc(dxgwId, tgwId, opts.allowed?.[dxgwId] ?? []),
  );
  if (opts.hiddenOn) {
    t.dxGatewayAssociations.push({
      directConnectGatewayId: opts.hiddenOn,
      associatedGateway: { id: '', type: undefined, region: '', ownerAccount: '' },
      associationState: 'associated',
      allowedPrefixes: [],
      isPrefixPoolStub: true,
    } as never);
  }

  t.virtualInterfaces = Object.entries(opts.vifs ?? {}).map(([vifId, spec]) => ({
    virtualInterfaceId: vifId,
    virtualInterfaceName: `name-${vifId}`,
    virtualInterfaceType: 'transit',
    virtualInterfaceState: 'available',
    directConnectGatewayId: spec.dxgw,
    connectionId: `dxcon-${vifId}`,
    bgpPeers: [{ bgpStatus: 'up' }],
    tags: {},
  } as never));

  if (!opts.noRouteFetch) {
    const map = new Map();
    for (const [vifId, spec] of Object.entries(opts.vifs ?? {})) {
      if (!spec.accepted) continue;
      map.set(vifId, { accepted: spec.accepted.map(route), advertised: [] });
    }
    t.vifRoutes = map;
  }
  return t;
}

const compare = (t: TopologyData) => compareDxGateways(t, 'dxgw-a', 'dxgw-b')!;

describe('compareDxGateways — relationship verdict', () => {
  it('calls gateways sharing a TGW the same routing domain', () => {
    const result = compare(build({ assoc: { 'dxgw-a': 'tgw-1', 'dxgw-b': 'tgw-1' } }));
    expect(result.relationship.verdict).toBe('same-routing-domain');
    expect(result.relationship.sharedTargets.map((x) => x.id)).toEqual(['tgw-1']);
  });

  it('calls gateways with no shared downstream independent', () => {
    const result = compare(build({ assoc: { 'dxgw-a': 'tgw-1', 'dxgw-b': 'tgw-2' } }));
    expect(result.relationship.verdict).toBe('independent');
    expect(result.relationship.sharedTargets).toEqual([]);
    // The explanation is quoted to the user, so it must carry the "not a gap"
    // point rather than leaving the model to infer it.
    expect(result.relationship.explanation).toMatch(/NOT a redundancy gap/);
  });

  it('groups gateways whose different TGWs reach the same VPC', () => {
    // The subtle case: no shared association target, but both TGWs attach the
    // same workload VPC, so losing one gateway is covered by the other.
    const t = build({ assoc: { 'dxgw-a': 'tgw-1', 'dxgw-b': 'tgw-2' } });
    t.transitGatewayAttachments = [
      { transitGatewayId: 'tgw-1', resourceType: 'vpc', resourceId: 'vpc-shared' },
      { transitGatewayId: 'tgw-2', resourceType: 'vpc', resourceId: 'vpc-shared' },
    ] as never;
    expect(compare(t).relationship.verdict).toBe('same-routing-domain');
  });

  it('reports indeterminate — never independent — when an association is hidden', () => {
    const result = compare(build({ assoc: { 'dxgw-a': 'tgw-1', 'dxgw-b': 'tgw-2' }, hiddenOn: 'dxgw-b' }));
    expect(result.relationship.verdict).toBe('indeterminate');
    expect(result.relationship.hiddenAssociations.b).toBe(1);
  });

  it('prefers a confirmed shared target over a hidden association', () => {
    // A redaction elsewhere must not downgrade evidence we do have.
    const result = compare(build({ assoc: { 'dxgw-a': 'tgw-1', 'dxgw-b': 'tgw-1' }, hiddenOn: 'dxgw-b' }));
    expect(result.relationship.verdict).toBe('same-routing-domain');
  });

  it('returns null for a gateway that is not in the topology', () => {
    expect(compareDxGateways(build({}), 'dxgw-a', 'dxgw-nope')).toBeNull();
  });
});

describe('compareDxGateways — allowedPrefixes (no fetch required)', () => {
  it('diffs the permitted lists per shared target', () => {
    const result = compare(build({
      assoc: { 'dxgw-a': 'tgw-1', 'dxgw-b': 'tgw-1' },
      allowed: { 'dxgw-a': ['10.0.0.0/16', '10.1.0.0/16'], 'dxgw-b': ['10.0.0.0/16'] },
      noRouteFetch: true,
    }));
    expect(result.allowedPrefixes.perSharedTarget).toHaveLength(1);
    const diff = result.allowedPrefixes.perSharedTarget[0].diff;
    expect(diff.onBoth).toBe(1);
    expect(diff.onlyOnA).toBe(1);
    expect(diff.onlyOnB).toBe(0);
    expect(diff.rows.find((r) => r.cidr === '10.1.0.0/16')!.onB).toBe('absent');
  });

  it('reports a narrower list on B as covered, not absent', () => {
    // A permits 10/8 and B only 10.1/16. B's prefix is INSIDE A's, so on A it is
    // covered — traffic still reaches it via the aggregate. Calling that absent
    // would claim a blackhole where a working coarser route exists.
    const result = compare(build({
      assoc: { 'dxgw-a': 'tgw-1', 'dxgw-b': 'tgw-1' },
      allowed: { 'dxgw-a': ['10.0.0.0/8'], 'dxgw-b': ['10.1.0.0/16'] },
      noRouteFetch: true,
    }));
    const diff = result.allowedPrefixes.perSharedTarget[0].diff;
    const narrow = diff.rows.find((r) => r.cidr === '10.1.0.0/16')!;
    expect(narrow.onA).toBe('covered');
    expect(narrow.viaOnA).toBe('10.0.0.0/8');
    // And the reverse direction is NOT covered: the /8 spans addresses the /16
    // cannot reach, so B only carries part of it.
    const wide = diff.rows.find((r) => r.cidr === '10.0.0.0/8')!;
    expect(wide.onB).toBe('partial');
    expect(wide.insideOnB).toEqual(['10.1.0.0/16']);
  });

  it('flags two empty permitted lists as empty rather than matching', () => {
    const result = compare(build({ assoc: { 'dxgw-a': 'tgw-1', 'dxgw-b': 'tgw-1' }, noRouteFetch: true }));
    expect(result.allowedPrefixes.empty).toBe(true);
    expect(result.allowedPrefixes.overall.total).toBe(0);
  });
});

describe('compareDxGateways — accepted routes', () => {
  it('says not-fetched when ListVirtualInterfaceRoutes was never called', () => {
    const result = compare(build({
      assoc: { 'dxgw-a': 'tgw-1', 'dxgw-b': 'tgw-1' },
      vifs: { 'dxvif-1': { dxgw: 'dxgw-a' }, 'dxvif-2': { dxgw: 'dxgw-b' } },
      noRouteFetch: true,
    }));
    expect(result.acceptedRoutes.availability.status).toBe('not-fetched');
    expect(result.acceptedRoutes.diff).toBeUndefined();
  });

  it('distinguishes a gateway with no VIFs from one whose routes were not fetched', () => {
    // The demo "maximum" scenario hits this: its non-prod gateway has zero VIFs.
    // "Carries nothing" is a fact about the gateway; "not fetched" is missing
    // data. Conflating them would let the model call unknown prefixes absent.
    const result = compare(build({
      assoc: { 'dxgw-a': 'tgw-1', 'dxgw-b': 'tgw-1' },
      vifs: { 'dxvif-1': { dxgw: 'dxgw-a', accepted: ['10.0.0.0/16'] } },
    }));
    expect(result.acceptedRoutes.availability.status).toBe('insufficient');
    const reason = (result.acceptedRoutes.availability as { reason: string }).reason;
    expect(reason).toMatch(/no virtual interfaces at all/);
    expect(reason).not.toMatch(/UNKNOWN/);
  });

  it('says insufficient — not "absent" — when only one gateway has route data', () => {
    // The dangerous failure: B's prefixes are unknown, and treating unknown as
    // absent would report every one of A's prefixes as an orphan.
    const result = compare(build({
      assoc: { 'dxgw-a': 'tgw-1', 'dxgw-b': 'tgw-1' },
      vifs: {
        'dxvif-1': { dxgw: 'dxgw-a', accepted: ['10.0.0.0/16'] },
        'dxvif-2': { dxgw: 'dxgw-b' },
      },
    }));
    expect(result.acceptedRoutes.availability.status).toBe('insufficient');
    expect(result.acceptedRoutes.diff).toBeUndefined();
  });

  it('diffs accepted prefixes across the two gateways', () => {
    const result = compare(build({
      assoc: { 'dxgw-a': 'tgw-1', 'dxgw-b': 'tgw-1' },
      vifs: {
        'dxvif-1': { dxgw: 'dxgw-a', accepted: ['10.0.0.0/16', '10.9.0.0/16'] },
        'dxvif-2': { dxgw: 'dxgw-b', accepted: ['10.0.0.0/16'] },
      },
    }));
    expect(result.acceptedRoutes.availability.status).toBe('available');
    const diff = result.acceptedRoutes.diff!;
    expect(diff.onBoth).toBe(1);
    expect(diff.onlyOnA).toBe(1);
    expect(diff.rows[0].cidr).toBe('10.9.0.0/16'); // worst first
  });

  it('treats a gateway as covering a prefix any of its VIFs carries', () => {
    // Gateway-level rollup: B's second VIF has the prefix, so B is not missing
    // it, even though B's first VIF does not.
    const result = compare(build({
      assoc: { 'dxgw-a': 'tgw-1', 'dxgw-b': 'tgw-1' },
      vifs: {
        'dxvif-1': { dxgw: 'dxgw-a', accepted: ['10.0.0.0/16'] },
        'dxvif-2': { dxgw: 'dxgw-b', accepted: ['192.168.0.0/16'] },
        'dxvif-3': { dxgw: 'dxgw-b', accepted: ['10.0.0.0/16'] },
      },
    }));
    const diff = result.acceptedRoutes.diff!;
    expect(diff.rows.find((r) => r.cidr === '10.0.0.0/16')!.onB).toBe('exact');
    expect(diff.onlyOnA).toBe(0);
    expect(diff.onlyOnB).toBe(1); // 192.168/16 is on B only
  });

  it('counts identical prefix sets as no gaps in either direction', () => {
    const result = compare(build({
      assoc: { 'dxgw-a': 'tgw-1', 'dxgw-b': 'tgw-1' },
      vifs: {
        'dxvif-1': { dxgw: 'dxgw-a', accepted: ['10.0.0.0/16', '10.1.0.0/16'] },
        'dxvif-2': { dxgw: 'dxgw-b', accepted: ['10.1.0.0/16', '10.0.0.0/16'] },
      },
    }));
    const diff = result.acceptedRoutes.diff!;
    expect(diff.onBoth).toBe(2);
    expect(diff.onlyOnA + diff.onlyOnB).toBe(0);
  });

  it('reports gateway identity including which VIFs have route data', () => {
    const result = compare(build({
      assoc: { 'dxgw-a': 'tgw-1', 'dxgw-b': 'tgw-1' },
      vifs: {
        'dxvif-1': { dxgw: 'dxgw-a', accepted: ['10.0.0.0/16'] },
        'dxvif-2': { dxgw: 'dxgw-a' },
        'dxvif-3': { dxgw: 'dxgw-b', accepted: ['10.0.0.0/16'] },
      },
    }));
    expect(result.gatewayA.name).toBe('primary-dxgw');
    expect(result.gatewayA.vifCount).toBe(2);
    expect(result.gatewayA.vifsWithRouteData).toBe(1);
  });
});
