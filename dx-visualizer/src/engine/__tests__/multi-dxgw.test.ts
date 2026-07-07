import { describe, it, expect } from 'vitest';
import { analyzeTopology, getRecommendedGraph } from '../recommendation-engine';
import { multiDxgwTopology } from './fixtures/multi-dxgw-topology';
import type { DxNode } from '../../types/topology';

/**
 * Multi-DXGW scenario: a "No Resiliency" posture with TWO DX locations and TWO
 * DX Gateways, where each DXGW is fed by exactly ONE location (single connection
 * each). The topology looks multi-site at a glance, but every DXGW is single-site
 * on its own — so each must independently earn a "second location" recommendation.
 */

const CUSTOMER_PREMISES_CATEGORIES = ['customerSite', 'onPremise'];

function assertNoCustomerPremisesGhosts(nodes: DxNode[]) {
  const offenders = nodes
    .filter((n) => n.data.isRecommended)
    .filter((n) => CUSTOMER_PREMISES_CATEGORIES.includes(n.data.category as string));
  expect(offenders.map((n) => `${n.id} (${n.data.category})`)).toEqual([]);
}

describe('Multi-DXGW scenario', () => {
  it('has exactly two DX locations and two DX gateways', () => {
    expect(multiDxgwTopology.locations).toHaveLength(2);
    expect(multiDxgwTopology.dxGateways).toHaveLength(2);
  });

  it('connects each DXGW to exactly one distinct location', () => {
    const t = multiDxgwTopology;
    const connLocation = new Map(t.connections.map((c) => [c.connectionId, c.location]));

    const locationsByDxgw = new Map<string, Set<string>>();
    for (const vif of t.virtualInterfaces) {
      if (!vif.directConnectGatewayId) continue;
      const loc = vif.location ?? (vif.connectionId ? connLocation.get(vif.connectionId) : undefined);
      if (!loc) continue;
      if (!locationsByDxgw.has(vif.directConnectGatewayId)) {
        locationsByDxgw.set(vif.directConnectGatewayId, new Set());
      }
      locationsByDxgw.get(vif.directConnectGatewayId)!.add(loc);
    }

    expect(locationsByDxgw.size).toBe(2);
    for (const locs of locationsByDxgw.values()) {
      expect(locs.size).toBe(1);
    }
    // The two DXGWs must sit at different locations (not both on the same site).
    const allLocs = [...locationsByDxgw.values()].flatMap((s) => [...s]);
    expect(new Set(allLocs).size).toBe(2);
  });

  it('assesses each DXGW independently as single-site (devtest)', () => {
    const assessment = analyzeTopology(multiDxgwTopology);
    expect(assessment.perDxGateway).toHaveLength(2);
    for (const gw of assessment.perDxGateway) {
      expect(gw.currentLevel).toBe('devtest');
      expect(gw.locationCount).toBe(1);
      const ruleIds = gw.recommendations.map((r) => r.ruleId);
      expect(ruleIds).toContain('single-dx-location');
    }
  });

  it('emits a distinct DXGW-scoped second-location rec per gateway', () => {
    const assessment = analyzeTopology(multiDxgwTopology);
    const recIds = assessment.perDxGateway
      .flatMap((g) => g.recommendations)
      .filter((r) => r.ruleId === 'single-dx-location')
      .map((r) => r.id);
    // Two gateways → two uniquely-scoped recommendations.
    expect(recIds).toHaveLength(2);
    expect(new Set(recIds).size).toBe(2);
  });

  it('scopes each focused ghost graph to its own gateway', () => {
    const assessment = analyzeTopology(multiDxgwTopology);
    for (const gw of assessment.perDxGateway) {
      const { nodes } = getRecommendedGraph(assessment, gw.dxGatewayId);
      expect(nodes.length).toBeGreaterThan(0);
      // Ghost chain must fan out only to this gateway's node.
      const { edges } = getRecommendedGraph(assessment, gw.dxGatewayId);
      const sinkTargets = edges.map((e) => e.target).filter((t) => t.startsWith('dxgw-'));
      for (const target of sinkTargets) {
        expect(target).toBe(`dxgw-${gw.dxGatewayId}`);
      }
    }
  });

  it('ghost recommendation chains start at the Customer / Partner Device (no premises ghosts)', () => {
    const assessment = analyzeTopology(multiDxgwTopology);
    const allGhostNodes = assessment.perDxGateway.flatMap((g) =>
      g.recommendations.flatMap((r) => r.additionalNodes),
    );
    assertNoCustomerPremisesGhosts(allGhostNodes);
  });

  it.each(['high', 'maximum'] as const)('no ghost edge links back to an on-prem / customer node (target=%s)', (target) => {
    const assessment = analyzeTopology(multiDxgwTopology, target);
    const allGhostEdges = assessment.perDxGateway.flatMap((g) =>
      g.recommendations.flatMap((r) => r.additionalEdges),
    );
    const offenders = allGhostEdges.filter(
      (e) => e.source.startsWith('onprem-') || e.target.startsWith('onprem-')
        || e.source.startsWith('custsite-') || e.target.startsWith('custsite-'),
    );
    expect(offenders.map((e) => `${e.source}->${e.target}`)).toEqual([]);
  });

  // --- Reuse-existing-DX-location rule ---
  // When a topology already has another DX location with AWS devices, a
  // second-location recommendation must REUSE that existing location rather than
  // minting a brand-new ghost "Second Direct Connect Location". A new ghost
  // location is minted only when there is no other existing location to reuse.
  describe.each(['high', 'maximum'] as const)('reuse existing location (target=%s)', (target) => {
    it('does NOT mint a ghost "Second Direct Connect Location" for either DXGW', () => {
      const assessment = analyzeTopology(multiDxgwTopology, target);
      const ghostLocations = assessment.perDxGateway
        .flatMap((g) => g.recommendations)
        .flatMap((r) => r.additionalNodes)
        .filter((n) => n.data.isRecommended && n.data.category === 'dxLocation');
      expect(ghostLocations).toEqual([]);
    });

    it('attaches each ghost chain to the OTHER gateway\'s existing location', () => {
      const assessment = analyzeTopology(multiDxgwTopology, target);
      const locFor = new Map([
        ['dxgw-mdx-prod', 'EqSG2'],
        ['dxgw-mdx-corp', 'EqSG3'],
      ]);
      for (const gw of assessment.perDxGateway) {
        const secondLocRec = gw.recommendations.find((r) => r.ruleId === 'single-dx-location');
        expect(secondLocRec).toBeDefined();
        const ghostDevices = secondLocRec!.additionalNodes.filter(
          (n) => n.data.isRecommended && n.data.category === 'awsDevice',
        );
        expect(ghostDevices.length).toBeGreaterThan(0);
        // The reused location is the OTHER gateway's existing site, never its own.
        const ownLoc = locFor.get(gw.dxGatewayId);
        const otherLoc = ownLoc === 'EqSG2' ? 'EqSG3' : 'EqSG2';
        for (const dev of ghostDevices) {
          const lc = (dev.data.details as Record<string, string> | undefined)?.locationCode;
          expect(lc).toBe(otherLoc);
        }
      }
    });
  });
});
