/**
 * The numeric table that heads the HTML report: one row per Direct Connect
 * gateway, one column per failure that can actually stop traffic.
 *
 * Deliberately counts rather than glyphs. A per-theme grid of marks answers "which
 * checks touched this target", which is a coverage question; it is the wrong table
 * for the question a reader opens the report with, because a glyph carries no
 * magnitude — `⚠` on *Devices* looks identical whether one link or nine are
 * exposed, so the reader has to click through every cell to find out which gateway
 * to care about. Every cell here is a count over the population at risk
 * (`5 of 10`), so the table ranks itself. Coverage — including the checks with no
 * column here — is the Best practices section, which lists passes too.
 *
 * Two consequences of that choice, both deliberate:
 *
 *  1. **Only disruptive checks get a column.** MTU, MD5 consistency, tagging,
 *     Enterprise Support and Well-Architected prerequisites cannot themselves
 *     interrupt traffic, so putting them beside "prefixes that lose every path"
 *     flattens a real outage into the same visual weight as a config nit. They
 *     keep their full treatment in the best-practice section — nothing is
 *     dropped, it is ranked.
 *  2. **`na` is a real state and is never rendered as a pass.** A gateway with no
 *     VIFs has no BGP session to grade; a topology with no `vifRoutes` (the
 *     permission is a separate `List*` action) cannot be asked which prefixes are
 *     single-pathed. Both read `—`, not `0`, because zero is a measurement and
 *     these are the absence of one.
 *
 * The account-total row is not a sum of the rows above it, and the one column
 * where that matters is `linksOnOneDevice` — see `buildQuickView`.
 */

import type { TopologyData } from '../types/topology';
import type { CombinedAssessment, ResiliencyLevel } from '../types/recommendations';
import type { BgpSessionStability, DxConnection, DxVirtualInterface } from '../types/aws-resources';
import { computeDxgwRouteDiff } from './vif-route-diff';
import { acceptedByFamily, prefixQuotaFor, PREFIX_UTILIZATION_WARN } from './bestpractice-rules';

/** Column identity. Order here is the column order in the report. */
export type QuickViewColumnId =
  | 'scale'
  | 'locations'
  | 'sharedDevice'
  | 'soloPrefixes'
  | 'prefixQuota'
  | 'lastDown';

export type QuickViewSeverity = 'critical' | 'warning' | 'ok' | 'na';

/**
 * One DX location's link shape, as `connections`·`AWS logical devices`.
 *
 * Structured rather than pre-rendered, because this module emits no HTML — the
 * report's renderer turns these into chips. `state` is not derivable from the two
 * counts alone: a site whose links report no AWS logical device has a *known*
 * connection count and an *unknown* device count, which is neither a pass nor a
 * fault.
 */
export interface QuickViewChip {
  /** DX location code, e.g. `EqSG2`. */
  label: string;
  /** `2·1`, or `2·?` when AWS does not report a device for every link there. */
  value: string;
  state: 'ok' | 'weak' | 'unknown';
  /** The same fact spelled out in words, for the chip's tooltip. */
  title: string;
}

export interface QuickViewCell {
  /** The headline figure, already formatted (`5 of 10`, `2`, `all`, `—`). */
  figure: string;
  /** One short clause naming what the figure is made of. May be empty. */
  detail: string;
  /**
   * Per-location chips, which take the place of `detail` when present. Only the
   * locations column sets them, because its count alone describes three
   * materially different estates — 2+1, 1+2, and a 2+1 whose pair shares one AWS
   * device — and the tier badge on the same row is identical in all three.
   */
  chips?: QuickViewChip[];
  severity: QuickViewSeverity;
  /**
   * Which report section holds the records behind the figure. The renderer turns
   * this into an in-document link; `undefined` means the figure has no backing
   * detail to jump to (an `na` cell, or the scale column).
   */
  section?:
    | 'route-analysis'
    | 'inventory'
    | 'findings'
    | 'gateway'
    /** The row's gateway card, opened at its per-location / per-device posture table. */
    | 'gateway-posture'
    /** The row's gateway card, opened at its virtual-interface inventory. */
    | 'gateway-vifs'
    | 'best-practices';
  /**
   * Resource ids the cell is about, so the renderer can flash the matching rows
   * in the target section. Empty when the cell points at a whole section.
   */
  focusIds?: string[];
}

/**
 * The row's resiliency tier, rendered in the row head rather than as a column.
 *
 * It moved out of the grid because a tier is an attribute of the gateway, not a
 * measurement over a population like every other column — and because the row head
 * had a name, an id and then empty space under them, which is exactly where two
 * badges belong. Levels rather than labels, so the renderer owns the palette and
 * the engine stays free of presentation.
 */
export interface QuickViewTier {
  /** `null` when tiers do not apply — an unattached gateway, or the orphan row. */
  currentLevel: ResiliencyLevel | null;
  /** `null` at the ceiling, or where a single target is not meaningful. */
  targetLevel: ResiliencyLevel | null;
  /** SLA today, or the per-tier tally on the account row. */
  note: string;
  severity: QuickViewSeverity;
}

export interface QuickViewRow {
  key: string;
  kind: 'dxgw' | 'other' | 'total';
  label: string;
  sublabel: string;
  /** Gateway id for rows that have one, so the renderer can resolve its anchor. */
  targetId?: string;
  tier: QuickViewTier;
  cells: Map<QuickViewColumnId, QuickViewCell>;
}

/**
 * An AWS public documentation reference. The report cites rather than explains:
 * a paraphrase of AWS behaviour in our own prose can go stale silently, and the
 * customer's network team will act on the canonical page regardless.
 */
export interface DocRef {
  url: string;
  label: string;
}

export interface QuickViewColumn {
  id: QuickViewColumnId;
  label: string;
  /** The second header line: what failure this column describes. */
  sublabel: string;
  /** The counting rule, stated as briefly as it can be stated. */
  blurb: string;
  /** Where AWS documents the behaviour behind the column. */
  docs?: DocRef[];
  /** Right-align numeric columns; the tier column is prose. */
  numeric: boolean;
}

/**
 * Verified against the live pages. Do not add a URL here without opening it —
 * a dead link in a customer-facing report is worse than no link.
 */
export const DOC = {
  toolkit: {
    url: 'https://docs.aws.amazon.com/directconnect/latest/UserGuide/resiliency_toolkit.html',
    label: 'Resiliency Toolkit',
  },
  maintenance: {
    url: 'https://docs.aws.amazon.com/directconnect/latest/UserGuide/dx-maintenance.html',
    label: 'Direct Connect maintenance',
  },
  quotas: {
    url: 'https://docs.aws.amazon.com/directconnect/latest/UserGuide/limits.html',
    label: 'Direct Connect quotas',
  },
  routing: {
    url: 'https://docs.aws.amazon.com/directconnect/latest/UserGuide/routing-and-bgp.html',
    label: 'Inbound routing policy',
  },
  sla: {
    url: 'https://aws.amazon.com/directconnect/sla/',
    label: 'Direct Connect SLA',
  },
  prefixControls: {
    url: 'https://docs.aws.amazon.com/directconnect/latest/UserGuide/prefix-controls.html',
    label: 'Inbound prefix controls',
  },
} as const satisfies Record<string, DocRef>;

export const QUICKVIEW_COLUMNS: QuickViewColumn[] = [
  {
    id: 'scale',
    label: 'Connections / VIFs',
    sublabel: 'Carrying this gateway',
    blurb: 'Connections reaching this gateway, and virtual interfaces riding them. The denominator for every column to its right.',
    numeric: true,
  },
  {
    id: 'locations',
    label: 'DX locations',
    sublabel: 'Links per site (connection·device)',
    blurb: 'Distinct Direct Connect locations with a connection to this gateway, then one chip '
      + 'per location reading connections·AWS logical devices, weakest location first. One '
      + 'location is one building and one fibre entry, whatever the link count. A chip reading '
      + '2·1 has two connections landing on one AWS device: full bandwidth, no device '
      + 'redundancy. 1·1 is a single link. 2·? means AWS reports no logical device for at '
      + 'least one of those links, so redundancy there can be neither confirmed nor ruled out. '
      + 'Amber marks any site with fewer than two confirmed devices — that is the location to '
      + 'add a link at, and it is the leftmost chip.',
    docs: [DOC.toolkit, DOC.maintenance],
    numeric: true,
  },
  {
    id: 'sharedDevice',
    label: 'Links on one device',
    sublabel: 'One device maintenance removes them',
    blurb: 'Connections sharing one AWS logical device at a site where no second device is in use. Two or more devices in use at a site counts 0; a single link counts 0.',
    docs: [DOC.maintenance],
    numeric: true,
  },
  {
    id: 'soloPrefixes',
    label: 'Prefixes with one path',
    sublabel: 'No second route into AWS',
    blurb: 'On-premises prefixes reachable across one logical device only, counted once each.',
    docs: [DOC.routing],
    numeric: true,
  },
  {
    id: 'prefixQuota',
    label: 'VIFs at 80%+ prefix quota',
    sublabel: 'BGP session can drop above 100%',
    blurb: 'VIFs at or above 80% of their own inbound prefix allocation, per address family. The default allocation is 100 per family and can be raised to 1,000; a DX gateway allows 10,000 across all its VIFs. Accepted prefixes come from ListVirtualInterfaceRoutes, counted once each. Advertising past the allocation puts the BGP session into an idle state.',
    docs: [DOC.quotas, DOC.prefixControls],
    numeric: true,
  },
  {
    id: 'lastDown',
    label: 'Last VIF down',
    sublabel: 'Most recent BGP drop',
    blurb: 'When a virtual interface on this gateway last lost its BGP session, from the AWS/DX '
      + 'VirtualInterfaceBgpStatus metric sampled at its minimum, so a drop shorter than the '
      + 'sampling period is not averaged away. DescribeVirtualInterfaces reports only the state '
      + 'right now, which makes a VIF that flapped eleven times last week indistinguishable from '
      + 'one solid for a year. CloudWatch retention bounds the window, so "no drop" means none '
      + 'in the days sampled rather than none ever.',
    docs: [DOC.sla],
    numeric: false,
  },
];

const TIER_LABEL: Record<ResiliencyLevel, string> = {
  none: 'No Resiliency',
  devtest: 'Development & Testing',
  high: 'High Resiliency',
  maximum: 'Maximum Resiliency',
};

/** What the tier buys, so the reader does not have to look the SLA up. */
const TIER_SLA: Record<ResiliencyLevel, string> = {
  none: 'no SLA — no connection detected',
  devtest: '95% single-connection SLA today',
  high: '99.9% today',
  maximum: '99.99% connection SLA · met',
};

const TIER_RANK: Record<ResiliencyLevel, number> = {
  none: 0,
  devtest: 1,
  high: 2,
  maximum: 3,
};

function na(detail: string): QuickViewCell {
  return { figure: '—', detail, severity: 'na' };
}

/**
 * A site's links, grouped by the AWS logical device they terminate on.
 *
 * `awsLogicalDeviceId` is absent on partner-hosted connections, and that absence
 * is load-bearing rather than a gap to paper over: two links at one site with no
 * readable device could be on one device (redundancy is illusory) or two (it is
 * real), and the API will not say which. They are counted separately as
 * `unknownCount` so the caller reports "unconfirmed" instead of picking whichever
 * answer happens to look better.
 */
interface SiteDevices {
  location: string;
  /** device id → connection ids on it. Only links that report a device. */
  byDevice: Map<string, string[]>;
  /** Links at this site whose device AWS does not report. */
  unknown: string[];
}

/**
 * Bucket for links AWS reports no location for. Named rather than inlined because
 * `linkChips` has to skip it: it is not a DX location, so it cannot be a chip, and
 * a fourth chip reading `unknown 1·1` would look like a site the reader could go
 * and add a link at.
 */
const UNKNOWN_SITE = 'unknown';

function groupBySite(connections: DxConnection[]): Map<string, SiteDevices> {
  const sites = new Map<string, SiteDevices>();
  for (const c of connections) {
    const loc = c.location || UNKNOWN_SITE;
    let site = sites.get(loc);
    if (!site) {
      site = { location: loc, byDevice: new Map(), unknown: [] };
      sites.set(loc, site);
    }
    const dev = c.awsLogicalDeviceId;
    if (!dev) {
      site.unknown.push(c.connectionId);
      continue;
    }
    const list = site.byDevice.get(dev) ?? [];
    list.push(c.connectionId);
    site.byDevice.set(dev, list);
  }
  return sites;
}

/**
 * Links exposed to one device's maintenance, over the sites given.
 *
 * The rule is a site having **two or more links on one device and no second
 * device in use there**. A site spreading four links over two devices survives
 * losing either, so it contributes nothing; a site with one link contributes
 * nothing either, because there is no false redundancy to expose. Both
 * exclusions come from the counting rule, not from a severity judgement.
 */
function sharedDeviceExposure(sites: Iterable<SiteDevices>): {
  exposed: number;
  unconfirmed: number;
  /** Affected sites, worst first. Empty when nothing is exposed. */
  perSite: { location: string; count: number; deviceId: string }[];
} {
  let exposed = 0;
  let unconfirmed = 0;
  const perSite: { location: string; count: number; deviceId: string }[] = [];

  for (const site of sites) {
    unconfirmed += site.unknown.length;
    // More than one device in use here means a device outage leaves a path.
    if (site.byDevice.size !== 1) continue;
    const [deviceId, links] = [...site.byDevice][0];
    if (links.length < 2) continue;
    exposed += links.length;
    perSite.push({ location: site.location, count: links.length, deviceId });
  }

  perSite.sort((a, b) => b.count - a.count || a.location.localeCompare(b.location));
  return { exposed, unconfirmed, perSite };
}

/**
 * One chip per DX location — `connections`·`AWS logical devices`, weakest first.
 *
 * Derived from `groupBySite`, the same grouping `sharedDeviceExposure` counts over,
 * and deliberately **not** from `getLocationLinkCounts` in `sla-gating.ts` — which
 * is what the equivalent chips used while they lived in the per-gateway assessment
 * table. That function falls back to the connection id as the device key when
 * `awsLogicalDeviceId` is absent, so two device-less partner-hosted links at one
 * site count as two devices. Reusing it here would print `SITE 2·2` in green,
 * reading as device-redundant, in the column immediately left of "Links on one
 * device" reporting `2 links: device not reported` in amber: two adjacent cells of
 * one table contradicting each other about the same two links. `groupBySite` keeps
 * device-less links in `unknown` precisely so that is not papered over, and the
 * third chip state is what honouring it costs.
 *
 * Weakest first because the reader's question is "where do I add a link", and the
 * answer is then the leftmost chip.
 */
function linkChips(sites: Iterable<SiteDevices>): QuickViewChip[] {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const rows: { chip: QuickViewChip; devices: number; conns: number }[] = [];

  for (const site of sites) {
    if (site.location === UNKNOWN_SITE) continue;
    const confirmed = [...site.byDevice.values()].reduce((n, links) => n + links.length, 0);
    const conns = confirmed + site.unknown.length;
    if (conns === 0) continue;
    // A single link is one link on one device whatever AWS says its id is, so a
    // missing id tells us nothing there — `1·?` would invent a doubt. Likewise
    // `byDevice.size || 1`: a lone device-less link has no device entry at all and
    // must still read `1·1`, never `1·0`.
    const certain = site.unknown.length === 0 || conns === 1;
    const devices = site.byDevice.size || 1;
    const state: QuickViewChip['state'] = !certain ? 'unknown' : devices < 2 ? 'weak' : 'ok';
    rows.push({
      devices: site.byDevice.size,
      conns,
      chip: {
        label: site.location,
        value: certain ? `${conns}·${devices}` : `${conns}·?`,
        state,
        title: certain
          ? `${site.location}: ${plural(conns, 'connection')} on ${plural(devices, 'AWS logical device')}`
            + (devices < 2 ? ' — a device outage cuts this location entirely' : '')
          : `${site.location}: ${plural(conns, 'connection')}; AWS does not report a logical `
            + `device for ${site.unknown.length} of them, so device redundancy here is unconfirmed`,
      },
    });
  }

  rows.sort(
    (a, b) =>
      (a.chip.state === 'ok' ? 1 : 0) - (b.chip.state === 'ok' ? 1 : 0)
      || a.devices - b.devices
      || a.conns - b.conns
      || a.chip.label.localeCompare(b.chip.label),
  );
  return rows.map((r) => r.chip);
}

/**
 * VIFs at or past `PREFIX_UTILIZATION_WARN` of their own allocation.
 *
 * Every VIF with a readable count is graded the same way, including one whose
 * accepted count lands above its allocation: over the allocation is over the
 * allocation, and the BGP session can be driven into an idle state for it. An
 * earlier version excluded that case as "two counts disagreeing" whenever the
 * session was up, which asked the reader to reason about where each number came
 * from before acting on it.
 */
function prefixPressure(topology: TopologyData, vifs: DxVirtualInterface[]): {
  graded: number;
  flagged: DxVirtualInterface[];
  worstPct: number | null;
  worstVif: DxVirtualInterface | null;
  overQuota: number;
} {
  let graded = 0;
  let worstPct: number | null = null;
  let worstVif: DxVirtualInterface | null = null;
  let overQuota = 0;
  const flagged: DxVirtualInterface[] = [];

  for (const vif of vifs) {
    const counts = acceptedByFamily(topology, vif.virtualInterfaceId);
    if (!counts) continue;
    let vifWorst = 0;
    for (const family of ['ipv4', 'ipv6'] as const) {
      const used = counts[family];
      if (used === undefined) continue;
      const { limit } = prefixQuotaFor(vif, family);
      if (!limit) continue;
      vifWorst = Math.max(vifWorst, used / limit);
    }
    graded += 1;
    if (vifWorst >= PREFIX_UTILIZATION_WARN) flagged.push(vif);
    if (vifWorst > 1) overQuota += 1;
    if (worstPct === null || vifWorst > worstPct) {
      worstPct = vifWorst;
      worstVif = vif;
    }
  }
  return { graded, flagged, worstPct, worstVif, overQuota };
}

type PrefixPressure = ReturnType<typeof prefixPressure>;

/**
 * One cell for the prefix-quota column, shared by the per-gateway rows and the
 * account total so the two can never word the same state differently.
 */
function prefixCell(press: PrefixPressure): QuickViewCell {
  const worst = press.worstPct === null ? '' : pct(press.worstPct);
  const utilization = press.graded === 0
    ? ''
    : press.overQuota > 0
      ? `worst ${worst} — over the allocation`
      : press.flagged.length > 0
        ? `worst ${worst} — at risk`
        : press.worstVif
          ? `worst ${worst} — ${vifName(press.worstVif)}`
          : '';
  return {
    figure: press.graded === 0 ? 'Not comparable' : `${press.flagged.length} of ${press.graded}`,
    detail: utilization,
    severity: press.overQuota > 0
      ? 'critical'
      : press.flagged.length > 0
        ? 'warning'
        : 'ok',
    // This column counts VIFs against their own allocation, and the per-VIF
    // Accepted / Allocated figures are in the gateway's virtual-interface inventory —
    // not in the prefix-diff matrix, which is per prefix.
    section: 'gateway-vifs',
    focusIds: press.flagged.map((v) => v.virtualInterfaceId),
  };
}

function pct(ratio: number): string {
  const p = ratio * 100;
  // A hair under a band boundary must not round onto it: 79.6% displayed as
  // "80%" beside an unflagged cell reads as a bug in the flag, not as rounding.
  if (p >= 10) return `${Math.floor(p)}%`;
  return `${Math.round(p * 10) / 10}%`;
}

function vifName(v: DxVirtualInterface): string {
  return v.virtualInterfaceName || v.virtualInterfaceId;
}

/**
 * The row's tier badges. `target` is the engine's own `targetLevel`, never "one rung
 * up": a gateway co-riding a public VIF is escalated to that VIF's higher tier, and
 * inventing the next rung here would contradict the gateway's own card further down.
 */
function rowTier(current: ResiliencyLevel, target: ResiliencyLevel): QuickViewTier {
  return {
    currentLevel: current,
    targetLevel: TIER_RANK[target] > TIER_RANK[current] ? target : null,
    note: TIER_SLA[current],
    severity: current === 'maximum' ? 'ok' : current === 'high' ? 'warning' : 'critical',
  };
}

/** Tiers are graded per DX gateway, so a row that is not one gets no badge at all. */
function noTier(note: string): QuickViewTier {
  return { currentLevel: null, targetLevel: null, note, severity: 'na' };
}

/**
 * When a VIF on this row last lost its BGP session.
 *
 * `bgpStability` is on-demand and billed per metric retrieved, so its absence is
 * routine rather than exceptional — and it is reported as `—` with a reason, never
 * as "no drops", because "we did not look" and "it never dropped" would otherwise
 * render identically on a gateway that flapped nightly. The window is whatever the
 * fetch sampled (CloudWatch keeps 5-minute data 63 days), so a clean row is only
 * ever clean *for the days sampled*.
 */
function lastDownCell(
  topology: TopologyData,
  vifs: DxVirtualInterface[],
): QuickViewCell {
  const stability = topology.bgpStability;
  if (!stability || stability.size === 0) return na('BGP history not fetched');
  if (vifs.length === 0) return na('no BGP sessions');

  const sampled = vifs
    .map((v) => ({ vif: v, s: stability.get(v.virtualInterfaceId) }))
    .filter((e): e is { vif: DxVirtualInterface; s: BgpSessionStability } => !!e.s);
  if (sampled.length === 0) return na('not sampled for this gateway');

  const windowDays = Math.max(...sampled.map((e) => e.s.windowDays));
  const flaps = sampled.filter((e) => e.s.lastFlapAt);
  if (flaps.length === 0) {
    return {
      figure: 'No drop',
      detail: `none in ${windowDays}d sampled`,
      severity: 'ok',
      section: 'gateway-vifs',
    };
  }
  // Most recent across the row's VIFs: the question is when this gateway was last
  // disturbed, and the oldest flap on a healthy sibling does not answer it.
  const worst = flaps.reduce((a, b) => (a.s.lastFlapAt! > b.s.lastFlapAt! ? a : b));
  const totalFlaps = sampled.reduce((n, e) => n + e.s.flapCount, 0);
  return {
    figure: formatUtc(worst.s.lastFlapAt!),
    detail: `${vifName(worst.vif)} · ${totalFlaps} drop${totalFlaps === 1 ? '' : 's'} in ${windowDays}d`,
    severity: 'warning',
    section: 'gateway-vifs',
    focusIds: flaps.map((e) => e.vif.virtualInterfaceId),
  };
}

/**
 * `2026-09-01 14:32 UTC`. Explicitly UTC and fixed-width: the reader is correlating
 * this against a CloudWatch console and a change record, and a locale-formatted
 * local time turns that into arithmetic. Deliberately not "3 days ago" — the file
 * is read weeks after it is written, and a relative age silently decays.
 */
function formatUtc(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} `
    + `${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

export interface QuickView {
  columns: QuickViewColumn[];
  rows: QuickViewRow[];
  /**
   * True when `vifRoutes` was never fetched, so the `soloPrefixes` column is `na`
   * everywhere. The renderer states the reason once rather than per row.
   */
  routesUnavailable: boolean;
}

/**
 * Build the table.
 *
 * @param gatewayOrder Gateway ids in the order the report already lists them, so
 *   this table and the per-gateway sections below cannot disagree.
 */
export function buildQuickView(
  topology: TopologyData,
  assessment: CombinedAssessment,
  gatewayOrder: string[] = [],
): QuickView {
  const rank = new Map(gatewayOrder.map((id, i) => [id, i]));
  const gateways = [...assessment.perDxGateway].sort(
    (a, b) =>
      (rank.get(a.dxGatewayId) ?? Number.MAX_SAFE_INTEGER)
      - (rank.get(b.dxGatewayId) ?? Number.MAX_SAFE_INTEGER),
  );

  const connById = new Map(topology.connections.map((c) => [c.connectionId, c]));
  const rows: QuickViewRow[] = [];

  const vifsFor = (predicate: (v: DxVirtualInterface) => boolean) =>
    topology.virtualInterfaces.filter(predicate);

  /** The connections a set of VIFs rides, deduplicated. */
  const connectionsFor = (vifs: DxVirtualInterface[]): DxConnection[] => {
    const ids = new Set(vifs.map((v) => v.connectionId).filter(Boolean));
    return [...ids].map((id) => connById.get(id)).filter((c): c is DxConnection => !!c);
  };

  const buildRow = (
    key: string,
    kind: 'dxgw' | 'other',
    label: string,
    sublabel: string,
    targetId: string | undefined,
    vifs: DxVirtualInterface[],
    tier: { current: ResiliencyLevel; target: ResiliencyLevel } | null,
  ): QuickViewRow => {
    const conns = connectionsFor(vifs);
    const cells = new Map<QuickViewColumnId, QuickViewCell>();

    cells.set('scale', {
      figure: `${conns.length} / ${vifs.length}`,
      detail: '',
      severity: 'na',
      section: 'inventory',
    });

    // Grouped once and read twice: the locations chips and the shared-device count
    // are two readings of the same grouping, and they sit in adjacent columns.
    // Grouping separately for each is how they would come to disagree.
    const sites = groupBySite(conns);

    // --- locations ---
    const locations = [...new Set(conns.map((c) => c.location).filter(Boolean))].sort();
    if (locations.length === 0) {
      cells.set('locations', { figure: '0', detail: 'no connections', severity: 'critical', section: 'inventory' });
    } else {
      const chips = linkChips(sites.values());
      cells.set('locations', {
        figure: String(locations.length),
        // The chips supersede the prose list. The fallback cannot fire for real
        // data — every located connection yields a chip — but an empty cell would
        // be worse than the plain list if it ever did.
        detail: chips.length ? '' : locations.join(', '),
        chips: chips.length ? chips : undefined,
        severity: locations.length === 1 ? 'critical' : 'ok',
        // This gateway's own posture card, not the shared inventory table. The chips
        // compress each site to four characters; the reader's next question is which
        // AWS device each link lands on, and that is the table the posture card
        // opens with. Pointing every row at one estate-wide table meant five rows
        // all navigated to the same place and flashed rows the reader then had to
        // find their gateway among.
        section: 'gateway-posture',
      });
    }

    // --- links on one device ---
    if (conns.length === 0) {
      cells.set('sharedDevice', na('nothing to assess'));
    } else {
      const { exposed, unconfirmed, perSite } = sharedDeviceExposure(sites.values());
      // Every affected site, not just the worst one: naming one site beside a figure
      // of "4 of 4" reads as if the other two links were fine.
      const detail = exposed > 0 && perSite.length
        ? perSite.map((s) => `${s.count} at ${s.location}`).join(', ')
        : unconfirmed > 0
          ? `${unconfirmed} link${unconfirmed === 1 ? '' : 's'}: device not reported`
          : conns.length === 1
            ? 'single link, nothing to share'
            : '1 link per site';
      cells.set('sharedDevice', {
        figure: `${exposed} of ${conns.length}`,
        // Unconfirmed is a warning, not a pass: a partner-hosted pair may share
        // a device, which would make this gateway's redundancy illusory.
        severity: exposed > 0 ? 'critical' : unconfirmed > 0 ? 'warning' : conns.length === 1 ? 'na' : 'ok',
        detail,
        section: 'inventory',
        focusIds: conns.map((c) => c.connectionId),
      });
    }

    // --- prefixes with one path ---
    const diff = targetId && kind === 'dxgw' ? computeDxgwRouteDiff(topology, targetId) : null;
    if (!diff) {
      cells.set(
        'soloPrefixes',
        na(topology.vifRoutes ? 'no BGP routes on this gateway' : 'BGP routes not fetched'),
      );
    } else {
      const gaps = diff.totalSolo + diff.totalPartial;
      cells.set('soloPrefixes', {
        figure: `${gaps} of ${diff.rows.length}`,
        detail: gaps === 0 ? 'every prefix has a second path' : `${diff.totalSolo} solo, ${diff.totalPartial} partly covered`,
        severity: gaps === 0 ? 'ok' : 'warning',
        section: 'route-analysis',
        focusIds: targetId ? [targetId] : [],
      });
    }

    // --- prefix quota ---
    const press = prefixPressure(topology, vifs);
    if (press.graded === 0) {
      cells.set('prefixQuota', na(vifs.length === 0 ? 'no BGP sessions' : 'prefix counts not available'));
    } else {
      cells.set('prefixQuota', prefixCell(press));
    }

    // --- last VIF down ---
    cells.set('lastDown', lastDownCell(topology, vifs));

    return {
      key,
      kind,
      label,
      sublabel,
      targetId,
      tier: tier === null
        ? noTier(kind === 'dxgw' ? 'no VIF — no tier graded' : 'tiers are graded per DX gateway')
        : rowTier(tier.current, tier.target),
      cells,
    };
  };

  for (const gw of gateways) {
    const vifs = vifsFor((v) => v.directConnectGatewayId === gw.dxGatewayId);
    rows.push(
      buildRow(
        `dxgw:${gw.dxGatewayId}`,
        'dxgw',
        gw.dxGatewayName || gw.dxGatewayId,
        gw.dxGatewayId,
        gw.dxGatewayId,
        vifs,
        // An unattached gateway carries no VIFs, so no tier is graded for it —
        // reporting one would assert an SLA for a path that does not exist.
        gw.isUnattached ? null : { current: gw.currentLevel, target: gw.targetLevel },
      ),
    );
  }

  // VIFs that terminate on a VGW or nothing at all. They are still customer
  // traffic on a DX circuit, so leaving them out would under-report the account
  // total — but they have no gateway, so no tier is graded for them.
  const orphans = vifsFor(
    (v) => v.virtualInterfaceType !== 'public'
      && (!v.directConnectGatewayId || v.directConnectGatewayId.startsWith('vgw-')),
  );
  if (orphans.length > 0) {
    const vgws = [...new Set(orphans.map((v) => v.directConnectGatewayId).filter(Boolean))];
    rows.push(
      buildRow(
        'other',
        'other',
        'Virtual interfaces with no DX gateway',
        vgws.length ? `on ${vgws.join(', ')}` : 'no gateway association',
        undefined,
        orphans,
        null,
      ),
    );
  }

  // ---------------- account total ----------------
  //
  // Every column except `sharedDevice` is a straight roll-up. `sharedDevice` is
  // NOT, and that difference is the most valuable number in the table: the rule
  // groups links by device, and a device is shared ACROSS gateways. Five links on
  // one device spanning four gateways gives every gateway row `0` — each survives
  // on its other site — while the account loses a link from all four at once.
  // Summing the gateway rows would report that as 0 and hide the only correlated
  // failure in the account.
  const allVifs = topology.virtualInterfaces.filter((v) => v.virtualInterfaceType !== 'public');
  const allConns = topology.connections;
  const totalCells = new Map<QuickViewColumnId, QuickViewCell>();

  totalCells.set('scale', {
    figure: `${allConns.length} / ${allVifs.length}`,
    detail: '',
    severity: 'na',
    section: 'inventory',
  });

  const accountSites = groupBySite(allConns);
  const allLocations = [...new Set(allConns.map((c) => c.location).filter(Boolean))].sort();
  const allChips = linkChips(accountSites.values());
  // Two locations is the AWS-recommended floor, not a caution: grading it amber here
  // would contradict a Maximum Resiliency verdict sitting on the same row. The chips
  // are the estate's own link shape, not a sum of the gateway rows — one connection
  // reaches several gateways, so summing those rows would count it more than once.
  totalCells.set('locations', {
    figure: String(allLocations.length),
    detail: allChips.length ? '' : allLocations.length === 0 ? 'no connections' : allLocations.join(', '),
    chips: allChips.length ? allChips : undefined,
    severity: allLocations.length <= 1 ? 'critical' : 'ok',
    // The account row has no gateway card to open, so it keeps the inventory table —
    // which is the estate-wide list of every connection and the site it lands at.
    section: 'inventory',
    focusIds: allConns.map((c) => c.connectionId),
  });

  const accountShared = sharedDeviceExposure(accountSites.values());
  if (allConns.length === 0) {
    totalCells.set('sharedDevice', na('no connections'));
  } else {
    totalCells.set('sharedDevice', {
      figure: `${accountShared.exposed} of ${allConns.length}`,
      detail: accountShared.perSite.length
        ? accountShared.perSite.map((s) => `${s.count} at ${s.location}`).join(', ')
        : accountShared.unconfirmed > 0
          ? `${accountShared.unconfirmed} link${accountShared.unconfirmed === 1 ? '' : 's'}: device not reported`
          : 'no site puts two links on one device',
      severity: accountShared.exposed > 0
        ? 'critical'
        : accountShared.unconfirmed > 0 ? 'warning' : 'ok',
      section: 'inventory',
    });
  }

  // Distinct prefixes, not the sum of the gateway columns: the same prefix can be
  // single-pathed on three gateways, and adding them up triple-counts one CIDR.
  const gwIds = new Set(gateways.map((g) => g.dxGatewayId));
  const soloPrefixes = new Set<string>();
  const allPrefixes = new Set<string>();
  let anyDiff = false;
  for (const id of gwIds) {
    const d = computeDxgwRouteDiff(topology, id);
    if (!d) continue;
    anyDiff = true;
    for (const row of d.rows) {
      allPrefixes.add(row.cidr);
      if (row.verdict === 'solo' || row.verdict === 'partial') soloPrefixes.add(row.cidr);
    }
  }
  totalCells.set(
    'soloPrefixes',
    anyDiff
      ? {
          // Ratio, not a bare count, so it reads the same way as the gateway rows above
          // and so a `0` is visibly out of a real population rather than out of nothing.
          figure: `${soloPrefixes.size} of ${allPrefixes.size}`,
          detail: soloPrefixes.size > 0
            ? 'distinct prefixes, counted once each'
            : 'every prefix has a second path',
          severity: soloPrefixes.size > 0 ? 'warning' : 'ok',
          section: 'route-analysis',
        }
      : na(topology.vifRoutes ? 'no BGP routes on any gateway' : 'BGP routes not fetched'),
  );

  const allPress = prefixPressure(topology, allVifs);
  if (allPress.graded === 0) {
    totalCells.set('prefixQuota', na('prefix counts not available'));
  } else {
    totalCells.set('prefixQuota', prefixCell(allPress));
  }

  totalCells.set('lastDown', lastDownCell(topology, allVifs));

  // The estate's tier is the WEAKEST gateway, not an average: the account is only as
  // resilient as its most exposed path, and a mean would let three Maximum gateways
  // hide a Dev & Test one. The tally beside it says how many sit where.
  const levels: ResiliencyLevel[] = gateways.filter((g) => !g.isUnattached).map((g) => g.currentLevel);
  let totalTier: QuickViewTier;
  if (levels.length === 0) {
    totalTier = noTier(gateways.length ? 'no gateway carries a VIF' : 'no DX gateways');
  } else {
    const weakest = levels.reduce((a, b) => (TIER_RANK[b] < TIER_RANK[a] ? b : a));
    const tally = new Map<ResiliencyLevel, number>();
    for (const l of levels) tally.set(l, (tally.get(l) ?? 0) + 1);
    const parts = (['maximum', 'high', 'devtest', 'none'] as const)
      .filter((l) => tally.has(l))
      .map((l) => `${tally.get(l)} ${l === 'devtest' ? 'Dev & Test' : l === 'none' ? 'none' : TIER_LABEL[l].replace(' Resiliency', '')}`);
    totalTier = {
      currentLevel: weakest,
      // No target: the account has no single one — each gateway carries its own, and
      // picking the weakest gateway's target would understate the work.
      targetLevel: null,
      note: `weakest of ${parts.join(' · ')}`,
      severity: weakest === 'maximum' ? 'ok' : weakest === 'high' ? 'warning' : 'critical',
    };
  }

  const gwCount = gateways.length;
  const vgwCount = new Set(
    orphans.map((v) => v.directConnectGatewayId).filter((id): id is string => !!id),
  ).size;
  rows.push({
    key: 'total',
    kind: 'total',
    label: 'Account total',
    sublabel: [
      `${gwCount} DX gateway${gwCount === 1 ? '' : 's'}`,
      vgwCount ? `${vgwCount} VGW` : null,
      `${allLocations.length} location${allLocations.length === 1 ? '' : 's'}`,
    ].filter(Boolean).join(' · '),
    tier: totalTier,
    cells: totalCells,
  });

  return { columns: QUICKVIEW_COLUMNS, rows, routesUnavailable: !topology.vifRoutes };
}
