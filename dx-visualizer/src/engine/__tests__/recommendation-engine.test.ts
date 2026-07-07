import { describe, it, expect } from 'vitest';
import { analyzeTopology, getRecommendedGraph, FOCUSED_PUBLIC_VIF, FOCUSED_LAG } from '../recommendation-engine';
import { makeEmptyTopology } from './helpers';

describe('analyzeTopology', () => {
  it('returns "none" resiliency level for empty topology', () => {
    const result = analyzeTopology(makeEmptyTopology());
    expect(result.resiliency.currentLevel).toBe('none');
  });

  it('returns "devtest" for single connection at one location (AWS Single Connection SLA — 95%)', () => {
    const t = makeEmptyTopology();
    t.connections = [
      { connectionId: 'c1', location: 'EqDC2', connectionState: 'available', bandwidth: '1Gbps', tags: {} } as any,
    ];
    const result = analyzeTopology(t);
    expect(result.resiliency.currentLevel).toBe('devtest');
    // Default target is 'high'
    expect(result.resiliency.targetLevel).toBe('high');
  });

  it('honors explicit "maximum" target from "devtest"', () => {
    const t = makeEmptyTopology();
    t.connections = [
      { connectionId: 'c1', location: 'EqDC2', connectionState: 'available', bandwidth: '1Gbps', tags: {} } as any,
    ];
    const result = analyzeTopology(t, 'maximum');
    expect(result.resiliency.currentLevel).toBe('devtest');
    expect(result.resiliency.targetLevel).toBe('maximum');
  });

  it('returns "devtest" for two connections at same location (single-site device redundancy)', () => {
    const t = makeEmptyTopology();
    t.connections = [
      { connectionId: 'c1', location: 'EqDC2', connectionState: 'available', bandwidth: '1Gbps', tags: {} } as any,
      { connectionId: 'c2', location: 'EqDC2', connectionState: 'available', bandwidth: '1Gbps', tags: {} } as any,
    ];
    const result = analyzeTopology(t);
    expect(result.resiliency.currentLevel).toBe('devtest');
    expect(result.resiliency.targetLevel).toBe('high');
  });

  it('returns "high" for two locations with single connection each (target forced to maximum)', () => {
    const t = makeEmptyTopology();
    t.connections = [
      { connectionId: 'c1', location: 'EqDC2', connectionState: 'available', bandwidth: '1Gbps', tags: {} } as any,
      { connectionId: 'c2', location: 'EqDC6', connectionState: 'available', bandwidth: '1Gbps', tags: {} } as any,
    ];
    const result = analyzeTopology(t);
    expect(result.resiliency.currentLevel).toBe('high');
    // From high, target always bumps to maximum regardless of picker input
    expect(result.resiliency.targetLevel).toBe('maximum');
  });

  it('returns "maximum" for two locations with two connections each', () => {
    const t = makeEmptyTopology();
    t.connections = [
      { connectionId: 'c1', location: 'EqDC2', connectionState: 'available', bandwidth: '1Gbps', tags: {} } as any,
      { connectionId: 'c2', location: 'EqDC2', connectionState: 'available', bandwidth: '1Gbps', tags: {} } as any,
      { connectionId: 'c3', location: 'EqDC6', connectionState: 'available', bandwidth: '1Gbps', tags: {} } as any,
      { connectionId: 'c4', location: 'EqDC6', connectionState: 'available', bandwidth: '1Gbps', tags: {} } as any,
    ];
    const result = analyzeTopology(t);
    expect(result.resiliency.currentLevel).toBe('maximum');
    expect(result.resiliency.targetLevel).toBe('maximum');
  });

  it('does not qualify for "maximum" when 2 connections share an AWS logical device', () => {
    // Both connections at EqDC6 terminate on the same AWS router — device
    // redundancy isn't met even though the raw connection count is 2.
    const t = makeEmptyTopology();
    t.connections = [
      { connectionId: 'c1', location: 'EqDC2', connectionState: 'available', bandwidth: '1Gbps', awsLogicalDeviceId: 'dev-A', tags: {} } as any,
      { connectionId: 'c2', location: 'EqDC2', connectionState: 'available', bandwidth: '1Gbps', awsLogicalDeviceId: 'dev-B', tags: {} } as any,
      { connectionId: 'c3', location: 'EqDC6', connectionState: 'available', bandwidth: '1Gbps', awsLogicalDeviceId: 'dev-C', tags: {} } as any,
      { connectionId: 'c4', location: 'EqDC6', connectionState: 'available', bandwidth: '1Gbps', awsLogicalDeviceId: 'dev-C', tags: {} } as any,
    ];
    const result = analyzeTopology(t, 'maximum');
    expect(result.resiliency.currentLevel).toBe('high');
    const ruleIds = result.resiliency.recommendations.map((r) => r.ruleId);
    expect(ruleIds).toContain('single-connection-per-location');
    // The device-short location should be EqDC6, not EqDC2
    const rec = result.resiliency.recommendations.find((r) => r.ruleId === 'single-connection-per-location');
    expect(rec?.title).toContain('EqDC6');
  });

  it('qualifies for "maximum" when 2 connections per location terminate on distinct AWS logical devices', () => {
    const t = makeEmptyTopology();
    t.connections = [
      { connectionId: 'c1', location: 'EqDC2', connectionState: 'available', bandwidth: '1Gbps', awsLogicalDeviceId: 'dev-A', tags: {} } as any,
      { connectionId: 'c2', location: 'EqDC2', connectionState: 'available', bandwidth: '1Gbps', awsLogicalDeviceId: 'dev-B', tags: {} } as any,
      { connectionId: 'c3', location: 'EqDC6', connectionState: 'available', bandwidth: '1Gbps', awsLogicalDeviceId: 'dev-C', tags: {} } as any,
      { connectionId: 'c4', location: 'EqDC6', connectionState: 'available', bandwidth: '1Gbps', awsLogicalDeviceId: 'dev-D', tags: {} } as any,
    ];
    const result = analyzeTopology(t);
    expect(result.resiliency.currentLevel).toBe('maximum');
  });

  it('falls back to connection ID when awsLogicalDeviceId is missing (hosted VIFs)', () => {
    // No logical IDs exposed — each raw connection counts as its own device
    // so we don't over-penalize accounts using partner-hosted connections.
    const t = makeEmptyTopology();
    t.connections = [
      { connectionId: 'c1', location: 'EqDC2', connectionState: 'available', bandwidth: '1Gbps', tags: {} } as any,
      { connectionId: 'c2', location: 'EqDC2', connectionState: 'available', bandwidth: '1Gbps', tags: {} } as any,
      { connectionId: 'c3', location: 'EqDC6', connectionState: 'available', bandwidth: '1Gbps', tags: {} } as any,
      { connectionId: 'c4', location: 'EqDC6', connectionState: 'available', bandwidth: '1Gbps', tags: {} } as any,
    ];
    const result = analyzeTopology(t);
    expect(result.resiliency.currentLevel).toBe('maximum');
  });

  it('generates single-dx-location rec for single-location topology (default high target)', () => {
    const t = makeEmptyTopology();
    t.connections = [
      { connectionId: 'c1', location: 'EqDC2', connectionState: 'available', bandwidth: '1Gbps', tags: {} } as any,
    ];
    const result = analyzeTopology(t);
    const ruleIds = result.resiliency.recommendations.map((r) => r.ruleId);
    expect(ruleIds).toContain('single-dx-location');
    // high target doesn't generate per-location redundancy recs
    expect(ruleIds).not.toContain('single-connection-per-location');
  });

  it('generates single-connection-per-location rec when target is maximum', () => {
    const t = makeEmptyTopology();
    t.connections = [
      { connectionId: 'c1', location: 'EqDC2', connectionState: 'available', bandwidth: '1Gbps', tags: {} } as any,
    ];
    const result = analyzeTopology(t, 'maximum');
    const ruleIds = result.resiliency.recommendations.map((r) => r.ruleId);
    expect(ruleIds).toContain('single-dx-location');
    expect(ruleIds).toContain('single-connection-per-location');
  });

  it('includes best practice recommendations', () => {
    const t = makeEmptyTopology();
    t.connections = [
      { connectionId: 'c1', location: 'EqDC2', connectionState: 'available', bandwidth: '1Gbps', tags: {} } as any,
    ];
    const result = analyzeTopology(t);
    expect(result.bestPractice.recommendations.length).toBeGreaterThan(0);
    const bpRuleIds = result.bestPractice.recommendations.map((r) => r.ruleId);
    expect(bpRuleIds).toContain('bfd-guidance');
    expect(bpRuleIds).toContain('no-vpn-backup');
  });

});

describe('getRecommendedGraph', () => {
  it('collects ghost nodes and edges from resiliency recommendations', () => {
    const t = makeEmptyTopology();
    t.connections = [
      { connectionId: 'c1', location: 'EqDC2', connectionState: 'available', bandwidth: '1Gbps', tags: {} } as any,
    ];
    const assessment = analyzeTopology(t);
    const { nodes, edges } = getRecommendedGraph(assessment);
    expect(nodes.length).toBeGreaterThan(0);
    expect(edges.length).toBeGreaterThan(0);
    // All ghost nodes should be marked as recommended
    for (const n of nodes) {
      expect(n.data.isRecommended).toBe(true);
    }
  });

  it('produces independent per-DXGW assessments for two gateways with different postures', () => {
    const t = makeEmptyTopology();
    t.dxGateways = [
      { directConnectGatewayId: 'gw-healthy', directConnectGatewayName: 'DxGwHealthy', ownerAccount: '1', amazonSideAsn: 64512, directConnectGatewayState: 'available' } as any,
      { directConnectGatewayId: 'gw-single', directConnectGatewayName: 'DxGwOsaka', ownerAccount: '1', amazonSideAsn: 64512, directConnectGatewayState: 'available' } as any,
    ];
    t.connections = [
      // healthy gateway: 2 connections across 2 locations
      { connectionId: 'c1', location: 'EqDC2', connectionState: 'available', bandwidth: '1Gbps', tags: {} } as any,
      { connectionId: 'c2', location: 'EqDC6', connectionState: 'available', bandwidth: '1Gbps', tags: {} } as any,
      // single-location gateway: 1 connection at 1 location
      { connectionId: 'c3', location: 'Osaka1', connectionState: 'available', bandwidth: '1Gbps', tags: {} } as any,
    ];
    t.virtualInterfaces = [
      { virtualInterfaceId: 'v1', connectionId: 'c1', location: 'EqDC2', directConnectGatewayId: 'gw-healthy', virtualInterfaceState: 'available', bgpPeers: [{ bgpStatus: 'up' }] } as any,
      { virtualInterfaceId: 'v2', connectionId: 'c2', location: 'EqDC6', directConnectGatewayId: 'gw-healthy', virtualInterfaceState: 'available', bgpPeers: [{ bgpStatus: 'up' }] } as any,
      { virtualInterfaceId: 'v3', connectionId: 'c3', location: 'Osaka1', directConnectGatewayId: 'gw-single', virtualInterfaceState: 'available', bgpPeers: [{ bgpStatus: 'up' }] } as any,
    ];

    const result = analyzeTopology(t);

    expect(result.perDxGateway).toHaveLength(2);
    const healthy = result.perDxGateway.find((g) => g.dxGatewayId === 'gw-healthy')!;
    const single = result.perDxGateway.find((g) => g.dxGatewayId === 'gw-single')!;

    expect(healthy.currentLevel).toBe('high');
    expect(healthy.recommendations.map((r) => r.ruleId)).not.toContain('single-dx-location');

    expect(single.currentLevel).toBe('devtest');
    expect(single.recommendations.map((r) => r.ruleId)).toContain('single-dx-location');
  });

  it('exposes global section separate from per-DXGW recommendations', () => {
    const t = makeEmptyTopology();
    t.dxGateways = [
      { directConnectGatewayId: 'gw1', directConnectGatewayName: 'Dx', ownerAccount: '1', amazonSideAsn: 64512, directConnectGatewayState: 'available' } as any,
    ];
    t.connections = [
      { connectionId: 'c1', location: 'EqDC2', connectionState: 'available', bandwidth: '1Gbps', tags: {} } as any,
      { connectionId: 'c2', location: 'EqDC6', connectionState: 'available', bandwidth: '1Gbps', tags: {} } as any,
    ];
    t.virtualInterfaces = [
      { virtualInterfaceId: 'v1', connectionId: 'c1', location: 'EqDC2', directConnectGatewayId: 'gw1', virtualInterfaceState: 'available', bgpPeers: [{ bgpStatus: 'up' }] } as any,
      { virtualInterfaceId: 'v2', connectionId: 'c2', location: 'EqDC6', directConnectGatewayId: 'gw1', virtualInterfaceState: 'available', bgpPeers: [{ bgpStatus: 'up' }] } as any,
    ];

    const result = analyzeTopology(t);
    // BFD guidance and no-VPN-backup should always appear in the global section
    const globalBpIds = result.global.bestPractice.recommendations.map((r) => r.ruleId);
    expect(globalBpIds).toContain('bfd-guidance');
    expect(globalBpIds).toContain('no-vpn-backup');
    // VIF-down is a per-DXGW rule now — it must not leak into the global section
    expect(globalBpIds).not.toContain('vif-down');
  });

  it('returns empty graph when no resiliency recommendations have ghost nodes', () => {
    const t = makeEmptyTopology();
    t.connections = [
      { connectionId: 'c1', location: 'EqDC2', connectionState: 'available', bandwidth: '1Gbps', tags: {} } as any,
      { connectionId: 'c2', location: 'EqDC2', connectionState: 'available', bandwidth: '1Gbps', tags: {} } as any,
      { connectionId: 'c3', location: 'EqDC6', connectionState: 'available', bandwidth: '1Gbps', tags: {} } as any,
      { connectionId: 'c4', location: 'EqDC6', connectionState: 'available', bandwidth: '1Gbps', tags: {} } as any,
    ];
    const assessment = analyzeTopology(t);
    const { nodes, edges } = getRecommendedGraph(assessment);
    expect(nodes).toHaveLength(0);
    expect(edges).toHaveLength(0);
  });

  it('returns only public VIF ghost nodes when FOCUSED_PUBLIC_VIF is focused', () => {
    const t = makeEmptyTopology();
    t.connections = [
      { connectionId: 'c1', location: 'EqSG1', connectionState: 'available', bandwidth: '1Gbps', tags: {} } as any,
    ];
    t.virtualInterfaces = [
      { virtualInterfaceId: 'vif-1', virtualInterfaceType: 'public', connectionId: 'c1', location: 'EqSG1', bgpPeers: [], tags: {} } as any,
    ];
    t.dxGateways = [{ directConnectGatewayId: 'gw-1', directConnectGatewayName: 'my-gw', tags: {} } as any];
    t.dxGatewayAssociations = [];
    const assessment = analyzeTopology(t);
    const { nodes, edges } = getRecommendedGraph(assessment, FOCUSED_PUBLIC_VIF);
    expect(nodes.length).toBeGreaterThan(0);
    expect(nodes.every((n) => n.id.startsWith('rec-pubvif-'))).toBe(true);
    expect(edges.some((e) => e.target === 'pub-endpoints')).toBe(true);
  });

  it('does not include public VIF ghosts when a DXGW is focused', () => {
    const t = makeEmptyTopology();
    t.connections = [
      { connectionId: 'c1', location: 'EqSG1', connectionState: 'available', bandwidth: '1Gbps', tags: {} } as any,
    ];
    t.virtualInterfaces = [
      { virtualInterfaceId: 'vif-1', virtualInterfaceType: 'public', connectionId: 'c1', location: 'EqSG1', bgpPeers: [], tags: {} } as any,
      { virtualInterfaceId: 'vif-2', virtualInterfaceType: 'private', directConnectGatewayId: 'gw-1', connectionId: 'c1', location: 'EqSG1', bgpPeers: [], tags: {} } as any,
    ];
    t.dxGateways = [{ directConnectGatewayId: 'gw-1', directConnectGatewayName: 'my-gw', tags: {} } as any];
    t.dxGatewayAssociations = [];
    const assessment = analyzeTopology(t);
    const { nodes } = getRecommendedGraph(assessment, 'gw-1');
    expect(nodes.every((n) => !n.id.startsWith('rec-pubvif-'))).toBe(true);
  });

  it('skips per-DXGW rules when LAG topology is already maximum (2 LAGs per location)', () => {
    const t = makeEmptyTopology();
    t.connections = [
      { connectionId: 'c1', location: 'EqDC2', connectionState: 'available', bandwidth: '1Gbps', awsLogicalDeviceId: 'dev-1', tags: {} } as any,
      { connectionId: 'c2', location: 'EqDC2', connectionState: 'available', bandwidth: '1Gbps', awsLogicalDeviceId: 'dev-2', tags: {} } as any,
      { connectionId: 'c3', location: 'EqDC6', connectionState: 'available', bandwidth: '1Gbps', awsLogicalDeviceId: 'dev-3', tags: {} } as any,
      { connectionId: 'c4', location: 'EqDC6', connectionState: 'available', bandwidth: '1Gbps', awsLogicalDeviceId: 'dev-4', tags: {} } as any,
    ];
    t.virtualInterfaces = [
      { virtualInterfaceId: 'vif-1', virtualInterfaceType: 'private', directConnectGatewayId: 'gw-1', connectionId: 'c1', location: 'EqDC2', bgpPeers: [], tags: {} } as any,
    ];
    t.lags = [
      { lagId: 'lag-1', lagName: 'LAG-A', location: 'EqDC2', lagState: 'available', connectionsBandwidth: '1Gbps', numberOfConnections: 2, minimumLinks: 1, connections: [{ connectionId: 'c1' }] } as any,
      { lagId: 'lag-2', lagName: 'LAG-B', location: 'EqDC2', lagState: 'available', connectionsBandwidth: '1Gbps', numberOfConnections: 2, minimumLinks: 1, connections: [{ connectionId: 'c2' }] } as any,
      { lagId: 'lag-3', lagName: 'LAG-C', location: 'EqDC6', lagState: 'available', connectionsBandwidth: '1Gbps', numberOfConnections: 2, minimumLinks: 1, connections: [{ connectionId: 'c3' }] } as any,
      { lagId: 'lag-4', lagName: 'LAG-D', location: 'EqDC6', lagState: 'available', connectionsBandwidth: '1Gbps', numberOfConnections: 2, minimumLinks: 1, connections: [{ connectionId: 'c4' }] } as any,
    ];
    t.dxGateways = [{ directConnectGatewayId: 'gw-1', directConnectGatewayName: 'my-gw', tags: {} } as any];
    t.dxGatewayAssociations = [{ directConnectGatewayId: 'gw-1', associatedGatewayId: 'tgw-1' } as any];
    const assessment = analyzeTopology(t);
    expect(assessment.perDxGateway[0].recommendations).toEqual([]);
  });

  it('LAG ghost nodes fan out edges to all DXGWs in the topology', () => {
    const t = makeEmptyTopology();
    t.connections = [
      { connectionId: 'c1', location: 'EqDC2', connectionState: 'available', bandwidth: '1Gbps', awsLogicalDeviceId: 'dev-1', tags: {} } as any,
    ];
    t.virtualInterfaces = [
      { virtualInterfaceId: 'vif-1', virtualInterfaceType: 'private', directConnectGatewayId: 'gw-1', connectionId: 'c1', location: 'EqDC2', bgpPeers: [], tags: {} } as any,
    ];
    t.lags = [
      { lagId: 'lag-1', lagName: 'LAG-A', location: 'EqDC2', lagState: 'available', connectionsBandwidth: '1Gbps', numberOfConnections: 2, minimumLinks: 1, connections: [{ connectionId: 'c1' }] } as any,
    ];
    t.dxGateways = [
      { directConnectGatewayId: 'gw-1', directConnectGatewayName: 'GW-1', tags: {} } as any,
      { directConnectGatewayId: 'gw-2', directConnectGatewayName: 'GW-2', tags: {} } as any,
    ];
    const assessment = analyzeTopology(t);
    const { edges } = getRecommendedGraph(assessment, FOCUSED_LAG);
    const edgesToGw1 = edges.filter((e) => e.target === 'dxgw-gw-1');
    const edgesToGw2 = edges.filter((e) => e.target === 'dxgw-gw-2');
    expect(edgesToGw1.length).toBeGreaterThan(0);
    expect(edgesToGw2.length).toBeGreaterThan(0);
  });
});
