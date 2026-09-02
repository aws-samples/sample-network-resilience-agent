import type { NodeProps } from '@xyflow/react';
import type { DxNodeData } from '../../types/topology';
import { BaseNode } from './BaseNode';
import { LiveStatusDot } from './LiveStatusDot';
import { CustomerGatewayIcon } from './aws-icons';
import { useTopologyStore } from '../../store/topology-store';

export function DxPartnerDeviceNode({ id, data }: NodeProps) {
  const d = data as DxNodeData;
  const showLiveStatus = useTopologyStore((s) => s.showLiveStatus);
  const state = d.details?.state;
  return (
    <BaseNode
      nodeId={id}
      label={d.label}
      subtitle="Customer Gateway"
      icon={<CustomerGatewayIcon />}
      isRecommended={d.isRecommended}
      accent={d.isInferred ? 'inferred' : 'default'}
      bgColor="#1e1033"
      badges={d.badges}
      // Customer-link anchors, same as the on-prem routers. These cards share one
      // column, so a link between two of them drops vertically rather than
      // looping right→left around both. Both render after BaseNode's default
      // left/right pair, so the unnamed DX Connection edge to the AWS device
      // still resolves to the right-hand handle.
      extraTopHandles={[{ id: 'top', type: 'target' }]}
      extraBottomHandles={[{ id: 'bottom', type: 'source' }]}
    >
      {showLiveStatus && <LiveStatusDot state={state} />}
    </BaseNode>
  );
}
