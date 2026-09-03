import { describe, it, expect } from 'vitest';
import { computeDxgwRouteDiff, type DxgwRouteDiff } from '../vif-route-diff';
import { makeEmptyTopology } from './helpers';
import type { TopologyData } from '../../types/topology';
import type { VifRoute } from '../../types/aws-resources';

function route(cidr: string, family?: 'ipv4' | 'ipv6'): VifRoute {
  return {
    cidr,
    addressFamily: family ?? (cidr.includes(':') ? 'ipv6' : 'ipv4'),
    asPath: [{ path: [65000], pathType: 'seq' }],
    communities: [],
    routeDirection: 'accepted',
  };
}

/**
 * A gateway with `vifs` transit VIFs, each accepting the prefixes given. A VIF
 * mapped to `undefined` exists but has no route data (never fetched, or its own
 * ListVirtualInterfaceRoutes call was denied).
 */
function topologyWith(
  vifs: Record<string, string[] | undefined>,
  dxgwId = 'dxgw-1',
): TopologyData {
  const t = makeEmptyTopology();
  t.dxGateways = [{
    directConnectGatewayId: dxgwId,
    directConnectGatewayName: 'prod-dxgw',
    amazonSideAsn: 64512,
    ownerAccount: '123456789012',
    directConnectGatewayState: 'available',
  } as any];
  t.virtualInterfaces = Object.keys(vifs).map((id) => ({
    virtualInterfaceId: id,
    virtualInterfaceName: `name-${id}`,
    virtualInterfaceType: 'transit',
    virtualInterfaceState: 'available',
    directConnectGatewayId: dxgwId,
    bgpPeers: [{ bgpStatus: 'up' }],
    tags: {},
  } as any));
  const map = new Map();
  for (const [id, prefixes] of Object.entries(vifs)) {
    if (!prefixes) continue;
    map.set(id, { accepted: prefixes.map((p) => route(p)), advertised: [] });
  }
  t.vifRoutes = map;
  return t;
}

const rowFor = (diff: DxgwRouteDiff, cidr: string) => diff.rows.find((r) => r.cidr === cidr)!;

describe('computeDxgwRouteDiff', () => {
  it('returns null when no routes have been fetched at all', () => {
    const t = topologyWith({ v1: ['10.0.0.0/24'], v2: ['10.0.0.0/24'] });
    delete t.vifRoutes;
    expect(computeDxgwRouteDiff(t, 'dxgw-1')).toBeNull();
  });

  it('returns null when only one VIF on the gateway has route data', () => {
    // The other VIF exists but its route call returned nothing — there is no
    // second prefix set to compare against, so the comparison is unavailable
    // rather than clean.
    const t = topologyWith({ v1: ['10.0.0.0/24'], v2: undefined });
    expect(computeDxgwRouteDiff(t, 'dxgw-1')).toBeNull();
  });

  it('returns null for a gateway with a single VIF', () => {
    const t = topologyWith({ v1: ['10.0.0.0/24'] });
    expect(computeDxgwRouteDiff(t, 'dxgw-1')).toBeNull();
  });

  it('builds one row per distinct prefix and one cell per VIF', () => {
    // The union, not one VIF's list: 10.9.9.0/24 is only on v1 and must still be
    // a row, and every row carries a cell for every VIF including its owners.
    const t = topologyWith({
      v1: ['10.0.0.0/24', '10.9.9.0/24'],
      v2: ['10.0.0.0/24'],
      v3: ['10.0.0.0/24'],
    });
    const diff = computeDxgwRouteDiff(t, 'dxgw-1')!;
    expect(diff.rows.map((r) => r.cidr)).toEqual(['10.0.0.0/24', '10.9.9.0/24']);
    for (const row of diff.rows) {
      expect(row.cells.size).toBe(3);
      expect([...row.cells.keys()].sort()).toEqual(['v1', 'v2', 'v3']);
    }
    // A VIF's own column reads as an exact match — the table shows who carries
    // the prefix, not just who is missing it.
    expect(rowFor(diff, '10.9.9.0/24').cells.get('v1')).toEqual({ state: 'exact' });
  });

  it('marks a prefix on every VIF as redundant', () => {
    const t = topologyWith({
      v1: ['10.0.0.0/24', '10.0.1.0/24'],
      v2: ['10.0.0.0/24', '10.0.1.0/24'],
    });
    const diff = computeDxgwRouteDiff(t, 'dxgw-1')!;
    expect(diff.totalSolo).toBe(0);
    expect(diff.totalLoose).toBe(0);
    expect(diff.totalPartial).toBe(0);
    expect(diff.rows).toHaveLength(2);
    expect(diff.rows.every((row) => row.verdict === 'redundant')).toBe(true);
    expect(diff.rows.every((row) => row.exactCount === 2)).toBe(true);
  });

  it('flags a prefix carried by only one VIF as solo', () => {
    const t = topologyWith({
      v1: ['10.0.0.0/24', '10.9.9.0/24'],
      v2: ['10.0.0.0/24'],
    });
    const diff = computeDxgwRouteDiff(t, 'dxgw-1')!;
    expect(diff.totalSolo).toBe(1);
    const solo = rowFor(diff, '10.9.9.0/24');
    expect(solo.verdict).toBe('solo');
    expect(solo.owners).toEqual(['v1']);
    expect(solo.cells.get('v2')).toEqual({ state: 'absent' });
    // The gap is attributed to the VIF that carries it alone, which is the tab
    // that can list it.
    expect(diff.byVif.get('v1')!.soloCount).toBe(1);
    expect(diff.byVif.get('v2')!.soloCount).toBe(0);
    // Tab row counts are that VIF's own prefixes, not the union.
    expect(diff.byVif.get('v1')!.rowCount).toBe(2);
    expect(diff.byVif.get('v2')!.rowCount).toBe(1);
  });

  it('counts a solo prefix once, not once per VIF that lacks it', () => {
    // Four VIFs, one prefix present on a single VIF. A per-pair count would say
    // 3; the operator has one problem, not three.
    const t = topologyWith({
      v1: ['10.0.0.0/24', '10.9.9.0/24'],
      v2: ['10.0.0.0/24'],
      v3: ['10.0.0.0/24'],
      v4: ['10.0.0.0/24'],
    });
    const diff = computeDxgwRouteDiff(t, 'dxgw-1')!;
    expect(diff.totalSolo).toBe(1);
    expect(diff.rows).toHaveLength(2);
    expect(diff.vifs).toHaveLength(4);
    // Four VIFs means four columns, on every row.
    expect(rowFor(diff, '10.9.9.0/24').cells.size).toBe(4);
  });

  it('treats a less specific prefix elsewhere as covered, not absent', () => {
    // v2 has no /24 but does have the covering /16: failover still reaches the
    // destination, just via a coarser route. Calling that "not reachable" would
    // send someone to fix a router that is already working.
    const t = topologyWith({
      v1: ['10.0.5.0/24'],
      v2: ['10.0.0.0/16'],
    });
    const diff = computeDxgwRouteDiff(t, 'dxgw-1')!;
    const row = rowFor(diff, '10.0.5.0/24');
    expect(row.cells.get('v2')).toEqual({ state: 'covered', via: '10.0.0.0/16' });
    expect(row.verdict).toBe('covered');
    expect(diff.byVif.get('v1')!.looseCount).toBe(1);
    // The relation is not symmetric, and it should not be. v2's /16 spans
    // addresses (10.0.9.1) that v1's single /24 cannot reach, so the /16 is not
    // covered by the /24 — but v1 does carry a piece of it, so the gap is
    // partial rather than total.
    const aggregate = rowFor(diff, '10.0.0.0/16');
    expect(aggregate.cells.get('v1')).toEqual({ state: 'partial', inside: ['10.0.5.0/24'] });
    expect(aggregate.verdict).toBe('partial');
  });

  it('names the longest covering prefix when a VIF has several', () => {
    const t = topologyWith({
      v1: ['10.0.5.0/24'],
      v2: ['10.0.0.0/16', '10.0.4.0/22', '10.0.0.0/8'],
    });
    const diff = computeDxgwRouteDiff(t, 'dxgw-1')!;
    // /22 wins longest-prefix match on v2, so it is the route that would
    // actually carry the traffic there.
    expect(rowFor(diff, '10.0.5.0/24').cells.get('v2')).toEqual({
      state: 'covered',
      via: '10.0.4.0/22',
    });
  });

  it('reports a VIF carrying only pieces of the block as partial', () => {
    // The real shape this exists for: one VIF advertises a /16 aggregate and its
    // sibling advertises the individual /24s. Calling that "cannot reach" claims
    // traffic is blackholed when most of it still flows; calling it "covered"
    // hides that everything outside those /24s has no path.
    const t = topologyWith({
      v1: ['10.30.0.0/16'],
      v2: ['10.30.1.0/24', '10.30.2.0/24'],
    });
    const diff = computeDxgwRouteDiff(t, 'dxgw-1')!;
    const aggregate = rowFor(diff, '10.30.0.0/16');
    expect(aggregate.cells.get('v2')).toEqual({
      state: 'partial',
      inside: ['10.30.1.0/24', '10.30.2.0/24'],
    });
    expect(aggregate.verdict).toBe('partial');
    expect(diff.totalPartial).toBe(1);
    expect(diff.totalSolo).toBe(0);
    // The /24s themselves are covered whole by the aggregate on v1.
    expect(rowFor(diff, '10.30.1.0/24').verdict).toBe('covered');
    expect(diff.byVif.get('v1')!.partialCount).toBe(1);
    expect(diff.byVif.get('v2')!.looseCount).toBe(2);
  });

  it('prefers a covering route over partial pieces on the same VIF', () => {
    // v2 has both the covering /16 and a /25 inside v1's /24. Full coverage is
    // the stronger guarantee, so the cell must report that, not the fragment.
    const t = topologyWith({
      v1: ['10.0.5.0/24'],
      v2: ['10.0.0.0/16', '10.0.5.128/25'],
    });
    const diff = computeDxgwRouteDiff(t, 'dxgw-1')!;
    const row = rowFor(diff, '10.0.5.0/24');
    expect(row.cells.get('v2')).toEqual({ state: 'covered', via: '10.0.0.0/16' });
    expect(row.verdict).toBe('covered');
    expect(row.partialCount).toBe(0);
    // The /16 is a row in its own right and IS partial — v1's /24 is a piece of
    // it. That is a separate finding about a different prefix, not this one.
    expect(rowFor(diff, '10.0.0.0/16').verdict).toBe('partial');
  });

  it('treats a more specific prefix elsewhere as partial, not covering', () => {
    // v2 has 10.0.5.128/25 — half of v1's /24. Traffic to 10.0.5.10 would be
    // dropped on failover, so this is NOT covered; but 10.0.5.200 would still
    // arrive, so it is not absent either.
    const t = topologyWith({
      v1: ['10.0.5.0/24'],
      v2: ['10.0.5.128/25'],
    });
    const diff = computeDxgwRouteDiff(t, 'dxgw-1')!;
    const row = rowFor(diff, '10.0.5.0/24');
    expect(row.cells.get('v2')).toEqual({ state: 'partial', inside: ['10.0.5.128/25'] });
    expect(row.verdict).toBe('partial');
    // v2's /25 is fully inside v1's /24, so its own row is covered, not solo.
    expect(rowFor(diff, '10.0.5.128/25').verdict).toBe('covered');
    expect(diff.totalSolo).toBe(0);
  });

  it('is solo only when no VIF reaches any part of the prefix', () => {
    // v2 covers part of the /16 and v3 nothing at all. One VIF offering partial
    // coverage is enough to keep the row out of the solo count.
    const t = topologyWith({
      v1: ['10.30.0.0/16'],
      v2: ['10.30.1.0/24'],
      v3: ['192.168.0.0/24'],
    });
    const diff = computeDxgwRouteDiff(t, 'dxgw-1')!;
    const row = rowFor(diff, '10.30.0.0/16');
    expect(row.cells.get('v2')!.state).toBe('partial');
    expect(row.cells.get('v3')!.state).toBe('absent');
    expect(row.verdict).toBe('partial');
    // v3's own prefix is reachable from nowhere else.
    expect(rowFor(diff, '192.168.0.0/24').verdict).toBe('solo');
  });

  it('does not treat a same-length non-overlapping prefix as partial', () => {
    // Equal prefix lengths that are different blocks share no addresses, so
    // neither covers nor partially covers the other.
    const t = topologyWith({
      v1: ['10.0.1.0/24'],
      v2: ['10.0.2.0/24'],
    });
    const diff = computeDxgwRouteDiff(t, 'dxgw-1')!;
    expect(rowFor(diff, '10.0.1.0/24').cells.get('v2')).toEqual({ state: 'absent' });
    expect(diff.totalSolo).toBe(2);
    expect(diff.totalPartial).toBe(0);
  });

  it('does not cross address families when looking for a covering prefix', () => {
    const t = topologyWith({
      v1: ['2001:db8:1::/48'],
      v2: ['10.0.0.0/8'],
    });
    const diff = computeDxgwRouteDiff(t, 'dxgw-1')!;
    const row = rowFor(diff, '2001:db8:1::/48');
    expect(row.cells.get('v2')).toEqual({ state: 'absent' });
    expect(row.addressFamily).toBe('ipv6');
  });

  it('ignores VIFs on other gateways', () => {
    const t = topologyWith({ v1: ['10.0.0.0/24'], v2: ['10.0.0.0/24'] });
    t.virtualInterfaces.push({
      virtualInterfaceId: 'v3',
      virtualInterfaceName: 'other-gateway-vif',
      virtualInterfaceType: 'transit',
      virtualInterfaceState: 'available',
      directConnectGatewayId: 'dxgw-2',
      bgpPeers: [{ bgpStatus: 'up' }],
      tags: {},
    } as any);
    t.vifRoutes!.set('v3', { accepted: [route('192.168.0.0/16')], advertised: [] });
    const diff = computeDxgwRouteDiff(t, 'dxgw-1')!;
    expect(diff.vifs.map((v) => v.vifId)).toEqual(['v1', 'v2']);
    // The other gateway's prefix must not appear in the union either.
    expect(diff.rows.map((r) => r.cidr)).toEqual(['10.0.0.0/24']);
  });

  it('excludes public VIFs, which have no gateway to be redundant on', () => {
    const t = topologyWith({ v1: ['10.0.0.0/24'], v2: ['10.0.0.0/24'] });
    t.virtualInterfaces.push({
      virtualInterfaceId: 'pub1',
      virtualInterfaceName: 'public-vif',
      virtualInterfaceType: 'public',
      virtualInterfaceState: 'available',
      bgpPeers: [{ bgpStatus: 'up' }],
      tags: {},
    } as any);
    t.vifRoutes!.set('pub1', { accepted: [route('203.0.113.0/24')], advertised: [] });
    const diff = computeDxgwRouteDiff(t, 'dxgw-1')!;
    expect(diff.vifs.map((v) => v.vifId)).toEqual(['v1', 'v2']);
    expect(diff.rows.map((r) => r.cidr)).toEqual(['10.0.0.0/24']);
  });

  it('deduplicates a prefix repeated on one VIF', () => {
    const t = topologyWith({ v1: ['10.0.0.0/24'], v2: ['10.0.0.0/24'] });
    t.vifRoutes!.set('v1', {
      accepted: [route('10.0.0.0/24'), route('10.0.0.0/24')],
      advertised: [],
    });
    const diff = computeDxgwRouteDiff(t, 'dxgw-1')!;
    expect(diff.rows).toHaveLength(1);
    expect(diff.rows[0].owners).toEqual(['v1', 'v2']);
  });

  it('numbers VIFs from 1 in the order they are listed', () => {
    const t = topologyWith({ v1: ['10.0.0.0/24'], v2: ['10.0.0.0/24'], v3: ['10.0.0.0/24'] });
    const diff = computeDxgwRouteDiff(t, 'dxgw-1')!;
    expect(diff.vifs.map((v) => v.index)).toEqual([1, 2, 3]);
    expect(diff.vifs.map((v) => v.label)).toEqual(['name-v1', 'name-v2', 'name-v3']);
  });

  it('sorts rows by prefix so the matrix order is stable', () => {
    const t = topologyWith({
      v1: ['10.0.20.0/24', '10.0.3.0/24'],
      v2: ['10.0.100.0/24', '10.0.3.0/24'],
    });
    const diff = computeDxgwRouteDiff(t, 'dxgw-1')!;
    expect(diff.rows.map((r) => r.cidr)).toEqual([
      '10.0.3.0/24', '10.0.20.0/24', '10.0.100.0/24',
    ]);
  });

  it('carries the parent connection so a caller can tell VIF from connection', () => {
    // A hosted-VIF account's inferred connection is named after its VIF, so the
    // name is not enough to identify which is on screen.
    const t = topologyWith({ v1: ['10.0.0.0/24'], v2: ['10.0.0.0/24'] });
    t.virtualInterfaces[0].connectionId = 'dxcon-abc';
    const diff = computeDxgwRouteDiff(t, 'dxgw-1')!;
    expect(diff.vifs[0]).toMatchObject({ vifId: 'v1', label: 'name-v1', connectionId: 'dxcon-abc' });
  });

  describe('narrowed to a subset', () => {
    const three = () => topologyWith({
      v1: ['10.1.1.0/24', '10.9.9.0/24'],
      v2: ['10.1.1.0/24'],
      v3: ['10.3.3.0/24'],
    });

    it('compares only the VIFs in scope', () => {
      const diff = computeDxgwRouteDiff(three(), 'dxgw-1', new Set(['v1', 'v3']))!;
      expect(diff.vifs.map((v) => v.vifId)).toEqual(['v1', 'v3']);
      // v2's prefixes are out of scope entirely, so the union shrinks with it.
      expect(diff.rows.map((r) => r.cidr)).toEqual(['10.1.1.0/24', '10.3.3.0/24', '10.9.9.0/24']);
      for (const row of diff.rows) expect([...row.cells.keys()]).toEqual(['v1', 'v3']);
    });

    it('regrades a gateway-wide redundant prefix as solo inside an excluding pair', () => {
      // The whole point of narrowing: 10.1.1.0/24 survives losing v1 only because
      // v2 carries it, and v2 is not in this comparison.
      expect(rowFor(computeDxgwRouteDiff(three(), 'dxgw-1')!, '10.1.1.0/24').verdict)
        .toBe('redundant');
      const pair = computeDxgwRouteDiff(three(), 'dxgw-1', new Set(['v1', 'v3']))!;
      expect(rowFor(pair, '10.1.1.0/24').verdict).toBe('solo');
      expect(pair.totalSolo).toBe(3);
    });

    it('keeps a VIF\'s column number stable whichever subset is in scope', () => {
      // Renumbering per selection would silently redefine what "3" means between
      // two clicks.
      const diff = computeDxgwRouteDiff(three(), 'dxgw-1', new Set(['v1', 'v3']))!;
      expect(diff.vifs.map((v) => v.index)).toEqual([1, 3]);
    });

    it('applies the covered and partial states within the subset', () => {
      const t = topologyWith({
        v1: ['10.30.0.0/16'],
        v2: ['10.30.0.0/16'],
        v3: ['10.30.1.0/24'],
      });
      // Against v2 the aggregate is like-for-like redundant; against v3 only part
      // of it survives.
      expect(rowFor(computeDxgwRouteDiff(t, 'dxgw-1', new Set(['v1', 'v2']))!, '10.30.0.0/16').verdict)
        .toBe('redundant');
      const vs3 = computeDxgwRouteDiff(t, 'dxgw-1', new Set(['v1', 'v3']))!;
      expect(rowFor(vs3, '10.30.0.0/16').verdict).toBe('partial');
      expect(rowFor(vs3, '10.30.1.0/24').cells.get('v1')).toMatchObject({
        state: 'covered', via: '10.30.0.0/16',
      });
    });

    it('ignores a subset of fewer than two and compares the whole gateway', () => {
      // One pick is a partial selection, not a comparison.
      for (const scope of [new Set<string>(), new Set(['v1'])]) {
        const diff = computeDxgwRouteDiff(three(), 'dxgw-1', scope)!;
        expect(diff.vifs.map((v) => v.vifId)).toEqual(['v1', 'v2', 'v3']);
      }
    });

    it('returns null when fewer than two of the picked VIFs have route data', () => {
      const t = topologyWith({ v1: ['10.0.0.0/24'], v2: ['10.0.0.0/24'], v3: undefined });
      expect(computeDxgwRouteDiff(t, 'dxgw-1', new Set(['v1', 'v3']))).toBeNull();
    });
  });

  describe('shared fate', () => {
    /** Stamp each VIF's failure domain onto the topology the way AWS reports it. */
    function placeVifs(
      t: TopologyData,
      placement: Record<string, { device?: string; site?: string }>,
    ): TopologyData {
      for (const v of t.virtualInterfaces) {
        const p = placement[v.virtualInterfaceId];
        if (!p) continue;
        v.awsLogicalDeviceId = p.device;
        v.location = p.site;
      }
      return t;
    }

    it('flags a redundant prefix whose every carrier is on one logical device', () => {
      // Two ✓ marks, so the verdict reads safe — and one DX maintenance event on
      // EqSG2-lg1a takes both BGP sessions at once. This is the false all-clear the
      // whole feature exists to convert into a warning.
      const t = placeVifs(
        topologyWith({ v1: ['10.0.0.0/24'], v2: ['10.0.0.0/24'] }),
        { v1: { device: 'EqSG2-lg1a', site: 'EqSG2' }, v2: { device: 'EqSG2-lg1a', site: 'EqSG2' } },
      );
      const diff = computeDxgwRouteDiff(t, 'dxgw-1')!;
      const row = rowFor(diff, '10.0.0.0/24');
      expect(row.verdict).toBe('redundant');
      expect(row.fate).toEqual({ scope: 'device', id: 'EqSG2-lg1a', vifIds: ['v1', 'v2'] });
      expect(diff.totalSharedDevice).toBe(1);
      expect(diff.totalSharedSite).toBe(0);
    });

    it('reports only the tightest scope — a shared device is not also a shared site', () => {
      // A logical device sits in exactly one location, so every device finding would
      // double-report as a site finding and the counts would both be inflated.
      const t = placeVifs(
        topologyWith({ v1: ['10.0.0.0/24'], v2: ['10.0.0.0/24'] }),
        { v1: { device: 'EqSG2-lg1a', site: 'EqSG2' }, v2: { device: 'EqSG2-lg1a', site: 'EqSG2' } },
      );
      const diff = computeDxgwRouteDiff(t, 'dxgw-1')!;
      expect(diff.totalSharedDevice + diff.totalSharedSite).toBe(1);
    });

    it('falls back to a site finding when carriers are on different devices in one location', () => {
      // Survives device maintenance, not a facility failure — a real but weaker
      // finding, and a different remediation, so it must not read as `device`.
      const t = placeVifs(
        topologyWith({ v1: ['10.0.0.0/24'], v2: ['10.0.0.0/24'] }),
        { v1: { device: 'EqSG2-lg1a', site: 'EqSG2' }, v2: { device: 'EqSG2-lg1b', site: 'EqSG2' } },
      );
      const diff = computeDxgwRouteDiff(t, 'dxgw-1')!;
      expect(rowFor(diff, '10.0.0.0/24').fate).toEqual({
        scope: 'site', id: 'EqSG2', vifIds: ['v1', 'v2'],
      });
      expect(diff.totalSharedDevice).toBe(0);
      expect(diff.totalSharedSite).toBe(1);
    });

    it('leaves genuinely diverse carriers unflagged', () => {
      const t = placeVifs(
        topologyWith({ v1: ['10.0.0.0/24'], v2: ['10.0.0.0/24'] }),
        { v1: { device: 'EqSG2-lg1a', site: 'EqSG2' }, v2: { device: 'EqSY4-lg1a', site: 'EqSY4' } },
      );
      const diff = computeDxgwRouteDiff(t, 'dxgw-1')!;
      expect(rowFor(diff, '10.0.0.0/24').fate).toBeUndefined();
      expect(diff.totalSharedDevice + diff.totalSharedSite).toBe(0);
    });

    it('treats an unknown domain as unknown, never as shared', () => {
      // The fixture leaves both fields unset, which is what a mock, a v1 snapshot,
      // or an older API response looks like. Reporting "shared" here would invent a
      // blackhole out of a gap in our own data.
      const diff = computeDxgwRouteDiff(
        topologyWith({ v1: ['10.0.0.0/24'], v2: ['10.0.0.0/24'] }),
        'dxgw-1',
      )!;
      expect(rowFor(diff, '10.0.0.0/24').fate).toBeUndefined();
      expect(diff.totalSharedDevice + diff.totalSharedSite).toBe(0);
    });

    it('does not flag a solo or partial row', () => {
      // Already red on its own verdict; a second warning adds no information, and a
      // single carrier is trivially single-device.
      const t = placeVifs(
        topologyWith({ v1: ['10.0.0.0/24', '10.9.9.0/24'], v2: ['10.0.0.0/24'] }),
        { v1: { device: 'lg1a', site: 'SG2' }, v2: { device: 'lg1a', site: 'SG2' } },
      );
      const diff = computeDxgwRouteDiff(t, 'dxgw-1')!;
      expect(rowFor(diff, '10.9.9.0/24').verdict).toBe('solo');
      expect(rowFor(diff, '10.9.9.0/24').fate).toBeUndefined();
    });

    it('counts a covering peer as a carrier but a partial fragment as not', () => {
      // v2 reaches all of 10.30.1.0/24 via its /16, so it IS a surviving path and
      // its device counts. The aggregate row is `partial` from v3's fragment only,
      // so it is graded by its verdict, not by fate.
      const t = placeVifs(
        topologyWith({
          v1: ['10.30.1.0/24'],
          v2: ['10.30.0.0/16'],
          v3: ['10.30.2.0/24'],
        }),
        {
          v1: { device: 'lg1a', site: 'SG2' },
          v2: { device: 'lg1a', site: 'SG2' },
          v3: { device: 'lg9z', site: 'SY4' },
        },
      );
      const diff = computeDxgwRouteDiff(t, 'dxgw-1')!;
      const covered = rowFor(diff, '10.30.1.0/24');
      expect(covered.verdict).toBe('covered');
      // v3 carries nothing inside this /24, so it is not a carrier and does not
      // dilute the shared domain.
      expect(covered.fate).toEqual({ scope: 'device', id: 'lg1a', vifIds: ['v1', 'v2'] });
    });

    it('regrades fate when the comparison is narrowed to a subset', () => {
      // Gateway-wide the carriers span two sites, so nothing is flagged. Narrowed to
      // the two VIFs in one site, that pair genuinely shares a fate — the same
      // reason narrowing regrades the verdict.
      const t = placeVifs(
        topologyWith({ v1: ['10.0.0.0/24'], v2: ['10.0.0.0/24'], v3: ['10.0.0.0/24'] }),
        {
          v1: { device: 'lg1a', site: 'SG2' },
          v2: { device: 'lg1b', site: 'SG2' },
          v3: { device: 'lg9z', site: 'SY4' },
        },
      );
      expect(computeDxgwRouteDiff(t, 'dxgw-1')!.totalSharedSite).toBe(0);
      const pair = computeDxgwRouteDiff(t, 'dxgw-1', new Set(['v1', 'v2']))!;
      expect(rowFor(pair, '10.0.0.0/24').fate).toMatchObject({ scope: 'site', id: 'SG2' });
    });

    it('resolves the device from accepted routes when the VIF record lacks it', () => {
      // ListVirtualInterfaceRoutes stamps awsLogicalDeviceId on each route, so a VIF
      // record without the field is still placeable.
      const t = topologyWith({ v1: ['10.0.0.0/24'], v2: ['10.0.0.0/24'] });
      for (const [id, dev] of [['v1', 'lg1a'], ['v2', 'lg1a']] as const) {
        for (const rt of t.vifRoutes!.get(id)!.accepted) rt.awsLogicalDeviceId = dev;
      }
      expect(rowFor(computeDxgwRouteDiff(t, 'dxgw-1')!, '10.0.0.0/24').fate)
        .toMatchObject({ scope: 'device', id: 'lg1a' });
    });

    it('does not trust route-derived devices that disagree', () => {
      // Two devices on one VIF's routes means the VIF is not on a single device, so
      // "every carrier shares one" cannot be claimed.
      const t = topologyWith({ v1: ['10.0.0.0/24', '10.1.0.0/24'], v2: ['10.0.0.0/24'] });
      const [a, b] = t.vifRoutes!.get('v1')!.accepted;
      a.awsLogicalDeviceId = 'lg1a';
      b.awsLogicalDeviceId = 'lg1b';
      for (const rt of t.vifRoutes!.get('v2')!.accepted) rt.awsLogicalDeviceId = 'lg1a';
      expect(rowFor(computeDxgwRouteDiff(t, 'dxgw-1')!, '10.0.0.0/24').fate).toBeUndefined();
    });

    it('falls back to the parent connection for a VIF with no location', () => {
      // DescribeConnections is where the location actually lives for many accounts.
      const t = topologyWith({ v1: ['10.0.0.0/24'], v2: ['10.0.0.0/24'] });
      t.virtualInterfaces.forEach((v, i) => {
        v.connectionId = `dxcon-${i}`;
        v.awsLogicalDeviceId = `lg-${i}`;
      });
      t.connections = [
        { connectionId: 'dxcon-0', location: 'EqSG2' } as any,
        { connectionId: 'dxcon-1', location: 'EqSG2' } as any,
      ];
      expect(rowFor(computeDxgwRouteDiff(t, 'dxgw-1')!, '10.0.0.0/24').fate)
        .toMatchObject({ scope: 'site', id: 'EqSG2' });
    });
  });
});
