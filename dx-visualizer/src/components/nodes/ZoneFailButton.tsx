import { useCallback } from 'react';
import { useTopologyStore } from '../../store/topology-store';

const CONTAINER_CATEGORIES = new Set(['dxLocation', 'region', 'customerSite', 'awsCloud']);

interface ZoneFailButtonProps {
  zoneId: string;
  zoneType: string;
  zoneKey: string | undefined;
  failed: boolean;
}

export function ZoneFailButton({ zoneId, zoneType, zoneKey, failed }: ZoneFailButtonProps) {
  const currentNodes = useTopologyStore((s) => s.currentNodes);
  const currentEdges = useTopologyStore((s) => s.currentEdges);
  const failZone = useTopologyStore((s) => s.failZone);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!zoneKey) return;

      const childNodeIds: string[] = [];

      if (zoneType === 'dxLocation' || zoneType === 'customerSite') {
        for (const n of currentNodes) {
          if (CONTAINER_CATEGORIES.has(n.data.category)) continue;
          const nLoc = (n.data.details as Record<string, string>)?.locationCode;
          if (nLoc === zoneKey) childNodeIds.push(n.id);
        }
      } else if (zoneType === 'region') {
        const regionChildCategories = new Set(['tgw', 'tgwGroup', 'isolatedTgwGroup', 'vgw', 'vpc', 'vpcGroup']);
        for (const n of currentNodes) {
          if (!regionChildCategories.has(n.data.category)) continue;
          const nRegion = (n.data.details as Record<string, string>)?.region;
          if (nRegion === zoneKey || n.id.includes(zoneKey)) childNodeIds.push(n.id);
        }
      }

      if (childNodeIds.length === 0) return;

      const nodeSet = new Set(childNodeIds);
      const childEdgeIds: string[] = [];
      for (const e of currentEdges) {
        if (!e.data?.isRecommended && (nodeSet.has(e.source) || nodeSet.has(e.target))) {
          childEdgeIds.push(e.id);
        }
      }

      failZone([zoneId, ...childNodeIds], childEdgeIds);
    },
    [zoneId, zoneType, zoneKey, currentNodes, currentEdges, failZone]
  );

  return (
    <button
      onClick={handleClick}
      className="absolute top-0.5 right-1 pointer-events-auto cursor-pointer rounded p-0.5 transition-colors"
      style={{
        zIndex: 10,
        color: failed ? '#fca5a5' : '#ef4444',
        backgroundColor: failed ? 'rgba(239,68,68,0.2)' : 'rgba(239,68,68,0.1)',
      }}
      title={failed ? 'Restore zone' : 'Fail zone'}
    >
      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
      </svg>
    </button>
  );
}
