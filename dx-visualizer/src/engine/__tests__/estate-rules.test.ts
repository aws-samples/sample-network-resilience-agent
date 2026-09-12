import { describe, it, expect } from 'vitest';
import {
  ruleSharedLogicalDevice,
  ruleConnectionLogicalRedundancy,
  ruleUnusedDxGateway,
  ruleRecentAwsIssue,
} from '../bestpractice-rules';
import { getLocationLinkCounts, getLocationDeviceCounts } from '../sla-gating';
import { makeEmptyTopology } from './helpers';
import type {
  DxVirtualInterface,
  DxConnection,
  DxMaintenanceEvent,
} from '../../types/aws-resources';

const vif = (id: string, over: Partial<DxVirtualInterface> = {}): DxVirtualInterface => ({
  virtualInterfaceId: id,
  virtualInterfaceName: id,
  virtualInterfaceType: 'private',
  virtualInterfaceState: 'available',
  connectionId: 'c1',
  vlan: 100,
  asn: 65000,
  bgpPeers: [],
  region: 'ap-southeast-1',
  ...over,
});

const conn = (id: string, over: Partial<DxConnection> = {}): DxConnection => ({
  connectionId: id,
  connectionName: id,
  connectionState: 'available',
  location: 'EqSG2',
  bandwidth: '1Gbps',
  region: 'ap-southeast-1',
  ...over,
});

describe('ruleSharedLogicalDevice', () => {
  it('is critical when a shared device is a routing domain\'s only path', () => {
    const t = makeEmptyTopology();
    t.virtualInterfaces = [
      vif('v1', { directConnectGatewayId: 'dxgw-prod', awsLogicalDeviceId: 'dev-a' }),
      vif('v2', { directConnectGatewayId: 'dxgw-prod', awsLogicalDeviceId: 'dev-b' }),
      // Staging's only VIF, on the same device as prod's primary.
      vif('v3', { directConnectGatewayId: 'dxgw-stg', awsLogicalDeviceId: 'dev-a' }),
    ];
    const rec = ruleSharedLogicalDevice(t).recommendation!;
    expect(rec.ruleId).toBe('shared-logical-device');
    expect(rec.severity).toBe('critical');
    expect(rec.description).toContain('dev-a carries 2 VIFs for 2 routing domains');
    expect(rec.description).toContain('dxgw-stg would be left with no path at all');
  });

  it('is a warning when every affected domain keeps another path', () => {
    const t = makeEmptyTopology();
    t.virtualInterfaces = [
      vif('v1', { directConnectGatewayId: 'dxgw-a', awsLogicalDeviceId: 'dev-a' }),
      vif('v2', { directConnectGatewayId: 'dxgw-a', awsLogicalDeviceId: 'dev-b' }),
      vif('v3', { directConnectGatewayId: 'dxgw-b', awsLogicalDeviceId: 'dev-a' }),
      vif('v4', { directConnectGatewayId: 'dxgw-b', awsLogicalDeviceId: 'dev-b' }),
    ];
    const rec = ruleSharedLogicalDevice(t).recommendation!;
    expect(rec.severity).toBe('warning');
    expect(rec.description).not.toContain('no path at all');
  });

  it('resolves the gateway name so the reader is not shown a bare UUID', () => {
    const t = makeEmptyTopology();
    t.dxGateways = [
      { directConnectGatewayId: 'dxgw-a', directConnectGatewayName: 'Prod', amazonSideAsn: 64512, directConnectGatewayState: 'available' },
    ];
    t.virtualInterfaces = [
      vif('v1', { directConnectGatewayId: 'dxgw-a', awsLogicalDeviceId: 'dev-a' }),
      vif('v2', { directConnectGatewayId: 'vgw-1', awsLogicalDeviceId: 'dev-a' }),
    ];
    expect(ruleSharedLogicalDevice(t).recommendation!.description).toContain('Prod');
  });

  it('stays silent when one device serves a single routing domain', () => {
    const t = makeEmptyTopology();
    t.virtualInterfaces = [
      vif('v1', { directConnectGatewayId: 'dxgw-a', awsLogicalDeviceId: 'dev-a' }),
      vif('v2', { directConnectGatewayId: 'dxgw-a', awsLogicalDeviceId: 'dev-a' }),
    ];
    expect(ruleSharedLogicalDevice(t).recommendation).toBeNull();
  });

  it('stays silent when AWS did not report device identity', () => {
    const t = makeEmptyTopology();
    t.virtualInterfaces = [
      vif('v1', { directConnectGatewayId: 'dxgw-a' }),
      vif('v2', { directConnectGatewayId: 'dxgw-b' }),
    ];
    expect(ruleSharedLogicalDevice(t).recommendation).toBeNull();
  });
});

describe('ruleConnectionLogicalRedundancy', () => {
  it('reports AWS\'s own "no" verdict, grouped by location', () => {
    const t = makeEmptyTopology();
    t.connections = [
      conn('c1', { hasLogicalRedundancy: 'no' }),
      conn('c2', { location: 'EqSG3', hasLogicalRedundancy: 'yes' }),
    ];
    const rec = ruleConnectionLogicalRedundancy(t).recommendation!;
    expect(rec.ruleId).toBe('logical-redundancy');
    expect(rec.severity).toBe('warning');
    expect(rec.description).toContain('1 of 2 connections');
    expect(rec.description).toContain('EqSG2: c1');
  });

  it('accepts "Yes" in any case AWS returns it', () => {
    const t = makeEmptyTopology();
    t.connections = [conn('c1', { hasLogicalRedundancy: 'Yes' }), conn('c2', { hasLogicalRedundancy: 'yes' })];
    expect(ruleConnectionLogicalRedundancy(t).recommendation!.ruleId).toBe('logical-redundancy-ok');
  });

  it('stays silent when AWS reported no verdict, and skips inferred connections', () => {
    const t = makeEmptyTopology();
    t.connections = [conn('c1'), conn('c2', { isInferred: true, hasLogicalRedundancy: 'no' })];
    expect(ruleConnectionLogicalRedundancy(t).recommendation).toBeNull();
  });
});

describe('ruleUnusedDxGateway', () => {
  const gw = (id: string) => ({
    directConnectGatewayId: id,
    directConnectGatewayName: id,
    amazonSideAsn: 64512,
    directConnectGatewayState: 'available' as const,
  });

  it('flags a gateway with neither VIFs nor associations', () => {
    const t = makeEmptyTopology();
    t.dxGateways = [gw('dxgw-idle')];
    expect(ruleUnusedDxGateway(t).recommendation!.ruleId).toBe('unused-dxgw');
  });

  it('stays silent when the gateway has an association but no VIF yet', () => {
    const t = makeEmptyTopology();
    t.dxGateways = [gw('dxgw-a')];
    t.dxGatewayAssociations = [
      {
        directConnectGatewayId: 'dxgw-a',
        associationId: 'a1',
        associationState: 'associated',
        allowedPrefixes: [],
        associatedGateway: {
          id: 'tgw-1',
          type: 'transitGateway',
          region: 'ap-southeast-1',
          ownerAccount: '111122223333',
        },
      },
    ];
    expect(ruleUnusedDxGateway(t).recommendation).toBeNull();
  });

  it('stays silent when the gateway carries a VIF', () => {
    const t = makeEmptyTopology();
    t.dxGateways = [gw('dxgw-a')];
    t.virtualInterfaces = [vif('v1', { directConnectGatewayId: 'dxgw-a' })];
    expect(ruleUnusedDxGateway(t).recommendation).toBeNull();
  });
});

describe('ruleRecentAwsIssue', () => {
  const issue = (over: Partial<DxMaintenanceEvent> = {}): DxMaintenanceEvent => ({
    arn: 'arn:aws:health:::event/DIRECTCONNECT/x',
    eventTypeCode: 'AWS_DIRECTCONNECT_CONNECTION_ISSUE',
    region: 'ap-southeast-1',
    statusCode: 'closed',
    eventTypeCategory: 'issue',
    eventScopeCode: 'ACCOUNT_SPECIFIC',
    startTime: '2026-08-01T00:00:00Z',
    affectedResourceIds: [],
    description: 'Elevated packet loss on a Direct Connect device.',
    ...over,
  });

  it('names the affected resource when AWS itemised one we own', () => {
    const t = makeEmptyTopology();
    t.connections = [conn('dxcon-abc')];
    t.maintenanceEvents = [issue({ affectedResourceIds: ['dxcon-abc'] })];
    const rec = ruleRecentAwsIssue(t).recommendation!;
    expect(rec.severity).toBe('info');
    expect(rec.description).toContain('dxcon-abc');
    expect(rec.description).toContain('2026-08-01');
    expect(rec.description).toContain('(resolved)');
  });

  it('says the scope was not itemised rather than inventing one', () => {
    const t = makeEmptyTopology();
    t.maintenanceEvents = [issue()];
    expect(ruleRecentAwsIssue(t).recommendation!.description)
      .toContain('this account, resources not itemised by AWS');
  });

  it('warns while an issue is still open', () => {
    const t = makeEmptyTopology();
    t.maintenanceEvents = [issue({ statusCode: 'open' })];
    const rec = ruleRecentAwsIssue(t).recommendation!;
    expect(rec.severity).toBe('warning');
    expect(rec.title).toContain('ongoing');
  });

  it('warns on repeats, because a pattern outranks an isolated fault', () => {
    const t = makeEmptyTopology();
    t.maintenanceEvents = [issue(), issue({ startTime: '2026-08-20T00:00:00Z' })];
    const rec = ruleRecentAwsIssue(t).recommendation!;
    expect(rec.severity).toBe('warning');
    expect(rec.description).toContain('a pattern rather than an isolated fault');
  });

  it('ignores scheduled changes and region-wide PUBLIC events', () => {
    const scheduled = makeEmptyTopology();
    scheduled.maintenanceEvents = [issue({ eventTypeCategory: 'scheduledChange' })];
    expect(ruleRecentAwsIssue(scheduled).recommendation).toBeNull();

    const broadcast = makeEmptyTopology();
    broadcast.maintenanceEvents = [issue({ eventScopeCode: 'PUBLIC' })];
    expect(ruleRecentAwsIssue(broadcast).recommendation).toBeNull();
  });
});

describe('getLocationLinkCounts', () => {
  it('separates a 2+1 split from a 1+2 one, with devices alongside connections', () => {
    const t = makeEmptyTopology();
    t.connections = [
      conn('c1', { location: 'EqSG2', awsLogicalDeviceId: 'dev-a' }),
      conn('c2', { location: 'EqSG2', awsLogicalDeviceId: 'dev-b' }),
      conn('c3', { location: 'EqSG3', awsLogicalDeviceId: 'dev-c' }),
    ];
    const counts = getLocationLinkCounts(t);
    expect(counts.get('EqSG2')).toEqual({ connections: 2, devices: 2 });
    expect(counts.get('EqSG3')).toEqual({ connections: 1, devices: 1 });
  });

  it('reports two connections on one device as 2 links but 1 device', () => {
    const t = makeEmptyTopology();
    t.connections = [
      conn('c1', { awsLogicalDeviceId: 'dev-a' }),
      conn('c2', { awsLogicalDeviceId: 'dev-a' }),
    ];
    expect(getLocationLinkCounts(t).get('EqSG2')).toEqual({ connections: 2, devices: 1 });
  });

  it('counts distinct connections, not VIFs, in the hosted-VIF fallback', () => {
    const t = makeEmptyTopology();
    // Three VIFs sharing one hosted link: a single-link location, not a redundant one.
    t.virtualInterfaces = [
      vif('v1', { connectionId: 'dxcon-h', location: 'EqSG2', awsLogicalDeviceId: 'dev-a' }),
      vif('v2', { connectionId: 'dxcon-h', location: 'EqSG2', awsLogicalDeviceId: 'dev-a' }),
      vif('v3', { connectionId: 'dxcon-h', location: 'EqSG2', awsLogicalDeviceId: 'dev-a' }),
    ];
    expect(getLocationLinkCounts(t).get('EqSG2')).toEqual({ connections: 1, devices: 1 });
  });

  it('keeps getLocationDeviceCounts in step with it', () => {
    const t = makeEmptyTopology();
    t.connections = [
      conn('c1', { awsLogicalDeviceId: 'dev-a' }),
      conn('c2', { awsLogicalDeviceId: 'dev-a' }),
      conn('c3', { location: 'EqSG3', awsLogicalDeviceId: 'dev-c' }),
    ];
    const devices = getLocationDeviceCounts(t);
    for (const [loc, links] of getLocationLinkCounts(t)) {
      expect(devices.get(loc)).toBe(links.devices);
    }
    expect(devices.get('EqSG2')).toBe(1);
  });

  it('falls back to the connection id when AWS reported no device identity', () => {
    const t = makeEmptyTopology();
    // Erring generous: two connections with unknown devices count as two.
    t.connections = [conn('c1'), conn('c2')];
    expect(getLocationLinkCounts(t).get('EqSG2')).toEqual({ connections: 2, devices: 2 });
  });
});
