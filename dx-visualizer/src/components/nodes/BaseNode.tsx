import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { NodeBadge } from '../../types/topology';
import { COLORS } from '../../utils/colors';
import { useTopologyStore } from '../../store/topology-store';
import { useRedact } from '../../utils/redact';

export type NodeAccent = 'default' | 'crossAccount' | 'inferred';

const ACCENT_BORDER: Record<NodeAccent, { dark: string; light: string }> = {
  default: { dark: COLORS.existing.border, light: COLORS.light.border },
  crossAccount: { dark: '#f59e0b', light: '#d97706' },
  inferred: { dark: '#facc15', light: '#a16207' },
};

interface BaseNodeProps {
  label: string;
  subtitle?: string;
  icon: React.ReactNode;
  isRecommended?: boolean;
  accent?: NodeAccent;
  borderColor?: string;
  bgColor?: string;
  badges?: NodeBadge[];
  handles?: { source?: boolean; target?: boolean };
  targetHandleIds?: string[];
  // Named handles rendered at middle-left; visually stack on the default
  // target handle so they read as a single dot. Needed for peering edges
  // that require a named source handle on the left.
  extraLeftHandles?: { id: string; type: 'source' | 'target'; background?: string }[];
  extraRightHandles?: { id: string; type: 'source' | 'target'; background?: string }[];
  children?: React.ReactNode;
  nodeId?: string;
  // Rendered absolutely-positioned at the visible node's top-right corner.
  topRightOverlay?: React.ReactNode;
}

export const BaseNode = memo(function BaseNode({
  label,
  subtitle,
  icon,
  isRecommended,
  accent,
  borderColor,
  bgColor = '#1e293b',
  badges,
  handles = { source: true, target: true },
  targetHandleIds,
  extraLeftHandles,
  extraRightHandles,
  children,
  nodeId,
  topRightOverlay,
}: BaseNodeProps) {
  const theme = useTopologyStore((s) => s.theme);
  const r = useRedact();
  const isSimulating = useTopologyStore((s) => s.isSimulating);
  const isLocked = useTopologyStore((s) => s.isLocked);
  const toggleNodeFailure = useTopologyStore((s) => s.toggleNodeFailure);
  // Per-id selectors: Zustand compares the returned value with ===, so a node's
  // booleans are stable when a *different* node's state changes — avoiding an
  // N-node rerender storm on every hover/failure toggle.
  const isFailed = useTopologyStore((s) => nodeId != null && s.failedNodeIds.has(nodeId));
  const isDimmed = useTopologyStore(
    (s) => s.hoveredNodeId != null && nodeId != null && !s.highlightedNodeIds.has(nodeId),
  );
  const isSpotlit = useTopologyStore((s) => nodeId != null && s.spotlightNodeIds.has(nodeId));
  const isPinned = useTopologyStore((s) => nodeId != null && s.pinnedNodeId === nodeId);
  const light = theme === 'light';
  const canGlow = !isFailed && !isRecommended;

  const accentPair = accent ? ACCENT_BORDER[accent] : null;
  const darkBorder = accentPair ? accentPair.dark : borderColor ?? COLORS.existing.border;
  const lightBorder = accentPair ? accentPair.light : borderColor ?? COLORS.light.border;
  const effectiveBorder = isFailed
    ? '#ef4444'
    : isRecommended
      ? COLORS.recommended.border
      : light ? lightBorder : darkBorder;
  const darkBg = isRecommended ? '#0d3025' : bgColor;
  const effectiveBg = isFailed
    ? (light ? '#fef2f2' : '#3b1111')
    : light
      ? (isRecommended ? COLORS.light.recommendedBg : COLORS.light.nodeBg)
      : darkBg;

  const handleClick = () => {
    if (isSimulating && nodeId && !isRecommended) {
      toggleNodeFailure(nodeId);
    }
  };

  // The card only *is* a control while simulating — outside simulation it must stay
  // a plain, non-focusable div so nodes don't add a tab stop each.
  const canToggleFailure = Boolean(isSimulating && nodeId && !isRecommended);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Ignore keys bubbling up from the overlay buttons — preventDefault here
    // would swallow their own activation.
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleClick();
    }
  };

  const accentStrip = light && !isFailed && !isRecommended
    ? `inset 4px 0 0 0 ${effectiveBorder}`
    : null;
  const baseShadow = isFailed
    ? '0 0 12px rgba(239,68,68,0.4)'
    : isRecommended
      ? `0 0 8px ${COLORS.recommended.border}30`
      : light
        ? (accentStrip ? `${accentStrip}, ${COLORS.light.nodeShadow}` : COLORS.light.nodeShadow)
        : '0 1px 3px rgba(0,0,0,0.3)';

  // Hover-path highlight: dim everything not on the path; nodes on the path stay
  // their normal color. The contrast + the accent-colored path edges carry the signal.
  const hoverOpacity = isDimmed ? 0.25 : undefined;

  return (
    <div data-node-card className="flex items-center justify-center" style={{ width: '100%', height: '100%' }}>
      <div
        role={canToggleFailure ? 'button' : undefined}
        tabIndex={canToggleFailure ? 0 : undefined}
        aria-pressed={canToggleFailure ? isFailed : undefined}
        aria-label={canToggleFailure ? `Toggle simulated failure for ${r(label)}` : undefined}
        className={`relative flex flex-col items-start justify-center rounded-md px-2.5 py-1.5 transition-all ${canGlow ? 'hover:brightness-110' : ''} ${isSpotlit ? 'node-spotlight' : ''} ${isPinned ? 'node-pinned' : ''}`}
        style={{
          borderWidth: isFailed ? 2.5 : light ? 1 : 1.5,
          borderStyle: isRecommended ? 'dashed' : 'solid',
          borderColor: light
            ? (isFailed ? '#ef4444' : isRecommended ? COLORS.recommended.border : '#e2e5ea')
            : effectiveBorder,
          paddingLeft: light && !isFailed && !isRecommended ? 12 : undefined,
          backgroundColor: effectiveBg,
          opacity: hoverOpacity ?? (isRecommended ? 0.85 : isFailed ? 0.6 : 1),
          boxShadow: baseShadow,
          minWidth: 70,
          maxWidth: '100%',
          cursor: isSimulating && !isRecommended ? 'pointer' : undefined,
          filter: isFailed ? 'grayscale(50%)' : undefined,
        }}
        onClick={canToggleFailure ? handleClick : undefined}
        onKeyDown={canToggleFailure ? handleKeyDown : undefined}
      >
        {handles.target && targetHandleIds && targetHandleIds.length > 0 ? (
          targetHandleIds.map((hid, i) => (
            <Handle
              key={hid}
              id={hid}
              type="target"
              position={Position.Left}
              style={{
                background: effectiveBorder,
                width: 6,
                height: 6,
                top: `${((i + 1) / (targetHandleIds.length + 1)) * 100}%`,
              }}
            />
          ))
        ) : handles.target ? (
          <Handle type="target" position={Position.Left} style={{ background: effectiveBorder, width: 6, height: 6 }} />
        ) : null}
        <div className="flex items-start gap-2 w-full">
          <div className="flex-shrink-0 flex items-center justify-center" style={{ color: effectiveBorder, width: 28, height: 28 }}>{icon}</div>
          {/* The pointer handlers only stop React Flow from claiming the gesture as a
              drag so the label stays selectable — no action fires, so there is nothing
              for a keyboard user to activate here. */}
          {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
          <div
            className={`flex flex-col items-start min-w-0 gap-0.5 selectable-text${isLocked ? ' nodrag nopan' : ''}`}
            onMouseDown={isLocked ? (e) => e.stopPropagation() : undefined}
            onPointerDown={isLocked ? (e) => e.stopPropagation() : undefined}
          >
            <span
              className={`text-[10px] font-semibold leading-tight whitespace-pre-line ${theme === 'light' ? 'text-slate-800' : 'text-slate-200'}`}
              style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}
            >{r(label)}</span>
            {subtitle && (
              <span className={`text-[8px] leading-tight ${theme === 'light' ? 'text-violet-500' : 'text-cyan-400'}`}>{subtitle}</span>
            )}
            {children}
          </div>
        </div>

        {badges && badges.length > 0 && (
          <div className="absolute -top-1.5 -right-1.5 flex gap-0.5">
            {badges.map((badge, i) => (
              <span
                key={i}
                className="rounded-full px-1 py-0 text-[7px] font-bold text-white"
                style={{ backgroundColor: COLORS.severity[badge.type === 'error' ? 'critical' : badge.type] }}
                title={badge.description}
              >
                {badge.label}
              </span>
            ))}
          </div>
        )}

        {isFailed && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <svg className="w-8 h-8" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="3" strokeLinecap="round">
              <line x1="4" y1="4" x2="20" y2="20" />
              <line x1="20" y1="4" x2="4" y2="20" />
            </svg>
          </div>
        )}

        {handles.source && (
          <Handle type="source" position={Position.Right} style={{ background: effectiveBorder, width: 6, height: 6 }} />
        )}
        {extraLeftHandles?.map((h) => (
          <Handle
            key={h.id}
            id={h.id}
            type={h.type}
            position={Position.Left}
            style={{ background: h.background ?? effectiveBorder, width: 6, height: 6 }}
          />
        ))}
        {extraRightHandles?.map((h) => (
          <Handle
            key={h.id}
            id={h.id}
            type={h.type}
            position={Position.Right}
            style={{ background: h.background ?? effectiveBorder, width: 6, height: 6 }}
          />
        ))}
        {topRightOverlay && (
          /* Wrapper only shields the overlay's own controls from React Flow's drag
             handling; the controls inside carry the keyboard-accessible actions. */
          /* eslint-disable-next-line jsx-a11y/no-static-element-interactions */
          <div
            className="nodrag nopan"
            style={{
              position: 'absolute',
              top: -8,
              right: -8,
              display: 'flex',
              gap: 2,
              pointerEvents: 'auto',
              zIndex: 10,
            }}
            onMouseDown={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {topRightOverlay}
          </div>
        )}
      </div>
    </div>
  );
});
