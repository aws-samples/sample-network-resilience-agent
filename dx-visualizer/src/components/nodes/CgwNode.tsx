import type { NodeProps } from '@xyflow/react';
import { Handle, Position } from '@xyflow/react';
import type { DxNodeData } from '../../types/topology';
import { BaseNode } from './BaseNode';
import { LiveStatusDot } from './LiveStatusDot';
import { VpnConnectionIcon } from './aws-icons';
import { useTopologyStore } from '../../store/topology-store';
import { useRedact } from '../../utils/redact';

export function CgwNode({ id, data }: NodeProps) {
  const d = data as DxNodeData;
  const r = useRedact();
  const showLiveStatus = useTopologyStore((s) => s.showLiveStatus);
  const vpnState = d.details?.state;

  return (
    <div className="relative">
      <BaseNode
        nodeId={id}
        label={d.label}
        subtitle="VPN Connection"
        icon={<VpnConnectionIcon />}
        isRecommended={d.isRecommended}
        borderColor="#8b5cf6"
        bgColor="#1e1033"
        badges={d.badges}
        handles={{ source: false, target: true }}
        extraLeftHandles={[{ id: 'left-source', type: 'source' }]}
      >
        {d.resourceId && (
          <span className="text-[9px] text-slate-500 font-tech">{r(d.resourceId)}</span>
        )}
        {d.details?.asn && (
          <span className="text-[9px] text-slate-400 font-tech">{r(`ASN: ${d.details.asn}`)}</span>
        )}
        {showLiveStatus && <LiveStatusDot state={vpnState} />}
      </BaseNode>
      {/* VPN Connection sits directly above its gateway — the on-prem tunnel
          drops in at 'top' and the tunnel to the gateway exits at 'bottom'.
          No left/right handles: BaseNode's defaults are disabled above. */}
      <Handle
        id="bottom"
        type="source"
        position={Position.Bottom}
        style={{ background: '#8b5cf6', width: 6, height: 6 }}
      />
      <Handle
        id="top"
        type="target"
        position={Position.Top}
        style={{ background: '#8b5cf6', width: 6, height: 6 }}
      />
    </div>
  );
}
