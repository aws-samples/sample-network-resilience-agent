// Compare two Direct Connect Gateways against each other.
//
// `computeDxgwRouteDiff` answers "if I lose one VIF on this gateway, what stops
// working?". This answers the gateway-level question: "if I lose gateway A, does
// gateway B carry me?" — which is the one a reader actually asks when an estate
// runs two DXGWs for blast-radius isolation (one per site, or one per DX
// provider, both feeding the same TGW).
//
// The whole difficulty is that a prefix difference between two gateways is only a
// PROBLEM when the gateways serve the same downstream. Within one gateway every
// VIF reaches the same VPCs, so "only one VIF carries this" is unambiguously a
// failover gap. Across gateways it is not: a prod gateway and a dev gateway are
// SUPPOSED to carry disjoint prefixes, and grading them like redundant peers
// would flag every row — the same false-positive flood that made
// "missing from some sibling" the wrong rule inside a single gateway.
//
// So the relationship is resolved first, from `groupDxGatewaysBySharedDownstream`
// (which already unions gateways transitively, including the case where two
// DIFFERENT intermediate TGWs reach the same terminal VPC), and every finding is
// reported against that verdict rather than asserted as a gap.
//
// Two independent axes are compared, and they fail in opposite directions:
//
//  1. `allowedPrefixes` on the DXGW associations — what AWS is permitted to
//     advertise back to on-premises. Config, not BGP state. Always available
//     (it rides along with the login fetch), needs no extra IAM, and works in
//     demo mode and in v1 snapshots. Comparing it across gateways is meaningful
//     in a way that comparing it *within* one gateway is not, because every VIF
//     on one gateway draws from the same association list by construction.
//     Failure mode caught: A permits a wider range than B, so failing over from
//     A to B silently shrinks what on-premises learns.
//
//  2. Accepted BGP routes from `vifRoutes` — what the customer's routers are
//     actually sending in. Real state, but on-demand and permission-gated
//     (`directconnect:ListVirtualInterfaceRoutes`), so this half degrades to an
//     explicit "not fetched" rather than a wrong answer.
//
// Actual *advertised* routes are deliberately not compared. Axis 1 already covers
// that direction from config that is always present, and adding a second,
// sometimes-missing source for the same question would let the two disagree with
// no way to say which is right.

import type { DxGatewayAssociation } from '../types/aws-resources';
import type { TopologyData } from '../types/topology';
import { parseIpRange, rangeCovers } from '../utils/cidr';
import { groupDxGatewaysBySharedDownstream, getGroupLocations } from './downstream-grouping';
import { computeDxgwRouteDiff, type CellState, type DiffCell } from './vif-route-diff';

/** Cap on prefixes listed per bucket. Totals are always exact; see `truncated`. */
const MAX_LISTED = 50;

export interface DxgwIdentity {
  dxGatewayId: string;
  name: string;
  amazonSideAsn?: number;
  state?: string;
  /** VIFs terminating on this gateway. */
  vifCount: number;
  /** Of those, how many have accepted-route data fetched. */
  vifsWithRouteData: number;
  /** DX location codes this gateway's VIFs land in. */
  locations: string[];
}

/**
 * Whether the two gateways serve the same downstream, and so whether a prefix
 * difference between them is a failover gap or the intended design.
 *
 * - `same-routing-domain` — they reach a common TGW / VGW / Cloud WAN core
 *   network / terminal VPC. Differences are gaps.
 * - `independent` — no shared downstream found. Differences are expected;
 *   the comparison is a config diff, not a resiliency finding.
 * - `indeterminate` — at least one gateway's associations are hidden from this
 *   account (`isPrefixPoolStub`), so a shared downstream can be neither
 *   confirmed nor ruled out. Report, never guess.
 */
export type DownstreamVerdict = 'same-routing-domain' | 'independent' | 'indeterminate';

export interface DownstreamTarget {
  id: string;
  type: string;
  region?: string;
}

export interface DownstreamRelationship {
  verdict: DownstreamVerdict;
  sharedTargets: DownstreamTarget[];
  targetsOnlyOnA: DownstreamTarget[];
  targetsOnlyOnB: DownstreamTarget[];
  /** Associations AWS redacted, per gateway. Non-zero forces `indeterminate`. */
  hiddenAssociations: { a: number; b: number };
  /** Why the verdict is what it is, in one sentence, safe to quote verbatim. */
  explanation: string;
}

/** One prefix, and how each gateway relates to it. Vocabulary matches `CellState`. */
export interface PrefixComparisonRow {
  cidr: string;
  addressFamily?: 'ipv4' | 'ipv6';
  onA: CellState;
  onB: CellState;
  /** For a `covered` side: the less specific prefix carrying it there. */
  viaOnA?: string;
  viaOnB?: string;
  /** For a `partial` side: the more specific pieces present inside it there. */
  insideOnA?: string[];
  insideOnB?: string[];
}

export interface PrefixDiff {
  /** Distinct prefixes across both gateways. */
  total: number;
  /** Present verbatim on both. */
  onBoth: number;
  /** On A, and B cannot reach any part of it. The finding, when domains match. */
  onlyOnA: number;
  onlyOnB: number;
  /** On one gateway, reachable on the other only via a less specific route. */
  coarserOnB: number;
  coarserOnA: number;
  /** On one gateway, only partly reachable on the other. */
  partialOnB: number;
  partialOnA: number;
  /** Worst-first, capped at `MAX_LISTED`. Counts above are over ALL prefixes. */
  rows: PrefixComparisonRow[];
  truncated: boolean;
}

export type RouteAvailability =
  | { status: 'available' }
  | { status: 'not-fetched'; reason: string }
  | { status: 'insufficient'; reason: string };

export interface DxgwComparison {
  gatewayA: DxgwIdentity;
  gatewayB: DxgwIdentity;
  relationship: DownstreamRelationship;
  /** Always present — `allowedPrefixes` needs no fetch and no extra permission. */
  allowedPrefixes: {
    /** Per shared downstream target: A's permitted list vs B's for that target. */
    perSharedTarget: Array<{ target: DownstreamTarget; diff: PrefixDiff }>;
    /** Each gateway's union across all its associations. */
    overall: PrefixDiff;
    /** True when neither gateway permits any prefix — nothing to compare. */
    empty: boolean;
  };
  /** Absent unless accepted-route data was fetched for both gateways. */
  acceptedRoutes: { availability: RouteAvailability; diff?: PrefixDiff };
}

// --- prefix grading ---------------------------------------------------------

/**
 * How `cidr` fares against a set of prefixes on the other side. Same four states
 * as the per-VIF matrix, for the same reasons: a covering route still delivers
 * traffic, and fragments inside the block deliver *some* of it, so collapsing
 * either into `absent` overstates the damage.
 */
function gradeAgainst(cidr: string, others: readonly string[]): DiffCell {
  if (others.includes(cidr)) return { state: 'exact' };
  const mine = parseIpRange(cidr);
  if (!mine) return { state: 'absent' };

  let via: string | undefined;
  let viaLen = -1;
  const inside: string[] = [];
  for (const other of others) {
    const or = parseIpRange(other);
    if (!or || or.family !== mine.family) continue;
    if (or.prefixLength < mine.prefixLength) {
      // Longest covering prefix wins — that is the route longest-prefix match
      // would actually pick, so it is the one worth naming.
      if (rangeCovers(or, mine) && or.prefixLength > viaLen) {
        via = other;
        viaLen = or.prefixLength;
      }
    } else if (rangeCovers(mine, or)) {
      inside.push(other);
    }
  }
  if (via) return { state: 'covered', via };
  if (inside.length > 0) return { state: 'partial', inside };
  return { state: 'absent' };
}

const STATE_RANK: Record<CellState, number> = { exact: 3, covered: 2, partial: 1, absent: 0 };

/** Worst first, so the rows that matter survive truncation. */
function rowSeverity(row: PrefixComparisonRow): number {
  return Math.min(STATE_RANK[row.onA], STATE_RANK[row.onB]);
}

function diffPrefixSets(aPrefixes: readonly string[], bPrefixes: readonly string[]): PrefixDiff {
  const a = [...new Set(aPrefixes)];
  const b = [...new Set(bPrefixes)];
  const union = [...new Set([...a, ...b])].sort((x, y) => x.localeCompare(y, undefined, { numeric: true }));

  const rows: PrefixComparisonRow[] = union.map((cidr) => {
    const onA = a.includes(cidr) ? ({ state: 'exact' } as DiffCell) : gradeAgainst(cidr, a);
    const onB = b.includes(cidr) ? ({ state: 'exact' } as DiffCell) : gradeAgainst(cidr, b);
    return {
      cidr,
      addressFamily: parseIpRange(cidr)?.family,
      onA: onA.state,
      onB: onB.state,
      viaOnA: onA.via,
      viaOnB: onB.via,
      insideOnA: onA.inside,
      insideOnB: onB.inside,
    };
  });

  return summarize(rows);
}

function summarize(rows: PrefixComparisonRow[]): PrefixDiff {
  const count = (pred: (r: PrefixComparisonRow) => boolean) => rows.filter(pred).length;
  const sorted = [...rows].sort(
    (x, y) => rowSeverity(x) - rowSeverity(y) || x.cidr.localeCompare(y.cidr, undefined, { numeric: true }),
  );
  return {
    total: rows.length,
    onBoth: count((r) => r.onA === 'exact' && r.onB === 'exact'),
    onlyOnA: count((r) => r.onA === 'exact' && r.onB === 'absent'),
    onlyOnB: count((r) => r.onB === 'exact' && r.onA === 'absent'),
    coarserOnB: count((r) => r.onA === 'exact' && r.onB === 'covered'),
    coarserOnA: count((r) => r.onB === 'exact' && r.onA === 'covered'),
    partialOnB: count((r) => r.onA === 'exact' && r.onB === 'partial'),
    partialOnA: count((r) => r.onB === 'exact' && r.onA === 'partial'),
    rows: sorted.slice(0, MAX_LISTED),
    truncated: sorted.length > MAX_LISTED,
  };
}

// --- relationship -----------------------------------------------------------

function targetsOf(assocs: readonly DxGatewayAssociation[]): { targets: DownstreamTarget[]; hidden: number } {
  const targets: DownstreamTarget[] = [];
  let hidden = 0;
  for (const assoc of assocs) {
    if (assoc.isPrefixPoolStub) {
      hidden++;
      continue;
    }
    if (assoc.associatedGateway?.id) {
      targets.push({
        id: assoc.associatedGateway.id,
        type: assoc.associatedGateway.type ?? 'unknown',
        region: assoc.associatedGateway.region,
      });
    } else if (assoc.associatedCoreNetwork?.id) {
      targets.push({ id: assoc.associatedCoreNetwork.id, type: 'coreNetwork' });
    } else {
      // No gateway, no core network, not flagged as a stub — cannot attribute it.
      hidden++;
    }
  }
  return { targets, hidden };
}

function resolveRelationship(
  topology: TopologyData,
  a: string,
  b: string,
  nameA: string,
  nameB: string,
): DownstreamRelationship {
  const assocsA = topology.dxGatewayAssociations.filter((x) => x.directConnectGatewayId === a);
  const assocsB = topology.dxGatewayAssociations.filter((x) => x.directConnectGatewayId === b);
  const { targets: tA, hidden: hiddenA } = targetsOf(assocsA);
  const { targets: tB, hidden: hiddenB } = targetsOf(assocsB);

  const idsA = new Set(tA.map((t) => t.id));
  const idsB = new Set(tB.map((t) => t.id));
  const byId = new Map<string, DownstreamTarget>([...tA, ...tB].map((t) => [t.id, t]));

  const sharedIds = [...idsA].filter((id) => idsB.has(id));
  const sharedTargets = sharedIds.map((id) => byId.get(id)!);
  const targetsOnlyOnA = [...idsA].filter((id) => !idsB.has(id)).map((id) => byId.get(id)!);
  const targetsOnlyOnB = [...idsB].filter((id) => !idsA.has(id)).map((id) => byId.get(id)!);

  // Direct target overlap is the clearest evidence, but not the only kind: the
  // shared-downstream grouping also unions gateways whose different intermediate
  // TGWs/VGWs reach the same terminal VPC. Ask it too, or a real redundant pair
  // reads as independent.
  const grouped = groupDxGatewaysBySharedDownstream(topology).get(a)?.has(b) ?? false;

  let verdict: DownstreamVerdict;
  let explanation: string;
  if (sharedTargets.length > 0) {
    verdict = 'same-routing-domain';
    explanation = `${nameA} and ${nameB} both associate to ${sharedTargets.map((t) => t.id).join(', ')}, so they serve the same downstream and a prefix reachable through only one of them has no failover path.`;
  } else if (grouped) {
    verdict = 'same-routing-domain';
    explanation = `${nameA} and ${nameB} associate to different intermediate gateways but reach a common downstream VPC, so they serve the same workload and a prefix reachable through only one of them has no failover path.`;
  } else if (hiddenA > 0 || hiddenB > 0) {
    verdict = 'indeterminate';
    explanation = `No shared downstream is visible, but ${hiddenA + hiddenB} association(s) are hidden from this account, so whether ${nameA} and ${nameB} serve the same downstream cannot be confirmed either way. Treat prefix differences as unexplained, not as gaps.`;
  } else {
    verdict = 'independent';
    explanation = `${nameA} and ${nameB} share no downstream gateway, core network, or VPC, so they serve separate routing domains. Differing prefixes are the expected design here, NOT a redundancy gap.`;
  }

  return { verdict, sharedTargets, targetsOnlyOnA, targetsOnlyOnB, hiddenAssociations: { a: hiddenA, b: hiddenB }, explanation };
}

// --- identity ---------------------------------------------------------------

function identify(topology: TopologyData, dxgwId: string): DxgwIdentity | null {
  const gw = topology.dxGateways.find((g) => g.directConnectGatewayId === dxgwId);
  if (!gw) return null;
  const vifs = topology.virtualInterfaces.filter((v) => v.directConnectGatewayId === dxgwId);
  return {
    dxGatewayId: dxgwId,
    name: gw.directConnectGatewayName || dxgwId,
    amazonSideAsn: gw.amazonSideAsn,
    state: gw.directConnectGatewayState,
    vifCount: vifs.length,
    vifsWithRouteData: vifs.filter((v) => topology.vifRoutes?.has(v.virtualInterfaceId)).length,
    locations: [...getGroupLocations(topology, new Set([dxgwId]))].sort(),
  };
}

// --- accepted-route rollup --------------------------------------------------

/**
 * Collapse one prefix's per-VIF cells down to a single state for a gateway. A
 * gateway reaches a prefix as well as its best VIF does, so this is a max over
 * `STATE_RANK` — precedence exact → covered → partial → absent, matching the
 * panel, where full coverage beats fragments.
 */
function rollUp(cells: Map<string, DiffCell>, vifIds: readonly string[]): DiffCell {
  let best: DiffCell = { state: 'absent' };
  for (const vifId of vifIds) {
    const cell = cells.get(vifId);
    if (cell && STATE_RANK[cell.state] > STATE_RANK[best.state]) best = cell;
  }
  return best;
}

function compareAcceptedRoutes(
  topology: TopologyData,
  a: DxgwIdentity,
  b: DxgwIdentity,
): { availability: RouteAvailability; diff?: PrefixDiff } {
  if (!topology.vifRoutes) {
    return {
      availability: {
        status: 'not-fetched',
        reason: 'BGP route data has not been fetched. Turn on Live Status (or click Routes on a VIF edge) to load it. It needs the directconnect:ListVirtualInterfaceRoutes permission, which the directconnect:Describe* wildcard does NOT cover.',
      },
    };
  }
  // "No VIFs at all" and "VIFs whose routes were not fetched" both stop the
  // comparison, but they are different facts and the second one is the dangerous
  // one: unknown prefixes must never be described as absent. A gateway with no
  // VIFs genuinely carries nothing, which is itself worth saying out loud.
  const noVifs = [a, b].filter((g) => g.vifCount === 0);
  if (noVifs.length > 0) {
    return {
      availability: {
        status: 'insufficient',
        reason: `${noVifs.map((g) => `${g.name} (${g.dxGatewayId})`).join(' and ')} ${noVifs.length > 1 ? 'have' : 'has'} no virtual interfaces at all, so ${noVifs.length > 1 ? 'they carry' : 'it carries'} no BGP routes and there is nothing to compare. This is a fact about the gateway, not missing data — a DX Gateway with no VIF provides no connectivity.`,
      },
    };
  }
  const unfetched = [a, b].filter((g) => g.vifsWithRouteData === 0);
  if (unfetched.length > 0) {
    return {
      availability: {
        status: 'insufficient',
        reason: `Route data is loaded for this topology, but none of the VIFs on ${unfetched.map((g) => `${g.name} (${g.dxGatewayId})`).join(' or ')} have any. Its prefixes are UNKNOWN — do not describe them as absent or report the other gateway's prefixes as orphaned.`,
      },
    };
  }

  const diff = computeDxgwRouteDiff(topology, new Set([a.dxGatewayId, b.dxGatewayId]));
  if (!diff) {
    return {
      availability: {
        status: 'insufficient',
        reason: 'Fewer than two VIFs across both gateways have route data, so there is nothing to compare.',
      },
    };
  }

  const vifsA = diff.vifs.filter((v) => v.dxGatewayId === a.dxGatewayId).map((v) => v.vifId);
  const vifsB = diff.vifs.filter((v) => v.dxGatewayId === b.dxGatewayId).map((v) => v.vifId);

  const rows: PrefixComparisonRow[] = diff.rows.map((row) => {
    const onA = rollUp(row.cells, vifsA);
    const onB = rollUp(row.cells, vifsB);
    return {
      cidr: row.cidr,
      addressFamily: row.addressFamily,
      onA: onA.state,
      onB: onB.state,
      viaOnA: onA.via,
      viaOnB: onB.via,
      insideOnA: onA.inside,
      insideOnB: onB.inside,
    };
  });

  return { availability: { status: 'available' }, diff: summarize(rows) };
}

// --- entry point ------------------------------------------------------------

/**
 * Compare two DX Gateways. Returns null only when either id is not in the
 * topology — every other shortfall (no route data, hidden associations, no
 * shared downstream) is reported inside the result rather than by failing, so
 * the caller can say what is missing instead of going quiet.
 */
export function compareDxGateways(
  topology: TopologyData,
  dxgwIdA: string,
  dxgwIdB: string,
): DxgwComparison | null {
  const a = identify(topology, dxgwIdA);
  const b = identify(topology, dxgwIdB);
  if (!a || !b) return null;

  const relationship = resolveRelationship(topology, dxgwIdA, dxgwIdB, a.name, b.name);

  const assocsA = topology.dxGatewayAssociations.filter((x) => x.directConnectGatewayId === dxgwIdA);
  const assocsB = topology.dxGatewayAssociations.filter((x) => x.directConnectGatewayId === dxgwIdB);

  // Per shared target is the precise comparison: the two associations that feed
  // the SAME TGW are the ones whose permitted lists must match for failover to
  // preserve what on-premises learns. The overall union is the fallback view when
  // there is no shared target to key on.
  const perSharedTarget = relationship.sharedTargets.map((target) => ({
    target,
    diff: diffPrefixSets(
      assocsA.filter((x) => x.associatedGateway?.id === target.id || x.associatedCoreNetwork?.id === target.id)
        .flatMap((x) => x.allowedPrefixes ?? []),
      assocsB.filter((x) => x.associatedGateway?.id === target.id || x.associatedCoreNetwork?.id === target.id)
        .flatMap((x) => x.allowedPrefixes ?? []),
    ),
  }));

  const allA = assocsA.flatMap((x) => x.allowedPrefixes ?? []);
  const allB = assocsB.flatMap((x) => x.allowedPrefixes ?? []);
  const overall = diffPrefixSets(allA, allB);

  return {
    gatewayA: a,
    gatewayB: b,
    relationship,
    allowedPrefixes: {
      perSharedTarget,
      overall,
      // An empty permitted list is normal for a VGW association (AWS then
      // advertises the attached VPC CIDRs), so this is "nothing to compare",
      // never "misconfigured".
      empty: allA.length === 0 && allB.length === 0,
    },
    acceptedRoutes: compareAcceptedRoutes(topology, a, b),
  };
}
