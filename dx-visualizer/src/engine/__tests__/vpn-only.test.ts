import { describe, it, expect } from 'vitest';
import { analyzeTopology } from '../recommendation-engine';
import { buildGraph } from '../topology-builder';
import { applyLayout } from '../layout-engine';
import type { DxNode } from '../../types/topology';
import { vpnOnlyTopology } from './fixtures/vpn-only-topology';
import { makeEmptyTopology } from './helpers';

// The vpnOnly demo scenario is the only fixture with a zero-DX footprint —
// these tests pin the end-to-end no-DX path: assessment flag, VPN rules still
// firing, and the builder producing a coherent VPN/TGW/VPC graph.

describe('vpnOnly scenario — recommendation engine', () => {
  const result = analyzeTopology(vpnOnlyTopology);

  it('flags dxNotInUse and keeps the back-compat "none" level', () => {
    expect(result.dxNotInUse).toBe(true);
    expect(result.resiliency.currentLevel).toBe('none');
    expect(result.perDxGateway).toHaveLength(0);
  });

  it('VPN best-practice rules still fire without DX', () => {
    const ruleIds = new Set(result.bestPractice.recommendations.map((r) => r.ruleId));
    // vpn-secondary01 has one DOWN tunnel
    expect(ruleIds.has('vpn-tunnel-redundancy')).toBe(true);
  });

  it('emits no DX-provisioning resiliency recommendations', () => {
    // The DX resiliency rules self-guard on zero locations/connections —
    // a VPN-only account shouldn't be told to fix DX redundancy.
    expect(result.resiliency.recommendations).toHaveLength(0);
  });
});

describe('vpnOnly scenario — topology builder', () => {
  const { nodes } = buildGraph(vpnOnlyTopology, new Set());

  it('builds the TGW, both VPCs, and both VPN connections', () => {
    expect(nodes.find((n) => n.id === 'tgw-tgw-vpnhub01')).toBeDefined();
    expect(nodes.find((n) => n.data.resourceId === 'vpc-vpn01')).toBeDefined();
    expect(nodes.find((n) => n.data.resourceId === 'vpc-vpn02')).toBeDefined();
    expect(nodes.find((n) => n.id === 'vpn-vpn-primary01')).toBeDefined();
    expect(nodes.find((n) => n.id === 'vpn-vpn-secondary01')).toBeDefined();
  });

  it('builds on-prem routers and the region container', () => {
    expect(nodes.find((n) => n.id === 'onprem-vpn-cgw-hq01')).toBeDefined();
    expect(nodes.find((n) => n.id === 'onprem-vpn-cgw-dr01')).toBeDefined();
    expect(nodes.find((n) => n.id === 'region-eu-west-1')).toBeDefined();
  });

  it('builds no DX nodes at all', () => {
    expect(nodes.some((n) => n.id.startsWith('dxgw-'))).toBe(false);
    expect(nodes.some((n) => n.data.category === 'dxLocation')).toBe(false);
    expect(nodes.some((n) => n.data.category === 'dxPartnerDevice')).toBe(false);
  });
});

describe('vpnOnly scenario — layout', () => {
  // Absolute position of a node: React Flow child positions are relative to
  // their parent container, so walk up the parentId chain to get world coords.
  function absLeft(byId: Map<string, DxNode>, n: DxNode): number {
    let x = n.position.x;
    let cur = n.parentId ? byId.get(n.parentId) : undefined;
    while (cur) {
      x += cur.position.x;
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return x;
  }
  function absRight(byId: Map<string, DxNode>, n: DxNode): number {
    return absLeft(byId, n) + ((n.width as number) ?? 0);
  }
  function absTop(byId: Map<string, DxNode>, n: DxNode): number {
    let y = n.position.y;
    let cur = n.parentId ? byId.get(n.parentId) : undefined;
    while (cur) {
      y += cur.position.y;
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return y;
  }

  it('keeps Customer Data Center containers clear of the AWS Cloud (no DX columns to space them apart)', () => {
    const { nodes, edges } = buildGraph(vpnOnlyTopology, new Set());
    const laid = applyLayout(nodes, edges);
    const byId = new Map(laid.map((n) => [n.id, n]));

    const awsCloud = laid.find((n) => n.data.category === 'awsCloud');
    const customerSites = laid.filter((n) => n.data.category === 'customerSite');
    expect(awsCloud).toBeDefined();
    expect(customerSites.length).toBeGreaterThan(0);

    // Every Customer Data Center box must end (right edge) to the LEFT of the
    // AWS Cloud's left edge. Before the VPN-only onPremise-column reservation,
    // all DX columns collapsed and the region flow started at x≈0, overlapping
    // the customer strip — the "squashed together" bug.
    const cloudLeft = absLeft(byId, awsCloud!);
    for (const site of customerSites) {
      expect(absRight(byId, site)).toBeLessThanOrEqual(cloudLeft);
    }
  });

  it('stacks standalone Customer Data Center containers with a visible vertical gap', () => {
    const { nodes, edges } = buildGraph(vpnOnlyTopology, new Set());
    const laid = applyLayout(nodes, edges);
    const byId = new Map(laid.map((n) => [n.id, n]));

    // Two CGWs with distinct IPs → two standalone custsite-vpn containers. Each
    // router previously advanced by the bare-node rowHeight, whose gap was fully
    // eaten by container PAD_TOP/PAD_BOTTOM, so the boxes touched (0px gap).
    const sites = laid
      .filter((n) => n.data.category === 'customerSite')
      .map((n) => ({ top: absTop(byId, n), bottom: absTop(byId, n) + ((n.height as number) ?? 0) }))
      .sort((a, b) => a.top - b.top);
    expect(sites.length).toBe(2);

    const gap = sites[1].top - sites[0].bottom;
    expect(gap).toBeGreaterThan(0);
  });
});

describe('no-DX VGW rendering (hasDxPresence escape)', () => {
  it('renders a VPC-attached VGW without the showNonDx toggle when the account has no DX', () => {
    const topo = makeEmptyTopology();
    topo.vpcs = [
      { vpcId: 'vpc-solo1', cidrBlock: '10.5.0.0/16', region: 'eu-west-1', tags: { Name: 'Solo-VPC' }, state: 'available' },
    ];
    topo.vpnGateways = [
      {
        vpnGatewayId: 'vgw-solo1',
        vpcAttachments: [{ vpcId: 'vpc-solo1', state: 'attached' }],
        type: 'ipsec.1',
        amazonSideAsn: 64512,
        state: 'available',
        tags: { Name: 'Solo-VGW' },
      },
    ];

    // Empty showNonDxVpcs set — before the fix this VGW (no DXGW assoc, no
    // VPN, no VIF) was suppressed even though there is no DX to focus on.
    const { nodes } = buildGraph(topo, new Set());
    expect(nodes.find((n) => n.id === 'vgw-vgw-solo1')).toBeDefined();
  });
});
