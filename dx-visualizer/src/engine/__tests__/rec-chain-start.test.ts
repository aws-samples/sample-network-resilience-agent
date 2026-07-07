import { describe, it, expect } from 'vitest';
import { analyzeTopology } from '../recommendation-engine';
import {
  ruleSingleDxLocation,
  ruleSingleConnectionPerLocation,
  ruleLagResiliency,
} from '../resiliency-rules';
import {
  rulePublicVifSingleLocation,
  rulePublicVifSingleConnectionPerLocation,
} from '../public-vif-rules';
import { secondLocationGhostChain } from '../ghost-chains';
import { makeEmptyTopology } from './helpers';
import type { DxNode } from '../../types/topology';

/**
 * CROSS-CUTTING DESIGN RULE (applies to ALL resiliency recommendations —
 * DXGW, LAG, and public endpoints):
 *
 *   A recommended (ghost) chain must START at the Customer / Partner Device
 *   (a `dxPartnerDevice` node) and flow inward toward AWS. It must NOT mint any
 *   customer-premises ghost nodes further out on the path:
 *     - no `customerSite` ghost  ("Customer Data Center")
 *     - no `onPremise`   ghost  ("Customer Gateway" / "Second On-Prem Router")
 *
 * These are black-box tests: they assert only on the public shape of the
 * emitted recommendation nodes/edges, never on internal implementation.
 */

const CUSTOMER_PREMISES_CATEGORIES = ['customerSite', 'onPremise'];

function ghostNodesOf(nodes: DxNode[]): DxNode[] {
  return nodes.filter((n) => n.data.isRecommended);
}

function assertNoCustomerPremisesGhosts(nodes: DxNode[]) {
  const offenders = ghostNodesOf(nodes).filter((n) =>
    CUSTOMER_PREMISES_CATEGORIES.includes(n.data.category as string),
  );
  expect(offenders.map((n) => `${n.id} (${n.data.category})`)).toEqual([]);
}

/** A single-connection topology whose lone location will trigger a second-location rec. */
function singleLocationTopology() {
  const t = makeEmptyTopology();
  t.connections = [
    { connectionId: 'c1', location: 'EqSG1', connectionState: 'available', bandwidth: '1Gbps', awsLogicalDeviceId: 'lg1', tags: {} } as any,
  ];
  t.locations = [{ locationCode: 'EqSG1', locationName: 'Equinix SG1' } as any];
  return t;
}

describe('rec chain starts at Customer / Partner Device — shared builder', () => {
  for (const target of ['high', 'maximum'] as const) {
    it(`secondLocationGhostChain (${target}) mints no customerSite / onPremise ghost`, () => {
      const { nodes } = secondLocationGhostChain({
        prefix: 'rec',
        locCode: 'rec-loc-B',
        sinks: [{ nodeId: 'dxgw-gw-1', label: 'VIF' }],
        target,
      });
      assertNoCustomerPremisesGhosts(nodes);
      // The innermost customer-side node kept is the partner device.
      expect(nodes.find((n) => n.id === 'rec-partner-B')).toBeDefined();
    });
  }

  it('the ghost backbone begins partner -> awsDevice (no on-prem -> partner edge)', () => {
    const { nodes, edges } = secondLocationGhostChain({
      prefix: 'rec',
      locCode: 'rec-loc-B',
      sinks: [{ nodeId: 'dxgw-gw-1', label: 'VIF' }],
      target: 'high',
    });
    // No edge originates from a customer-premises ghost node.
    const premiseIds = new Set(
      ghostNodesOf(nodes)
        .filter((n) => CUSTOMER_PREMISES_CATEGORIES.includes(n.data.category as string))
        .map((n) => n.id),
    );
    expect(edges.some((e) => premiseIds.has(e.source))).toBe(false);
    // First backbone hop is partner -> awsDevice.
    expect(edges.find((e) => e.source === 'rec-partner-B' && e.target === 'rec-awsdev-B')).toBeDefined();
  });
});

describe('rec chain starts at Customer / Partner Device — DXGW rule', () => {
  it('ruleSingleDxLocation (high) emits no customer-premises ghost', () => {
    const rec = ruleSingleDxLocation(singleLocationTopology(), 'high', 'gw-1', 'My-GW')!;
    assertNoCustomerPremisesGhosts(rec.additionalNodes);
  });

  it('ruleSingleDxLocation (maximum) emits no customer-premises ghost', () => {
    const rec = ruleSingleDxLocation(singleLocationTopology(), 'maximum', 'gw-1', 'My-GW')!;
    assertNoCustomerPremisesGhosts(rec.additionalNodes);
  });

  it('ruleSingleConnectionPerLocation emits no customer-premises ghost', () => {
    const recs = ruleSingleConnectionPerLocation(singleLocationTopology(), 'maximum', 'gw-1');
    recs.forEach((r) => assertNoCustomerPremisesGhosts(r.additionalNodes));
  });
});

describe('rec chain starts at Customer / Partner Device — public endpoints rule', () => {
  it('rulePublicVifSingleLocation (high) emits no customer-premises ghost', () => {
    assertNoCustomerPremisesGhosts(rulePublicVifSingleLocation(singleLocationTopology(), 'high')!.additionalNodes);
  });

  it('rulePublicVifSingleLocation (maximum) emits no customer-premises ghost', () => {
    assertNoCustomerPremisesGhosts(rulePublicVifSingleLocation(singleLocationTopology(), 'maximum')!.additionalNodes);
  });

  it('rulePublicVifSingleConnectionPerLocation emits no customer-premises ghost', () => {
    rulePublicVifSingleConnectionPerLocation(singleLocationTopology(), 'maximum')
      .forEach((r) => assertNoCustomerPremisesGhosts(r.additionalNodes));
  });
});

describe('rec chain starts at Customer / Partner Device — LAG rule (already conforms)', () => {
  it('ruleLagResiliency emits no customer-premises ghost', () => {
    const t = makeEmptyTopology();
    t.lags = [
      { lagId: 'lag-1', lagName: 'LAG-A', location: 'EqSG1', lagState: 'available', connectionsBandwidth: '1Gbps', numberOfConnections: 2, minimumLinks: 1, connections: [] } as any,
    ];
    t.locations = [{ locationCode: 'EqSG1', locationName: 'Equinix SG1' } as any];
    ruleLagResiliency(t, 'maximum').forEach((r) => assertNoCustomerPremisesGhosts(r.additionalNodes));
  });
});

describe('rec chain starts at Customer / Partner Device — whole-assessment sweep', () => {
  it('no recommendation anywhere in analyzeTopology mints a customer-premises ghost', () => {
    const t = singleLocationTopology();
    t.virtualInterfaces = [
      { virtualInterfaceId: 'vif-priv', virtualInterfaceType: 'private', directConnectGatewayId: 'gw-1', connectionId: 'c1', location: 'EqSG1', bgpPeers: [], tags: {} } as any,
      { virtualInterfaceId: 'vif-pub', virtualInterfaceType: 'public', connectionId: 'c1', location: 'EqSG1', bgpPeers: [], tags: {} } as any,
    ];
    t.dxGateways = [{ directConnectGatewayId: 'gw-1', directConnectGatewayName: 'My-GW', tags: {} } as any];

    for (const target of ['high', 'maximum'] as const) {
      const a = analyzeTopology(t, target);
      const allRecs = [
        ...a.perDxGateway.flatMap((g) => g.recommendations),
        ...(a.publicVif?.recommendations ?? []),
        ...(a.lag?.recommendations ?? []),
        ...a.resiliency.recommendations,
      ];
      assertNoCustomerPremisesGhosts(allRecs.flatMap((r) => r.additionalNodes));
    }
  });
});
