import type { TopologyData, DxNode, DxEdge } from '../types/topology';
import type {
  CombinedAssessment,
  ResiliencyLevel,
  Recommendation,
  DxGatewayAssessment,
  VgwAssessment,
  PublicVifAssessment,
  LagAssessment,
} from '../types/recommendations';
import {
  ruleSingleDxLocation,
  ruleSingleConnectionPerLocation,
  ruleNoTgw,
  ruleSingleVgw,
  ruleNoLag,
  ruleLagResiliency,
  type ResiliencyTarget,
} from './resiliency-rules';
import {
  rulePublicVifSingleLocation,
  rulePublicVifSingleConnectionPerLocation,
  rulePublicVifCarriedMaxGap,
} from './public-vif-rules';
import {
  ruleVifDown,
  ruleConnectionNotAvailable,
  ruleEnterpriseSupportRequired,
  ruleWellArchitectedReviewRequired,
  getAllBestPracticeResults,
} from './bestpractice-rules';
import { getLocationDeviceCounts, findReusableLocation, findReusableSinkLocation, getSinkConnectedDevices, getUsedLocations, type SinkDeviceInfo } from './sla-gating';
import { groupDxGatewaysBySharedDownstream, getGroupLocations } from './downstream-grouping';

function determineResiliencyLevel(topology: TopologyData): ResiliencyLevel {
  if (topology.connections.length === 0 && topology.virtualInterfaces.length === 0) return 'none';

  const locationDevices = getLocationDeviceCounts(topology);
  const allLocationsHaveMultiple =
    locationDevices.size > 0 && [...locationDevices.values()].every((c) => c >= 2);

  // AWS Direct Connect SLA page defines three named deployments:
  //  - Multi-Site Redundant    → 99.99% (2+ locations, 2+ devices each)
  //  - Multi-Site Non-Redundant → 99.9%  (2+ locations, 1+ device each)
  //  - Single Connection        → 95.0%  (one Connection, LAG counts as one)
  // "1 location with 2+ devices" is not a named AWS tier, but it's strictly
  // stronger than Single Connection (device redundancy without site redundancy),
  // so we keep it under 'devtest' alongside the single-connection case — both
  // are covered by the Single Connection 95% SLA per Connection.
  if (locationDevices.size >= 2 && allLocationsHaveMultiple) return 'maximum';
  if (locationDevices.size >= 2) return 'high';
  if (locationDevices.size >= 1) return 'devtest';
  return 'none';
}

/**
 * Build a topology view containing only the connections/VIFs/locations/LAGs that
 * feed a specific DX Gateway. Walking VIF→Connection→Location keeps the scope
 * tight so each DXGW is assessed on its own posture.
 */
function buildDxgwScope(topology: TopologyData, dxGatewayId: string): TopologyData {
  return buildDxgwGroupScope(topology, new Set([dxGatewayId]));
}

/**
 * Like `buildDxgwScope` but for a SET of gateways — the combined view of a
 * shared-downstream group. Used to measure the group's per-location device
 * redundancy: when 2+ member gateways reach the same converged TGW/VPC via
 * separate devices at one location, that location already survives a device
 * failure for the shared blast-radius, so no per-gateway device-gap ghost is
 * needed there.
 */
function buildDxgwGroupScope(topology: TopologyData, dxGatewayIds: Set<string>): TopologyData {
  const scopedVifs = topology.virtualInterfaces.filter(
    (v) => v.directConnectGatewayId != null && dxGatewayIds.has(v.directConnectGatewayId),
  );
  const scopedConnIds = new Set(scopedVifs.map((v) => v.connectionId).filter(Boolean) as string[]);
  const scopedConns = topology.connections.filter((c) => scopedConnIds.has(c.connectionId));
  const scopedLocationCodes = new Set<string>();
  for (const c of scopedConns) if (c.location) scopedLocationCodes.add(c.location);
  for (const v of scopedVifs) if (v.location) scopedLocationCodes.add(v.location);
  const scopedLocations = topology.locations.filter((l) => scopedLocationCodes.has(l.locationCode));
  const scopedLags = topology.lags.filter((lag) =>
    lag.connections.some((c) => scopedConnIds.has(c.connectionId)),
  );

  return {
    ...topology,
    connections: scopedConns,
    virtualInterfaces: scopedVifs,
    locations: scopedLocations,
    lags: scopedLags,
  };
}

/**
 * VGW ids reached over Direct Connect — a private VIF terminates on them
 * (`virtualGatewayId` set, no `directConnectGatewayId`) — that the graph
 * actually RENDERS a node for. Only these get the DXGW-style resiliency
 * treatment.
 *
 * "Rendered" means the VGW has a `VpnGateway` record in `topology.vpnGateways`
 * AND at least one VPC attachment in `attached` state — the exact condition
 * under which topology-builder emits a `vgw-<id>` node (an unattached/isolated
 * VGW is not drawn). A VGW referenced ONLY by a VIF (no VpnGateway record — e.g.
 * a partial or filtered snapshot where the EC2 describe was scoped out) is NOT
 * rendered, so we must NOT assess it: its ghost devices would fan into a
 * non-existent `vgw-<id>` sink and render as dangling ghost paths. Skipping it
 * mirrors the DXGW `!hasVif` skip — no node to make redundant.
 *
 * Returned in `topology.vpnGateways` order for deterministic per-VGW card order.
 */
function dxReachedVgwIds(topology: TopologyData): string[] {
  const withDxVif = new Set<string>();
  for (const v of topology.virtualInterfaces) {
    if (v.virtualGatewayId && !v.directConnectGatewayId) withDxVif.add(v.virtualGatewayId);
  }
  return topology.vpnGateways
    .filter((g) => withDxVif.has(g.vpnGatewayId) && g.vpcAttachments.some((a) => a.state === 'attached'))
    .map((g) => g.vpnGatewayId);
}

/**
 * Build a topology view containing only the connections/VIFs/locations/LAGs that
 * feed a specific VGW over Direct Connect. Mirrors buildDxgwScope — the VGW's DX
 * path is assessed on its own site/device posture, exactly like a DXGW.
 */
function buildVgwScope(topology: TopologyData, vgwId: string): TopologyData {
  const scopedVifs = topology.virtualInterfaces.filter(
    (v) => v.virtualGatewayId === vgwId && !v.directConnectGatewayId,
  );
  const scopedConnIds = new Set(scopedVifs.map((v) => v.connectionId).filter(Boolean) as string[]);
  const scopedConns = topology.connections.filter((c) => scopedConnIds.has(c.connectionId));
  const scopedLocationCodes = new Set<string>();
  for (const c of scopedConns) if (c.location) scopedLocationCodes.add(c.location);
  for (const v of scopedVifs) if (v.location) scopedLocationCodes.add(v.location);
  const scopedLocations = topology.locations.filter((l) => scopedLocationCodes.has(l.locationCode));
  const scopedLags = topology.lags.filter((lag) =>
    lag.connections.some((c) => scopedConnIds.has(c.connectionId)),
  );

  return {
    ...topology,
    connections: scopedConns,
    virtualInterfaces: scopedVifs,
    locations: scopedLocations,
    lags: scopedLags,
  };
}

/**
 * Build a topology view containing only standalone public VIFs (no DXGW, no VGW)
 * and their parent connections/locations. Returns null when no such VIFs exist.
 */
export function buildPublicVifScope(topology: TopologyData): TopologyData | null {
  const publicVifs = topology.virtualInterfaces.filter(
    (v) => v.virtualInterfaceType === 'public' && !v.directConnectGatewayId && !v.virtualGatewayId,
  );
  if (publicVifs.length === 0) return null;

  const connIds = new Set(publicVifs.map((v) => v.connectionId).filter(Boolean) as string[]);
  const conns = topology.connections.filter((c) => connIds.has(c.connectionId));
  const locationCodes = new Set<string>();
  for (const c of conns) if (c.location) locationCodes.add(c.location);
  for (const v of publicVifs) if (v.location) locationCodes.add(v.location);
  const locations = topology.locations.filter((l) => locationCodes.has(l.locationCode));
  const lags = topology.lags.filter((lag) =>
    lag.connections.some((c) => connIds.has(c.connectionId)),
  );

  return {
    ...topology,
    connections: conns,
    virtualInterfaces: publicVifs,
    locations,
    lags,
    dxGateways: [],
    dxGatewayAssociations: [],
  };
}

/**
 * Set of connection IDs used by standalone public VIFs (no DXGW/VGW of their
 * own). A DXGW that shares any of these connections is the public VIF's
 * "carrier" — its resilient second location/device already provides the
 * redundant path the public VIF needs, so the DXGW rule fans its ghost devices
 * out to `pub-endpoints` instead of the public-VIF rule minting its own chain.
 */
function standalonePublicVifConnectionIds(topology: TopologyData): Set<string> {
  const ids = new Set<string>();
  for (const v of topology.virtualInterfaces) {
    if (v.virtualInterfaceType === 'public' && !v.directConnectGatewayId && !v.virtualGatewayId && v.connectionId) {
      ids.add(v.connectionId);
    }
  }
  return ids;
}

function runPerDxgwRules(
  scope: TopologyData,
  target: ResiliencyTarget,
  currentLevel: ResiliencyLevel,
  dxGatewayId: string,
  dxGatewayName?: string,
  carriesPublicVif = false,
  reuseLocationCode?: string,
  // Sink-scoped device info for THIS DXGW's own path — built with
  // getSinkConnectedDevices(scope, fullTopology) so the device-gap ghost follows
  // whether THIS gateway is reached via a LAG at that location, not whether the
  // location runs any LAG (which might serve a different sink). The fullTopology
  // lagSource still catches a scoped device that coincides with a LAG bundle
  // device (MGMT-on-LAG-device), even when the scope stripped the LAG members.
  sinkDevicesScoped?: Map<string, SinkDeviceInfo>,
  // When this DXGW belongs to a shared-downstream group that ALREADY spans 2+
  // DX locations across its members, the group is cross-DXGW site-redundant —
  // adding another location for this single gateway is redundant, so suppress
  // the second-location rec. Device-redundancy (ruleSingleConnectionPerLocation)
  // still fires: each site can independently lack a second logical device.
  groupIsSiteRedundant = false,
  // Locations already device-redundant at the shared-downstream GROUP level
  // (2+ converged member gateways reach the same TGW/VPC via separate devices
  // here). The per-location device-gap ghost is suppressed at these locations —
  // the site already survives a device failure for the shared blast-radius.
  groupDeviceRedundantLocations?: Set<string>,
): Recommendation[] {
  const recs: Recommendation[] = [];

  if (scope.lags.length === 0) {
    if (!groupIsSiteRedundant) {
      const singleLocation = ruleSingleDxLocation(scope, target, dxGatewayId, dxGatewayName, carriesPublicVif, reuseLocationCode);
      if (singleLocation) recs.push(singleLocation);
    }

    recs.push(...ruleSingleConnectionPerLocation(scope, target, dxGatewayId, carriesPublicVif, sinkDevicesScoped, groupDeviceRedundantLocations));

    const noLag = ruleNoLag(scope);
    if (noLag) recs.push(noLag);
  }

  const vifDown = ruleVifDown(scope);
  if (vifDown.recommendation) recs.push(vifDown.recommendation);

  const connDown = ruleConnectionNotAvailable(scope);
  if (connDown.recommendation) recs.push(connDown.recommendation);

  // SLA preconditions (tier-dependent, attestation-only since AWS APIs don't
  // expose support-plan or Well-Architected status).
  const enterpriseSupport = ruleEnterpriseSupportRequired(scope, currentLevel, target);
  if (enterpriseSupport.recommendation) recs.push(enterpriseSupport.recommendation);

  const warReview = ruleWellArchitectedReviewRequired(scope, currentLevel, target);
  if (warReview.recommendation) recs.push(warReview.recommendation);

  const severityOrder: Record<string, number> = { critical: 0, warning: 1, info: 2 };
  recs.sort((a, b) => (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3));
  return recs;
}

/**
 * Per-VGW resiliency rules — the VGW analog of runPerDxgwRules. A VGW reached
 * over Direct Connect has the same site/device redundancy posture as a DXGW, so
 * it runs the SAME second-location + redundant-device rules, fanning ghost
 * devices into the `vgw-<id>` node. VGWs never carry a standalone public VIF
 * (that's a DXGW/LAG/standalone concern), so there's no public-carrier branch.
 */
function runPerVgwRules(
  scope: TopologyData,
  target: ResiliencyTarget,
  currentLevel: ResiliencyLevel,
  vgwId: string,
  vgwName?: string,
  reuseLocationCode?: string,
  // VGW-inclusive sink-device info (loc → { hasLag }) so the device-gap ghost
  // mirrors the VGW's real DX path shape (LAG vs plain).
  sinkDevicesFull?: Map<string, SinkDeviceInfo>,
): Recommendation[] {
  const recs: Recommendation[] = [];

  if (scope.lags.length === 0) {
    const singleLocation = ruleSingleDxLocation(scope, target, vgwId, vgwName, false, reuseLocationCode, 'vgw');
    if (singleLocation) recs.push(singleLocation);

    recs.push(...ruleSingleConnectionPerLocation(scope, target, vgwId, false, sinkDevicesFull, undefined, 'vgw'));

    const noLag = ruleNoLag(scope);
    if (noLag) recs.push(noLag);
  }

  const vifDown = ruleVifDown(scope);
  if (vifDown.recommendation) recs.push(vifDown.recommendation);

  const connDown = ruleConnectionNotAvailable(scope);
  if (connDown.recommendation) recs.push(connDown.recommendation);

  const enterpriseSupport = ruleEnterpriseSupportRequired(scope, currentLevel, target);
  if (enterpriseSupport.recommendation) recs.push(enterpriseSupport.recommendation);

  const warReview = ruleWellArchitectedReviewRequired(scope, currentLevel, target);
  if (warReview.recommendation) recs.push(warReview.recommendation);

  const severityOrder: Record<string, number> = { critical: 0, warning: 1, info: 2 };
  recs.sort((a, b) => (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3));
  return recs;
}

export function analyzeTopology(
  topology: TopologyData,
  targets: Record<string, ResiliencyTarget> | ResiliencyTarget = 'high',
): CombinedAssessment {
  const topLevel = determineResiliencyLevel(topology);

  // Zero DX footprint — tiers don't apply. Same signal EmptyStateBanner uses
  // for its "No Direct Connect resources found" card.
  const dxNotInUse =
    topology.connections.length === 0 &&
    topology.virtualInterfaces.length === 0 &&
    topology.dxGateways.length === 0;

  // Targets can be passed per-DXGW (record) or as a single fallback scalar
  // (older callers and tests). Each DXGW resolves its own effective target
  // in the loop below, auto-escalating past tiers the gateway already meets.
  const resolveTarget = (dxGatewayId: string): ResiliencyTarget => {
    if (typeof targets === 'string') return targets;
    return targets[dxGatewayId] ?? 'high';
  };

  // --- Per-DXGW assessments ---
  // When LAGs span 2+ locations with 2+ LAGs each, LAG resiliency is maximum —
  // skip per-DXGW evaluation entirely (the topology is fully redundant through LAGs).
  const lagLocationsMap = new Map<string, number>();
  for (const l of topology.lags) {
    if (l.location) lagLocationsMap.set(l.location, (lagLocationsMap.get(l.location) ?? 0) + 1);
  }
  const lagIsMaximum = lagLocationsMap.size >= 2 && [...lagLocationsMap.values()].every((c) => c >= 2);

  // --- Public VIF carrier resolution (priority: LAG > DXGW > standalone) ---
  // A standalone public VIF is a sink, not its own infrastructure. When its
  // connection also feeds a DXGW or belongs to a LAG, that carrier's resilient
  // second location/device already provides the redundant path — so the carrier
  // rule fans a ghost device out to `pub-endpoints` and we suppress the
  // duplicate standalone rec-pubvif chain.
  const pubConnIds = standalonePublicVifConnectionIds(topology);
  const dxgwConnIds = new Set<string>();
  for (const v of topology.virtualInterfaces) {
    if (v.directConnectGatewayId && v.connectionId) dxgwConnIds.add(v.connectionId);
  }
  const lagConnIds = new Set<string>();
  for (const lag of topology.lags) {
    for (const c of lag.connections) if (c.connectionId) lagConnIds.add(c.connectionId);
  }
  // Only suppress the standalone chain when EVERY standalone public-VIF
  // connection is carried; a genuinely orphan public VIF keeps its own chain.
  const publicVifFullyCarried = pubConnIds.size > 0
    && [...pubConnIds].every((id) => dxgwConnIds.has(id) || lagConnIds.has(id));

  // Resolve the public VIF's own target UP FRONT so a carrier (DXGW/LAG) can be
  // evaluated at least at this tier. The public VIF has no ghost chain of its
  // own when carried — its recommended path IS the carrier's ghost devices — so
  // asking the endpoint for Maximum must escalate the carrier to Maximum too,
  // otherwise the focused public-VIF graph would only show the carrier's lower
  // (e.g. High) recommendation. See getRecommendedGraph's FOCUSED_PUBLIC_VIF path.
  const pubScope = buildPublicVifScope(topology);
  const pubLevel: ResiliencyLevel = pubScope ? determineResiliencyLevel(pubScope) : 'none';
  const userPubTarget: ResiliencyTarget | undefined =
    typeof targets === 'string' ? undefined : targets[FOCUSED_PUBLIC_VIF];
  const pubTarget: ResiliencyTarget = userPubTarget
    ? userPubTarget
    : pubLevel === 'maximum' ? 'maximum' : pubLevel === 'high' ? 'maximum' : 'high';
  const higherTier = (a: ResiliencyTarget, b: ResiliencyTarget): ResiliencyTarget =>
    a === 'maximum' || b === 'maximum' ? 'maximum' : 'high';
  const lagCarriesPublicVif = [...pubConnIds].some((id) => lagConnIds.has(id));

  // Running logical-device count per DX location, seeded from the REAL devices
  // already present. As each DXGW's second-location rec reuses a location, we
  // add its ghost devices here so a subsequent gateway won't overfill the same
  // site — once a location reaches 2 devices (Max cap) the picker moves to the
  // next real location. See findReusableLocation.
  const runningDeviceCounts = getLocationDeviceCounts(topology);

  // Full-topology sink-device info (loc → { deviceCount, hasLag }). Resolved
  // ONCE against the whole topology so per-DXGW rules can tell whether a
  // location's real sink path is LAG-backed even when the DXGW scope strips the
  // LAG out (its member connections carry no DXGW VIF).
  const sinkDevicesFull = getSinkConnectedDevices(topology);

  // Shared-downstream grouping: DXGWs serving the same TGW/VGW/Cloud WAN core
  // form one redundant group. A group that jointly spans 2+ DX locations is
  // already cross-DXGW site-redundant, so its members shouldn't each be told to
  // add a second location (the group as a whole survives a site failure).
  const dxgwGroups = groupDxGatewaysBySharedDownstream(topology);

  // Carrier ghost paths re-minted at the PUBLIC VIF's own target, collected as we
  // walk the carriers (DXGWs here, LAG below). When a carrier's connection also
  // feeds the public endpoint, its ghost devices double as the public path — but
  // the carrier chain in `recommendations` is minted at the ESCALATED tier
  // (max of its own target and the public's). If the carrier's own target is the
  // higher one, that escalated chain would over-draw the public path when the
  // Public VIF row is focused (the reverse of the forward leak). So we stash a
  // copy minted at the public's tier for `publicVif.focusRecommendations`.
  const pubCarrierFocusRecs: Recommendation[] = [];
  // True once any public-carrying carrier was escalated ABOVE the public's tier
  // — only then does the focused public view diverge from the escalated merge,
  // so only then do we populate focusRecommendations (else the well-tested
  // aggregate merge path in getRecommendedGraph stays byte-identical).
  let pubCarrierEscalated = false;

  const perDxGateway: DxGatewayAssessment[] = [];
  for (const gw of topology.dxGateways) {
    const scope = buildDxgwScope(topology, gw.directConnectGatewayId);
    const level = determineResiliencyLevel(scope);
    const userTarget = resolveTarget(gw.directConnectGatewayId);
    // Auto-escalate when the DXGW already meets/exceeds the user's pick so
    // recommendations still surface a next step worth pursuing.
    let effectiveTarget: ResiliencyTarget =
      level === 'maximum' ? 'maximum' : level === 'high' ? 'maximum' : userTarget;
    // A DXGW is "unattached" (for resiliency purposes) when it has no VIFs —
    // no VIFs means no DX location/connection path, so SLA tiering is
    // meaningless regardless of whether the DXGW has TGW/VGW associations on
    // the AWS side. This is intentionally stricter than topology-builder's
    // check (which also requires no associations to move the DXGW into the
    // Unattached zone): consumers of this flag (bulk picker, per-DXGW card)
    // want to skip any gateway whose resiliency posture can't change because
    // there's nothing on the DX side to make redundant.
    const hasVif = topology.virtualInterfaces.some(
      (v) => v.directConnectGatewayId === gw.directConnectGatewayId,
    );
    const hasAssociation = topology.dxGatewayAssociations.some(
      (a) => a.directConnectGatewayId === gw.directConnectGatewayId,
    );
    const isUnattached = !hasVif;
    // This DXGW carries a standalone public VIF when one of its scoped
    // connections is shared with a standalone public VIF — but LAGs take
    // priority, so a connection that belongs to a LAG is left to the LAG rule.
    const carriesPublicVif = scope.lags.length === 0 && scope.connections.some(
      (c) => pubConnIds.has(c.connectionId) && !lagConnIds.has(c.connectionId),
    );
    // The public VIF rides this DXGW's connection and has no chain of its own —
    // escalate to the public VIF's target so a "Maximum" pick on the endpoint
    // materialises the full ghost chain here (the carrier the endpoint reuses).
    // `rawTarget` captures this gateway's OWN tier BEFORE that escalation, so a
    // focused view can render exactly the tier its card shows — a stale Maximum
    // on the co-riding public VIF must not bleed into this gateway's focused
    // canvas (and vice-versa). See `focusRecs` below.
    const rawTarget = effectiveTarget;
    if (carriesPublicVif) effectiveTarget = higherTier(effectiveTarget, pubTarget);
    // Prefer reusing an existing DX location (with spare device capacity) over
    // minting a brand-new ghost site. Only relevant when this gateway is
    // single-location and LAG-free (the case ruleSingleDxLocation fires on).
    const scopeLocations = getUsedLocations(scope);
    // Only reuse when the gateway is single-location AND its shared-downstream
    // group isn't already site-redundant (otherwise the second-location rec is
    // suppressed and there's nothing to reuse a location for).
    const group = dxgwGroups.get(gw.directConnectGatewayId) ?? new Set([gw.directConnectGatewayId]);
    const groupIsSiteRedundant = group.size > 1 && getGroupLocations(topology, group).size >= 2;
    // Locations where the CONVERGED group already has 2+ logical devices: two
    // member gateways sharing the same TGW/VPC each reach it via a separate
    // device here, so the site already survives a device failure for that shared
    // blast-radius — suppress this gateway's per-location device-gap ghost there.
    // (Only meaningful for a real multi-gateway group; a singleton is covered by
    // its own scope device count.)
    const groupDeviceRedundantLocations = group.size > 1
      ? new Set(
          [...getLocationDeviceCounts(buildDxgwGroupScope(topology, group))]
            .filter(([, count]) => count >= 2)
            .map(([loc]) => loc),
        )
      : undefined;
    const reuseLocationCode = !lagIsMaximum && !groupIsSiteRedundant && scope.lags.length === 0 && scopeLocations.size === 1
      ? findReusableLocation(topology, scopeLocations, runningDeviceCounts)
      : undefined;
    // Sink-scoped device map for THIS gateway's device-gap ghost shape: resolved
    // over the DXGW scope so the ghost mirrors how THIS gateway is reached at
    // each location (LAG vs plain), not whether the location runs any LAG. The
    // full topology is the lagSource so a scoped device coinciding with a LAG
    // bundle device (MGMT-on-LAG-device) is still flagged LAG.
    const sinkDevicesScoped = getSinkConnectedDevices(scope, topology);
    const recs = lagIsMaximum
      ? []
      : runPerDxgwRules(
          scope,
          effectiveTarget,
          level,
          gw.directConnectGatewayId,
          gw.directConnectGatewayName,
          carriesPublicVif,
          reuseLocationCode,
          sinkDevicesScoped,
          groupIsSiteRedundant,
          groupDeviceRedundantLocations,
        );
    // Parallel rec set minted at this gateway's OWN (unescalated) target, for the
    // focused canvas view. Same scope / reuse location as `recs` — only the device
    // count differs by tier. Only needed when escalation actually bumped the tier;
    // otherwise the two sets are identical and `recs` is reused (undefined here).
    const focusRecs = !lagIsMaximum && rawTarget !== effectiveTarget
      ? runPerDxgwRules(
          scope,
          rawTarget,
          level,
          gw.directConnectGatewayId,
          gw.directConnectGatewayName,
          carriesPublicVif,
          reuseLocationCode,
          sinkDevicesFull,
          groupIsSiteRedundant,
        )
      : undefined;
    // When this DXGW carries the public VIF, stash a copy of its ghost chain
    // minted at the PUBLIC VIF's tier (not this gateway's escalated tier) so the
    // focused Public VIF view reuses a carrier drawn at the public tier. Only
    // matters — and is only collected — when the carrier was escalated above the
    // public tier (otherwise the escalated chain already equals the public tier
    // and the existing merge path is correct + well-tested).
    if (carriesPublicVif && !lagIsMaximum && effectiveTarget !== pubTarget) {
      pubCarrierEscalated = true;
      // Keep only the ghost paths that actually fan out to `pub-endpoints` —
      // mirrors getRecommendedGraph's carrier-merge filter so the focused public
      // set carries the same carrier ghosts the escalated merge would, just
      // minted at the public tier. scopeToSink later drops their dxgw fan-out.
      pubCarrierFocusRecs.push(
        ...runPerDxgwRules(
          scope,
          pubTarget,
          level,
          gw.directConnectGatewayId,
          gw.directConnectGatewayName,
          carriesPublicVif,
          reuseLocationCode,
          sinkDevicesFull,
          groupIsSiteRedundant,
        ).filter((r) => r.additionalEdges.some((e) => e.target === 'pub-endpoints')),
      );
    }
    // Account for the ghost devices this rec added to the reused location so
    // later gateways see the updated capacity (high → 1 device, maximum → 2).
    // Keyed on the escalated target — the aggregate ("view all") canvas draws the
    // escalated footprint, so that's the capacity later gateways must reason about.
    if (reuseLocationCode) {
      const added = effectiveTarget === 'maximum' ? 2 : 1;
      runningDeviceCounts.set(
        reuseLocationCode,
        (runningDeviceCounts.get(reuseLocationCode) ?? 0) + added,
      );
    }
    const locationCount = new Set(
      scope.connections.map((c) => c.location).filter(Boolean) as string[],
    ).size || new Set(scope.virtualInterfaces.map((v) => v.location).filter(Boolean) as string[]).size;

    perDxGateway.push({
      dxGatewayId: gw.directConnectGatewayId,
      dxGatewayName: gw.directConnectGatewayName || gw.directConnectGatewayId,
      currentLevel: level,
      targetLevel: effectiveTarget,
      locationCount,
      connectionCount: scope.connections.length,
      isUnattached,
      hasVif,
      hasAssociation,
      recommendations: recs,
      focusRecommendations: focusRecs,
    });
  }

  // --- Per-VGW assessments (VGWs reached over Direct Connect) ---
  // A VGW fed by a DX private VIF has the same site/device redundancy posture as
  // a DXGW, so it runs the same second-location + redundant-device rules. Shape
  // (LAG vs plain) follows the VGW's real DX path, so use a VGW-inclusive sink
  // map. Reuse the same runningDeviceCounts so VGW ghost devices spread across
  // sites alongside the DXGW ones.
  const perVgw: VgwAssessment[] = [];
  const vgwIds = dxReachedVgwIds(topology);
  const sinkDevicesWithVgw = vgwIds.length > 0 ? getSinkConnectedDevices(topology, topology, true) : undefined;
  for (const vgwId of vgwIds) {
    const scope = buildVgwScope(topology, vgwId);
    if (scope.virtualInterfaces.length === 0) continue;
    const level = determineResiliencyLevel(scope);
    const userTarget = resolveTarget(vgwId);
    const effectiveTarget: ResiliencyTarget =
      level === 'maximum' ? 'maximum' : level === 'high' ? 'maximum' : userTarget;

    const vgwName = topology.vpnGateways.find((g) => g.vpnGatewayId === vgwId)?.tags?.Name || vgwId;

    const scopeLocations = getUsedLocations(scope);
    const reuseLocationCode = !lagIsMaximum && scope.lags.length === 0 && scopeLocations.size === 1
      ? findReusableLocation(topology, scopeLocations, runningDeviceCounts)
      : undefined;

    const recs = lagIsMaximum
      ? []
      : runPerVgwRules(scope, effectiveTarget, level, vgwId, vgwName, reuseLocationCode, sinkDevicesWithVgw);

    if (reuseLocationCode) {
      const added = effectiveTarget === 'maximum' ? 2 : 1;
      runningDeviceCounts.set(reuseLocationCode, (runningDeviceCounts.get(reuseLocationCode) ?? 0) + added);
    }

    const locationCount = new Set(
      scope.connections.map((c) => c.location).filter(Boolean) as string[],
    ).size || new Set(scope.virtualInterfaces.map((v) => v.location).filter(Boolean) as string[]).size;

    perVgw.push({
      vgwId,
      vgwName,
      currentLevel: level,
      targetLevel: effectiveTarget,
      locationCount,
      connectionCount: scope.connections.length,
      recommendations: recs,
    });
  }

  // --- LAG assessment ---
  // (Computed BEFORE the public VIF assessment: a carried public endpoint reuses
  // the carrier's ghost devices as public sinks, so the public block needs to
  // know how many carrier ghosts already fan out to `pub-endpoints`.)
  // LAG level: 2+ locations with LAGs = maximum, 1 location = devtest.
  // LAGs bundle connections on the same device by design, so per-location device
  // count doesn't apply — 1 LAG per location across 2+ locations is Maximum.
  let lag: LagAssessment | null = null;
  if (topology.lags.length > 0) {
    const lagsByLocation = new Map<string, number>();
    for (const l of topology.lags) {
      if (l.location) lagsByLocation.set(l.location, (lagsByLocation.get(l.location) ?? 0) + 1);
    }
    const lagLocCount = lagsByLocation.size;

    const allLocationsHaveMultipleLags = lagLocCount > 0 && [...lagsByLocation.values()].every((c) => c >= 2);
    const lagLevel: ResiliencyLevel =
      lagLocCount >= 2 && allLocationsHaveMultipleLags ? 'maximum'
        : lagLocCount >= 2 ? 'high'
          : lagLocCount >= 1 ? 'devtest'
            : 'none';

    const userLagTarget: ResiliencyTarget | undefined =
      typeof targets === 'string' ? undefined : targets[FOCUSED_LAG];
    const autoLagTarget: ResiliencyTarget =
      lagLevel === 'maximum' ? 'maximum' : lagLevel === 'high' ? 'maximum' : 'high';
    let lagTarget: ResiliencyTarget = userLagTarget ?? autoLagTarget;
    // LAG owns the public VIF (priority LAG > DXGW) and provides its ghost chain;
    // escalate so a "Maximum" pick on the public VIF materialises here too.
    // `rawLagTarget` is the LAG's OWN tier before that escalation — used for the
    // focused-LAG canvas so a stale Maximum on the public VIF doesn't bleed in.
    const rawLagTarget = lagTarget;
    if (lagCarriesPublicVif) lagTarget = higherTier(lagTarget, pubTarget);

    const allDxgwIds = topology.dxGateways.map((gw) => gw.directConnectGatewayId);
    // Prefer reusing an existing DX location for the second-LAG chain over
    // minting a new ghost site — only applies to the single-location LAG case,
    // which is what mints a location. Reuse is gated on SINK-connected devices:
    // the site must already carry a real DXGW/public path (Rule 1) and not be
    // fully device-redundant already (Rule 2). Whether that site runs a real LAG
    // decides the ghost shape (LAG vs plain non-LAG path).
    const sinkDevices = sinkDevicesFull;
    const lagReuseLoc = lagLocCount < 2
      ? findReusableSinkLocation(topology, lagsByLocation.keys(), sinkDevices)
      : undefined;
    const lagReuseHasLag = lagReuseLoc ? (sinkDevices.get(lagReuseLoc)?.hasLag ?? false) : true;
    const lagRecs = ruleLagResiliency(topology, lagTarget, allDxgwIds, lagReuseLoc, lagReuseHasLag);
    // Parallel LAG rec set at the LAG's own (unescalated) target, for focus view.
    const lagFocusRecs = rawLagTarget !== lagTarget
      ? ruleLagResiliency(topology, rawLagTarget, allDxgwIds, lagReuseLoc, lagReuseHasLag)
      : undefined;
    // If this LAG carries the public VIF and was escalated above the public tier,
    // collect its pub-touching ghosts minted at the PUBLIC tier for the focused
    // public view (mirrors the DXGW-carrier collection in the loop above).
    if (lagCarriesPublicVif && lagTarget !== pubTarget) {
      pubCarrierEscalated = true;
      pubCarrierFocusRecs.push(
        ...ruleLagResiliency(topology, pubTarget, allDxgwIds, lagReuseLoc, lagReuseHasLag)
          .filter((r) => r.additionalEdges.some((e) => e.target === 'pub-endpoints')),
      );
    }
    if (lagReuseLoc) {
      const added = lagTarget === 'maximum' ? 2 : 1;
      runningDeviceCounts.set(lagReuseLoc, (runningDeviceCounts.get(lagReuseLoc) ?? 0) + added);
    }

    lag = {
      currentLevel: lagLevel,
      targetLevel: lagTarget,
      locationCount: lagLocCount,
      lagCount: topology.lags.length,
      recommendations: lagRecs,
      focusRecommendations: lagFocusRecs,
    };
  }

  // --- Public VIF assessment ---
  // pubScope / pubLevel / pubTarget were resolved up front (carrier escalation).
  let publicVif: PublicVifAssessment | null = null;
  if (pubScope) {
    const pubRecs: Recommendation[] = [];
    // Only draw the standalone rec-pubvif chain when no LAG/DXGW carrier owns
    // the public VIF's connection(s). When carried, the carrier's ghost devices
    // already fan out to `pub-endpoints` (see runPerDxgwRules / ruleLagResiliency);
    // the assessment below still reports the endpoint's own tier + a next step.
    if (pubScope.lags.length === 0 && !publicVifFullyCarried) {
      // Prefer reusing an existing DX location (with spare device capacity) over
      // minting a new ghost site, consistent with the DXGW/LAG rules.
      const pubReuseLoc = getUsedLocations(pubScope).size === 1
        ? findReusableLocation(topology, getUsedLocations(pubScope), runningDeviceCounts)
        : undefined;
      const singleLoc = rulePublicVifSingleLocation(pubScope, pubTarget, pubReuseLoc);
      if (singleLoc) pubRecs.push(singleLoc);
      if (pubReuseLoc) {
        const added = pubTarget === 'maximum' ? 2 : 1;
        runningDeviceCounts.set(pubReuseLoc, (runningDeviceCounts.get(pubReuseLoc) ?? 0) + added);
      }
      pubRecs.push(...rulePublicVifSingleConnectionPerLocation(pubScope, pubTarget));
    } else if (publicVifFullyCarried) {
      // Carried public endpoint: it reuses the carrier's (LAG/DXGW) ghost devices
      // as public sinks. The MAX target is 4 total upstream links to
      // `pub-endpoints` (HIGH: 2), so we mint only the SHORTFALL beyond what the
      // real public VIFs and the carrier ghosts (already fanning to
      // `pub-endpoints`) provide — never a duplicate LAG per location, never a
      // new location. getRecommendedGraph merges the carrier ghosts back in.
      const realPubSinks = topology.virtualInterfaces.filter((v) => v.virtualInterfaceType === 'public').length;
      const carrierRecs = [...(lag?.recommendations ?? []), ...perDxGateway.flatMap((g) => g.recommendations)];
      const carrierPubGhosts = carrierRecs.reduce(
        (n, r) => n + r.additionalEdges.filter((e) => e.target === 'pub-endpoints').length,
        0,
      );
      const targetPubSinks = pubTarget === 'maximum' ? 4 : 2;
      const shortfall = Math.max(0, targetPubSinks - realPubSinks - carrierPubGhosts);
      if (shortfall > 0) {
        pubRecs.push(...rulePublicVifCarriedMaxGap(topology, pubTarget, shortfall));
      }
    }
    const pubLocationCount = new Set(
      pubScope.connections.map((c) => c.location).filter(Boolean) as string[],
    ).size || new Set(pubScope.virtualInterfaces.map((v) => v.location).filter(Boolean) as string[]).size;

    // Focused Public VIF view: when a co-riding carrier (DXGW/LAG) was escalated
    // ABOVE the public tier (e.g. the user left a DXGW on Maximum but set the
    // public row to High), `pubRecs` + the escalated carrier merge in
    // getRecommendedGraph would over-draw the public path. Build a self-contained
    // rec set that pairs the carrier re-minted at the PUBLIC tier
    // (`pubCarrierFocusRecs`) with a shortfall recomputed against THAT count, so
    // the focused canvas reflects exactly the public row's own tier. Left
    // undefined otherwise so the well-tested escalated merge path is unchanged.
    let pubFocusRecs: Recommendation[] | undefined;
    if (pubCarrierEscalated) {
      const focusOwn: Recommendation[] = [];
      if (pubScope.lags.length === 0 && !publicVifFullyCarried) {
        // Standalone chain is already minted at the public tier — reuse it.
        focusOwn.push(...pubRecs);
      } else if (publicVifFullyCarried) {
        const realPubSinks = topology.virtualInterfaces.filter((v) => v.virtualInterfaceType === 'public').length;
        const carrierPubGhostsAtPub = pubCarrierFocusRecs.reduce(
          (n, r) => n + r.additionalEdges.filter((e) => e.target === 'pub-endpoints').length,
          0,
        );
        const targetPubSinks = pubTarget === 'maximum' ? 4 : 2;
        const shortfall = Math.max(0, targetPubSinks - realPubSinks - carrierPubGhostsAtPub);
        if (shortfall > 0) focusOwn.push(...rulePublicVifCarriedMaxGap(topology, pubTarget, shortfall));
      }
      pubFocusRecs = [...focusOwn, ...pubCarrierFocusRecs];
    }

    publicVif = {
      currentLevel: pubLevel,
      targetLevel: pubTarget,
      locationCount: pubLocationCount,
      connectionCount: pubScope.connections.length,
      recommendations: pubRecs,
      focusRecommendations: pubFocusRecs,
    };
  }

  // --- Global rules (don't pin to a single DXGW) ---
  const globalResiliencyRecs: Recommendation[] = [];

  const noTgw = ruleNoTgw(topology);
  if (noTgw) globalResiliencyRecs.push(noTgw);

  const singleVgw = ruleSingleVgw(topology);
  if (singleVgw) globalResiliencyRecs.push(singleVgw);

  // Fallback target for the aggregated global view: use the first DXGW's target
  // when one exists, otherwise the scalar (or 'high' default) passed by the caller.
  const globalTarget: ResiliencyTarget = typeof targets === 'string'
    ? targets
    : topology.dxGateways[0]
      ? (targets[topology.dxGateways[0].directConnectGatewayId] ?? 'high')
      : 'high';
  const globalEffectiveTarget: ResiliencyTarget =
    topLevel === 'maximum' ? 'maximum' : topLevel === 'high' ? 'maximum' : globalTarget;

  // If the topology has no DX Gateways at all (test fixtures or edge cases) the
  // per-DXGW loop produces nothing, but the resiliency rules still have useful
  // things to say about connections/VIFs — run them once at the global level.
  if (topology.dxGateways.length === 0) {
    const singleLocation = ruleSingleDxLocation(topology, globalEffectiveTarget);
    if (singleLocation) globalResiliencyRecs.push(singleLocation);
    globalResiliencyRecs.push(...ruleSingleConnectionPerLocation(topology, globalEffectiveTarget));
    const noLag = ruleNoLag(topology);
    if (noLag) globalResiliencyRecs.push(noLag);
    globalResiliencyRecs.push(...ruleLagResiliency(topology, globalEffectiveTarget));
  }

  const bestPractice = getAllBestPracticeResults(topology);
  // VIF-down and connection-not-available are now per-DXGW; strip them from the global list.
  const globalBestPracticeRecs = bestPractice.recommendations.filter(
    (r) => r.ruleId !== 'vif-down' && r.ruleId !== 'connection-not-available',
  );

  // --- Aggregated views (back-compat for callers reading the old shape) ---
  const perDxgwResiliencyRecs = perDxGateway.flatMap((d) =>
    d.recommendations.filter((r) => r.category === 'resiliency'),
  );
  const perDxgwBestPracticeRecs = perDxGateway.flatMap((d) =>
    d.recommendations.filter((r) => r.category === 'bestpractice'),
  );
  const perVgwResiliencyRecs = perVgw.flatMap((d) =>
    d.recommendations.filter((r) => r.category === 'resiliency'),
  );
  const perVgwBestPracticeRecs = perVgw.flatMap((d) =>
    d.recommendations.filter((r) => r.category === 'bestpractice'),
  );
  const pubVifResiliencyRecs = publicVif?.recommendations ?? [];
  const lagResiliencyRecs = lag?.recommendations ?? [];
  const aggregateResiliencyRecs = [...perDxgwResiliencyRecs, ...perVgwResiliencyRecs, ...pubVifResiliencyRecs, ...lagResiliencyRecs, ...globalResiliencyRecs];
  const aggregateBestPracticeRecs = [...perDxgwBestPracticeRecs, ...perVgwBestPracticeRecs, ...globalBestPracticeRecs];

  return {
    dxNotInUse,
    perDxGateway,
    perVgw,
    publicVif,
    lag,
    global: {
      resiliency: {
        currentLevel: topLevel,
        targetLevel: globalEffectiveTarget,
        recommendations: globalResiliencyRecs,
      },
      bestPractice: {
        annotations: bestPractice.annotations,
        recommendations: globalBestPracticeRecs,
      },
    },
    resiliency: {
      currentLevel: topLevel,
      targetLevel: globalEffectiveTarget,
      recommendations: aggregateResiliencyRecs,
    },
    bestPractice: {
      annotations: bestPractice.annotations,
      recommendations: aggregateBestPracticeRecs,
    },
  };
}

export const FOCUSED_PUBLIC_VIF = '__public-vif__';
export const FOCUSED_LAG = '__lag-resiliency__';

export function getRecommendedGraph(
  assessment: CombinedAssessment,
  focusedDxGatewayId?: string | null,
): {
  nodes: DxNode[];
  edges: DxEdge[];
} {
  const nodes: DxNode[] = [];
  const edges: DxEdge[] = [];

  // A shared carrier ghost device fans out to BOTH the DXGW (`dxgw-<id>`, the
  // private/transit path) and `pub-endpoints` (the public path). When the user
  // focuses one specific entity, they expect to see only THAT entity's path —
  // the DXGW row shows only the private path, the Public Endpoints row only the
  // public path (both together are what "View all" is for). Drop terminal edges
  // that lead to a foreign sink, then prune any ghost node left with no edges.
  // Container categories (the ghost DX location "zone", region, customer site)
  // are positioned by their `locationCode`, NOT by edges — they legitimately
  // have no adjacency, so they must survive the prune below or the zone box
  // disappears while its leaf devices remain.
  const containerCats = new Set(['dxLocation', 'region', 'customerSite']);
  const scopeToSink = (
    isForeignSink: (targetId: string) => boolean,
  ): { nodes: DxNode[]; edges: DxEdge[] } => {
    const keptEdges = edges.filter((e) => !isForeignSink(e.target));
    const connected = new Set<string>();
    for (const e of keptEdges) { connected.add(e.source); connected.add(e.target); }
    // Keep a node if it still has an edge OR it's a container (edgeless by design).
    return {
      nodes: nodes.filter((n) => connected.has(n.id) || containerCats.has(n.data.category)),
      edges: keptEdges,
    };
  };

  // When a specific entity is focused, emit only its ghost nodes so the canvas
  // isn't cluttered with ghosts from all gateways at once.
  if (focusedDxGatewayId === FOCUSED_PUBLIC_VIF) {
    // Dedup by id: the public endpoint's own recs and the carrier's
    // pub-touching ghost can be merged together (a carried Maximum endpoint has
    // both), and a carrier node must not be added twice.
    const seenNodes = new Set<string>();
    const seenEdges = new Set<string>();
    const pushRec = (rec: Recommendation) => {
      for (const n of rec.additionalNodes) if (!seenNodes.has(n.id)) { seenNodes.add(n.id); nodes.push(n); }
      for (const e of rec.additionalEdges) if (!seenEdges.has(e.id)) { seenEdges.add(e.id); edges.push(e); }
    };

    // When a co-riding carrier was escalated ABOVE the public tier, the engine
    // pre-built a self-contained `focusRecommendations` (public own recs + carrier
    // ghosts minted at the PUBLIC tier). Use it verbatim so the focused canvas
    // reflects the public row's own tier instead of the escalated carrier — this
    // set already includes the carrier's pub-touching ghosts, so skip the merge.
    if (assessment.publicVif?.focusRecommendations) {
      for (const rec of assessment.publicVif.focusRecommendations) pushRec(rec);
      return scopeToSink((t) => t.startsWith('dxgw-'));
    }

    const recs = assessment.publicVif?.recommendations ?? [];
    for (const rec of recs) pushRec(rec);

    // When a LAG or DXGW carries the public VIF, the carrier's recs contain the
    // pub-endpoints edges — always merge the carrier ghost paths that touch
    // `pub-endpoints` so the user sees the reused carrier device alongside the
    // public endpoint's own added paths. Only include carrier recs that actually
    // touch `pub-endpoints` to avoid pulling in unrelated ghost infrastructure.
    // We reach here only when no carrier was escalated ABOVE the public tier (the
    // escalated-carrier case returned early above), so every carrier's escalated
    // `recommendations` is already minted at the public tier — exactly what the
    // public focus wants. Using their lower-tier focusRecommendations here would
    // UNDER-draw the public path.
    const carrierRecs = [
      ...(assessment.lag?.recommendations ?? []),
      ...assessment.perDxGateway.flatMap((g) => g.recommendations),
    ];
    for (const rec of carrierRecs) {
      if (rec.additionalEdges.some((e) => e.target === 'pub-endpoints')) pushRec(rec);
    }
    // Public VIF focus shows only the public path — drop the carrier's private
    // fan-out to any DXGW so this row doesn't mirror the DXGW recommendation.
    return scopeToSink((t) => t.startsWith('dxgw-'));
  }

  if (focusedDxGatewayId === FOCUSED_LAG) {
    // Focused LAG reflects its OWN tier — use focusRecommendations (minted at the
    // LAG's raw target) when a co-riding public VIF escalated the aggregate set.
    const recs = assessment.lag?.focusRecommendations ?? assessment.lag?.recommendations ?? [];
    for (const rec of recs) {
      nodes.push(...rec.additionalNodes);
      edges.push(...rec.additionalEdges);
    }
    return { nodes, edges };
  }

  // A focused VGW emits only its own ghost recs — its devices fan solely into
  // `vgw-<id>` (VGWs don't share a carrier device with a DXGW/public endpoint),
  // so there's nothing foreign to scope out. Checked before the generic DXGW
  // branch below so a VGW focus id isn't mis-looked-up in perDxGateway.
  const vgwMatch = assessment.perVgw.find((g) => g.vgwId === focusedDxGatewayId);
  if (vgwMatch) {
    for (const rec of vgwMatch.recommendations.filter((r) => r.category === 'resiliency')) {
      nodes.push(...rec.additionalNodes);
      edges.push(...rec.additionalEdges);
    }
    return { nodes, edges };
  }

  if (focusedDxGatewayId) {
    // Dedup by id so a carrier ghost path (see below) isn't added twice when it
    // also appears in the DXGW's own recs.
    const seenNodes = new Set<string>();
    const seenEdges = new Set<string>();
    const pushRec = (rec: Recommendation) => {
      for (const n of rec.additionalNodes) if (!seenNodes.has(n.id)) { seenNodes.add(n.id); nodes.push(n); }
      for (const e of rec.additionalEdges) if (!seenEdges.has(e.id)) { seenEdges.add(e.id); edges.push(e); }
    };

    // Focused DXGW reflects its OWN tier — use focusRecommendations (minted at the
    // gateway's raw target) when a co-riding public VIF escalated the aggregate
    // set, so a stale Maximum on the public row doesn't leak into this view.
    const match = assessment.perDxGateway.find((g) => g.dxGatewayId === focusedDxGatewayId);
    const matchRecs = match?.focusRecommendations ?? match?.recommendations ?? [];
    const recs = matchRecs.filter((r) => r.category === 'resiliency');
    for (const rec of recs) pushRec(rec);

    // When a LAG carries this DXGW (its member connections feed the DXGW's VIFs),
    // the recommended second location/device is minted by the LAG rule, not the
    // DXGW rule — so this gateway's own resiliency recs are empty and focusing it
    // would otherwise render a blank canvas. The LAG's ghost paths terminate on
    // this DXGW node (`dxgw-<id>`), so merge in any carrier ghost path whose edge
    // targets this gateway. Mirrors the FOCUSED_PUBLIC_VIF carrier-merge above.
    const dxgwNodeId = `dxgw-${focusedDxGatewayId}`;
    const carrierRecs = assessment.lag?.focusRecommendations ?? assessment.lag?.recommendations ?? [];
    for (const rec of carrierRecs) {
      if (rec.additionalEdges.some((e) => e.target === dxgwNodeId)) pushRec(rec);
    }
    // DXGW focus shows only this gateway's private path — drop the carrier's
    // public fan-out to `pub-endpoints`, and any OTHER DXGW sink a shared carrier
    // device might feed, so this row doesn't mirror the Public Endpoints (or a
    // sibling DXGW's) recommendation.
    return scopeToSink((t) => t === 'pub-endpoints' || (t.startsWith('dxgw-') && t !== dxgwNodeId));
  }

  for (const rec of assessment.resiliency.recommendations) {
    nodes.push(...rec.additionalNodes);
    edges.push(...rec.additionalEdges);
  }

  return { nodes, edges };
}
