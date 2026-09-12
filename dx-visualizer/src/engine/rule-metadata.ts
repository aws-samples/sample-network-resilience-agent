/**
 * Static prioritization metadata, one entry per rule the engine can emit.
 *
 * Why this exists as a hand-maintained table rather than something derived:
 * `severity` cannot rank remediation work. Every rule in `resiliency-rules.ts`
 * and `public-vif-rules.ts` emits `severity: 'info'` — including "Add a Second
 * Direct Connect Location", which is the single highest-impact finding the tool
 * produces and the gate on the 99.9% SLA. Deriving impact or effort from
 * severity would sort that below an informational BGP timer tweak.
 *
 * The split of fields is deliberate:
 *
 *  - `effort`, `leadTime`, `changeType`, `category`, `publishedId` describe THE
 *    FIX, so they key on `ruleId` alone. Fixing `bgp-route-limit` is the same
 *    work whether the rule fired critical, warning or advisory.
 *  - `impact` describes WHAT BREAKS IF IGNORED, which does move with the emitted
 *    severity — several rules emit three or four different severities under one
 *    `ruleId` (`bgp-route-limit` and `dx-failover-testing` both do). So the table
 *    carries a baseline and `impactFor()` escalates it, rather than the table
 *    carrying 42 x 3 entries.
 *
 * `publishedId` is stored, never derived from array position: the whole point is
 * that a customer can say "we closed DX-ARC-01" across two reviews, so an index
 * that shifts when a rule is added would break the contract. Numbers are
 * append-only — never renumber, never reuse a retired number.
 */

/** What breaks if this finding is ignored. Independent of how alarming the row looks. */
export type RuleImpact = 'critical' | 'high' | 'medium' | 'low';

/** How much work the fix is, once you have decided to do it. */
type RuleEffort = 'low' | 'medium' | 'high';

/**
 * Wall-clock time from decision to done. `weeks` is reserved for anything
 * gated on a third party shipping something physical.
 */
export type RuleLeadTime = 'hours' | 'days' | 'weeks' | 'ongoing';

/**
 * How the fix gets made. DX remediation is bimodal — either an API/router
 * change you make this afternoon, or a circuit you order from a partner with a
 * multi-week lead time — so the roadmap groups on this rather than on uniform
 * week buckets, which would file "add a second DX location" next to "enable
 * BFD" and mislead on both.
 */
export type RuleChangeType =
  /** API call, console change or router config. No third party, no window. */
  | 'config'
  /** Needs a maintenance window, a partner ticket, or a change record. */
  | 'coordinated'
  /** New circuit, cross-connect or LOA-CFA. Gated on a partner or facility. */
  | 'procurement'
  /** Not a one-off change — a habit, a document, or a recurring test. */
  | 'practice';

/**
 * Report grouping. Matches the three `BpCategory` values the best-practices
 * table already uses, so this table can replace `RULE_CATEGORY` in
 * `useExportReport.ts` rather than introducing a parallel taxonomy.
 */
type RuleReportCategory = 'architecture' | 'configuration' | 'operations';

export interface RuleMeta {
  /** Stable, citable identifier. Append-only; never renumbered. */
  publishedId: string;
  category: RuleReportCategory;
  /** Baseline impact. `impactFor()` escalates this for critical emissions. */
  impact: RuleImpact;
  effort: RuleEffort;
  leadTime: RuleLeadTime;
  changeType: RuleChangeType;
  /**
   * True for the `-ok` attestation rules, which report that a check PASSED.
   * They carry metadata so the best-practices table can still categorize them,
   * but they are never ranked and never appear in the roadmap — there is no
   * work to schedule.
   */
  isPass?: boolean;
  /**
   * True when this rule's `info` emission is a pass or generic guidance rather
   * than a finding at `impact`.
   *
   * Needed because the `-ok` naming convention only covers four of the rules
   * that report a healthy result. Six others emit their pass or their
   * "consider doing this" text under the SAME `ruleId` as their real warning,
   * distinguished only by title — and title is prose, so it cannot be the
   * discriminator. Without this flag, `consistent-prefix-advertisement`
   * emitting "Redundant VIFs receive matching prefix sets" (a pass) inherited
   * the `high` impact that belongs to "Redundant VIFs are not receiving the
   * same prefixes", and ranked third on a topology with nothing wrong.
   *
   * Set on exactly the rules that emit more than one severity —
   * `rule-metadata.test.ts` derives that set from the rules sources and fails
   * if the two disagree, so a new multi-severity rule cannot forget it.
   *
   * NOT a substitute for `isPass`: these rules still emit real findings at
   * warning or critical, so they belong in the plan. Only the `info` emission
   * is demoted.
   */
  infoIsAdvisory?: boolean;
}

/**
 * Keyed by `Recommendation.ruleId`. Exhaustive by construction: a rule missing
 * from here fails `rule-metadata.test.ts`, which cross-checks this table
 * against the `ruleId` literals in the three rules files. That test is the
 * reason a new rule cannot silently fall back to a default category the way it
 * did under the old 18-entry `RULE_CATEGORY` map.
 */
export const RULE_META: Record<string, RuleMeta> = {
  // ── Architecture ────────────────────────────────────────────────────────────
  // Site and device redundancy. Almost all of this is procurement-gated: you
  // cannot fix "one location" with an API call, which is exactly why these
  // outrank config tweaks on impact while losing to them on effort.
  'single-dx-location': {
    publishedId: 'DX-ARC-01',
    category: 'architecture',
    // Gates the 99.9% SLA. A single location is a single facility failure away
    // from total loss of the DX path, whatever the device redundancy inside it.
    impact: 'critical',
    effort: 'high',
    leadTime: 'weeks',
    changeType: 'procurement',
  },
  'single-connection-per-location': {
    publishedId: 'DX-ARC-02',
    category: 'architecture',
    // Gates the 99.99% SLA once two locations exist.
    impact: 'high',
    effort: 'high',
    leadTime: 'weeks',
    changeType: 'procurement',
  },
  'vgw-single-dx-location': {
    publishedId: 'DX-ARC-03',
    category: 'architecture',
    impact: 'critical',
    effort: 'high',
    leadTime: 'weeks',
    changeType: 'procurement',
  },
  'vgw-single-connection-per-location': {
    publishedId: 'DX-ARC-04',
    category: 'architecture',
    impact: 'high',
    effort: 'high',
    leadTime: 'weeks',
    changeType: 'procurement',
  },
  'pubvif-single-dx-location': {
    publishedId: 'DX-ARC-05',
    category: 'architecture',
    impact: 'high',
    effort: 'high',
    leadTime: 'weeks',
    changeType: 'procurement',
  },
  'pubvif-single-connection-per-location': {
    publishedId: 'DX-ARC-06',
    category: 'architecture',
    impact: 'medium',
    effort: 'high',
    leadTime: 'weeks',
    changeType: 'procurement',
  },
  'pubvif-carried-max-gap': {
    publishedId: 'DX-ARC-07',
    category: 'architecture',
    impact: 'medium',
    effort: 'high',
    leadTime: 'weeks',
    changeType: 'procurement',
  },
  'lag-single-location': {
    publishedId: 'DX-ARC-08',
    category: 'architecture',
    impact: 'high',
    effort: 'high',
    leadTime: 'weeks',
    changeType: 'procurement',
  },
  'lag-redundancy-per-location': {
    publishedId: 'DX-ARC-09',
    category: 'architecture',
    impact: 'high',
    effort: 'high',
    leadTime: 'weeks',
    changeType: 'procurement',
  },
  'no-tgw': {
    publishedId: 'DX-ARC-11',
    category: 'architecture',
    impact: 'medium',
    effort: 'high',
    leadTime: 'weeks',
    changeType: 'coordinated',
  },
  'single-vgw': {
    publishedId: 'DX-ARC-12',
    category: 'architecture',
    impact: 'medium',
    effort: 'medium',
    leadTime: 'days',
    changeType: 'coordinated',
  },
  'no-vpn-backup': {
    publishedId: 'DX-ARC-13',
    category: 'architecture',
    // The cheapest real answer to a single DX path: no circuit to order, and it
    // is the pairing AWS itself recommends. High impact, medium effort — this
    // is the row most likely to surface as a quick win on a weak topology.
    impact: 'high',
    effort: 'medium',
    leadTime: 'days',
    changeType: 'coordinated',
  },
  'cgw-redundancy': {
    publishedId: 'DX-ARC-14',
    category: 'architecture',
    impact: 'medium',
    effort: 'medium',
    leadTime: 'days',
    changeType: 'coordinated',
  },
  'dx-partner-diversity': {
    publishedId: 'DX-ARC-15',
    category: 'architecture',
    impact: 'medium',
    effort: 'high',
    leadTime: 'weeks',
    changeType: 'procurement',
  },
  'dx-location-redundancy': {
    publishedId: 'DX-ARC-16',
    category: 'architecture',
    impact: 'low',
    effort: 'low',
    leadTime: 'ongoing',
    changeType: 'practice',
  },
  'sla-awareness': {
    publishedId: 'DX-ARC-17',
    category: 'architecture',
    impact: 'low',
    effort: 'low',
    leadTime: 'ongoing',
    changeType: 'practice',
  },
  'resiliency-toolkit': {
    publishedId: 'DX-ARC-18',
    category: 'architecture',
    impact: 'low',
    effort: 'low',
    leadTime: 'ongoing',
    changeType: 'practice',
  },
  // Buying a support plan is a commercial process with an owner outside the network
  // team and a real end date, so it is `procurement`, not `practice`. It was filed as
  // a practice and the roadmap then printed it under "no completion date — these are
  // habits, not tasks" beside a `days` lead time, contradicting itself in one row.
  'enterprise-support-required': {
    publishedId: 'DX-ARC-19',
    category: 'architecture',
    impact: 'medium',
    effort: 'medium',
    leadTime: 'weeks',
    changeType: 'procurement',
  },
  // A Well-Architected review is a scheduled engagement with the account team: it
  // finishes, so it is coordinated work rather than an ongoing habit.
  'well-architected-review-required': {
    publishedId: 'DX-ARC-20',
    category: 'architecture',
    impact: 'medium',
    effort: 'medium',
    leadTime: 'weeks',
    changeType: 'coordinated',
  },
  // Two connections in two facilities that land on the same AWS logical device
  // are not two failure domains, and nothing in the console says so — the
  // topology looks fully redundant. Baseline `high`; `impactFor()` lifts it to
  // critical on the emission where a routing domain would be left with zero
  // paths, which is the case that turns a redundant-looking estate into a
  // single-device outage. `procurement`, because the only real fix is a new
  // connection AWS terminates elsewhere: you cannot choose the device.
  'shared-logical-device': {
    publishedId: 'DX-ARC-21',
    category: 'architecture',
    impact: 'high',
    effort: 'high',
    leadTime: 'weeks',
    changeType: 'procurement',
  },
  // `hasLogicalRedundancy: 'no'` is AWS stating this connection has no redundant
  // hardware behind it. Lower impact than a shared device: it is one link's
  // internal resilience, not two links secretly sharing a fate.
  'logical-redundancy': {
    publishedId: 'DX-ARC-22',
    category: 'architecture',
    impact: 'medium',
    effort: 'high',
    leadTime: 'weeks',
    changeType: 'procurement',
  },
  'logical-redundancy-ok': {
    publishedId: 'DX-ARC-23',
    category: 'architecture',
    impact: 'low',
    effort: 'low',
    leadTime: 'ongoing',
    changeType: 'practice',
    isPass: true,
  },

  // ── Configuration ───────────────────────────────────────────────────────────
  // Overwhelmingly `config` / low effort / hours. This is the bucket that fills
  // the Quick Wins section, and the reason impact has to be tracked separately:
  // several of these are higher impact than the architecture rows above while
  // costing an afternoon.
  'vif-down': {
    publishedId: 'DX-CFG-01',
    category: 'configuration',
    // Not a risk — an outage in progress on the affected VIFs.
    impact: 'critical',
    effort: 'low',
    leadTime: 'hours',
    changeType: 'config',
  },
  'connection-not-available': {
    publishedId: 'DX-CFG-02',
    category: 'configuration',
    // `coordinated`, not `config`: the cause may be incomplete provisioning or
    // a facility-side fault, both of which need the partner.
    impact: 'critical',
    effort: 'medium',
    leadTime: 'days',
    changeType: 'coordinated',
  },
  'bgp-route-limit': {
    publishedId: 'DX-CFG-03',
    category: 'configuration',
    // Baseline high; `impactFor()` lifts it to critical on the at-teardown
    // emission. Exceeding the per-family quota drops the session entirely.
    impact: 'high',
    effort: 'low',
    leadTime: 'hours',
    changeType: 'config',
    infoIsAdvisory: true,
  },
  'bgp-route-limit-ok': {
    publishedId: 'DX-CFG-04',
    category: 'configuration',
    impact: 'low',
    effort: 'low',
    leadTime: 'hours',
    changeType: 'config',
    isPass: true,
  },
  'bfd-guidance': {
    publishedId: 'DX-CFG-05',
    category: 'configuration',
    // Without BFD, failover waits on BGP hold time — tens of seconds of
    // blackholing on a path that is already redundant. Cheap, high value.
    impact: 'high',
    effort: 'low',
    leadTime: 'hours',
    changeType: 'config',
  },
  'bgp-timers-fallback': {
    publishedId: 'DX-CFG-06',
    category: 'configuration',
    impact: 'medium',
    effort: 'low',
    leadTime: 'hours',
    changeType: 'config',
  },
  'consistent-prefix-advertisement': {
    publishedId: 'DX-CFG-07',
    category: 'configuration',
    // A prefix only one VIF carries is a failover gap that no health check
    // shows: the path is up, the destination is unreachable after failover.
    impact: 'high',
    effort: 'medium',
    leadTime: 'days',
    changeType: 'coordinated',
    infoIsAdvisory: true,
  },
  'vif-route-symmetry': {
    publishedId: 'DX-CFG-08',
    category: 'configuration',
    impact: 'medium',
    effort: 'medium',
    leadTime: 'days',
    changeType: 'coordinated',
    infoIsAdvisory: true,
  },
  'vif-rate-limit-oversubscription': {
    publishedId: 'DX-CFG-09',
    category: 'configuration',
    impact: 'medium',
    effort: 'low',
    leadTime: 'days',
    changeType: 'coordinated',
  },
  'lag-min-links': {
    publishedId: 'DX-CFG-10',
    category: 'configuration',
    impact: 'medium',
    effort: 'low',
    leadTime: 'hours',
    changeType: 'config',
  },
  'dxgw-propagation': {
    publishedId: 'DX-CFG-11',
    category: 'configuration',
    // Propagation off means the TGW route table has no path on-prem: traffic is
    // silently dropped with nothing in a health check to show it.
    impact: 'high',
    effort: 'low',
    leadTime: 'hours',
    changeType: 'config',
  },
  'dxgw-propagation-ok': {
    publishedId: 'DX-CFG-12',
    category: 'configuration',
    impact: 'low',
    effort: 'low',
    leadTime: 'hours',
    changeType: 'config',
    isPass: true,
  },
  'blackhole-routes': {
    publishedId: 'DX-CFG-13',
    category: 'configuration',
    impact: 'high',
    effort: 'low',
    leadTime: 'hours',
    changeType: 'config',
  },
  'vpc-no-hybrid-route': {
    publishedId: 'DX-CFG-14',
    category: 'configuration',
    impact: 'medium',
    effort: 'low',
    leadTime: 'hours',
    changeType: 'config',
  },
  'vpn-tunnel-redundancy': {
    publishedId: 'DX-CFG-15',
    category: 'configuration',
    impact: 'high',
    effort: 'low',
    leadTime: 'hours',
    changeType: 'config',
  },
  'vpn-dpd': {
    publishedId: 'DX-CFG-16',
    category: 'configuration',
    impact: 'medium',
    effort: 'low',
    leadTime: 'hours',
    changeType: 'config',
    infoIsAdvisory: true,
  },
  'vpn-static-routes-only': {
    publishedId: 'DX-CFG-17',
    category: 'configuration',
    // Static routes do not withdraw on failure, so the "backup" VPN keeps
    // attracting traffic into a dead path. High impact, and the fix touches the
    // customer router, so it needs a window.
    impact: 'high',
    effort: 'medium',
    leadTime: 'days',
    changeType: 'coordinated',
  },
  // The weakest sibling's prefix allocation is the one that governs failover: if
  // the surviving VIF allows fewer prefixes than the failed one was carrying, the
  // overflow is dropped or the session tears down at the moment it is needed. A
  // `ModifyVirtualInterfaceAttributes`-class change, so cheap — the cost is
  // noticing.
  'prefix-allocation-skew': {
    publishedId: 'DX-CFG-18',
    category: 'configuration',
    impact: 'high',
    effort: 'low',
    leadTime: 'hours',
    changeType: 'config',
  },
  // A connection whose pool has nothing unallocated cannot give any of its VIFs
  // more headroom without taking it from a sibling, so the next prefix-growth
  // request is blocked until the pool is re-cut or raised with AWS.
  'prefix-pool-exhausted': {
    publishedId: 'DX-CFG-19',
    category: 'configuration',
    impact: 'medium',
    effort: 'medium',
    leadTime: 'days',
    changeType: 'coordinated',
  },
  // Housekeeping, not risk: an idle gateway costs nothing and breaks nothing. It
  // is worth reporting because it is usually the residue of a migration, and a
  // reader comparing gateway counts against their design needs to know which
  // ones are inert.
  'unused-dxgw': {
    publishedId: 'DX-CFG-20',
    category: 'configuration',
    impact: 'low',
    effort: 'low',
    leadTime: 'hours',
    changeType: 'config',
  },
  // Throughput tuning, not resiliency — and `coordinated` despite being a single
  // API field, because an MTU change resets the BGP session and has to match end
  // to end or traffic silently fragments.
  // Fires only on inconsistency, so the finding is "this estate has a standard
  // and these sessions miss it" — an audit gap more than an availability one.
  // Adding a key resets the session, hence `coordinated`.

  // ── Operations ──────────────────────────────────────────────────────────────
  // Practices and evidence, not configuration. These never become quick wins —
  // `ongoing` lead time means there is no "done" — but they are what turns a
  // configured redundancy into a proven one.
  'dx-failover-testing': {
    publishedId: 'DX-OPS-01',
    category: 'operations',
    // Baseline high: redundancy that has never been exercised is a hypothesis.
    // `impactFor()` lifts it to critical on the "a test did not complete
    // successfully" emission, which is evidence the redundancy does not work.
    impact: 'high',
    effort: 'medium',
    leadTime: 'ongoing',
    changeType: 'practice',
    infoIsAdvisory: true,
  },
  'dx-failover-testing-ok': {
    publishedId: 'DX-OPS-02',
    category: 'operations',
    impact: 'low',
    effort: 'low',
    leadTime: 'ongoing',
    changeType: 'practice',
    isPass: true,
  },
  'failover-runbooks': {
    publishedId: 'DX-OPS-03',
    category: 'operations',
    impact: 'medium',
    effort: 'medium',
    leadTime: 'ongoing',
    changeType: 'practice',
  },
  'bgp-session-stability': {
    publishedId: 'DX-OPS-04',
    category: 'operations',
    // A flapping session is an intermittent outage. Diagnosis usually lands on
    // the customer router or the partner circuit, so `days`, not `hours`.
    impact: 'high',
    effort: 'medium',
    leadTime: 'days',
    changeType: 'coordinated',
    infoIsAdvisory: true,
  },
  'bgp-session-stability-ok': {
    publishedId: 'DX-OPS-05',
    category: 'operations',
    impact: 'low',
    effort: 'low',
    leadTime: 'ongoing',
    changeType: 'practice',
    isPass: true,
  },
  // A prefix count that moves is the same class of evidence as a flap count, and
  // lands with the same people: the customer router's BGP logs and the partner.
  // It also invalidates the quota headroom figure, so it is worth acting on even
  // when the peak looks comfortable.
  'prefix-churn': {
    publishedId: 'DX-OPS-06',
    category: 'operations',
    impact: 'medium',
    effort: 'medium',
    leadTime: 'days',
    changeType: 'coordinated',
  },
  // AWS Health reporting a Direct Connect issue against this account's own
  // resources is history, not a defect — there is nothing to "fix". What it is
  // worth is corroboration: a repeated or ongoing fault on a path the rules
  // already call single-threaded is the difference between a theoretical risk and
  // one that has already fired. `practice`, because the response is a review of
  // that path, not a configuration change.
  'recent-aws-issue': {
    publishedId: 'DX-OPS-07',
    category: 'operations',
    impact: 'medium',
    effort: 'low',
    leadTime: 'ongoing',
    changeType: 'practice',
    infoIsAdvisory: true,
  },
};

/** Sort weight, highest first. Used by the ranked findings table. */
export const IMPACT_RANK: Record<RuleImpact, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

/** Sort weight, lowest effort first — cheap work wins ties on equal impact. */
export const EFFORT_RANK: Record<RuleEffort, number> = {
  low: 1,
  medium: 2,
  high: 3,
};





/**
 * Roadmap phase order, keyed by change type. Phases are grouped by HOW the fix
 * is made because DX remediation is bimodal, not a continuum: an API change and
 * a new cross-connect belong in different conversations with different people.
 */
export const ROADMAP_PHASES: { changeType: RuleChangeType; title: string; blurb: string }[] = [
  {
    changeType: 'config',
    title: 'Phase 1 · Configuration changes',
    blurb: 'API, console or router changes. No third party, no maintenance window needed.',
  },
  {
    changeType: 'coordinated',
    title: 'Phase 2 · Coordinated changes',
    blurb:
      'Needs a maintenance window, a change record, or time from your Direct Connect partner or AWS account team.',
  },
  {
    changeType: 'procurement',
    title: 'Phase 3 · Procurement',
    blurb:
      'Anything gated on a partner, a facility or a commercial agreement — new circuits, cross-connects, LOA-CFAs, support plans. Start these first even though they finish last.',
  },
  {
    changeType: 'practice',
    title: 'Phase 4 · Ongoing practice',
    blurb: 'Recurring tests, runbooks and reviews. No completion date — these are habits, not tasks.',
  },
];

/**
 * Metadata for a rule, or `undefined` if it is not in the table.
 *
 * Callers must handle `undefined` rather than substituting a default. A rule
 * absent from `RULE_META` is a bug the completeness test catches at build time;
 * silently defaulting it — as the old `RULE_CATEGORY[id] ?? 'configuration'`
 * did — is how 15 rules ended up mis-filed with nothing to signal it.
 */
export function metaFor(ruleId: string): RuleMeta | undefined {
  return RULE_META[ruleId];
}

/**
 * Effective impact for one emitted recommendation.
 *
 * A rule's baseline impact describes its typical emission. Rules that emit
 * several severities under one `ruleId` need the actual emission taken into
 * account: `bgp-route-limit` firing `critical` means the session is at
 * teardown, and `dx-failover-testing` firing `critical` means a test actually
 * failed. Both are materially worse than the baseline.
 *
 * Escalation is one-directional, with one explicit exception. A `critical`
 * emission always raises impact, and a lower severity never lowers it —
 * `single-dx-location` emits `info` and is still critical impact, which is the
 * whole reason this module exists. The exception is `infoIsAdvisory`: for the
 * six rules that emit their pass or their generic guidance as `info` alongside
 * a real warning under the same `ruleId`, the `info` emission is demoted to
 * `low`. Without that, a healthy topology ranked "Redundant VIFs receive
 * matching prefix sets" — a pass — third, above actual work.
 */
export function impactFor(ruleId: string, severity: 'critical' | 'warning' | 'info'): RuleImpact {
  const meta = RULE_META[ruleId];
  if (!meta) return 'medium';
  if (severity === 'critical') return 'critical';
  if (severity === 'info' && meta.infoIsAdvisory) return 'low';
  return meta.impact;
}
