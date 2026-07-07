import type { TopologyData, DxNode, DxEdge } from '../types/topology';
import type { Recommendation, ResiliencyLevel } from '../types/recommendations';
import { getLocationDeviceCounts, getUsedLocations, getSinkConnectedDevices, lagMemberCount, type SinkDeviceInfo } from './sla-gating';
import { makeGhostNode, makeGhostEdge } from './ghost-helpers';
import { secondLocationGhostChain, extraDeviceGhost, lagDeviceGhost, ghostSinkEdges, ghostLagEdges, type GhostSink } from './ghost-chains';

export type ResiliencyTarget = Extract<ResiliencyLevel, 'high' | 'maximum'>;

/**
 * Which AWS gateway a per-gateway resiliency rule targets. A VGW reached over
 * Direct Connect has the SAME site/device redundancy posture as a DXGW — the
 * only difference is the sink node id (`vgw-<id>` vs `dxgw-<id>`) the ghost
 * devices fan into. Everything else (second location, redundant device, reuse)
 * is identical, so the rules take this kind and are otherwise shared.
 */
export type GatewayKind = 'dxgw' | 'vgw';

/** The single consolidated public-endpoints sink (see topology-builder). */
const PUB_SINK: GhostSink = { nodeId: 'pub-endpoints', label: 'Public VIF' };

export function ruleSingleDxLocation(
  topology: TopologyData,
  target: ResiliencyTarget = 'high',
  dxGatewayId?: string,
  dxGatewayName?: string,
  // When a public VIF rides the same connection as this DXGW, its resilient
  // path is the SAME new location — so fan the ghost AWS device out to the
  // public-endpoints sink too, rather than minting a duplicate rec-pubvif chain.
  carriesPublicVif = false,
  // An existing DX location (elsewhere in the FULL topology) this scope can
  // reuse for its redundant path instead of minting a brand-new ghost location.
  // Resolved by the engine, which sees the whole topology; undefined → mint.
  reuseLocationCode?: string,
  // Which gateway this scope targets. 'vgw' fans the ghost devices into the
  // `vgw-<id>` node instead of `dxgw-<id>`; the DX-side redundancy is identical.
  gatewayKind: GatewayKind = 'dxgw',
): Recommendation | null {
  const usedLocations = getUsedLocations(topology);
  if (usedLocations.size >= 2) return null;
  if (usedLocations.size === 0) return null;

  // When the rule is DXGW-scoped, target that specific gateway; otherwise fall
  // back to the first known gateway so recommendations still attach to the graph.
  const resolvedDxgwId = dxGatewayId ?? (gatewayKind === 'dxgw' ? topology.dxGateways[0]?.directConnectGatewayId : undefined);
  const dxgwNodeId = resolvedDxgwId ? `${gatewayKind}-${resolvedDxgwId}` : undefined;
  const prefix = resolvedDxgwId ? `rec-${resolvedDxgwId}` : 'rec';
  const locCode = `${prefix}-loc-B`;

  const sinks: GhostSink[] = [];
  if (dxgwNodeId) sinks.push({ nodeId: dxgwNodeId, label: 'VIF' });
  if (carriesPublicVif) sinks.push(PUB_SINK);

  // When this recommendation is DXGW-scoped, spell out which gateway the
  // proposed second location supports so users with multiple DXGWs can tell
  // overlapping ghost zones apart at a glance. (The label attaches to the DX
  // location node — the ghost chain starts at the Customer / Partner Device and
  // no customer-premises node is minted.) Only relevant when minting a ghost
  // location; reuse attaches to the existing (already-labelled) site.
  const siteLabel = dxGatewayId
    ? `Second Direct Connect Location to support ${dxGatewayName ?? dxGatewayId}`
    : undefined;

  const { nodes, edges } = secondLocationGhostChain({
    prefix,
    locCode,
    sinks,
    target,
    siteLabel,
    siteDetails: { dxGatewayId },
    reuseLocationCode,
  });

  // Namespace the rec id by gateway kind so a VGW and a DXGW that (in theory)
  // share a raw id never collide. DXGW keeps its historical id shape.
  const idBase = gatewayKind === 'vgw' ? 'rec-single-vgw-dx-location' : 'rec-single-dx-location';

  const slaLabel = target === 'maximum' ? 'Maximum Resiliency (99.99% SLA)' : 'High Resiliency (99.9% SLA)';
  const reuseText = reuseLocationCode
    ? `Reuse your existing Direct Connect location ${reuseLocationCode} for this gateway`
    : 'Adding a second location';
  const description = target === 'maximum'
    ? `Your topology uses only one Direct Connect location. ${reuseText} with two redundant connections provides ${slaLabel} by eliminating both site and device failure.`
    : `Your topology uses only one Direct Connect location. ${reuseText} provides ${slaLabel} by eliminating single-site failure.`;

  return {
    id: `${idBase}${resolvedDxgwId ? `-${resolvedDxgwId}` : ''}`,
    ruleId: gatewayKind === 'vgw' ? 'vgw-single-dx-location' : 'single-dx-location',
    category: 'resiliency',
    // Tier-gap recommendations are advisory — whether to upgrade to High/Max is
    // a product decision (a dev environment may intentionally sit on a single
    // connection). Real faults (VIF down, connection unavailable) stay Critical
    // and are emitted by the best-practice rules instead.
    severity: 'info',
    title: 'Add a Second Direct Connect Location',
    description,
    additionalNodes: nodes,
    additionalEdges: edges,
  };
}

export function ruleSingleConnectionPerLocation(
  topology: TopologyData,
  target: ResiliencyTarget = 'high',
  dxGatewayId?: string,
  carriesPublicVif = false,
  // Sink-scoped device info (loc → { hasLag }) for THIS DXGW's own path — the
  // engine builds it with getSinkConnectedDevices(scope, fullTopology), so the
  // ghost shape follows THIS gateway's existing connected path: LAG only where
  // this DXGW is itself reached via a LAG (member connection, or a device the
  // LAG bundle also terminates on), plain otherwise. A LAG serving a *different*
  // sink at the same location no longer forces a LAG ghost here. When omitted,
  // falls back to plain shape.
  sinkDevicesFull?: Map<string, SinkDeviceInfo>,
  // Locations already device-redundant at the shared-downstream GROUP level:
  // 2+ member gateways converging on the same TGW/VPC reach it via separate
  // devices here, so this location already survives a device failure for the
  // shared blast-radius. Resolved by the engine (which sees the whole group);
  // the device-gap ghost is suppressed at these locations.
  skipLocations?: Set<string>,
  // Which gateway this scope targets — fans ghost devices into `vgw-<id>` vs
  // `dxgw-<id>`. DX-side device redundancy is otherwise identical.
  gatewayKind: GatewayKind = 'dxgw',
): Recommendation[] {
  // High-tier topologies only need 1 connection per location — this rule
  // is about closing the device-failure gap, which only matters for Maximum.
  if (target === 'high') return [];

  const recs: Recommendation[] = [];
  const locationDevices = getLocationDeviceCounts(topology);

  // Max tier requires 2+ conns on separate devices at EVERY location, including
  // the existing one. For a single-location DXGW targeting Max, the user needs
  // both: (a) a second location (covered by ruleSingleDxLocation) and
  // (b) a second device at the existing location (this rule). Don't gate on
  // multi-location scope — both recs need to fire in parallel for the tier goal.

  const resolvedDxgwId = dxGatewayId ?? (gatewayKind === 'dxgw' ? topology.dxGateways[0]?.directConnectGatewayId : undefined);
  const prefix = resolvedDxgwId ? `rec-${resolvedDxgwId}` : 'rec';
  const dxgwNodeId = resolvedDxgwId ? `${gatewayKind}-${resolvedDxgwId}` : undefined;

  const sinks: GhostSink[] = [];
  if (dxgwNodeId) sinks.push({ nodeId: dxgwNodeId, label: 'VIF' });
  if (carriesPublicVif) sinks.push(PUB_SINK);

  for (const [location, deviceCount] of locationDevices) {
    if (deviceCount >= 2) continue;
    // Already device-redundant for the converged downstream at this location.
    if (skipLocations?.has(location)) continue;

    const locNode = topology.locations.find((l) => l.locationCode === location);
    const locName = locNode?.locationName ?? location;

    // LAG shape when this location's real sink device is LAG-backed (resolved
    // against the FULL topology; the per-DXGW scope may have stripped the LAG).
    // The ghost mirrors the member count of that real LAG.
    const sinkInfo = sinkDevicesFull?.get(location);
    const drawLag = sinkInfo?.hasLag ?? false;
    const { nodes, edges } = drawLag
      ? lagDeviceGhost({ prefix, location, sinks, memberCount: sinkInfo?.lagMemberCount })
      : extraDeviceGhost({ prefix, location, sinks });

    // Distinguish "only 1 raw connection" from "multiple conns sharing one AWS
    // device". Both fail the device-redundancy check, but the fix framing is
    // different: one is "add a connection", the other is "add a connection on
    // a separate device".
    const rawConnCount = topology.connections.length > 0
      ? topology.connections.filter((c) => c.location === location).length
      : topology.virtualInterfaces.filter((v) => (v.location ?? '') === location).length;
    const description = rawConnCount >= 2
      ? `Location ${locName} has ${rawConnCount} connections, but they terminate on the same AWS logical device — a device failure cuts this location entirely. Add a connection on a separate device to reach Maximum Resiliency (99.99% SLA).`
      : `Location ${locName} has only one Direct Connect connection. Adding a second connection on a separate device provides Maximum Resiliency (99.99% SLA).`;

    recs.push({
      id: `${gatewayKind === 'vgw' ? 'rec-single-vgw-conn' : 'rec-single-conn'}-${location}${resolvedDxgwId ? `-${resolvedDxgwId}` : ''}`,
      ruleId: gatewayKind === 'vgw' ? 'vgw-single-connection-per-location' : 'single-connection-per-location',
      category: 'resiliency',
      // Advisory, not a fault — the user may be intentionally under-provisioned
      // (dev/test, cost ceiling). See `ruleSingleDxLocation` for the same rationale.
      severity: 'info',
      title: `Add Redundant Connection at ${locName}`,
      description,
      additionalNodes: nodes,
      additionalEdges: edges,
    });
  }

  return recs;
}

export function ruleNoTgw(topology: TopologyData): Recommendation | null {
  if (topology.transitGateways.length > 0) return null;
  if (topology.vpnGateways.length === 0) return null;

  return {
    id: 'rec-no-tgw',
    ruleId: 'no-tgw',
    category: 'resiliency',
    severity: 'warning',
    title: 'Consider Using Transit Gateway',
    description:
      'Using a Transit Gateway instead of multiple Virtual Private Gateways simplifies routing and enables better scalability.',
    additionalNodes: [],
    additionalEdges: [],
  };
}

export function ruleSingleVgw(topology: TopologyData): Recommendation | null {
  if (topology.vpnGateways.length !== 1 || topology.transitGateways.length > 0) return null;

  return {
    id: 'rec-single-vgw',
    ruleId: 'single-vgw',
    category: 'resiliency',
    severity: 'warning',
    title: 'Add Redundant Virtual Private Gateway',
    description: 'You have a single Virtual Private Gateway. Consider adding a second one for redundancy.',
    additionalNodes: [],
    additionalEdges: [],
  };
}

export function ruleNoLag(topology: TopologyData): Recommendation | null {
  if (topology.lags.length > 0) return null;
  if (topology.connections.length < 2) return null;

  const locationConnections = new Map<string, number>();
  for (const conn of topology.connections) {
    locationConnections.set(conn.location, (locationConnections.get(conn.location) ?? 0) + 1);
  }

  if (![...locationConnections.values()].some((c) => c >= 2)) return null;

  return {
    id: 'rec-no-lag',
    ruleId: 'no-lag',
    category: 'resiliency',
    severity: 'info',
    title: 'Consider Using LAG Groups',
    description: 'Link Aggregation Groups can bundle multiple connections for simplified management.',
    additionalNodes: [],
    additionalEdges: [],
  };
}

/**
 * LAG resiliency rule — recommends adding LAGs and/or DX locations to reach
 * High (1 LAG per location, 2+ locations) or Maximum (2 LAGs per location,
 * 2+ locations) resiliency when the account already uses LAGs.
 *
 * Only fires when LAGs exist in the topology. Does not drop existing LAGs.
 */
export function ruleLagResiliency(
  topology: TopologyData,
  target: ResiliencyTarget = 'high',
  dxGatewayIds?: string | string[],
  // An existing DX location (with spare sink-device capacity) the second-LAG
  // chain can reuse instead of minting a brand-new ghost location. Resolved by
  // the engine; undefined → mint (consistent with the DXGW/public-VIF rules).
  reuseLocationCode?: string,
  // Whether the reused location ALREADY runs a real LAG on a sink-connected
  // path. LAG ghost paths may only be drawn where a LAG already exists (Rule 1);
  // when reusing a location that has only a plain (non-LAG) sink-connected
  // device, we draw a plain non-LAG ghost path instead. Defaults to true for the
  // minted-greenfield case and for callers that don't distinguish.
  reuseLocationHasLag = true,
): Recommendation[] {
  if (topology.lags.length === 0) return [];

  const recs: Recommendation[] = [];
  // Resolve target DXGW node IDs — ghost edges fan out to all connected gateways.
  const resolvedIds: string[] = dxGatewayIds
    ? (Array.isArray(dxGatewayIds) ? dxGatewayIds : [dxGatewayIds])
    : topology.dxGateways[0]?.directConnectGatewayId
      ? [topology.dxGateways[0].directConnectGatewayId]
      : [];
  const dxgwNodeIds = resolvedIds.map((id) => `dxgw-${id}`);
  const prefix = resolvedIds[0] ? `rec-lag-${resolvedIds[0]}` : 'rec-lag';

  const hasPublicVifs = topology.virtualInterfaces.some(
    (v) => v.virtualInterfaceType === 'public',
  );

  // Every ghost AWS device fans out to each connected DXGW and (when public VIFs
  // ride these LAGs) the single public-endpoints sink — the LAG already carries
  // both, so we reuse one device instead of a separate rec-pubvif chain.
  const lagSinks: GhostSink[] = [
    ...dxgwNodeIds.map((id) => ({ nodeId: id, label: 'VIF' })),
    ...(hasPublicVifs ? [PUB_SINK] : []),
  ];

  // Count LAGs per location, and record each location's member counts (largest
  // first) so a ghost can mirror a real LAG's connection count.
  const lagsByLocation = new Map<string, number>();
  const lagCountsByLocation = new Map<string, number[]>();
  for (const lag of topology.lags) {
    if (lag.location) {
      lagsByLocation.set(lag.location, (lagsByLocation.get(lag.location) ?? 0) + 1);
      const list = lagCountsByLocation.get(lag.location) ?? [];
      list.push(lagMemberCount(lag));
      lagCountsByLocation.set(lag.location, list);
    }
  }
  for (const list of lagCountsByLocation.values()) list.sort((a, b) => b - a);
  // Largest LAG member count at a location (0 when none) — the count a single
  // mirrored ghost uses (High tier, or a same-location device-gap fill).
  const largestLagAt = (loc: string): number => lagCountsByLocation.get(loc)?.[0] ?? 0;

  const locationCount = lagsByLocation.size;
  const allLocationsHaveMultipleLags = locationCount > 0 && [...lagsByLocation.values()].every((c) => c >= 2);

  // 2+ locations with 2+ LAGs each = Maximum already met.
  if (locationCount >= 2 && allLocationsHaveMultipleLags) return recs;

  const sinkDevices = getSinkConnectedDevices(topology);

  // One redundant path (partner → [LAG →] awsDevice → sinks) AT an existing
  // location — closes the device-redundancy gap there. The shape mirrors the
  // location's real sink path: a location that already runs a LAG gets a ghost
  // LAG; a plain (non-LAG) sink location gets a plain ghost path.
  const makeRedundantDeviceRec = (location: string): Recommendation => {
    const locNode = topology.locations.find((l) => l.locationCode === location);
    const locName = locNode?.locationName ?? location;
    // LAG shape when the location runs a LAG — detected via sink devices, or
    // (for LAG-only fixtures with no VIFs) simply present in lagsByLocation.
    const drawLag = (sinkDevices.get(location)?.hasLag ?? false) || lagsByLocation.has(location);
    // Mirror the location's own real LAG: prefer the sink-connected LAG's count,
    // fall back to the largest LAG at the location (LAG-only fixtures).
    const memberCount = sinkDevices.get(location)?.lagMemberCount || largestLagAt(location) || 2;

    const partnerId = `${prefix}-partner-${location}-2`;
    const awsId = `${prefix}-awsdev-${location}-2`;
    const nodes: DxNode[] = [
      makeGhostNode(partnerId, 'dxPartnerDevice', 'Customer / Partner Device', { details: { locationCode: location } }),
    ];
    const edges: DxEdge[] = [];
    if (drawLag) {
      const lagId = `${prefix}-lag-${location}-2`;
      nodes.push(makeGhostNode(lagId, 'lag', 'LAG (Recommended)', { details: { locationCode: location } }));
      nodes.push(makeGhostNode(awsId, 'awsDevice', 'AWS Device', { details: { locationCode: location } }));
      edges.push(...ghostLagEdges(partnerId, lagId, awsId, memberCount));
    } else {
      nodes.push(makeGhostNode(awsId, 'awsDevice', 'AWS Device', { details: { locationCode: location } }));
      edges.push(makeGhostEdge(partnerId, awsId));
    }
    edges.push(...ghostSinkEdges(awsId, lagSinks));

    const fixText = drawLag
      ? 'Adding a second LAG on a separate AWS device'
      : 'Adding a second connection on a separate AWS device';
    return {
      id: `rec-lag-redundancy-${location}${resolvedIds[0] ? `-${resolvedIds[0]}` : ''}`,
      ruleId: 'lag-redundancy-per-location',
      category: 'resiliency',
      severity: 'info',
      title: drawLag ? `Add Redundant LAG at ${locName}` : `Add Redundant Connection at ${locName}`,
      description: `Location ${locName} has only one AWS logical device reaching this gateway. ${fixText} provides Maximum Resiliency (99.99% SLA).`,
      additionalNodes: nodes,
      additionalEdges: edges,
    };
  };

  // BUG FIX (multi-site device gap): the DXGW/public sink is ALREADY fed from
  // 2+ real DX locations, so the topology is site-redundant — minting a
  // brand-new "Second Direct Connect Location" is wrong. The only remaining gap
  // (Maximum only) is per-location device redundancy: for EACH feeding location
  // with fewer than 2 sink-connected devices, add a redundant path AT that
  // location (LAG shape where a LAG exists, plain otherwise). Locations already
  // at 2+ sink devices are skipped.
  if (sinkDevices.size >= 2 && locationCount < 2) {
    if (target === 'maximum') {
      for (const [location, info] of sinkDevices) {
        if (info.deviceCount >= 2) continue;
        recs.push(makeRedundantDeviceRec(location));
      }
    }
    return recs;
  }

  // Rule 1: Single location → recommend adding a LAG at a second DX location.
  if (locationCount < 2) {
    const existingLocation = [...lagsByLocation.keys()][0];
    const existingLocNode = topology.locations.find((l) => l.locationCode === existingLocation);
    const existingLocName = existingLocNode?.locationName ?? existingLocation;
    const locCode = `${prefix}-loc-B`;
    // Reuse attaches ghost devices to the existing location's container; a minted
    // location uses the synthetic locCode.
    const deviceLocCode = reuseLocationCode ?? locCode;

    // A LAG ghost path may only be drawn at a location that ALREADY runs a real
    // LAG (Rule 1). When minting a brand-new ghost location the scope's own LAG
    // justifies a LAG shape; when reusing an existing location we only draw a
    // LAG if that site already has one, otherwise we draw a plain (non-LAG) path.
    const drawLag = !reuseLocationCode || reuseLocationHasLag;

    // The source location's real LAG member counts (largest first). A ghost LAG
    // at the (empty) second location mirrors these so it draws the same number
    // of connections as a real LAG this topology already runs:
    //   High → one path at the LARGEST count.
    //   Max  → two paths: largest, then second-largest (replicating the largest
    //          when the source runs a single LAG).
    const existingCounts = lagCountsByLocation.get(existingLocation) ?? [];
    const primaryCount = existingCounts[0] || 2;
    const secondaryCount = existingCounts[1] || primaryCount;

    // Emit one redundant path (partner → [LAG →] awsDevice → sinks) at the
    // second location. `suffix` disambiguates the maximum-tier second path.
    const pushPath = (nodes: DxNode[], edges: DxEdge[], suffix: string, loc: string, memberCount: number) => {
      const partnerId = `${prefix}-partner-${suffix}`;
      const awsId = `${prefix}-awsdev-${suffix}`;
      nodes.push(makeGhostNode(partnerId, 'dxPartnerDevice', 'Customer / Partner Device', { details: { locationCode: loc } }));
      if (drawLag) {
        const lagId = `${prefix}-lag-${suffix}`;
        nodes.push(makeGhostNode(lagId, 'lag', 'LAG (Recommended)', { details: { locationCode: loc } }));
        nodes.push(makeGhostNode(awsId, 'awsDevice', 'AWS Device', { details: { locationCode: loc } }));
        edges.push(...ghostLagEdges(partnerId, lagId, awsId, memberCount));
      } else {
        nodes.push(makeGhostNode(awsId, 'awsDevice', 'AWS Device', { details: { locationCode: loc } }));
        edges.push(makeGhostEdge(partnerId, awsId));
      }
      edges.push(...ghostSinkEdges(awsId, lagSinks));
    };

    const nodes: DxNode[] = [];
    if (!reuseLocationCode) {
      nodes.push(makeGhostNode(`${prefix}-dxloc-B`, 'dxLocation', 'Second Direct Connect Location', { details: { code: locCode } }));
    }
    const edges: DxEdge[] = [];
    pushPath(nodes, edges, 'B-1', deviceLocCode, primaryCount);

    if (target === 'maximum') {
      pushPath(nodes, edges, 'B-2', deviceLocCode, secondaryCount);

      if ((lagsByLocation.get(existingLocation) ?? 0) < 2) {
        // The existing location runs a single real LAG — fill its device gap with
        // a ghost mirroring that LAG's own count.
        const partnerE = `${prefix}-partner-${existingLocation}-2`;
        const lagE = `${prefix}-lag-${existingLocation}-2`;
        const awsE = `${prefix}-awsdev-${existingLocation}-2`;
        nodes.push(
          makeGhostNode(partnerE, 'dxPartnerDevice', 'Customer / Partner Device', { details: { locationCode: existingLocation } }),
          makeGhostNode(lagE, 'lag', 'LAG (Recommended)', { details: { locationCode: existingLocation } }),
          makeGhostNode(awsE, 'awsDevice', 'AWS Device', { details: { locationCode: existingLocation } }),
        );
        edges.push(...ghostLagEdges(partnerE, lagE, awsE, primaryCount));
        edges.push(...ghostSinkEdges(awsE, lagSinks));
      }
    }

    const slaLabel = target === 'maximum' ? 'Maximum Resiliency (99.99% SLA)' : 'High Resiliency (99.9% SLA)';
    recs.push({
      id: `rec-lag-single-location${resolvedIds[0] ? `-${resolvedIds[0]}` : ''}`,
      ruleId: 'lag-single-location',
      category: 'resiliency',
      severity: 'info',
      title: 'Add LAG at a Second Direct Connect Location',
      description: `Your LAG topology uses only one Direct Connect location (${existingLocName}). Adding a LAG at a second location provides ${slaLabel} by eliminating single-site failure.`,
      additionalNodes: nodes,
      additionalEdges: edges,
    });
  }

  // Rule 2: 2+ locations but some have <2 LAGs → recommend second LAG per location.
  if (target === 'maximum' && locationCount >= 2) {
    for (const [location, lagCount] of lagsByLocation) {
      if (lagCount >= 2) continue;
      recs.push(makeRedundantDeviceRec(location));
    }
  }

  return recs;
}
