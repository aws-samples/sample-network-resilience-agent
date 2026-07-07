import { describe, it, expect } from 'vitest';
import { getSinkConnectedDevices } from '../sla-gating';
import { makeEmptyTopology } from './helpers';

/**
 * HOST-LOCATION LAG DETECTION BY DEVICE IDENTITY
 * ==============================================
 *
 * A DX location "runs a LAG that sinks to the DXGW/public endpoint" whenever a
 * sink-connected AWS logical device at that location is the same device the LAG
 * bundle terminates on — EVEN IF the specific sink VIF rides a connection that
 * is NOT itself a LAG member.
 *
 * Real-data shape (EMEALAB / Equinix LD5): the LAG `LAG-1-DX102-DX103` bundles
 * two member connections that both terminate on device `EqLD5-98p0kd02k3ws`.
 * The DXGW private VIF `dxvif-ffz7n84x` rides a DIFFERENT connection
 * (`dxcon-ffqh8jsu`, not a LAG member) that nonetheless lands on that SAME
 * device. The location must therefore be flagged `hasLag: true` so a redundant
 * ghost path drawn here is LAG-shaped — respecting the host location's existing
 * connected LAG.
 */

describe('getSinkConnectedDevices — LAG detection by device identity', () => {
  it('flags hasLag when the sink VIF lands on the LAG bundle device via a non-member connection', () => {
    const t = makeEmptyTopology();
    t.locations = [{ locationCode: 'EqLD5', locationName: 'Equinix LD5', region: 'eu-west-2', availablePortSpeeds: [] }];
    t.dxGateways = [{ directConnectGatewayId: 'gw', directConnectGatewayName: 'GW', directConnectGatewayState: 'available', amazonSideAsn: 64512 }];

    // LAG member connections — both terminate on device EqLD5-98p0kd02k3ws.
    t.connections = [
      { connectionId: 'dxcon-fgdrdh4c', connectionName: 'P4', connectionState: 'available', location: 'EqLD5', bandwidth: '1Gbps', region: 'eu-west-2', lagId: 'dxlag-ffxgu8xg', awsLogicalDeviceId: 'EqLD5-98p0kd02k3ws' },
      { connectionId: 'dxcon-fha2h0m3', connectionName: 'P5', connectionState: 'available', location: 'EqLD5', bandwidth: '1Gbps', region: 'eu-west-2', lagId: 'dxlag-ffxgu8xg', awsLogicalDeviceId: 'EqLD5-98p0kd02k3ws' },
      // The DXGW-sinking connection: NOT a LAG member, but same logical device.
      { connectionId: 'dxcon-ffqh8jsu', connectionName: 'MGMT', connectionState: 'available', location: 'EqLD5', bandwidth: '1Gbps', region: 'eu-west-2', awsLogicalDeviceId: 'EqLD5-98p0kd02k3ws' },
    ];
    t.lags = [
      { lagId: 'dxlag-ffxgu8xg', lagName: 'LAG-1-DX102-DX103', connectionsBandwidth: '1Gbps', numberOfConnections: 2, minimumLinks: 0, location: 'EqLD5', region: 'eu-west-2', lagState: 'available', connections: [
        { connectionId: 'dxcon-fgdrdh4c', connectionName: 'P4', connectionState: 'available', location: 'EqLD5', bandwidth: '1Gbps', region: 'eu-west-2', lagId: 'dxlag-ffxgu8xg', awsLogicalDeviceId: 'EqLD5-98p0kd02k3ws' },
        { connectionId: 'dxcon-fha2h0m3', connectionName: 'P5', connectionState: 'available', location: 'EqLD5', bandwidth: '1Gbps', region: 'eu-west-2', lagId: 'dxlag-ffxgu8xg', awsLogicalDeviceId: 'EqLD5-98p0kd02k3ws' },
      ] },
    ];
    t.virtualInterfaces = [
      { virtualInterfaceId: 'dxvif-ffz7n84x', virtualInterfaceName: 'VLAN550', virtualInterfaceType: 'private', virtualInterfaceState: 'available', connectionId: 'dxcon-ffqh8jsu', directConnectGatewayId: 'gw', vlan: 550, asn: 65000, bgpPeers: [], region: 'eu-west-2', location: 'EqLD5' },
    ];

    const info = getSinkConnectedDevices(t).get('EqLD5');
    expect(info?.deviceCount).toBe(1);
    expect(info?.hasLag).toBe(true);
  });

  it('does NOT flag hasLag when the sink device is unrelated to any LAG bundle device', () => {
    const t = makeEmptyTopology();
    t.locations = [{ locationCode: 'EqLD5', locationName: 'Equinix LD5', region: 'eu-west-2', availablePortSpeeds: [] }];
    t.dxGateways = [{ directConnectGatewayId: 'gw', directConnectGatewayName: 'GW', directConnectGatewayState: 'available', amazonSideAsn: 64512 }];
    // A LAG on device D-lag, but the DXGW VIF lands on a DIFFERENT plain device.
    t.connections = [
      { connectionId: 'lagmember', connectionName: 'LM', connectionState: 'available', location: 'EqLD5', bandwidth: '1Gbps', region: 'eu-west-2', lagId: 'lag1', awsLogicalDeviceId: 'EqLD5-lagdev' },
      { connectionId: 'plain', connectionName: 'PL', connectionState: 'available', location: 'EqLD5', bandwidth: '1Gbps', region: 'eu-west-2', awsLogicalDeviceId: 'EqLD5-plaindev' },
    ];
    t.lags = [
      { lagId: 'lag1', lagName: 'LAG1', connectionsBandwidth: '1Gbps', numberOfConnections: 1, minimumLinks: 0, location: 'EqLD5', region: 'eu-west-2', lagState: 'available', connections: [
        { connectionId: 'lagmember', connectionName: 'LM', connectionState: 'available', location: 'EqLD5', bandwidth: '1Gbps', region: 'eu-west-2', lagId: 'lag1', awsLogicalDeviceId: 'EqLD5-lagdev' },
      ] },
    ];
    t.virtualInterfaces = [
      { virtualInterfaceId: 'v', virtualInterfaceName: 'V', virtualInterfaceType: 'private', virtualInterfaceState: 'available', connectionId: 'plain', directConnectGatewayId: 'gw', vlan: 10, asn: 1, bgpPeers: [], region: 'eu-west-2', location: 'EqLD5' },
    ];
    const info = getSinkConnectedDevices(t).get('EqLD5');
    // Only the plain DXGW device is sink-connected (the LAG device carries no
    // sink VIF here) → not LAG-backed.
    expect(info?.hasLag).toBe(false);
  });
});
