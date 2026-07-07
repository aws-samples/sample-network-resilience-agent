import type { NodeProps } from '@xyflow/react';
import { Handle, Position } from '@xyflow/react';
import type { DxNodeData } from '../../types/topology';
import { BaseNode } from './BaseNode';
import { LiveStatusDot } from './LiveStatusDot';
import { VpnGatewayIcon } from './aws-icons';
import { useTopologyStore } from '../../store/topology-store';
import { useRedact } from '../../utils/redact';

export function VgwNode({ id, data }: NodeProps) {
  const d = data as DxNodeData;
  const r = useRedact();
  const showLiveStatus = useTopologyStore((s) => s.showLiveStatus);
  const theme = useTopologyStore((s) => s.theme);
  const isCrossAccount = d.details?.crossAccount === 'true';
  const state = d.details?.state;
  const accountColor = theme === 'light' ? '#d97706' : '#fbbf24';
  return (
    <div className="relative">
    <BaseNode
      nodeId={id}
      label={d.label}
      subtitle="Virtual Private Gateway"
      icon={<VpnGatewayIcon />}
      isRecommended={d.isRecommended}
      accent={isCrossAccount ? 'crossAccount' : 'default'}
      bgColor="#1e1033"
      badges={d.badges}
      targetHandleIds={d.targetHandleIds}
    >
      {d.resourceId && d.resourceId !== d.label && (
        <span className="text-[9px] text-slate-500 font-tech">{r(d.resourceId)}</span>
      )}
      {d.details?.asn && (
        <span className="text-[9px] text-slate-400 font-tech">{r(`ASN: ${d.details.asn}`)}</span>
      )}
      {!d.resourceId && d.details?.dxGatewayId && (
        <span className="text-[9px] text-slate-400 font-tech" title="Parent Direct Connect Gateway">DXGW: {r(d.details.dxGatewayId)}</span>
      )}
      {!d.resourceId && d.details?.associationId && (
        <span className="text-[9px] text-slate-500 font-tech" title="Association ID">Assoc: {r(d.details.associationId)}</span>
      )}
      {isCrossAccount && d.details?.ownerAccount && (
        <span className="text-[9px] font-tech whitespace-nowrap" style={{ color: accountColor }}>{r(`Account: ${d.details.ownerAccount}`)}</span>
      )}
      {showLiveStatus && <LiveStatusDot state={state} upPattern={/^(available|associated)$/i} />}
    </BaseNode>
    {/* Top handle — only rendered when a VPN Connection targets this VGW,
        otherwise an unconnected dot would show on top of the node. MUST
        render after BaseNode so BaseNode's default left target handle is
        the first match for edges that don't specify a targetHandle; otherwise
        ReactFlow picks this top handle and DX-GW → VGW edges route top-down. */}
    {d.hasTopHandle && (
      <Handle id="top" type="target" position={Position.Top} style={{ background: isCrossAccount ? (theme === 'light' ? '#d97706' : '#fbbf24') : '#8b5cf6', width: 6, height: 6 }} />
    )}
    </div>
  );
}
