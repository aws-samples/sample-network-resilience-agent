import { describe, it, expect } from 'vitest';
import { analyzeTopology, FOCUSED_LAG, FOCUSED_PUBLIC_VIF } from '../recommendation-engine';
import { makeEmptyTopology } from './helpers';
import type { TopologyData, DxNode } from '../../types/topology';

/**
 * GHOST SHAPE FOLLOWS THE SINK'S OWN PATH, NOT THE LOCATION'S LAG
 * ==============================================================
 *
 * A single DX location can reach different sinks by different means: DXGW-1 via
 * a LAG, DXGW-2 via a plain (non-LAG) connection on a SEPARATE device. When the
 * device-gap rule recommends a redundant path for DXGW-2 at that location, the
 * ghost must be PLAIN — DXGW-2's own existing path is plain — even though the
 * location also runs a LAG for DXGW-1. (Previously the shape was decided from
 * the full-topology "does this location have any LAG" flag, which wrongly drew a
 * LAG ghost for the plain DXGW.)
 */
function makeMixedShapeTopology(): TopologyData {
  const t = makeEmptyTopology();
  t.locations = [
    { locationCode: 'LocA', locationName: 'A', region: 'ap-southeast-1', availablePortSpeeds: ['10Gbps'] },
  ];
  t.dxGateways = [
    { directConnectGatewayId: 'gw1', directConnectGatewayName: 'GW1 (LAG)', directConnectGatewayState: 'available', amazonSideAsn: 64512 },
    { directConnectGatewayId: 'gw2', directConnectGatewayName: 'GW2 (plain)', directConnectGatewayState: 'available', amazonSideAsn: 64513 },
  ];

  // GW1 reached via a LAG on device LocA-lagdev (2 members).
  t.connections.push(
    { connectionId: 'c-lag1', connectionName: 'LAG-P1', connectionState: 'available', location: 'LocA', bandwidth: '10Gbps', region: 'ap-southeast-1', lagId: 'lagA', awsLogicalDeviceId: 'LocA-lagdev' },
    { connectionId: 'c-lag2', connectionName: 'LAG-P2', connectionState: 'available', location: 'LocA', bandwidth: '10Gbps', region: 'ap-southeast-1', lagId: 'lagA', awsLogicalDeviceId: 'LocA-lagdev' },
  );
  t.lags.push({
    lagId: 'lagA', lagName: 'LAG-A', connectionsBandwidth: '10Gbps', numberOfConnections: 2, minimumLinks: 0,
    location: 'LocA', region: 'ap-southeast-1', lagState: 'available',
    connections: [
      { connectionId: 'c-lag1', connectionName: 'LAG-P1', connectionState: 'available', location: 'LocA', bandwidth: '10Gbps', region: 'ap-southeast-1', lagId: 'lagA', awsLogicalDeviceId: 'LocA-lagdev' },
      { connectionId: 'c-lag2', connectionName: 'LAG-P2', connectionState: 'available', location: 'LocA', bandwidth: '10Gbps', region: 'ap-southeast-1', lagId: 'lagA', awsLogicalDeviceId: 'LocA-lagdev' },
    ],
  });

  // GW2 reached via a PLAIN connection on a SEPARATE device LocA-plaindev.
  t.connections.push(
    { connectionId: 'c-plain', connectionName: 'PLAIN', connectionState: 'available', location: 'LocA', bandwidth: '10Gbps', region: 'ap-southeast-1', awsLogicalDeviceId: 'LocA-plaindev' },
  );

  t.virtualInterfaces.push(
    { virtualInterfaceId: 'v-lag', virtualInterfaceName: 'V-LAG', virtualInterfaceType: 'private', virtualInterfaceState: 'available', connectionId: 'c-lag1', directConnectGatewayId: 'gw1', vlan: 10, asn: 1, bgpPeers: [], region: 'ap-southeast-1', location: 'LocA' },
    { virtualInterfaceId: 'v-plain', virtualInterfaceName: 'V-PLAIN', virtualInterfaceType: 'private', virtualInterfaceState: 'available', connectionId: 'c-plain', directConnectGatewayId: 'gw2', vlan: 20, asn: 1, bgpPeers: [], region: 'ap-southeast-1', location: 'LocA' },
  );

  return t;
}

function locOf(n: DxNode): string {
  return (n.data.details as Record<string, string> | undefined)?.locationCode ?? '';
}

function tgwAssoc(dxgwId: string, tgwId: string) {
  return {
    directConnectGatewayId: dxgwId,
    associatedGateway: { id: tgwId, type: 'transitGateway' as const, region: 'ap-southeast-1', ownerAccount: '111122223333' },
    associationState: 'associated',
    allowedPrefixes: [],
  };
}

describe('device-gap ghost shape follows the sink, not the location', () => {
  it('draws a PLAIN ghost for the plain DXGW even though the location runs a LAG for another DXGW', () => {
    const a = analyzeTopology(makeMixedShapeTopology(), {
      [FOCUSED_LAG]: 'maximum',
      [FOCUSED_PUBLIC_VIF]: 'maximum',
      gw1: 'maximum',
      gw2: 'maximum',
    });

    const gw2 = a.perDxGateway.find((g) => g.dxGatewayId === 'gw2');
    expect(gw2).toBeDefined();
    const gw2Nodes = gw2!.recommendations.flatMap((r) => r.additionalNodes);

    // A redundant device ghost is added for GW2 at LocA.
    const devsAtA = gw2Nodes.filter(
      (n) => n.data.isRecommended && n.data.category === 'awsDevice' && locOf(n) === 'LocA',
    );
    expect(devsAtA.length).toBeGreaterThan(0);

    // It is PLAIN — no ghost LAG node in GW2's own recommendations (GW2's path is plain).
    const lagGhosts = gw2Nodes.filter((n) => n.data.isRecommended && n.data.category === 'lag');
    expect(lagGhosts).toEqual([]);
  });

  it('still draws the plain ghost when the two DXGWs go to SEPARATE TGWs (not converged)', () => {
    const t = makeMixedShapeTopology();
    // GW1 → tgw-1, GW2 → tgw-2: distinct blast-radii, so LocA is NOT already
    // device-redundant for GW2's downstream — the device-gap ghost must fire.
    t.dxGatewayAssociations = [tgwAssoc('gw1', 'tgw-1'), tgwAssoc('gw2', 'tgw-2')];

    const a = analyzeTopology(t, {
      [FOCUSED_LAG]: 'maximum',
      [FOCUSED_PUBLIC_VIF]: 'maximum',
      gw1: 'maximum',
      gw2: 'maximum',
    });
    const gw2 = a.perDxGateway.find((g) => g.dxGatewayId === 'gw2');
    const devsAtA = gw2!.recommendations
      .flatMap((r) => r.additionalNodes)
      .filter((n) => n.data.isRecommended && n.data.category === 'awsDevice' && locOf(n) === 'LocA');
    expect(devsAtA.length).toBeGreaterThan(0);
  });

  it('SKIPS the device-gap ghost at a location when the two DXGWs CONVERGE on the same TGW', () => {
    const t = makeMixedShapeTopology();
    // GW1 (LAG device) and GW2 (plain device) both associate to tgw-1: LocA
    // already has 2 separate devices reaching the shared downstream, so it
    // survives a device failure for that blast-radius → no device-gap ghost.
    t.dxGatewayAssociations = [tgwAssoc('gw1', 'tgw-1'), tgwAssoc('gw2', 'tgw-1')];

    const a = analyzeTopology(t, {
      [FOCUSED_LAG]: 'maximum',
      [FOCUSED_PUBLIC_VIF]: 'maximum',
      gw1: 'maximum',
      gw2: 'maximum',
    });
    const gw2 = a.perDxGateway.find((g) => g.dxGatewayId === 'gw2');
    const gapRecs = gw2!.recommendations.filter(
      (r) => r.ruleId === 'single-connection-per-location',
    );
    // No per-location device-gap rec at LocA (converged group is device-redundant there).
    const devsAtA = gapRecs
      .flatMap((r) => r.additionalNodes)
      .filter((n) => n.data.isRecommended && n.data.category === 'awsDevice' && locOf(n) === 'LocA');
    expect(devsAtA).toEqual([]);
  });
});
