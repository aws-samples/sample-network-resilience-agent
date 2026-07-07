import type { NodeProps } from '@xyflow/react';
import { Handle, Position } from '@xyflow/react';
import type { DxNodeData } from '../../types/topology';
import { BaseNode } from './BaseNode';
import { LiveStatusDot } from './LiveStatusDot';
import { TransitGatewayIcon } from './aws-icons';
import { useTopologyStore } from '../../store/topology-store';
import { useRedact } from '../../utils/redact';
import { TgwRoutePanel } from './TgwRoutePanel';

export function TgwNode({ id, data }: NodeProps) {
  const d = data as DxNodeData;
  const r = useRedact();
  const showLiveStatus = useTopologyStore((s) => s.showLiveStatus);
  const theme = useTopologyStore((s) => s.theme);
  const isExpanded = useTopologyStore((s) => s.expandedTgwRoutePanels.has(d.resourceId ?? ''));
  const togglePanel = useTopologyStore((s) => s.toggleTgwRoutePanel);
  const routeTables = useTopologyStore((s) => s.topologyData?.tgwRouteTables.get(d.resourceId ?? ''));
  const isCrossAccount = d.details?.crossAccount === 'true';
  const state = d.details?.state;
  const accountColor = theme === 'light' ? '#d97706' : '#fbbf24';

  return (
    <div className="relative">
    <BaseNode
      nodeId={id}
      label={d.label}
      subtitle="Transit Gateway"
      icon={<TransitGatewayIcon />}
      isRecommended={d.isRecommended}
      accent={isCrossAccount ? 'crossAccount' : 'default'}
      bgColor="#1e1033"
      badges={d.badges}
      targetHandleIds={d.targetHandleIds}
      // Gated on hasPeeringHandle: React Flow picks a left source handle over
      // the default Right for unqualified outbound edges (e.g. TGW→VPC), so
      // only render these when an edge actually targets them.
      extraLeftHandles={d.hasPeeringHandle ? [
        { id: 'peering-left', type: 'source', background: '#8b5cf6' },
        { id: 'peering-left-target', type: 'target', background: '#8b5cf6' },
      ] : undefined}
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
      {routeTables && routeTables.length > 0 && (
        <button
          onClick={(e) => { e.stopPropagation(); togglePanel(d.resourceId!); }}
          onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
          onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
          className="text-[8px] text-violet-400 hover:text-violet-300 mt-0.5 flex items-center gap-0.5 cursor-pointer self-end nodrag"
          title="View route tables"
        >
          <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
            <path d="M0 2a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V2zm2 0v3h5V1H2a1 1 0 0 0-1 1zm6-1v4h7V2a1 1 0 0 0-1-1H8zM1 6v4h6V6H1zm7 0v4h7V6H8zM1 11v3a1 1 0 0 0 1 1h5v-4H1zm7 4h6a1 1 0 0 0 1-1v-3H8v4z"/>
          </svg>
          Routes {isExpanded ? '▴' : '▾'}
        </button>
      )}
      {isExpanded && routeTables && (
        <TgwRoutePanel routeTables={routeTables} onClose={() => togglePanel(d.resourceId!)} nodeId={id} />
      )}
    </BaseNode>
    {/* Top handle — only rendered when a VPN Connection targets this TGW,
        otherwise an unconnected dot would show on top of the node. MUST
        render after BaseNode so BaseNode's default left target handle is
        the first match for edges that don't specify a targetHandle; otherwise
        ReactFlow picks this top handle and DX-GW → TGW edges route top-down. */}
    {d.hasTopHandle && (
      <Handle id="top" type="target" position={Position.Top} style={{ background: isCrossAccount ? accountColor : '#8b5cf6', width: 6, height: 6 }} />
    )}
    </div>
  );
}
