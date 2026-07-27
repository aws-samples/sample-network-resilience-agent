import type { NodeProps } from '@xyflow/react';
import type { DxNodeData } from '../../types/topology';
import { BaseNode } from './BaseNode';
import { LiveStatusDot } from './LiveStatusDot';
import { FirewallIcon } from './aws-icons';
import { useTopologyStore } from '../../store/topology-store';
import { useRedact } from '../../utils/redact';

export function TgwFirewallNode({ id, data }: NodeProps) {
  const d = data as DxNodeData;
  const r = useRedact();
  const showLiveStatus = useTopologyStore((s) => s.showLiveStatus);
  const isCrossAccount = d.details?.crossAccount === 'true';
  return (
    <BaseNode
      nodeId={id}
      label={d.label}
      subtitle="Network Firewall (Native Attachment)"
      icon={<FirewallIcon />}
      isRecommended={d.isRecommended}
      accent={isCrossAccount ? 'crossAccount' : 'default'}
      bgColor="#1e1033"
      badges={d.badges}
    >
      {d.resourceId && (
        <span className="text-[9px] text-slate-500 font-tech">{r(d.resourceId)}</span>
      )}
      {/* Color the attachment state green/red via the shared status dot, matching
          every other gateway node. Gated on live-status mode like its siblings. */}
      {showLiveStatus && <LiveStatusDot state={d.details?.state} />}
    </BaseNode>
  );
}
