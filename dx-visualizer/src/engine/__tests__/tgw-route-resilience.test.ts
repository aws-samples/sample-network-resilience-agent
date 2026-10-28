import { describe, it, expect } from 'vitest';
import { computeDxgwRouteDiff } from '../vif-route-diff';
import { gradePrefix, activeViaForPrefix, isBelowHigh, tgwRejectedCopies, assessTgwRouteResilience } from '../tgw-route-resilience';
import { getMockTopology } from '../../utils/mock-data';
import { makeEmptyTopology } from './helpers';
import type { TopologyData } from '../../types/topology';
import type { TgwRouteTableWithRoutes, VifRoute } from '../../types/aws-resources';

/**
 * Per-prefix grading across every transit VIF reaching a TGW. Built on
 * `computeDxgwRouteDiff` over a SET of gateways, so these fixtures are two DX
 * gateways feeding one TGW, each VIF accepting a chosen list of prefixes.
 */

const route = (cidr: string): VifRoute => ({
  cidr, addressFamily: 'ipv4', asPath: [{ pathType: 'seq', path: [65000] }], communities: [], routeDirection: 'accepted',
});

let n = 0;
function vif(t: TopologyData, dxgwId: string, location: string | undefined, device: string | undefined, prefixes: string[]) {
  n += 1;
  const connId = `c-${n}`;
  t.connections.push({ connectionId: connId, connectionName: connId, connectionState: 'available', location: location ?? '', bandwidth: '1Gbps', region: 'r', awsLogicalDeviceId: device });
  t.virtualInterfaces.push({ virtualInterfaceId: `v-${n}`, virtualInterfaceName: `vif-${n}`, virtualInterfaceType: 'transit', virtualInterfaceState: 'available', connectionId: connId, directConnectGatewayId: dxgwId, vlan: n, asn: 1, bgpPeers: [], region: 'r', location, awsLogicalDeviceId: device });
  t.vifRoutes!.set(`v-${n}`, { accepted: prefixes.map(route), advertised: [] });
}

/** Grade of each prefix, over both gateways. */
function grades(build: (t: TopologyData) => void): Record<string, string> {
  const t = makeEmptyTopology();
  t.vifRoutes = new Map();
  build(t);
  const diff = computeDxgwRouteDiff(t, new Set(['gwA', 'gwB']))!;
  return Object.fromEntries(diff.rows.map((row) => [row.cidr, gradePrefix(row, diff.vifs)]));
}

describe('gradePrefix', () => {
  it('grades each failure domain a prefix depends on', () => {
    expect(grades((t) => {
      vif(t, 'gwA', 'LocA', 'a1', ['10.0.1.0/24', '10.0.2.0/24', '10.0.3.0/24', '10.0.4.0/24']);
      vif(t, 'gwA', 'LocA', 'a1', ['10.0.2.0/24']); // same device as the first
      vif(t, 'gwA', 'LocA', 'a2', ['10.0.3.0/24']); // same site, other device
      vif(t, 'gwB', 'LocB', 'b1', ['10.0.4.0/24', '10.0.5.0/24']);
    })).toEqual({
      '10.0.1.0/24': 'none',
      '10.0.2.0/24': 'device',
      '10.0.3.0/24': 'site',
      '10.0.4.0/24': 'high',
      '10.0.5.0/24': 'none',
    });
  });

  it('reaches maximum only with two devices at every site', () => {
    expect(grades((t) => {
      vif(t, 'gwA', 'LocA', 'a1', ['10.1.0.0/16']);
      vif(t, 'gwA', 'LocA', 'a2', ['10.1.0.0/16']);
      vif(t, 'gwB', 'LocB', 'b1', ['10.1.0.0/16']);
      vif(t, 'gwB', 'LocB', 'b2', ['10.1.0.0/16']);
    })['10.1.0.0/16']).toBe('maximum');
  });

  it('counts a covering route as a carrier and a fragment as partial', () => {
    expect(grades((t) => {
      vif(t, 'gwA', 'LocA', 'a1', ['10.2.0.0/24', '10.3.0.0/16']);
      vif(t, 'gwB', 'LocB', 'b1', ['10.2.0.0/16', '10.3.1.0/24']);
    })).toMatchObject({
      '10.2.0.0/24': 'high', // gwB covers it via the /16
      '10.3.0.0/16': 'partial', // gwB only carries a /24 inside it
    });
  });

  it('will not confirm a grade it cannot resolve', () => {
    expect(grades((t) => {
      vif(t, 'gwA', 'LocA', 'a1', ['10.4.0.0/16']);
      vif(t, 'gwB', undefined, undefined, ['10.4.0.0/16']);
    })['10.4.0.0/16']).toBe('unknown');
  });

  it('treats only the sub-High grades as below High', () => {
    expect(['rejected', 'none', 'partial', 'device', 'site', 'high', 'maximum', 'unknown'].filter((g) => isBelowHigh(g as never)))
      .toEqual(['rejected', 'none', 'partial', 'device', 'site']);
  });
});

describe('activeViaForPrefix', () => {
  const table = (routes: TgwRouteTableWithRoutes['routes']): TgwRouteTableWithRoutes =>
    ({ routeTable: { transitGatewayRouteTableId: `rt-${routes.length}` }, routes } as TgwRouteTableWithRoutes);
  const dxRoute = (cidr: string, dxgwId: string, state: 'active' | 'blackhole' = 'active') => ({
    destinationCidrBlock: cidr,
    transitGatewayAttachments: [{ transitGatewayAttachmentId: `att-${dxgwId}`, resourceType: 'direct-connect-gateway', resourceId: dxgwId }],
    type: 'propagated' as const,
    state,
  });

  it('is unknown without route tables', () => {
    expect(activeViaForPrefix(undefined, '10.0.0.0/16')).toEqual({ state: 'unknown' });
    expect(activeViaForPrefix([], '10.0.0.0/16')).toEqual({ state: 'unknown' });
  });

  it('names the DX gateway the TGW forwards to, across tables', () => {
    const via = activeViaForPrefix([table([dxRoute('10.0.0.0/16', 'gwA')]), table([])], '10.0.0.0/16');
    expect(via).toMatchObject({ state: 'found', dxGatewayIds: ['gwA'], foundIn: 1, tableCount: 2, blackhole: false });
  });

  it('matches the exact prefix only — a covering aggregate is a different route', () => {
    expect(activeViaForPrefix([table([dxRoute('10.0.0.0/8', 'gwA')])], '10.0.0.0/16'))
      .toEqual({ state: 'missing', tableCount: 1 });
  });

  it('does not call a prefix missing when a table came back truncated', () => {
    const truncated = { ...table([dxRoute('10.0.0.0/16', 'gwA')]), routesTruncated: true };
    expect(activeViaForPrefix([truncated], '10.5.0.0/16')).toEqual({ state: 'unknown' });
  });

  it('reports a non-DX attachment and a blackhole', () => {
    const vpn = {
      destinationCidrBlock: '10.9.0.0/16',
      transitGatewayAttachments: [{ transitGatewayAttachmentId: 'att-vpn', resourceType: 'vpn', resourceId: 'vpn-1' }],
      type: 'static' as const,
      state: 'active' as const,
    };
    expect(activeViaForPrefix([table([vpn])], '10.9.0.0/16')).toMatchObject({
      state: 'found', dxGatewayIds: [], other: [{ resourceType: 'vpn', resourceId: 'vpn-1', type: 'static' }],
    });
    expect(activeViaForPrefix([table([dxRoute('10.8.0.0/16', 'gwA', 'blackhole')])], '10.8.0.0/16'))
      .toMatchObject({ state: 'found', blackhole: true });
  });
});

describe('AS-loop rejection', () => {
  // The live case behind this: on-prem reused AS 65003, the TGW's own ASN, so the
  // TGW discarded every copy that had passed through it.
  const TGW_ASN = 65003;
  const withPath = (cidr: string, path: number[]): VifRoute => ({
    cidr, addressFamily: 'ipv4', asPath: [{ pathType: 'seq', path }], communities: [], routeDirection: 'accepted',
  });
  function setup(copies: { gw: string; loc: string; dev: string; routes: VifRoute[] }[]) {
    const t = makeEmptyTopology();
    t.vifRoutes = new Map();
    t.transitGateways = [{ transitGatewayId: 'tgw-1', transitGatewayArn: '', state: 'available', ownerId: '', description: '', amazonSideAsn: TGW_ASN, tags: {} }];
    for (const c of copies) {
      vif(t, c.gw, c.loc, c.dev, []);
      t.vifRoutes.set(`v-${n}`, { accepted: c.routes, advertised: [] });
    }
    return t;
  }
  // `null` for "ASN unknown": an explicit `undefined` would take the default.
  const gradeOf = (t: TopologyData, cidr: string, asn: number | null = TGW_ASN) => {
    const diff = computeDxgwRouteDiff(t, new Set(['gwA', 'gwB']))!;
    return gradePrefix(diff.rows.find((r) => r.cidr === cidr)!, diff.vifs, tgwRejectedCopies(t, asn ?? undefined));
  };

  it('grades a prefix rejected on every VIF as rejected, not redundant', () => {
    const t = setup([
      { gw: 'gwA', loc: 'TY2', dev: 'a', routes: [withPath('1.1.1.1/32', [65005, 65003, 65001])] },
      { gw: 'gwB', loc: 'OSA', dev: 'b', routes: [withPath('1.1.1.1/32', [65006, 65003, 65001])] },
    ]);
    expect(gradeOf(t, '1.1.1.1/32')).toBe('rejected');
    // Without the TGW's ASN the check cannot run, and the prefix reads as it would.
    expect(gradeOf(t, '1.1.1.1/32', null)).toBe('high');
  });

  it('counts only the usable copies', () => {
    const t = setup([
      { gw: 'gwA', loc: 'TY2', dev: 'a', routes: [withPath('2.2.2.2/32', [65005, 65003])] },
      { gw: 'gwB', loc: 'OSA', dev: 'b', routes: [withPath('2.2.2.2/32', [65006, 65002])] },
    ]);
    expect(gradeOf(t, '2.2.2.2/32')).toBe('none');
  });

  it('judges a covered copy by its covering route', () => {
    // gwA reaches 10.1.0.0/16 only through its /8, and that /8 is a rejected copy.
    const t = setup([
      { gw: 'gwA', loc: 'TY2', dev: 'a', routes: [withPath('10.0.0.0/8', [65005, 65003])] },
      { gw: 'gwB', loc: 'OSA', dev: 'b', routes: [withPath('10.1.0.0/16', [65006])] },
    ]);
    expect(gradeOf(t, '10.1.0.0/16')).toBe('none');
    expect(gradeOf(t, '10.1.0.0/16', null)).toBe('high');
  });
});

describe('assessTgwRouteResilience on the cross-account demo', () => {
  const t = getMockTopology('crossAccount');
  it("rejects the prefix whose path holds Hub-TGW's ASN, and leaves it out of the route table", () => {
    const a = assessTgwRouteResilience(t, 'tgw-hub01', ['dxgw-hub01'])!;
    expect(a.asn).toBe(64512);
    const row = a.rows.find((r) => r.cidr === '10.99.0.0/24')!;
    expect(row.grade).toBe('rejected');
    expect(row.via.state).toBe('missing');
    expect(a.rows[0].cidr).toBe('10.99.0.0/24'); // worst first
    expect(a.belowHigh).toBe(1);
  });
  it('cannot check a cross-account TGW, whose ASN this account cannot read', () => {
    const a = assessTgwRouteResilience(t, 'tgw-spoke-a', ['dxgw-hub01'])!;
    expect(a.asn).toBeUndefined();
    expect(a.counts.rejected).toBe(0);
  });
});

describe('live-account fixes: static routes, mismatch, foreign owner', () => {
  // The live tgw01 case: every VIF copy of 2.2.2.2/32 carried the TGW's ASN, yet
  // the TGW held it as a STATIC route to dxgw01 — so it was installed, not rejected.
  const TGW = 'tgw-1';
  const withPath = (cidr: string, path: number[]): VifRoute => ({
    cidr, addressFamily: 'ipv4', asPath: [{ pathType: 'seq', path }], communities: [], routeDirection: 'accepted',
  });
  function setup(routeType: 'static' | 'propagated' | null) {
    const t = makeEmptyTopology();
    t.vifRoutes = new Map();
    t.homeAccountId = '111111111111';
    t.transitGateways = [{ transitGatewayId: TGW, transitGatewayArn: 'arn:aws:ec2:r:111111111111:transit-gateway/tgw-1', state: 'available', ownerId: '111111111111', description: '', amazonSideAsn: 65002, tags: {} }];
    vif(t, 'gwA', 'TY2', 'a', []); t.vifRoutes.set(`v-${n}`, { accepted: [withPath('2.2.2.2/32', [65006, 65002])], advertised: [] });
    vif(t, 'gwB', 'OSA', 'b', []); t.vifRoutes.set(`v-${n}`, { accepted: [withPath('2.2.2.2/32', [65005, 65002])], advertised: [] });
    if (routeType) {
      t.tgwRouteTables = new Map([[TGW, [{
        routeTable: { transitGatewayRouteTableId: 'rt' },
        routes: [{ destinationCidrBlock: '2.2.2.2/32', type: routeType, state: 'active',
          transitGatewayAttachments: [{ transitGatewayAttachmentId: 'att-a', resourceType: 'direct-connect-gateway', resourceId: 'gwA' }] }],
      } as TgwRouteTableWithRoutes]]]);
    }
    return t;
  }
  const row = (t: TopologyData) => assessTgwRouteResilience(t, TGW, ['gwA', 'gwB'])!.rows.find((r) => r.cidr === '2.2.2.2/32')!;

  it('exempts the static target gateway from the AS-loop check', () => {
    const r = row(setup('static'));
    expect(r.grade).toBe('none'); // gwA's copy now counts; gwB's is still looped
    expect(r.via).toMatchObject({ state: 'found', staticDxGatewayIds: ['gwA'] });
    expect(r.mismatch).toBe(false);
  });

  it('flags a looped prefix the route table still holds by propagation', () => {
    const r = row(setup('propagated'));
    expect(r.grade).toBe('rejected');
    expect(r.mismatch).toBe(true);
  });

  it('names the owning account of a TGW this account cannot describe', () => {
    const t = setup(null);
    t.transitGateways = [];
    t.dxGatewayAssociations = [{
      directConnectGatewayId: 'gwA', associationState: 'associated', allowedPrefixes: [],
      associatedGateway: { id: TGW, type: 'transitGateway', region: 'r', ownerAccount: '396913707275' },
    }];
    const a = assessTgwRouteResilience(t, TGW, ['gwA', 'gwB'])!;
    expect(a.foreignOwner).toBe('396913707275');
    expect(a.asn).toBeUndefined();
  });
});
