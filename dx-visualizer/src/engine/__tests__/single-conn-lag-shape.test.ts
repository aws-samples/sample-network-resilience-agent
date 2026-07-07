import { describe, it, expect } from 'vitest';
import { analyzeTopology, FOCUSED_LAG, FOCUSED_PUBLIC_VIF } from '../recommendation-engine';
import { makeEmptyTopology } from './helpers';
import type { TopologyData, DxNode } from '../../types/topology';

/**
 * PER-DXGW single-connection rec must respect the host location's LAG
 * ==================================================================
 *
 * EMEALAB shape: a DXGW is fed from TCSH (many plain devices) and Equinix LD5,
 * where the only DXGW-facing device (via a plain MGMT connection) is ALSO the
 * device the LAG bundle terminates on. The per-DXGW device-gap rule fires for
 * LD5 (its scope sees 1 DXGW device there) — and the ghost path it draws must be
 * LAG-shaped, because LD5's real sink device is the LAG bundle device.
 *
 * The bug: ruleSingleConnectionPerLocation drew a plain path, and it detected
 * hasLag against the STRIPPED per-DXGW scope (which excludes the LAG's member
 * connections since they carry no DXGW VIF) → hasLag=false → plain ghost.
 */

function makeEmealabTopology(): TopologyData {
  const t = makeEmptyTopology();
  t.locations = [
    { locationCode: 'TCSH', locationName: 'Digital Realty LHR20', region: 'eu-west-2', availablePortSpeeds: ['10Gbps'] },
    { locationCode: 'EqLD5', locationName: 'Equinix LD5', region: 'eu-west-2', availablePortSpeeds: ['1Gbps'] },
  ];
  t.dxGateways = [{ directConnectGatewayId: 'gw', directConnectGatewayName: 'EMEALAB MGMT', directConnectGatewayState: 'available', amazonSideAsn: 64512 }];

  // TCSH: two plain devices with DXGW VIFs → already device-redundant here.
  t.connections.push(
    { connectionId: 'tcsh-c1', connectionName: 'DX9', connectionState: 'available', location: 'TCSH', bandwidth: '10Gbps', region: 'eu-west-2', awsLogicalDeviceId: 'TCSH-d1' },
    { connectionId: 'tcsh-c2', connectionName: 'DX10', connectionState: 'available', location: 'TCSH', bandwidth: '10Gbps', region: 'eu-west-2', awsLogicalDeviceId: 'TCSH-d2' },
  );
  t.virtualInterfaces.push(
    { virtualInterfaceId: 'tv1', virtualInterfaceName: 'A', virtualInterfaceType: 'private', virtualInterfaceState: 'available', connectionId: 'tcsh-c1', directConnectGatewayId: 'gw', vlan: 114, asn: 1, bgpPeers: [], region: 'eu-west-2', location: 'TCSH' },
    { virtualInterfaceId: 'tv2', virtualInterfaceName: 'B', virtualInterfaceType: 'private', virtualInterfaceState: 'available', connectionId: 'tcsh-c2', directConnectGatewayId: 'gw', vlan: 214, asn: 1, bgpPeers: [], region: 'eu-west-2', location: 'TCSH' },
  );

  // EqLD5: LAG bundle (2 members) on device EqLD5-lagdev — these members carry
  // NO DXGW VIF. A separate plain MGMT connection lands on the SAME device and
  // carries the only DXGW VIF at LD5.
  t.connections.push(
    { connectionId: 'ld5-p4', connectionName: 'LAG-P4', connectionState: 'available', location: 'EqLD5', bandwidth: '1Gbps', region: 'eu-west-2', lagId: 'ld5-lag', awsLogicalDeviceId: 'EqLD5-lagdev' },
    { connectionId: 'ld5-p5', connectionName: 'LAG-P5', connectionState: 'available', location: 'EqLD5', bandwidth: '1Gbps', region: 'eu-west-2', lagId: 'ld5-lag', awsLogicalDeviceId: 'EqLD5-lagdev' },
    { connectionId: 'ld5-mgmt', connectionName: 'MGMT', connectionState: 'available', location: 'EqLD5', bandwidth: '1Gbps', region: 'eu-west-2', awsLogicalDeviceId: 'EqLD5-lagdev' },
  );
  t.lags.push({
    lagId: 'ld5-lag', lagName: 'LAG-1-DX102-DX103', connectionsBandwidth: '1Gbps', numberOfConnections: 2, minimumLinks: 0,
    location: 'EqLD5', region: 'eu-west-2', lagState: 'available',
    connections: [
      { connectionId: 'ld5-p4', connectionName: 'LAG-P4', connectionState: 'available', location: 'EqLD5', bandwidth: '1Gbps', region: 'eu-west-2', lagId: 'ld5-lag', awsLogicalDeviceId: 'EqLD5-lagdev' },
      { connectionId: 'ld5-p5', connectionName: 'LAG-P5', connectionState: 'available', location: 'EqLD5', bandwidth: '1Gbps', region: 'eu-west-2', lagId: 'ld5-lag', awsLogicalDeviceId: 'EqLD5-lagdev' },
    ],
  });
  t.virtualInterfaces.push(
    { virtualInterfaceId: 'ld5-v', virtualInterfaceName: 'MGMT-VIF', virtualInterfaceType: 'private', virtualInterfaceState: 'available', connectionId: 'ld5-mgmt', directConnectGatewayId: 'gw', vlan: 550, asn: 1, bgpPeers: [], region: 'eu-west-2', location: 'EqLD5' },
  );

  return t;
}

function dxgwGhostNodes(a: ReturnType<typeof analyzeTopology>): DxNode[] {
  return a.perDxGateway.flatMap((g) => g.recommendations.flatMap((r) => r.additionalNodes));
}
function locOf(n: DxNode): string {
  return (n.data.details as Record<string, string> | undefined)?.locationCode ?? '';
}

describe('per-DXGW single-connection rec respects host LAG', () => {
  it('draws a LAG-shaped ghost at EqLD5 (its real sink device is the LAG bundle device)', () => {
    const a = analyzeTopology(makeEmealabTopology(), { [FOCUSED_LAG]: 'maximum', [FOCUSED_PUBLIC_VIF]: 'maximum', gw: 'maximum' });
    const nodes = dxgwGhostNodes(a);
    // A device-gap ghost is added at EqLD5.
    const ld5Devs = nodes.filter((n) => n.data.isRecommended && n.data.category === 'awsDevice' && locOf(n) === 'EqLD5');
    expect(ld5Devs.length).toBeGreaterThan(0);
    // And it is LAG-shaped: a ghost LAG node sits at EqLD5.
    const ld5Lags = nodes.filter((n) => n.data.isRecommended && n.data.category === 'lag' && locOf(n) === 'EqLD5');
    expect(ld5Lags.length).toBeGreaterThan(0);
  });
});
