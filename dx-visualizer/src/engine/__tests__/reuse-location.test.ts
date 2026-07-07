import { describe, it, expect } from 'vitest';
import { analyzeTopology } from '../recommendation-engine';
import { ruleSingleDxLocation, ruleLagResiliency } from '../resiliency-rules';
import { rulePublicVifSingleLocation } from '../public-vif-rules';
import { findReusableLocation, MAX_DEVICES_PER_LOCATION } from '../sla-gating';
import { makeEmptyTopology } from './helpers';
import type { DxNode } from '../../types/topology';

/**
 * REUSE-EXISTING-LOCATION RULE (applies to all second-location recommendations):
 *
 *   Prefer reusing an EXISTING DX location that has AWS logical devices over
 *   minting a brand-new ghost "Second Direct Connect Location". Only mint a new
 *   ghost location when no other existing location is available to reuse.
 *
 *   Capacity: a location is reusable only while it has FEWER than 2 logical
 *   devices (real + ghost already assigned this pass). A location that already
 *   has 2+ pre-existing devices is skipped as a reuse target — but its extra
 *   devices are NEVER recommended for removal; we simply cap at 2 for tiering.
 */

function ghostLocations(nodes: DxNode[]): DxNode[] {
  return nodes.filter((n) => n.data.isRecommended && n.data.category === 'dxLocation');
}
function ghostDeviceLocCodes(nodes: DxNode[]): string[] {
  return nodes
    .filter((n) => n.data.isRecommended && n.data.category === 'awsDevice')
    .map((n) => (n.data.details as Record<string, string> | undefined)?.locationCode ?? '');
}

describe('findReusableLocation', () => {
  const t = makeEmptyTopology();
  t.locations = [
    { locationCode: 'LocA', locationName: 'A', region: 'ap-southeast-1', availablePortSpeeds: [] },
    { locationCode: 'LocB', locationName: 'B', region: 'ap-southeast-1', availablePortSpeeds: [] },
  ];
  t.connections = [
    { connectionId: 'c1', location: 'LocA', connectionState: 'available', bandwidth: '1Gbps', awsLogicalDeviceId: 'devA1', tags: {} } as any,
    { connectionId: 'c2', location: 'LocB', connectionState: 'available', bandwidth: '1Gbps', awsLogicalDeviceId: 'devB1', tags: {} } as any,
  ];

  it('reuses a different existing location with device capacity', () => {
    const counts = new Map([['LocA', 1], ['LocB', 1]]);
    expect(findReusableLocation(t, ['LocA'], counts)).toBe('LocB');
  });

  it('excludes the scope\'s own location', () => {
    const counts = new Map([['LocA', 1], ['LocB', 1]]);
    expect(findReusableLocation(t, ['LocB'], counts)).toBe('LocA');
  });

  it('prefers a location with spare device capacity over a full one', () => {
    // LocA is at the 2-device cap; LocB has room → prefer LocB so ghost devices
    // spread across sites rather than piling onto the full location.
    const counts = new Map([['LocA', MAX_DEVICES_PER_LOCATION], ['LocB', 1]]);
    expect(findReusableLocation(t, [], counts)).toBe('LocB');
  });

  it('still reuses a well-provisioned location when none have spare capacity', () => {
    // Both locations already device-redundant (>=2, incl. one with MORE than 2).
    // Reuse is still preferred over minting a new ghost location — a fuller site
    // is a perfectly good (already-redundant) reuse target. We NEVER mint a new
    // location just because existing ones are well-provisioned, and never
    // recommend removing the extra pre-existing devices.
    const counts = new Map([['LocA', 5], ['LocB', 4]]);
    expect(findReusableLocation(t, [], counts)).toBe('LocA');
    expect(findReusableLocation(t, ['LocA'], counts)).toBe('LocB');
  });

  it('returns undefined only when there is no OTHER existing location to reuse', () => {
    const counts = new Map([['LocA', 5]]);
    expect(findReusableLocation(t, ['LocA'], counts)).toBeUndefined();
  });
});

describe('rule-level reuse (mint only when no reuse location given)', () => {
  function singleLocScope() {
    const t = makeEmptyTopology();
    t.locations = [{ locationCode: 'LocA', locationName: 'A', region: 'ap-southeast-1', availablePortSpeeds: [] }];
    t.connections = [
      { connectionId: 'c1', location: 'LocA', connectionState: 'available', bandwidth: '1Gbps', awsLogicalDeviceId: 'devA1', tags: {} } as any,
    ];
    t.dxGateways = [{ directConnectGatewayId: 'gw1', directConnectGatewayName: 'GW1', amazonSideAsn: 64512, directConnectGatewayState: 'available' }];
    return t;
  }

  describe.each(['high', 'maximum'] as const)('target=%s', (target) => {
    it('ruleSingleDxLocation mints a ghost location when no reuse code is provided', () => {
      const rec = ruleSingleDxLocation(singleLocScope(), target, 'gw1', 'GW1');
      expect(rec).not.toBeNull();
      expect(ghostLocations(rec!.additionalNodes).length).toBe(1);
    });

    it('ruleSingleDxLocation reuses (no ghost location) when a reuse code is provided', () => {
      const rec = ruleSingleDxLocation(singleLocScope(), target, 'gw1', 'GW1', false, 'LocB');
      expect(rec).not.toBeNull();
      expect(ghostLocations(rec!.additionalNodes)).toEqual([]);
      for (const lc of ghostDeviceLocCodes(rec!.additionalNodes)) expect(lc).toBe('LocB');
      expect(rec!.description).toContain('LocB');
    });

    it('rulePublicVifSingleLocation reuses when a reuse code is provided', () => {
      const t = makeEmptyTopology();
      t.locations = [{ locationCode: 'LocA', locationName: 'A', region: 'ap-southeast-1', availablePortSpeeds: [] }];
      t.virtualInterfaces = [
        { virtualInterfaceId: 'pub1', virtualInterfaceType: 'public', virtualInterfaceState: 'available', connectionId: 'c1', location: 'LocA', vlan: 1, asn: 1, bgpPeers: [] } as any,
      ];
      t.connections = [
        { connectionId: 'c1', location: 'LocA', connectionState: 'available', bandwidth: '1Gbps', awsLogicalDeviceId: 'devA1', tags: {} } as any,
      ];
      const minted = rulePublicVifSingleLocation(t, target);
      expect(ghostLocations(minted!.additionalNodes).length).toBe(1);

      const reused = rulePublicVifSingleLocation(t, target, 'LocB');
      expect(ghostLocations(reused!.additionalNodes)).toEqual([]);
      for (const lc of ghostDeviceLocCodes(reused!.additionalNodes)) expect(lc).toBe('LocB');
    });

    it('ruleLagResiliency reuses when a reuse code is provided', () => {
      const t = makeEmptyTopology();
      t.locations = [{ locationCode: 'LocA', locationName: 'A', region: 'ap-southeast-1', availablePortSpeeds: [] }];
      t.lags = [
        { lagId: 'lag1', lagName: 'LAG1', connectionsBandwidth: '1Gbps', numberOfConnections: 1, minimumLinks: 1, location: 'LocA', region: 'ap-southeast-1', lagState: 'available', connections: [{ connectionId: 'c1', connectionName: 'C1', connectionState: 'available', location: 'LocA', bandwidth: '1Gbps', lagId: 'lag1' }] } as any,
      ];
      const minted = ruleLagResiliency(t, target, 'gw1');
      expect(ghostLocations(minted.flatMap((r) => r.additionalNodes)).length).toBe(1);

      const reused = ruleLagResiliency(t, target, 'gw1', 'LocB');
      expect(ghostLocations(reused.flatMap((r) => r.additionalNodes))).toEqual([]);
    });
  });
});

describe('capacity accounting across the analysis pass', () => {
  it('two single-location DXGWs each reuse the OTHER existing location, never overfilling', () => {
    // Two locations, each with one device, feeding one DXGW each. Each DXGW's
    // reuse target is the other's location; neither exceeds 2 devices.
    const t = makeEmptyTopology();
    t.locations = [
      { locationCode: 'LocA', locationName: 'A', region: 'ap-southeast-1', availablePortSpeeds: [] },
      { locationCode: 'LocB', locationName: 'B', region: 'ap-southeast-1', availablePortSpeeds: [] },
    ];
    t.connections = [
      { connectionId: 'cA', location: 'LocA', connectionState: 'available', bandwidth: '1Gbps', awsLogicalDeviceId: 'devA1', tags: {} } as any,
      { connectionId: 'cB', location: 'LocB', connectionState: 'available', bandwidth: '1Gbps', awsLogicalDeviceId: 'devB1', tags: {} } as any,
    ];
    t.virtualInterfaces = [
      { virtualInterfaceId: 'vA', virtualInterfaceType: 'private', virtualInterfaceState: 'available', connectionId: 'cA', directConnectGatewayId: 'gwA', location: 'LocA', vlan: 1, asn: 1, bgpPeers: [] } as any,
      { virtualInterfaceId: 'vB', virtualInterfaceType: 'private', virtualInterfaceState: 'available', connectionId: 'cB', directConnectGatewayId: 'gwB', location: 'LocB', vlan: 2, asn: 2, bgpPeers: [] } as any,
    ];
    t.dxGateways = [
      { directConnectGatewayId: 'gwA', directConnectGatewayName: 'GW-A', amazonSideAsn: 64512, directConnectGatewayState: 'available' },
      { directConnectGatewayId: 'gwB', directConnectGatewayName: 'GW-B', amazonSideAsn: 64513, directConnectGatewayState: 'available' },
    ];

    const assessment = analyzeTopology(t, 'high');
    const allGhostNodes = assessment.perDxGateway.flatMap((g) => g.recommendations.flatMap((r) => r.additionalNodes));
    // No ghost locations minted — both reuse existing sites.
    expect(ghostLocations(allGhostNodes)).toEqual([]);
  });

  it('reuses a second location that has a sink-connected path with capacity for a single-location LAG', () => {
    // Revised sink-aware rule: a LAG lives at LocA, and a SECOND real location
    // LocB has ONE sink-connected (DXGW-facing) logical device — spare capacity
    // (< 2) and no LAG of its own. The LAG rec must REUSE LocB rather than mint a
    // "Second Direct Connect Location" ghost, and because LocB has no real LAG the
    // ghost path there is a PLAIN (non-LAG) path, not a ghost LAG (Rule 1).
    const t = makeEmptyTopology();
    t.locations = [
      { locationCode: 'LocA', locationName: 'A', region: 'eu-west-2', availablePortSpeeds: [] },
      { locationCode: 'LocB', locationName: 'B', region: 'eu-west-2', availablePortSpeeds: [] },
    ];
    // LocA: a LAG feeding the DXGW. LocB: one plain DXGW-facing device.
    t.connections = [
      { connectionId: 'cA1', location: 'LocA', connectionState: 'available', bandwidth: '10Gbps', awsLogicalDeviceId: 'devA1', lagId: 'lag1', tags: {} } as any,
      { connectionId: 'cB1', location: 'LocB', connectionState: 'available', bandwidth: '10Gbps', awsLogicalDeviceId: 'devB1', tags: {} } as any,
    ];
    t.lags = [
      { lagId: 'lag1', lagName: 'LAG-A', connectionsBandwidth: '10Gbps', numberOfConnections: 2, minimumLinks: 0, location: 'LocA', region: 'eu-west-2', lagState: 'available', connections: [{ connectionId: 'cA1', connectionName: 'cA1', connectionState: 'available', location: 'LocA', bandwidth: '10Gbps', lagId: 'lag1' }] } as any,
    ];
    t.virtualInterfaces = [
      { virtualInterfaceId: 'vA', virtualInterfaceType: 'private', virtualInterfaceState: 'available', connectionId: 'cA1', directConnectGatewayId: 'gw1', location: 'LocA', vlan: 1, asn: 1, bgpPeers: [] } as any,
      { virtualInterfaceId: 'vB', virtualInterfaceType: 'private', virtualInterfaceState: 'available', connectionId: 'cB1', directConnectGatewayId: 'gw1', location: 'LocB', vlan: 2, asn: 1, bgpPeers: [] } as any,
    ];
    t.dxGateways = [{ directConnectGatewayId: 'gw1', directConnectGatewayName: 'GW1', amazonSideAsn: 64512, directConnectGatewayState: 'available' }];

    for (const target of ['high', 'maximum'] as const) {
      const assessment = analyzeTopology(t, target);
      const lagGhostNodes = assessment.lag?.recommendations.flatMap((r) => r.additionalNodes) ?? [];
      // No minted ghost location — the redundant path attaches to existing LocB.
      expect(ghostLocations(lagGhostNodes)).toEqual([]);
      const lagDevLocs = lagGhostNodes
        .filter((n) => n.data.isRecommended && n.data.category === 'awsDevice')
        .map((n) => (n.data.details as Record<string, string>)?.locationCode);
      for (const lc of lagDevLocs) expect(lc).toBe('LocB');
      // LocB has no real LAG → the ghost path there must be plain (no ghost LAG node).
      const ghostLagsAtB = lagGhostNodes.filter(
        (n) => n.data.isRecommended && n.data.category === 'lag'
          && (n.data.details as Record<string, string> | undefined)?.locationCode === 'LocB',
      );
      expect(ghostLagsAtB).toEqual([]);
    }
  });
});
