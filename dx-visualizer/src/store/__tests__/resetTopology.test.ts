// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useTopologyStore } from '../topology-store';
import type { TopologyData } from '../../types/topology';
import type { DxNode, DxEdge } from '../../types/topology';
import type { ImportedSnapshotInfo } from '../topology-store';

const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { store = {}; },
  };
})();

vi.stubGlobal('localStorage', localStorageMock);

// Minimal stand-in topology — resetTopology only cares that these fields go away.
function fakeTopology(): TopologyData {
  return {
    connections: [],
    virtualInterfaces: [],
    dxGateways: [],
    vpnConnections: [],
    vpnGateways: [],
    customerGateways: [],
    transitGateways: [],
    vpcs: [],
    homeAccountId: '123456789012',
    errors: [],
  } as unknown as TopologyData;
}

const node = (id: string): DxNode => ({ id, type: 'onPremise', position: { x: 0, y: 0 }, data: { label: id, category: 'onPremise' } });
const edge = (id: string): DxEdge => ({ id, source: 'a', target: 'b' });

function seedLoadedGraph() {
  useTopologyStore.setState({
    topologyData: fakeTopology(),
    currentNodes: [node('n1')],
    currentEdges: [edge('e1')],
    recommendedNodes: [node('r1')],
    recommendedEdges: [edge('re1')],
    recommendedCurrentNodes: [node('rc1')],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assessment: {} as any,
    homeAccountName: 'NetworkHub-Prod',
    error: 'stale error',
    isLoading: true,
  });
}

describe('resetTopology', () => {
  beforeEach(() => {
    localStorageMock.clear();
    useTopologyStore.setState({
      importedSnapshot: null,
      topologyData: null,
      currentNodes: [],
      currentEdges: [],
      recommendedNodes: [],
      recommendedEdges: [],
      recommendedCurrentNodes: [],
      assessment: null,
      homeAccountName: null,
      error: null,
      isLoading: false,
      userEdges: [],
      hiddenEdgeIds: new Set(),
      edgeReconnectOverrides: new Map(),
      userCustomerSites: [],
      hiddenCustomerSiteIds: new Set(),
      utilizationCache: new Map(),
      showUtilization: false,
      failedNodeIds: new Set(),
      failedEdgeIds: new Set(),
      isSimulating: false,
      pinnedNodeId: null,
      hoveredNodeId: null,
    });
  });

  it('clears the loaded graph back to the blank cold-start state', () => {
    seedLoadedGraph();

    useTopologyStore.getState().resetTopology();

    const s = useTopologyStore.getState();
    expect(s.topologyData).toBeNull();
    expect(s.currentNodes).toHaveLength(0);
    expect(s.currentEdges).toHaveLength(0);
    expect(s.recommendedNodes).toHaveLength(0);
    expect(s.recommendedEdges).toHaveLength(0);
    expect(s.recommendedCurrentNodes).toHaveLength(0);
    expect(s.assessment).toBeNull();
    expect(s.homeAccountName).toBeNull();
    expect(s.error).toBeNull();
    expect(s.isLoading).toBe(false);
  });

  it('does NOT reload the mock scenario — canvas stays blank (regression)', () => {
    seedLoadedGraph();

    useTopologyStore.getState().resetTopology();

    // The whole point of the fix: after sign-out the graph is empty, not the
    // demo scenario. If resetTopology ever rebuilds from mock, these grow.
    expect(useTopologyStore.getState().currentNodes).toHaveLength(0);
    expect(useTopologyStore.getState().topologyData).toBeNull();
  });

  it('drops live-account user customizations and cached utilization', () => {
    seedLoadedGraph();
    useTopologyStore.setState({
      userEdges: [edge('user-1')],
      hiddenEdgeIds: new Set(['hidden-1']),
      edgeReconnectOverrides: new Map([['e', { source: 'x', target: 'y' }]]),
      userCustomerSites: [node('site-1')],
      hiddenCustomerSiteIds: new Set(['site-hidden']),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      utilizationCache: new Map([[30, { vif: new Map(), connection: new Map() }]]) as any,
      showUtilization: true,
    });

    useTopologyStore.getState().resetTopology();

    const s = useTopologyStore.getState();
    expect(s.userEdges).toHaveLength(0);
    expect(s.hiddenEdgeIds.size).toBe(0);
    expect(s.edgeReconnectOverrides.size).toBe(0);
    expect(s.userCustomerSites).toHaveLength(0);
    expect(s.hiddenCustomerSiteIds.size).toBe(0);
    expect(s.utilizationCache.size).toBe(0);
    expect(s.showUtilization).toBe(false);
  });

  it('clears in-flight selection and simulation state', () => {
    seedLoadedGraph();
    useTopologyStore.setState({
      isSimulating: true,
      failedNodeIds: new Set(['n1']),
      failedEdgeIds: new Set(['e1']),
      pinnedNodeId: 'n1',
      hoveredNodeId: 'n1',
    });

    useTopologyStore.getState().resetTopology();

    const s = useTopologyStore.getState();
    expect(s.isSimulating).toBe(false);
    expect(s.failedNodeIds.size).toBe(0);
    expect(s.failedEdgeIds.size).toBe(0);
    expect(s.pinnedNodeId).toBeNull();
    expect(s.hoveredNodeId).toBeNull();
  });

  it('is a no-op while an imported snapshot is pinned', () => {
    seedLoadedGraph();
    const snapshot: ImportedSnapshotInfo = {
      exportedAt: '2026-01-01T00:00:00Z',
      redactedView: false,
    };
    useTopologyStore.setState({ importedSnapshot: snapshot });

    useTopologyStore.getState().resetTopology();

    // The imported view must survive — sign-out/timeout must not clobber it.
    const s = useTopologyStore.getState();
    expect(s.importedSnapshot).toEqual(snapshot);
    expect(s.topologyData).not.toBeNull();
    expect(s.currentNodes).toHaveLength(1);
  });
});
