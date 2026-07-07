import { describe, it, expect } from 'vitest';
import { analyzeTopology, FOCUSED_LAG } from '../recommendation-engine';
import { makeEmptyTopology } from './helpers';
import type { TopologyData, DxNode } from '../../types/topology';

/**
 * BUG REPRODUCTION — multi-site LAG device gap (EMEALAB MGMT shape)
 * ================================================================
 *
 * A single DXGW is ALREADY fed from TWO real DX locations:
 *   - LHR20 (Digital Realty): 2+ plain (non-LAG) AWS logical devices → the DXGW
 *     is already device-redundant at this site.
 *   - LD5   (Equinix):        1 LAG-backed device (LAG-1-DX102-DX103) → the DXGW
 *     has only a SINGLE device here.
 *
 * The DXGW therefore already spans 2 locations; the ONLY gap to Maximum is a
 * second device at LD5. The correct recommendation is a single ghost LAG path
 * AT the existing LD5 — NOT a brand-new minted "Second Direct Connect Location",
 * and NOT LAG nodes floating on an invented site.
 *
 * The pre-fix engine mints a bogus ghost location (LD5 is the only LAG location,
 * and the other real location LHR20 is already 2-device "full" so reuse is
 * refused → mint). This test pins the corrected behavior.
 */

function makeEmealabTopology(): TopologyData {
  const t = makeEmptyTopology();
  t.homeAccountId = '111122223333';
  t.locations = [
    { locationCode: 'LHR20', locationName: 'Digital Realty LHR20, London, GBR', region: 'eu-west-2', availablePortSpeeds: ['1Gbps', '10Gbps'] },
    { locationCode: 'EqLD5', locationName: 'Equinix LD5, Slough, GBR', region: 'eu-west-2', availablePortSpeeds: ['1Gbps', '10Gbps'] },
  ];
  t.dxGateways = [
    { directConnectGatewayId: 'dxgw-emealab', directConnectGatewayName: '-DND- EMEALAB MGMT', directConnectGatewayState: 'available', amazonSideAsn: 64512 },
  ];

  // --- LHR20: two plain (non-LAG) devices, each with a private VIF to the DXGW.
  t.connections.push(
    { connectionId: 'dxcon-lhr20a', connectionName: 'EMEALAB-DX9', connectionState: 'available', location: 'LHR20', bandwidth: '10Gbps', region: 'eu-west-2', awsLogicalDeviceId: 'LHR20-dev1' },
    { connectionId: 'dxcon-lhr20b', connectionName: 'EMEALAB-DX10', connectionState: 'available', location: 'LHR20', bandwidth: '10Gbps', region: 'eu-west-2', awsLogicalDeviceId: 'LHR20-dev2' },
  );
  t.virtualInterfaces.push(
    { virtualInterfaceId: 'vif-lhr20a', virtualInterfaceName: 'VIF-LHR20-A', virtualInterfaceType: 'private', virtualInterfaceState: 'available', connectionId: 'dxcon-lhr20a', directConnectGatewayId: 'dxgw-emealab', vlan: 114, asn: 65000, bgpPeers: [], region: 'eu-west-2', location: 'LHR20' },
    { virtualInterfaceId: 'vif-lhr20b', virtualInterfaceName: 'VIF-LHR20-B', virtualInterfaceType: 'private', virtualInterfaceState: 'available', connectionId: 'dxcon-lhr20b', directConnectGatewayId: 'dxgw-emealab', vlan: 214, asn: 65000, bgpPeers: [], region: 'eu-west-2', location: 'LHR20' },
  );

  // --- LD5: a LAG (2 member connections) on ONE logical device, with a private
  // VIF to the DXGW and a public VIF (VLAN 351) riding the same LAG device.
  t.connections.push(
    { connectionId: 'dxcon-ld5p4', connectionName: 'EMEALAB-DX102-LAG-1-FR101-P4', connectionState: 'available', location: 'EqLD5', bandwidth: '1Gbps', region: 'eu-west-2', lagId: 'dxlag-ld5', awsLogicalDeviceId: 'EqLD5-lagdev' },
    { connectionId: 'dxcon-ld5p5', connectionName: 'EMEALAB-DX103-LAG-1-FR101-P5', connectionState: 'available', location: 'EqLD5', bandwidth: '1Gbps', region: 'eu-west-2', lagId: 'dxlag-ld5', awsLogicalDeviceId: 'EqLD5-lagdev' },
  );
  t.lags.push({
    lagId: 'dxlag-ld5', lagName: 'LAG-1-DX102-DX103', connectionsBandwidth: '1Gbps', numberOfConnections: 2, minimumLinks: 0,
    location: 'EqLD5', region: 'eu-west-2', lagState: 'available',
    connections: [
      { connectionId: 'dxcon-ld5p4', connectionName: 'EMEALAB-DX102-LAG-1-FR101-P4', connectionState: 'available', location: 'EqLD5', bandwidth: '1Gbps', region: 'eu-west-2', lagId: 'dxlag-ld5', awsLogicalDeviceId: 'EqLD5-lagdev' },
      { connectionId: 'dxcon-ld5p5', connectionName: 'EMEALAB-DX103-LAG-1-FR101-P5', connectionState: 'available', location: 'EqLD5', bandwidth: '1Gbps', region: 'eu-west-2', lagId: 'dxlag-ld5', awsLogicalDeviceId: 'EqLD5-lagdev' },
    ],
  });
  t.virtualInterfaces.push(
    { virtualInterfaceId: 'vif-ld5-priv', virtualInterfaceName: 'VIF-LD5-PRIV', virtualInterfaceType: 'private', virtualInterfaceState: 'available', connectionId: 'dxcon-ld5p4', directConnectGatewayId: 'dxgw-emealab', vlan: 116, asn: 65000, bgpPeers: [], region: 'eu-west-2', location: 'EqLD5' },
    { virtualInterfaceId: 'vif-ld5-pub', virtualInterfaceName: 'VIF-LD5-PUB', virtualInterfaceType: 'public', virtualInterfaceState: 'available', connectionId: 'dxcon-ld5p5', vlan: 351, asn: 65000, bgpPeers: [], region: 'eu-west-2', location: 'EqLD5' },
  );

  return t;
}

function ghostNodes(recs: { additionalNodes: DxNode[] }[]): DxNode[] {
  return recs.flatMap((r) => r.additionalNodes);
}
function mintedLocations(nodes: DxNode[]): DxNode[] {
  return nodes.filter((n) => n.data.isRecommended && n.data.category === 'dxLocation');
}
function ghostAwsDeviceLocs(nodes: DxNode[]): string[] {
  return nodes
    .filter((n) => n.data.isRecommended && n.data.category === 'awsDevice')
    .map((n) => (n.data.details as Record<string, string> | undefined)?.locationCode ?? '');
}
function ghostLagLocs(nodes: DxNode[]): string[] {
  return nodes
    .filter((n) => n.data.isRecommended && n.data.category === 'lag')
    .map((n) => (n.data.details as Record<string, string> | undefined)?.locationCode ?? '');
}

describe('multi-site LAG device gap (EMEALAB MGMT)', () => {
  it('does NOT mint a new ghost DX location — the DXGW already spans 2 real sites', () => {
    const a = analyzeTopology(makeEmealabTopology(), { [FOCUSED_LAG]: 'maximum' });
    const lagNodes = ghostNodes(a.lag?.recommendations ?? []);
    expect(mintedLocations(lagNodes)).toEqual([]);
  });

  it('draws the ghost LAG path AT the existing LD5 (its device gap), not on an invented site', () => {
    const a = analyzeTopology(makeEmealabTopology(), { [FOCUSED_LAG]: 'maximum' });
    const lagNodes = ghostNodes(a.lag?.recommendations ?? []);
    // Every ghost AWS device and ghost LAG lives at the real EqLD5 code.
    for (const loc of ghostAwsDeviceLocs(lagNodes)) expect(loc).toBe('EqLD5');
    expect(ghostLagLocs(lagNodes).length).toBeGreaterThan(0);
    for (const loc of ghostLagLocs(lagNodes)) expect(loc).toBe('EqLD5');
  });

  it('brings the DXGW to Maximum with a single added LAG device at LD5', () => {
    const a = analyzeTopology(makeEmealabTopology(), { [FOCUSED_LAG]: 'maximum' });
    const lagNodes = ghostNodes(a.lag?.recommendations ?? []);
    // Exactly one ghost LAG path added (LD5 goes from 1 → 2 sink devices).
    const lagCount = lagNodes.filter((n) => n.data.isRecommended && n.data.category === 'lag').length;
    expect(lagCount).toBe(1);
  });
});
