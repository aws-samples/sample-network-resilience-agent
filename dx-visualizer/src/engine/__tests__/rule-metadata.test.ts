import { describe, it, expect } from 'vitest';
import {
  RULE_META,
  IMPACT_RANK,
  EFFORT_RANK,
  ROADMAP_PHASES,
  metaFor,
  impactFor,
} from '../rule-metadata';

/**
 * The rule sources as text.
 *
 * Read through Vite's raw glob rather than `node:fs` so the test stays inside the
 * app's type surface — `tsconfig.app.json` sets `types: ["vite/client"]`, and
 * `npm run build` typechecks `src` including tests, so a `node:fs` import here
 * would fail the production build unless `@types/node` were added to the app's
 * types for the sake of one test file.
 */
const RULE_SOURCES = import.meta.glob(
  ['../resiliency-rules.ts', '../public-vif-rules.ts', '../bestpractice-rules.ts'],
  { query: '?raw', eager: true, import: 'default' },
) as Record<string, string>;

/**
 * Every `ruleId` literal the engine can emit, read out of source at test time.
 *
 * Parsing source rather than importing and running the rules is deliberate: a
 * rule only emits its id on the code path where it fires, so an import-and-run
 * approach would need a topology fixture that triggers all 42 branches, and any
 * branch we failed to trigger would silently pass. Reading the literals catches
 * a new rule the moment it is written, which is the point.
 *
 * Handles both spellings in the sources:
 *   ruleId: 'single-vgw'
 *   ruleId: gatewayKind === 'vgw' ? 'vgw-single-dx-location' : 'single-dx-location'
 */
function emittedRuleIds(): Set<string> {
  const ids = new Set<string>();
  for (const src of Object.values(RULE_SOURCES)) {
    // Grab the whole right-hand side of `ruleId:` up to the end of the line,
    // then pull every quoted token out of it. The ternary form yields three
    // quoted tokens, one of which is the discriminant ('vgw'), so filter to
    // tokens that actually resolve in the table's key space by shape: rule ids
    // are kebab-case with at least one dash.
    for (const line of src.split('\n')) {
      const m = /ruleId:\s*(.+)$/.exec(line);
      if (!m) continue;
      for (const q of m[1].matchAll(/'([a-z0-9-]+)'/g)) {
        if (q[1].includes('-')) ids.add(q[1]);
      }
    }
  }
  return ids;
}

describe('RULE_META completeness', () => {
  const emitted = emittedRuleIds();

  it('reads all three rule source files', () => {
    // A glob that silently matched nothing would make every check below vacuous.
    expect(Object.keys(RULE_SOURCES).length).toBe(3);
  });

  it('finds every rule id in the sources', () => {
    // Guards the parser itself. If a refactor changes how rules declare their
    // id, this drops toward zero and the coverage assertions below would pass
    // vacuously.
    expect(emitted.size).toBeGreaterThanOrEqual(42);
  });

  it('has an entry for every rule the engine can emit', () => {
    const missing = [...emitted].filter((id) => !RULE_META[id]).sort();
    expect(missing).toEqual([]);
  });

  it('has no entry for a rule that no longer exists', () => {
    // Keeps the table from accumulating dead rows that would show up as
    // published IDs a customer can never see again.
    const orphaned = Object.keys(RULE_META).filter((id) => !emitted.has(id)).sort();
    expect(orphaned).toEqual([]);
  });
});

/**
 * Every severity each rule can emit, read out of source alongside its id.
 *
 * Rules declare `ruleId` and `severity` a couple of lines apart inside the same
 * object literal, so this walks forward from each `ruleId:` to the next
 * `severity:` and pairs them. Ternaries on either field contribute all their
 * quoted arms, which is what makes `bgp-session-stability` — whose severity is
 * `worst >= THRESHOLD ? 'warning' : 'info'` — correctly read as multi-severity.
 */
function emittedSeverities(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const SEVERITIES = new Set(['critical', 'warning', 'info']);
  for (const src of Object.values(RULE_SOURCES)) {
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const idMatch = /ruleId:\s*(.+)$/.exec(lines[i]);
      if (!idMatch) continue;
      const ids = [...idMatch[1].matchAll(/'([a-z0-9-]+)'/g)]
        .map((m) => m[1])
        .filter((s) => s.includes('-'));
      if (ids.length === 0) continue;
      // Look a few lines ahead for this emission's severity. The gap is 2-4
      // lines in every current rule; 8 is slack without reaching the next
      // emission, and a miss would only ever under-report, which the
      // cross-check below treats as a failure rather than a pass.
      for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
        const sevMatch = /severity:\s*(.+)$/.exec(lines[j]);
        if (!sevMatch) continue;
        const sevs = [...sevMatch[1].matchAll(/'([a-z]+)'/g)]
          .map((m) => m[1])
          .filter((s) => SEVERITIES.has(s));
        for (const id of ids) {
          out.set(id, new Set([...(out.get(id) ?? []), ...sevs]));
        }
        break;
      }
    }
  }
  return out;
}

describe('infoIsAdvisory tracks the rules that emit more than one severity', () => {
  const severities = emittedSeverities();

  it('resolves a severity for every rule id', () => {
    // Parser guard. A rule with no severity found would silently look
    // single-severity and so exempt itself from the assertion below.
    const missing = [...emittedRuleIds()].filter((id) => !severities.get(id)?.size).sort();
    expect(missing).toEqual([]);
  });

  it('flags exactly the rules that emit both info and a higher severity', () => {
    // The invariant: if a rule can emit `info` AND warning/critical under one
    // ruleId, its `info` case is a pass or generic guidance and must not
    // inherit the finding's impact. Deriving the expected set from source means
    // a new multi-severity rule fails here rather than quietly ranking its own
    // pass as a high-impact finding.
    const expected = [...severities.entries()]
      .filter(([id, sevs]) => !RULE_META[id]?.isPass && sevs.has('info') && sevs.size > 1)
      .map(([id]) => id)
      .sort();
    const actual = Object.entries(RULE_META)
      .filter(([, m]) => m.infoIsAdvisory)
      .map(([id]) => id)
      .sort();
    expect(actual).toEqual(expected);
  });

  it('never sets infoIsAdvisory together with isPass', () => {
    // isPass already removes the rule from the plan entirely; also demoting its
    // info impact would be dead configuration hiding a misunderstanding.
    for (const [ruleId, m] of Object.entries(RULE_META)) {
      expect(!(m.isPass && m.infoIsAdvisory), ruleId).toBe(true);
    }
  });

  it('demotes an advisory info emission but keeps its warning impact', () => {
    expect(RULE_META['consistent-prefix-advertisement'].impact).toBe('high');
    expect(impactFor('consistent-prefix-advertisement', 'info')).toBe('low');
    expect(impactFor('consistent-prefix-advertisement', 'warning')).toBe('high');
    expect(impactFor('consistent-prefix-advertisement', 'critical')).toBe('critical');
  });

  it('leaves a single-severity info rule at full impact', () => {
    expect(RULE_META['single-dx-location'].infoIsAdvisory).toBeUndefined();
    expect(impactFor('single-dx-location', 'info')).toBe('critical');
  });
});

describe('RULE_META consistency', () => {
  const entries = Object.entries(RULE_META);

  it('assigns a unique published id to every rule', () => {
    const ids = entries.map(([, m]) => m.publishedId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('uses a published id prefix that matches the category', () => {
    const prefix = { architecture: 'DX-ARC-', configuration: 'DX-CFG-', operations: 'DX-OPS-' };
    for (const [ruleId, m] of entries) {
      expect(m.publishedId.startsWith(prefix[m.category]), `${ruleId} → ${m.publishedId}`).toBe(true);
    }
  });

  /**
   * Numbers retired by deleting a rule. They are NEVER reused and never renumbered:
   * a customer has to be able to say "we closed DX-ARC-01" across two reviews, so the
   * id cannot shift when the rule list changes.
   *
   *  - DX-ARC-10 — `no-lag` ("Consider Using LAG Groups"). Removed because a LAG is
   *    not a resiliency mechanism: AWS's own FAQ says it "doesn't make your
   *    connectivity to AWS more resilient" and "will not protect against a single
   *    device failure or device maintenance at AWS where your LAG is terminating".
   *    All members terminate on one device at one location, so it buys bandwidth.
   */
  const RETIRED_IDS = new Map<string, number[]>([['architecture', [10]]]);

  it('numbers published ids contiguously from 01 within each category, allowing retired gaps', () => {
    // Contiguity is checked, not enforced by construction, because the numbers
    // are append-only by hand. A gap means a rule was deleted and its number
    // retired — legitimate, but it must be a deliberate edit to RETIRED_IDS above
    // rather than something that drifts in unnoticed.
    const byCategory = new Map<string, number[]>();
    for (const [, m] of entries) {
      const n = Number(m.publishedId.slice(-2));
      byCategory.set(m.category, [...(byCategory.get(m.category) ?? []), n]);
    }
    for (const [category, nums] of byCategory) {
      const sorted = [...nums, ...(RETIRED_IDS.get(category) ?? [])].sort((a, b) => a - b);
      expect(sorted, category).toEqual(Array.from({ length: sorted.length }, (_, i) => i + 1));
    }
  });

  it('never reissues a retired published id', () => {
    for (const [category, retired] of RETIRED_IDS) {
      const live = entries.filter(([, m]) => m.category === category)
        .map(([, m]) => Number(m.publishedId.slice(-2)));
      for (const n of retired) {
        expect(live, `${category} reused retired id ${n}`).not.toContain(n);
      }
    }
  });

  it('marks exactly the -ok attestation rules as passes', () => {
    const passes = entries.filter(([, m]) => m.isPass).map(([id]) => id).sort();
    const okSuffixed = entries.filter(([id]) => id.endsWith('-ok')).map(([id]) => id).sort();
    expect(passes).toEqual(okSuffixed);
  });

  it('never rates a procurement fix as low effort', () => {
    // A new circuit is never cheap. If this trips, the roadmap would advertise
    // a multi-week partner order as a quick win.
    for (const [ruleId, m] of entries) {
      if (m.changeType === 'procurement') {
        expect(m.effort, ruleId).not.toBe('low');
      }
    }
  });

  it('pairs the practice change type with an ongoing lead time, both ways', () => {
    // The roadmap's practice phase is captioned "no completion date — these are
    // habits, not tasks", so a `practice` row with a `days` lead time contradicts
    // its own heading, and a finite change type with `ongoing` promises a date that
    // will never arrive. Two rules were on the wrong side of this: verifying a
    // support plan and booking a Well-Architected review both finish.
    for (const [ruleId, m] of entries) {
      expect(m.changeType === 'practice', `${ruleId} changeType`).toBe(m.leadTime === 'ongoing');
    }
  });

  it('never rates a config-change fix as taking weeks', () => {
    for (const [ruleId, m] of entries) {
      if (m.changeType === 'config') {
        expect(m.leadTime, ruleId).not.toBe('weeks');
      }
    }
  });

  it('covers every change type with a roadmap phase', () => {
    const phased = new Set(ROADMAP_PHASES.map((p) => p.changeType));
    for (const [ruleId, m] of entries) {
      expect(phased.has(m.changeType), `${ruleId} → ${m.changeType}`).toBe(true);
    }
  });

  it('orders roadmap phases config → coordinated → procurement → practice', () => {
    expect(ROADMAP_PHASES.map((p) => p.changeType)).toEqual([
      'config',
      'coordinated',
      'procurement',
      'practice',
    ]);
  });
});

describe('impactFor', () => {
  it('escalates to critical when the emission is critical', () => {
    // `bgp-route-limit` is baseline high but emits critical at teardown.
    expect(RULE_META['bgp-route-limit'].impact).toBe('high');
    expect(impactFor('bgp-route-limit', 'critical')).toBe('critical');
  });

  it('keeps the baseline for a warning emission', () => {
    expect(impactFor('bgp-route-limit', 'warning')).toBe('high');
  });

  it('demotes the info emission of a multi-severity rule', () => {
    // `bgp-route-limit` at info is its "Keep BGP routes under 100 per session"
    // guidance text, emitted when there is no route data to grade — not a
    // session three prefixes from teardown.
    expect(impactFor('bgp-route-limit', 'info')).toBe('low');
  });

  it('does not demote a high-impact rule that emits info', () => {
    // The reason this module exists: every resiliency rule emits `info`, and
    // "add a second DX location" is the highest-impact finding in the tool.
    expect(impactFor('single-dx-location', 'info')).toBe('critical');
    expect(impactFor('no-vpn-backup', 'info')).toBe('high');
  });

  it('falls back to medium for an unknown rule instead of throwing', () => {
    expect(impactFor('not-a-real-rule', 'info')).toBe('medium');
    expect(metaFor('not-a-real-rule')).toBeUndefined();
  });
});

describe('rank tables', () => {
  it('ranks impact highest-first and effort lowest-first', () => {
    expect(IMPACT_RANK.critical).toBeGreaterThan(IMPACT_RANK.high);
    expect(IMPACT_RANK.high).toBeGreaterThan(IMPACT_RANK.medium);
    expect(IMPACT_RANK.medium).toBeGreaterThan(IMPACT_RANK.low);
    expect(EFFORT_RANK.low).toBeLessThan(EFFORT_RANK.medium);
    expect(EFFORT_RANK.medium).toBeLessThan(EFFORT_RANK.high);
  });
});
