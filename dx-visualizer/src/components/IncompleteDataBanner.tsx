import { useState } from 'react';
import { useTopologyStore } from '../store/topology-store';
import { useIsLight } from '../hooks/useTheme';
import { COLORS } from '../utils/colors';
import type { TopologyData } from '../types/topology';
import { summariseIssues, guidanceFor, deniedAction } from '../utils/fetch-issues';
import type { FetchIssue } from '../types/topology';

/**
 * One display row per distinct cause.
 *
 * AWS errors carry the full caller ARN and policy ARN, and a missing permission
 * repeats the same sentence for every account × region × resource — 20+ rows of
 * near-identical ~300-char text that buried the canvas. Issues are grouped by
 * cause (the denied action, else the verbatim message) and each group's labels
 * are split back into resource / region / account so each part prints once:
 * "ec2:DescribeRouteTables — denied for VpcRouteTables in 16 regions: …".
 * The verbatim AWS message stays in the row's tooltip for anyone who needs it.
 */
interface IssueRow {
  key: string;
  /** Denied action, or undefined for a non-authorization failure. */
  action?: string;
  kind: FetchIssue['kind'];
  scp: boolean;
  resources: string[];
  regions: string[];
  accounts: string[];
  message: string;
}

const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d+$/;
const ACCOUNT_RE = /^\d{12}$/;

/**
 * fetch-topology labels are `Name`, `region/Name` or `account/region/Name`, but
 * some have a non-region prefix (`CloudWatch/BgpPrefixMetrics`), so segments
 * are only peeled off when they actually look like a region / account.
 */
function parseLabel(label: string): { account?: string; region?: string; resource: string } {
  const parts = label.split('/');
  let account: string | undefined;
  let region: string | undefined;
  if (parts.length > 1 && ACCOUNT_RE.test(parts[0])) account = parts.shift();
  if (parts.length > 1 && REGION_RE.test(parts[0])) region = parts.shift();
  return { account, region, resource: parts.join('/') };
}

/** Customer-facing names for fetch-topology's internal resource labels. */
const FRIENDLY: Record<string, string> = {
  VpcRouteTables: 'VPC route tables',
  VPCs: 'VPCs',
  TGWs: 'Transit gateways',
  TransitGateways: 'Transit gateways',
  TGWAttachments: 'Transit gateway attachments',
  TGWPeeringAttachments: 'Transit gateway peerings',
  TGWRoutes: 'Transit gateway route tables',
  VpcPeerings: 'VPC peerings',
  VpnConnections: 'VPN connections',
  VpnGateways: 'Virtual private gateways',
  CustomerGateways: 'Customer gateways',
  Connections: 'DX connections',
  VirtualInterfaces: 'Virtual interfaces',
  Lags: 'LAGs',
  Locations: 'DX locations',
  DxGateways: 'DX gateways',
  DxGwAssoc: 'DX gateway associations',
  DxGwAttachmentRegions: 'DX gateway attachments',
};

function friendlyName(resource: string): string {
  // `TGWRoutes(1a2b3c4d)` → `TGWRoutes`: the per-TGW suffix is noise here.
  const base = resource.replace(/\(.*\)$/, '');
  return FRIENDLY[base] ?? base;
}

/** Short reason for a non-permission failure; the raw text stays in the tooltip. */
function shortReason(row: IssueRow): string {
  if (row.kind === 'truncated') return 'partially loaded';
  if (/not able to validate the provided access credentials/i.test(row.message)) {
    return 'credentials rejected (region may not be enabled)';
  }
  return row.message.length > 80 ? `${row.message.slice(0, 77)}…` : row.message;
}

function pushUnique(list: string[], value: string | undefined) {
  if (value && !list.includes(value)) list.push(value);
}

function issueRows(issues: FetchIssue[]): IssueRow[] {
  const groups = new Map<string, IssueRow>();
  for (const issue of issues) {
    const action = issue.kind === 'failed' ? deniedAction(issue.message) : undefined;
    const key = `${issue.kind}|${action ?? issue.message}`;
    let row = groups.get(key);
    if (!row) {
      row = { key, action, kind: issue.kind, scp: false, resources: [], regions: [], accounts: [], message: issue.message };
      groups.set(key, row);
    }
    const { account, region, resource } = parseLabel(issue.label);
    pushUnique(row.resources, friendlyName(resource));
    pushUnique(row.regions, region);
    pushUnique(row.accounts, account);
    if (/service control policy/i.test(issue.message)) row.scp = true;
  }
  // Permission denials first: they are the actionable ones.
  return [...groups.values()].sort((a, b) => Number(!!b.action) - Number(!!a.action));
}

function where(row: IssueRow): string {
  if (row.regions.length === 0) return '';
  return row.regions.length === 1 ? ` · ${row.regions[0]}` : ` · ${row.regions.length} regions`;
}

function tooltip(row: IssueRow): string {
  return [
    row.regions.length > 0 ? `Regions: ${row.regions.join(', ')}` : '',
    row.accounts.length > 0 ? `Account: ${row.accounts.join(', ')}` : '',
    row.message,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Persistent notice that the loaded topology is missing data.
 *
 * `logged()` in fetch-topology.ts deliberately returns `[]` for a resource that
 * failed rather than aborting the whole load — one dead service should not blank
 * the canvas. The cost is that a failure is indistinguishable from an empty
 * account, and nothing told the user: the errors were collected into a local
 * array and dropped, so an AccessDenied on VPC route tables produced a topology
 * that looked complete and correct.
 *
 * That matters more than "some panels are empty", which is why this is not
 * dismissable-and-forgotten like EmptyStateBanner. Several rules read absence as
 * a pass — an empty `vpcRouteTables` means `ruleBlackholeRoutes` finds no
 * blackholes and `ruleVpcNoHybridRoute` finds nothing missing — so a failed
 * fetch can RAISE the resiliency score. The score and any exported report are
 * then confidently wrong, and the user has no way to know.
 *
 * Starts collapsed to its one-line header, and can be closed. Closing lasts
 * only for the current topology: refreshing or switching account/scenario
 * replaces `topologyData`, which brings it back for the new context. The
 * exported HTML report carries the same warning independently, so closing the
 * banner never removes it from a report.
 */
export function IncompleteDataBanner() {
  const topologyData = useTopologyStore((s) => s.topologyData);
  const isLoading = useTopologyStore((s) => s.isLoading);
  const error = useTopologyStore((s) => s.error);
  const light = useIsLight();

  // Starts collapsed: the header alone states the problem, and the full list
  // covered the canvas on estates with many denied calls. Keyed on the topology
  // object rather than a bare boolean so a refresh or an account switch folds
  // it back for the new context.
  const [expandedFor, setExpandedFor] = useState<TopologyData | null>(null);
  const collapsed = topologyData == null || expandedFor !== topologyData;
  const [dismissedFor, setDismissedFor] = useState<TopologyData | null>(null);

  const issues = topologyData?.fetchIssues ?? [];

  // App.tsx already owns the full-screen error and loading states; don't stack.
  if (isLoading || error) return null;
  if (issues.length === 0) return null;
  if (dismissedFor === topologyData) return null;

  const guidance = guidanceFor(issues);

  const amber = COLORS.severity.warning;

  return (
    <div
      role="alert"
      style={{
        background: light ? '#FFFBEB' : 'rgba(120, 53, 15, 0.35)',
        border: `1px solid ${amber}`,
        borderRadius: 8,
        padding: '10px 12px',
        maxWidth: 460,
        maxHeight: '45vh',
        display: 'flex',
        flexDirection: 'column',
        overflowWrap: 'anywhere',
        fontSize: 12,
        color: light ? '#78350F' : '#FDE68A',
        boxShadow: '0 2px 8px rgba(0,0,0,0.18)',
        backdropFilter: 'blur(4px)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span aria-hidden style={{ color: amber, fontSize: 14 }}>
          ⚠
        </span>
        <strong style={{ flex: 1, fontSize: 12.5 }}>
          Topology may be incomplete — {summariseIssues(issues)}
        </strong>
        <button
          type="button"
          onClick={() => setExpandedFor(collapsed ? (topologyData ?? null) : null)}
          aria-expanded={!collapsed}
          style={{
            background: 'transparent',
            border: `1px solid ${amber}`,
            borderRadius: 4,
            color: 'inherit',
            cursor: 'pointer',
            fontSize: 11,
            padding: '1px 6px',
          }}
        >
          {collapsed ? 'Details' : 'Hide'}
        </button>
        <button
          type="button"
          onClick={() => setDismissedFor(topologyData)}
          aria-label="Close notice"
          title="Close"
          style={{
            background: 'transparent',
            border: 'none',
            color: 'inherit',
            cursor: 'pointer',
            fontSize: 14,
            lineHeight: 1,
            padding: '0 2px',
            opacity: 0.8,
          }}
        >
          ×
        </button>
      </div>

      {!collapsed && (
        <div style={{ overflowY: 'auto', minHeight: 0 }}>
          {/* Stated before the list, because the list alone reads as a
              cosmetic gap rather than a reason to distrust the score. */}
          <div style={{ marginTop: 6, lineHeight: 1.45 }}>
            Resiliency scores and exported reports may be inaccurate: data that
            failed to load looks the same as data that does not exist.
          </div>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18, lineHeight: 1.5 }}>
            {issueRows(issues).map((row) => (
              <li key={row.key} title={tooltip(row)}>
                <strong>{row.resources.join(', ')}</strong>
                {row.action ? (
                  <>
                    {row.scp ? ' — blocked by organization policy ' : ' — missing permission '}
                    <code style={{ fontSize: 11 }}>{row.action}</code>
                  </>
                ) : (
                  ` — ${shortReason(row)}`
                )}
                {where(row)}
              </li>
            ))}
          </ul>
          {guidance.map((line) => (
            <div key={line} style={{ marginTop: 6, opacity: 0.9 }}>
              {line}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
