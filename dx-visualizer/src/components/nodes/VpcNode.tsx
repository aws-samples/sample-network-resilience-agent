import type { NodeProps } from '@xyflow/react';
import type { DxNodeData } from '../../types/topology';
import { BaseNode } from './BaseNode';
import { LiveStatusDot } from './LiveStatusDot';
import { VpcIcon } from './aws-icons';
import { useTopologyStore } from '../../store/topology-store';
import { useRedact } from '../../utils/redact';
import { VpcRoutePanel } from './VpcRoutePanel';
import { VpcPeerPanel } from './VpcPeerPanel';

export function VpcNode({ id, data }: NodeProps) {
  const d = data as DxNodeData;
  const r = useRedact();
  const showLiveStatus = useTopologyStore((s) => s.showLiveStatus);
  const theme = useTopologyStore((s) => s.theme);
  const isExpanded = useTopologyStore((s) => s.expandedVpcRoutePanels.has(d.resourceId ?? ''));
  const togglePanel = useTopologyStore((s) => s.toggleVpcRoutePanel);
  const routeTables = useTopologyStore((s) => s.topologyData?.vpcRouteTables.get(d.resourceId ?? ''));
  const peers = d.vpcPeers;
  const isPeersExpanded = useTopologyStore((s) => s.expandedVpcPeerPanels.has(d.resourceId ?? ''));
  const togglePeersPanel = useTopologyStore((s) => s.toggleVpcPeerPanel);
  const isCrossAccount = d.details?.crossAccount === 'true';
  const state = d.details?.state;
  const accountColor = theme === 'light' ? '#d97706' : '#fbbf24';
  return (
    <BaseNode
      nodeId={id}
      label={d.label}
      subtitle="Virtual Private Cloud"
      icon={<VpcIcon />}
      isRecommended={d.isRecommended}
      accent={isCrossAccount ? 'crossAccount' : 'default'}
      bgColor="#1e1033"
      badges={d.badges}
      handles={{ source: false, target: true }}
      extraRightHandles={d.hasPeeringHandle ? [
        { id: 'peering-right', type: 'source', background: '#8b5cf6' },
        { id: 'peering-right-target', type: 'target', background: '#8b5cf6' },
      ] : undefined}
    >
      {d.resourceId && (
        <span className="text-[9px] text-slate-500 font-tech">{r(d.resourceId)}</span>
      )}
      {d.details?.cidr && (
        <span className="text-[9px] text-slate-400 font-tech">{r(d.details.cidr)}</span>
      )}
      {isCrossAccount && d.details?.ownerAccount && (
        <span className="text-[9px] font-tech whitespace-nowrap" style={{ color: accountColor }}>{r(`Account: ${d.details.ownerAccount}`)}</span>
      )}
      {showLiveStatus && <LiveStatusDot state={state} />}
      {peers && peers.length > 1 && (
        <button
          onClick={(e) => { e.stopPropagation(); togglePeersPanel(d.resourceId!); }}
          onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
          onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
          className="text-[8px] text-violet-400 hover:text-violet-300 mt-0.5 flex items-center gap-0.5 cursor-pointer self-end nodrag"
          title="List VPC peering connections"
        >
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="3.5" cy="8" r="2" />
            <circle cx="12.5" cy="4" r="2" />
            <circle cx="12.5" cy="12" r="2" />
            <path d="M5.4 7 10.6 4.6M5.4 9l5.2 2.4" />
          </svg>
          Peers ({peers.length}) {isPeersExpanded ? '▴' : '▾'}
        </button>
      )}
      {isPeersExpanded && peers && peers.length > 1 && (
        <VpcPeerPanel peers={peers} onClose={() => togglePeersPanel(d.resourceId!)} nodeId={id} />
      )}
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
        <VpcRoutePanel routeTables={routeTables} onClose={() => togglePanel(d.resourceId!)} nodeId={id} />
      )}
    </BaseNode>
  );
}
