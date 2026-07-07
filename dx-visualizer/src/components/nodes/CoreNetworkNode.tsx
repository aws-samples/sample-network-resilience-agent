import type { NodeProps } from '@xyflow/react';
import type { DxNodeData } from '../../types/topology';
import { BaseNode } from './BaseNode';
import { LiveStatusDot } from './LiveStatusDot';
import { CloudWanIcon } from './aws-icons';
import { useTopologyStore } from '../../store/topology-store';
import { useRedact } from '../../utils/redact';
import { CloudWanRoutePanel } from './CloudWanRoutePanel';

export function CoreNetworkNode({ id, data }: NodeProps) {
  const d = data as DxNodeData;
  const r = useRedact();
  const showLiveStatus = useTopologyStore((s) => s.showLiveStatus);
  const isExpanded = useTopologyStore((s) => s.expandedCloudWanRoutePanels.has(d.resourceId ?? ''));
  const togglePanel = useTopologyStore((s) => s.toggleCloudWanRoutePanel);
  const segmentRoutes = useTopologyStore((s) => s.topologyData?.cloudWanRoutes.get(d.resourceId ?? ''));
  const state = d.details?.state;
  return (
    <BaseNode
      nodeId={id}
      label={d.label}
      subtitle="Cloud WAN Core Network"
      icon={<CloudWanIcon />}
      isRecommended={d.isRecommended}
      borderColor="#8B5CF6"
      bgColor="#1e1033"
      badges={d.badges}
      targetHandleIds={d.targetHandleIds}
    >
      {d.resourceId && (
        <span className="text-[9px] text-slate-500 font-tech">{r(d.resourceId)}</span>
      )}
      {d.details?.segments && (
        <span className="text-[9px] text-violet-400 font-tech">Segments: {d.details.segments}</span>
      )}
      {d.details?.edgeLocations && (
        <span className="text-[9px] text-slate-400 font-tech">Edges: {d.details.edgeLocations}</span>
      )}
      {showLiveStatus && <LiveStatusDot state={state} upPattern={/available/i} />}
      {segmentRoutes && segmentRoutes.length > 0 && (
        <button
          onClick={(e) => { e.stopPropagation(); togglePanel(d.resourceId!); }}
          onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
          onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
          className="text-[8px] text-violet-400 hover:text-violet-300 mt-0.5 flex items-center gap-0.5 cursor-pointer self-end nodrag"
          title="View Cloud WAN routes"
        >
          <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
            <path d="M0 2a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V2zm2 0v3h5V1H2a1 1 0 0 0-1 1zm6-1v4h7V2a1 1 0 0 0-1-1H8zM1 6v4h6V6H1zm7 0v4h7V6H8zM1 11v3a1 1 0 0 0 1 1h5v-4H1zm7 4h6a1 1 0 0 0 1-1v-3H8v4z"/>
          </svg>
          Routes {isExpanded ? '▴' : '▾'}
        </button>
      )}
      {isExpanded && segmentRoutes && (
        <CloudWanRoutePanel segmentRoutes={segmentRoutes} onClose={() => togglePanel(d.resourceId!)} nodeId={id} />
      )}
    </BaseNode>
  );
}
