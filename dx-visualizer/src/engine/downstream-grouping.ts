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
  const addTarget = (targetId: string, dxgwId: string) => {
    if (!targetId || !parent.has(dxgwId)) return;
    const list = dxgwsByTarget.get(targetId);
    if (list) list.push(dxgwId);
    else dxgwsByTarget.set(targetId, [dxgwId]);
  };

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

  for (const assoc of topology.dxGatewayAssociations) {
    const dxgwId = assoc.directConnectGatewayId;
    const gwTargetId = assoc.associatedGateway?.id;
    if (gwTargetId) {
      addTarget(gwTargetId, dxgwId);
      // Fold in the terminal VPCs this intermediate gateway reaches, keyed
      // distinctly (`vpc:<id>`) so a shared VPC unions regardless of which
      // TGW/VGW each DXGW went through.
      const vpcs = vpcsByTgw.get(gwTargetId) ?? vpcsByVgw.get(gwTargetId) ?? [];
      for (const vpcId of vpcs) addTarget(`vpc:${vpcId}`, dxgwId);
    }
    const coreId = assoc.associatedCoreNetwork?.id;
    if (coreId) addTarget(coreId, dxgwId);
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
