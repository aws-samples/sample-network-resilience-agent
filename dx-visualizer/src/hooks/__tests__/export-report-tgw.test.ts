import { describe, it, expect } from 'vitest';
import { buildHtmlReport } from '../useExportReport';
import { analyzeTopology } from '../../engine/recommendation-engine';
import { buildQuickView } from '../../engine/report-quickview';
import { getMockTopology } from '../../utils/mock-data';
import type { MockScenario } from '../../utils/shared';
import { stripTags } from './helpers';
import { buildSystemPrompt } from '../../chat/system-prompt';

/**
 * Transit gateways are graded at their Transit Gateway (decision A): the gateway
 * card keeps its VIFs and fixes but states no tier of its own, and the TGW band
 * carries the tier. The `high` demo is one transit gateway feeding two TGWs, so
 * both TGWs share one card.
 */
function render(scenario: MockScenario) {
  const topology = getMockTopology(scenario);
  const assessment = analyzeTopology(topology);
  return { html: buildHtmlReport(topology, assessment, scenario, 'light'), assessment, topology };
}

/** From `startId`'s element to the next element carrying `endId`. */
const between = (html: string, startId: string, endId: string) => {
  const start = html.indexOf(`id="${startId}"`);
  const end = html.indexOf(`id="${endId}"`, start + 1);
  expect(start, `missing id="${startId}"`).toBeGreaterThan(-1);
  expect(end, `missing id="${endId}" after ${startId}`).toBeGreaterThan(start);
  return html.slice(start, end);
};

describe('report: Transit Gateway band', () => {
  it('renders one card for TGWs fed by the same gateways, with tier and findings', () => {
    const { html, assessment } = render('high');
    expect(assessment.perTgw.map((t) => t.tgwName)).toEqual(['Prod-TGW', 'SDWAN-TGW']);
    const band = between(html, 'per-tgw', 'findings');
    const text = stripTags(band, ' ').replace(/\s+/g, ' ');
    expect(text).toContain('Prod-TGW, SDWAN-TGW');
    expect(band).not.toContain('id="tgw2"');
    expect(text).toContain('High Resiliency');
    // The demo's device gaps, cited by their published id.
    expect(text).toContain('DX-ARC-26');
    expect(band).toContain('href="#gw1"');
  });

  it('points the transit gateway card at the TGW instead of tiering it', () => {
    const { html } = render('high');
    const posture = between(html, 'gw1-posture', 'gw1-findings');
    expect(stripTags(posture, ' ')).toContain('Graded at the Transit Gateway');
    expect(posture).toContain('href="#tgw1"');
    // Exactly one tier badge per TGW named — the gateway's own pair is not emitted.
    expect(posture.match(/class="tier-badge"/g)).toHaveLength(2);
  });

  it('does not count TGW findings in the findings totals', () => {
    const { html } = render('high');
    // DX-ARC-24..26 are TGW-only; the estate findings and the gateway index must not list them.
    const findings = between(html, 'findings', 'best-practices');
    expect(findings).not.toMatch(/DX-ARC-2[456]/);
  });

  it('leaves a private-only estate without a TGW band', () => {
    const { html, assessment } = render('devTest');
    expect(assessment.perTgw).toEqual([]);
    expect(html).not.toContain('id="per-tgw"');
  });
});

describe('exposure table: transit gateway rows', () => {
  it('gives transit gateways a row per Transit Gateway, not per DX gateway', () => {
    const topology = getMockTopology('high');
    const qv = buildQuickView(topology, analyzeTopology(topology));
    // Prod-TGW and SDWAN-TGW share their feeders, so they share one row — the same
    // grouping as their report card.
    const row = qv.rows.find((r) => r.key === 'tgw:tgw-high01')!;
    expect(row.kind).toBe('tgw');
    expect(row.label).toBe('Prod-TGW, SDWAN-TGW');
    expect(row.tier.currentLevel).toBe('high');
    expect(qv.rows.some((r) => r.key === 'dxgw:dxgw-high01')).toBe(false);
  });

  it('links a TGW row to its TGW card, not to a DX gateway card', () => {
    const topology = getMockTopology('high');
    const html = buildHtmlReport(topology, analyzeTopology(topology), 'high', 'light');
    const table = html.slice(html.indexOf('id="check-matrix"'), html.indexOf('id="executive-summary"'));
    expect(table).toContain('Resiliency exposure by gateway');
    expect(table).toContain('<a href="#tgw1">Prod-TGW, SDWAN-TGW</a>');
    expect(table).toContain('href="#tgw1-posture"');
    // Every link from the table resolves to an element in the report.
    for (const [, id] of table.matchAll(/href="#([^"]+)"/g)) expect(html).toContain(`id="${id}"`);
  });

  it('tallies the account total over TGWs, not their transit gateways', () => {
    const topology = getMockTopology('maximum');
    const qv = buildQuickView(topology, analyzeTopology(topology));
    const total = qv.rows.find((r) => r.key === 'total')!;
    // Four TGWs at Maximum; the unattached second gateway carries no tier.
    expect(total.tier.note).toBe('weakest of 4 Maximum');
  });
});

describe('report: per-prefix route resilience on the TGW card', () => {
  const LIVE = { kind: 'live' as const, scenario: null, primaryRegion: 'ap-southeast-1' };
  const topology = getMockTopology('crossAccount');
  const assessment = analyzeTopology(topology);
  // Visible text: tags stripped, the report's entities decoded.
  const text = (html: string) => stripTags(html, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&mdash;/g, '—').replace(/&middot;/g, '·').replace(/&rsquo;/g, '’').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');

  it("names the AS-loop rejection on Hub-TGW and lists the spoke D gaps", () => {
    const html = buildHtmlReport(topology, assessment, 'crossAccount', 'light');
    const band = text(html.slice(html.indexOf('id="per-tgw"'), html.indexOf('id="findings"')));
    expect(band).toContain('Route resilience — Hub-TGW');
    expect(band).toContain('rejected by this Transit Gateway');
    expect(band).toMatch(/10\.99\.0\.0\/24 ⊘ Rejected \(AS loop\) not in TGW/);
    expect(band).toContain('Route resilience — tgw-spoke-d');
    expect(band).toMatch(/8 of 13 on-premises prefixes survive a DX location failure/);
    expect(band).toContain('not readable from this account');
  });

  it('masks the TGW ASN in a redacted report', () => {
    const html = buildHtmlReport(topology, assessment, null, 'light', { ...LIVE, redacted: true });
    const sentence = text(html).match(/Every copy's AS path already contains its own ASN, [^,]+,/)?.[0] ?? '';
    expect(sentence).not.toBe('');
    expect(sentence).not.toContain('64512');
  });
});

describe('chat context: per-prefix route resilience', () => {
  it('states the grades and the rejection reason per TGW', () => {
    const topology = getMockTopology('crossAccount');
    const prompt = buildSystemPrompt(topology, analyzeTopology(topology));
    expect(prompt).toContain('10.99.0.0/24 (rejected, not in TGW route table)');
    expect(prompt).toContain("contains this TGW's ASN 64512");
    expect(prompt).toMatch(/8 of 13 on-prem prefixes survive a DX location failure; 5 below High/);
  });
});
