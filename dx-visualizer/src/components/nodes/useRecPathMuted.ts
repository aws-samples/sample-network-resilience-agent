import { useTopologyStore, isRecPathActive } from '../../store/topology-store';

/**
 * True when a tier option is selected and its recommended path is on the canvas,
 * and this node is NOT on that path — so it should step back, the same way
 * BaseNode dims an off-path node. The group and zone node components don't go
 * through BaseNode, so they call this directly to stay consistent with it.
 */
export function useRecPathMuted(id: string | undefined): boolean {
  return useTopologyStore((s) => id != null && isRecPathActive(s) && !s.recPathNodeIds.has(id));
}
