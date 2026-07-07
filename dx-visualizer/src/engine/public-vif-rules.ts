import type { TopologyData, DxNode, DxEdge } from '../types/topology';
import type { Recommendation } from '../types/recommendations';
import { getLocationDeviceCounts, getUsedLocations, getSinkConnectedDevices, findReusableLocation } from './sla-gating';
import { makeGhostNode, makeGhostEdge } from './ghost-helpers';
import { ghostLagEdges } from './ghost-chains';
import type { ResiliencyTarget } from './resiliency-rules';

const TARGET_NODE_ID = 'pub-endpoints';

export function rulePublicVifSingleLocation(
  topology: TopologyData,
  target: ResiliencyTarget = 'high',
  // An existing DX location (elsewhere in the FULL topology) the public VIF can
  // reuse for its redundant path instead of minting a brand-new ghost location.
  // Resolved by the engine; undefined → mint (consistent with the DXGW rule).
  reuseLocationCode?: string,
): Recommendation | null {
  const usedLocations = getUsedLocations(topology);
  if (usedLocations.size >= 2 || usedLocations.size === 0) return null;

  const prefix = 'rec-pubvif';
  const locCode = `${prefix}-loc-B`;
  // Reuse attaches ghost devices to the existing location's container; a minted
  // location uses the synthetic locCode.
  const deviceLocCode = reuseLocationCode ?? locCode;

  // The recommendation path starts at the Customer / Partner Device and flows
  // inward — no customer data center / on-prem router ghost is minted (consistent
  // with the DXGW and LAG rules).
  const nodes: DxNode[] = [];
  if (!reuseLocationCode) {
    nodes.push(makeGhostNode(`${prefix}-dxloc-B`, 'dxLocation', 'Second Direct Connect Location', { details: { code: locCode } }));
  }
  nodes.push(
    makeGhostNode(`${prefix}-partner-B`, 'dxPartnerDevice', 'Customer / Partner Device', { details: { locationCode: deviceLocCode } }),
    makeGhostNode(`${prefix}-awsdev-B`, 'awsDevice', 'AWS Device', { details: { locationCode: deviceLocCode } }),
  );

  const edges: DxEdge[] = [
    makeGhostEdge(`${prefix}-partner-B`, `${prefix}-awsdev-B`),
    makeGhostEdge(`${prefix}-awsdev-B`, TARGET_NODE_ID, 'Public VIF', 0.2),
  ];

  if (target === 'maximum') {
    nodes.push(
      makeGhostNode(`${prefix}-partner-B-2`, 'dxPartnerDevice', 'Customer / Partner Device', { details: { locationCode: deviceLocCode } }),
      makeGhostNode(`${prefix}-awsdev-B-2`, 'awsDevice', 'AWS Device', { details: { locationCode: deviceLocCode } }),
    );
    edges.push(
      makeGhostEdge(`${prefix}-partner-B-2`, `${prefix}-awsdev-B-2`),
      makeGhostEdge(`${prefix}-awsdev-B-2`, TARGET_NODE_ID, 'Public VIF', 0.2),
    );
  }

  const slaLabel = target === 'maximum' ? 'Maximum Resiliency (99.99% SLA)' : 'High Resiliency (99.9% SLA)';
  const reuseText = reuseLocationCode
    ? `Reuse your existing Direct Connect location ${reuseLocationCode}`
    : 'Adding a second location';
  const description = target === 'maximum'
    ? `Your public VIF connectivity uses only one Direct Connect location. ${reuseText} with two redundant connections provides ${slaLabel} by eliminating both site and device failure.`
    : `Your public VIF connectivity uses only one Direct Connect location. ${reuseText} provides ${slaLabel} by eliminating single-site failure.`;

  return {
    id: 'rec-pubvif-single-dx-location',
    ruleId: 'pubvif-single-dx-location',
    category: 'resiliency',
    severity: 'info',
    title: 'Add a Second Direct Connect Location for Public VIF',
    description,
    additionalNodes: nodes,
    additionalEdges: edges,
  };
}

/**
 * Public endpoint MAX recommendation when the public VIF is CARRIED by a
 * DXGW/LAG that already spans 2+ real DX locations (see the multi-site device
 * gap fix in resiliency-rules). The public endpoint has no chain of its own —
 * it rides the carrier — but reaching Maximum (4 total upstream links across
 * >= 2 locations) needs ghost paths the carrier's device-gap fill doesn't cover:
 *
 *   - At each EXISTING location that already feeds the public endpoint, mint a
 *     redundant path (LAG shape where that location runs a LAG, else plain) so
 *     the public link is device-redundant there.
 *   - Reuse a SECOND existing real location (one that feeds the carrier but not
 *     yet the public endpoint) to add a plain/LAG path so the public endpoint
 *     spans 2 sites.
 *
 * The carrier's own device-gap ghost (which already fans out to `pub-endpoints`)
 * is contributed separately by the LAG/DXGW rule and merged in by
 * getRecommendedGraph — this rule does NOT re-mint it. Never mints a new
 * location. Only fires at target === 'maximum'.
 */
export function rulePublicVifCarriedMaxGap(
  topology: TopologyData,
  // The public endpoint's own target. `shortfall` already encodes how many paths
  // to mint, but the target also decides candidate PRIORITY (High wants a second
  // site first; Max additionally wants per-site device redundancy) and the ghost
  // path's description wording.
  target: ResiliencyTarget,
  // Number of ADDITIONAL public sink paths to mint — the shortfall beyond the
  // real public VIFs and the carrier ghost devices that already fan out to
  // `pub-endpoints`. The engine computes this (target 4 for Maximum / 2 for
  // High, minus real + carrier ghosts) so we never exceed the endpoint's sink
  // target or duplicate the carrier's per-location LAG.
  shortfall: number,
): Recommendation[] {
  if (shortfall <= 0) return [];

  // Locations that already feed the public endpoint (a public VIF lives there).
  const connLoc = new Map<string, string | undefined>();
  for (const c of topology.connections) connLoc.set(c.connectionId, c.location);
  const pubLocations = new Set<string>();
  for (const v of topology.virtualInterfaces) {
    if (v.virtualInterfaceType !== 'public') continue;
    const loc = connLoc.get(v.connectionId) ?? v.location;
    if (loc) pubLocations.add(loc);
  }
  if (pubLocations.size === 0) return [];

  // Shape decision follows the PUBLIC endpoint's own existing path per location,
  // not whether the location runs any LAG for some other sink. Scope the sink
  // map to public VIFs (LAG identity still resolved against the full topology so
  // a public VIF landing on a LAG bundle device is flagged LAG). A location that
  // already feeds the public endpoint mirrors ITS public path; a brand-new reuse
  // location (no public path yet) falls back to the location's own LAG presence.
  const pubScope: TopologyData = {
    ...topology,
    virtualInterfaces: topology.virtualInterfaces.filter((v) => v.virtualInterfaceType === 'public'),
  };
  const pubSinkDevices = getSinkConnectedDevices(pubScope, topology);
  const fullSinkDevices = getSinkConnectedDevices(topology);
  const prefix = 'rec-pubvif-max';
  const recs: Recommendation[] = [];
  const slaLabel = target === 'maximum'
    ? 'Maximum Resiliency (99.99% SLA)'
    : 'High Resiliency (99.9% SLA)';

  // `kind` distinguishes a second-SITE path (spans a new location — the High-tier
  // goal) from a same-location DEVICE-redundant path (a Max-tier refinement), so
  // the description matches what the path actually buys.
  const makePath = (location: string, hasLag: boolean, tag: string, kind: 'site' | 'dev', memberCount = 2): Recommendation => {
    const locNode = topology.locations.find((l) => l.locationCode === location);
    const locName = locNode?.locationName ?? location;
    const partnerId = `${prefix}-partner-${location}-${tag}`;
    const awsId = `${prefix}-awsdev-${location}-${tag}`;
    const nodes: DxNode[] = [
      makeGhostNode(partnerId, 'dxPartnerDevice', 'Customer / Partner Device', { details: { locationCode: location } }),
    ];
    const edges: DxEdge[] = [];
    if (hasLag) {
      const lagId = `${prefix}-lag-${location}-${tag}`;
      nodes.push(makeGhostNode(lagId, 'lag', 'LAG (Recommended)', { details: { locationCode: location } }));
      nodes.push(makeGhostNode(awsId, 'awsDevice', 'AWS Device', { details: { locationCode: location } }));
      edges.push(...ghostLagEdges(partnerId, lagId, awsId, memberCount));
    } else {
      nodes.push(makeGhostNode(awsId, 'awsDevice', 'AWS Device', { details: { locationCode: location } }));
      edges.push(makeGhostEdge(partnerId, awsId));
    }
    edges.push(makeGhostEdge(awsId, TARGET_NODE_ID, 'Public VIF', 0.2));
    const description = kind === 'site'
      ? `Adding a public VIF path at ${locName}, a second Direct Connect location, helps the public endpoint reach ${slaLabel} by eliminating single-site failure.`
      : `Adding a redundant public VIF path on a separate AWS device at ${locName} helps the public endpoint reach ${slaLabel} across two Direct Connect locations.`;
    return {
      id: `rec-pubvif-max-${location}-${tag}`,
      ruleId: 'pubvif-carried-max-gap',
      category: 'resiliency',
      severity: 'info',
      title: `Add Redundant Public VIF Path at ${locName}`,
      description,
      additionalNodes: nodes,
      additionalEdges: edges,
    };
  };

  // Two kinds of ghost path (reuse existing locations first, never mint a new site):
  //   - `dev`  — a device-redundant path at an EXISTING public-feeding location
  //              (LAG shape where that location runs a LAG). Closes per-location
  //              redundancy; a Max-tier (99.99%) refinement.
  //   - `site` — a path at a SECOND existing real location that feeds the carrier
  //              but not yet the public endpoint, so the endpoint spans 2 sites.
  //              This is the High-tier (99.9%) goal.
  const devCandidates: Recommendation[] = [];
  for (const location of pubLocations) {
    // Mirror the public endpoint's OWN path at this location, including its LAG's
    // member count so a redundant ghost LAG draws the same number of connections.
    const info = pubSinkDevices.get(location);
    devCandidates.push(makePath(location, info?.hasLag ?? false, 'dev', 'dev', info?.lagMemberCount || 2));
  }
  const reuseLoc = findReusableLocation(topology, pubLocations, getLocationDeviceCounts(topology));
  const reuseInfo = reuseLoc ? fullSinkDevices.get(reuseLoc) : undefined;
  const siteCandidate = reuseLoc
    // No public path here yet → follow whatever this location already runs.
    ? makePath(reuseLoc, reuseInfo?.hasLag ?? false, 'site', 'site', reuseInfo?.lagMemberCount || 2)
    : undefined;

  // Priority for the `shortfall` slice. Site redundancy (reaching a 2nd location)
  // is what a public endpoint needs FIRST — it's the High-tier goal and strictly
  // more valuable than a redundant device at a site the endpoint already reaches.
  // So while the endpoint spans fewer than 2 locations, the `site` candidate leads
  // (a High shortfall of 1 then correctly picks the second location, not a
  // same-location device path). Once it already spans 2+ locations only device
  // redundancy remains meaningful, so `dev` leads and `site` (a 3rd location)
  // trails as a last resort.
  const candidates: Recommendation[] = pubLocations.size < 2 && siteCandidate
    ? [siteCandidate, ...devCandidates]
    : [...devCandidates, ...(siteCandidate ? [siteCandidate] : [])];

  recs.push(...candidates.slice(0, shortfall));
  return recs;
}

export function rulePublicVifSingleConnectionPerLocation(
  topology: TopologyData,
  target: ResiliencyTarget = 'high',
): Recommendation[] {
  if (target === 'high') return [];

  const recs: Recommendation[] = [];
  const locationDevices = getLocationDeviceCounts(topology);
  const prefix = 'rec-pubvif';

  for (const [location, deviceCount] of locationDevices) {
    if (deviceCount >= 2) continue;

    const locNode = topology.locations.find((l) => l.locationCode === location);
    const locName = locNode?.locationName ?? location;

    const nodes: DxNode[] = [
      makeGhostNode(`${prefix}-partner-${location}-2`, 'dxPartnerDevice', 'Customer / Partner Device', { details: { locationCode: location } }),
      makeGhostNode(`${prefix}-awsdev-${location}-2`, 'awsDevice', 'AWS Device', { details: { locationCode: location } }),
    ];

    // Chain starts at the new Customer / Partner Device — no edge back to the
    // location's on-prem / customer data center node (consistent with the DXGW
    // and LAG rules; that customer-side cabling isn't what AWS recommends).
    const edges: DxEdge[] = [
      makeGhostEdge(`${prefix}-partner-${location}-2`, `${prefix}-awsdev-${location}-2`),
      makeGhostEdge(`${prefix}-awsdev-${location}-2`, TARGET_NODE_ID, 'Public VIF', 0.2),
    ];

    const rawConnCount = topology.connections.length > 0
      ? topology.connections.filter((c) => c.location === location).length
      : topology.virtualInterfaces.filter((v) => (v.location ?? '') === location).length;
    const description = rawConnCount >= 2
      ? `Location ${locName} has ${rawConnCount} connections for public VIF, but they terminate on the same AWS logical device. Add a connection on a separate device to reach Maximum Resiliency (99.99% SLA).`
      : `Location ${locName} has only one Direct Connect connection for public VIF. Adding a second connection on a separate device provides Maximum Resiliency (99.99% SLA).`;

    recs.push({
      id: `rec-pubvif-single-conn-${location}`,
      ruleId: 'pubvif-single-connection-per-location',
      category: 'resiliency',
      severity: 'info',
      title: `Add Redundant Connection at ${locName} for Public VIF`,
      description,
      additionalNodes: nodes,
      additionalEdges: edges,
    });
  }

  return recs;
}
