import { describe, it, expect } from 'vitest';
import { analyzeTopology } from '../recommendation-engine';
import { buildGraph } from '../topology-builder';
import { applyLayout } from '../layout-engine';
import type { DxNode, TopologyData } from '../../types/topology';
import { multiDxgwTopology } from './fixtures/multi-dxgw-topology';

/**
 * The "hide VPN" filter (`showVpn` in the store) works by handing `buildGraph`
 * a copy of the topology with `vpnConnections` emptied, while `analyzeTopology`
 * keeps the full one. These tests pin both halves of that contract — the graph
 * really loses every VPN artifact, and the assessment really doesn't move.
 *
 * `useTopology.withoutVpn` is module-private, so the tests reproduce the same
 * one-field strip rather than importing it.
 */

// multiDxgwTopology is full DX with no VPN, so bolt one onto vgw-mdx-prod.
// One tunnel DOWN so `vpn-tunnel-redundancy` has something to report.
const dxAndVpn: TopologyData = {
  ...multiDxgwTopology,
  vpnConnections: [
    {
      vpnConnectionId: 'vpn-hide01',
      vpnGatewayId: 'vgw-mdx-prod',
      customerGatewayId: 'cgw-hide01',
      state: 'available',
      type: 'ipsec.1',
      category: 'VPN',
      customerGatewayAddress: '',
      tunnels: [
        { outsideIpAddress: '52.10.0.1', status: 'UP' },
        { outsideIpAddress: '52.10.0.2', status: 'DOWN' },
      ],
      tags: { Name: 'HQ-Backup-VPN' },
    },
  ],
  customerGateways: [
    {
      customerGatewayId: 'cgw-hide01',
      bgpAsn: '65100',
      ipAddress: '203.0.113.10',
      state: 'available',
      type: 'ipsec.1',
      tags: { Name: 'HQ-Router' },
    },
  ],
};

const vpnHidden: TopologyData = { ...dxAndVpn, vpnConnections: [] };

const isVpnArtifact = (n: DxNode) =>
  n.id.startsWith('vpn-') ||
  n.id.startsWith('onprem-vpn-') ||
  n.id.startsWith('custsite-vpn-');

describe('hide VPN — graph', () => {
  it('renders the VPN connection and its on-prem router when the filter is off', () => {
    const { nodes } = buildGraph(dxAndVpn, new Set());
    expect(nodes.find((n) => n.id === 'vpn-vpn-hide01')).toBeDefined();
    expect(nodes.find((n) => n.id === 'onprem-vpn-cgw-hide01')).toBeDefined();
  });

  it('emits no VPN node of any kind when the filter is on', () => {
    const { nodes } = buildGraph(vpnHidden, new Set());
    expect(nodes.filter(isVpnArtifact)).toEqual([]);
  });

  it('emits no VPN tunnel edge when the filter is on', () => {
    const { nodes, edges } = buildGraph(vpnHidden, new Set());
    const ids = new Set(nodes.map((n) => n.id));
    // No edge may dangle off a node the strip removed, in either direction.
    for (const e of edges) {
      expect(ids.has(e.source)).toBe(true);
      expect(ids.has(e.target)).toBe(true);
    }
    // label is typed as ReactNode; the builder only ever puts a string there.
    expect(edges.some((e) => String(e.label ?? '').includes('VPN Tunnel'))).toBe(false);
  });

  it('leaves the DX topology completely intact', () => {
    const withVpn = buildGraph(dxAndVpn, new Set()).nodes;
    const without = buildGraph(vpnHidden, new Set()).nodes;

    // Every non-VPN node in the unfiltered graph must survive the filter.
    const survivingIds = new Set(without.map((n) => n.id));
    for (const n of withVpn.filter((x) => !isVpnArtifact(x))) {
      expect(survivingIds.has(n.id)).toBe(true);
    }
    // And both DXGWs are still there — a sanity check that we compared a real
    // DX graph rather than two empty ones.
    expect(without.find((n) => n.id === 'dxgw-dxgw-mdx-prod')).toBeDefined();
    expect(without.find((n) => n.id === 'dxgw-dxgw-mdx-corp')).toBeDefined();
  });

  it('drops the VGW top handle that only the VPN tunnel needed', () => {
    const withVpn = buildGraph(dxAndVpn, new Set()).nodes;
    const without = buildGraph(vpnHidden, new Set()).nodes;
    // addVpnSubgraph stamps hasTopHandle on the tunnel's destination gateway.
    // With no tunnel, the handle must not render or the VGW shows a dot with
    // no edge attached to it.
    expect(withVpn.find((n) => n.id === 'vgw-vgw-mdx-prod')?.data.hasTopHandle).toBe(true);
    expect(without.find((n) => n.id === 'vgw-vgw-mdx-prod')?.data.hasTopHandle).toBeFalsy();
  });
});

describe('hide VPN — layout', () => {
  function absTop(byId: Map<string, DxNode>, n: DxNode): number {
    let y = n.position.y;
    let cur = n.parentId ? byId.get(n.parentId) : undefined;
    while (cur) {
      y += cur.position.y;
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return y;
  }

  // The whole reason the filter strips before buildGraph instead of filtering
  // rendered nodes: applyLayout reserves a horizontal band above the DX rows
  // sized to the VPN section. Filter the nodes afterwards and the band stays
  // behind as empty canvas.
  it('reclaims the vertical band the VPN section reserved above the DX rows', () => {
    const layoutFor = (t: TopologyData) => {
      const { nodes, edges } = buildGraph(t, new Set());
      const laid = applyLayout(nodes, edges);
      const byId = new Map(laid.map((n) => [n.id, n]));
      const dxgw = laid.find((n) => n.id === 'dxgw-dxgw-mdx-prod');
      expect(dxgw).toBeDefined();
      return absTop(byId, dxgw!);
    };
    expect(layoutFor(vpnHidden)).toBeLessThan(layoutFor(dxAndVpn));
  });
});

describe('hide VPN — assessment is unaffected', () => {
  const ruleIds = (t: TopologyData) =>
    new Set(analyzeTopology(t).bestPractice.recommendations.map((r) => r.ruleId));

  it('keeps reporting the degraded tunnel, which is what the filter must not silence', () => {
    // The app grades the FULL topology even while the canvas hides VPN, so this
    // finding has to survive the filter being on.
    expect(ruleIds(dxAndVpn).has('vpn-tunnel-redundancy')).toBe(true);
  });

  it('would invent a "no VPN backup" warning if it graded the filtered copy', () => {
    // This is the trap the split exists to avoid: bp-no-vpn-backup is credit for
    // HAVING a VPN, so grading the stripped topology flips a healthy account
    // into a warning. If this ever stops holding, the guard in
    // rebuildFromTopology has become load-bearing for a different reason.
    expect(ruleIds(dxAndVpn).has('no-vpn-backup')).toBe(false);
    expect(ruleIds(vpnHidden).has('no-vpn-backup')).toBe(true);
  });
});
