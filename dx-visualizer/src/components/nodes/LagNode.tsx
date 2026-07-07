import type { NodeProps } from '@xyflow/react';
import type { DxNodeData } from '../../types/topology';
import { BaseNode } from './BaseNode';
import { LiveStatusDot } from './LiveStatusDot';
import { LagIcon } from './aws-icons';
import { useTopologyStore } from '../../store/topology-store';
import { useRedact } from '../../utils/redact';

export function LagNode({ id, data }: NodeProps) {
  const d = data as DxNodeData;
  const r = useRedact();
  const showLiveStatus = useTopologyStore((s) => s.showLiveStatus);
  const state = d.details?.state;
  const minimumLinks = d.details?.minimumLinks;
  const numberOfConnections = d.details?.numberOfConnections;
  const bandwidth = d.details?.bandwidth;

  return (
    <BaseNode
      nodeId={id}
      label={d.label}
      subtitle="Link Aggregation Group"
      icon={<LagIcon />}
      isRecommended={d.isRecommended}
      accent={d.isInferred ? 'inferred' : 'default'}
      bgColor="#1e1033"
      badges={d.badges}
    >
      {d.resourceId && (
        <span className="text-[9px] text-slate-500 font-tech">{r(d.resourceId)}</span>
      )}
      {bandwidth && (
        <span className="text-[9px] text-slate-400">
          {numberOfConnections} &times; {bandwidth}
        </span>
      )}
      {minimumLinks != null && (
        <span className="text-[9px] text-slate-400 font-medium">
          Min links: {minimumLinks}
        </span>
      )}
      {showLiveStatus && <LiveStatusDot state={state} />}
    </BaseNode>
  );
}
