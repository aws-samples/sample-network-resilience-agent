// Per-prefix resilience for a Transit Gateway reached over transit VIFs.
//
// WHY THIS CANNOT BE READ OFF THE TGW ROUTE TABLE. AWS installs only the
// preferred route for a prefix: "A backup route will only appear in the transit
// gateway route table if the previously active route is no longer advertised"
// (https://docs.aws.amazon.com/vpc/latest/tgw/how-transit-gateways-work.html).
// A prefix carried by two DX gateways therefore looks exactly like one carried by
// a single VIF — one row, one attachment. The redundancy is only visible one hop
// back, in the accepted routes of every transit VIF on every DX gateway feeding
// the TGW, which is what `computeDxgwRouteDiff` already compares when given a SET
// of gateways. This module grades each of its rows against the TGW tiers, and
// reads the route table only for what it CAN say: which attachment is active now.

import type { TgwRouteTableWithRoutes, VifRoute } from '../types/aws-resources';
import type { TopologyData } from '../types/topology';
import type { DiffRow, DiffVif, DxgwRouteDiff } from './vif-route-diff';
import { computeDxgwRouteDiff } from './vif-route-diff';

/**
 * How much failure a prefix survives, across every transit VIF reaching the TGW.
 * Ordered worst first; `unknown` sorts last because it is not a finding.
 * - `rejected` — every copy's AS path already contains this TGW's own ASN, so
 *                the TGW discards them all (eBGP loop prevention, RFC 4271
 *                §9.1.2). Accepted on the VIFs, never installed in the TGW.
 * - `none`     — one usable VIF carries it; losing that VIF loses the prefix.
 * - `partial`  — no single other path carries the whole block.
 * - `device`   — every usable carrier terminates on one AWS logical device.
 * - `site`     — every usable carrier sits in one DX location.
 * - `high`     — usable carriers in two or more DX locations.
 * - `maximum`  — two or more locations with two or more devices each (the SLA bar).
 * - `unknown`  — a carrier's location could not be resolved, so the grade cannot
 *                be confirmed either way. Never reported as shared or redundant.
 */
export type PrefixGrade = 'rejected' | 'none' | 'partial' | 'device' | 'site' | 'high' | 'maximum' | 'unknown';

export const PREFIX_GRADE_RANK: Record<PrefixGrade, number> = {
  rejected: 0, none: 1, partial: 2, device: 3, site: 4, high: 5, maximum: 6, unknown: 7,
};

/** Grades that do not survive a DX location failure — the TGW's High bar. */
export function isBelowHigh(grade: PrefixGrade): boolean {
  return grade === 'rejected' || grade === 'none' || grade === 'partial' || grade === 'device' || grade === 'site';
}

/** True when this VIF's copy of `cidr` would be discarded by the TGW. */
export type RejectedCopy = (vifId: string, cidr: string) => boolean;

/** Does a route's AS path already contain `asn`? */
export function asPathContains(route: VifRoute, asn: number): boolean {
  return (route.asPath ?? []).some((seg) => seg.path.includes(asn));
}

/**
 * The copies a TGW with Amazon-side ASN `asn` would discard. Undefined ASN (a
 * cross-account TGW this account cannot describe) means the check cannot run —
 * every copy is treated as usable, and callers say so rather than imply it passed.
 */
export function tgwRejectedCopies(topology: TopologyData, asn: number | undefined): RejectedCopy {
  if (asn == null) return () => false;
  const rejected = new Set<string>();
  for (const [vifId, routes] of topology.vifRoutes ?? []) {
    for (const rt of routes.accepted) if (asPathContains(rt, asn)) rejected.add(`${vifId}|${rt.cidr}`);
  }
  return (vifId, cidr) => rejected.has(`${vifId}|${cidr}`);
}

/**
 * Grade one route-diff row over the copies the TGW would actually use.
 *
 * Carriers are the VIFs that reach the WHOLE prefix — `exact`, or `covered` by a
 * less specific route — minus any copy the TGW rejects (for `covered`, the copy
 * that matters is the covering route). Graded here from those carriers rather than
 * read off `DiffRow.fate`, because fate is computed over every copy including the
 * rejected ones, and a rejected copy is not a path.
 */
export function gradePrefix(row: DiffRow, vifs: DiffVif[], isRejected: RejectedCopy = () => false): PrefixGrade {
  if (row.verdict === 'partial') return 'partial';
  const whole = vifs.filter((v) => {
    const state = row.cells.get(v.vifId)?.state;
    return state === 'exact' || state === 'covered';
  });
  const carriers = whole.filter((v) => {
    const cell = row.cells.get(v.vifId)!;
    return !isRejected(v.vifId, cell.state === 'covered' ? cell.via! : row.cidr);
  });
  if (carriers.length === 0) return whole.length > 0 ? 'rejected' : 'none';
  if (carriers.length === 1) return 'none';
  if (carriers.some((v) => !v.site)) return 'unknown';

  const devicesBySite = new Map<string, Set<string | undefined>>();
  for (const v of carriers) {
    const set = devicesBySite.get(v.site!) ?? new Set();
    set.add(v.device);
    devicesBySite.set(v.site!, set);
  }
  if (devicesBySite.size === 1) {
    // One shared site is known; a shared device only when every device is known.
    const [devices] = [...devicesBySite.values()];
    return devices.size === 1 && !devices.has(undefined) ? 'device' : 'site';
  }
  // Two sites with two known devices each is Maximum (the SLA bar); further
  // single-device sites add paths, they do not lower the grade.
  const redundantSites = [...devicesBySite.values()].filter(
    (devices) => devices.size >= 2 && !devices.has(undefined),
  ).length;
  return redundantSites >= 2 ? 'maximum' : 'high';
}

/** What the TGW route table says about one prefix right now. */
export type ActiveVia =
  /** No route table for this TGW: cross-account, or not fetched / denied. */
  | { state: 'unknown' }
  /** Read the tables, and no route matches this exact prefix. */
  | { state: 'missing'; tableCount: number }
  | {
      state: 'found';
      /** DX gateways the TGW currently forwards this prefix to, across its tables. */
      dxGatewayIds: string[];
      /**
       * The subset of `dxGatewayIds` reached by a STATIC route. A static route is
       * installed whatever BGP says, so the AS-loop check does not apply to it.
       */
      staticDxGatewayIds: string[];
      /** Non-DX attachments it is installed against instead (static route, VPN...). */
      other: { resourceType: string; resourceId: string; type: 'static' | 'propagated' }[];
      blackhole: boolean;
      foundIn: number;
      tableCount: number;
    };

/**
 * Look one prefix up in the TGW's route tables. Exact-match only: a covering
 * aggregate in the table is a different route, and claiming it as this prefix's
 * active path would hide that the more specific one never arrived.
 */
export function activeViaForPrefix(
  tables: TgwRouteTableWithRoutes[] | undefined,
  cidr: string,
): ActiveVia {
  if (!tables || tables.length === 0) return { state: 'unknown' };
  const dx = new Set<string>();
  const staticDx = new Set<string>();
  const other: { resourceType: string; resourceId: string; type: 'static' | 'propagated' }[] = [];
  let foundIn = 0;
  let blackhole = false;
  for (const t of tables) {
    const route = t.routes.find((rt) => rt.destinationCidrBlock === cidr);
    if (!route) continue;
    foundIn += 1;
    if (route.state === 'blackhole') blackhole = true;
    for (const a of route.transitGatewayAttachments) {
      if (a.resourceType === 'direct-connect-gateway') {
        dx.add(a.resourceId);
        if (route.type === 'static') staticDx.add(a.resourceId);
      }
      else if (!other.some((o) => o.resourceId === a.resourceId)) {
        other.push({ resourceType: a.resourceType, resourceId: a.resourceId, type: route.type });
      }
    }
  }
  if (foundIn === 0) {
    // A truncated table may hold it past the cut — absence there proves nothing.
    return tables.some((t) => t.routesTruncated) ? { state: 'unknown' } : { state: 'missing', tableCount: tables.length };
  }
  return { state: 'found', dxGatewayIds: [...dx], staticDxGatewayIds: [...staticDx], other, blackhole, foundIn, tableCount: tables.length };
}

/** One TGW's route resilience, as every surface (node, panel, report, chat) states it. */
export interface TgwRouteResilience {
  diff: DxgwRouteDiff;
  /** The TGW's Amazon-side ASN, when this account can describe the TGW. */
  asn?: number;
  /**
   * The account that owns the TGW, from its DX gateway association — set when that
   * is not the account being read, which is why its ASN and route table are not
   * readable here (unless that account was added as a spoke account at sign-in).
   */
  foreignOwner?: string;
  isRejected: RejectedCopy;
  rows: {
    cidr: string;
    grade: PrefixGrade;
    via: ActiveVia;
    /**
     * The grades and the route table disagree: every copy reads as rejected, yet the
     * TGW has the prefix installed by propagation. That cannot both be current — the
     * VIF routes and the route table were read at different moments.
     */
    mismatch: boolean;
  }[];
  counts: Record<PrefixGrade, number>;
  belowHigh: number;
  /** Route tables were readable, so `via` means something. */
  viaKnown: boolean;
}

/**
 * Grade every on-prem prefix reaching `tgwId` through `dxGatewayIds`. Null when
 * there is nothing to compare (routes not fetched, or fewer than two VIFs with
 * route data) — the same condition as the DX gateway route diff.
 */
export function assessTgwRouteResilience(
  topology: TopologyData,
  tgwId: string,
  dxGatewayIds: Iterable<string>,
): TgwRouteResilience | null {
  const diff = computeDxgwRouteDiff(topology, new Set(dxGatewayIds));
  if (!diff) return null;
  const asn = topology.transitGateways.find((t) => t.transitGatewayId === tgwId)?.amazonSideAsn;
  const tables = topology.tgwRouteTables.get(tgwId);
  // A STATIC route to a DX gateway forwards whatever BGP says, so the AS-loop
  // check does not apply to that gateway's copies of the prefix: they are graded
  // as carriers like any other. (Seen live: tgw01 held 2.2.2.2/32 as a static route
  // while every VIF copy carried its ASN — graded "Rejected" beside an installed route.)
  const staticDxByCidr = new Map<string, Set<string>>();
  for (const t of tables ?? []) {
    for (const rt of t.routes) {
      if (rt.type !== 'static') continue;
      for (const a of rt.transitGatewayAttachments) {
        if (a.resourceType !== 'direct-connect-gateway') continue;
        const set = staticDxByCidr.get(rt.destinationCidrBlock) ?? new Set<string>();
        set.add(a.resourceId);
        staticDxByCidr.set(rt.destinationCidrBlock, set);
      }
    }
  }
  const gatewayOf = new Map(topology.virtualInterfaces.map((v) => [v.virtualInterfaceId, v.directConnectGatewayId]));
  const loopRejected = tgwRejectedCopies(topology, asn);
  const isRejected: RejectedCopy = (vifId, cidr) => {
    if (!loopRejected(vifId, cidr)) return false;
    const gw = gatewayOf.get(vifId);
    return !(gw && staticDxByCidr.get(cidr)?.has(gw));
  };
  const counts = { rejected: 0, none: 0, partial: 0, device: 0, site: 0, high: 0, maximum: 0, unknown: 0 };
  const rows = diff.rows.map((row) => {
    const grade = gradePrefix(row, diff.vifs, isRejected);
    counts[grade] += 1;
    const via = activeViaForPrefix(tables, row.cidr);
    const mismatch = grade === 'rejected' && via.state === 'found'
      && via.dxGatewayIds.some((id) => !via.staticDxGatewayIds.includes(id));
    return { cidr: row.cidr, grade, via, mismatch };
  });
  const association = topology.dxGatewayAssociations.find((a) => a.associatedGateway?.id === tgwId);
  const owner = association?.associatedGateway.ownerAccount;
  const foreignOwner = owner && topology.homeAccountId && owner !== topology.homeAccountId && asn == null ? owner : undefined;
  rows.sort((a, b) => PREFIX_GRADE_RANK[a.grade] - PREFIX_GRADE_RANK[b.grade]);
  return {
    diff,
    asn,
    foreignOwner,
    isRejected,
    rows,
    counts,
    belowHigh: rows.filter((r) => isBelowHigh(r.grade)).length,
    viaKnown: !!tables && tables.length > 0,
  };
}
