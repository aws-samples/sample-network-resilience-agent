import { describe, it, expect } from 'vitest';
import { analyzeTopology, getRecommendedGraph } from '../recommendation-engine';
import { makeEmptyTopology } from './helpers';
import type { TopologyData, DxNode, DxEdge } from '../../types/topology';

/**
 * VGW RESILIENCY — synonymous with DXGW
 * =====================================
 *
 * A Virtual Private Gateway reached over Direct Connect (a private VIF with
 * `virtualGatewayId`, no `directConnectGatewayId`) has the SAME site/device
 * redundancy posture as a DX Gateway. It must get the same ghost recommendations
 * (second DX location, redundant device) fanning into its `vgw-<id>` node —
 * NOT the old text-only "add a redundant VGW" warning.
 *
 * VPN-only VGWs (no DX-side VIF) are NOT DX-reached and get no per-VGW card.
 */

function vgw(id: string, name = id) {
  return { vpnGatewayId: id, vpcAttachments: [{ vpcId: 'vpc-1', state: 'attached' }], type: 'ipsec.1', amazonSideAsn: 64512, state: 'available', tags: { Name: name } };
}

/** Single-location VGW reached by one DX private VIF at LocA. */
function makeSingleLocationVgwTopology(): TopologyData {
  const t = makeEmptyTopology();
  t.locations = [{ locationCode: 'LocA', locationName: 'A', region: 'ap-southeast-1', availablePortSpeeds: ['1Gbps'] }];
  t.vpnGateways = [vgw('vgw-1', 'Prod VGW')];
  t.connections = [
    { connectionId: 'c1', connectionName: 'C1', connectionState: 'available', location: 'LocA', bandwidth: '1Gbps', region: 'ap-southeast-1', awsLogicalDeviceId: 'devA1' },
  ];
  t.virtualInterfaces = [
    { virtualInterfaceId: 'v1', virtualInterfaceName: 'V1', virtualInterfaceType: 'private', virtualInterfaceState: 'available', connectionId: 'c1', virtualGatewayId: 'vgw-1', vlan: 10, asn: 1, bgpPeers: [], region: 'ap-southeast-1', location: 'LocA' },
  ];
  return t;
}

function ghostEdges(recs: { additionalEdges: DxEdge[] }[]): DxEdge[] {
  return recs.flatMap((r) => r.additionalEdges);
}

describe('per-VGW resiliency assessment', () => {
  it('produces a per-VGW card for a DX-reached VGW', () => {
    const a = analyzeTopology(makeSingleLocationVgwTopology(), 'high');
    expect(a.perVgw.length).toBe(1);
    expect(a.perVgw[0].vgwId).toBe('vgw-1');
    expect(a.perVgw[0].vgwName).toBe('Prod VGW');
    expect(a.perVgw[0].currentLevel).toBe('devtest'); // 1 location, 1 device
  });

  it('recommends a second DX location with ghost nodes fanning into the vgw node', () => {
    const a = analyzeTopology(makeSingleLocationVgwTopology(), 'high');
    const recs = a.perVgw[0].recommendations;
    // A second-location rec exists (ghost recommendation, not a text warning).
    const secondLoc = recs.find((r) => r.ruleId === 'vgw-single-dx-location');
    expect(secondLoc).toBeDefined();
    expect(secondLoc!.additionalNodes.length).toBeGreaterThan(0);
    // Its ghost AWS device fans into the vgw-<id> node.
    const fansIntoVgw = ghostEdges([secondLoc!]).some((e) => e.target === 'vgw-vgw-1');
    expect(fansIntoVgw).toBe(true);
  });

  it('adds a redundant device at the existing location for Maximum', () => {
    const a = analyzeTopology(makeSingleLocationVgwTopology(), 'maximum');
    const recs = a.perVgw[0].recommendations;
    const devGap = recs.find((r) => r.ruleId === 'vgw-single-connection-per-location');
    expect(devGap).toBeDefined();
    expect(ghostEdges([devGap!]).some((e) => e.target === 'vgw-vgw-1')).toBe(true);
  });

  it('focuses the VGW row to render only its ghosts', () => {
    const a = analyzeTopology(makeSingleLocationVgwTopology(), 'maximum');
    const { nodes, edges } = getRecommendedGraph(a, 'vgw-1');
    expect(nodes.length).toBeGreaterThan(0);
    // Every ghost sink edge targets the vgw node — no foreign sink leaks in.
    const sinkEdges = edges.filter((e: DxEdge) => e.target.startsWith('vgw-') || e.target.startsWith('dxgw-') || e.target === 'pub-endpoints');
    expect(sinkEdges.every((e) => e.target === 'vgw-vgw-1')).toBe(true);
  });

  it('does NOT create a per-VGW card for a VPN-only VGW (no DX VIF)', () => {
    const t = makeEmptyTopology();
    // A VGW that exists but has no Direct Connect private VIF pointing at it is
    // VPN-only — no DX path to make redundant, so no per-VGW card.
    t.vpnGateways = [vgw('vgw-vpn', 'VPN Only')];
    const a = analyzeTopology(t, 'maximum');
    expect(a.perVgw.length).toBe(0);
  });

  it('does NOT assess a DX-reached VGW that has no attached VPC', () => {
    // A VGW reached by a DX private VIF but detached from any VPC has nothing
    // downstream to protect — its DX-side redundancy posture is meaningless, so
    // no per-VGW card (mirrors the DXGW no-VIF skip).
    const t = makeSingleLocationVgwTopology();
    t.vpnGateways = [{ ...vgw('vgw-1', 'Detached VGW'), vpcAttachments: [] }];
    const a = analyzeTopology(t, 'maximum');
    expect(a.perVgw.length).toBe(0);
  });

  it('does NOT assess a DX-reached VGW whose only VPC attachment is detaching', () => {
    // Only "attached"-state attachments count (matches topology-builder's
    // isVgwIsolated) — a transitional "detaching" attachment does not qualify.
    const t = makeSingleLocationVgwTopology();
    t.vpnGateways = [{ ...vgw('vgw-1'), vpcAttachments: [{ vpcId: 'vpc-1', state: 'detaching' }] }];
    const a = analyzeTopology(t, 'maximum');
    expect(a.perVgw.length).toBe(0);
  });

  it('does NOT assess a DX-reached VGW that has no VpnGateway record (partial snapshot)', () => {
    // EMEALAB regression: a partial/filtered snapshot can carry a private VIF
    // whose virtualGatewayId has NO matching entry in topology.vpnGateways (the
    // EC2 describe was scoped out). topology-builder renders no `vgw-<id>` node
    // for it, so assessing it would mint ghost devices fanning into a
    // non-existent sink → dangling ghost paths on the canvas. It must be skipped.
    const t = makeSingleLocationVgwTopology();
    t.vpnGateways = []; // VIF references vgw-1, but no gateway record exists.
    const a = analyzeTopology(t, 'maximum');
    expect(a.perVgw.length).toBe(0);
    // And no resiliency recommendation anywhere fans an edge into a vgw- node.
    const allEdges = a.resiliency.recommendations.flatMap((r) => r.additionalEdges);
    expect(allEdges.some((e) => e.target.startsWith('vgw-'))).toBe(false);
  });

  it('draws a plain (non-LAG) ghost mirroring the VGW\'s own DX path shape', () => {
    // The VGW at LocA is reached by a plain (non-LAG) connection, so its
    // redundant-device ghost is plain — no ghost LAG node.
    const a = analyzeTopology(makeSingleLocationVgwTopology(), 'maximum');
    const nodes: DxNode[] = a.perVgw[0].recommendations.flatMap((r) => r.additionalNodes);
    const lagGhosts = nodes.filter((n) => n.data.isRecommended && n.data.category === 'lag');
    expect(lagGhosts.length).toBe(0);
    // But an AWS device ghost IS added.
    const devGhosts = nodes.filter((n) => n.data.isRecommended && n.data.category === 'awsDevice');
    expect(devGhosts.length).toBeGreaterThan(0);
  });

  // KNOWN LIMITATION: a VGW reached PURELY via a LAG is not yet given per-VGW
  // ghost recommendations — the shared LAG assessment (ruleLagResiliency) only
  // fans ghost devices into DXGW nodes, and runPerVgwRules skips LAG scopes
  // (mirroring runPerDxgwRules). Documented here so the gap is explicit; the
  // common non-LAG DX→VGW path above is fully covered.
  it('does not (yet) emit per-VGW ghosts when the VGW is reached only via a LAG', () => {
    const t = makeSingleLocationVgwTopology();
    t.connections[0].lagId = 'lagA';
    t.lags = [
      { lagId: 'lagA', lagName: 'LAG-A', connectionsBandwidth: '1Gbps', numberOfConnections: 1, minimumLinks: 0, location: 'LocA', region: 'ap-southeast-1', lagState: 'available', connections: [{ ...t.connections[0] }] },
    ];
    const a = analyzeTopology(t, 'maximum');
    const resRecs = a.perVgw[0]?.recommendations.filter((r) => r.category === 'resiliency') ?? [];
    expect(resRecs.length).toBe(0);
  });
});
