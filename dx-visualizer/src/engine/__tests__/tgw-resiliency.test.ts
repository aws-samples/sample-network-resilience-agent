import { describe, it, expect } from 'vitest';
import { analyzeTopology, getRecommendedGraph } from '../recommendation-engine';
import { getMockTopology } from '../../utils/mock-data';
import { meetsMaximumTier, maximumTierGapLocations } from '../sla-gating';
import { makeEmptyTopology } from './helpers';
import type { TopologyData } from '../../types/topology';

/**
 * TGW-LEVEL RESILIENCY FOR TRANSIT VIFs
 * =====================================
 *
 * A transit VIF's DX gateway is only a hop: what must stay reachable is the
 * Transit Gateway. So a TGW reached over transit VIFs gets its own card, graded
 * over EVERY transit VIF reaching it across all its feeding gateways, and each
 * feeding gateway's card points at it (`assessedAtTgwIds`). Private-VIF gateways
 * are untouched — the DX gateway is still their unit.
 */

function dxgw(id: string, name = id) {
  return { directConnectGatewayId: id, directConnectGatewayName: name, amazonSideAsn: 64512, directConnectGatewayState: 'available' };
}
function tgwAssoc(dxgwId: string, tgwId: string, extra: { state?: string; region?: string; stub?: boolean } = {}) {
  return {
    directConnectGatewayId: dxgwId,
    associatedGateway: { id: tgwId, type: 'transitGateway' as const, region: extra.region ?? 'ap-southeast-1', ownerAccount: '111122223333' },
    associationState: extra.state ?? 'associated',
    allowedPrefixes: [],
    ...(extra.stub ? { isPrefixPoolStub: true } : {}),
  };
}
function vgwAssoc(dxgwId: string, vgwId: string) {
  return {
    directConnectGatewayId: dxgwId,
    associatedGateway: { id: vgwId, type: 'virtualPrivateGateway' as const, region: 'ap-southeast-1', ownerAccount: '111122223333' },
    associationState: 'associated',
    allowedPrefixes: [],
  };
}
function loc(code: string) {
  return { locationCode: code, locationName: `${code} name`, region: 'ap-southeast-1', availablePortSpeeds: [] };
}
function tgw(id: string, name: string) {
  return { transitGatewayId: id, transitGatewayArn: `arn:${id}`, state: 'available', ownerId: '111122223333', description: '', amazonSideAsn: 64513, tags: { Name: name } };
}

let n = 0;
/** One VIF of `type` for `dxgwId` on a fresh connection at `location` / `device`. */
function vifAt(t: TopologyData, dxgwId: string, location: string, device: string, type: 'transit' | 'private' = 'transit') {
  n += 1;
  const connId = `c-${n}`;
  if (!t.locations.some((l) => l.locationCode === location)) t.locations.push(loc(location));
  t.connections.push({ connectionId: connId, connectionName: connId, connectionState: 'available', location, bandwidth: '1Gbps', region: 'ap-southeast-1', awsLogicalDeviceId: device });
  t.virtualInterfaces.push({ virtualInterfaceId: `v-${n}`, virtualInterfaceName: `vif-${n}`, virtualInterfaceType: type, virtualInterfaceState: 'available', connectionId: connId, directConnectGatewayId: dxgwId, vlan: n, asn: 1, bgpPeers: [], region: 'ap-southeast-1', location });
}

const ruleIds = (recs: { ruleId: string }[]) => recs.map((r) => r.ruleId).sort();

describe('per-TGW resiliency assessment', () => {
  it('cards a TGW reached by one transit VIF and points its gateway at it', () => {
    const t = makeEmptyTopology();
    t.dxGateways = [dxgw('gwA')];
    t.transitGateways = [tgw('tgw-1', 'Core TGW')];
    t.dxGatewayAssociations = [tgwAssoc('gwA', 'tgw-1')];
    vifAt(t, 'gwA', 'LocA', 'devA1');

    const a = analyzeTopology(t, 'high');
    expect(a.perTgw).toHaveLength(1);
    const card = a.perTgw[0];
    expect(card).toMatchObject({
      tgwId: 'tgw-1', tgwName: 'Core TGW', currentLevel: 'devtest', targetLevel: 'high',
      locationCount: 1, connectionCount: 1, transitVifCount: 1, dxGatewayIds: ['gwA'],
    });
    expect(ruleIds(card.recommendations)).toEqual(['tgw-single-transit-vif']);
    expect(card.recommendations[0].description).toContain('vif-1');
    expect(a.perDxGateway[0].assessedAtTgwIds).toEqual(['tgw-1']);
  });

  it('grades two single-site gateways at different sites as one site-redundant TGW', () => {
    const t = makeEmptyTopology();
    t.dxGateways = [dxgw('gwA'), dxgw('gwB')];
    t.dxGatewayAssociations = [tgwAssoc('gwA', 'tgw-1'), tgwAssoc('gwB', 'tgw-1')];
    vifAt(t, 'gwA', 'LocA', 'devA1');
    vifAt(t, 'gwB', 'LocB', 'devB1');

    const a = analyzeTopology(t, 'high');
    const card = a.perTgw[0];
    // Each gateway alone is devtest; the TGW they jointly reach is not.
    expect(a.perDxGateway.map((g) => g.currentLevel)).toEqual(['devtest', 'devtest']);
    expect(card.currentLevel).toBe('high');
    expect(card.dxGatewayIds).toEqual(['gwA', 'gwB']);
    // High is met, so the target escalates to Maximum and the device gaps show.
    expect(card.targetLevel).toBe('maximum');
    expect(ruleIds(card.recommendations)).toEqual(['tgw-single-device-per-location', 'tgw-single-device-per-location']);
    expect(a.perDxGateway.every((g) => g.assessedAtTgwIds?.[0] === 'tgw-1')).toBe(true);
  });

  it('reaches Maximum when each of two sites has two devices into the TGW', () => {
    const t = makeEmptyTopology();
    t.dxGateways = [dxgw('gwA'), dxgw('gwB')];
    t.dxGatewayAssociations = [tgwAssoc('gwA', 'tgw-1'), tgwAssoc('gwB', 'tgw-1')];
    vifAt(t, 'gwA', 'LocA', 'devA1');
    vifAt(t, 'gwA', 'LocA', 'devA2');
    vifAt(t, 'gwB', 'LocB', 'devB1');
    vifAt(t, 'gwB', 'LocB', 'devB2');

    const card = analyzeTopology(t, 'high').perTgw[0];
    expect(card.currentLevel).toBe('maximum');
    expect(card.recommendations).toEqual([]);
  });

  it('reports one location (not one VIF) when two VIFs share a site', () => {
    const t = makeEmptyTopology();
    t.dxGateways = [dxgw('gwA')];
    t.dxGatewayAssociations = [tgwAssoc('gwA', 'tgw-1')];
    vifAt(t, 'gwA', 'LocA', 'devA1');
    vifAt(t, 'gwA', 'LocA', 'devA2');

    const card = analyzeTopology(t, 'high').perTgw[0];
    expect(card.currentLevel).toBe('devtest');
    expect(ruleIds(card.recommendations)).toEqual(['tgw-single-dx-location']);
    expect(card.recommendations[0].description).toContain('LocA name');
  });

  it('leaves device gaps to Maximum — at High one site is the whole finding', () => {
    const t = makeEmptyTopology();
    t.dxGateways = [dxgw('gwA')];
    t.dxGatewayAssociations = [tgwAssoc('gwA', 'tgw-1')];
    vifAt(t, 'gwA', 'LocA', 'devA1');
    vifAt(t, 'gwA', 'LocA', 'devA1');

    expect(ruleIds(analyzeTopology(t, 'high').perTgw[0].recommendations)).toEqual(['tgw-single-dx-location']);
    expect(ruleIds(analyzeTopology(t, 'maximum').perTgw[0].recommendations))
      .toEqual(['tgw-single-device-per-location', 'tgw-single-dx-location']);
  });

  it('does not count a VIF-less gateway sharing the TGW as a feeder', () => {
    const t = makeEmptyTopology();
    t.dxGateways = [dxgw('gwA'), dxgw('gwIdle')];
    t.dxGatewayAssociations = [tgwAssoc('gwA', 'tgw-1'), tgwAssoc('gwIdle', 'tgw-1')];
    vifAt(t, 'gwA', 'LocA', 'devA1');

    const a = analyzeTopology(t, 'high');
    expect(a.perTgw[0].dxGatewayIds).toEqual(['gwA']);
    expect(a.perDxGateway.find((g) => g.dxGatewayId === 'gwIdle')!.assessedAtTgwIds).toBeUndefined();
  });

  it('names a device gap where two connections share one device', () => {
    const t = makeEmptyTopology();
    t.dxGateways = [dxgw('gwA')];
    t.dxGatewayAssociations = [tgwAssoc('gwA', 'tgw-1')];
    vifAt(t, 'gwA', 'LocA', 'devA1');
    vifAt(t, 'gwA', 'LocA', 'devA1');
    vifAt(t, 'gwA', 'LocB', 'devB1');
    vifAt(t, 'gwA', 'LocB', 'devB2');

    const card = analyzeTopology(t, 'high').perTgw[0];
    expect(card.currentLevel).toBe('high');
    const gaps = card.recommendations.filter((r) => r.ruleId === 'tgw-single-device-per-location');
    expect(gaps).toHaveLength(1);
    expect(gaps[0].description).toContain('2 connections at LocA name terminate on one AWS logical device');
  });

  it('follows a feeder that targets Maximum', () => {
    const t = makeEmptyTopology();
    t.dxGateways = [dxgw('gwA')];
    t.dxGatewayAssociations = [tgwAssoc('gwA', 'tgw-1')];
    vifAt(t, 'gwA', 'LocA', 'devA1');
    vifAt(t, 'gwA', 'LocA', 'devA2');

    expect(analyzeTopology(t, { gwA: 'maximum' }).perTgw[0].targetLevel).toBe('maximum');
    expect(analyzeTopology(t, { gwA: 'high' }).perTgw[0].targetLevel).toBe('high');
  });

  it('cards a TGW this account cannot describe, keyed by the association', () => {
    const t = makeEmptyTopology();
    t.dxGateways = [dxgw('gwA')];
    t.dxGatewayAssociations = [tgwAssoc('gwA', 'tgw-remote', { region: 'eu-west-1' })];
    vifAt(t, 'gwA', 'LocA', 'devA1');

    const card = analyzeTopology(t, 'high').perTgw[0];
    expect(card).toMatchObject({ tgwId: 'tgw-remote', tgwName: 'tgw-remote', region: 'eu-west-1', ownerAccount: '111122223333' });
  });

  it('gives a gateway associated to two TGWs a pointer to both', () => {
    const t = makeEmptyTopology();
    t.dxGateways = [dxgw('gwA')];
    t.dxGatewayAssociations = [tgwAssoc('gwA', 'tgw-1'), tgwAssoc('gwA', 'tgw-2')];
    vifAt(t, 'gwA', 'LocA', 'devA1');

    const a = analyzeTopology(t, 'high');
    expect(a.perTgw.map((c) => c.tgwId)).toEqual(['tgw-1', 'tgw-2']);
    expect(a.perDxGateway[0].assessedAtTgwIds).toEqual(['tgw-1', 'tgw-2']);
  });

  it('grades each TGW only on its own feeders, even when gateway grouping is transitive', () => {
    // gwA reaches tgw-1 and tgw-2; gwB reaches only tgw-2. Grouping unions
    // {gwA, gwB} through tgw-2, so the group spans two sites — but tgw-1 is
    // reached from LocA alone and a LocA failure cuts it off.
    const t = makeEmptyTopology();
    t.dxGateways = [dxgw('gwA'), dxgw('gwB')];
    t.dxGatewayAssociations = [tgwAssoc('gwA', 'tgw-1'), tgwAssoc('gwA', 'tgw-2'), tgwAssoc('gwB', 'tgw-2')];
    vifAt(t, 'gwA', 'LocA', 'devA1');
    vifAt(t, 'gwA', 'LocA', 'devA2');
    vifAt(t, 'gwB', 'LocB', 'devB1');

    const a = analyzeTopology(t, 'high');
    const byId = new Map(a.perTgw.map((c) => [c.tgwId, c]));
    expect(byId.get('tgw-1')!.currentLevel).toBe('devtest');
    expect(ruleIds(byId.get('tgw-1')!.recommendations)).toEqual(['tgw-single-dx-location']);
    expect(byId.get('tgw-2')!.currentLevel).toBe('high');
  });

  describe('does not card', () => {
    it('a private-VIF gateway, which keeps its own tier', () => {
      const t = makeEmptyTopology();
      t.dxGateways = [dxgw('gwP')];
      t.dxGatewayAssociations = [vgwAssoc('gwP', 'vgw-1')];
      vifAt(t, 'gwP', 'LocA', 'devA1', 'private');

      const a = analyzeTopology(t, 'high');
      expect(a.perTgw).toEqual([]);
      expect(a.perDxGateway[0].assessedAtTgwIds).toBeUndefined();
    });

    it('a TGW whose gateway has no transit VIF', () => {
      const t = makeEmptyTopology();
      t.dxGateways = [dxgw('gwA')];
      t.dxGatewayAssociations = [tgwAssoc('gwA', 'tgw-1')];
      expect(analyzeTopology(t, 'high').perTgw).toEqual([]);
    });

    it('a prefix-pool stub, which has no TGW id to key on', () => {
      const t = makeEmptyTopology();
      t.dxGateways = [dxgw('gwA')];
      t.dxGatewayAssociations = [tgwAssoc('gwA', '', { stub: true })];
      vifAt(t, 'gwA', 'LocA', 'devA1');
      expect(analyzeTopology(t, 'high').perTgw).toEqual([]);
    });

    it('a disassociated TGW', () => {
      const t = makeEmptyTopology();
      t.dxGateways = [dxgw('gwA')];
      t.dxGatewayAssociations = [tgwAssoc('gwA', 'tgw-1', { state: 'disassociated' })];
      vifAt(t, 'gwA', 'LocA', 'devA1');
      const a = analyzeTopology(t, 'high');
      expect(a.perTgw).toEqual([]);
      expect(a.perDxGateway[0].assessedAtTgwIds).toBeUndefined();
    });
  });

  it('keeps TGW findings out of the aggregated view and off the canvas', () => {
    const t = makeEmptyTopology();
    t.dxGateways = [dxgw('gwA')];
    t.dxGatewayAssociations = [tgwAssoc('gwA', 'tgw-1')];
    vifAt(t, 'gwA', 'LocA', 'devA1');

    const a = analyzeTopology(t, 'maximum');
    const tgwRecs = a.perTgw.flatMap((c) => c.recommendations);
    expect(tgwRecs.length).toBeGreaterThan(0);
    expect(tgwRecs.every((r) => r.additionalNodes.length === 0 && r.additionalEdges.length === 0)).toBe(true);
    expect(a.resiliency.recommendations.some((r) => r.ruleId.startsWith('tgw-'))).toBe(false);
    // The gateway still owns the ghost fix.
    expect(a.perDxGateway[0].recommendations.some((r) => r.ruleId === 'single-dx-location')).toBe(true);
  });
});

describe('cross-account demo: spoke D', () => {
  // The demo's only "resilient together" pair. If it stops grading this way, the
  // TGW card has nothing to show in the app.
  it('grades two Dev/Test branch gateways as one High Transit Gateway', () => {
    const a = analyzeTopology(getMockTopology('crossAccount'), 'high');
    const branch = a.perDxGateway.filter((g) => g.dxGatewayId.startsWith('dxgw-br'));
    expect(branch.map((g) => [g.currentLevel, g.assessedAtTgwIds])).toEqual([
      ['devtest', ['tgw-spoke-d']],
      ['devtest', ['tgw-spoke-d']],
    ]);
    expect(a.perTgw.find((t) => t.tgwId === 'tgw-spoke-d')).toMatchObject({
      tgwName: 'tgw-spoke-d', currentLevel: 'high', locationCount: 2, transitVifCount: 2,
      dxGatewayIds: ['dxgw-brsg01', 'dxgw-brty01'],
    });
    // The pair already spans two sites, so no second location is drawn for either.
    const ghostsIntoBranch = getRecommendedGraph(a).edges.filter((e) => e.target.startsWith('dxgw-dxgw-br'));
    expect(ghostsIntoBranch).toEqual([]);
  });
});

describe('focusing a TGW', () => {
  // Transit gateways have no card in the panel, so the TGW card's tier pick is
  // what asks for their fixes: it must draw every feeder's ghosts, and only theirs.
  it("draws the feeding gateways' ghosts and no other gateway's", () => {
    const t = getMockTopology('crossAccount');
    const a = analyzeTopology(t, { 'dxgw-brsg01': 'maximum', 'dxgw-brty01': 'maximum', 'dxgw-hub01': 'maximum' });
    const sinks = (focus: string) => new Set(
      getRecommendedGraph(a, focus).edges.map((e) => e.target).filter((id) => id.startsWith('dxgw-') || id === 'pub-endpoints'),
    );
    expect(sinks('tgw-spoke-d')).toEqual(new Set(['dxgw-dxgw-brsg01', 'dxgw-dxgw-brty01']));
    expect(sinks('tgw-hub01')).toEqual(new Set(['dxgw-dxgw-hub01']));
  });
});

describe('Maximum is two device-redundant locations (the DX SLA)', () => {
  // "at least four Connections ... across a minimum of two Direct Connect locations
  // (where no fewer than two Connections are deployed in each of the two ...)" —
  // a third, single-device location does not disqualify the tier.
  it('counts locations with two or more devices, not every location', () => {
    expect(meetsMaximumTier([2, 2, 1])).toBe(true);
    expect(meetsMaximumTier([2, 1, 1])).toBe(false);
    expect(meetsMaximumTier([3])).toBe(false);
  });

  it('names only the fewest locations that close the gap', () => {
    expect(maximumTierGapLocations(new Map([['A', 2], ['B', 2], ['C', 1]]))).toEqual([]);
    expect(maximumTierGapLocations(new Map([['A', 2], ['B', 1], ['C', 1]]))).toEqual(['B']);
    expect(maximumTierGapLocations(new Map([['A', 1], ['B', 1], ['C', 1]]))).toEqual(['A', 'B']);
    // A location already redundant for the group counts toward the two.
    expect(maximumTierGapLocations(new Map([['A', 2], ['B', 1]]), new Set(['B']))).toEqual([]);
  });

  it("grades the live tgw02 shape (ATTC1 x2, EqTY2 x2, KDOS2 x1) Maximum with no device gap", () => {
    const t = makeEmptyTopology();
    t.dxGateways = [dxgw('gw01'), dxgw('gw04')];
    t.dxGatewayAssociations = [tgwAssoc('gw01', 'tgw-02'), tgwAssoc('gw04', 'tgw-02')];
    vifAt(t, 'gw01', 'ATTC1', 'attc-a');
    vifAt(t, 'gw01', 'ATTC1', 'attc-b');
    vifAt(t, 'gw01', 'EqTY2', 'ty-a');
    vifAt(t, 'gw01', 'EqTY2', 'ty-b');
    vifAt(t, 'gw04', 'ATTC1', 'attc-a');
    vifAt(t, 'gw04', 'KDOS2', 'kd-a');

    const a = analyzeTopology(t, 'maximum');
    const card = a.perTgw[0];
    expect(card.currentLevel).toBe('maximum');
    expect(card.recommendations).toEqual([]);
    // gw01 alone also meets it, so it gets no device-gap ghost either.
    expect(a.perDxGateway.find((g) => g.dxGatewayId === 'gw01')!.currentLevel).toBe('maximum');
  });
});

describe('TGW Maximum pick draws the device gaps of THIS TGW', () => {
  // The live-account shape: gwB feeds tgw-alone by itself (ATTC1 + KDOS2, one
  // device each) and tgw-shared together with gwA (two devices at ATTC1 and at
  // EqTY2). gwA's second ATTC1 device covers ATTC1 for the shared-downstream
  // group — but gwA does not reach tgw-alone, so for tgw-alone ATTC1 is still on
  // one device. The card said "ATTC1 and KDOS2"; the canvas drew KDOS2 only.
  function estate() {
    const t = makeEmptyTopology();
    t.dxGateways.push(dxgw('gwA'), dxgw('gwB'));
    t.transitGateways.push(tgw('tgw-alone', 'alone'), tgw('tgw-shared', 'shared'));
    t.dxGatewayAssociations.push(tgwAssoc('gwB', 'tgw-alone'), tgwAssoc('gwB', 'tgw-shared'), tgwAssoc('gwA', 'tgw-shared'));
    vifAt(t, 'gwA', 'ATTC1', 'ATTC1-a'); vifAt(t, 'gwA', 'ATTC1', 'ATTC1-b');
    vifAt(t, 'gwA', 'EqTY2', 'EqTY2-a'); vifAt(t, 'gwA', 'EqTY2', 'EqTY2-b');
    vifAt(t, 'gwB', 'ATTC1', 'ATTC1-a'); vifAt(t, 'gwB', 'KDOS2', 'KDOS2-a');
    return t;
  }
  const ghostDeviceLocations = (nodes: { data: { category: string; details?: Record<string, unknown> } }[]) =>
    nodes.filter((nd) => nd.data.category === 'awsDevice').map((nd) => String(nd.data.details?.locationCode)).sort();

  it('draws a ghost at every location the card names', () => {
    const t = estate();
    const base = analyzeTopology(t);
    const alone = base.perTgw.find((x) => x.tgwId === 'tgw-alone')!;
    expect(alone.currentLevel).toBe('high');
    const a = analyzeTopology(t, Object.fromEntries(alone.dxGatewayIds.map((id) => [id, 'maximum' as const])));
    const g = getRecommendedGraph(a, 'tgw-alone');
    // Same gap set the card's text is graded from.
    const named = maximumTierGapLocations(new Map([['ATTC1', 1], ['KDOS2', 1]])).sort();
    expect(ghostDeviceLocations(g.nodes)).toEqual(named);
    expect(named).toEqual(['ATTC1', 'KDOS2']);
    // Every ghost device plugs into the TGW's own feeder.
    expect(g.edges.filter((e) => e.target.startsWith('dxgw-')).every((e) => e.target === 'dxgw-gwB')).toBe(true);
  });

  it('draws nothing for a TGW already at Maximum', () => {
    const t = estate();
    const a = analyzeTopology(t, { gwA: 'maximum', gwB: 'maximum' });
    expect(a.perTgw.find((x) => x.tgwId === 'tgw-shared')!.currentLevel).toBe('maximum');
    expect(ghostDeviceLocations(getRecommendedGraph(a, 'tgw-shared').nodes)).toEqual([]);
  });

  it('view-all (no focus) draws the same TGW gaps, without doubling a covered site', () => {
    const t = estate();
    const a = analyzeTopology(t, { gwA: 'maximum', gwB: 'maximum' });
    const g = getRecommendedGraph(a, null);
    const onGwB = g.nodes.filter((nd) => nd.data.category === 'awsDevice'
      && g.edges.some((e) => e.source === nd.id && e.target === 'dxgw-gwB'));
    // tgw-alone needs a second device at ATTC1 and at KDOS2, both on gwB.
    expect(ghostDeviceLocations(onGwB)).toEqual(['ATTC1', 'KDOS2']);
    // No location gets two ghost devices on the same gateway.
    const keys = onGwB.map((nd) => String(nd.data.details?.locationCode));
    expect(new Set(keys).size).toBe(keys.length);
  });
});
