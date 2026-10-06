import type { TopologyData } from '../types/topology';

/**
 * Group DX Gateways that serve the SAME downstream into shared-redundancy sets.
 *
 * Two DXGWs share a downstream when they associate to the same target — the same
 * Transit Gateway, the same Virtual Private Gateway, or the same Cloud WAN core
 * network — OR when their (possibly different) intermediate gateways reach the
 * same TERMINAL VPC (the VPC holds the real workload, so a shared VPC is the same
 * blast-radius even through different TGWs/VGWs). Grouping is transitive: if A
 * and B share TGW-1 and B and C share TGW-2, then {A, B, C} is one group (a
 * connected component over the DXGW↔downstream bipartite graph).
 *
 * The point of the grouping is resiliency posture: a group that already spans
 * two DX locations (across its member gateways) is cross-DXGW redundant, so the
 * per-gateway "add a second location" recommendation should not fire for each
 * member independently.
 *
 * Returns a map from each DXGW id to the Set of DXGW ids in its group. A gateway
 * with no association (or a downstream shared with nobody) is its own singleton.
 */
export function groupDxGatewaysBySharedDownstream(topology: TopologyData): Map<string, Set<string>> {
  // Union-find over DXGW ids.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    // Path compression.
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (const gw of topology.dxGateways) parent.set(gw.directConnectGatewayId, gw.directConnectGatewayId);

  // Map each downstream target id → the DXGWs associated to it, then union them.
  const dxgwsByTarget = new Map<string, string[]>();
  for (const [dxgwId, targets] of downstreamTargetsByDxgw(topology)) {
    if (!parent.has(dxgwId)) continue;
    for (const targetId of targets) {
      const list = dxgwsByTarget.get(targetId);
      if (list) list.push(dxgwId);
      else dxgwsByTarget.set(targetId, [dxgwId]);
    }
  }

  for (const dxgwIds of dxgwsByTarget.values()) {
    for (let i = 1; i < dxgwIds.length; i++) union(dxgwIds[0], dxgwIds[i]);
  }

  // Materialize each root's component, then map every member to its set.
  const byRoot = new Map<string, Set<string>>();
  for (const gw of topology.dxGateways) {
    const root = find(gw.directConnectGatewayId);
    let set = byRoot.get(root);
    if (!set) {
      set = new Set();
      byRoot.set(root, set);
    }
    set.add(gw.directConnectGatewayId);
  }

  const result = new Map<string, Set<string>>();
  for (const gw of topology.dxGateways) {
    result.set(gw.directConnectGatewayId, byRoot.get(find(gw.directConnectGatewayId))!);
  }
  return result;
}

/**
 * Every downstream a DXGW reaches, as grouping keys: the associated TGW / VGW /
 * Cloud WAN core network id, plus `vpc:<id>` for each terminal VPC behind a
 * TGW or VGW. Two gateways sharing any key share a blast-radius.
 */
function downstreamTargetsByDxgw(topology: TopologyData): Map<string, Set<string>> {
  // Terminal VPCs reachable through a TGW / VGW — the VPC holds the real
  // workload, so two DXGWs whose DIFFERENT intermediate gateways both reach the
  // SAME VPC converge on one blast-radius and must group together, even though
  // their direct association targets differ.
  const vpcsByTgw = new Map<string, string[]>();
  for (const att of topology.transitGatewayAttachments) {
    if (att.resourceType === 'vpc' && att.resourceId) {
      const list = vpcsByTgw.get(att.transitGatewayId);
      if (list) list.push(att.resourceId);
      else vpcsByTgw.set(att.transitGatewayId, [att.resourceId]);
    }
  }
  const vpcsByVgw = new Map<string, string[]>();
  for (const vgw of topology.vpnGateways) {
    const vpcs = (vgw.vpcAttachments ?? []).map((a) => a.vpcId).filter(Boolean);
    if (vpcs.length) vpcsByVgw.set(vgw.vpnGatewayId, vpcs);
  }

  const result = new Map<string, Set<string>>();
  const add = (dxgwId: string, targetId: string | undefined) => {
    if (!targetId) return;
    let set = result.get(dxgwId);
    if (!set) result.set(dxgwId, (set = new Set()));
    set.add(targetId);
  };
  for (const assoc of topology.dxGatewayAssociations) {
    const dxgwId = assoc.directConnectGatewayId;
    const gwTargetId = assoc.associatedGateway?.id;
    if (gwTargetId) {
      add(dxgwId, gwTargetId);
      // Keyed distinctly (`vpc:<id>`) so a shared VPC unions regardless of
      // which TGW/VGW each DXGW went through.
      const vpcs = vpcsByTgw.get(gwTargetId) ?? vpcsByVgw.get(gwTargetId) ?? [];
      for (const vpcId of vpcs) add(dxgwId, `vpc:${vpcId}`);
    }
    add(dxgwId, assoc.associatedCoreNetwork?.id);
  }
  return result;
}

/**
 * Display names of what `dxGatewayId` shares with `peerIds` — the reason the
 * group is one blast-radius. A shared TGW / VGW / core network is named rather
 * than every VPC behind it; a VPC is named only when the gateways reach it
 * through DIFFERENT intermediates (the VGW-plus-TGW case), since that VPC is
 * then the whole story.
 */
export function sharedDownstreamNames(
  topology: TopologyData,
  dxGatewayId: string,
  peerIds: Iterable<string>,
): string[] {
  const byDxgw = downstreamTargetsByDxgw(topology);
  const own = byDxgw.get(dxGatewayId) ?? new Set<string>();
  const peerTargets = new Set<string>();
  for (const id of peerIds) for (const t of byDxgw.get(id) ?? []) peerTargets.add(t);
  const shared = [...own].filter((t) => peerTargets.has(t));
  const sharedGateways = shared.filter((t) => !t.startsWith('vpc:'));

  // VPCs already implied by a shared gateway aren't worth naming again.
  const impliedVpcs = new Set<string>();
  for (const gwId of sharedGateways) {
    for (const a of topology.transitGatewayAttachments) {
      if (a.transitGatewayId === gwId && a.resourceType === 'vpc') impliedVpcs.add(a.resourceId);
    }
    for (const a of topology.vpnGateways.find((g) => g.vpnGatewayId === gwId)?.vpcAttachments ?? []) {
      impliedVpcs.add(a.vpcId);
    }
  }
  const sharedVpcs = shared
    .filter((t) => t.startsWith('vpc:'))
    .map((t) => t.slice(4))
    .filter((id) => !impliedVpcs.has(id));

  const nameOf = (id: string): string =>
    topology.transitGateways.find((t) => t.transitGatewayId === id)?.tags.Name
    || topology.vpnGateways.find((g) => g.vpnGatewayId === id)?.tags.Name
    || topology.vpcs.find((v) => v.vpcId === id)?.tags.Name
    || id;
  return [...sharedVpcs, ...sharedGateways].map(nameOf);
}

/**
 * Distinct DX location codes used across a group of DX Gateways (by walking each
 * member's VIF → connection → location, falling back to VIF.location for
 * hosted-VIF accounts). This is the group's COMBINED site span — the basis for
 * deciding whether the shared-downstream group is already site-redundant.
 */
export function getGroupLocations(topology: TopologyData, dxGatewayIds: Set<string>): Set<string> {
  const connLoc = new Map<string, string | undefined>();
  for (const c of topology.connections) connLoc.set(c.connectionId, c.location);

  const locations = new Set<string>();
  for (const vif of topology.virtualInterfaces) {
    if (!vif.directConnectGatewayId || !dxGatewayIds.has(vif.directConnectGatewayId)) continue;
    const loc = connLoc.get(vif.connectionId) ?? vif.location;
    if (loc) locations.add(loc);
  }
  return locations;
}
