import { Handle, Position } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import type { DxNodeData } from '../../types/topology';
import { COLORS } from '../../utils/colors';
import { useTopologyStore } from '../../store/topology-store';
import { TransitGatewayIcon } from './aws-icons';

export function TgwGroupNode({ data, id }: NodeProps) {
  const d = data as DxNodeData;
  const toggleTgwGroup = useTopologyStore((s) => s.toggleTgwGroup);
  const theme = useTopologyStore((s) => s.theme);
  const hoveredNodeId = useTopologyStore((s) => s.hoveredNodeId);
  const highlightedNodeIds = useTopologyStore((s) => s.highlightedNodeIds);
  const hasHoverActive = hoveredNodeId != null;
  const isOnHoverPath = hasHoverActive && highlightedNodeIds.has(id);
  const isDimmed = hasHoverActive && !isOnHoverPath;

  // Use the node id directly as the toggle key (e.g. "tgwgroup-ap-southeast-1-dxgw-001")
  const groupKey = id;
  const bg = theme === 'light' ? COLORS.light.nodeBg : '#1e1033';
  const border = theme === 'light' ? COLORS.light.border : COLORS.existing.border;
  const baseShadow = theme === 'light' ? COLORS.light.nodeShadow : '0 1px 3px rgba(0,0,0,0.3)';

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
        opacity: isDimmed ? 0.25 : 1,
      }}
      onClick={() => toggleTgwGroup(groupKey)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleTgwGroup(groupKey); } }}
      aria-expanded={false}
      aria-label={`Expand group of ${d.childCount} Transit Gateways`}
    >
      <Handle type="target" position={Position.Left} style={{ background: border }} />
      <Handle type="source" position={Position.Right} style={{ background: border }} />

      <div style={{ color: border }}>
        <TransitGatewayIcon />
      </div>

      <div
        className="mt-1.5 rounded-full px-2.5 py-0.5 text-[9px] font-bold text-white"
        style={{ backgroundColor: border }}
      >
        {d.childCount} TGWs
      </div>

      <span className={`text-[8px] mt-1 ${theme === 'light' ? 'text-slate-500' : 'text-slate-400'}`}>
        Click to expand
      </span>
    </div>
  );
}
