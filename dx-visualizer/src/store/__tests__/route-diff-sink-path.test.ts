// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useTopologyStore } from '../topology-store';
import type { DxEdge } from '../../types/topology';

vi.stubGlobal('localStorage', {
  getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {},
});

/**
 * A TGW route-resilience pick lights the carrier VIFs AND runs on into the TGW,
 * through the carriers' own DX gateways only:
 *
 *   awsdev-1 ─(VIF v1)→ dxgw-A ─→ tgw
 *   awsdev-2 ─(VIF v2)→ dxgw-B ─→ tgw
 */
const vifEdge = (id: string, source: string, target: string, vifId: string): DxEdge =>
  ({ id, source, target, data: { vifId } } as DxEdge);
const edge = (source: string, target: string): DxEdge => ({ id: `e-${source}-${target}`, source, target });

const EDGES: DxEdge[] = [
  vifEdge('vif-v1', 'awsdev-1', 'dxgw-A', 'v1'),
  vifEdge('vif-v2', 'awsdev-2', 'dxgw-B', 'v2'),
  edge('dxgw-A', 'tgw'),
  edge('dxgw-B', 'tgw'),
];

beforeEach(() => {
  useTopologyStore.setState({
    viewMode: 'current',
    currentNodes: [],
    currentEdges: EDGES,
    recommendedEdges: [],
    userEdges: [],
    routeDiffPickedVifIds: new Set(),
    routeDiffPickedSinkNodeId: null,
  });
});

describe('route-diff path with a sink', () => {
  it('runs on into the sink through the carrier gateway only', () => {
    useTopologyStore.getState().setRouteDiffPickedVifIds(['v1'], 'tgw');
    const { routeDiffPickedEdgeIds: edges, routeDiffPickedNodeIds: nodes } = useTopologyStore.getState();
    expect(edges.has('vif-v1')).toBe(true);
    expect(edges.has('e-dxgw-A-tgw')).toBe(true);
    expect(nodes.has('tgw')).toBe(true);
    // dxgw-B also feeds the TGW but does not carry the prefix.
    expect(edges.has('e-dxgw-B-tgw')).toBe(false);
  });

  it('stops at the gateway without a sink, as the DX gateway panel always has', () => {
    useTopologyStore.getState().setRouteDiffPickedVifIds(['v1']);
    const { routeDiffPickedEdgeIds: edges, routeDiffPickedNodeIds: nodes } = useTopologyStore.getState();
    expect(edges.has('vif-v1')).toBe(true);
    expect(edges.has('e-dxgw-A-tgw')).toBe(false);
    expect(nodes.has('tgw')).toBe(false);
  });

  it('recomputes when only the sink changes', () => {
    useTopologyStore.getState().setRouteDiffPickedVifIds(['v1']);
    useTopologyStore.getState().setRouteDiffPickedVifIds(['v1'], 'tgw');
    expect(useTopologyStore.getState().routeDiffPickedEdgeIds.has('e-dxgw-A-tgw')).toBe(true);
  });
});
