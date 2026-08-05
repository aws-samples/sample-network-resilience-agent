import { Handle, Position } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import type { DxNodeData, VpcChildInfo } from '../../types/topology';
import { COLORS } from '../../utils/colors';
import { VPC_TABLE_MAX_BODY_HEIGHT, VPC_TABLE_WIDTH } from '../../utils/constants';
import { useTopologyStore } from '../../store/topology-store';
import { VpcIcon } from './aws-icons';

export function VpcGroupNode({ data, id }: NodeProps) {
  const d = data as DxNodeData;
  const toggleVpcGroupTable = useTopologyStore((s) => s.toggleVpcGroupTable);
  const toggleVpcGroup = useTopologyStore((s) => s.toggleVpcGroup);
  const vpcGroupViewMode = useTopologyStore((s) => s.vpcGroupViewMode);
  const theme = useTopologyStore((s) => s.theme);
  const isLocked = useTopologyStore((s) => s.isLocked);
  const hoveredNodeId = useTopologyStore((s) => s.hoveredNodeId);
  const highlightedNodeIds = useTopologyStore((s) => s.highlightedNodeIds);
  const hasHoverActive = hoveredNodeId != null;
  const isOnHoverPath = hasHoverActive && highlightedNodeIds.has(id);
  const isDimmed = hasHoverActive && !isOnHoverPath;

  const details = d.details as Record<string, string> | undefined;
  const groupKey = details?.groupKey ?? id.replace(/^vpcgroup-/, '');
  const isOrphan = details?.orphan === 'true';
  const bg = theme === 'light' ? COLORS.light.nodeBg : '#1e1033';
  const border = theme === 'light' ? COLORS.light.border : '#8b5cf6';
  const isTable = vpcGroupViewMode.has(groupKey);
  const vpcChildren = (d.vpcChildren as VpcChildInfo[] | undefined) ?? [];
  const baseShadow = theme === 'light' ? COLORS.light.nodeShadow : '0 1px 3px rgba(0,0,0,0.3)';
  const dimOpacity = isDimmed ? 0.25 : undefined;

  if (isTable) {
    return (
      <div
        className="rounded-lg overflow-hidden"
        style={{
          borderWidth: 2,
          borderStyle: 'solid',
          borderColor: theme === 'light' ? '#e2e5ea' : border,
          borderLeftWidth: theme === 'light' ? 3 : 2,
          borderLeftColor: border,
          backgroundColor: bg,
          minWidth: 280,
          boxShadow: baseShadow,
          opacity: dimOpacity ?? 1,
        }}
      >
        <Handle type="target" position={Position.Left} style={{ background: border }} />

        <div
          className="flex items-center justify-between px-3 py-1.5"
          style={{ borderBottom: `1px solid ${theme === 'light' ? '#e2e5ea' : 'rgba(139,92,246,0.3)'}` }}
        >
          {/* Pointer handlers only stop React Flow claiming the gesture as a drag so the
              title stays selectable — no action fires, nothing for a keyboard user to do. */}
          {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
          <div
            className={`flex items-center gap-1.5 selectable-text${isLocked ? ' nodrag nopan' : ''}`}
            onMouseDown={isLocked ? (e) => e.stopPropagation() : undefined}
            onPointerDown={isLocked ? (e) => e.stopPropagation() : undefined}
          >
            <div style={{ color: border }}><VpcIcon /></div>
            <span className={`text-[10px] font-semibold ${theme === 'light' ? 'text-slate-700' : 'text-slate-200'}`}>
              {d.label}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <div
              role="button"
              tabIndex={0}
              className="text-[8px] px-1.5 py-0.5 rounded cursor-pointer hover:brightness-125 transition-all focus-visible:ring-1 focus-visible:ring-purple-500"
              style={{ backgroundColor: theme === 'light' ? '#f1f5f9' : 'rgba(139,92,246,0.2)', color: theme === 'light' ? '#475569' : '#c4b5fd' }}
              onClick={(e) => { e.stopPropagation(); toggleVpcGroupTable(groupKey); toggleVpcGroup(groupKey); }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); toggleVpcGroupTable(groupKey); toggleVpcGroup(groupKey); } }}
              aria-label="Expand VPCs into individual nodes"
            >
              Expand
            </div>
            <div
              role="button"
              tabIndex={0}
              className="text-[8px] px-1.5 py-0.5 rounded cursor-pointer hover:brightness-125 transition-all focus-visible:ring-1 focus-visible:ring-purple-500"
              style={{ backgroundColor: theme === 'light' ? '#f1f5f9' : 'rgba(139,92,246,0.2)', color: theme === 'light' ? '#475569' : '#c4b5fd' }}
              onClick={(e) => { e.stopPropagation(); toggleVpcGroupTable(groupKey); }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); toggleVpcGroupTable(groupKey); } }}
              aria-label="Collapse VPC list"
            >
              Collapse
            </div>
          </div>
        </div>

        {/* Same drag guard as the header: the table body is read-only, so there is no
            action to expose to the keyboard. */}
        {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
        <div
          className={`overflow-y-auto selectable-text${isLocked ? ' nodrag nopan' : ''}`}
          // Cap + scroll from the SAME constant the layout engine reserves height
          // with (utils/constants → vpcTableHeight), so the node box and the
          // rendered table can never disagree and leave an empty gap.
          style={{ maxHeight: VPC_TABLE_MAX_BODY_HEIGHT }}
          onMouseDown={isLocked ? (e) => e.stopPropagation() : undefined}
          onPointerDown={isLocked ? (e) => e.stopPropagation() : undefined}
        >
          {/* table-layout: fixed + explicit column widths keep every row a
              SINGLE line (long VPC names truncate rather than wrap), so the
              rendered row height matches VPC_TABLE_ROW_HEIGHT and the region
              container reserves exactly enough — no overflow past its border. */}
          <table className="text-[9px] border-collapse" style={{ tableLayout: 'fixed', width: VPC_TABLE_WIDTH }}>
            <colgroup>
              <col style={{ width: 150 }} />
              <col style={{ width: 90 }} />
              <col style={{ width: 60 }} />
            </colgroup>
            <thead>
              <tr style={{ backgroundColor: theme === 'light' ? '#f8fafc' : 'rgba(139,92,246,0.1)' }}>
                <th className={`text-left px-2 py-1 font-semibold ${theme === 'light' ? 'text-slate-600' : 'text-slate-400'}`}>Name</th>
                <th className={`text-left px-2 py-1 font-semibold ${theme === 'light' ? 'text-slate-600' : 'text-slate-400'}`}>CIDR</th>
                <th className={`text-left px-2 py-1 font-semibold ${theme === 'light' ? 'text-slate-600' : 'text-slate-400'}`}>State</th>
              </tr>
            </thead>
            <tbody>
              {vpcChildren.map((vpc) => (
                <tr
                  key={vpc.vpcId}
                  className={`${theme === 'light' ? 'hover:bg-slate-50' : 'hover:bg-white/5'} transition-colors`}
                  style={{ borderTop: `1px solid ${theme === 'light' ? '#f1f5f9' : 'rgba(255,255,255,0.05)'}` }}
                >
                  <td className={`px-2 py-1 ${theme === 'light' ? 'text-slate-700' : 'text-slate-300'}`}>
                    <div className="flex items-center gap-1 min-w-0">
                      <span className="truncate" title={vpc.name}>{vpc.name}</span>
                      {vpc.crossAccount && (
                        <span className="shrink-0 text-[7px] px-1 rounded bg-amber-500/20 text-amber-400">X</span>
                      )}
                    </div>
                  </td>
                  <td className={`px-2 py-1 font-mono whitespace-nowrap truncate ${theme === 'light' ? 'text-slate-600' : 'text-slate-400'}`} title={vpc.cidr}>{vpc.cidr}</td>
                  <td className="px-2 py-1 whitespace-nowrap">
                    <span className={`inline-block w-1.5 h-1.5 rounded-full mr-1 ${vpc.state === 'available' ? 'bg-green-400' : 'bg-yellow-400'}`} />
                    <span className={theme === 'light' ? 'text-slate-600' : 'text-slate-400'}>{vpc.state}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  if (isOrphan) {
    // Stacked-card look: front card shows "N Isolated VPCs / Click to expand"; ghost borders
    // above-left hint at the other orphans. Clicking opens the table view of all orphans.
    const extra = Math.max(0, vpcChildren.length - 1);
    const OFFSET = 6;
    const ghosts = Math.min(extra, 2); // cap ghost layers so stack doesn't grow unbounded
    const pad = OFFSET * ghosts;
    return (
      <div
        className="relative"
        style={{
          paddingTop: pad,
          paddingLeft: pad,
          opacity: dimOpacity ?? 1,
        }}
      >
        {Array.from({ length: ghosts }).map((_, i) => {
          const step = ghosts - i;
          const t = pad - step * OFFSET;
          const l = pad - step * OFFSET;
          return (
            <div
              key={i}
              aria-hidden
              className="absolute rounded-lg pointer-events-none"
              style={{
                top: t,
                left: l,
                right: step * OFFSET,
                bottom: step * OFFSET,
                borderWidth: 2,
                borderStyle: 'solid',
                borderColor: border,
                opacity: 0.55 + i * 0.2,
              }}
            />
          );
        })}
        <div
          role="button"
          tabIndex={0}
          className="relative flex flex-col items-center rounded-lg px-4 py-3 cursor-pointer hover:brightness-110 transition-all focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:ring-offset-2"
          style={{
            borderWidth: 2,
            borderStyle: 'solid',
            borderColor: border,
            backgroundColor: bg,
            minWidth: 160,
            boxShadow: baseShadow,
          }}
          onClick={() => toggleVpcGroupTable(groupKey)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleVpcGroupTable(groupKey); } }}
          aria-expanded={false}
          aria-label={`Expand list of ${d.childCount} isolated VPCs`}
        >
          <Handle type="target" position={Position.Left} style={{ background: border, width: 6, height: 6 }} />
          <div style={{ color: border }}>
            <VpcIcon />
          </div>
          <div
            className="mt-1.5 inline-block rounded-sm px-1 py-0 text-[8px] font-bold tracking-wide text-white"
            style={{ backgroundColor: COLORS.severity.warning }}
          >
            {d.childCount} Isolated VPCs
          </div>
          <span className={`text-[8px] mt-1 ${theme === 'light' ? 'text-slate-500' : 'text-slate-400'}`}>
            Click to expand
          </span>
        </div>
      </div>
    );
  }

  return (
    <div
      role="button"
      tabIndex={0}
      className="flex flex-col items-center rounded-lg px-4 py-3 cursor-pointer hover:brightness-110 transition-all focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:ring-offset-2"
      style={{
        borderWidth: 2,
        borderStyle: 'solid',
        borderColor: theme === 'light' ? '#e2e5ea' : border,
        borderLeftWidth: theme === 'light' ? 3 : 2,
        borderLeftColor: border,
        backgroundColor: bg,
        minWidth: 90,
        boxShadow: baseShadow,
        opacity: dimOpacity ?? 1,
      }}
      onClick={() => toggleVpcGroupTable(groupKey)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleVpcGroupTable(groupKey); } }}
      aria-expanded={false}
      aria-label={`Expand list of ${d.childCount} VPCs`}
    >
      <Handle type="target" position={Position.Left} style={{ background: border }} />

      <div style={{ color: border }}>
        <VpcIcon />
      </div>

      <div
        className="mt-1.5 rounded-full px-2.5 py-0.5 text-[9px] font-bold text-white"
        style={{ backgroundColor: border }}
      >
        {d.label}
      </div>

      <span className={`text-[8px] mt-1 ${theme === 'light' ? 'text-slate-500' : 'text-slate-400'}`}>
        Click to expand
      </span>
    </div>
  );
}
