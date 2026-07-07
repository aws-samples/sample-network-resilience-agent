import { useTopologyStore } from '../store/topology-store';

/** Returns true when light mode is active */
export function useIsLight() {
  return useTopologyStore((s) => s.theme) === 'light';
}
