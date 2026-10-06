// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useTopology } from '../useTopology';
import { useTopologyStore } from '../../store/topology-store';
import { makeTaggedTopology } from '../../engine/__tests__/fixtures/tagged-topology';
import type { DxNode } from '../../types/topology';

beforeEach(() => {
  useTopologyStore.setState(useTopologyStore.getInitialState(), true);
  useTopologyStore.setState({ topologyData: makeTaggedTopology(), importedSnapshot: null, showVpn: true });
});
afterEach(cleanup);

const resourceIds = (nodes: DxNode[]) => nodes.map((n) => n.data.resourceId).filter(Boolean);

describe('tag filter view lifecycle', () => {
  it('rebuilds the view without changing the assessment or the source topology', () => {
    renderHook(() => useTopology());
    const original = useTopologyStore.getState();
    const count = original.currentNodes.length;
    act(() => useTopologyStore.getState().setTagFilters([{ key: 'Environment', value: 'prod' }]));
    const filtered = useTopologyStore.getState();
    expect(filtered.topologyData).toBe(original.topologyData);
    expect(filtered.assessment).toEqual(original.assessment);
    expect(filtered.currentNodes.length).toBeLessThan(count);
    expect(resourceIds(filtered.currentNodes)).toContain('vpc-prod');
    expect(resourceIds(filtered.currentNodes)).not.toContain('vpc-stage');

    act(() => useTopologyStore.getState().setTagFilters([]));
    expect(useTopologyStore.getState().currentNodes).toHaveLength(count);
    expect(useTopologyStore.getState().assessment).toEqual(original.assessment);
  });

  it('composes with the VPN layer while preserving the full assessment', () => {
    renderHook(() => useTopology());
    const assessment = useTopologyStore.getState().assessment;
    act(() => {
      useTopologyStore.getState().setTagFilters([{ key: 'Environment', value: 'prod' }]);
      useTopologyStore.getState().setShowVpn(false);
    });
    expect(resourceIds(useTopologyStore.getState().currentNodes)).not.toContain('vpn-backup');
    expect(useTopologyStore.getState().assessment).toEqual(assessment);
    expect(useTopologyStore.getState().topologyData?.vpnConnections).toHaveLength(1);
  });

  it('has no recommendations or edges when no resources match', () => {
    renderHook(() => useTopology());
    act(() => useTopologyStore.getState().setTagFilters([{ key: 'Environment', value: 'missing' }]));
    const state = useTopologyStore.getState();
    expect(state.currentEdges).toEqual([]);
    expect(state.recommendedNodes).toEqual([]);
    expect(state.recommendedEdges).toEqual([]);
    expect(resourceIds(state.currentNodes)).toEqual([]);
  });

  it('preserves filters across data refresh and clears them on scenario change or reset', () => {
    renderHook(() => useTopology());
    act(() => useTopologyStore.getState().setTagFilters([{ key: 'Environment', value: 'prod' }]));
    act(() => useTopologyStore.getState().setTopologyData(makeTaggedTopology()));
    expect(resourceIds(useTopologyStore.getState().currentNodes)).not.toContain('vpc-stage');
    act(() => useTopologyStore.getState().setMockScenario('maximum'));
    expect(useTopologyStore.getState().tagFilters).toEqual([]);
    act(() => useTopologyStore.getState().setTagFilters([{ key: 'Environment', value: 'prod' }]));
    act(() => useTopologyStore.getState().resetTopology());
    expect(useTopologyStore.getState().tagFilters).toEqual([]);
    expect(useTopologyStore.getState().topologyData).toBeNull();
  });

  it('does not leave recommendation edges pointing to filtered-out nodes', () => {
    renderHook(() => useTopology());
    act(() => useTopologyStore.getState().setTagFilters([{ key: 'Gateway', value: 'b' }]));
    const state = useTopologyStore.getState();
    const ids = new Set([...state.recommendedCurrentNodes, ...state.recommendedNodes].map((n) => n.id));
    expect(state.recommendedEdges.length).toBeGreaterThan(0);
    expect(state.recommendedEdges.every((e) => ids.has(e.source) && ids.has(e.target))).toBe(true);
    expect(resourceIds(state.recommendedCurrentNodes)).not.toContain('dxgw-a');
  });
});
