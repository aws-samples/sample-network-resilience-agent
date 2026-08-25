// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useTopologyStore } from '../topology-store';
import type { DxEdge } from '../../types/topology';
import { customerLinkId } from '../../utils/user-edges';

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

/**
 * Two redundant DX paths through one colo, each ending at its own AWS logical
 * device but sharing a DX gateway — the shape in the screenshot that showed the
 * bug:
 *
 *   router-1 → partnerUpper → awsdev-1 ─┐
 *        (customer link, drawn by hand)  ├→ dxgw
 *   router-2 → partnerLower → awsdev-2 ─┘
 *
 * The customer link joins the two partner devices. It is the only edge here the
 * user drew; everything else came from the AWS APIs.
 */
const LINK_ID = customerLinkId('partnerUpper', 'partnerLower');

const e = (source: string, target: string): DxEdge => ({ id: `e-${source}-${target}`, source, target });

// Anchored upper→lower, exactly as `planUserEdge` builds it.
const customerLink: DxEdge = {
  id: LINK_ID,
  source: 'partnerUpper',
  target: 'partnerLower',
  sourceHandle: 'bottom',
  targetHandle: 'top',
  data: { isPeering: true, isLateral: true },
};

const AWS_EDGES: DxEdge[] = [
  e('router-1', 'partnerUpper'),
  e('router-2', 'partnerLower'),
  e('partnerUpper', 'awsdev-1'),
  e('partnerLower', 'awsdev-2'),
  e('awsdev-1', 'dxgw'),
  e('awsdev-2', 'dxgw'),
];

function seed() {
  useTopologyStore.setState({
    viewMode: 'current',
    currentEdges: AWS_EDGES,
    recommendedEdges: [],
    userEdges: [customerLink],
    pinnedNodeId: null,
    highlightedNodeIds: new Set(),
    highlightedEdgeIds: new Set(),
  });
}

function clickHighlight(nodeId: string) {
  useTopologyStore.getState().setPinnedNode(nodeId);
  const { highlightedNodeIds, highlightedEdgeIds } = useTopologyStore.getState();
  useTopologyStore.getState().setPinnedNode(null);
  return { nodes: highlightedNodeIds, edges: highlightedEdgeIds };
}

beforeEach(seed);

describe('clicking a node highlights the customer link regardless of which end is upper', () => {
  // The upper/lower split is a cosmetic routing choice, so nothing about the
  // highlight may depend on it.
  it.each([
    ['the lower partner device', 'partnerLower'],
    ['the upper partner device', 'partnerUpper'],
    ['the AWS device behind the lower one', 'awsdev-2'],
    ['the AWS device behind the upper one', 'awsdev-1'],
    ['the router feeding the lower one', 'router-2'],
    ['the router feeding the upper one', 'router-1'],
    ['the shared DX gateway', 'dxgw'],
  ])('covers it when clicking %s', (_label, nodeId) => {
    expect(clickHighlight(nodeId).edges).toContain(LINK_ID);
  });

  it('highlights both ends of the link, so the redundant pair reads as related', () => {
    const { nodes } = clickHighlight('awsdev-1');
    expect(nodes).toContain('partnerUpper');
    expect(nodes).toContain('partnerLower');
  });
});

describe('a customer link does not leak the peer path into the highlight', () => {
  it('stops at the peer instead of dragging its whole path along', () => {
    // Clicking the upper AWS device must not pull in the LOWER path's own
    // router or AWS device — the link says "these two back each other up", not
    // "these are one path".
    const { nodes } = clickHighlight('awsdev-1');
    expect(nodes).toContain('router-1');
    expect(nodes).not.toContain('router-2');
    expect(nodes).not.toContain('awsdev-2');
  });

  it('leaves AWS-reported peerings on the directional traversal', () => {
    // Scope marker, not an endorsement: VPC↔VPC / TGW↔TGW / Cloud WAN peerings
    // are `isPeering` but NOT `isLateral`, so they are still walked as path
    // steps and keep the same asymmetry. Flipping them would change what
    // clicking a Core Network or a peered VPC covers, which is a separate call.
    const vpcPeering: DxEdge = {
      id: 'e-vpcpeer-1', source: 'vpc-a', target: 'vpc-b',
      data: { isPeering: true },
    };
    useTopologyStore.setState({
      currentEdges: [e('tgw-1', 'vpc-a'), vpcPeering],
      userEdges: [],
    });
    // Reached from the accepter, the peering pulls the requester's whole upstream
    // in — today's behaviour, unchanged by this fix.
    expect(clickHighlight('vpc-b').nodes).toContain('tgw-1');
  });

  it('still covers the clicked node\'s own end-to-end path', () => {
    const { nodes, edges } = clickHighlight('awsdev-1');
    for (const id of ['router-1', 'partnerUpper', 'awsdev-1', 'dxgw']) {
      expect(nodes, `${id} is on the clicked path`).toContain(id);
    }
    for (const id of ['e-router-1-partnerUpper', 'e-partnerUpper-awsdev-1', 'e-awsdev-1-dxgw']) {
      expect(edges, `${id} is on the clicked path`).toContain(id);
    }
  });
});
