import type { NodeProps } from '@xyflow/react';
import type { DxNodeData } from '../../types/topology';
import { BaseNode } from './BaseNode';

const PublicResourcesIcon = ({ size = 28 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 48 48" fill="currentColor">
    <circle cx="24" cy="24" r="18" fill="none" stroke="currentColor" strokeWidth="2.5" />
    <path d="M24 6C24 6 36 14 36 24C36 34 24 42 24 42" fill="none" stroke="currentColor" strokeWidth="2" />
    <path d="M24 6C24 6 12 14 12 24C12 34 24 42 24 42" fill="none" stroke="currentColor" strokeWidth="2" />
    <line x1="7" y1="18" x2="41" y2="18" stroke="currentColor" strokeWidth="2" />
    <line x1="7" y1="30" x2="41" y2="30" stroke="currentColor" strokeWidth="2" />
  </svg>
);

export function PublicResourcesNode({ id, data }: NodeProps) {
  const d = data as DxNodeData;
  const serviceEntries = d.details?.services?.split(' | ') || [];
  return (
    <BaseNode
      nodeId={id}
      label={d.label}
      subtitle="AWS Public Endpoints"
      icon={<PublicResourcesIcon />}
      borderColor="#8b5cf6"
      bgColor="#1e1033"
      badges={d.badges}
    >
      {d.details?.vifCount && (
        <span className="text-[9px] text-slate-400 font-tech block">
          {d.details.vifCount} Public VIFs connected
        </span>
      )}
      {serviceEntries.length > 0 && (
        <div className="flex flex-col gap-[1px]">
          {serviceEntries.map((entry, i) => (
            <span key={i} className="text-[9px] text-violet-400/80 font-tech block max-w-full overflow-hidden text-ellipsis whitespace-nowrap" title={entry}>
              {entry}
            </span>
          ))}
        </div>
      )}
    </BaseNode>
  );
}
