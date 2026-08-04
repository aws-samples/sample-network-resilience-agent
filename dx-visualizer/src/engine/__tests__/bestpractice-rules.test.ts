import { describe, it, expect } from 'vitest';
import {
  ruleBfdGuidance,
  ruleVifDown,
  ruleConnectionNotAvailable,
  ruleNoVpnBackup,
  ruleSlaAwareness,
  ruleResiliencyToolkit,
  ruleConsistentPrefixAdvertisement,
  ruleBgpRouteLimit,
  ruleVpnTunnelRedundancy,
  ruleCgwRedundancy,
  ruleDxPartnerDiversity,
  ruleVpnDpd,
  ruleDxLocationRedundancy,
  ruleBgpTimersFallback,
  ruleDxFailoverTesting,
  ruleFailoverRunbooks,
  getAllBestPracticeResults,
} from '../bestpractice-rules';
import { makeEmptyTopology } from './helpers';

describe('ruleBfdGuidance', () => {
  it('returns no recommendation when no connections or VIFs', () => {
    const result = ruleBfdGuidance(makeEmptyTopology());
    expect(result.recommendation).toBeNull();
  });

  it('returns BFD guidance when connections exist', () => {
    const t = makeEmptyTopology();
    t.connections = [{ connectionId: 'c1', connectionState: 'available', tags: {} } as any];
    const result = ruleBfdGuidance(t);
    expect(result.recommendation).not.toBeNull();
    expect(result.recommendation!.ruleId).toBe('bfd-guidance');
  });

  it('returns BFD guidance when only VIFs exist', () => {
    const t = makeEmptyTopology();
    t.virtualInterfaces = [{ virtualInterfaceId: 'v1', bgpPeers: [], tags: {} } as any];
    const result = ruleBfdGuidance(t);
    expect(result.recommendation).not.toBeNull();
  });
});

describe('ruleVifDown', () => {
  it('returns no recommendation when all VIFs are available', () => {
    const t = makeEmptyTopology();
    t.virtualInterfaces = [
      { virtualInterfaceId: 'v1', virtualInterfaceName: 'vif-1', virtualInterfaceState: 'available', bgpPeers: [{ bgpStatus: 'up' }], tags: {} } as any,
    ];
    expect(ruleVifDown(t).recommendation).toBeNull();
  });

  it('detects VIF in non-available state', () => {
    const t = makeEmptyTopology();
    t.virtualInterfaces = [
      { virtualInterfaceId: 'v1', virtualInterfaceName: 'vif-down', virtualInterfaceState: 'down', bgpPeers: [], tags: {} } as any,
    ];
    const result = ruleVifDown(t);
    expect(result.recommendation).not.toBeNull();
    expect(result.recommendation!.severity).toBe('critical');
    expect(result.recommendation!.description).toContain('vif-down');
  });

  it('detects VIF with all BGP peers down', () => {
    const t = makeEmptyTopology();
    t.virtualInterfaces = [
      {
        virtualInterfaceId: 'v1',
        virtualInterfaceName: 'vif-bgp-down',
        virtualInterfaceState: 'available',
        bgpPeers: [{ bgpStatus: 'down' }, { bgpStatus: 'down' }],
        tags: {},
      } as any,
    ];
    const result = ruleVifDown(t);
    expect(result.recommendation).not.toBeNull();
    expect(result.recommendation!.description).toContain('vif-bgp-down');
  });
});

describe('ruleConnectionNotAvailable', () => {
  it('returns no recommendation when all connections are available', () => {
    const t = makeEmptyTopology();
    t.connections = [{ connectionId: 'c1', connectionName: 'conn-1', connectionState: 'available', tags: {} } as any];
    expect(ruleConnectionNotAvailable(t).recommendation).toBeNull();
  });

  it('detects connection in non-available state', () => {
    const t = makeEmptyTopology();
    t.connections = [{ connectionId: 'c1', connectionName: 'bad-conn', connectionState: 'down', tags: {} } as any];
    const result = ruleConnectionNotAvailable(t);
    expect(result.recommendation).not.toBeNull();
    expect(result.recommendation!.severity).toBe('critical');
    expect(result.recommendation!.description).toContain('bad-conn');
  });
});

describe('ruleNoVpnBackup', () => {
  it('returns no recommendation when no DX infrastructure exists', () => {
    expect(ruleNoVpnBackup(makeEmptyTopology()).recommendation).toBeNull();
  });

  it('returns recommendation when DX exists but no VPN backup', () => {
    const t = makeEmptyTopology();
    t.connections = [{ connectionId: 'c1', connectionState: 'available', tags: {} } as any];
    const result = ruleNoVpnBackup(t);
    expect(result.recommendation).not.toBeNull();
    expect(result.recommendation!.ruleId).toBe('no-vpn-backup');
    expect(result.recommendation!.severity).toBe('warning');
  });

  it('returns no recommendation when VPN connections exist', () => {
    const t = makeEmptyTopology();
    t.connections = [{ connectionId: 'c1', connectionState: 'available', tags: {} } as any];
    t.vpnConnections = [{ vpnConnectionId: 'vpn-1', tags: {} } as any];
    expect(ruleNoVpnBackup(t).recommendation).toBeNull();
  });
});

describe('ruleSlaAwareness', () => {
  it('returns no recommendation for empty topology', () => {
    expect(ruleSlaAwareness(makeEmptyTopology()).recommendation).toBeNull();
  });

  it('returns info-level SLA awareness recommendation when DX exists', () => {
    const t = makeEmptyTopology();
    t.connections = [{ connectionId: 'c1', connectionState: 'available', tags: {} } as any];
    const result = ruleSlaAwareness(t);
    expect(result.recommendation).not.toBeNull();
    expect(result.recommendation!.ruleId).toBe('sla-awareness');
    expect(result.recommendation!.severity).toBe('info');
    expect(result.recommendation!.description).toContain('aws.amazon.com/directconnect/sla');
  });
});

describe('ruleResiliencyToolkit', () => {
  it('returns no recommendation for empty topology', () => {
    expect(ruleResiliencyToolkit(makeEmptyTopology()).recommendation).toBeNull();
  });

  it('returns info recommendation when DX exists', () => {
    const t = makeEmptyTopology();
    t.virtualInterfaces = [{ virtualInterfaceId: 'v1', bgpPeers: [], tags: {} } as any];
    const result = ruleResiliencyToolkit(t);
    expect(result.recommendation).not.toBeNull();
    expect(result.recommendation!.ruleId).toBe('resiliency-toolkit');
    expect(result.recommendation!.description).toContain('resiliency_toolkit');
  });
});

describe('ruleConsistentPrefixAdvertisement', () => {
  it('returns no recommendation when fewer than 2 VIFs', () => {
    const t = makeEmptyTopology();
    t.virtualInterfaces = [{ virtualInterfaceId: 'v1', bgpPeers: [], tags: {} } as any];
    expect(ruleConsistentPrefixAdvertisement(t).recommendation).toBeNull();
  });

  it('returns recommendation when 2 or more VIFs exist', () => {
    const t = makeEmptyTopology();
    t.virtualInterfaces = [
      { virtualInterfaceId: 'v1', bgpPeers: [], tags: {} } as any,
      { virtualInterfaceId: 'v2', bgpPeers: [], tags: {} } as any,
    ];
    const result = ruleConsistentPrefixAdvertisement(t);
    expect(result.recommendation).not.toBeNull();
    expect(result.recommendation!.ruleId).toBe('consistent-prefix-advertisement');
  });
});

describe('ruleBgpRouteLimit', () => {
  const makeVif = (id: string, type: 'private' | 'transit' | 'public' = 'private') =>
    ({
      virtualInterfaceId: id,
      virtualInterfaceName: id,
      virtualInterfaceType: type,
      bgpPeers: [],
      tags: {},
    }) as any;

  it('returns no recommendation without applicable VIFs', () => {
    expect(ruleBgpRouteLimit(makeEmptyTopology()).recommendation).toBeNull();
  });

  it('ignores public VIFs (1000-prefix limit does not apply)', () => {
    const t = makeEmptyTopology();
    t.virtualInterfaces = [makeVif('v-pub', 'public')];
    expect(ruleBgpRouteLimit(t).recommendation).toBeNull();
  });

  it('falls back to info guidance when CloudWatch metrics are missing', () => {
    const t = makeEmptyTopology();
    t.virtualInterfaces = [makeVif('v1')];
    const result = ruleBgpRouteLimit(t);
    expect(result.recommendation).not.toBeNull();
    expect(result.recommendation!.ruleId).toBe('bgp-route-limit');
    expect(result.recommendation!.severity).toBe('info');
    expect(result.recommendation!.description).toContain('limits.html');
  });

  it('confirms met when all VIFs are well under the limit', () => {
    const t = makeEmptyTopology();
    t.virtualInterfaces = [makeVif('v1'), makeVif('v2', 'transit')];
    t.bgpPrefixMetrics = new Map([
      ['v1', { accepted: 12, advertised: 5 }],
      ['v2', { accepted: 34, advertised: 8 }],
    ]);
    const result = ruleBgpRouteLimit(t);
    expect(result.recommendation).not.toBeNull();
    expect(result.recommendation!.ruleId).toBe('bgp-route-limit-ok');
    expect(result.recommendation!.severity).toBe('info');
    expect(result.recommendation!.description).toContain('peak observed is 34');
  });

  it('warns when a VIF is within 20 prefixes of the limit', () => {
    const t = makeEmptyTopology();
    t.virtualInterfaces = [makeVif('v-near')];
    t.bgpPrefixMetrics = new Map([['v-near', { accepted: 85 }]]);
    const result = ruleBgpRouteLimit(t);
    expect(result.recommendation).not.toBeNull();
    expect(result.recommendation!.severity).toBe('warning');
    expect(result.recommendation!.description).toContain('v-near');
    expect(result.recommendation!.description).toContain('85');
  });

  it('flags critical when a VIF is at or over 100 prefixes', () => {
    const t = makeEmptyTopology();
    t.virtualInterfaces = [makeVif('v-over')];
    t.bgpPrefixMetrics = new Map([['v-over', { accepted: 102 }]]);
    const result = ruleBgpRouteLimit(t);
    expect(result.recommendation).not.toBeNull();
    expect(result.recommendation!.severity).toBe('critical');
    expect(result.recommendation!.description).toContain('v-over');
    expect(result.recommendation!.description).toContain('102 accepted');
  });
});

describe('ruleVpnTunnelRedundancy', () => {
  it('returns no recommendation when no VPN connections', () => {
    expect(ruleVpnTunnelRedundancy(makeEmptyTopology()).recommendation).toBeNull();
  });

  it('returns no recommendation when all VPNs have 2 tunnels UP', () => {
    const t = makeEmptyTopology();
    t.vpnConnections = [{
      vpnConnectionId: 'vpn-1',
      customerGatewayId: 'cgw-1',
      tunnels: [{ status: 'UP' }, { status: 'UP' }],
      tags: {},
    } as any];
    expect(ruleVpnTunnelRedundancy(t).recommendation).toBeNull();
  });

  it('detects VPN with a down tunnel', () => {
    const t = makeEmptyTopology();
    t.vpnConnections = [{
      vpnConnectionId: 'vpn-degraded',
      customerGatewayId: 'cgw-1',
      tunnels: [{ status: 'UP' }, { status: 'DOWN' }],
      tags: {},
    } as any];
    const result = ruleVpnTunnelRedundancy(t);
    expect(result.recommendation).not.toBeNull();
    expect(result.recommendation!.severity).toBe('warning');
    expect(result.recommendation!.description).toContain('vpn-degraded');
  });
});

describe('ruleCgwRedundancy', () => {
  it('returns no recommendation without VPN connections', () => {
    expect(ruleCgwRedundancy(makeEmptyTopology()).recommendation).toBeNull();
  });

  it('fires when all VPNs share the same CGW', () => {
    const t = makeEmptyTopology();
    t.vpnConnections = [
      { vpnConnectionId: 'vpn-1', customerGatewayId: 'cgw-1', tunnels: [], tags: {} } as any,
      { vpnConnectionId: 'vpn-2', customerGatewayId: 'cgw-1', tunnels: [], tags: {} } as any,
    ];
    const result = ruleCgwRedundancy(t);
    expect(result.recommendation).not.toBeNull();
    expect(result.recommendation!.severity).toBe('warning');
  });

  it('returns no recommendation when 2+ CGWs are used', () => {
    const t = makeEmptyTopology();
    t.vpnConnections = [
      { vpnConnectionId: 'vpn-1', customerGatewayId: 'cgw-1', tunnels: [], tags: {} } as any,
      { vpnConnectionId: 'vpn-2', customerGatewayId: 'cgw-2', tunnels: [], tags: {} } as any,
    ];
    expect(ruleCgwRedundancy(t).recommendation).toBeNull();
  });
});

describe('ruleDxPartnerDiversity', () => {
  it('returns no recommendation with fewer than 2 connections', () => {
    const t = makeEmptyTopology();
    t.connections = [{ connectionId: 'c1', partnerName: 'Equinix', tags: {} } as any];
    expect(ruleDxPartnerDiversity(t).recommendation).toBeNull();
  });

  it('stays silent when no partner names are populated', () => {
    const t = makeEmptyTopology();
    t.connections = [
      { connectionId: 'c1', tags: {} } as any,
      { connectionId: 'c2', tags: {} } as any,
    ];
    expect(ruleDxPartnerDiversity(t).recommendation).toBeNull();
  });

  it('fires when all connections share a partner', () => {
    const t = makeEmptyTopology();
    t.connections = [
      { connectionId: 'c1', partnerName: 'Equinix', tags: {} } as any,
      { connectionId: 'c2', partnerName: 'Equinix', tags: {} } as any,
    ];
    const result = ruleDxPartnerDiversity(t);
    expect(result.recommendation).not.toBeNull();
    expect(result.recommendation!.description).toContain('Equinix');
  });

  it('returns no recommendation when partners differ', () => {
    const t = makeEmptyTopology();
    t.connections = [
      { connectionId: 'c1', partnerName: 'Equinix', tags: {} } as any,
      { connectionId: 'c2', partnerName: 'Megaport', tags: {} } as any,
    ];
    expect(ruleDxPartnerDiversity(t).recommendation).toBeNull();
  });
});

describe('ruleVpnDpd', () => {
  it('returns no recommendation without VPN connections', () => {
    expect(ruleVpnDpd(makeEmptyTopology()).recommendation).toBeNull();
  });

  it('returns info attestation when every tunnel has a DPD action configured', () => {
    const t = makeEmptyTopology();
    t.vpnConnections = [{
      vpnConnectionId: 'vpn-1',
      customerGatewayId: 'cgw-1',
      tunnels: [
        { status: 'UP', dpdTimeoutAction: 'restart' },
        { status: 'UP', dpdTimeoutAction: 'clear' },
      ],
      tags: {},
    } as any];
    const result = ruleVpnDpd(t);
    expect(result.recommendation).not.toBeNull();
    expect(result.recommendation!.ruleId).toBe('vpn-dpd');
    expect(result.recommendation!.severity).toBe('info');
  });

  it('warns when a tunnel has DpdTimeoutAction set to none', () => {
    const t = makeEmptyTopology();
    t.vpnConnections = [{
      vpnConnectionId: 'vpn-lax',
      customerGatewayId: 'cgw-1',
      tunnels: [
        { status: 'UP', outsideIpAddress: '1.2.3.4', dpdTimeoutAction: 'none' },
        { status: 'UP', outsideIpAddress: '1.2.3.5', dpdTimeoutAction: 'restart' },
      ],
      tags: {},
    } as any];
    const result = ruleVpnDpd(t);
    expect(result.recommendation).not.toBeNull();
    expect(result.recommendation!.severity).toBe('warning');
    expect(result.recommendation!.description).toContain('vpn-lax');
    expect(result.recommendation!.description).toContain('1.2.3.4');
  });

  it('falls back to info attestation when DPD config is not yet populated', () => {
    const t = makeEmptyTopology();
    t.vpnConnections = [{
      vpnConnectionId: 'vpn-unknown',
      customerGatewayId: 'cgw-1',
      tunnels: [{ status: 'UP' }, { status: 'UP' }],
      tags: {},
    } as any];
    const result = ruleVpnDpd(t);
    expect(result.recommendation).not.toBeNull();
    expect(result.recommendation!.severity).toBe('info');
  });
});

describe('ruleDxLocationRedundancy', () => {
  it('returns no recommendation for empty topology', () => {
    expect(ruleDxLocationRedundancy(makeEmptyTopology()).recommendation).toBeNull();
  });

  it('returns info recommendation when DX exists', () => {
    const t = makeEmptyTopology();
    t.connections = [{ connectionId: 'c1', tags: {} } as any];
    const result = ruleDxLocationRedundancy(t);
    expect(result.recommendation).not.toBeNull();
    expect(result.recommendation!.description).toContain('Metro');
    expect(result.recommendation!.description).toContain('Geographic');
  });
});

describe('ruleBgpTimersFallback', () => {
  it('returns no recommendation without VIFs', () => {
    expect(ruleBgpTimersFallback(makeEmptyTopology()).recommendation).toBeNull();
  });

  it('returns info recommendation when VIFs exist', () => {
    const t = makeEmptyTopology();
    t.virtualInterfaces = [{ virtualInterfaceId: 'v1', bgpPeers: [], tags: {} } as any];
    const result = ruleBgpTimersFallback(t);
    expect(result.recommendation).not.toBeNull();
    expect(result.recommendation!.ruleId).toBe('bgp-timers-fallback');
  });
});

describe('ruleDxFailoverTesting', () => {
  it('returns no recommendation for empty topology', () => {
    expect(ruleDxFailoverTesting(makeEmptyTopology()).recommendation).toBeNull();
  });

  it('returns info recommendation when DX exists', () => {
    const t = makeEmptyTopology();
    t.connections = [{ connectionId: 'c1', tags: {} } as any];
    const result = ruleDxFailoverTesting(t);
    expect(result.recommendation).not.toBeNull();
    expect(result.recommendation!.description).toContain('72 hours');
  });
});

describe('ruleFailoverRunbooks', () => {
  it('returns no recommendation for empty topology', () => {
    expect(ruleFailoverRunbooks(makeEmptyTopology()).recommendation).toBeNull();
  });

  it('returns info recommendation when DX exists', () => {
    const t = makeEmptyTopology();
    t.connections = [{ connectionId: 'c1', tags: {} } as any];
    const result = ruleFailoverRunbooks(t);
    expect(result.recommendation).not.toBeNull();
    expect(result.recommendation!.ruleId).toBe('failover-runbooks');
  });
});

describe('getAllBestPracticeResults', () => {
  it('returns recommendations sorted by severity (critical > warning > info)', () => {
    const t = makeEmptyTopology();
    t.connections = [{ connectionId: 'c1', connectionName: 'bad', connectionState: 'down', tags: {} } as any];
    const { recommendations } = getAllBestPracticeResults(t);
    // Critical: connection-not-available. Warning: no-vpn-backup.
    // Info: bfd, sla-awareness, resiliency-toolkit, bgp-route-limit, vpn-dpd×0,
    //   dx-location-redundancy, bgp-timers-fallback×0, dx-failover-testing, failover-runbooks.
    // Only VIF-dependent info rules (consistent-prefix-advertisement, bgp-route-limit,
    //   bgp-timers-fallback) need VIFs — we have none here, so they shouldn't fire.
    const severities = recommendations.map((r) => r.severity);
    expect(severities[0]).toBe('critical');
    expect(severities).toContain('warning');
    expect(severities.filter((s) => s === 'info').length).toBeGreaterThan(0);
    // Severity order invariant
    const order = { critical: 0, warning: 1, info: 2 };
    for (let i = 1; i < severities.length; i++) {
      expect(order[severities[i]]).toBeGreaterThanOrEqual(order[severities[i - 1]]);
    }
  });

  it('returns empty for empty topology', () => {
    const { recommendations, annotations } = getAllBestPracticeResults(makeEmptyTopology());
    expect(recommendations).toHaveLength(0);
    expect(annotations).toHaveLength(0);
  });
});
