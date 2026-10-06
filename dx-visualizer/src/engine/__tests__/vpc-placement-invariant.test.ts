import { describe, it, expect } from 'vitest';
import { buildGraph } from '../topology-builder';
import { filterTopologyByTags, getTaggedResources } from '../tag-filter';
import { getMockTopology } from '../../utils/mock-data';
import { makeEmptyTopology } from './helpers';
import type { TopologyData } from '../../types/topology';

/**
 * A VPC attached to both a VGW and a collapsed TGW group is left out of the
 * group and drawn once as a VGW-side card. The TGW section renders first, so it
 * relies on `vgwCardVpcIds()` to PREDICT which VPCs the VGW loop will draw.
 * The two copies of that rule are kept in step by hand; if they disagree the VPC
 * is dropped from the group, never drawn as a card, and the TGW's edge points at
 * a node that does not exist — the VPC silently vanishes and no other test fails.
 *
 * These invariants catch that drift for every mock scenario and a seeded set of
 * random VGW/TGW-overlap estates, under every relevant view toggle.
 */

const R1 = 'ap-southeast-1';
const R2 = 'ap-northeast-1';
const ACCT = '111122223333';
const SEEDS = 1000;
// Was ~0.6s locally but 10.5s on CI's shared `small` runner beside 81 other
// files, tripping Vitest's 5s default; `builds()` cut it ~4x. Generous anyway,
// so only a real hang fails it.
const FUZZ_TIMEOUT_MS = 60_000;

function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function randomTopology(r: () => number): TopologyData {
  const pick = <T,>(xs: T[]): T => xs[Math.floor(r() * xs.length)];
  const t = makeEmptyTopology();
  t.homeAccountId = ACCT;
  t.locations = ['LocA', 'LocB'].map((c) => ({ locationCode: c, locationName: c, region: R1, availablePortSpeeds: [] }));

  const vpcIds = Array.from({ length: 2 + Math.floor(r() * 6) }, (_, i) => `vpc-${i}`);
  const regionOf = new Map(vpcIds.map((id) => [id, r() > 0.85 ? R2 : R1]));
  t.vpcs = vpcIds.map((id, i) => ({
    vpcId: id, cidrBlock: `10.${i}.0.0/16`, region: regionOf.get(id)!, ownerAccountId: ACCT,
    tags: { Name: id, Env: pick(['prod', 'dev']) }, state: 'available',
  }));

  const tgwCount = 1 + Math.floor(r() * 3);
  for (let i = 0; i < tgwCount; i++) {
    const region = r() > 0.85 ? R2 : R1;
    t.transitGateways.push({
      transitGatewayId: `tgw-${i}`, transitGatewayArn: `arn:aws:ec2:${region}:${ACCT}:transit-gateway/tgw-${i}`,
      state: 'available', ownerId: ACCT, description: '', amazonSideAsn: 64600 + i,
      tags: { Name: `tgw-${i}`, Env: pick(['prod', 'dev']) },
    });
    // A TGW or VGW only attaches VPCs in its own region.
    for (const id of vpcIds.filter((v) => regionOf.get(v) === region)) {
      if (r() > 0.4) {
        t.transitGatewayAttachments.push({
          transitGatewayAttachmentId: `att-${i}-${id}`, transitGatewayId: `tgw-${i}`, resourceType: 'vpc',
          resourceId: id, resourceOwnerId: ACCT, state: pick(['available', 'available', 'pending', 'deleted']),
        });
      }
    }
  }

  const vgwCount = 1 + Math.floor(r() * 3);
  const vgwRegion = new Map<string, string>();
  for (let i = 0; i < vgwCount; i++) {
    const region = r() > 0.85 ? R2 : R1;
    vgwRegion.set(`vgw-${i}`, region);
    t.vpnGateways.push({
      vpnGatewayId: `vgw-${i}`,
      vpcAttachments: vpcIds.filter((v) => regionOf.get(v) === region && r() > 0.6).map((vpcId) => ({ vpcId, state: pick(['attached', 'attached', 'detached', 'attaching']) })),
      type: 'ipsec.1', amazonSideAsn: 64512, state: pick(['available', 'available', 'pending']), tags: { Name: `vgw-${i}`, Env: pick(['prod', 'dev']) },
    });
  }

  const gwCount = 1 + Math.floor(r() * 3);
  for (let g = 0; g < gwCount; g++) {
    const gw = `gw${g}`;
    const loc = pick(['LocA', 'LocB']);
    const connId = `c-${gw}`;
    t.dxGateways.push({ directConnectGatewayId: gw, directConnectGatewayName: gw, amazonSideAsn: 64512, directConnectGatewayState: 'available' });
    t.connections.push({ connectionId: connId, connectionName: connId, connectionState: 'available', location: loc, bandwidth: '1Gbps', region: R1, awsLogicalDeviceId: `dev-${gw}` });
    t.virtualInterfaces.push({
      virtualInterfaceId: `v-${gw}`, virtualInterfaceName: `v-${gw}`, virtualInterfaceType: 'private', virtualInterfaceState: 'available',
      connectionId: connId, directConnectGatewayId: gw, vlan: g + 1, asn: 65001, bgpPeers: [], region: R1, location: loc,
    });
    const targets = [
      ...t.transitGateways.map((x) => ({ id: x.transitGatewayId, type: 'transitGateway' as const, region: x.transitGatewayArn.split(':')[3] })),
      // A VGW association's region may be missing, which sends the builder down its VPC-region fallback.
      ...t.vpnGateways.map((x) => ({ id: x.vpnGatewayId, type: 'virtualPrivateGateway' as const, region: pick([vgwRegion.get(x.vpnGatewayId), undefined]) })),
    ];
    for (const target of targets) {
      if (r() > 0.6) {
        t.dxGatewayAssociations.push({
          directConnectGatewayId: gw,
          associatedGateway: { id: target.id, type: target.type, region: target.region as string, ownerAccount: ACCT },
          associationState: 'associated', allowedPrefixes: [],
        });
      }
    }
  }

  // A VPN-attached VGW is on-path without any DX association — a separate branch in the builder.
  if (r() > 0.7) {
    t.vpnConnections.push({
      vpnConnectionId: 'vpn-1', vpnGatewayId: pick(t.vpnGateways).vpnGatewayId, customerGatewayId: 'cgw-1',
      state: 'available', type: 'ipsec.1', category: 'VPN', customerGatewayAddress: '203.0.113.1', tunnels: [], tags: {},
    });
  }
  return t;
}

interface Toggles { showNonDx: boolean; expandAll: boolean; table: boolean }

/**
 * Every toggle combination's graph. The collapsed, list-view build takes the
 * same arguments as the probe that discovers the group keys, so the probe is
 * reused as that build; and with no VPC groups the expand/table toggles have
 * nothing to act on, so all four builds would be identical and only one runs.
 */
function builds(t: TopologyData): { tg: Toggles; graph: ReturnType<typeof buildGraph> }[] {
  const out: { tg: Toggles; graph: ReturnType<typeof buildGraph> }[] = [];
  for (const showNonDx of [false, true]) {
    const nonDx = showNonDx ? new Set([R1, R2, ...t.vpcs.map((v) => v.region)]) : new Set<string>();
    const probe = buildGraph(t, new Set(), new Set(), new Map(), new Set(), new Map(), nonDx);
    out.push({ tg: { showNonDx, expandAll: false, table: false }, graph: probe });
    const keys = probe.nodes
      .filter((n) => n.data.category === 'vpcGroup')
      .map((n) => String(n.data.details?.groupKey));
    if (keys.length === 0) continue;
    for (const [expandAll, table] of [[false, true], [true, false], [true, true]]) {
      out.push({
        tg: { showNonDx, expandAll, table },
        graph: buildGraph(
          t,
          expandAll ? new Set(keys) : new Set(),
          new Set(),
          table ? new Map(keys.map((k) => [k, 'table' as const])) : new Map(),
          new Set(),
          new Map(),
          nonDx,
        ),
      });
    }
  }
  return out;
}

/** Every broken invariant, labelled so a failure names the estate and toggles. */
function violations(t: TopologyData, label: string): string[] {
  const out: string[] = [];
  for (const { tg, graph: { nodes, edges } } of builds(t)) {
    const where = `${label} ${JSON.stringify(tg)}`;
    const ids = new Set(nodes.map((n) => n.id));

    for (const e of edges) {
      if (!ids.has(e.source) || !ids.has(e.target)) out.push(`${where}: edge ${e.source} -> ${e.target} has a missing endpoint`);
    }

    // Scoped to VGW-side cards on purpose: a VPC attached to two TGWs under
    // different DX gateways can still be a card on one and a row on the other,
    // which predates the VGW handling and is not what this test guards.
    const vgwCards = new Set(edges
      .filter((e) => e.source.startsWith('vgw-') && e.target.startsWith('vpc-') && ids.has(e.target))
      .map((e) => e.target.replace(/^vpc-/, '')));
    for (const g of nodes.filter((n) => n.data.category === 'vpcGroup')) {
      for (const c of g.data.vpcChildren ?? []) {
        if (vgwCards.has(c.vpcId)) out.push(`${where}: ${c.vpcId} is both a VGW-side card and a row in ${g.id}`);
      }
      // "+N drawn separately" must be backed by N real cards this group's TGW side edges to.
      const separate = g.data.separateVpcCount ?? 0;
      if (separate > 0) {
        const groupKey = String(g.data.details?.groupKey);
        const tgwSources = new Set([groupKey, ...edges.filter((e) => e.target === g.id).map((e) => e.source)]);
        const drawn = new Set(edges
          .filter((e) => tgwSources.has(e.source) && e.target.startsWith('vpc-') && ids.has(e.target))
          .map((e) => e.target));
        if (drawn.size < separate) out.push(`${where}: ${g.id} says +${separate} drawn separately but only ${drawn.size} card(s) exist`);
      }
    }
  }
  return out;
}

describe('VPC placement: a VPC left out of a TGW group is always drawn elsewhere', () => {
  it('holds for every mock scenario, unfiltered and under each tag filter', () => {
    const out: string[] = [];
    for (const s of ['noResiliency', 'devTest', 'high', 'maximum', 'crossAccount'] as const) {
      const t = getMockTopology(s);
      out.push(...violations(t, s));
      const pairs = new Set(getTaggedResources(t).flatMap((res) => Object.entries(res.tags ?? {}).map(([k, v]) => JSON.stringify([k, v]))));
      for (const p of pairs) {
        const [key, value] = JSON.parse(p) as [string, string];
        out.push(...violations(filterTopologyByTags(t, [{ key, value }]), `${s}[${key}=${value}]`));
      }
    }
    expect(out).toEqual([]);
  });

  it(`holds for ${SEEDS} seeded random VGW + TGW overlap estates`, () => {
    const out: string[] = [];
    for (let seed = 1; seed <= SEEDS && out.length < 10; seed++) {
      out.push(...violations(randomTopology(rng(seed)), `seed ${seed}`));
    }
    expect(out).toEqual([]);
  }, FUZZ_TIMEOUT_MS);
});
