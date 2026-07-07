import { describe, it, expect } from 'vitest';
import {
  ghostSinkEdges,
  secondLocationGhostChain,
  extraDeviceGhost,
  type GhostSink,
} from '../ghost-chains';

const DXGW_SINK: GhostSink = { nodeId: 'dxgw-gw-1', label: 'VIF' };
const PUB_SINK: GhostSink = { nodeId: 'pub-endpoints', label: 'Public VIF' };

describe('ghostSinkEdges', () => {
  it('emits one ghost edge per sink from the given AWS device', () => {
    const edges = ghostSinkEdges('rec-awsdev-B', [DXGW_SINK, PUB_SINK]);
    expect(edges).toHaveLength(2);
    expect(edges.every((e) => e.source === 'rec-awsdev-B')).toBe(true);
    expect(edges.every((e) => e.data?.isRecommended)).toBe(true);
  });

  it('labels each edge with its sink label and targets the sink node', () => {
    const [vifEdge, pubEdge] = ghostSinkEdges('rec-awsdev-B', [DXGW_SINK, PUB_SINK]);
    expect(vifEdge.target).toBe('dxgw-gw-1');
    expect(vifEdge.data?.label).toBe('VIF');
    expect(pubEdge.target).toBe('pub-endpoints');
    expect(pubEdge.data?.label).toBe('Public VIF');
  });

  it('returns no edges when there are no sinks', () => {
    expect(ghostSinkEdges('rec-awsdev-B', [])).toEqual([]);
  });
});

describe('secondLocationGhostChain', () => {
  it('high target builds a 3-node chain (location, partner, device) — no customer premises', () => {
    const { nodes } = secondLocationGhostChain({
      prefix: 'rec',
      locCode: 'rec-loc-B',
      sinks: [DXGW_SINK],
      target: 'high',
    });
    expect(nodes).toHaveLength(3);
    // The recommendation path starts at the Customer / Partner Device — no
    // "Customer Data Center" (customerSite) or "Customer Gateway" (onPremise) ghost.
    expect(nodes.find((n) => n.id === 'rec-custsite-B')).toBeUndefined();
    expect(nodes.find((n) => n.id === 'rec-onprem-B')).toBeUndefined();
    expect(nodes.find((n) => n.id === 'rec-dxloc-B')).toBeDefined();
    expect(nodes.find((n) => n.id === 'rec-partner-B')).toBeDefined();
    expect(nodes.find((n) => n.id === 'rec-awsdev-B')).toBeDefined();
    expect(nodes.every((n) => n.data.isRecommended)).toBe(true);
  });

  it('maximum target adds a second partner + device (5 nodes)', () => {
    const { nodes } = secondLocationGhostChain({
      prefix: 'rec',
      locCode: 'rec-loc-B',
      sinks: [DXGW_SINK],
      target: 'maximum',
    });
    expect(nodes).toHaveLength(5);
    expect(nodes.find((n) => n.id === 'rec-partner-B-2')).toBeDefined();
    expect(nodes.find((n) => n.id === 'rec-awsdev-B-2')).toBeDefined();
  });

  it('every ghost AWS device fans out to each sink', () => {
    const { edges } = secondLocationGhostChain({
      prefix: 'rec',
      locCode: 'rec-loc-B',
      sinks: [DXGW_SINK, PUB_SINK],
      target: 'maximum',
    });
    // device B and device B-2 each edge to both sinks => 4 sink edges
    const sinkEdges = edges.filter((e) => e.target === 'dxgw-gw-1' || e.target === 'pub-endpoints');
    expect(sinkEdges).toHaveLength(4);
    expect(edges.filter((e) => e.source === 'rec-awsdev-B' && e.target === 'pub-endpoints')).toHaveLength(1);
    expect(edges.filter((e) => e.source === 'rec-awsdev-B-2' && e.target === 'dxgw-gw-1')).toHaveLength(1);
  });

  it('wires the partner -> device backbone starting at the partner device', () => {
    const { edges } = secondLocationGhostChain({
      prefix: 'rec',
      locCode: 'rec-loc-B',
      sinks: [DXGW_SINK],
      target: 'high',
    });
    // Chain starts at the partner device — no on-prem -> partner edge anymore.
    expect(edges.find((e) => e.source === 'rec-onprem-B')).toBeUndefined();
    expect(edges.find((e) => e.source === 'rec-partner-B' && e.target === 'rec-awsdev-B')).toBeDefined();
  });

  it('produces no sink edges when sinks is empty (backbone only)', () => {
    const { edges } = secondLocationGhostChain({
      prefix: 'rec',
      locCode: 'rec-loc-B',
      sinks: [],
      target: 'high',
    });
    expect(edges.find((e) => e.target === 'dxgw-gw-1' || e.target === 'pub-endpoints')).toBeUndefined();
  });

  it('honours a custom site label and details on the DX location node (per-DXGW disambiguation)', () => {
    const { nodes } = secondLocationGhostChain({
      prefix: 'rec-dxgw-1',
      locCode: 'rec-dxgw-1-loc-B',
      sinks: [DXGW_SINK],
      target: 'high',
      siteLabel: 'Second Direct Connect Location to support My-GW',
      siteDetails: { dxGatewayId: 'gw-1' },
    });
    // With the customer-site ghost removed, the label/details attach to the
    // Second Direct Connect Location node so multiple DXGWs stay distinguishable.
    const loc = nodes.find((n) => n.id === 'rec-dxgw-1-dxloc-B')!;
    expect(loc.data.label).toBe('Second Direct Connect Location to support My-GW');
    expect((loc.data.details as Record<string, unknown>).dxGatewayId).toBe('gw-1');
  });
});

describe('extraDeviceGhost', () => {
  it('adds a partner + device pair at an existing location', () => {
    const { nodes } = extraDeviceGhost({
      prefix: 'rec',
      location: 'EqSG1',
      sinks: [DXGW_SINK],
    });
    expect(nodes).toHaveLength(2);
    expect(nodes.find((n) => n.id === 'rec-partner-EqSG1-2')).toBeDefined();
    expect(nodes.find((n) => n.id === 'rec-awsdev-EqSG1-2')).toBeDefined();
  });

  it('starts at partner -> device and fans the device to each sink (no on-prem edge)', () => {
    const { edges } = extraDeviceGhost({
      prefix: 'rec',
      location: 'EqSG1',
      sinks: [DXGW_SINK, PUB_SINK],
    });
    // No edge back to the location's on-prem / customer data center node.
    expect(edges.find((e) => e.source === 'onprem-EqSG1')).toBeUndefined();
    expect(edges.find((e) => e.source === 'rec-partner-EqSG1-2' && e.target === 'rec-awsdev-EqSG1-2')).toBeDefined();
    expect(edges.find((e) => e.source === 'rec-awsdev-EqSG1-2' && e.target === 'dxgw-gw-1')).toBeDefined();
    expect(edges.find((e) => e.source === 'rec-awsdev-EqSG1-2' && e.target === 'pub-endpoints')).toBeDefined();
  });
});
