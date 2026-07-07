import type { NodeProps } from '@xyflow/react';
import { useReactFlow } from '@xyflow/react';
import type { DxNodeData } from '../../types/topology';
import { BaseNode } from './BaseNode';
import { CustomerGatewayIcon } from './aws-icons';
import { useTopologyStore } from '../../store/topology-store';
import { useRedact } from '../../utils/redact';

export function OnPremiseNode({ id, data }: NodeProps) {
  const d = data as DxNodeData;
  const r = useRedact();
  const { getNode } = useReactFlow();
  const theme = useTopologyStore((s) => s.theme);
  const isLocked = useTopologyStore((s) => s.isLocked);
  const isSimulating = useTopologyStore((s) => s.isSimulating);
  const addUserOnPremise = useTopologyStore((s) => s.addUserOnPremise);
  const removeUserOnPremise = useTopologyStore((s) => s.removeUserOnPremise);
  const hideOnPremise = useTopologyStore((s) => s.hideOnPremise);

  const isUserCreated = (d.details as Record<string, string> | undefined)?.userCreated === 'true';
  const canShowButtons = !d.isRecommended && !isLocked && !isSimulating;
  const light = theme === 'light';

  const handleAdd = () => {
    const parentId = getNode(id)?.parentId
      ?? (d.details as Record<string, string> | undefined)?.parentSiteId;
    if (!parentId) return;
    addUserOnPremise(parentId);
  };

  const handleRemove = () => {
    if (isUserCreated) removeUserOnPremise(id);
    else hideOnPremise(id);
  };

  const overlay = canShowButtons ? (
    <>
      <button
        type="button"
        title="Add another Customer Router in this zone"
        onClick={(e) => { e.stopPropagation(); handleAdd(); }}
        className="flex items-center justify-center rounded-full"
        style={{
          width: 16,
          height: 16,
          padding: 0,
          border: `1px solid ${light ? '#059669' : '#10b981'}`,
          background: light ? '#ffffff' : '#0f172a',
          color: light ? '#059669' : '#34d399',
          cursor: 'pointer',
        }}
      >
        <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <line x1="6" y1="2" x2="6" y2="10" />
          <line x1="2" y1="6" x2="10" y2="6" />
        </svg>
      </button>
      <button
        type="button"
        title="Remove this Customer Router"
        onClick={(e) => { e.stopPropagation(); handleRemove(); }}
        className="flex items-center justify-center rounded-full"
        style={{
          width: 16,
          height: 16,
          padding: 0,
          border: `1px solid ${light ? '#dc2626' : '#f87171'}`,
          background: light ? '#ffffff' : '#0f172a',
          color: light ? '#dc2626' : '#f87171',
          cursor: 'pointer',
        }}
      >
        <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <line x1="3" y1="3" x2="9" y2="9" />
          <line x1="9" y1="3" x2="3" y2="9" />
        </svg>
      </button>
    </>
  ) : null;

  return (
    <BaseNode
      nodeId={id}
      label={d.label}
      subtitle="Customer Router"
      icon={<CustomerGatewayIcon />}
      isRecommended={d.isRecommended}
      borderColor="#8b5cf6"
      bgColor="#1e1033"
      badges={d.badges}
      handles={{ source: true, target: true }}
      extraLeftHandles={[{ id: 'left-source', type: 'source' }]}
      topRightOverlay={overlay}
    >
      {d.resourceId && (
        <span className="text-[9px] text-slate-500 font-tech">{r(d.resourceId)}</span>
      )}
    </BaseNode>
  );
}
