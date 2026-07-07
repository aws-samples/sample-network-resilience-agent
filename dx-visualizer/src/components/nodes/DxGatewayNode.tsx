import type { NodeProps } from '@xyflow/react';
import type { DxNodeData } from '../../types/topology';
import { BaseNode } from './BaseNode';
import { LiveStatusDot } from './LiveStatusDot';
import { DxGatewayIcon } from './aws-icons';
import { useTopologyStore } from '../../store/topology-store';
import { useRedact } from '../../utils/redact';
import { COLORS } from '../../utils/colors';

export function DxGatewayNode({ id, data }: NodeProps) {
  const d = data as DxNodeData;
  const r = useRedact();
  const showLiveStatus = useTopologyStore((s) => s.showLiveStatus);
  const state = d.details?.state;
  return (
    <BaseNode
      nodeId={id}
      label={d.label}
      subtitle="Direct Connect Gateway"
      icon={<DxGatewayIcon />}
      isRecommended={d.isRecommended}
      borderColor="#7c3aed"
      bgColor="#1e1033"
      badges={d.badges}
    >
      {d.isOrphan && (
        <span
          className="inline-block rounded-sm px-1 py-0 text-[8px] font-bold uppercase tracking-wide text-white"
          style={{ backgroundColor: COLORS.severity.warning }}
        >
          Unattached
        </span>
      )}
      {d.resourceId && (
        <span
          className="text-[9px] text-slate-500 font-tech block max-w-full overflow-hidden text-ellipsis whitespace-nowrap"
          title={r(d.resourceId)}
        >
          {r(d.resourceId)}
        </span>
      )}
      {d.details?.asn && (
        <span className="text-[9px] text-slate-400 font-tech">{r(`ASN: ${d.details.asn}`)}</span>
      )}
      {showLiveStatus && <LiveStatusDot state={state} />}
    </BaseNode>
  );
}
