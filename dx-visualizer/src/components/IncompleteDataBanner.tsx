import { useState } from 'react';
import { useTopologyStore } from '../store/topology-store';
import { useIsLight } from '../hooks/useTheme';
import { COLORS } from '../utils/colors';
import type { TopologyData } from '../types/topology';
import { summariseIssues, guidanceFor } from '../utils/fetch-issues';

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
 * Collapsible, not dismissable: the header stays on screen for the life of the
 * topology so a shared screenshot or an exported report is never taken from a
 * view that silently hid this. Refreshing or switching account/scenario
 * replaces `topologyData`, which is what clears it.
 */
export function IncompleteDataBanner() {
  const topologyData = useTopologyStore((s) => s.topologyData);
  const isLoading = useTopologyStore((s) => s.isLoading);
  const error = useTopologyStore((s) => s.error);
  const light = useIsLight();

  // Keyed on the topology object rather than a bare boolean so a refresh or an
  // account switch re-expands it for the new context.
  const [collapsedFor, setCollapsedFor] = useState<TopologyData | null>(null);
  const collapsed = topologyData != null && collapsedFor === topologyData;

  const issues = topologyData?.fetchIssues ?? [];

  // App.tsx already owns the full-screen error and loading states; don't stack.
  if (isLoading || error) return null;
  if (issues.length === 0) return null;

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
          onClick={() => setCollapsedFor(collapsed ? null : (topologyData ?? null))}
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
      </div>

      {!collapsed && (
        <>
          {/* Stated before the list, because the list alone reads as a
              cosmetic gap rather than a reason to distrust the score. */}
          <div style={{ marginTop: 6, lineHeight: 1.45 }}>
            Resiliency scores and exported reports may be inaccurate — a resource
            that failed to load is indistinguishable from one that does not
            exist, so some checks may report no finding rather than “unknown”.
          </div>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18, lineHeight: 1.5 }}>
            {issues.map((issue) => (
              <li key={`${issue.kind}:${issue.label}`}>
                <code style={{ fontSize: 11 }}>{issue.label}</code>
                {issue.kind === 'truncated' ? ' — incomplete: ' : ' — failed: '}
                {issue.message}
              </li>
            ))}
          </ul>
          {guidance.map((line) => (
            <div key={line} style={{ marginTop: 6, opacity: 0.9 }}>
              {line}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
