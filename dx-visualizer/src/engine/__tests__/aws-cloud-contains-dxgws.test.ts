import { describe, it, expect } from 'vitest';
import { multiDxgwTopology } from './fixtures/multi-dxgw-topology';
import { buildGraph } from '../topology-builder';
import { applyLayout } from '../layout-engine';
import { analyzeTopology, getRecommendedGraph } from '../recommendation-engine';
import type { DxNode, DxEdge } from '../../types/topology';

/**
 * AWS Cloud container must fully contain its DX Gateway children
 * =============================================================
 *
 * Step 9.1 re-centers each DXGW on its awsDevice-peer row (absolute coords).
 * A DXGW whose peers sit near the TOP DX location can be lifted above the AWS
 * Cloud's inner top — which was sized earlier — leaving the gateway rendered
 * OUTSIDE the container border. The container must be re-fit so every DXGW
 * (and coreNetwork) child stays within its bounds, top and bottom.
 *
 * Regression: multiDxgwTopology (two DXGWs, one per DX location) rendered
 * DXGW-Prod-SG2 above the AWS box.
 */

function absYRange(node: DxNode, byId: Map<string, DxNode>): { top: number; bottom: number } {
  // aws-cloud children carry positions relative to the cloud; add the parent.
  const parent = node.parentId ? byId.get(node.parentId) : undefined;
  const parentY = parent ? (parent.position.y as number) : 0;
  const top = parentY + (node.position.y as number);
  const h = (node.height as number | undefined) ?? 80;
  return { top, bottom: top + h };
}

function assertDxgwsInsideCloud(nodes: DxNode[]) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const cloud = nodes.find((n) => n.data.category === 'awsCloud');
  expect(cloud).toBeDefined();
  const cloudTop = cloud!.position.y as number;
  const cloudBottom = cloudTop + (cloud!.height as number);

  const dxgws = nodes.filter((n) => n.data.category === 'dxGateway');
  expect(dxgws.length).toBeGreaterThan(0);
  for (const gw of dxgws) {
    // A DXGW parented to aws-cloud has cloud-relative coords; others are absolute.
    const { top, bottom } = gw.parentId === cloud!.id
      ? { top: cloudTop + (gw.position.y as number), bottom: cloudTop + (gw.position.y as number) + ((gw.height as number | undefined) ?? 80) }
      : absYRange(gw, byId);
    expect(top, `${gw.id} top ${top} >= cloud top ${cloudTop}`).toBeGreaterThanOrEqual(cloudTop);
    expect(bottom, `${gw.id} bottom ${bottom} <= cloud bottom ${cloudBottom}`).toBeLessThanOrEqual(cloudBottom);
  }
}

describe('AWS Cloud contains all DX Gateways', () => {
  it('base (current) view — multiDxgw', () => {
    const { nodes, edges } = buildGraph(multiDxgwTopology, new Set());
    const laid = applyLayout(nodes as DxNode[], edges as DxEdge[]);
    assertDxgwsInsideCloud(laid);
  });

  it('recommended view — multiDxgw at maximum (no focus)', () => {
    const base = buildGraph(multiDxgwTopology, new Set());
    const rec = getRecommendedGraph(analyzeTopology(multiDxgwTopology, 'maximum'));
    const nodes = [...base.nodes, ...rec.nodes] as DxNode[];
    const edges = [...base.edges, ...rec.edges] as DxEdge[];
    const laid = applyLayout(nodes, edges);
    assertDxgwsInsideCloud(laid);
  });

  // The app renders the recommended view focused on a specific DXGW. When the
  // focused gateway's ghost peers pull the cloud/region block down, an UNfocused
  // gateway aligned to a top DX location was left ABOVE the container top
  // (negative relative Y) — the DXGW-Prod-SG2-outside-the-box regression.
  it.each(['dxgw-mdx-prod', 'dxgw-mdx-corp'])('recommended view focused on %s', (focus) => {
    const base = buildGraph(multiDxgwTopology, new Set());
    const rec = getRecommendedGraph(analyzeTopology(multiDxgwTopology, 'maximum'), focus);
    const nodes = [...base.nodes, ...rec.nodes] as DxNode[];
    const edges = [...base.edges, ...rec.edges] as DxEdge[];
    const laid = applyLayout(nodes, edges);
    assertDxgwsInsideCloud(laid);
  });
});
