import { describe, it, expect } from 'vitest';
import { buildHtmlReport } from '../useExportReport';
import { analyzeTopology } from '../../engine/recommendation-engine';
import { getMockTopology } from '../../utils/mock-data';
import type { MockScenario } from '../../utils/shared';

const SCENARIOS: MockScenario[] = ['noResiliency', 'devTest', 'high', 'maximum', 'crossAccount'];

function render(scenario: MockScenario) {
  const topology = getMockTopology(scenario);
  return buildHtmlReport(topology, analyzeTopology(topology), scenario, 'light');
}


const sectionOf = (html: string, id: string, nextId: string) =>
  html.slice(html.indexOf(`id="${id}"`), html.indexOf(`id="${nextId}"`));


describe('best practices grouping', () => {
  it('files a rule by its own category instead of defaulting to configuration', () => {
    // `single-dx-location` is architecture. It was absent from the hook's local
    // 18-entry table, so it fell through `?? 'configuration'` and appeared under
    // Configuration on every weak topology.
    const html = render('noResiliency');
    const section = sectionOf(html, 'best-practices', 'vif-utilization');
    const arch = section.indexOf('Architecture');
    const config = section.indexOf('Configuration');
    const idx = section.indexOf('Add a Second Direct Connect Location');
    if (idx >= 0) {
      expect(arch).toBeGreaterThanOrEqual(0);
      expect(idx).toBeGreaterThan(arch);
      expect(idx).toBeLessThan(config);
    }
  });

  it('counts open items in the group chip, not total rows', () => {
    const section = sectionOf(render('maximum'), 'best-practices', 'vif-utilization');
    const chips = [...section.matchAll(/<span class="bp-count" title="([^"]+)"/g)].map((m) => m[1]);
    expect(chips.length).toBeGreaterThan(0);
    for (const title of chips) {
      expect(title).toMatch(/^\d+ (of \d+ still open|checks?, all passing)$/);
    }
  });

  it('colours the group chip from its worst item rather than always amber', () => {
    // Before, every chip was `bp-group-gap` regardless of content, so a group of
    // three green ticks was headed by an amber "3". The colour has to vary with the
    // data — across scenarios, since a single topology can legitimately have all
    // three groups in the same state.
    const seen = new Set<string>();
    for (const scenario of SCENARIOS) {
      const section = sectionOf(render(scenario), 'best-practices', 'vif-utilization');
      const classes = [...section.matchAll(/class="bp-group-title (bp-group-\w+)"/g)].map((m) => m[1]);
      expect(classes.length, scenario).toBeGreaterThan(0);
      for (const c of classes) seen.add(c);
    }
    expect(seen.size).toBeGreaterThan(1);
    expect(seen.has('bp-group-alert')).toBe(true);
  });
});

describe('findings strip', () => {
  it('links each severity card to the section it counts', () => {
    const html = render('noResiliency');
    for (const sev of ['critical', 'warning', 'info']) {
      expect(html).toContain(`class="finding-card clickable f-${sev}"`);
      expect(html).toContain(`href="#findings-${sev}"`);
    }
  });

  it('marks a zero card so it reads as none rather than as unmeasured', () => {
    // `maximum` has no critical findings.
    const html = render('maximum');
    expect(html).toMatch(/class="finding-card clickable f-critical zero"/);
  });

  it('agrees with the sidebar badge counts', () => {
    for (const scenario of SCENARIOS) {
      const html = render(scenario);
      const nav = html.slice(html.indexOf('<nav id="toc">'), html.indexOf('</nav>'));
      // Each severity is one sidebar row under "All findings". A row with nothing
      // flagged carries no badge at all, which is the sidebar's way of saying zero —
      // the strip still prints an explicit 0, so absence has to read as 0 here.
      const navCount = (sev: string) => {
        const row = nav.match(new RegExp(`href="#findings-${sev}"[^>]*>(.*?)</a>`))?.[1] ?? '';
        return Number(row.match(/&#9432;(\d+)/)?.[1] ?? 0);
      };
      const strip = html.slice(html.indexOf('class="findings-strip"'));
      const stripCounts = [...strip.matchAll(/class="count">(\d+)</g)].map((m) => Number(m[1]));
      expect(stripCounts.slice(0, 3), scenario)
        .toEqual(['critical', 'warning', 'info'].map(navCount));
    }
  });
});

describe('finding cards', () => {
  it('shows the published id on every card that has one', () => {
    const html = render('noResiliency');
    const cards = [...html.matchAll(/<div id="(f-[^"]+)" class="finding /g)].map((m) => m[1]);
    expect(cards.length).toBeGreaterThan(0);
    for (const anchor of cards) {
      expect(html).toContain(`<code class="finding-id">${anchor.slice(2).replace(/-\d+$/, '')}`);
    }
  });

  it('keeps every per-gateway description instead of the first only', () => {
    // The best-practice list used to dedupe on ruleId alone, so a rule that emits
    // different text per gateway lost all but one. Merging keeps each.
    const topology = getMockTopology('crossAccount');
    const assessment = analyzeTopology(topology);
    const byKey = new Map<string, Set<string>>();
    for (const r of assessment.bestPractice.recommendations) {
      const key = `${r.ruleId}::${r.title}`;
      byKey.set(key, new Set([...(byKey.get(key) ?? []), r.description]));
    }
    const multi = [...byKey.values()].filter((d) => d.size > 1);
    const html = buildHtmlReport(topology, assessment, 'crossAccount', 'light');
    for (const descriptions of multi) {
      for (const d of descriptions) {
        expect(html).toContain(d.replace(/&/g, '&amp;').replace(/</g, '&lt;'));
      }
    }
  });
});
