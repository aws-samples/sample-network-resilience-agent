import { useCallback } from 'react';
import { type NodeProps, NodeResizer } from '@xyflow/react';
import type { DxNodeData } from '../../types/topology';
import { useTopologyStore } from '../../store/topology-store';
import { OnPremiseIcon } from './aws-icons';
import { ZoneFailButton } from './ZoneFailButton';

export function CustomerSiteNode({ id, data }: NodeProps) {
  const d = data as DxNodeData;
  const theme = useTopologyStore((s) => s.theme);
  const failed = useTopologyStore((s) => s.failedNodeIds.has(id));
  const isSimulating = useTopologyStore((s) => s.isSimulating);
  const isLocked = useTopologyStore((s) => s.isLocked);
  const setNodeSizeOverride = useTopologyStore((s) => s.setNodeSizeOverride);
  const addUserCustomerSite = useTopologyStore((s) => s.addUserCustomerSite);
  const removeUserCustomerSite = useTopologyStore((s) => s.removeUserCustomerSite);
  const hideCustomerSite = useTopologyStore((s) => s.hideCustomerSite);
  const light = theme === 'light';
  const isUserCreated = (d.details as Record<string, string> | undefined)?.userCreated === 'true';
  // Both + and - show on every real or user-created Customer Data Center zone.
  // Ghost (recommended) zones stay read-only.
  const canShowAddButton = !d.isRecommended && !isLocked && !isSimulating;
  const canShowDeleteButton = !d.isRecommended && !isLocked && !isSimulating;

  const handleResizeEnd = useCallback(
    (_event: unknown, params: { width: number; height: number }) => {
      setNodeSizeOverride(id, params.width, params.height);
    },
    [id, setNodeSizeOverride],
  );

  // Ghost zones fade border + fill via rgba alpha instead of a container-level
  // `opacity`. The DxLocationNode uses container opacity, but we can't here —
  // the embedded TargetTierPicker menu would inherit the fade and become
  // half-transparent. Match the same visual weight by pre-fading the colors.
  const recommendedBorder = 'rgba(16,185,129,0.6)';
  const border = failed
    ? '#ef4444'
    : d.isRecommended
      ? recommendedBorder
      : light ? '#6b7280' : '#4b5563';
  const bg = failed
    ? 'rgba(239,68,68,0.08)'
    : light
      ? (d.isRecommended ? 'rgba(16,185,129,0.05)' : 'rgba(248,250,252,0.8)')
      : (d.isRecommended ? 'rgba(16,185,129,0.05)' : 'rgba(100,116,139,0.08)');
  const headerBg = failed
    ? 'rgba(239,68,68,0.15)'
    : light
      ? (d.isRecommended ? 'rgba(16,185,129,0.09)' : '#f1f5f9')
      : (d.isRecommended ? 'rgba(16,185,129,0.13)' : 'rgba(100,116,139,0.22)');

  const labelOpacity = d.isRecommended && !failed ? 0.6 : 1;

  return (
    <>
      <NodeResizer
        minWidth={150}
        minHeight={80}
        isVisible={!isLocked && !d.isRecommended}
        color={light ? '#94a3b8' : '#4b5563'}
        handleStyle={{ width: 8, height: 8, borderRadius: 2 }}
        lineStyle={{ borderWidth: 1 }}
        onResizeEnd={handleResizeEnd}
      />
      <div
        className="rounded-xl pointer-events-none"
        style={{
          borderWidth: light ? 1.5 : 2,
          borderStyle: d.isRecommended ? 'dashed' : 'solid',
          borderColor: light ? (failed ? '#ef4444' : d.isRecommended ? recommendedBorder : '#94a3b8') : border,
          backgroundColor: bg,
          width: '100%',
          height: '100%',
          position: 'relative',
          boxShadow: light && !d.isRecommended
            ? 'inset 0 0 0 1px rgba(100,116,139,0.08), 0 1px 3px rgba(15,23,42,0.05)'
            : undefined,
        }}
      >
        <div
          className="flex items-center gap-1.5 px-2 py-1 rounded-t-xl"
          style={{
            background: light && !d.isRecommended && !failed
              ? 'linear-gradient(to bottom, #e2e8f0, #eef1f6)'
              : headerBg,
            borderBottom: `1px solid ${light ? 'rgba(100,116,139,0.22)' : border + '20'}`,
          }}
        >
          <div style={{ color: light ? '#374151' : '#ffffff', opacity: labelOpacity }}>
            <OnPremiseIcon size={14} />
          </div>
          {/* Pointer handlers only stop React Flow claiming the gesture as a drag so the
              zone name stays selectable — no action fires, nothing to expose to the keyboard. */}
          {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
          <span
            className={`text-[10px] font-bold flex-1 min-w-0 truncate selectable-text${isLocked ? ' nodrag nopan' : ''}`}
            style={{ color: light ? '#374151' : '#ffffff', opacity: labelOpacity, pointerEvents: 'auto' }}
            title={d.label}
            onMouseDown={isLocked ? (e) => e.stopPropagation() : undefined}
            onPointerDown={isLocked ? (e) => e.stopPropagation() : undefined}
          >
            {d.label}
          </span>
          {canShowAddButton && (
            <button
              type="button"
              title="Add another Customer Data Center"
              onClick={(e) => { e.stopPropagation(); addUserCustomerSite(); }}
              onMouseDown={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              className="nodrag nopan flex items-center justify-center"
              style={{
                pointerEvents: 'auto',
                width: 14,
                height: 14,
                padding: 0,
                border: 'none',
                background: 'transparent',
                color: light ? '#059669' : '#34d399',
                opacity: 0.9,
                cursor: 'pointer',
                flexShrink: 0,
              }}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <line x1="6" y1="2" x2="6" y2="10" />
                <line x1="2" y1="6" x2="10" y2="6" />
              </svg>
            </button>
          )}
          {canShowDeleteButton && (
            <button
              type="button"
              title="Remove this Customer Data Center"
              onClick={(e) => {
                e.stopPropagation();
                if (isUserCreated) removeUserCustomerSite(id);
                else hideCustomerSite(id);
              }}
              onMouseDown={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              className="nodrag nopan flex items-center justify-center"
              style={{
                pointerEvents: 'auto',
                width: 14,
                height: 14,
                padding: 0,
                border: 'none',
                background: 'transparent',
                color: light ? '#dc2626' : '#f87171',
                opacity: 0.9,
                cursor: 'pointer',
                flexShrink: 0,
              }}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <line x1="3" y1="3" x2="9" y2="9" />
                <line x1="9" y1="3" x2="3" y2="9" />
              </svg>
            </button>
          )}
        </div>
        {isSimulating && !d.isRecommended && !isUserCreated && (
          <ZoneFailButton zoneId={id} zoneType="customerSite" zoneKey={(d.details as Record<string, string>)?.locationCode} failed={failed} />
        )}
      </div>
    </>
  );
}
