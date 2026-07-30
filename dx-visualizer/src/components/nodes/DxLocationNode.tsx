import { useCallback } from 'react';
import { type NodeProps, NodeResizer } from '@xyflow/react';
import type { DxNodeData } from '../../types/topology';
import { COLORS } from '../../utils/colors';
import { useTopologyStore } from '../../store/topology-store';
import { DirectConnectIcon } from './aws-icons';
import { ZoneFailButton } from './ZoneFailButton';

export function DxLocationNode({ id, data }: NodeProps) {
  const d = data as DxNodeData;
  const theme = useTopologyStore((s) => s.theme);
  const failed = useTopologyStore((s) => s.failedNodeIds.has(id));
  const isSimulating = useTopologyStore((s) => s.isSimulating);
  const isLocked = useTopologyStore((s) => s.isLocked);
  const setNodeSizeOverride = useTopologyStore((s) => s.setNodeSizeOverride);
  const togglePartnerGroup = useTopologyStore((s) => s.togglePartnerGroup);
  const light = theme === 'light';

  const handleResizeEnd = useCallback(
    (_event: unknown, params: { width: number; height: number }) => {
      setNodeSizeOverride(id, params.width, params.height);
    },
    [id, setNodeSizeOverride],
  );
  const expandedPartnerGroupKeys = (
    (d.details as Record<string, string> | undefined)?.expandedPartnerGroupKeys ?? ''
  ).split(',').filter(Boolean);
  const border = failed
    ? '#ef4444'
    : d.isRecommended
      ? COLORS.recommended.border
      : light ? COLORS.light.border : COLORS.containers.dxLocation.border;
  const bg = failed
    ? 'rgba(239,68,68,0.08)'
    : light
      ? (d.isRecommended ? 'rgba(16,185,129,0.08)' : COLORS.light.containerDx)
      : (d.isRecommended ? 'rgba(16,185,129,0.08)' : 'rgba(139,92,246,0.08)');
  const headerBg = failed
    ? 'rgba(239,68,68,0.15)'
    : light
      ? (d.isRecommended ? 'rgba(16,185,129,0.14)' : COLORS.light.containerDxHeader)
      : (d.isRecommended ? 'rgba(16,185,129,0.22)' : 'rgba(139,92,246,0.22)');
  const headerTextColor = failed ? '#ef4444' : light ? '#6d28d9' : '#ffffff';

  return (
    <>
      <NodeResizer
        minWidth={150}
        minHeight={80}
        isVisible={!isLocked && !d.isRecommended}
        color={light ? '#a78bfa' : '#7c3aed'}
        handleStyle={{ width: 8, height: 8, borderRadius: 2 }}
        lineStyle={{ borderWidth: 1 }}
        onResizeEnd={handleResizeEnd}
      />
      <div
        className="rounded-lg pointer-events-none"
      style={{
        borderWidth: light ? 1.5 : 2,
        borderStyle: d.isRecommended ? 'dashed' : 'solid',
        borderColor: light ? (failed ? '#ef4444' : '#a78bfa') : border,
        backgroundColor: bg,
        width: '100%',
        height: '100%',
        position: 'relative',
        opacity: d.isRecommended ? 0.6 : 1,
        boxShadow: light && !d.isRecommended
          ? 'inset 0 0 0 1px rgba(124,58,237,0.10), 0 1px 2px rgba(15,23,42,0.04)'
          : undefined,
      }}
    >
      <div
        className="flex items-center gap-1.5 px-2 py-1 rounded-t-lg text-[10px] font-semibold"
        style={{
          color: headerTextColor,
          background: light && !d.isRecommended && !failed
            ? `linear-gradient(to bottom, ${headerBg}, rgba(124,58,237,0.05))`
            : headerBg,
          borderBottom: `1px solid ${light ? 'rgba(124,58,237,0.22)' : 'rgba(139,92,246,0.30)'}`,
        }}
      >
        <DirectConnectIcon size={14} />
        {/* Pointer handlers only stop React Flow claiming the gesture as a drag so the
            location label stays selectable — no action fires, nothing to expose to the keyboard. */}
        {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
        <span
          className={`selectable-text${isLocked ? ' nodrag nopan' : ''}`}
          style={{ pointerEvents: 'auto' }}
          onMouseDown={isLocked ? (e) => e.stopPropagation() : undefined}
          onPointerDown={isLocked ? (e) => e.stopPropagation() : undefined}
        >
          {d.label}
        </span>
        {expandedPartnerGroupKeys.length > 0 && (
          <div
            role="button"
            tabIndex={0}
            className="ml-auto cursor-pointer px-2 py-0.5 rounded-md text-[9px] font-bold transition-colors hover:brightness-110 focus-visible:ring-1 focus-visible:ring-purple-500"
            style={{
              pointerEvents: 'auto',
              color: '#fff',
              backgroundColor: '#8b5cf6',
              boxShadow: '0 1px 4px rgba(139,92,246,0.35)',
            }}
            onClick={(e) => { e.stopPropagation(); expandedPartnerGroupKeys.forEach((k) => togglePartnerGroup(k)); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                expandedPartnerGroupKeys.forEach((k) => togglePartnerGroup(k));
              }
            }}
            title="Collapse CGWs"
            aria-label="Collapse Customer Gateways back into group"
          >
            <span className="flex items-center gap-1">
              <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="4 14 10 14 10 20" />
                <polyline points="20 10 14 10 14 4" />
                <line x1="14" y1="10" x2="21" y2="3" />
                <line x1="3" y1="21" x2="10" y2="14" />
              </svg>
              Collapse CGWs
            </span>
          </div>
        )}
      </div>
      {isSimulating && !d.isRecommended && (
        <ZoneFailButton zoneId={id} zoneType="dxLocation" zoneKey={(d.details as Record<string, string>)?.code} failed={failed} />
      )}
    </div>
    </>
  );
}
