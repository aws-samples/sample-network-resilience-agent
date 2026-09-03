// Cross-VIF prefix comparison for one Direct Connect Gateway.
//
// `ruleConsistentPrefixAdvertisement` reports that redundant VIFs accept
// different prefix sets, but a finding sentence can only name a few prefixes.
// This is the interactive counterpart: one row per prefix on the gateway, one
// column per VIF, so "which prefixes have no failover path?" is a single read.
// A prefix carried by only one VIF has no backup — that VIF goes down and the
// destination is unreachable, with nothing in the console saying so.
//
// The matrix is the UNION of every VIF's prefixes with a column for every VIF,
// including the ones that carry the prefix. An earlier version listed one
// selected VIF's prefixes against N-1 "peer" columns, which meant the column set
// changed every time you switched tabs — the reader had to re-learn the table on
// each click, and a prefix absent from the selected VIF was invisible.
//
// Only ACCEPTED routes are compared. Advertised routes come from the gateway's
// association `allowedPrefixes`, which is per-association, so every VIF on one
// DXGW draws from the same set by construction — comparing them can only
// surface BGP convergence noise, never a misconfiguration.
//
// A SECOND, ORTHOGONAL QUESTION: shared fate.
//
// The verdict above counts VIFs, which answers "what if I lose one VIF?". It
// cannot answer "what if I lose one AWS logical device, or one DX location?" —
// and those take out several VIFs at once. Two VIFs on the same logical device
// look like a reassuring pair of exact matches and are one maintenance event from
// a blackhole; two VIFs in the same DX location survive maintenance but not a site
// failure. So a `redundant` verdict on its own can be a false all-clear.
//
// `DiffRow.fate` records that, computed over the row's CARRIERS (the VIFs that
// keep the whole prefix reachable — `exact` or `covered`; a `partial` fragment is
// not a surviving path for the block). Three deliberate choices:
//
//   - Only rows that currently look SAFE (`redundant` / `covered`) are graded. A
//     `solo` row is single-VIF by definition, hence trivially single-device and
//     single-site; flagging it would add a second warning to something already
//     red. The value here is converting false-safe rows into flagged ones.
//   - A logical device lives in exactly one location, so single-device implies
//     single-site. Only the TIGHTEST scope is reported, or every device finding
//     would double-report as a site finding too.
//   - An unknown device or location is not a shared one. If any carrier's domain
//     is unresolvable the row is left unflagged, the same way
//     `ruleDxgwPropagationEnabled` skips tables whose propagations are unknown
//     rather than reporting a blackhole from a missing field.
//
// No new API call: this reads `topology.vifRoutes`, already fetched on demand by
// the Routes button on a VIF edge, and `awsLogicalDeviceId` / `location` ride
// along on DescribeVirtualInterfaces / DescribeConnections.

import type { DxVirtualInterface, VifRoute } from '../types/aws-resources';
import type { TopologyData } from '../types/topology';
import { parseIpRange, rangeCovers, type IpRange } from '../utils/cidr';

export interface DiffVif {
  vifId: string;
  /**
   * `virtualInterfaceName`, falling back to the VIF ID. Deliberately never the
   * connection name — and on a hosted-VIF account those can be the same string,
   * because `fetch-topology.ts` names an *inferred* connection after the VIF
   * that revealed it. The panel shows `vifId` alongside this so a reader can
   * tell which of the two they are looking at.
   */
  label: string;
  vifType: string;
  /** Parent connection, shown in tooltips to keep VIF and connection distinct. */
  connectionId?: string;
  /**
   * The gateway this VIF terminates on. Redundant when the comparison is scoped
   * to a single DXGW (every VIF has the same one), but `compareDxGateways` scopes
   * it to several and then needs to attribute each column to its gateway.
   */
  dxGatewayId?: string;
  /**
   * 1-based position in `DxgwRouteDiff.vifs`. Matrix columns are labelled with
   * this number rather than a truncated name: VIF names on one gateway routinely
   * share both a prefix and a suffix (`cwnm-poc-primary-x` vs
   * `cwnm-poc-secondary-x`), so no fixed-width abbreviation stays unambiguous.
   * The tab bar carries the full names and acts as the legend.
   */
  index: number;
  /**
   * Where this VIF terminates — the two failure domains `DiffRow.fate` grades on.
   * Carried on the column so the panel can name them without re-deriving, and
   * either may be absent (see `resolveVifFates`); absent is *unknown*, never
   * "not shared".
   */
  device?: string;
  site?: string;
}

/**
 * How one VIF relates to one prefix.
 * - `exact`   — this VIF accepts the prefix itself.
 * - `covered` — it has no such prefix but does have a less specific one that
 *               contains it. Traffic still reaches the destination via this VIF,
 *               just on a coarser route.
 * - `partial` — it carries only more specific pieces *inside* the prefix. Some
 *               of the range is reachable here and some is not, so this is
 *               neither safe nor a total loss. Reporting it as `absent` would
 *               claim traffic is dropped that in fact still flows; reporting it
 *               as `covered` would hide a genuine hole.
 * - `absent`  — this VIF cannot reach any part of the prefix.
 */
export type CellState = 'exact' | 'covered' | 'partial' | 'absent';

export interface DiffCell {
  state: CellState;
  /** For `covered`: the less specific prefix on this VIF that carries it. */
  via?: string;
  /** For `partial`: this VIF's more specific prefixes that fall inside it. */
  inside?: string[];
}

/**
 * How well a prefix survives losing the VIF (or VIFs) that carry it.
 * Ranked worst first, which is also the panel's default row order.
 */
export type RowVerdict = 'solo' | 'partial' | 'covered' | 'redundant';

/**
 * The correlated-failure domain that every carrier of one prefix shares, when they
 * share one. `scope` is the tightest that applies:
 * - `device` — all carriers terminate on one AWS logical device, so a Direct
 *   Connect maintenance event on it leaves the prefix with no path.
 * - `site`   — all carriers sit in one DX location (on different devices), so the
 *   prefix survives device maintenance but not a location failure.
 */
export interface SharedFate {
  scope: 'device' | 'site';
  /** The `awsLogicalDeviceId` or `location` code shared by every carrier. */
  id: string;
  /** The carriers riding it — by definition of shared fate, all of them. */
  vifIds: string[];
}

export interface DiffRow {
  cidr: string;
  addressFamily?: 'ipv4' | 'ipv6';
  /** Keyed by every `vifId` on the gateway — owners included, never sparse. */
  cells: Map<string, DiffCell>;
  /** VIFs accepting this exact prefix. Always at least one. */
  owners: string[];
  /** VIFs accepting this exact prefix (`owners.length`). */
  exactCount: number;
  /** VIFs covering it whole via a less specific prefix. */
  coveredCount: number;
  /** VIFs carrying only more specific pieces inside it. */
  partialCount: number;
  verdict: RowVerdict;
  /**
   * Set only when the verdict reads safe (`redundant` / `covered`) AND every
   * carrier shares one failure domain — i.e. the redundancy the verdict reports is
   * illusory against that domain. Absent means either the row is already flagged by
   * its verdict, the carriers are genuinely diverse, or their device / location
   * could not be resolved (unknown is never reported as shared).
   */
  fate?: SharedFate;
}

/** Per-VIF tallies over the prefixes that VIF accepts — drives the tab badges. */
export interface VifDiff {
  vif: DiffVif;
  /** Prefixes this VIF accepts. */
  rowCount: number;
  /** Of those, prefixes no other VIF can reach any part of. */
  soloCount: number;
  /** Of those, prefixes only partly reachable elsewhere. */
  partialCount: number;
  /** Of those, prefixes covered whole elsewhere but only by a coarser route. */
  looseCount: number;
  /**
   * Of those, prefixes whose every carrier shares one logical device / one DX
   * location. Unlike `soloCount` and `partialCount`, these do NOT sum to the
   * gateway totals across tabs: a shared-fate row has two or more carriers by
   * construction, so every carrier's tab counts the same row. The panel shows the
   * gateway-wide figure in its summary and scopes these to "this VIF's prefixes".
   */
  sharedDeviceCount: number;
  sharedSiteCount: number;
}

export interface DxgwRouteDiff {
  vifs: DiffVif[];
  /** Every distinct prefix on the gateway, in prefix order. */
  rows: DiffRow[];
  byVif: Map<string, VifDiff>;
  /** Prefixes carried by one VIF with no other path at all. */
  totalSolo: number;
  /** Prefixes whose only other path is a less specific route. */
  totalLoose: number;
  /** Prefixes only partly reachable from any other VIF. */
  totalPartial: number;
  /**
   * Prefixes that read as redundant but whose every carrier terminates on one AWS
   * logical device — a DX maintenance event on it blackholes them.
   */
  totalSharedDevice: number;
  /** Prefixes whose every carrier sits in one DX location. */
  totalSharedSite: number;
}

/** Deduplicate by prefix — the same CIDR twice on one VIF would double every row. */
function uniqueByCidr(routes: VifRoute[]): VifRoute[] {
  const seen = new Set<string>();
  const out: VifRoute[] = [];
  for (const rt of routes) {
    if (seen.has(rt.cidr)) continue;
    seen.add(rt.cidr);
    out.push(rt);
  }
  return out;
}

/** Where one VIF physically terminates. Either field may be unresolvable. */
interface VifFate {
  /** AWS logical device holding this VIF's BGP session. */
  device?: string;
  /** DX location code that device sits in. */
  site?: string;
}

/**
 * Resolve the failure domains of every VIF in the comparison.
 *
 * Device comes from the VIF record first: a VIF terminates on exactly one logical
 * device, so `DxVirtualInterface.awsLogicalDeviceId` is the direct statement of it.
 * Its accepted routes' `awsLogicalDeviceId` is the fallback for records that arrive
 * without the field, and is trusted only when every route that carries one agrees —
 * a split would mean the VIF is not on a single device, so "shared" could not be
 * claimed honestly.
 *
 * Location comes from the VIF, then from its parent connection, which is where
 * DescribeConnections reports it.
 */
function resolveVifFates(
  topology: TopologyData,
  vifs: DiffVif[],
  vifRoutes: NonNullable<TopologyData['vifRoutes']>,
): Map<string, VifFate> {
  const byId = new Map(topology.virtualInterfaces.map((v) => [v.virtualInterfaceId, v]));
  const connLocation = new Map(topology.connections.map((c) => [c.connectionId, c.location]));

  const out = new Map<string, VifFate>();
  for (const { vifId } of vifs) {
    const v = byId.get(vifId);
    let device = v?.awsLogicalDeviceId || undefined;
    if (!device) {
      const fromRoutes = new Set(
        (vifRoutes.get(vifId)?.accepted ?? [])
          .map((rt) => rt.awsLogicalDeviceId)
          .filter((d): d is string => !!d),
      );
      if (fromRoutes.size === 1) device = [...fromRoutes][0];
    }
    const site = v?.location || (v ? connLocation.get(v.connectionId) : undefined) || undefined;
    out.set(vifId, { device, site });
  }
  return out;
}

/**
 * Do these carriers all share one failure domain? Returns the tightest that
 * applies, or undefined when they are diverse — or when any carrier's domain is
 * unknown, since an unresolved device is not a shared device.
 */
function gradeFate(carriers: string[], fates: Map<string, VifFate>): SharedFate | undefined {
  if (carriers.length < 2) return undefined;

  // Device first: it is the tighter domain, and it implies the site, so reporting
  // both would double-count one finding.
  const devices = carriers.map((id) => fates.get(id)?.device);
  if (devices.every((d): d is string => d != null) && new Set(devices).size === 1) {
    return { scope: 'device', id: devices[0], vifIds: carriers };
  }

  const sites = carriers.map((id) => fates.get(id)?.site);
  if (sites.every((s): s is string => s != null) && new Set(sites).size === 1) {
    return { scope: 'site', id: sites[0], vifIds: carriers };
  }

  return undefined;
}

/**
 * Compare accepted prefixes across the VIFs on one Direct Connect Gateway — or,
 * when `dxGatewayId` is a set, across the VIFs on several gateways at once. The
 * multi-gateway form is what `compareDxGateways` builds on; the grading rule is
 * identical, since a prefix carried by one VIF has no failover path regardless of
 * how the scope was drawn. Interpreting that as a *problem* is the caller's job:
 * across gateways that serve unrelated downstreams, disjoint prefixes are the
 * intended design, not a gap (see `dxgw-compare.ts`).
 *
 * `compareVifIds` narrows the comparison to a subset — pass two VIF IDs to ask
 * "if I lose one of *these two*, does the other cover me?". The grading rule is
 * untouched; it is simply applied to whichever VIFs are in scope. So a prefix
 * that reads `redundant` gateway-wide can correctly read `solo` inside a pair
 * that excludes its other carrier, and that is the whole point of narrowing:
 * scoping the columns while keeping gateway-wide verdicts would show a prefix
 * marked safe next to a single ✓, hiding the very gap being looked for. Fewer
 * than two IDs (or omitted) compares every VIF on the gateway.
 *
 * Returns null when there is nothing to compare — fewer than two VIFs *in scope*
 * have route data, because they were never fetched, the
 * `directconnect:ListVirtualInterfaceRoutes` permission is missing, or the
 * gateway genuinely has a single VIF (which the resiliency rules already flag as
 * a single point of failure in its own right).
 */
export function computeDxgwRouteDiff(
  topology: TopologyData,
  dxGatewayId: string | ReadonlySet<string>,
  compareVifIds?: ReadonlySet<string>,
): DxgwRouteDiff | null {
  const vifRoutes = topology.vifRoutes;
  if (!vifRoutes) return null;

  const inScope = typeof dxGatewayId === 'string'
    ? (id: string | undefined) => id === dxGatewayId
    : (id: string | undefined) => id != null && dxGatewayId.has(id);

  // Public VIFs have no DXGW, so this filter excludes them for free — their
  // prefixes come from `routeFilterPrefixes` and are not a redundancy pair.
  const onGateway: DxVirtualInterface[] = topology.virtualInterfaces
    .filter((v) => inScope(v.directConnectGatewayId) && vifRoutes.has(v.virtualInterfaceId))
    // Gateway first, then name. With a single-gateway scope every VIF shares one
    // gateway id, so the first comparison is always 0 and this is exactly the
    // name sort it has always been; with several, it keeps each gateway's columns
    // contiguous instead of interleaving them by name.
    .sort((a, b) =>
      (a.directConnectGatewayId ?? '').localeCompare(b.directConnectGatewayId ?? '')
      || (a.virtualInterfaceName || a.virtualInterfaceId).localeCompare(
        b.virtualInterfaceName || b.virtualInterfaceId,
        undefined,
        { numeric: true },
      ),
    );

  // Column numbers are assigned over the WHOLE gateway *before* narrowing, so a
  // VIF keeps the same number whichever subset is in scope. Renumbering per
  // selection would silently redefine what "3" means between two clicks, and the
  // panel keeps out-of-scope columns on screen as re-add affordances.
  const numbered = onGateway.map((v, i) => ({ vif: v, index: i + 1 }));
  const scoped = compareVifIds && compareVifIds.size >= 2
    ? numbered.filter(({ vif }) => compareVifIds.has(vif.virtualInterfaceId))
    : numbered;
  if (scoped.length < 2) return null;

  const vifs: DiffVif[] = scoped.map(({ vif: v, index }) => ({
    vifId: v.virtualInterfaceId,
    label: v.virtualInterfaceName || v.virtualInterfaceId,
    vifType: v.virtualInterfaceType,
    connectionId: v.connectionId,
    dxGatewayId: v.directConnectGatewayId || undefined,
    index,
  }));

  // Resolved once for the whole comparison rather than per row: an N-VIF gateway
  // with M prefixes would otherwise walk the VIF and connection lists M times.
  // Stamped onto the columns too, so the panel names a carrier's device/location
  // from the same source that graded it.
  const vifFates = resolveVifFates(topology, vifs, vifRoutes);
  for (const v of vifs) {
    const f = vifFates.get(v.vifId);
    v.device = f?.device;
    v.site = f?.site;
  }

  // Per VIF: its accepted prefixes and a set for exact lookups. Ranges are
  // parsed once and shared across the whole comparison — an N-VIF gateway would
  // otherwise reparse the same CIDR N times per row.
  const accepted = new Map<string, VifRoute[]>();
  const prefixSets = new Map<string, Set<string>>();
  const ranges = new Map<string, IpRange | null>();
  // Union of every prefix on the gateway. Address family comes from whichever
  // VIF was seen first, which is safe: it is a property of the CIDR itself.
  // `routeInstalledAt` deliberately is NOT carried here — each VIF installed the
  // route at its own time, so a single value on a union row would be arbitrary.
  const union = new Map<string, 'ipv4' | 'ipv6' | undefined>();
  for (const v of vifs) {
    const rts = uniqueByCidr(vifRoutes.get(v.vifId)!.accepted);
    accepted.set(v.vifId, rts);
    prefixSets.set(v.vifId, new Set(rts.map((rt) => rt.cidr)));
    for (const rt of rts) {
      if (!ranges.has(rt.cidr)) ranges.set(rt.cidr, parseIpRange(rt.cidr));
      if (!union.has(rt.cidr)) union.set(rt.cidr, rt.addressFamily);
    }
  }

  const rows: DiffRow[] = [];
  for (const [cidr, addressFamily] of union) {
    const mine = ranges.get(cidr);
    const cells = new Map<string, DiffCell>();
    const owners: string[] = [];
    let coveredCount = 0;
    let partialCount = 0;

    for (const v of vifs) {
      if (prefixSets.get(v.vifId)!.has(cidr)) {
        cells.set(v.vifId, { state: 'exact' });
        owners.push(v.vifId);
        continue;
      }
      // Longest covering prefix on this VIF: that is the route which would win
      // longest-prefix match here, so it is the one worth naming. In the same
      // pass, collect any prefixes sitting *inside* the block — if nothing
      // covers it whole, those are the parts that do remain reachable.
      let via: string | undefined;
      let viaLen = -1;
      const inside: string[] = [];
      if (mine) {
        for (const cand of accepted.get(v.vifId)!) {
          const cr = ranges.get(cand.cidr);
          if (!cr || cr.family !== mine.family) continue;
          if (cr.prefixLength < mine.prefixLength) {
            if (!rangeCovers(cr, mine)) continue;
            if (cr.prefixLength > viaLen) {
              via = cand.cidr;
              viaLen = cr.prefixLength;
            }
          } else if (rangeCovers(mine, cr)) {
            inside.push(cand.cidr);
          }
        }
      }
      if (via) {
        cells.set(v.vifId, { state: 'covered', via });
        coveredCount++;
      } else if (inside.length > 0) {
        cells.set(v.vifId, { state: 'partial', inside });
        partialCount++;
      } else {
        cells.set(v.vifId, { state: 'absent' });
      }
    }

    // Grade on the best guarantee available if an owner drops. Two owners is
    // like-for-like redundancy; otherwise a covering route beats fragments,
    // which beat nothing at all.
    const exactCount = owners.length;
    const verdict: RowVerdict = exactCount >= 2
      ? 'redundant'
      : coveredCount > 0
        ? 'covered'
        : partialCount > 0
          ? 'partial'
          : 'solo';

    // Shared fate only sharpens a verdict that already reads safe; a solo or
    // partial row is flagged in its own right and its carriers cannot be diverse
    // anyway. Carriers are the VIFs that keep the WHOLE prefix reachable, so a
    // `partial` cell does not count — a fragment is not a failover path for the
    // block.
    const fate = verdict === 'redundant' || verdict === 'covered'
      ? gradeFate(
        vifs
          .map((v) => v.vifId)
          .filter((id) => {
            const state = cells.get(id)!.state;
            return state === 'exact' || state === 'covered';
          }),
        vifFates,
      )
      : undefined;

    rows.push({ cidr, addressFamily, cells, owners, exactCount, coveredCount, partialCount, verdict, fate });
  }

  rows.sort((a, b) => a.cidr.localeCompare(b.cidr, undefined, { numeric: true }));

  const byVif = new Map<string, VifDiff>();
  for (const vif of vifs) {
    // Tallied over the prefixes this VIF accepts, so each tab answers "what
    // happens to MY prefixes if I go away?".
    const own = rows.filter((row) => row.cells.get(vif.vifId)?.state === 'exact');
    byVif.set(vif.vifId, {
      vif,
      rowCount: own.length,
      soloCount: own.filter((row) => row.verdict === 'solo').length,
      partialCount: own.filter((row) => row.verdict === 'partial').length,
      looseCount: own.filter((row) => row.verdict === 'covered').length,
      sharedDeviceCount: own.filter((row) => row.fate?.scope === 'device').length,
      sharedSiteCount: own.filter((row) => row.fate?.scope === 'site').length,
    });
  }

  return {
    vifs,
    rows,
    byVif,
    // Counted over distinct prefixes, so a gap counts once however many VIFs
    // lack it.
    totalSolo: rows.filter((row) => row.verdict === 'solo').length,
    totalLoose: rows.filter((row) => row.verdict === 'covered').length,
    totalPartial: rows.filter((row) => row.verdict === 'partial').length,
    totalSharedDevice: rows.filter((row) => row.fate?.scope === 'device').length,
    totalSharedSite: rows.filter((row) => row.fate?.scope === 'site').length,
  };
}
