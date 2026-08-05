import { useCallback, useMemo } from 'react';
import type { NodeProps } from '@xyflow/react';
import type { DxNodeData } from '../../types/topology';
import { COLORS } from '../../utils/colors';
import { useTopologyStore } from '../../store/topology-store';
import { RegionFlagIcon } from './aws-icons';
import { ZoneFailButton } from './ZoneFailButton';

export function RegionNode({ id, data }: NodeProps) {
  const d = data as DxNodeData;
  const theme = useTopologyStore((s) => s.theme);
  const failed = useTopologyStore((s) => s.failedNodeIds.has(id));
  const isSimulating = useTopologyStore((s) => s.isSimulating);
  const isLocked = useTopologyStore((s) => s.isLocked);
  const expandedVpcGroups = useTopologyStore((s) => s.expandedVpcGroups);
  const expandedTgwGroups = useTopologyStore((s) => s.expandedTgwGroups);
  const toggleVpcGroup = useTopologyStore((s) => s.toggleVpcGroup);
  const toggleTgwGroup = useTopologyStore((s) => s.toggleTgwGroup);
  const showNonDxVpcs = useTopologyStore((s) => s.showNonDxVpcs);
  const toggleShowNonDxVpcs = useTopologyStore((s) => s.toggleShowNonDxVpcs);

  const regionCode = (d.details as Record<string, string>)?.regionCode ?? '';
  const nonDxVpcCount = d.nonDxVpcCount ?? 0;
  const nonDxVpcsShown = showNonDxVpcs.has(regionCode);

  // Find all expanded TGW/VPC group keys that belong to this region
  const expandedTgwKeys = useMemo(
    () => [...expandedTgwGroups].filter((k) => k.includes(regionCode)),
    [expandedTgwGroups, regionCode],
  );
  const expandedVpcKeys = useMemo(
    () => [...expandedVpcGroups].filter((k) => k.includes(regionCode)),
    [expandedVpcGroups, regionCode],
  );

  const light = theme === 'light';
  const regionBg = failed ? 'rgba(239,68,68,0.08)' : light ? COLORS.light.containerRegion : 'rgba(6,182,212,0.08)';
  const headerBg = failed ? 'rgba(239,68,68,0.15)' : light ? COLORS.light.containerRegionHeader : 'rgba(6,182,212,0.22)';
  const borderColor = failed ? '#ef4444' : light ? '#0ea5e9' : COLORS.containers.region.border;
  // Header text uses a higher-contrast color than the container border so labels stay readable
  const headerTextColor = failed ? '#ef4444' : light ? '#0369a1' : '#ffffff';

  const handleCollapseAllTgw = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    for (const key of expandedTgwKeys) toggleTgwGroup(key);
  }, [expandedTgwKeys, toggleTgwGroup]);

  const handleCollapseAllVpc = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    for (const key of expandedVpcKeys) toggleVpcGroup(key);
  }, [expandedVpcKeys, toggleVpcGroup]);

  const handleToggleNonDx = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    toggleShowNonDxVpcs(regionCode);
  }, [regionCode, toggleShowNonDxVpcs]);

  return (
    <div
      className="rounded-xl pointer-events-none"
      style={{
        borderWidth: light ? 1.5 : 2,
        borderStyle: 'solid',
        borderColor: light ? (failed ? '#ef4444' : '#7dd3fc') : borderColor,
        backgroundColor: regionBg,
        width: '100%',
        height: '100%',
        position: 'relative',
        opacity: light ? 1 : 0.8,
        boxShadow: light
          ? 'inset 0 0 0 1px rgba(14,165,233,0.10), 0 1px 2px rgba(15,23,42,0.04)'
          : undefined,
      }}
    >
      <div
        className="flex items-center gap-1.5 px-2 py-1 rounded-t-xl"
        style={{
          background: light && !failed
            ? `linear-gradient(to bottom, ${headerBg}, rgba(14,165,233,0.06))`
            : headerBg,
          borderBottom: `1px solid ${light ? 'rgba(14,165,233,0.22)' : borderColor + '20'}`,
        }}
      >
        <div style={{ color: headerTextColor }}>
          <RegionFlagIcon size={16} />
        </div>
        {/* Pointer handlers only stop React Flow claiming the gesture as a drag so the
            region label stays selectable — no action fires, nothing to expose to the keyboard. */}
        {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
        <div
          className={`flex items-center gap-1.5 selectable-text${isLocked ? ' nodrag nopan' : ''}`}
          style={{ pointerEvents: 'auto' }}
          onMouseDown={isLocked ? (e) => e.stopPropagation() : undefined}
          onPointerDown={isLocked ? (e) => e.stopPropagation() : undefined}
        >
          <span className="text-[10px] font-bold" style={{ color: headerTextColor }}>
            {d.label}
          </span>
          {regionCode && (
            <span className="text-[9px] font-medium" style={{ color: headerTextColor, opacity: 0.75 }}>({regionCode})</span>
          )}
        </div>
        {(expandedTgwKeys.length > 0 || expandedVpcKeys.length > 0 || nonDxVpcCount > 0) && (
          <div className="pointer-events-auto flex items-center gap-1 ml-auto">
            {nonDxVpcCount > 0 && (() => {
              const label = `${nonDxVpcsShown ? 'Hide' : 'Show'} non DXGW association nodes`;
              return (
                <button
                  onClick={handleToggleNonDx}
                  className="cursor-pointer px-2 py-0.5 rounded-md text-[9px] font-semibold transition-colors hover:brightness-110"
                  style={{
                    color: light ? '#6d28d9' : '#ede9fe',
                    backgroundColor: light ? 'rgba(139,92,246,0.12)' : 'rgba(139,92,246,0.22)',
                    border: `1px solid ${light ? 'rgba(139,92,246,0.45)' : 'rgba(139,92,246,0.55)'}`,
                  }}
                  title={label}
                >
                  {`${label} (${nonDxVpcCount})`}
                </button>
              );
            })()}
            {expandedTgwKeys.length > 0 && (
              <button
                onClick={handleCollapseAllTgw}
                className="cursor-pointer px-2 py-0.5 rounded-md text-[9px] font-bold transition-colors hover:brightness-110"
                style={{
                  color: '#fff',
                  backgroundColor: '#8b5cf6',
                  boxShadow: '0 1px 4px rgba(139,92,246,0.35)',
                }}
                title="Collapse TGWs"
              >
                <span className="flex items-center gap-1">
                  <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="4 14 10 14 10 20" />
                    <polyline points="20 10 14 10 14 4" />
                    <line x1="14" y1="10" x2="21" y2="3" />
                    <line x1="3" y1="21" x2="10" y2="14" />
                  </svg>
                  Collapse TGWs
                </span>
              </button>
            )}
            {expandedVpcKeys.length > 0 && (
              <button
                onClick={handleCollapseAllVpc}
                className="cursor-pointer px-2 py-0.5 rounded-md text-[9px] font-bold transition-colors hover:brightness-110"
                style={{
                  color: '#fff',
                  backgroundColor: '#8b5cf6',
                  boxShadow: '0 1px 4px rgba(139,92,246,0.35)',
                }}
                title="Collapse VPCs"
              >
                <span className="flex items-center gap-1">
                  <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="4 14 10 14 10 20" />
                    <polyline points="20 10 14 10 14 4" />
                    <line x1="14" y1="10" x2="21" y2="3" />
                    <line x1="3" y1="21" x2="10" y2="14" />
                  </svg>
                  Collapse VPCs
                </span>
              </button>
            )}
          </div>
        )}
      </div>
      {isSimulating && (
        <ZoneFailButton zoneId={id} zoneType="region" zoneKey={regionCode} failed={failed} />
      )}
    </div>
  );
}
