import { useState } from 'react';
import { useTopologyStore } from '../store/topology-store';
import { useIsLight } from '../hooks/useTheme';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useExportReport } from '../hooks/useExportReport';
import { COLORS } from '../utils/colors';
import type { Recommendation, DxGatewayAssessment, VgwAssessment, PublicVifAssessment } from '../types/recommendations';
import type { TopologyData } from '../types/topology';
import type { ResiliencyTarget } from '../engine/resiliency-rules';
import { FOCUSED_PUBLIC_VIF, buildPublicVifScope } from '../engine/recommendation-engine';
import { getLocationDeviceCounts } from '../engine/sla-gating';

const tierColors: Record<string, string> = {
  none: COLORS.severity.critical,
  devtest: COLORS.severity.warning,
  high: '#22c55e',
  maximum: '#06b6d4',
};

const tierLabels: Record<string, string> = {
  none: 'No Resiliency',
  devtest: 'Development & Testing',
  high: 'High Resiliency',
  maximum: 'Maximum Resiliency',
};

// Compact variants used in dense per-DXGW header rows where the full label
// dominates. Full labels are kept for the SLA Tier strip where there's room.
const tierShortLabels: Record<string, string> = {
  none: 'No SLA',
  devtest: 'Dev/Test',
  high: 'High',
  maximum: 'Maximum',
};

const tierSla: Record<string, string | null> = {
  none: null,
  devtest: '95%',
  high: '99.9%',
  maximum: '99.99%',
};

const severityColors: Record<string, string> = {
  critical: COLORS.severity.critical,
  warning: COLORS.severity.warning,
  info: '#3b82f6',
};

type ChecklistGroup = 'architecture' | 'configuration' | 'operations';

interface ChecklistItem {
  label: string;
  met: boolean;
  detail?: React.ReactNode;
  severity?: 'critical' | 'warning' | 'info';
  tier?: string;
  // Category grouping for the Best Practices section. Defaults to
  // 'configuration' for anything not explicitly tagged.
  group?: ChecklistGroup;
}

interface TierProgressionOption {
  level: string;
  step: string;
}

interface TierProgression {
  currentLevel: string;
  // Multiple options when there's a real choice (e.g., from "none" the user
  // can target High or Maximum); single entry when the progression is linear.
  options: TierProgressionOption[];
}

function buildChecklist(
  topology: TopologyData | null,
  recommendations: Recommendation[],
  light: boolean,
  opts?: { dxNotInUse?: boolean },
): {
  coverageChecklist: ChecklistItem[];
  bestPracticeChecklist: ChecklistItem[];
  tierProgression: TierProgression | null;
} {
  if (!topology) return { coverageChecklist: [], bestPracticeChecklist: [], tierProgression: null };

  // Use unique AWS logical devices per location — two connections sharing
  // a logical device are one SPOF, not two redundant paths.
  const locationConns = getLocationDeviceCounts(topology);

  const locCount = locationConns.size;
  const allHaveMultiple = locCount > 0 && [...locationConns.values()].every((c) => c >= 2);
  const underprovisioned = [...locationConns.entries()].filter(([, c]) => c < 2).map(([loc]) => loc);

  // Labels use consistent noun-based phrasing ("X redundancy") so pass and
  // fail rows scan the same way down the column — the row color and checkmark
  // communicate met/unmet, the label names the check itself.
  //
  // Zero DX footprint: "no locations / no connections" aren't failed checks,
  // they're a statement that DX tiering doesn't apply. One info row (excluded
  // from the unmet count) replaces the two unmet redundancy rows; the
  // 'none'-level progression options below double as getting-started guidance.
  const coverageChecklist: ChecklistItem[] = opts?.dxNotInUse
    ? [
        {
          label: 'Direct Connect not in use',
          met: false,
          severity: 'info',
          detail: 'This account has no Direct Connect connections, virtual interfaces, or DX gateways. DX SLA tiers do not apply — VPN and Transit Gateway posture is assessed under Best Practices.',
        },
      ]
    : [
        {
          label: 'Location redundancy',
          met: locCount >= 2,
          detail: locCount >= 2
            ? `${locCount} DX locations — outage at one still leaves the other available`
            : locCount === 1
              ? 'Only 1 location — a facility-wide outage would cut all Direct Connect paths'
              : 'No Direct Connect locations detected',
        },
      ];

  // Device redundancy in the AWS SLA sense requires 2+ locations AND 2+ conns
  // at each. Same-site device redundancy (1 location × 2 conns) technically
  // survives a device failure, but doesn't qualify for a named SLA tier — it's
  // still covered only by the Single Connection 95% SLA per Connection.
  // Marking it ✅ here misleads users into thinking they've cleared the check
  // when the score card still shows DEV/TEST.
  if (opts?.dxNotInUse) {
    // No device-redundancy row — the single info row above covers the zero-DX case.
  } else if (locCount === 0) {
    coverageChecklist.push({
      label: 'Device redundancy',
      met: false,
      detail: 'No connections detected',
    });
  } else if (locCount === 1) {
    const deviceCount = [...locationConns.values()][0];
    coverageChecklist.push({
      label: 'Device redundancy',
      met: false,
      detail: deviceCount >= 2
        ? `${deviceCount} AWS logical devices at a single location protect against local device failure, but don't qualify for the 99.9%/99.99% SLA — add a second location first`
        : 'Only 1 AWS logical device — a device outage cuts all Direct Connect paths',
    });
  } else if (allHaveMultiple) {
    coverageChecklist.push({
      label: 'Device redundancy',
      met: true,
      detail: 'Every location has 2+ connections on separate AWS logical devices',
    });
  } else {
    for (const loc of underprovisioned) {
      coverageChecklist.push({
        label: `Device redundancy at ${loc}`,
        met: false,
        detail: 'Connections at this location share a single AWS logical device — a device outage cuts the location entirely',
      });
    }
    const protectedLocs = [...locationConns.entries()].filter(([, c]) => c >= 2).map(([loc]) => loc);
    for (const loc of protectedLocs) {
      coverageChecklist.push({
        label: `Device redundancy at ${loc}`,
        met: true,
        detail: `${locationConns.get(loc)} connections on separate AWS logical devices`,
      });
    }
  }

  // SLA tier progression — from none/devtest the user has a real choice
  // between High and Maximum; from high the only next step is Maximum.
  // Mirrors determineResiliencyLevel in recommendation-engine.ts: any topology
  // with at least one connection falls under AWS's "Single Connection" 95% SLA,
  // which we surface as 'devtest' here.
  const currentLevel = locCount === 0
    ? 'none'
    : locCount >= 2 && allHaveMultiple
      ? 'maximum'
      : locCount >= 2
        ? 'high'
        : 'devtest';

  const options: TierProgressionOption[] = [];

  if (currentLevel === 'none') {
    options.push({
      level: 'high',
      step: 'Provision Direct Connect at 2 separate locations (2 connections total)',
    });
    options.push({
      level: 'maximum',
      step: 'Provision 2 connections at 2 separate locations (4 connections total)',
    });
  } else if (currentLevel === 'devtest') {
    options.push({
      level: 'high',
      step: 'Add a connection at a second location',
    });
    options.push({
      level: 'maximum',
      step: 'Add a second location with 2 connections',
    });
  } else if (currentLevel === 'high') {
    const list = underprovisioned.length === 1
      ? underprovisioned[0]
      : underprovisioned.length === 2
        ? underprovisioned.join(' and ')
        : `${underprovisioned.slice(0, -1).join(', ')}, and ${underprovisioned[underprovisioned.length - 1]}`;
    options.push({
      level: 'maximum',
      step: `Add a connection on a separate AWS logical device at ${list}`,
    });
  }

  const tierProgression: TierProgression = { currentLevel, options };

  const hasVpnBackup = !recommendations.some((r) => r.ruleId === 'no-vpn-backup');
  const hasVifDown = recommendations.some((r) => r.ruleId === 'vif-down');
  const hasConnDown = recommendations.some((r) => r.ruleId === 'connection-not-available');

  const bestPracticeChecklist: ChecklistItem[] = [];

  if (hasConnDown) {
    const recs = recommendations.filter((r) => r.ruleId === 'connection-not-available');
    bestPracticeChecklist.push({
      label: 'Ensure all Direct Connect connections are available',
      met: false,
      detail: recs.map((r) => r.description).join(' '),
      severity: 'critical',
      group: 'configuration',
    });
  }

  if (hasVifDown) {
    const recs = recommendations.filter((r) => r.ruleId === 'vif-down');
    bestPracticeChecklist.push({
      label: 'Ensure all Virtual Interface BGP sessions are established',
      met: false,
      detail: recs.map((r) => r.description).join(' '),
      severity: 'critical',
      group: 'configuration',
    });
  }

  bestPracticeChecklist.push({
    label: 'Ensure a Site-to-Site VPN failover path is configured',
    met: hasVpnBackup,
    detail: hasVpnBackup
      ? 'A Site-to-Site VPN connection is configured and can serve as a failover path if the Direct Connect link goes down. Note: a VPN backup does not improve the Direct Connect SLA — it only provides a failover path.'
      : 'No Site-to-Site VPN configured — Direct Connect has no failover path. A VPN backup does not improve the Direct Connect SLA, but it provides a budget-friendly failover option.',
    severity: hasVpnBackup ? undefined : 'warning',
    group: 'architecture',
  });

  const bfdDocLink = (
    <a
      href="https://repost.aws/knowledge-center/enable-bfd-direct-connect"
      target="_blank"
      rel="noopener noreferrer"
      className={`underline underline-offset-2 font-medium ${light ? 'text-blue-600 hover:text-blue-700' : 'text-blue-400 hover:text-blue-300'}`}
      onClick={(e) => e.stopPropagation()}
    >
      Enable BFD for Direct Connect
    </a>
  );

  bestPracticeChecklist.push({
    label: 'Ensure Bidirectional Forwarding Detection (BFD) is enabled',
    met: false,
    detail: (
      <span>
        Without BFD, failover relies on BGP hold timers, which can take up to 90 seconds to detect a link failure. BFD reduces detection to under a second. Configure BFD with a minimum interval of 300 ms and a liveness-detection multiplier of 3, and disable BGP graceful restart so BFD-driven failover is not delayed. See {bfdDocLink}.
      </span>
    ),
    severity: 'info',
    group: 'configuration',
  });

  const slaDocLink = (
    <a
      href="https://aws.amazon.com/directconnect/sla/"
      target="_blank"
      rel="noopener noreferrer"
      className={`underline underline-offset-2 font-medium ${light ? 'text-blue-600 hover:text-blue-700' : 'text-blue-400 hover:text-blue-300'}`}
      onClick={(e) => e.stopPropagation()}
    >
      AWS Direct Connect SLA
    </a>
  );

  const hasEnterpriseSupportPrereq = recommendations.some(
    (r) => r.ruleId === 'enterprise-support-required',
  );
  if (hasEnterpriseSupportPrereq) {
    bestPracticeChecklist.push({
      label: 'Confirm Enterprise Support plan (required for 99.9% / 99.99% SLA)',
      met: false,
      detail: <span>Required for the 99.9% and 99.99% Direct Connect SLAs. See {slaDocLink}.</span>,
      severity: 'info',
      group: 'architecture',
    });
  }

  const hasWarReviewPrereq = recommendations.some(
    (r) => r.ruleId === 'well-architected-review-required',
  );
  if (hasWarReviewPrereq) {
    bestPracticeChecklist.push({
      label: 'Confirm Well-Architected Review (required for 99.99% SLA)',
      met: false,
      detail: <span>Required for the 99.99% Direct Connect SLA, in addition to Enterprise Support. See {slaDocLink}.</span>,
      severity: 'info',
      group: 'architecture',
    });
  }

  // Link helpers for the new info cards below. Reuses the same styling used
  // for `bfdDocLink` / `slaDocLink` above so every doc reference looks consistent.
  const link = (href: string, text: string) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`underline underline-offset-2 font-medium ${light ? 'text-blue-600 hover:text-blue-700' : 'text-blue-400 hover:text-blue-300'}`}
      onClick={(e) => e.stopPropagation()}
    >
      {text}
    </a>
  );

  // --- New guidance-only info cards ---
  if (recommendations.some((r) => r.ruleId === 'sla-awareness')) {
    bestPracticeChecklist.push({
      label: 'Understand Direct Connect SLA tiers',
      met: false,
      detail: (
        <span>
          AWS publishes three SLA tiers: Single Connection (95%), Multi-Site Non-Redundant (99.9%, 2+ locations), and Multi-Site Redundant (99.99%, 2+ locations with 2+ devices each). Only the Maximum Resiliency model qualifies for the highest SLA. See {link('https://aws.amazon.com/directconnect/sla/', 'AWS Direct Connect SLA')}.
        </span>
      ),
      severity: 'info',
      group: 'architecture',
    });
  }

  if (recommendations.some((r) => r.ruleId === 'resiliency-toolkit')) {
    bestPracticeChecklist.push({
      label: 'Use the Direct Connect Resiliency Toolkit for production workloads',
      met: false,
      detail: (
        <span>
          For production or mission-critical workloads, implement the High or Maximum Resiliency model using the Resiliency Toolkit so traffic keeps flowing during maintenance events. The Development &amp; Test model fits non-production workloads from a cost-efficiency perspective. See {link('https://docs.aws.amazon.com/directconnect/latest/UserGuide/resiliency_toolkit.html', 'Resiliency Toolkit')} and {link('https://docs.aws.amazon.com/directconnect/latest/UserGuide/dx-maintenance.html', 'DX Maintenance')}.
        </span>
      ),
      severity: 'info',
      group: 'architecture',
    });
  }

  if (recommendations.some((r) => r.ruleId === 'consistent-prefix-advertisement')) {
    bestPracticeChecklist.push({
      label: 'Advertise the same prefixes across redundant VIFs',
      met: false,
      detail: 'Validate that the same BGP prefixes are learned and advertised across redundant Virtual Interfaces. Asymmetric advertisement leaves the failover path with different reachability and can cause traffic blackholes during a failover. BGP route state is not available via the AWS API — verify from your customer router.',
      severity: 'info',
      group: 'configuration',
    });
  }

  if (recommendations.some((r) => r.ruleId === 'vif-route-symmetry')) {
    bestPracticeChecklist.push({
      label: 'Summarize prefixes and keep VIF routing symmetric',
      met: false,
      detail: (
        <span>
          <strong>Route summarization</strong> — advertising individual /24s will exhaust the 100-prefix limit rapidly. Consolidate into aggregate prefixes. All VIFs attached to the same DXGW or VGW serving the same routing domain should advertise and receive identical prefix sets with consistent BGP attributes (local preference, AS_PATH length, etc.) unless traffic manipulation is required. BGP route state is not available via the AWS API — verify from your customer router.
        </span>
      ),
      severity: 'info',
      group: 'configuration',
    });
  }

  if (recommendations.some((r) => r.ruleId === 'lag-min-links')) {
    bestPracticeChecklist.push({
      label: 'Configure LAG min-links — a LAG is not a resiliency mechanism',
      met: false,
      detail: (
        <span>
          A LAG is a bandwidth aggregation mechanism, not a resiliency mechanism — all member connections terminate on the same AWS device at the same location. Configure the <strong>min-links</strong> parameter to define the minimum number of active members required for the LAG to remain operational. Without min-links, a severely degraded LAG continues forwarding traffic at reduced capacity rather than triggering failover to a redundant path. Set min-links to <strong>n/2 + 1</strong> (majority) to force clean failover before congestion occurs, or to <strong>1</strong> when external redundancy can absorb the full traffic load.
        </span>
      ),
      severity: 'info',
      group: 'configuration',
    });
  }

  {
    const bgpLimitRec = recommendations.find(
      (r) => r.ruleId === 'bgp-route-limit' || r.ruleId === 'bgp-route-limit-ok',
    );
    if (bgpLimitRec) {
      bestPracticeChecklist.push({
        label: bgpLimitRec.title,
        met: bgpLimitRec.ruleId === 'bgp-route-limit-ok',
        detail: bgpLimitRec.description,
        severity: bgpLimitRec.severity,
        group: 'configuration',
      });
    }
  }

  // VPN-related items
  if (recommendations.some((r) => r.ruleId === 'vpn-tunnel-redundancy')) {
    const recs = recommendations.filter((r) => r.ruleId === 'vpn-tunnel-redundancy');
    bestPracticeChecklist.push({
      label: 'Ensure both VPN tunnels are UP for redundancy',
      met: false,
      detail: recs.map((r) => r.description).join(' '),
      severity: 'warning',
      group: 'configuration',
    });
  }

  if (recommendations.some((r) => r.ruleId === 'cgw-redundancy')) {
    bestPracticeChecklist.push({
      label: 'Deploy multiple customer gateways for device redundancy',
      met: false,
      detail: 'All Site-to-Site VPN connections terminate on the same customer gateway. A single CGW (or DX partner device) is a single point of failure — deploy at least two so device failures do not take down the hybrid network.',
      severity: 'warning',
      group: 'architecture',
    });
  }

  {
    const dpdRec = recommendations.find((r) => r.ruleId === 'vpn-dpd');
    if (dpdRec) {
      bestPracticeChecklist.push({
        label: dpdRec.title,
        met: false,
        detail: dpdRec.description,
        severity: dpdRec.severity === 'warning' ? 'warning' : 'info',
        group: 'configuration',
      });
    }
  }

  if (recommendations.some((r) => r.ruleId === 'dx-partner-diversity')) {
    const recs = recommendations.filter((r) => r.ruleId === 'dx-partner-diversity');
    bestPracticeChecklist.push({
      label: 'Consider sourcing Direct Connect from multiple partners',
      met: false,
      detail: recs.map((r) => r.description).join(' '),
      severity: 'info',
      group: 'architecture',
    });
  }

  if (recommendations.some((r) => r.ruleId === 'dx-location-redundancy')) {
    bestPracticeChecklist.push({
      label: 'Choose DX location redundancy that matches your risk profile',
      met: false,
      detail: 'Metro diversity (DX locations in the same metro) gives fast, low-latency failover and protects against single-facility failures at lower cost. Geographic diversity (separate regions) protects against regional events — natural disasters, metro-wide fiber cuts, grid outages — at the cost of higher latency and circuit cost. Metro diversity is often sufficient; choose geographic diversity when business continuity demands resilience against catastrophic regional events.',
      severity: 'info',
      group: 'architecture',
    });
  }

  if (recommendations.some((r) => r.ruleId === 'bgp-timers-fallback')) {
    bestPracticeChecklist.push({
      label: 'Optimize BGP timers when BFD is not supported',
      met: false,
      detail: 'If the customer gateway or partner device does not support BFD, tune the BGP hold timer down to roughly 20–30 seconds to reduce failure detection time while keeping the session stable. The AWS default of 90 seconds delays failover significantly.',
      severity: 'info',
      group: 'configuration',
    });
  }

  if (recommendations.some((r) => r.ruleId === 'dx-failover-testing')) {
    bestPracticeChecklist.push({
      label: 'Conduct regular Direct Connect failover tests',
      met: false,
      detail: 'Exercise redundant paths on a schedule. AWS allows you to temporarily shut down BGP peers on your VIFs from the AWS side for up to 72 hours, which lets you simulate router maintenance and validate failover in advance. Partner-provided / hosted VIFs may be under partner monitoring — coordinate with your DX partner before running failover tests.',
      severity: 'info',
      group: 'operations',
    });
  }

  if (recommendations.some((r) => r.ruleId === 'failover-runbooks')) {
    bestPracticeChecklist.push({
      label: 'Maintain documented DX/VPN failover runbooks',
      met: false,
      detail: 'Create and maintain operational runbooks for Direct Connect and VPN failover procedures, including escalation paths, on-call rotations, and partner coordination steps. During an incident, a well-tested runbook turns failover from a multi-hour scramble into a repeatable procedure.',
      severity: 'info',
      group: 'operations',
    });
  }

  // Green-check confirmation: every location terminates on ≥ 2 AWS devices.
  // We only push the `met: true` row — the unmet case is already surfaced by
  // ruleSingleConnectionPerLocation in the resiliency section.
  if (allHaveMultiple) {
    bestPracticeChecklist.push({
      label: 'All Direct Connect connections terminate on different AWS devices',
      met: true,
      detail: 'Each Direct Connect location terminates on two or more distinct AWS logical devices, protecting against single-device failures.',
      group: 'architecture',
    });
  }

  // Float completed best practices to the bottom so open action items stay up top
  bestPracticeChecklist.sort((a, b) => Number(a.met) - Number(b.met));

  return { coverageChecklist, bestPracticeChecklist, tierProgression };
}

function TierProgressionStrip({
  progression,
  light,
  onSelectOption,
  activeOptionLevel,
  hideCurrentTier,
  neutralCurrentLabel,
  optionsHeading,
}: {
  progression: TierProgression;
  light: boolean;
  onSelectOption?: (level: ResiliencyTarget) => void;
  activeOptionLevel?: ResiliencyTarget | null;
  // When the parent card already shows the current tier pill (e.g. per-DXGW
  // headers), suppress the "SLA Tier — <level>" row here to avoid duplication.
  hideCurrentTier?: boolean;
  // Zero-DX accounts: show a gray informational pill with this label instead
  // of the red 'No Resiliency' failure pill (no SLA figure either).
  neutralCurrentLabel?: string;
  // Override the options heading (e.g. 'Getting started with Direct Connect').
  optionsHeading?: string;
}) {
  const { currentLevel, options } = progression;
  const currentColor = neutralCurrentLabel ? '#6b7280' : (tierColors[currentLevel] ?? '#6b7280');

  return (
    <div className={`rounded-lg border px-3.5 py-3 ${light ? 'bg-gray-50 border-gray-200' : 'bg-slate-700/40 border-slate-600/50'}`}>
      {!hideCurrentTier && (
        <div className="flex items-center justify-between gap-2 mb-2.5">
          <div className={`text-[10px] font-bold uppercase tracking-wider ${light ? 'text-gray-500' : 'text-slate-400'}`}>
            SLA Tier
          </div>
          <div className="flex items-center gap-2">
            <span
              className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full"
              style={{
                color: currentColor,
                backgroundColor: `${currentColor}1a`,
                border: `1px solid ${currentColor}40`,
              }}
            >
              <span
                className="w-1.5 h-1.5 rounded-full"
                style={{ backgroundColor: currentColor }}
                aria-hidden="true"
              />
              {neutralCurrentLabel ?? tierLabels[currentLevel]}
            </span>
            {!neutralCurrentLabel && tierSla[currentLevel] && (
              <span className={`text-[11px] font-semibold tabular-nums ${light ? 'text-gray-700' : 'text-slate-200'}`}>
                {tierSla[currentLevel]}
              </span>
            )}
          </div>
        </div>
      )}

      {options.length > 0 && (
        <>
          <div className={`text-[10px] font-semibold uppercase tracking-wider mb-2 ${light ? 'text-gray-500' : 'text-slate-400'}`}>
            {optionsHeading ?? (options.length > 1 ? 'Next Resiliency Level Options' : 'Next step')}
          </div>
          <div className={`grid gap-1.5 ${options.length > 1 ? 'grid-cols-2' : 'grid-cols-1'}`}>
            {options.map((opt) => {
              const optColor = tierColors[opt.level] ?? '#6b7280';
              const canSelect = onSelectOption && (opt.level === 'high' || opt.level === 'maximum');
              const isActive = canSelect && activeOptionLevel === opt.level;
              const baseCls = `relative flex items-stretch gap-3 rounded-md pl-3 pr-3 py-2 border overflow-hidden transition-colors w-full text-left`;
              const colorCls = isActive
                ? (light
                    ? 'bg-emerald-50 border-emerald-400 ring-1 ring-emerald-400'
                    : 'bg-emerald-500/10 border-emerald-400/60 ring-1 ring-emerald-400/60')
                : (light
                    ? 'bg-white border-gray-200 hover:border-emerald-400 hover:shadow-sm'
                    : 'bg-slate-800/60 border-slate-600/50 hover:border-emerald-500/60');
              const inner = (
                <>
                  <span
                    className="absolute left-0 top-0 bottom-0 w-1"
                    style={{ backgroundColor: optColor }}
                    aria-hidden="true"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2 mb-0.5">
                      <span
                        className="text-[10px] font-bold uppercase tracking-wider"
                        style={{ color: optColor }}
                      >
                        {tierLabels[opt.level]}
                      </span>
                      {tierSla[opt.level] && (
                        <span
                          className={`text-[11px] font-semibold tabular-nums ${light ? 'text-gray-700' : 'text-slate-200'}`}
                        >
                          {tierSla[opt.level]} SLA
                        </span>
                      )}
                    </div>
                    <p className={`text-xs leading-relaxed ${light ? 'text-gray-600' : 'text-slate-300'}`}>
                      {opt.step}
                    </p>
                  </div>
                </>
              );
              return canSelect ? (
                <button
                  key={opt.level}
                  type="button"
                  onClick={() => onSelectOption!(opt.level as ResiliencyTarget)}
                  aria-pressed={isActive}
                  className={`${baseCls} ${colorCls}`}
                >
                  {inner}
                </button>
              ) : (
                <div
                  key={opt.level}
                  className={`${baseCls} ${colorCls}`}
                >
                  {inner}
                </div>
              );
            })}
          </div>
        </>
      )}

      {options.length === 0 && currentLevel === 'maximum' && (
        <p className={`text-xs leading-relaxed ${light ? 'text-gray-600' : 'text-slate-300'}`}>
          You are at the highest SLA tier. Focus on operational best practices below.
        </p>
      )}
    </div>
  );
}

function ProtectionCoverage({ items, light, hideHeader = false }: { items: ChecklistItem[]; light: boolean; hideHeader?: boolean }) {
  return (
    <div>
      {!hideHeader && (
        <p className={`text-[11px] mb-2.5 leading-relaxed ${light ? 'text-gray-500' : 'text-slate-400'}`}>
          Independent checks — each protects against a different failure mode.
        </p>
      )}
      <div className="flex flex-col gap-2">
        {items.map((item, i) => {
          return (
            <div
              key={i}
              className={`px-3.5 py-3 rounded-lg border ${
                light ? 'bg-gray-50 border-gray-200' : 'bg-slate-700/40 border-slate-600/50'
              }`}
            >
              <div className="flex items-start gap-3">
                <span
                  className="shrink-0 mt-0.5 inline-flex items-center justify-center w-4 h-4 rounded-full"
                  style={
                    item.met
                      ? { backgroundColor: '#10b981', color: '#ffffff' }
                      : {
                          backgroundColor: 'transparent',
                          // Info rows are statements, not warnings — gray, not amber.
                          border: `1.5px solid ${item.severity === 'info' ? '#6b7280' : '#f59e0b'}`,
                        }
                  }
                  aria-hidden="true"
                >
                  {item.met && (
                    <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <p className={`text-sm font-medium leading-5 ${light ? 'text-gray-800' : 'text-slate-100'}`}>
                    {item.label}
                  </p>
                  {item.detail && (
                    <p className={`text-xs mt-1 leading-relaxed ${light ? 'text-gray-600' : 'text-slate-400'}`}>
                      {item.detail}
                    </p>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ChecklistItemRow({ item, light }: { item: ChecklistItem; light: boolean }) {
  const ringColor = item.severity ? severityColors[item.severity] : '#f59e0b';
  return (
    <div
      className={`px-3.5 py-3 rounded-lg border ${
        light ? 'bg-gray-50 border-gray-200' : 'bg-slate-700/40 border-slate-600/50'
      }`}
    >
      <div className="flex items-start gap-3">
        <span
          className="shrink-0 mt-0.5 inline-flex items-center justify-center w-4 h-4 rounded-full"
          style={
            item.met
              ? { backgroundColor: '#10b981', color: '#ffffff' }
              : {
                  backgroundColor: 'transparent',
                  border: `1.5px solid ${ringColor}`,
                }
          }
          aria-hidden="true"
        >
          {item.met && (
            <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className={`text-sm font-medium leading-5 ${light ? 'text-gray-800' : 'text-slate-100'}`}>
            {item.label}
          </p>
          {item.detail && (
            <p className={`text-xs mt-1 leading-relaxed ${light ? 'text-gray-600' : 'text-slate-400'}`}>
              {item.detail}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// Each category group renders as its own collapsible sub-section inside
// ChecklistSection.
function ChecklistGroupDrawer({
  title,
  tone,
  items,
  light,
  defaultOpen,
}: {
  title: string;
  tone: 'danger' | 'info' | 'success';
  items: ChecklistItem[];
  light: boolean;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (items.length === 0) return null;

  // Tone drives the accent dot color next to the group header so users can
  // see at a glance whether the group contains action items or guidance.
  const toneDot =
    tone === 'danger'
      ? COLORS.severity.critical
      : tone === 'success'
        ? '#10b981'
        : '#3b82f6';

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={`w-full flex items-center justify-between px-3 py-2 rounded-md border text-left transition-colors ${
          light
            ? 'bg-white border-gray-200 hover:bg-gray-50 text-gray-700'
            : 'bg-slate-800/40 border-slate-600/50 hover:bg-slate-800/70 text-slate-200'
        }`}
      >
        <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider">
          <span
            className="inline-block w-1.5 h-1.5 rounded-full"
            style={{ backgroundColor: toneDot }}
            aria-hidden="true"
          />
          {title}
          <span className={`text-[11px] font-mono font-semibold ${light ? 'text-gray-500' : 'text-slate-400'}`}>
            ({items.length})
          </span>
        </span>
        <svg
          className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-90' : ''} ${light ? 'text-gray-500' : 'text-slate-400'}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </button>
      {open && (
        <div className="flex flex-col gap-2 mt-2">
          {items.map((item, i) => (
            <ChecklistItemRow key={i} item={item} light={light} />
          ))}
        </div>
      )}
    </div>
  );
}

function ChecklistSection({ title, items, light }: { title: string; items: ChecklistItem[]; light: boolean }) {
  // Bucket items by their natural category. Both met and unmet items stay in
  // their assigned group — the checkmark/ring indicator communicates status.
  // Former "issues" items (connection-down, vif-down, tunnel-redundancy) fall
  // into Configuration since they reflect current resource state.
  const architecture: ChecklistItem[] = [];
  const configuration: ChecklistItem[] = [];
  const operations: ChecklistItem[] = [];

  for (const item of items) {
    const g = item.group ?? 'configuration';
    if (g === 'architecture') architecture.push(item);
    else if (g === 'operations') operations.push(item);
    else configuration.push(item);
  }

  // Within each drawer, surface higher-severity items first: critical → warning
  // → info → met. Array.prototype.sort is stable, so items with equal severity
  // keep their original source order.
  const severityRank = (item: ChecklistItem) =>
    item.met ? 3 : item.severity === 'critical' ? 0 : item.severity === 'warning' ? 1 : 2;
  const bySeverity = (a: ChecklistItem, b: ChecklistItem) =>
    severityRank(a) - severityRank(b);
  architecture.sort(bySeverity);
  configuration.sort(bySeverity);
  operations.sort(bySeverity);

  const hasAny = architecture.length + configuration.length + operations.length > 0;
  if (!hasAny) return null;

  return (
    <div>
      <div className={`text-xs font-bold uppercase tracking-wider mb-2.5 ${light ? 'text-gray-700' : 'text-slate-200'}`}>
        {title}
      </div>
      <div className="flex flex-col gap-2">
        <ChecklistGroupDrawer
          title="Architecture"
          tone="info"
          items={architecture}
          light={light}
          defaultOpen={true}
        />
        <ChecklistGroupDrawer
          title="Configuration"
          tone="info"
          items={configuration}
          light={light}
          defaultOpen={true}
        />
        <ChecklistGroupDrawer
          title="Operations"
          tone="info"
          items={operations}
          light={light}
          defaultOpen={false}
        />
      </div>
    </div>
  );
}


/**
 * Build a topology view containing only the connections/VIFs/locations that
 * feed a specific DX Gateway — matches the scoping done in recommendation-engine.
 */
function buildScopedTopology(topology: TopologyData, dxGatewayId: string): TopologyData {
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

/**
 * Build a topology view containing only the DX path feeding a specific VGW —
 * mirrors buildVgwScope in recommendation-engine so the coverage checklist and
 * tier progression are computed on the same scope the ghost rules ran on.
 */
function buildVgwScopedTopology(topology: TopologyData, vgwId: string): TopologyData {
  const scopedVifs = topology.virtualInterfaces.filter(
    (v) => v.virtualGatewayId === vgwId && !v.directConnectGatewayId,
  );
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

function PublicVifSection({
  pubVif,
  topology,
  light,
  inFullscreen,
}: {
  pubVif: PublicVifAssessment;
  topology: TopologyData;
  light: boolean;
  inFullscreen: boolean;
}) {
  const [open, setOpen] = useState(true);
  const setViewMode = useTopologyStore((s) => s.setViewMode);
  const setFocusedDxGatewayId = useTopologyStore((s) => s.setFocusedDxGatewayId);
  const focusedDxGatewayId = useTopologyStore((s) => s.focusedDxGatewayId);
  const viewMode = useTopologyStore((s) => s.viewMode);
  const setSpotlightNode = useTopologyStore((s) => s.setSpotlightNode);
  const hoveredNodeId = useTopologyStore((s) => s.hoveredNodeId);
  const setResiliencyTarget = useTopologyStore((s) => s.setResiliencyTarget);
  const currentTarget = useTopologyStore((s) => s.resiliencyTargets[FOCUSED_PUBLIC_VIF]);

  const isFocused = focusedDxGatewayId === FOCUSED_PUBLIC_VIF && viewMode === 'recommended';
  // Highlight the active option whenever this row's ghosts are actually drawn on
  // the canvas — i.e. in Recommended view when this row is focused OR nothing is
  // focused (view-all renders every row's recommendation). A different row being
  // focused hides this row's ghosts, so it must not highlight.
  const isRenderedOnCanvas =
    viewMode === 'recommended' &&
    (focusedDxGatewayId === FOCUSED_PUBLIC_VIF || focusedDxGatewayId === null);
  const activeOptionLevel: ResiliencyTarget | null = isRenderedOnCanvas
    ? (currentTarget ?? (pubVif.targetLevel === 'maximum' ? 'maximum' : 'high'))
    : null;

  const handleSelectOption = (level: ResiliencyTarget) => {
    if (isFocused && activeOptionLevel === level) {
      // Deselecting the active tier clears this row's focus but stays in
      // Recommendation mode — it drops back to the "view all recommendations"
      // state rather than exiting the canvas to Current State.
      setFocusedDxGatewayId(null);
      return;
    }
    setResiliencyTarget(FOCUSED_PUBLIC_VIF, level);
    setFocusedDxGatewayId(FOCUSED_PUBLIC_VIF);
    setViewMode('recommended');
  };

  const scopedTopology = buildPublicVifScope(topology)!;
  const publicVifs = scopedTopology.virtualInterfaces;

  const { coverageChecklist, tierProgression } = buildChecklist(scopedTopology, pubVif.recommendations, light);
  const levelColor = tierColors[pubVif.currentLevel] ?? '#6b7280';

  const spotlightId = 'pub-endpoints';
  const isReverseHighlighted = hoveredNodeId === spotlightId;

  return (
    <div
      className={`${inFullscreen ? 'px-5 pt-4 pb-4' : 'px-4 pt-3 pb-3'} border-t transition-colors ${light ? 'border-gray-200' : 'border-slate-700'} ${isReverseHighlighted ? (light ? 'bg-violet-100/60' : 'bg-violet-500/10') : ''}`}
      style={isReverseHighlighted ? { boxShadow: 'inset 3px 0 0 0 #8b5cf6' } : undefined}
      onMouseEnter={() => setSpotlightNode(spotlightId)}
      onMouseLeave={() => setSpotlightNode(null)}
    >
      <div className="flex items-center justify-between gap-2 mb-2.5">
        <div
          role="button"
          tabIndex={0}
          onClick={() => setOpen((v) => !v)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setOpen((v) => !v);
            }
          }}
          aria-expanded={open}
          aria-label={`${open ? 'Collapse' : 'Expand'} Public VIF Resiliency details`}
          className="min-w-0 flex-1 text-left cursor-pointer"
        >
          <div className={`text-sm font-bold truncate select-text ${light ? 'text-gray-800' : 'text-slate-100'}`}>
            AWS Public Endpoints
          </div>
          <div className={`text-[10px] font-mono truncate select-text ${light ? 'text-gray-500' : 'text-slate-400'}`}>
            {publicVifs.length} public VIF{publicVifs.length !== 1 ? 's' : ''}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span
            className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full"
            style={{
              color: levelColor,
              backgroundColor: `${levelColor}1a`,
              border: `1px solid ${levelColor}40`,
            }}
            title={tierLabels[pubVif.currentLevel]}
          >
            <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: levelColor }} aria-hidden="true" />
            {tierShortLabels[pubVif.currentLevel]}
          </span>
          {tierSla[pubVif.currentLevel] && (
            <span className={`text-[11px] font-semibold tabular-nums ${light ? 'text-gray-700' : 'text-slate-200'}`}>
              {tierSla[pubVif.currentLevel]}
            </span>
          )}
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={`${open ? 'Collapse' : 'Expand'} Public VIF Resiliency details`}
            className="p-0.5 rounded hover:bg-black/5 dark:hover:bg-white/5"
          >
            <svg
              className={`w-3.5 h-3.5 ${light ? 'text-gray-500' : 'text-slate-400'}`}
              fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true"
            >
              <path strokeLinecap="round" d="M6 12h12" />
              {!open && <path strokeLinecap="round" d="M12 6v12" />}
            </svg>
          </button>
        </div>
      </div>

      {open && (
        <>
          {tierProgression && viewMode === 'recommended' && (
            <div className="mb-3">
              <TierProgressionStrip
                progression={tierProgression}
                light={light}
                onSelectOption={handleSelectOption}
                activeOptionLevel={activeOptionLevel}
                hideCurrentTier
              />
            </div>
          )}

          {viewMode === 'current' && (
            <div className="mb-3">
              <ProtectionCoverage items={coverageChecklist} light={light} hideHeader />
            </div>
          )}
        </>
      )}
    </div>
  );
}

function DxGatewaySection({
  gateway,
  topology,
  light,
  inFullscreen,
  showHeader,
  collapsible,
  defaultOpen,
}: {
  gateway: DxGatewayAssessment;
  topology: TopologyData;
  light: boolean;
  inFullscreen: boolean;
  showHeader: boolean;
  collapsible: boolean;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const scopedTopology = buildScopedTopology(topology, gateway.dxGatewayId);
  const { coverageChecklist, tierProgression } = buildChecklist(
    scopedTopology,
    gateway.recommendations,
    light,
  );
  const levelColor = tierColors[gateway.currentLevel] ?? '#6b7280';
  const isOpen = collapsible ? open : true;

  // Clicking an upgrade-option card sets this DXGW's target, flips the canvas
  // to Recommended, and focuses the view so only this gateway's ghosts render.
  // Clicking the already-active option with this gateway focused toggles
  // the focus off so users can get back to the full current-state view.
  const setResiliencyTarget = useTopologyStore((s) => s.setResiliencyTarget);
  const setViewMode = useTopologyStore((s) => s.setViewMode);
  const setFocusedDxGatewayId = useTopologyStore((s) => s.setFocusedDxGatewayId);
  const focusedDxGatewayId = useTopologyStore((s) => s.focusedDxGatewayId);
  const viewMode = useTopologyStore((s) => s.viewMode);
  const currentTarget = useTopologyStore((s) => s.resiliencyTargets[gateway.dxGatewayId]);
  const setSpotlightNode = useTopologyStore((s) => s.setSpotlightNode);
  const hoveredNodeId = useTopologyStore((s) => s.hoveredNodeId);
  const isFocused = focusedDxGatewayId === gateway.dxGatewayId && viewMode === 'recommended';
  // Highlight the active option whenever this row's ghosts are actually drawn on
  // the canvas — i.e. in Recommended view when this row is focused OR nothing is
  // focused (view-all renders every row's recommendation). A different row being
  // focused hides this row's ghosts, so it must not highlight.
  const isRenderedOnCanvas =
    viewMode === 'recommended' &&
    (focusedDxGatewayId === gateway.dxGatewayId || focusedDxGatewayId === null);
  const activeOptionLevel: ResiliencyTarget | null = isRenderedOnCanvas
    ? (currentTarget ?? (gateway.targetLevel === 'maximum' ? 'maximum' : 'high'))
    : null;
  const handleSelectOption = (level: ResiliencyTarget) => {
    if (isFocused && activeOptionLevel === level) {
      // Deselecting the active tier clears this row's focus but stays in
      // Recommendation mode — it drops back to the "view all recommendations"
      // state rather than exiting the canvas to Current State.
      setFocusedDxGatewayId(null);
      return;
    }
    setResiliencyTarget(gateway.dxGatewayId, level);
    setFocusedDxGatewayId(gateway.dxGatewayId);
    setViewMode('recommended');
  };

  // Suppress the collapse toggle when the click ends a text selection —
  // otherwise drag-selecting the DXGW name/ID to copy would collapse the row.
  const toggleOpenIfNotSelecting = () => {
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.toString().length > 0) return;
    setOpen((v) => !v);
  };

  // Split the collapsible affordance into its own element so header siblings
  // (badges, tier pill, chevron) don't end up nested inside the toggle —
  // nested interactive elements are invalid HTML and trigger React warnings.
  // Using role="button" on a <div> (instead of a real <button>) keeps the
  // label text selectable so users can copy the DXGW name and ID.
  const headerRow = (
    <div className="flex items-center justify-between gap-2 mb-2.5">
      {collapsible ? (
        <div
          role="button"
          tabIndex={0}
          onClick={toggleOpenIfNotSelecting}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setOpen((v) => !v);
            }
          }}
          aria-expanded={isOpen}
          aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${gateway.dxGatewayName} details`}
          className="min-w-0 flex-1 text-left cursor-pointer"
        >
          <div className={`text-sm font-bold truncate select-text ${light ? 'text-gray-800' : 'text-slate-100'}`}>
            {gateway.dxGatewayName}
          </div>
          <div className={`text-[10px] font-mono truncate select-text ${light ? 'text-gray-500' : 'text-slate-400'}`}>
            {gateway.dxGatewayId}
          </div>
        </div>
      ) : (
        <div className="min-w-0 flex-1">
          <div className={`text-sm font-bold truncate select-text ${light ? 'text-gray-800' : 'text-slate-100'}`}>
            {gateway.dxGatewayName}
          </div>
          <div className={`text-[10px] font-mono truncate select-text ${light ? 'text-gray-500' : 'text-slate-400'}`}>
            {gateway.dxGatewayId}
          </div>
        </div>
      )}
      <div className="flex items-center gap-2 shrink-0">
        {gateway.isUnattached ? (
          <span
            className={`inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${
              light
                ? 'text-amber-700 bg-amber-100 border border-amber-300'
                : 'text-amber-300 bg-amber-500/15 border border-amber-400/40'
            }`}
            title="No VIFs or associations — SLA tier does not apply"
          >
            Unattached
          </span>
        ) : (
          <>
            <span
              className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full"
              style={{
                color: levelColor,
                backgroundColor: `${levelColor}1a`,
                border: `1px solid ${levelColor}40`,
              }}
              title={tierLabels[gateway.currentLevel]}
            >
              <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: levelColor }} aria-hidden="true" />
              {tierShortLabels[gateway.currentLevel]}
            </span>
            {tierSla[gateway.currentLevel] && (
              <span className={`text-[11px] font-semibold tabular-nums ${light ? 'text-gray-700' : 'text-slate-200'}`}>
                {tierSla[gateway.currentLevel]}
              </span>
            )}
          </>
        )}
        {collapsible && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={isOpen}
            aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${gateway.dxGatewayName} details`}
            className="p-0.5 rounded hover:bg-black/5 dark:hover:bg-white/5"
          >
            <svg
              className={`w-3.5 h-3.5 ${light ? 'text-gray-500' : 'text-slate-400'}`}
              fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true"
            >
              <path strokeLinecap="round" d="M6 12h12" />
              {!isOpen && <path strokeLinecap="round" d="M12 6v12" />}
            </svg>
          </button>
        )}
      </div>
    </div>
  );

  // Hovering the row wraps the matching DXGW node in a rotating rainbow ring
  // so users can see exactly which node in the diagram maps to this list entry.
  // Node IDs in the graph follow `dxgw-${directConnectGatewayId}` (see topology-builder).
  const spotlightId = `dxgw-${gateway.dxGatewayId}`;
  // Mirror direction: when the matching DXGW in the diagram is hovered, highlight this row.
  const isReverseHighlighted = hoveredNodeId === spotlightId;
  return (
    <div
      className={`${inFullscreen ? 'px-5 pt-4 pb-4' : 'px-4 pt-3 pb-3'} border-t transition-colors ${light ? 'border-gray-200' : 'border-slate-700'} ${isReverseHighlighted ? (light ? 'bg-violet-100/60' : 'bg-violet-500/10') : ''}`}
      style={isReverseHighlighted ? { boxShadow: 'inset 3px 0 0 0 #8b5cf6' } : undefined}
      onMouseEnter={() => setSpotlightNode(spotlightId)}
      onMouseLeave={() => setSpotlightNode(null)}
    >
      {showHeader && headerRow}

      {isOpen && (
        <>
          {tierProgression && viewMode === 'recommended' && !gateway.isUnattached && (
            <div className="mb-3">
              <TierProgressionStrip
                progression={tierProgression}
                light={light}
                onSelectOption={handleSelectOption}
                activeOptionLevel={activeOptionLevel}
                hideCurrentTier={showHeader}
              />
            </div>
          )}

          {viewMode === 'current' && !gateway.isUnattached && (
            <div className="mb-3">
              <ProtectionCoverage items={coverageChecklist} light={light} hideHeader={showHeader} />
            </div>
          )}

          {gateway.isUnattached && (
            <div
              className={`rounded-lg border px-3.5 py-2.5 text-xs leading-relaxed ${
                light
                  ? 'bg-amber-50 border-amber-200 text-amber-800'
                  : 'bg-amber-500/10 border-amber-400/30 text-amber-200'
              }`}
            >
              {!gateway.hasVif && !gateway.hasAssociation
                ? 'Missing both Virtual Interfaces and gateway associations (TGW/VGW).'
                : !gateway.hasVif
                  ? 'Missing Virtual Interfaces — no DX connection path to this gateway.'
                  : 'Missing gateway associations (TGW/VGW) — no destination network attached.'}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Per-VGW resilience card — the VGW analog of DxGatewaySection. A VGW reached
 * over Direct Connect shares the DXGW's site/device redundancy posture, so this
 * card reuses the same tier progression + coverage checklist, scoped to the
 * VGW's DX path. Focus id is the raw VGW id; the canvas node is `vgw-<id>`.
 */
function VgwSection({
  vgw,
  topology,
  light,
  inFullscreen,
}: {
  vgw: VgwAssessment;
  topology: TopologyData;
  light: boolean;
  inFullscreen: boolean;
}) {
  const [open, setOpen] = useState(true);
  const scopedTopology = buildVgwScopedTopology(topology, vgw.vgwId);
  const { coverageChecklist, tierProgression } = buildChecklist(
    scopedTopology,
    vgw.recommendations,
    light,
  );
  const levelColor = tierColors[vgw.currentLevel] ?? '#6b7280';

  const setResiliencyTarget = useTopologyStore((s) => s.setResiliencyTarget);
  const setViewMode = useTopologyStore((s) => s.setViewMode);
  const setFocusedDxGatewayId = useTopologyStore((s) => s.setFocusedDxGatewayId);
  const focusedDxGatewayId = useTopologyStore((s) => s.focusedDxGatewayId);
  const viewMode = useTopologyStore((s) => s.viewMode);
  const currentTarget = useTopologyStore((s) => s.resiliencyTargets[vgw.vgwId]);
  const setSpotlightNode = useTopologyStore((s) => s.setSpotlightNode);
  const hoveredNodeId = useTopologyStore((s) => s.hoveredNodeId);

  const isFocused = focusedDxGatewayId === vgw.vgwId && viewMode === 'recommended';
  const isRenderedOnCanvas =
    viewMode === 'recommended' &&
    (focusedDxGatewayId === vgw.vgwId || focusedDxGatewayId === null);
  const activeOptionLevel: ResiliencyTarget | null = isRenderedOnCanvas
    ? (currentTarget ?? (vgw.targetLevel === 'maximum' ? 'maximum' : 'high'))
    : null;
  const handleSelectOption = (level: ResiliencyTarget) => {
    if (isFocused && activeOptionLevel === level) {
      setFocusedDxGatewayId(null);
      return;
    }
    setResiliencyTarget(vgw.vgwId, level);
    setFocusedDxGatewayId(vgw.vgwId);
    setViewMode('recommended');
  };

  const toggleOpenIfNotSelecting = () => {
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.toString().length > 0) return;
    setOpen((v) => !v);
  };

  // Canvas node id follows `vgw-${vpnGatewayId}` (see topology-builder).
  const spotlightId = `vgw-${vgw.vgwId}`;
  const isReverseHighlighted = hoveredNodeId === spotlightId;

  return (
    <div
      className={`${inFullscreen ? 'px-5 pt-4 pb-4' : 'px-4 pt-3 pb-3'} border-t transition-colors ${light ? 'border-gray-200' : 'border-slate-700'} ${isReverseHighlighted ? (light ? 'bg-violet-100/60' : 'bg-violet-500/10') : ''}`}
      style={isReverseHighlighted ? { boxShadow: 'inset 3px 0 0 0 #8b5cf6' } : undefined}
      onMouseEnter={() => setSpotlightNode(spotlightId)}
      onMouseLeave={() => setSpotlightNode(null)}
    >
      <div className="flex items-center justify-between gap-2 mb-2.5">
        <div
          role="button"
          tabIndex={0}
          onClick={toggleOpenIfNotSelecting}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setOpen((v) => !v);
            }
          }}
          aria-expanded={open}
          aria-label={`${open ? 'Collapse' : 'Expand'} ${vgw.vgwName} details`}
          className="min-w-0 flex-1 text-left cursor-pointer"
        >
          <div className={`text-sm font-bold truncate select-text ${light ? 'text-gray-800' : 'text-slate-100'}`}>
            {vgw.vgwName}
          </div>
          <div className={`text-[10px] font-mono truncate select-text ${light ? 'text-gray-500' : 'text-slate-400'}`}>
            {vgw.vgwId}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span
            className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full"
            style={{
              color: levelColor,
              backgroundColor: `${levelColor}1a`,
              border: `1px solid ${levelColor}40`,
            }}
            title={tierLabels[vgw.currentLevel]}
          >
            <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: levelColor }} aria-hidden="true" />
            {tierShortLabels[vgw.currentLevel]}
          </span>
          {tierSla[vgw.currentLevel] && (
            <span className={`text-[11px] font-semibold tabular-nums ${light ? 'text-gray-700' : 'text-slate-200'}`}>
              {tierSla[vgw.currentLevel]}
            </span>
          )}
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={`${open ? 'Collapse' : 'Expand'} ${vgw.vgwName} details`}
            className="p-0.5 rounded hover:bg-black/5 dark:hover:bg-white/5"
          >
            <svg
              className={`w-3.5 h-3.5 ${light ? 'text-gray-500' : 'text-slate-400'}`}
              fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true"
            >
              <path strokeLinecap="round" d="M6 12h12" />
              {!open && <path strokeLinecap="round" d="M12 6v12" />}
            </svg>
          </button>
        </div>
      </div>

      {open && (
        <>
          {tierProgression && viewMode === 'recommended' && (
            <div className="mb-3">
              <TierProgressionStrip
                progression={tierProgression}
                light={light}
                onSelectOption={handleSelectOption}
                activeOptionLevel={activeOptionLevel}
                hideCurrentTier
              />
            </div>
          )}

          {viewMode === 'current' && (
            <div className="mb-3">
              <ProtectionCoverage items={coverageChecklist} light={light} hideHeader />
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function ResiliencyScoreCard() {
  const assessment = useTopologyStore((s) => s.assessment);
  const light = useIsLight();
  const topology = useTopologyStore((s) => s.topologyData);
  const currentNodes = useTopologyStore((s) => s.currentNodes);
  const recommendedCurrentNodes = useTopologyStore((s) => s.recommendedCurrentNodes);
  const viewMode = useTopologyStore((s) => s.viewMode);
  const setViewMode = useTopologyStore((s) => s.setViewMode);
  const [expanded, setExpanded] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const fullscreenTrapRef = useFocusTrap(fullscreen, () => setFullscreen(false));
  const exportReport = useExportReport();
  if (!assessment) return null;

  // Match the panel's DXGW order to the diagram's top-to-bottom order so users
  // can map list entries to nodes by eye. DXGW node IDs follow `dxgw-<id>`
  // (see topology-builder). Gateways not found in the graph fall back to
  // the engine's original order by ranking them last. Recommended view
  // repositions DXGWs, so read Y from whichever node set FlowCanvas renders.
  const renderedNodes = viewMode === 'recommended' && recommendedCurrentNodes.length > 0
    ? recommendedCurrentNodes
    : currentNodes;
  const dxgwYPosition = new Map<string, number>();
  for (const n of renderedNodes) {
    if (n.data.category === 'dxGateway') dxgwYPosition.set(n.id, n.position.y);
  }
  const orderedDxGateways = [...assessment.perDxGateway].sort((a, b) => {
    const ay = dxgwYPosition.get(`dxgw-${a.dxGatewayId}`) ?? Number.POSITIVE_INFINITY;
    const by = dxgwYPosition.get(`dxgw-${b.dxGatewayId}`) ?? Number.POSITIVE_INFINITY;
    return ay - by;
  });

  const handleExportReport = (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      exportReport();
    } catch (err) {
      console.error('Report export failed:', err);
    }
  };

  const globalRecs = [
    ...assessment.global.resiliency.recommendations,
    ...assessment.global.bestPractice.recommendations,
  ];
  const globalChecklist = buildChecklist(topology, globalRecs, light, { dxNotInUse: assessment.dxNotInUse });

  // Combine best-practice items surfaced per-DXGW (e.g. vif-down, connection-not-available)
  // with topology-wide best practices into a single merged checklist so the UI shows
  // all best-practice findings under one section. Items are deduplicated by label and
  // distinct details are merged so findings specific to individual DXGWs are preserved.
  const combinedBestPracticeChecklist: ChecklistItem[] = (() => {
    const merged = new Map<string, ChecklistItem>();
    // Key a detail by its string projection so identical copies from multiple
    // DXGWs (e.g. attestation boilerplate for Enterprise Support) collapse to one.
    // JSX is fine here since React.ReactNode renders predictably via String().
    const detailKey = (d: React.ReactNode): string => {
      if (d == null) return '';
      if (typeof d === 'string' || typeof d === 'number') return String(d);
      try {
        return JSON.stringify(d);
      } catch {
        return String(d);
      }
    };
    const seenDetails = new Map<string, Set<string>>();
    const addItem = (item: ChecklistItem) => {
      const existing = merged.get(item.label);
      if (!existing) {
        merged.set(item.label, { ...item });
        const set = new Set<string>();
        if (item.detail != null) set.add(detailKey(item.detail));
        seenDetails.set(item.label, set);
        return;
      }
      const met = existing.met && item.met;
      const seen = seenDetails.get(item.label)!;
      const incomingKey = item.detail == null ? '' : detailKey(item.detail);
      const alreadyHave = incomingKey === '' || seen.has(incomingKey);
      if (!alreadyHave && item.detail != null) seen.add(incomingKey);
      // Build the new detail only from unique pieces so we don't repeat the
      // same sentence for every DXGW that emits the same rec.
      const uniqueDetails: React.ReactNode[] = [];
      if (existing.detail != null) uniqueDetails.push(existing.detail);
      if (!alreadyHave && item.detail != null) uniqueDetails.push(item.detail);
      merged.set(item.label, {
        ...existing,
        met,
        severity: met ? undefined : (existing.severity ?? item.severity),
        detail: uniqueDetails.length > 1
          ? (<>{uniqueDetails.map((d, i) => <span key={i}>{i > 0 ? ' ' : ''}{d}</span>)}</>)
          : (uniqueDetails[0] ?? existing.detail),
      });
    };

    if (topology) {
      for (const g of orderedDxGateways) {
        const scoped = buildScopedTopology(topology, g.dxGatewayId);
        const { bestPracticeChecklist } = buildChecklist(scoped, g.recommendations, light);
        for (const item of bestPracticeChecklist) addItem(item);
      }
    }
    for (const item of globalChecklist.bestPracticeChecklist) addItem(item);

    const out = [...merged.values()];
    out.sort((a, b) => Number(a.met) - Number(b.met));
    return out;
  })();

  // Bottom-bar pill count — sum of unmet coverage items across every DXGW
  // (or the fallback global coverage) plus unmet items in the merged best-practice list.
  // Best Practices only render in Recommended view, so exclude them from the pill
  // in Current State to keep the count aligned with what's visible.
  const unmetCount = (() => {
    let count = 0;
    if (topology && orderedDxGateways.length > 0) {
      for (const g of orderedDxGateways) {
        const scoped = buildScopedTopology(topology, g.dxGatewayId);
        const { coverageChecklist } = buildChecklist(scoped, g.recommendations, light);
        count += coverageChecklist.filter((i) => !i.met && i.severity !== 'info').length;
      }
    } else {
      count += globalChecklist.coverageChecklist.filter((i) => !i.met && i.severity !== 'info').length;
    }
    if (viewMode === 'recommended') {
      count += combinedBestPracticeChecklist.filter((i) => !i.met && i.severity !== 'info').length;
    }
    return count;
  })();

  const hasPerDxgw = orderedDxGateways.length > 0 && !!topology;

  const content = (inFullscreen: boolean) => (
    <>
      {/* Per-DX Gateway cards — each gateway gets its own independent assessment.
          Every DXGW renders as its own named, collapsible section that starts open
          (like the Public Endpoints and LAG rows) so it reads as a peer row in the
          Resilience Status list — this holds even for a single-DXGW topology so the
          gateway always carries its own header instead of a bare SLA-tier strip. */}
      {hasPerDxgw ? (
        <section aria-label="Direct Connect Gateways">
          {orderedDxGateways.map((gw) => (
            <DxGatewaySection
              key={gw.dxGatewayId}
              gateway={gw}
              topology={topology!}
              light={light}
              inFullscreen={inFullscreen}
              showHeader
              collapsible
              defaultOpen
            />
          ))}
        </section>
      ) : (
        // Fallback for topologies with no DX Gateways — render the legacy single-card view
        <>
          {globalChecklist.tierProgression && (
            <div className={`${inFullscreen ? 'px-5 pt-4 pb-2' : 'px-4 pt-3 pb-2'}`}>
              <TierProgressionStrip
                progression={globalChecklist.tierProgression}
                light={light}
                neutralCurrentLabel={assessment.dxNotInUse ? 'Direct Connect not in use' : undefined}
                optionsHeading={assessment.dxNotInUse ? 'Getting started with Direct Connect' : undefined}
              />
            </div>
          )}
          <div className={`${inFullscreen ? 'px-5 pt-3 pb-3' : 'px-4 pt-3 pb-2'}`}>
            <ProtectionCoverage items={globalChecklist.coverageChecklist} light={light} />
          </div>
        </>
      )}

      {/* Per-VGW cards — VGWs reached over Direct Connect share the DXGW's
          site/device redundancy posture, so they render as peer gateway rows. */}
      {topology && assessment.perVgw.length > 0 && (
        <section aria-label="Virtual Private Gateways">
          {assessment.perVgw.map((vgw) => (
            <VgwSection
              key={vgw.vgwId}
              vgw={vgw}
              topology={topology}
              light={light}
              inFullscreen={inFullscreen}
            />
          ))}
        </section>
      )}

      {/* Public VIF section — rendered when standalone public VIFs exist */}
      {assessment.publicVif && topology && (
        <PublicVifSection
          pubVif={assessment.publicVif}
          topology={topology}
          light={light}
          inFullscreen={inFullscreen}
        />
      )}

      {/* Best Practices — combines per-DXGW findings (e.g. VIF/connection status)
          with topology-wide best practices into a single consolidated list.
          A thicker top border + tinted background visually detaches this group
          from the DX Gateways list above so the two sections scan as peers.
          Only shown in Recommended view — Current State keeps the panel focused
          on coverage checks for the existing topology. */}
      {viewMode === 'recommended' && combinedBestPracticeChecklist.length > 0 && (
        <div className={`${inFullscreen ? 'px-5 pt-4 pb-5' : 'px-4 pt-4 pb-4'} border-t-2 ${
          light ? 'border-gray-300 bg-gray-50/60' : 'border-slate-600 bg-slate-900/30'
        }`}>
          <ChecklistSection title="Best Practices" items={combinedBestPracticeChecklist} light={light} />
        </div>
      )}
    </>
  );

  return (
    <>
      {/* Fullscreen modal */}
      {fullscreen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          {/* The dim layer is a sibling of the panel rather than its ancestor,
              so it can own click-to-dismiss directly and the panel needs no
              stopPropagation. Deliberately not focusable — the focus trap
              already closes the dialog on Escape. */}
          {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
          <div
            className={`absolute inset-0 ${light ? 'bg-black/30' : 'bg-black/60'}`}
            onClick={() => setFullscreen(false)}
          />
          <div
            ref={fullscreenTrapRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="resiliency-modal-title"
            className={`relative w-[90vw] max-w-2xl max-h-[85vh] rounded-xl border shadow-2xl flex flex-col ${
              light ? 'bg-gray-100 border-gray-300' : 'bg-slate-800 border-slate-600'
            }`}
          >
            {/* Modal header */}
            <div className={`flex items-center justify-between px-5 py-4 border-b shrink-0 ${light ? 'border-gray-200' : 'border-slate-600'}`}>
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2">
                  <span id="resiliency-modal-title" className={`text-xl font-bold ${light ? 'text-gray-800' : 'text-slate-100'}`}>
                    Resilience Status
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button
                  className={`flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-md transition-colors ${
                    light
                      ? 'text-gray-600 hover:text-gray-800 hover:bg-gray-200'
                      : 'text-slate-300 hover:text-slate-100 hover:bg-slate-700'
                  }`}
                  onClick={handleExportReport}
                  title="Download HTML resilience report"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                  </svg>
                  Download Report
                </button>
                <button
                  className={`p-1.5 rounded-md transition-colors ${light ? 'hover:bg-gray-100 text-gray-500' : 'hover:bg-slate-700 text-slate-400'}`}
                  onClick={() => setFullscreen(false)}
                  aria-label="Close resiliency details"
                >
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>

            {/* Modal body */}
            <div className="flex-1 overflow-y-auto">
              {content(true)}
            </div>
          </div>
        </div>
      )}

      {/* Bottom-left card */}
      <div data-tour="scorecard" className={`absolute bottom-4 left-4 flex flex-col backdrop-blur border rounded-xl shadow-xl z-10 transition-all duration-200 ${
        light
          ? 'bg-gray-100/95 border-gray-300'
          : 'bg-slate-800/95 border-slate-600'
      }`} style={{ maxWidth: expanded ? 440 : undefined, maxHeight: expanded ? '70vh' : undefined }}>
        {/* Collapsed bar — clicking toggles the expanded panel */}
        <button
          className="shrink-0 w-full flex items-center gap-3 px-4 py-2.5 cursor-pointer select-none text-left focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:ring-offset-2 rounded-xl"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          aria-label={`Resilience Status: ${unmetCount}. ${expanded ? 'Collapse' : 'Expand'} details`}
        >
          <div className="flex items-center gap-2">
            <span className={`text-sm font-bold ${light ? 'text-gray-700' : 'text-slate-200'}`}>
              Resilience Status
            </span>
            {unmetCount > 0 && (
              <span className={`inline-flex items-center justify-center min-w-[18px] h-[18px] px-1.5 rounded-full text-[10px] font-bold leading-none ${
                light ? 'bg-amber-100 text-amber-700' : 'bg-amber-500/20 text-amber-400'
              }`}>
                {unmetCount}
              </span>
            )}
          </div>

          <svg
            className={`w-3.5 h-3.5 transition-transform duration-200 ${expanded ? 'rotate-180' : ''} ${light ? 'text-gray-500' : 'text-slate-400'}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2.5}
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
          </svg>
        </button>

        {/* Expanded content */}
        {expanded && (
          <div className={`flex flex-col min-h-0 border-t ${light ? 'border-gray-200' : 'border-slate-600'}`}>
            {/* Actions row — primary View Recommendation CTA stretches to fill the row;
                Download and Fullscreen collapse into icon-only buttons with tooltips. */}
            <div className="shrink-0 flex items-center gap-1.5 px-3 pt-2.5 pb-2.5">
              <button
                className={`flex-1 flex items-center justify-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-md transition-all ${
                  viewMode === 'recommended'
                    ? 'bg-emerald-600 text-white shadow-sm hover:bg-emerald-700'
                    : light
                      ? 'bg-emerald-600 text-white shadow-sm hover:bg-emerald-700'
                      : 'bg-emerald-500 text-white shadow-sm hover:bg-emerald-400'
                }`}
                onClick={(e) => {
                  e.stopPropagation();
                  setViewMode(viewMode === 'recommended' ? 'current' : 'recommended');
                }}
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4" />
                </svg>
                {viewMode === 'recommended' ? 'Exit Recommendation' : 'View Recommendation'}
              </button>
              <div className={`w-px self-stretch my-0.5 ${light ? 'bg-gray-200' : 'bg-slate-600'}`} aria-hidden="true" />
              <button
                className={`shrink-0 p-1.5 rounded-md transition-colors ${
                  light
                    ? 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-700'
                }`}
                onClick={handleExportReport}
                title="Download HTML resilience report"
                aria-label="Download HTML resilience report"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                </svg>
              </button>
              <button
                className={`shrink-0 p-1.5 rounded-md transition-colors ${
                  light
                    ? 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-700'
                }`}
                onClick={(e) => {
                  e.stopPropagation();
                  setFullscreen(true);
                }}
                title="Expand to fullscreen"
                aria-label="Expand to fullscreen"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5v-4m0 4h-4m4 0l-5-5" />
                </svg>
              </button>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto">
              {content(false)}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
