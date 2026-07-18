import { useCallback } from 'react';
import { useTopologyStore } from '../store/topology-store';
import type { TopologyData } from '../types/topology';
import type { CombinedAssessment, Recommendation, ResiliencyLevel } from '../types/recommendations';
import { getLocationDeviceCounts } from '../engine/sla-gating';

const TIER_LABELS: Record<ResiliencyLevel, string> = {
  none: 'No Resiliency',
  devtest: 'Development & Testing',
  high: 'High Resiliency',
  maximum: 'Maximum Resiliency',
};

const TIER_SLA: Record<ResiliencyLevel, string> = {
  none: 'No SLA — no connection detected',
  devtest: '95% Single Connection SLA',
  high: '99.9% connection SLA',
  maximum: '99.99% connection SLA',
};

const TIER_SUMMARY: Record<ResiliencyLevel, string> = {
  none: 'No Direct Connect connections detected.',
  devtest: 'Single Direct Connect location — covered by the AWS Single Connection SLA (95%), but not resilient to location failure.',
  high: 'Connections across multiple locations — resilient to location failure.',
  maximum: 'Multiple connections at each of multiple locations — highest redundancy tier.',
};

const TIER_BADGE_COLOR: Record<ResiliencyLevel, string> = {
  none: '#ef4444',
  devtest: '#f59e0b',
  high: '#22c55e',
  maximum: '#06b6d4',
};

const SEVERITY_COLOR: Record<string, string> = {
  critical: '#ef4444',
  warning: '#f59e0b',
  info: '#3b82f6',
};

const SEVERITY_LABEL: Record<string, string> = {
  critical: 'Critical',
  warning: 'Warning',
  info: 'Advisory',
};

function timestamp() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function download(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Narrow a topology to the connections/VIFs/locations that feed a specific
 * DX Gateway. Matches the scoping logic in `recommendation-engine.buildDxgwScope`
 * so report figures line up with the per-DXGW resilience cards in the UI.
 */
function scopeTopologyForDxgw(topology: TopologyData, dxGatewayId: string): TopologyData {
  const scopedVifs = topology.virtualInterfaces.filter((v) => v.directConnectGatewayId === dxGatewayId);
  const scopedConnIds = new Set(scopedVifs.map((v) => v.connectionId).filter(Boolean) as string[]);
  const scopedConns = topology.connections.filter((c) => scopedConnIds.has(c.connectionId));
  const scopedLocationCodes = new Set<string>();
  for (const c of scopedConns) if (c.location) scopedLocationCodes.add(c.location);
  for (const v of scopedVifs) if (v.location) scopedLocationCodes.add(v.location);
  const scopedLocations = topology.locations.filter((l) => scopedLocationCodes.has(l.locationCode));
  return {
    ...topology,
    connections: scopedConns,
    virtualInterfaces: scopedVifs,
    locations: scopedLocations,
  };
}

function collectTopologyStats(topology: TopologyData) {
  // Counts distinct AWS logical devices per location — same gating as the
  // tier engine. Two connections sharing a logical device count as one.
  const locationConns = getLocationDeviceCounts(topology);

  const dxRegions = new Set<string>();
  for (const c of topology.connections) if (c.region) dxRegions.add(c.region);
  for (const vif of topology.virtualInterfaces) if (vif.region) dxRegions.add(vif.region);

  const resourceRegions = new Set<string>();
  for (const v of topology.vpcs) if (v.region) resourceRegions.add(v.region);
  for (const tgw of topology.transitGateways) {
    const r = tgw.transitGatewayArn?.split(':')[3];
    if (r) resourceRegions.add(r);
  }

  return {
    locationConns,
    dxRegions: [...dxRegions].sort(),
    resourceRegions: [...resourceRegions].sort(),
    connectionCount: topology.connections.length,
    vifCount: topology.virtualInterfaces.length,
    vpnCount: topology.vpnConnections.length,
    vpcCount: topology.vpcs.length,
    tgwCount: topology.transitGateways.length,
    vgwCount: topology.vpnGateways.length,
    dxGatewayCount: topology.dxGateways.length,
  };
}

type TopologyStats = ReturnType<typeof collectTopologyStats>;

type UpgradeOption = { level: ResiliencyLevel; step: string };

function upgradeOptionsFor(level: ResiliencyLevel, stats: TopologyStats): UpgradeOption[] {
  const underprovisioned = [...stats.locationConns.entries()].filter(([, c]) => c < 2).map(([loc]) => loc);

  if (level === 'none') {
    return [
      { level: 'high', step: 'Provision Direct Connect at 2 separate locations (2 connections total).' },
      { level: 'maximum', step: 'Provision 2 connections at 2 separate locations (4 connections total).' },
    ];
  }
  if (level === 'devtest') {
    return [
      { level: 'high', step: 'Add a connection at a second location.' },
      { level: 'maximum', step: 'Add a second location with 2 connections.' },
    ];
  }
  if (level === 'high') {
    const list = underprovisioned.length === 1
      ? underprovisioned[0]
      : underprovisioned.length === 2
        ? underprovisioned.join(' and ')
        : `${underprovisioned.slice(0, -1).join(', ')}, and ${underprovisioned[underprovisioned.length - 1]}`;
    return [{ level: 'maximum', step: `Add a connection on a separate AWS logical device at ${list}.` }];
  }
  return [];
}

function nextStepsFor(level: ResiliencyLevel, stats: TopologyStats): string[] {
  const steps: string[] = [];
  const locCount = stats.locationConns.size;
  const underprovisioned = [...stats.locationConns.entries()].filter(([, c]) => c < 2).map(([loc]) => loc);

  switch (level) {
    case 'none':
      steps.push('Provision at least one Direct Connect connection to begin.');
      steps.push('A single connection is covered by the AWS Single Connection SLA (95%) — add a connection at a second DX location to reach High Resiliency (99.9% SLA).');
      steps.push('Add a second connection at each location to reach Maximum Resiliency (99.99% SLA).');
      break;
    case 'devtest':
      steps.push('Your setup is at a single Direct Connect location, covered by the Single Connection SLA (95%). Add Direct Connect connections at a second location to protect against a location-wide outage.');
      steps.push('The High Resiliency tier qualifies for the 99.9% connection SLA.');
      steps.push('Final step: ensure each location has at least 2 connections on separate devices to reach Maximum Resiliency (99.99% SLA).');
      break;
    case 'high':
      steps.push(`You have connections at ${locCount} locations. To reach Maximum Resiliency, each location needs at least 2 connections terminating on separate AWS logical devices.`);
      if (underprovisioned.length > 0) {
        steps.push(`Locations still on a single AWS logical device: ${underprovisioned.join(', ')}. Add a connection on a separate device at each of these (multiple connections sharing one device don't provide device redundancy).`);
      }
      steps.push('Once every location has at least 2 connections on separate AWS logical devices, you qualify for the 99.99% Direct Connect SLA.');
      break;
    case 'maximum':
      steps.push('You are at the highest tier (Maximum Resiliency, 99.99% SLA).');
      steps.push('Review the operational best practices below to maintain and strengthen your resilience posture.');
      break;
  }
  return steps;
}

function recsByCategory(recs: Recommendation[]) {
  return {
    critical: recs.filter((r) => r.severity === 'critical'),
    warning: recs.filter((r) => r.severity === 'warning'),
    info: recs.filter((r) => r.severity === 'info'),
  };
}

type ReferenceStatus = 'applied' | 'gap' | 'attest';

type ClassifyResult = { status: ReferenceStatus; evidence?: string[] };

type BpRowStatus = 'alert' | 'gap' | 'applied' | 'verify';
type BpCategory = 'architecture' | 'configuration' | 'operations';
type BpRow = { practice: string; status: BpRowStatus; detail: string; evidence?: string[]; category: BpCategory };

// Reference items covered by §1 resilience tier — don't duplicate into best practices.
const TIER_REF_TITLES = new Set([
  'Two DX locations minimum',
  'Two connections per location on separate DX devices',
]);

// Op-rule ruleIds that have a ref-item equivalent — keep the ref row, skip the op.
const OP_RULES_WITH_REF_EQUIVALENT = new Set([
  'bfd-guidance',
  'no-vpn-backup',
  'cross-region-path',
]);

const RULE_CATEGORY: Record<string, BpCategory> = {
  'vif-down': 'configuration',
  'connection-not-available': 'configuration',
  'vpn-tunnel-redundancy': 'configuration',
  'no-vpn-backup': 'architecture',
  'cgw-redundancy': 'architecture',
  'dx-partner-diversity': 'architecture',
  'cross-region-path': 'architecture',
  'bgp-route-limit': 'configuration',
  'enterprise-support-required': 'architecture',
  'well-architected-review-required': 'architecture',
  'bfd-guidance': 'configuration',
  'bgp-timers-fallback': 'configuration',
  'vpn-dpd': 'configuration',
  'consistent-prefix-advertisement': 'configuration',
  'dx-location-redundancy': 'architecture',
  'sla-awareness': 'architecture',
  'resiliency-toolkit': 'architecture',
  'dx-failover-testing': 'operations',
  'failover-runbooks': 'operations',
};

type ReferenceItem = {
  title: string;
  detail: string;
  category: BpCategory;
  classify: (stats: TopologyStats, uncoveredRegions: string[], topology: TopologyData) => ClassifyResult;
};

const REFERENCE_ITEMS: ReferenceItem[] = [
  {
    title: 'Two DX locations minimum',
    detail: 'Protects against location-wide outages. Required for the 99.9% Direct Connect SLA.',
    category: 'architecture',
    classify: (s) => {
      if (s.locationConns.size === 0) return { status: 'attest' };
      if (s.locationConns.size < 2) return { status: 'gap' };
      return { status: 'applied', evidence: [...s.locationConns.keys()].sort() };
    },
  },
  {
    title: 'Two connections per location on separate DX devices',
    detail: 'Protects against hardware failure at a single location. Required for the 99.99% Direct Connect SLA.',
    category: 'architecture',
    classify: (s) => {
      if (s.locationConns.size === 0) return { status: 'attest' };
      const entries = [...s.locationConns.entries()].sort();
      if (!entries.every(([, c]) => c >= 2)) return { status: 'gap' };
      return { status: 'applied', evidence: entries.map(([loc, c]) => `${loc}: ${c} AWS logical devices`) };
    },
  },
  {
    title: 'Enable Bidirectional Forwarding Detection (BFD)',
    detail: 'Configure on the customer router for sub-second failover detection. BFD state is not visible via the AWS API — verify from your router.',
    category: 'configuration',
    classify: () => ({ status: 'attest' }),
  },
  {
    title: 'Configure a Site-to-Site VPN backup',
    detail: 'Provides an internet-based fallback path if all Direct Connect paths are unavailable.',
    category: 'architecture',
    classify: (s, _u, t) => {
      if (s.connectionCount === 0 && s.vifCount === 0) return { status: 'attest' };
      if (s.vpnCount === 0) return { status: 'gap' };
      const ids = t.vpnConnections.map((v) => v.vpnConnectionId).filter(Boolean);
      return { status: 'applied', evidence: ids };
    },
  },
  {
    title: 'Match DX region to resource region',
    detail: 'Traffic that leaves the DX region rides the AWS backbone and is not covered by the DX SLA.',
    category: 'architecture',
    classify: (s, uncovered) => {
      if (s.dxRegions.length === 0 || s.resourceRegions.length === 0) return { status: 'attest' };
      if (uncovered.length > 0) return { status: 'gap' };
      return { status: 'applied', evidence: s.dxRegions };
    },
  },
  {
    title: 'Continuous monitoring of VIF BGP state and connection state',
    detail: 'Use CloudWatch metrics and alarms on BGP sessions and connection availability.',
    category: 'operations',
    classify: () => ({ status: 'attest' }),
  },
  {
    title: 'Regularly test failover',
    detail: 'Simulate link loss and confirm traffic re-routes to the backup path automatically.',
    category: 'operations',
    classify: () => ({ status: 'attest' }),
  },
  {
    title: 'Use a Direct Connect Gateway',
    detail: 'Share Direct Connect connections across regions and accounts using a DX Gateway.',
    category: 'architecture',
    classify: (s, _u, t) => {
      if (s.dxGatewayCount === 0) return { status: 'attest' };
      const ids = t.dxGateways.map((g) =>
        g.directConnectGatewayName ? `${g.directConnectGatewayName} (${g.directConnectGatewayId})` : g.directConnectGatewayId
      );
      return { status: 'applied', evidence: ids };
    },
  },
  {
    title: 'Stay within BGP advertisement limits',
    detail: 'Private VIFs accept up to 100 prefixes; public VIFs up to 1000. Summarise routes where possible.',
    category: 'configuration',
    classify: () => ({ status: 'attest' }),
  },
  {
    title: 'Document and maintain a fail-over runbook',
    detail: 'Keep the runbook in sync with topology changes and train on-call staff regularly.',
    category: 'operations',
    classify: () => ({ status: 'attest' }),
  },
];

function renderRecListHtml(recs: Recommendation[], seenAnchors: Set<string>): string {
  if (recs.length === 0) return '';
  return recs.map((r) => {
    const anchorAttr = seenAnchors.has(r.severity) ? '' : ` id="finding-${r.severity}"`;
    seenAnchors.add(r.severity);
    return `
    <div${anchorAttr} class="finding severity-${r.severity}">
      <div class="finding-head">
        <span class="severity-tag" style="background:${SEVERITY_COLOR[r.severity]}20;color:${SEVERITY_COLOR[r.severity]};border:1px solid ${SEVERITY_COLOR[r.severity]}50">${SEVERITY_LABEL[r.severity]}</span>
        <h4>${escapeHtml(r.title)}</h4>
      </div>
      <p>${escapeHtml(r.description)}</p>
    </div>
  `;
  }).join('');
}

function buildHtmlReport(topology: TopologyData, assessment: CombinedAssessment, scenario: string | null, initialTheme: 'light' | 'dark' = 'light'): string {
  const stats = collectTopologyStats(topology);
  // Dedupe resiliency recs that describe the same topology-wide condition (e.g.
  // `single-dx-location`, `no-lag`) — these run per-DXGW so identical copies
  // land in the aggregate list once per gateway. Key on ruleId + title so the
  // High-target (99.9%) and Maximum-target (99.99%) variants stay distinct.
  const resilRecs = (() => {
    const seen = new Set<string>();
    return assessment.resiliency.recommendations.filter((r) => {
      const key = `${r.ruleId}::${r.title}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  })();
  // Dedupe best-practice recs by ruleId — rules like `enterprise-support-required`
  // and `well-architected-review-required` run once per DXGW (keyed to per-gateway
  // target selection), but their body is identical and belongs in the report once.
  const bpRecs = (() => {
    const seen = new Set<string>();
    return assessment.bestPractice.recommendations.filter((r) => {
      if (seen.has(r.ruleId)) return false;
      seen.add(r.ruleId);
      return true;
    });
  })();
  const resilByCat = recsByCategory(resilRecs);

  const locationRows = [...stats.locationConns.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([loc, n]) => `<tr><td>${escapeHtml(loc)}</td><td class="num">${n}</td></tr>`)
    .join('') || `<tr><td colspan="2" class="empty">No Direct Connect locations detected.</td></tr>`;

  const uncoveredRegions = stats.resourceRegions.filter((r) => !stats.dxRegions.includes(r));

  type ClassifiedItem = { item: ReferenceItem; evidence?: string[] };
  const classified: Record<ReferenceStatus, ClassifiedItem[]> = { applied: [], gap: [], attest: [] };
  for (const item of REFERENCE_ITEMS) {
    const result = item.classify(stats, uncoveredRegions, topology);
    classified[result.status].push({ item, evidence: result.evidence });
  }

  const seenAnchors = new Set<string>();

  const when = new Date().toLocaleString();

  const coverageCard = (covered: boolean, title: string, desc: string) =>
    `<li class="coverage-card ${covered ? 'covered' : 'gap'}">
      <span class="coverage-icon">${covered ? '&#10003;' : '&#9675;'}</span>
      <div class="coverage-body">
        <div class="coverage-title">${escapeHtml(title)}</div>
        <div class="coverage-desc">${escapeHtml(desc)}</div>
      </div>
    </li>`;

  // Per-DXGW sections render as repeated "posture + coverage" blocks so each
  // gateway reports against its own target independently. When a topology has
  // no DXGWs (edge case / test fixtures) we fall back to the aggregate view.
  const renderPostureBlock = (
    scopeStats: ReturnType<typeof collectTopologyStats>,
    postureLevel: ResiliencyLevel,
    targetLevel: ResiliencyLevel,
  ): string => {
    const tint = TIER_BADGE_COLOR[postureLevel];
    // User's chosen target defines the "next target" column; also include any
    // other upgrade options computed from the current tier so the reader sees
    // the full upgrade path.
    const allOptions = upgradeOptionsFor(postureLevel, scopeStats);
    const targetOption = allOptions.find((o) => o.level === targetLevel);
    const orderedOptions = targetOption
      ? [targetOption, ...allOptions.filter((o) => o.level !== targetLevel)]
      : allOptions;
    return `<div class="posture-card">
      <div class="posture-flow">
        <div class="posture-block posture-current" style="--tier-tint:${tint}22">
          <div class="label">Current Posture</div>
          <div class="tier-value"><span class="tier-badge" style="background:${tint}">${escapeHtml(TIER_LABELS[postureLevel])}</span></div>
          <div class="sla-value">${escapeHtml(TIER_SLA[postureLevel])}</div>
        </div>
        ${orderedOptions.length === 0
          ? `<div class="posture-block posture-next">
              <div class="label">Next Target</div>
              <div class="tier-value"><span style="color:${SEVERITY_COLOR.info}">At highest tier</span></div>
              <div class="sla-value">Maintain operational best practices</div>
            </div>`
          : orderedOptions.map((opt, i) => {
              const optColor = TIER_BADGE_COLOR[opt.level];
              const header = i === 0
                ? 'Selected Target'
                : orderedOptions.length > 1
                  ? 'Alternative'
                  : 'Next Target';
              return `<div class="posture-block posture-option" style="--option-color:${optColor}">
                <div class="label">${escapeHtml(header)}</div>
                <div class="tier-value"><span class="arrow">&rarr;</span><span class="tier-badge" style="background:${optColor}">${escapeHtml(TIER_LABELS[opt.level])}</span></div>
                <div class="sla-value"><strong style="color:var(--text)">${escapeHtml(TIER_SLA[opt.level])}</strong><br>${escapeHtml(opt.step)}</div>
              </div>`;
            }).join('')}
      </div>
      <p class="posture-summary">${escapeHtml(TIER_SUMMARY[postureLevel])}</p>
    </div>`;
  };

  const renderCoverageBlock = (scopeStats: ReturnType<typeof collectTopologyStats>): string => {
    const hasMultiLoc = scopeStats.locationConns.size >= 2;
    const locationEntries = [...scopeStats.locationConns.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    // Device redundancy is only "covered" in the SLA-tier sense when there
    // are 2+ locations AND every location has 2+ connections. Same-site
    // device redundancy (1 loc × 2 conns) doesn't qualify for a named tier,
    // so it must render as a gap — otherwise the report contradicts the
    // "DEV/TEST — 95%" posture badge shown directly above.
    let deviceCards: string;
    if (locationEntries.length === 0) {
      deviceCards = coverageCard(false, 'Device redundancy', 'No connections detected');
    } else if (locationEntries.length === 1) {
      const [loc, count] = locationEntries[0];
      deviceCards = coverageCard(
        false,
        `Device redundancy at ${loc}`,
        count >= 2
          ? `${count} AWS logical devices at a single location — protects against local device failure but doesn't qualify for the 99.9%/99.99% SLA. Add a second location first.`
          : `Only ${count} AWS logical device — a device outage cuts this location entirely`,
      );
    } else {
      deviceCards = locationEntries.map(([loc, count]) =>
        coverageCard(
          count >= 2,
          `Device redundancy at ${loc}`,
          count >= 2
            ? `${count} AWS logical devices — a device outage is survivable at this location`
            : `Only ${count} AWS logical device — a device outage cuts this location entirely`,
        )
      ).join('');
    }
    return `<ul class="coverage-list">
      ${coverageCard(
        hasMultiLoc,
        'Location redundancy',
        hasMultiLoc
          ? `${scopeStats.locationConns.size} DX locations — an outage at one still leaves the other available`
          : scopeStats.locationConns.size === 1
            ? 'Only 1 DX location — a location-wide outage takes down all connectivity'
            : 'No DX locations detected',
      )}
      ${deviceCards}
    </ul>`;
  };

  const renderImprovementSteps = (
    scopeStats: ReturnType<typeof collectTopologyStats>,
    postureLevel: ResiliencyLevel,
  ): string => {
    const steps = nextStepsFor(postureLevel, scopeStats);
    return `<ol class="steps">${steps.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ol>`;
  };

  // Protection-coverage check list for a scoped stats snapshot. Returns a short
  // human-readable list of gaps plus a "covered" boolean the table uses to
  // pick a chip color. Mirrors the logic in renderCoverageBlock but emits a
  // compact string list instead of card markup.
  const coverageSummary = (
    scopeStats: ReturnType<typeof collectTopologyStats>,
  ): { covered: boolean; gaps: string[] } => {
    const gaps: string[] = [];
    const locCount = scopeStats.locationConns.size;
    if (locCount < 2) {
      gaps.push(locCount === 0 ? 'No DX locations' : 'Single-location only');
    }
    for (const [loc, n] of [...scopeStats.locationConns.entries()].sort()) {
      if (n < 2) gaps.push(`1 conn @ ${loc}`);
    }
    return { covered: gaps.length === 0, gaps };
  };

  // One-line upgrade headline. Picks the user-selected target step if present,
  // otherwise the first remaining option, otherwise calls out that we're at the ceiling.
  const nextStepHeadline = (
    scopeStats: ReturnType<typeof collectTopologyStats>,
    postureLevel: ResiliencyLevel,
    targetLevel: ResiliencyLevel,
  ): { label: string; step: string } => {
    const options = upgradeOptionsFor(postureLevel, scopeStats);
    if (options.length === 0) {
      return { label: 'At highest tier', step: 'Maintain operational best practices.' };
    }
    const chosen = options.find((o) => o.level === targetLevel) ?? options[0];
    return { label: TIER_LABELS[chosen.level], step: chosen.step };
  };

  // Per-DXGW sections: summary table for multi-DXGW, card for no-DXGW fallback.
  // Each DXGW gets a row with scope, current/target tiers, coverage gaps, and
  // the selected upgrade step so readers can scan all gateways at a glance
  // instead of scrolling through repeated card blocks.
  const hasPerDxgw = assessment.perDxGateway.length > 0;
  const perDxgwSections = hasPerDxgw
    ? (() => {
        const rows = assessment.perDxGateway.map((gw) => {
          const scoped = scopeTopologyForDxgw(topology, gw.dxGatewayId);
          const scopedStats = collectTopologyStats(scoped);
          const currentColor = TIER_BADGE_COLOR[gw.currentLevel];
          const targetColor = TIER_BADGE_COLOR[gw.targetLevel];
          const coverage = coverageSummary(scopedStats);
          const next = nextStepHeadline(scopedStats, gw.currentLevel, gw.targetLevel);
          const atCeiling = gw.currentLevel === 'maximum';

          const coverageCell = coverage.covered
            ? `<span class="table-chip chip-ok">&#10003; Fully covered</span>`
            : coverage.gaps
                .map((g) => `<span class="table-chip chip-gap">${escapeHtml(g)}</span>`)
                .join(' ');

          const targetCell = atCeiling
            ? `<span class="table-muted">&mdash;</span>`
            : `<span class="tier-badge" style="background:${targetColor}">${escapeHtml(TIER_LABELS[gw.targetLevel])}</span>
               <div class="table-sla">${escapeHtml(TIER_SLA[gw.targetLevel])}</div>`;

          const nextCell = atCeiling
            ? `<span class="table-muted">Maintain operational best practices.</span>`
            : `<strong>${escapeHtml(next.label)}</strong><div class="table-step">${escapeHtml(next.step)}</div>`;

          return `<tr>
            <td>
              <div class="table-dxgw-name">${escapeHtml(gw.dxGatewayName)}</div>
              ${gw.dxGatewayName !== gw.dxGatewayId ? `<code class="dxgw-id dxgw-id-inline">${escapeHtml(gw.dxGatewayId)}</code>` : ''}
            </td>
            <td>${gw.locationCount} loc &middot; ${gw.connectionCount} conn</td>
            <td>
              <span class="tier-badge" style="background:${currentColor}">${escapeHtml(TIER_LABELS[gw.currentLevel])}</span>
              <div class="table-sla">${escapeHtml(TIER_SLA[gw.currentLevel])}</div>
            </td>
            <td>${targetCell}</td>
            <td>${coverageCell}</td>
            <td>${nextCell}</td>
          </tr>`;
        }).join('');

        return `<table class="dxgw-table">
          <thead>
            <tr>
              <th>DX Gateway</th>
              <th>Scope</th>
              <th>Current</th>
              <th>Target</th>
              <th>Protection Coverage</th>
              <th>Next Step</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>`;
      })()
    : (() => {
        const fallbackLevel = assessment.resiliency.currentLevel;
        const fallbackTarget = assessment.resiliency.targetLevel;
        // Zero DX footprint: tiers don't apply, so swap the red failure
        // posture for a neutral card and frame the upgrade options as
        // getting-started guidance instead of remediation.
        if (assessment.dxNotInUse) {
          const neutral = '#6b7280';
          const options = upgradeOptionsFor('none', stats);
          return `
    <section class="dxgw-section">
      <div class="posture-card">
        <div class="posture-flow">
          <div class="posture-block posture-current" style="--tier-tint:${neutral}22">
            <div class="label">Current Posture</div>
            <div class="tier-value"><span class="tier-badge" style="background:${neutral}">Direct Connect not in use</span></div>
            <div class="sla-value">DX SLA tiers not applicable</div>
          </div>
          ${options.map((opt) => {
            const optColor = TIER_BADGE_COLOR[opt.level];
            return `<div class="posture-block posture-option" style="--option-color:${optColor}">
              <div class="label">Getting started with Direct Connect</div>
              <div class="tier-value"><span class="arrow">&rarr;</span><span class="tier-badge" style="background:${optColor}">${escapeHtml(TIER_LABELS[opt.level])}</span></div>
              <div class="sla-value"><strong style="color:var(--text)">${escapeHtml(TIER_SLA[opt.level])}</strong><br>${escapeHtml(opt.step)}</div>
            </div>`;
          }).join('')}
        </div>
        <p class="posture-summary">This account has no Direct Connect connections, virtual interfaces, or DX gateways — it connects via VPN / Transit Gateway. VPN and Transit Gateway posture is assessed under Best Practices below.</p>
      </div>
      <h4 class="subsection-title">Getting Started</h4>
      ${renderImprovementSteps(stats, 'none')}
    </section>`;
        }
        return `
    <section class="dxgw-section">
      ${renderPostureBlock(stats, fallbackLevel, fallbackTarget)}
      <h4 class="subsection-title">Protection Coverage</h4>
      <p class="coverage-subtitle">Independent checks — each protects against a different failure mode.</p>
      <div class="coverage-section">${renderCoverageBlock(stats)}</div>
      <h4 class="subsection-title">How to Improve</h4>
      ${renderImprovementSteps(stats, fallbackLevel)}
    </section>`;
      })();

  return `<!DOCTYPE html>
<html lang="en" data-theme="${initialTheme}">
<head>
<meta charset="UTF-8">
<title>Network Resilience Review (Direct Connect)</title>
<style>
  :root, [data-theme="light"] {
    --bg: #ffffff;
    --card: #f8fafc;
    --border: #e2e8f0;
    --text: #0f172a;
    --muted: #64748b;
    --accent: #2563eb;
    --shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
  }
  [data-theme="dark"] {
    --bg: #0f172a;
    --card: #1e293b;
    --border: #334155;
    --text: #e2e8f0;
    --muted: #94a3b8;
    --accent: #60a5fa;
    --shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
  }
  * { box-sizing: border-box; }
  html, body { background: var(--bg); }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: var(--text); margin: 0; padding: 40px 24px; -webkit-font-smoothing: antialiased; transition: background-color 0.2s ease, color 0.2s ease; }
  .container { max-width: 960px; margin: 0 auto; }
  header.page-header { border-bottom: 1px solid var(--border); padding-bottom: 20px; margin-bottom: 28px; display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
  header.page-header .title-block { flex: 1; min-width: 0; }
  h1 { margin: 0 0 6px 0; font-size: 26px; letter-spacing: -0.01em; }
  h2 { margin: 36px 0 14px; font-size: 18px; letter-spacing: -0.01em; border-bottom: 1px solid var(--border); padding-bottom: 8px; }
  h3 { margin: 20px 0 10px; font-size: 14px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }
  h4 { margin: 0; font-size: 14px; }
  p { line-height: 1.55; color: var(--text); }
  code { background: var(--card); padding: 1px 6px; border-radius: 4px; font-size: 0.9em; }
  .meta { color: var(--muted); font-size: 12px; }
  .posture-card { border: 1px solid var(--border); border-radius: 10px; background: var(--card); box-shadow: var(--shadow); overflow: hidden; }
  .posture-flow { display: flex; align-items: stretch; gap: 0; flex-wrap: wrap; }
  .posture-block { flex: 1; min-width: 200px; padding: 16px 20px; position: relative; }
  .posture-block + .posture-block { border-left: 1px solid var(--border); }
  .posture-block .label { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600; margin-bottom: 10px; }
  .posture-block .tier-value { font-size: 17px; font-weight: 600; line-height: 1.3; margin-bottom: 6px; }
  .posture-block .sla-value { font-size: 12px; color: var(--muted); line-height: 1.5; }
  .posture-current { background: linear-gradient(135deg, var(--tier-tint) 0%, transparent 55%); }
  .posture-next .arrow { display: inline-block; color: var(--muted); margin-right: 6px; font-weight: 400; }
  .posture-option { position: relative; }
  .posture-option::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: var(--option-color); }
  .posture-option .arrow { display: inline-block; color: var(--muted); margin-right: 6px; font-weight: 400; }
  .posture-option .sla-value strong { font-weight: 600; }
  .posture-summary { margin: 0; padding: 12px 20px; border-top: 1px solid var(--border); background: var(--bg); color: var(--muted); font-size: 12px; line-height: 1.55; }
  .tier-badge { display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 11px; font-weight: 600; color: white; letter-spacing: 0.01em; }
  .findings-strip { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
  .finding-card { border: 1px solid var(--border); border-left: 3px solid var(--border); border-radius: 8px; padding: 14px 16px; background: var(--card); box-shadow: var(--shadow); display: flex; align-items: center; gap: 16px; text-decoration: none; color: inherit; transition: transform 0.1s ease, border-color 0.15s ease, box-shadow 0.15s ease; }
  a.finding-card.clickable { cursor: pointer; }
  a.finding-card.clickable:hover { transform: translateY(-1px); border-color: var(--accent); box-shadow: 0 2px 8px rgba(15, 23, 42, 0.08); }
  a.finding-card.clickable:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  :target.finding { animation: flash 1.2s ease-out; }
  @keyframes flash { 0% { background: var(--accent); background: color-mix(in srgb, var(--accent) 15%, var(--card)); } 100% { background: var(--card); } }
  html { scroll-behavior: smooth; scroll-padding-top: 16px; }
  .finding-card.f-critical { border-left-color: ${SEVERITY_COLOR.critical}; }
  .finding-card.f-warning  { border-left-color: ${SEVERITY_COLOR.warning}; }
  .finding-card.f-info     { border-left-color: ${SEVERITY_COLOR.info}; }
  .finding-card .count { font-size: 28px; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1; min-width: 32px; }
  .finding-card.f-critical .count { color: ${SEVERITY_COLOR.critical}; }
  .finding-card.f-warning  .count { color: ${SEVERITY_COLOR.warning}; }
  .finding-card.f-info     .count { color: ${SEVERITY_COLOR.info}; }
  .finding-card.zero .count { color: var(--muted); }
  .finding-card .caption { flex: 1; min-width: 0; }
  .finding-card .caption .name { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
  .finding-card .caption .hint { font-size: 11px; color: var(--muted); margin-top: 3px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 8px; }
  table th, table td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--border); }
  table th { background: var(--card); font-weight: 600; font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.03em; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  table.dxgw-table { table-layout: auto; margin-top: 14px; }
  table.dxgw-table th, table.dxgw-table td { vertical-align: top; padding: 10px 12px; }
  table.dxgw-table tbody tr + tr td { border-top: 1px solid var(--border); }
  table.dxgw-table .table-dxgw-name { font-weight: 600; font-size: 13px; color: var(--text); margin-bottom: 2px; }
  table.dxgw-table .dxgw-id-inline { display: inline-block; padding: 0; background: transparent; }
  table.dxgw-table .table-sla { font-size: 11px; color: var(--muted); margin-top: 4px; }
  table.dxgw-table .table-step { font-size: 12px; color: var(--muted); margin-top: 3px; line-height: 1.45; }
  table.dxgw-table .table-muted { color: var(--muted); font-size: 12px; }
  .table-chip { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; margin: 1px 2px 1px 0; letter-spacing: 0.01em; }
  .table-chip.chip-ok { background: ${TIER_BADGE_COLOR.high}22; color: ${TIER_BADGE_COLOR.high}; border: 1px solid ${TIER_BADGE_COLOR.high}55; }
  .table-chip.chip-gap { background: ${SEVERITY_COLOR.warning}22; color: ${SEVERITY_COLOR.warning}; border: 1px solid ${SEVERITY_COLOR.warning}55; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .dxgw-section { border: 1px solid var(--border); border-radius: 10px; padding: 18px 20px; margin: 14px 0; background: var(--bg); }
  .dxgw-section + .dxgw-section { margin-top: 18px; }
  .dxgw-section-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 14px; padding-bottom: 10px; border-bottom: 1px solid var(--border); }
  .dxgw-section-title { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; min-width: 0; }
  .dxgw-chip { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, transparent); border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent); padding: 2px 8px; border-radius: 999px; }
  .dxgw-name { font-size: 15px; font-weight: 600; color: var(--text); }
  .dxgw-id { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; color: var(--muted); background: var(--card); padding: 1px 6px; border-radius: 4px; }
  .dxgw-section-meta { font-size: 12px; color: var(--muted); }
  .subsection-title { font-size: 13px; font-weight: 600; color: var(--text); margin: 18px 0 6px; text-transform: uppercase; letter-spacing: 0.04em; }
  .coverage-section { margin: 10px 0 16px; }
  .coverage-subtitle { color: var(--muted); font-size: 13px; margin: 0 0 14px; line-height: 1.5; }
  .coverage-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 8px; }
  .coverage-card { display: flex; gap: 14px; align-items: flex-start; padding: 14px 16px; border: 1px solid var(--border); border-radius: 8px; background: var(--card); }
  .coverage-icon { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 50%; font-size: 14px; font-weight: 700; flex-shrink: 0; margin-top: 1px; }
  .coverage-card.covered .coverage-icon { background: ${TIER_BADGE_COLOR.high}22; color: ${TIER_BADGE_COLOR.high}; }
  .coverage-card.gap .coverage-icon { background: ${SEVERITY_COLOR.warning}22; color: ${SEVERITY_COLOR.warning}; border: 1.5px solid ${SEVERITY_COLOR.warning}50; }
  .coverage-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
  .coverage-title { font-size: 14px; font-weight: 600; }
  .coverage-card.covered .coverage-title { color: var(--text); }
  .coverage-card.gap .coverage-title { color: ${SEVERITY_COLOR.warning}; }
  .coverage-desc { font-size: 12px; color: var(--muted); line-height: 1.45; }
  ol.steps { padding-left: 20px; }
  ol.steps li { margin-bottom: 8px; line-height: 1.55; }
  .finding { border: 1px solid var(--border); border-left: 4px solid var(--border); border-radius: 6px; padding: 12px 16px; margin-bottom: 10px; background: var(--card); }
  .finding.severity-critical { border-left-color: ${SEVERITY_COLOR.critical}; }
  .finding.severity-warning  { border-left-color: ${SEVERITY_COLOR.warning}; }
  .finding.severity-info     { border-left-color: ${SEVERITY_COLOR.info}; }
  .finding .finding-head { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
  .finding p { margin: 0; font-size: 13px; color: var(--muted); line-height: 1.5; }
  .severity-tag { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; padding: 2px 7px; border-radius: 4px; }
  .empty { color: var(--muted); font-style: italic; font-size: 13px; }
  .bp-group-title { display: flex; align-items: center; gap: 8px; margin: 22px 0 10px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: none; padding: 0; color: var(--text); }
  .bp-group-title .bp-count { display: inline-flex; align-items: center; justify-content: center; min-width: 22px; height: 22px; padding: 0 7px; border-radius: 11px; font-size: 12px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .bp-group-applied { color: ${TIER_BADGE_COLOR.high}; }
  .bp-group-applied .bp-count { background: ${TIER_BADGE_COLOR.high}22; color: ${TIER_BADGE_COLOR.high}; }
  .bp-group-alert { color: ${SEVERITY_COLOR.critical}; }
  .bp-group-alert .bp-count { background: ${SEVERITY_COLOR.critical}22; color: ${SEVERITY_COLOR.critical}; }
  .bp-group-gap { color: ${SEVERITY_COLOR.warning}; }
  .bp-group-gap .bp-count { background: ${SEVERITY_COLOR.warning}22; color: ${SEVERITY_COLOR.warning}; }
  .bp-group-attest { color: var(--muted); }
  .bp-group-attest .bp-count { background: var(--card); color: var(--muted); border: 1px solid var(--border); }
  ul.bp-list { list-style: none; padding: 0; margin: 0 0 6px; }
  .bp-item { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; margin-bottom: 6px; border: 1px solid var(--border); border-left: 3px solid var(--border); border-radius: 6px; background: var(--card); font-size: 13px; }
  .bp-item-applied { border-left-color: ${TIER_BADGE_COLOR.high}; }
  .bp-item-alert { border-left-color: ${SEVERITY_COLOR.critical}; }
  .bp-item-gap { border-left-color: ${SEVERITY_COLOR.warning}; }
  .bp-item-attest { border-left-color: var(--border); }
  .bp-item .bp-icon { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; border-radius: 50%; font-size: 12px; font-weight: 700; flex-shrink: 0; margin-top: 1px; }
  .bp-item-applied .bp-icon { background: ${TIER_BADGE_COLOR.high}22; color: ${TIER_BADGE_COLOR.high}; }
  .bp-item-alert .bp-icon { background: ${SEVERITY_COLOR.critical}22; color: ${SEVERITY_COLOR.critical}; }
  .bp-item-gap .bp-icon { background: ${SEVERITY_COLOR.warning}22; color: ${SEVERITY_COLOR.warning}; }
  .bp-item-attest .bp-icon { background: var(--bg); color: var(--muted); border: 1px solid var(--border); }
  .bp-item .bp-body { display: flex; flex-direction: column; gap: 4px; min-width: 0; flex: 1; }
  .bp-item .bp-detail { color: var(--muted); font-size: 12px; line-height: 1.45; }
  .bp-evidence { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 2px; }
  .bp-evidence-chip { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; padding: 2px 7px; border-radius: 4px; background: ${TIER_BADGE_COLOR.high}14; color: ${TIER_BADGE_COLOR.high}; border: 1px solid ${TIER_BADGE_COLOR.high}40; }
  .region-chip { display: inline-block; padding: 2px 8px; border: 1px solid var(--border); border-radius: 4px; font-family: ui-monospace, monospace; font-size: 11px; margin-right: 4px; }
  footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid var(--border); font-size: 11px; color: var(--muted); }
  a { color: var(--accent); }

  .theme-toggle {
    display: inline-flex; align-items: center; gap: 6px;
    background: var(--card); border: 1px solid var(--border); color: var(--text);
    padding: 6px 10px; border-radius: 8px; cursor: pointer; font-size: 12px;
    font-family: inherit; transition: background 0.15s ease, border-color 0.15s ease;
    flex-shrink: 0;
  }
  .theme-toggle:hover { border-color: var(--accent); }
  .theme-toggle svg { width: 14px; height: 14px; }
  .theme-toggle .icon-light, [data-theme="dark"] .theme-toggle .icon-dark { display: none; }
  [data-theme="dark"] .theme-toggle .icon-light { display: inline-block; }
  .theme-toggle .label-light, [data-theme="dark"] .theme-toggle .label-dark { display: none; }
  [data-theme="dark"] .theme-toggle .label-light { display: inline; }

  @media (max-width: 640px) {
    .findings-strip { grid-template-columns: 1fr; }
    .posture-block + .posture-block { border-left: none; border-top: 1px solid var(--border); }
  }

  @media print {
    body { padding: 0; background: white; color: black; }
    .container { max-width: 100%; }
    .theme-toggle { display: none; }
    h2 { page-break-after: avoid; }
    .posture-card, .finding-card { break-inside: avoid; }
    h2#appendix-start, h2.appendix { page-break-before: always; }
  }
</style>
</head>
<body>
<div class="container">
  <header class="page-header">
    <div class="title-block">
      <h1>Network Resilience Review (Direct Connect)</h1>
      <div class="meta">Generated ${escapeHtml(when)}${topology.homeAccountId ? ` &middot; Account ${escapeHtml(topology.homeAccountId)}` : ''}${scenario ? ` &middot; Mock scenario: <code>${escapeHtml(scenario)}</code>` : ''}</div>
    </div>
    <button type="button" class="theme-toggle" id="theme-toggle" aria-label="Toggle theme">
      <svg class="icon-light" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="5"></circle>
        <line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line>
        <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
        <line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line>
        <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
      </svg>
      <svg class="icon-dark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
      </svg>
      <span class="label-light">Light</span>
      <span class="label-dark">Dark</span>
    </button>
  </header>

  <h2>1. Resilience</h2>
  ${hasPerDxgw
    ? `<p class="meta">Where each DX Gateway stands today and what's needed to reach the selected target tier.</p>`
    : `<p class="meta">Where the topology stands today and what's needed to reach the target tier. No DX Gateways were detected, so a single combined view is shown.</p>`}
  ${perDxgwSections}

  ${resilRecs.length ? `
    <h3>How to improve resiliency</h3>
    ${renderRecListHtml(resilByCat.critical, seenAnchors)}
    ${renderRecListHtml(resilByCat.warning, seenAnchors)}
    ${renderRecListHtml(resilByCat.info, seenAnchors)}
  ` : ''}

  <h2>2. Best Practices</h2>
  <p class="meta">Canonical AWS Direct Connect practices, scored against your current topology. Items already covered by the resilience tier above (location/device redundancy) are not repeated here.</p>

  ${(() => {
    const rows: BpRow[] = [];

    // 1. Live op-rule findings.
    for (const r of bpRecs) {
      if (OP_RULES_WITH_REF_EQUIVALENT.has(r.ruleId)) continue;
      let status: BpRowStatus;
      if (r.severity === 'critical' || r.severity === 'warning') status = 'alert';
      else status = 'verify';
      const category = RULE_CATEGORY[r.ruleId] ?? 'configuration';
      rows.push({ practice: r.title, status, detail: r.description, category });
    }

    // 2. Reference items (minus the two tier items covered by §1).
    const pushRefRow = (items: ClassifiedItem[], status: BpRowStatus) => {
      for (const c of items) {
        if (TIER_REF_TITLES.has(c.item.title)) continue;
        rows.push({ practice: c.item.title, status, detail: c.item.detail, evidence: c.evidence, category: c.item.category });
      }
    };
    pushRefRow(classified.applied, 'applied');
    pushRefRow(classified.gap, 'gap');
    pushRefRow(classified.attest, 'verify');

    // Sort within each category: critical → warning → info/verify → applied
    const statusRank = (s: BpRowStatus) => s === 'alert' ? 0 : s === 'gap' ? 1 : s === 'verify' ? 2 : 3;
    rows.sort((a, b) => statusRank(a.status) - statusRank(b.status));

    const categories: Array<{ category: BpCategory; label: string }> = [
      { category: 'architecture', label: 'Architecture' },
      { category: 'configuration', label: 'Configuration' },
      { category: 'operations', label: 'Operations' },
    ];

    return categories.map((g) => {
      const groupRows = rows.filter((r) => r.category === g.category);
      if (groupRows.length === 0) return '';
      const body = `<ul class="bp-list">${groupRows.map((r) => {
            const icon = r.status === 'applied' ? '&#10003;'
              : r.status === 'alert' ? '!'
              : r.status === 'gap' ? '!'
              : '&#9675;';
            const cls = r.status === 'alert' ? 'bp-item-alert'
              : r.status === 'gap' ? 'bp-item-gap'
              : r.status === 'applied' ? 'bp-item-applied'
              : 'bp-item-attest';
            const evidenceHtml = r.evidence && r.evidence.length > 0
              ? `<div class="bp-evidence">${r.evidence.map((e) => `<code class="bp-evidence-chip">${escapeHtml(e)}</code>`).join('')}</div>`
              : '';
            const showDetail = r.status !== 'applied';
            return `<li class="bp-item ${cls}">
              <span class="bp-icon" aria-hidden="true">${icon}</span>
              <div class="bp-body">
                <strong>${escapeHtml(r.practice)}</strong>
                ${showDetail ? `<span class="bp-detail">${escapeHtml(r.detail)}</span>` : ''}
                ${evidenceHtml}
              </div>
            </li>`;
          }).join('')}</ul>`;
      return `<h3 class="bp-group-title bp-group-gap">
        <span class="bp-count">${groupRows.length}</span> ${escapeHtml(g.label)}
      </h3>
      ${body}`;
    }).join('');
  })()}

  <h2 class="appendix" id="appendix-start">Appendix A &middot; Topology Snapshot</h2>
  <p class="meta">Resource inventory discovered from AWS APIs at the time of report generation.</p>

  <h3>Resource Inventory</h3>
  <table>
    <thead><tr><th>Resource</th><th style="text-align:right">Count</th></tr></thead>
    <tbody>
      <tr><td>Direct Connect connections</td><td class="num">${stats.connectionCount}</td></tr>
      <tr><td>Virtual Interfaces (VIFs)</td><td class="num">${stats.vifCount}</td></tr>
      <tr><td>DX Gateways</td><td class="num">${stats.dxGatewayCount}</td></tr>
      <tr><td>Transit Gateways</td><td class="num">${stats.tgwCount}</td></tr>
      <tr><td>Virtual Private Gateways</td><td class="num">${stats.vgwCount}</td></tr>
      <tr><td>VPCs</td><td class="num">${stats.vpcCount}</td></tr>
      <tr><td>Site-to-Site VPN connections</td><td class="num">${stats.vpnCount}</td></tr>
    </tbody>
  </table>

  <h3>Direct Connect Locations (${stats.locationConns.size})</h3>
  <table>
    <thead><tr><th>Location</th><th style="text-align:right">AWS Logical Devices</th></tr></thead>
    <tbody>${locationRows}</tbody>
  </table>

  <h3>Regions</h3>
  <table>
    <thead><tr><th>Category</th><th>Regions</th><th style="text-align:right">Count</th></tr></thead>
    <tbody>
      <tr>
        <td><strong>DX regions</strong></td>
        <td>${stats.dxRegions.length ? stats.dxRegions.map((r) => `<span class="region-chip">${escapeHtml(r)}</span>`).join('') : '<span class="empty">None</span>'}</td>
        <td class="num">${stats.dxRegions.length}</td>
      </tr>
      <tr>
        <td><strong>Resource regions</strong></td>
        <td>${stats.resourceRegions.length ? stats.resourceRegions.map((r) => `<span class="region-chip">${escapeHtml(r)}</span>`).join('') : '<span class="empty">None</span>'}</td>
        <td class="num">${stats.resourceRegions.length}</td>
      </tr>
      <tr>
        <td><strong>Resource regions without local DX</strong></td>
        <td>${uncoveredRegions.length ? uncoveredRegions.map((r) => `<span class="region-chip" style="border-color:${SEVERITY_COLOR.warning};color:${SEVERITY_COLOR.warning}">${escapeHtml(r)}</span>`).join('') : '<span class="empty">None &mdash; all resource regions have local DX</span>'}</td>
        <td class="num" style="${uncoveredRegions.length ? `color:${SEVERITY_COLOR.warning}` : ''}">${uncoveredRegions.length}</td>
      </tr>
    </tbody>
  </table>

  <footer>
    Generated by the Network Resilience Agent. Verify SLA tiers and numbers against the
    <a href="https://docs.aws.amazon.com/directconnect/latest/UserGuide/" target="_blank" rel="noreferrer">AWS Direct Connect documentation</a>.
  </footer>
</div>
<script>
  (function () {
    var KEY = 'dx-report-theme';
    var root = document.documentElement;
    var toggle = document.getElementById('theme-toggle');

    function apply(theme) {
      root.setAttribute('data-theme', theme);
      try { localStorage.setItem(KEY, theme); } catch (e) {}
    }

    var saved = null;
    try { saved = localStorage.getItem(KEY); } catch (e) {}
    var initial = root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    apply(saved || initial);

    if (toggle) {
      toggle.addEventListener('click', function () {
        var current = root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
        apply(current === 'dark' ? 'light' : 'dark');
      });
    }
  })();
</script>
</body>
</html>`;
}

export function useExportReport() {
  const topologyData = useTopologyStore((s) => s.topologyData);
  const assessment = useTopologyStore((s) => s.assessment);
  const useMock = useTopologyStore((s) => s.useMock);
  const mockScenario = useTopologyStore((s) => s.mockScenario);
  const theme = useTopologyStore((s) => s.theme);

  return useCallback(() => {
    if (!topologyData || !assessment) return;
    const scenario = useMock ? mockScenario : null;
    const html = buildHtmlReport(topologyData, assessment, scenario, theme);
    download(html, `resilience-report-${timestamp()}.html`, 'text/html;charset=utf-8');
  }, [topologyData, assessment, useMock, mockScenario, theme]);
}
