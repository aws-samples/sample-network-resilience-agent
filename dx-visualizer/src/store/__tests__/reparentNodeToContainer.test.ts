import { describe, it, expect, beforeEach } from 'vitest';
import { useTopologyStore } from '../topology-store';
import type { DxNode } from '../../types/topology';

function makeNode(id: string, category: string, parentId?: string, position = { x: 0, y: 0 }): DxNode {
  return {
    id,
    type: category === 'customerSite' ? 'customerSite' : 'onPremise',
    position,
    parentId,
    data: { label: id, category } as DxNode['data'],
  };
}

describe('reparentNodeToContainer', () => {
  beforeEach(() => {
    useTopologyStore.setState({
      currentNodes: [
        makeNode('custsite-A', 'customerSite', undefined, { x: 0, y: 0 }),
        makeNode('dxloc-B', 'dxLocation', undefined, { x: 300, y: 0 }),
        makeNode('onprem-1', 'onPremise', 'custsite-A', { x: 20, y: 40 }),
        makeNode('onprem-2', 'onPremise', 'dxloc-B', { x: 20, y: 40 }),
      ],
      recommendedCurrentNodes: [],
    });
  });

  it('moves a node from one parent to another', () => {
    const { reparentNodeToContainer } = useTopologyStore.getState();
    reparentNodeToContainer('onprem-1', 'dxloc-B', { x: 50, y: 60 });

    const node = useTopologyStore.getState().currentNodes.find((n) => n.id === 'onprem-1');
    expect(node?.parentId).toBe('dxloc-B');
    expect(node?.position).toEqual({ x: 50, y: 60 });
  });

  it('updates position when reparenting to same container', () => {
    const { reparentNodeToContainer } = useTopologyStore.getState();
    reparentNodeToContainer('onprem-1', 'custsite-A', { x: 30, y: 80 });

    const node = useTopologyStore.getState().currentNodes.find((n) => n.id === 'onprem-1');
    expect(node?.parentId).toBe('custsite-A');
    expect(node?.position).toEqual({ x: 30, y: 80 });
  });

  it('does not modify other nodes', () => {
    const { reparentNodeToContainer } = useTopologyStore.getState();
    reparentNodeToContainer('onprem-1', 'dxloc-B', { x: 50, y: 60 });

    const other = useTopologyStore.getState().currentNodes.find((n) => n.id === 'onprem-2');
    expect(other?.parentId).toBe('dxloc-B');
    expect(other?.position).toEqual({ x: 20, y: 40 });
  });

  it('returns empty patch when node id not found', () => {
    const before = useTopologyStore.getState().currentNodes;
    const { reparentNodeToContainer } = useTopologyStore.getState();
    reparentNodeToContainer('nonexistent', 'dxloc-B', { x: 0, y: 0 });

    expect(useTopologyStore.getState().currentNodes).toBe(before);
  });
});
