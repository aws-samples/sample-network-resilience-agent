import { describe, it, expect } from 'vitest';
import { highResiliencyTopology } from '../../utils/mock-data';
import { analyzeTopology, getRecommendedGraph, FOCUSED_LAG, FOCUSED_PUBLIC_VIF } from '../recommendation-engine';
import type { DxNode, DxEdge, TopologyData } from '../../types/topology';

/**
 * PUBLIC ENDPOINT SINK COUNT — the core invariant
 * ===============================================
 *
 * The recommendation is validated from the AWS Public Endpoints node's point of
 * view: how many total upstream links (REAL + RECOMMENDED) terminate on it.
 *
 *   - Maximum resiliency → 4 total sinks (2 from each of 2 DX locations)
 *   - High resiliency    → 2 total sinks (1 from each of 2 DX locations)
 *
 * Recommendations always REUSE existing DX locations first (never mint a new
 * "Second Direct Connect Location" when real locations exist), and reuse the
 * carrier (DXGW/LAG) ghost devices rather than minting a duplicate LAG per
 * location.
 *
 * The High-Resiliency mock spans 2 real locations (EqSG2, EqSG3), each with one
 * real LAG and one real public VIF (2 real public sinks total).
 */

/** Real public VIFs each contribute one edge to pub-endpoints. */
function realPublicSinks(t: TopologyData): number {
  return t.virtualInterfaces.filter((v) => v.virtualInterfaceType === 'public').length;
}
function ghostPubSinks(edges: DxEdge[]): number {
  return edges.filter((e) => e.target === 'pub-endpoints').length;
}
function lagNodes(nodes: DxNode[]): DxNode[] {
  return nodes.filter((n) => n.data.isRecommended && n.data.category === 'lag');
}
function mintedLocations(nodes: DxNode[]): DxNode[] {
  return nodes.filter((n) => n.data.isRecommended && n.data.category === 'dxLocation');
}
function locOf(n: DxNode): string {
  return (n.data.details as Record<string, string> | undefined)?.locationCode ?? '';
}

describe('high-res mock: public endpoint sink count', () => {
  it('MAXIMUM → public endpoint reaches exactly 4 total sinks', () => {
    const a = analyzeTopology(highResiliencyTopology, { [FOCUSED_LAG]: 'maximum', [FOCUSED_PUBLIC_VIF]: 'maximum' });
    const { nodes, edges } = getRecommendedGraph(a, FOCUSED_PUBLIC_VIF);
    const total = realPublicSinks(highResiliencyTopology) + ghostPubSinks(edges);
    expect(total).toBe(4);
    // Reuse existing locations — never mint a new ghost DX location.
    expect(mintedLocations(nodes)).toEqual([]);
  });

  it('HIGH → public endpoint reaches exactly 2 total sinks', () => {
    const a = analyzeTopology(highResiliencyTopology, { [FOCUSED_LAG]: 'high', [FOCUSED_PUBLIC_VIF]: 'high' });
    const { nodes, edges } = getRecommendedGraph(a, FOCUSED_PUBLIC_VIF);
    const total = realPublicSinks(highResiliencyTopology) + ghostPubSinks(edges);
    expect(total).toBe(2);
    expect(mintedLocations(nodes)).toEqual([]);
  });

  it('MAXIMUM → exactly one recommended LAG per location (no duplicate per location)', () => {
    const a = analyzeTopology(highResiliencyTopology, { [FOCUSED_LAG]: 'maximum', [FOCUSED_PUBLIC_VIF]: 'maximum' });
    const { nodes } = getRecommendedGraph(a, FOCUSED_LAG);
    const byLoc = new Map<string, number>();
    for (const n of lagNodes(nodes)) byLoc.set(locOf(n), (byLoc.get(locOf(n)) ?? 0) + 1);
    expect(byLoc.get('EqSG2')).toBe(1);
    expect(byLoc.get('EqSG3')).toBe(1);
  });

  it('MAXIMUM → the focused public graph never doubles the LAG per location', () => {
    const a = analyzeTopology(highResiliencyTopology, { [FOCUSED_LAG]: 'maximum', [FOCUSED_PUBLIC_VIF]: 'maximum' });
    const { nodes } = getRecommendedGraph(a, FOCUSED_PUBLIC_VIF);
    const byLoc = new Map<string, number>();
    for (const n of lagNodes(nodes)) byLoc.set(locOf(n), (byLoc.get(locOf(n)) ?? 0) + 1);
    for (const [, count] of byLoc) expect(count).toBeLessThanOrEqual(1);
  });
});
