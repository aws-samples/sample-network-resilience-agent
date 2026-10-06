import type { DxEdge, DxNode, TopologyData, TopologyTagFilter } from '../types/topology';

interface TaggedResource {
  id: string;
  tags?: Record<string, string>;
}

/** One entry per AWS resource, including resources represented by edges or detail panels. */
export function getTaggedResources(topology: TopologyData): TaggedResource[] {
  const resources = new Map<string, TaggedResource>();
  const add = (id: string, tags?: Record<string, string>) => {
    if (!id) return;
    const previous = resources.get(id);
    resources.set(id, { id, tags: { ...previous?.tags, ...tags } });
  };

  for (const lag of topology.lags) {
    add(lag.lagId, lag.tags);
    for (const connection of lag.connections) add(connection.connectionId, connection.tags);
  }
  for (const r of topology.connections) add(r.connectionId, r.tags);
  for (const r of topology.virtualInterfaces) add(r.virtualInterfaceId, r.tags);
  for (const r of topology.dxGateways) add(r.directConnectGatewayId, r.tags);
  for (const r of topology.vpcs) add(r.vpcId, r.tags);
  for (const r of topology.vpnGateways) add(r.vpnGatewayId, r.tags);
  for (const r of topology.vpnConnections) add(r.vpnConnectionId, r.tags);
  for (const r of topology.customerGateways) add(r.customerGatewayId, r.tags);
  for (const r of topology.transitGateways) add(r.transitGatewayId, r.tags);
  for (const r of topology.transitGatewayAttachments) add(r.transitGatewayAttachmentId, r.tags);
  for (const r of topology.transitGatewayPeeringAttachments) add(r.transitGatewayAttachmentId, r.tags);
  for (const r of topology.vpcPeerings) add(r.vpcPeeringConnectionId, r.tags);
  for (const r of topology.cloudWanCoreNetworks) add(r.coreNetworkId, r.tags);
  for (const r of topology.cloudWanAttachments) add(r.attachmentId, r.tags);
  for (const r of topology.cloudWanPeerings) add(r.peeringId, r.tags);
  for (const tables of topology.vpcRouteTables.values()) {
    for (const r of tables) add(r.routeTableId, r.tags);
  }
  for (const tables of topology.tgwRouteTables.values()) {
    for (const { routeTable: r } of tables) add(r.transitGatewayRouteTableId, r.tags);
  }
  return [...resources.values()];
}

export function matchesTagFilters(
  tags: Record<string, string> | undefined,
  filters: readonly TopologyTagFilter[],
): boolean {
  return filters.every(({ key, value }) =>
    tags != null && Object.hasOwn(tags, key) && (value === null || tags[key] === value),
  );
}

/** Ids of the resources whose own tags satisfy every filter — the panel's "N matching". */
export function getTagMatchIds(
  topology: TopologyData,
  filters: readonly TopologyTagFilter[],
): Set<string> {
  if (filters.length === 0) return new Set();
  return new Set(getTaggedResources(topology)
    .filter((r) => matchesTagFilters(r.tags, filters))
    .map((r) => r.id));
}

/**
 * A VIF or DX connection is drawn as an edge label, not a card, so it is
 * matched by the ids the edge carries. An aggregated VIF edge matches when any
 * member does.
 */
export function edgeMatchesTag(
  data: { vifId?: unknown; connectionId?: unknown; aggregatedVifs?: unknown } | undefined,
  matchIds: ReadonlySet<string>,
): boolean {
  if (!data || matchIds.size === 0) return false;
  if (typeof data.vifId === 'string' && matchIds.has(data.vifId)) return true;
  if (typeof data.connectionId === 'string' && matchIds.has(data.connectionId)) return true;
  const agg = data.aggregatedVifs as { vifId: string }[] | undefined;
  return agg?.some((av) => matchIds.has(av.vifId)) ?? false;
}

/**
 * Nodes to frame when fitting the view to the tag matches: matched cards, both
 * ends of a matched VIF / connection edge, and any collapsed VPC or TGW group
 * that holds a match.
 */
export function tagFitNodeIds(
  nodes: readonly Pick<DxNode, 'id' | 'data'>[],
  edges: readonly Pick<DxEdge, 'source' | 'target' | 'data'>[],
  matchIds: ReadonlySet<string>,
  matchNodeIds: ReadonlySet<string>,
): string[] {
  const ids = new Set<string>();
  for (const n of nodes) {
    if (
      matchNodeIds.has(n.id)
      || n.data.vpcChildren?.some((v) => matchIds.has(v.vpcId))
      || n.data.memberResourceIds?.some((id) => matchIds.has(id))
    ) ids.add(n.id);
  }
  for (const e of edges) {
    if (!edgeMatchesTag(e.data, matchIds)) continue;
    ids.add(e.source);
    ids.add(e.target);
  }
  return [...ids];
}

export function getTagOptions(resources: readonly TaggedResource[]): { key: string; values: string[] }[] {
  const options = new Map<string, Set<string>>();
  for (const { tags } of resources) {
    for (const [key, value] of Object.entries(tags ?? {})) {
      if (!key || typeof value !== 'string') continue;
      if (!options.has(key)) options.set(key, new Set());
      options.get(key)!.add(value);
    }
  }
  return [...options].sort(([a], [b]) => a.localeCompare(b)).map(([key, values]) => ({
    key,
    values: [...values].sort((a, b) => a.localeCompare(b)),
  }));
}

type Adjacency = Map<string, Set<string>>;

function visit(seeds: Iterable<string>, adjacency: Adjacency): Set<string> {
  const visited = new Set(seeds);
  const queue = [...visited];
  for (let i = 0; i < queue.length; i++) {
    for (const id of adjacency.get(queue[i]) ?? []) {
      if (visited.has(id)) continue;
      visited.add(id);
      queue.push(id);
    }
  }
  return visited;
}

/**
 * Keep matches and their upstream/downstream paths before building or grouping
 * the graph. Walk each direction independently: walking back down from a shared
 * ancestor would bring every sibling VPC back into a VPC-tagged view.
 *
 * This is a canvas projection. Callers must assess and export the original data.
 * Tags on peering relationships select both endpoints; unrelated peerings only
 * survive when both endpoints already belong to the selected paths.
 */
export function filterTopologyByTags(
  topology: TopologyData,
  filters: readonly TopologyTagFilter[],
): TopologyData {
  if (filters.length === 0) return topology;

  const seeds = getTagMatchIds(topology, filters);
  const upstream: Adjacency = new Map();
  const downstream: Adjacency = new Map();
  const link = (parent: string | undefined, child: string | undefined) => {
    if (!parent || !child || parent === child) return;
    if (!downstream.has(parent)) downstream.set(parent, new Set());
    if (!upstream.has(child)) upstream.set(child, new Set());
    downstream.get(parent)!.add(child);
    upstream.get(child)!.add(parent);
  };
  const arnId = (arn: string) => arn.split('/').pop() ?? '';

  const connectionLag = new Map<string, string>();
  for (const lag of topology.lags) {
    for (const c of lag.connections) {
      connectionLag.set(c.connectionId, lag.lagId);
      link(c.connectionId, lag.lagId);
    }
  }
  for (const c of topology.connections) {
    if (c.lagId) {
      connectionLag.set(c.connectionId, c.lagId);
      link(c.connectionId, c.lagId);
    }
  }
  for (const vif of topology.virtualInterfaces) {
    link(connectionLag.get(vif.connectionId) ?? vif.connectionId, vif.virtualInterfaceId);
    link(vif.virtualInterfaceId, vif.directConnectGatewayId ?? vif.virtualGatewayId);
  }
  for (const a of topology.dxGatewayAssociations) {
    link(a.directConnectGatewayId, a.associatedCoreNetwork?.id ?? a.associatedGateway.id);
  }
  for (const g of topology.vpnGateways) {
    for (const a of g.vpcAttachments) link(g.vpnGatewayId, a.vpcId);
  }
  for (const vpn of topology.vpnConnections) {
    link(vpn.customerGatewayId, vpn.vpnConnectionId);
    link(vpn.vpnConnectionId, vpn.transitGatewayId ?? vpn.vpnGatewayId);
  }
  for (const a of topology.transitGatewayAttachments) {
    if (a.resourceType === 'peering') continue;
    if (a.resourceType === 'direct-connect-gateway' || a.resourceType === 'vpn') {
      link(a.resourceId, a.transitGatewayAttachmentId);
      link(a.transitGatewayAttachmentId, a.transitGatewayId);
    } else {
      link(a.transitGatewayId, a.transitGatewayAttachmentId);
      if (a.resourceType === 'vpc') link(a.transitGatewayAttachmentId, a.resourceId);
    }
  }
  const routeTableTgws = new Map<string, string>();
  for (const tables of topology.tgwRouteTables.values()) {
    for (const { routeTable: r } of tables) {
      routeTableTgws.set(r.transitGatewayRouteTableId, r.transitGatewayId);
      link(r.transitGatewayId, r.transitGatewayRouteTableId);
    }
  }
  for (const tables of topology.vpcRouteTables.values()) {
    for (const r of tables) link(r.vpcId, r.routeTableId);
  }
  for (const a of topology.cloudWanAttachments) {
    const resourceId = arnId(a.resourceArn);
    if (a.attachmentType === 'direct-connect-gateway' || a.attachmentType === 'site-to-site-vpn') {
      link(resourceId, a.attachmentId);
      link(a.attachmentId, a.coreNetworkId);
    } else {
      link(a.coreNetworkId, a.attachmentId);
      if (a.attachmentType === 'vpc') link(a.attachmentId, resourceId);
      if (a.attachmentType === 'transit-gateway-route-table') {
        const tgwId = routeTableTgws.get(resourceId);
        if (tgwId) {
          link(a.attachmentId, tgwId);
        } else {
          // Same fallback used by buildGraph when the route table is unavailable.
          for (const tgw of topology.transitGateways) {
            if (tgw.transitGatewayArn.split(':')[3] === a.edgeLocation) {
              link(a.attachmentId, tgw.transitGatewayId);
            }
          }
        }
      }
    }
  }
  for (const p of topology.cloudWanPeerings) {
    link(p.coreNetworkId, p.peeringId);
    link(p.peeringId, arnId(p.resourceArn));
  }

  const peerings = [
    ...topology.vpcPeerings.map((p) => ({
      id: p.vpcPeeringConnectionId, a: p.requesterVpc.vpcId, b: p.accepterVpc.vpcId,
    })),
    ...topology.transitGatewayPeeringAttachments.map((p) => ({
      id: p.transitGatewayAttachmentId,
      a: p.requesterTgwInfo.transitGatewayId, b: p.accepterTgwInfo.transitGatewayId,
    })),
  ];
  for (const p of peerings) {
    if (seeds.has(p.id)) {
      seeds.add(p.a);
      seeds.add(p.b);
    }
  }
  const retained = new Set([...visit(seeds, upstream), ...visit(seeds, downstream)]);
  const keep = (id: string) => retained.has(id);

  // A LAG is a single physical path. Retain its observed member connections,
  // even when only one member has the tag, so it never becomes an inferred port.
  for (const lag of topology.lags) {
    if (!keep(lag.lagId)) continue;
    for (const c of lag.connections) retained.add(c.connectionId);
    for (const c of topology.connections) if (c.lagId === lag.lagId) retained.add(c.connectionId);
  }
  for (const vif of topology.virtualInterfaces) {
    if (keep(vif.virtualInterfaceId)) retained.add(vif.connectionId);
  }
  for (const p of peerings) {
    if (keep(p.a) && keep(p.b)) retained.add(p.id);
  }

  const connections = topology.connections.filter((r) => keep(r.connectionId));
  const virtualInterfaces = topology.virtualInterfaces.filter((r) => keep(r.virtualInterfaceId));
  const lags = topology.lags.filter((r) => keep(r.lagId));
  const locations = new Set([
    ...connections.map((c) => c.location),
    ...virtualInterfaces.map((v) => v.location),
    ...lags.map((l) => l.location),
  ]);

  return {
    ...topology,
    connections,
    virtualInterfaces,
    lags,
    locations: topology.locations.filter((r) => locations.has(r.locationCode)),
    dxGateways: topology.dxGateways.filter((r) => keep(r.directConnectGatewayId)),
    dxGatewayAssociations: topology.dxGatewayAssociations.filter((a) =>
      keep(a.directConnectGatewayId)
      && (!a.associatedGateway.id && !a.associatedCoreNetwork?.id
        || keep(a.associatedCoreNetwork?.id ?? a.associatedGateway.id)),
    ),
    vpcs: topology.vpcs.filter((r) => keep(r.vpcId)),
    vpnGateways: topology.vpnGateways.filter((r) => keep(r.vpnGatewayId)).map((r) => ({
      ...r, vpcAttachments: r.vpcAttachments.filter((a) => keep(a.vpcId)),
    })),
    vpnConnections: topology.vpnConnections.filter((r) => keep(r.vpnConnectionId)),
    customerGateways: topology.customerGateways.filter((r) => keep(r.customerGatewayId)),
    transitGateways: topology.transitGateways.filter((r) => keep(r.transitGatewayId)),
    transitGatewayAttachments: topology.transitGatewayAttachments
      .filter((r) => keep(r.transitGatewayAttachmentId)),
    transitGatewayPeeringAttachments: topology.transitGatewayPeeringAttachments
      .filter((r) => keep(r.transitGatewayAttachmentId)),
    vpcPeerings: topology.vpcPeerings.filter((r) => keep(r.vpcPeeringConnectionId)),
    cloudWanCoreNetworks: topology.cloudWanCoreNetworks.filter((r) => keep(r.coreNetworkId)),
    cloudWanAttachments: topology.cloudWanAttachments.filter((r) => keep(r.attachmentId)),
    cloudWanPeerings: topology.cloudWanPeerings.filter((r) => keep(r.peeringId)),
    vpcRouteTables: new Map([...topology.vpcRouteTables].filter(([id]) => keep(id))),
    tgwRouteTables: new Map([...topology.tgwRouteTables].filter(([id]) => keep(id))),
    cloudWanRoutes: new Map([...topology.cloudWanRoutes].filter(([id]) => keep(id))),
    publicVifResources: topology.publicVifResources?.filter((r) => keep(r.virtualInterfaceId)),
  };
}

/** Keep only recommendation paths anchored to infrastructure in the filtered view. */
export function scopeTagRecommendations(
  currentNodes: DxNode[],
  recommendations: { nodes: DxNode[]; edges: DxEdge[] },
): { nodes: DxNode[]; edges: DxEdge[] } {
  const containers = new Set(['dxLocation', 'region', 'customerSite', 'awsCloud']);
  const currentIds = new Set(currentNodes.filter((n) => !containers.has(n.data.category)).map((n) => n.id));
  const allowedIds = new Set([...currentIds, ...recommendations.nodes.map((n) => n.id)]);
  const edges = recommendations.edges.filter((e) => allowedIds.has(e.source) && allowedIds.has(e.target));
  const adjacency: Adjacency = new Map();
  for (const edge of edges) {
    if (!adjacency.has(edge.source)) adjacency.set(edge.source, new Set());
    if (!adjacency.has(edge.target)) adjacency.set(edge.target, new Set());
    adjacency.get(edge.source)!.add(edge.target);
    adjacency.get(edge.target)!.add(edge.source);
  }
  const retained = visit(currentIds, adjacency);
  const leaves = recommendations.nodes.filter((n) => retained.has(n.id));
  const locations = new Set(leaves.map((n) => n.data.details?.locationCode).filter(Boolean));
  const regions = new Set(leaves.map((n) => n.data.details?.region).filter(Boolean));
  const nodes = recommendations.nodes.filter((n) =>
    retained.has(n.id)
    || (n.data.category === 'dxLocation' && locations.has(n.data.details?.code))
    || (n.data.category === 'region' && regions.has(n.data.details?.regionCode))
    || (n.data.category === 'customerSite' && retained.has(n.id.replace('custsite-', 'onprem-'))),
  );
  return { nodes, edges: edges.filter((e) => retained.has(e.source) && retained.has(e.target)) };
}

/** Custom routers/sites have no AWS tags, but can provide context for a visible path. */
export function tagFilteredCustomNodeIds(
  currentNodes: DxNode[],
  customNodes: DxNode[],
  customEdges: Pick<DxEdge, 'source' | 'target'>[],
): Set<string> {
  const currentIds = new Set(currentNodes.map((n) => n.id));
  const allowed = new Set([...currentIds, ...customNodes.map((n) => n.id)]);
  const adjacency: Adjacency = new Map();
  for (const edge of customEdges) {
    if (!allowed.has(edge.source) || !allowed.has(edge.target)) continue;
    if (!adjacency.has(edge.source)) adjacency.set(edge.source, new Set());
    if (!adjacency.has(edge.target)) adjacency.set(edge.target, new Set());
    adjacency.get(edge.source)!.add(edge.target);
    adjacency.get(edge.target)!.add(edge.source);
  }
  // Routers placed inside a surviving real customer site belong to that context.
  for (const node of customNodes) {
    if (node.parentId && currentIds.has(node.parentId)) currentIds.add(node.id);
  }
  const retained = visit(currentIds, adjacency);
  for (const node of customNodes) {
    if (retained.has(node.id) && node.parentId) retained.add(node.parentId);
  }
  return retained;
}
