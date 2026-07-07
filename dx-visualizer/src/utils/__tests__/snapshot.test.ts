import { describe, it, expect } from 'vitest';
import {
  serializeTopologyData,
  deserializeTopologyData,
  validateSnapshot,
  SnapshotValidationError,
  SNAPSHOT_SCHEMA_VERSION,
  type SnapshotFile,
} from '../snapshot';
import type { TopologyData } from '../../types/topology';

function makeTopology(): TopologyData {
  return {
    connections: [
      {
        connectionId: 'dxcon-aaaa1111',
        connectionName: 'conn-1',
        connectionState: 'available',
        location: 'EqDC2',
        bandwidth: '1Gbps',
        region: 'us-east-1',
      },
    ],
    virtualInterfaces: [],
    dxGateways: [],
    dxGatewayAssociations: [],
    locations: [],
    lags: [],
    vpcs: [],
    vpnGateways: [],
    vpnConnections: [],
    transitGateways: [],
    transitGatewayAttachments: [],
    transitGatewayPeeringAttachments: [],
    vpcPeerings: [],
    customerGateways: [],
    cloudWanCoreNetworks: [],
    cloudWanAttachments: [],
    cloudWanPeerings: [],
    tgwRouteTables: new Map([
      ['tgw-1', []],
      ['tgw-2', []],
    ]),
    vpcRouteTables: new Map([['vpc-1', []]]),
    cloudWanRoutes: new Map(),
    vifUtilization: new Map([['dxvif-1', { ingressBpsPeak: 100, egressBpsPeak: 200 }]]),
    connectionUtilization: new Map([['dxcon-aaaa1111', { ingressBpsPeak: 300 }]]),
    utilizationWindowDays: 60,
    homeAccountId: '123456789012',
    regionNames: new Map([['us-east-1', 'US East (N. Virginia)']]),
  };
}

describe('serializeTopologyData / deserializeTopologyData', () => {
  it('round-trips Map fields through JSON', () => {
    const td = makeTopology();
    const wire = JSON.parse(JSON.stringify(serializeTopologyData(td)));
    const back = deserializeTopologyData(wire);
    expect(back.tgwRouteTables).toBeInstanceOf(Map);
    expect(back.vpcRouteTables).toBeInstanceOf(Map);
    expect(back.cloudWanRoutes).toBeInstanceOf(Map);
    expect(back.vifUtilization).toBeInstanceOf(Map);
    expect(back.connectionUtilization).toBeInstanceOf(Map);
    expect(back.regionNames).toBeInstanceOf(Map);

    expect([...back.tgwRouteTables.keys()].sort()).toEqual(['tgw-1', 'tgw-2']);
    expect(back.vifUtilization?.get('dxvif-1')).toEqual({ ingressBpsPeak: 100, egressBpsPeak: 200 });
    expect(back.regionNames?.get('us-east-1')).toBe('US East (N. Virginia)');
    expect(back.utilizationWindowDays).toBe(60);
    expect(back.homeAccountId).toBe('123456789012');
  });

  it('preserves array contents verbatim', () => {
    const td = makeTopology();
    const back = deserializeTopologyData(JSON.parse(JSON.stringify(serializeTopologyData(td))));
    expect(back.connections).toEqual(td.connections);
  });

  it('handles missing optional Map fields without crashing', () => {
    const td = makeTopology();
    delete td.bgpPrefixMetrics;
    delete td.vifUtilization;
    delete td.connectionUtilization;
    delete td.regionNames;
    const back = deserializeTopologyData(JSON.parse(JSON.stringify(serializeTopologyData(td))));
    expect(back.bgpPrefixMetrics).toBeUndefined();
    expect(back.vifUtilization).toBeUndefined();
    expect(back.connectionUtilization).toBeUndefined();
    expect(back.regionNames).toBeUndefined();
  });
});

describe('validateSnapshot', () => {
  function validFile(): SnapshotFile {
    return {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      exportedAt: '2026-06-04T12:00:00Z',
      redactedView: false,
      topology: serializeTopologyData(makeTopology()),
      view: {
        viewMode: 'current',
        showLiveStatus: false,
        showUtilization: false,
        utilizationWindowDays: 30,
        focusedDxGatewayId: null,
        resiliencyTargets: {},
        expandedVpcGroups: [],
        expandedTgwGroups: [],
        expandedPartnerGroups: [],
        expandedIsolatedTgwGroups: [],
        expandedTgwRoutePanels: [],
        expandedVpcRoutePanels: [],
        expandedVpcPeerPanels: [],
        expandedCloudWanRoutePanels: [],
        vpcGroupViewMode: [],
        isolatedTgwGroupViewMode: [],
        showVpcs: true,
        showNonDxVpcs: [],
        expandedUnattachedZone: false,
        expandedHiddenAssocZone: false,
      },
      customizations: {
        userEdges: [],
        hiddenEdgeIds: [],
        edgeReconnectOverrides: [],
        userCustomerSites: [],
        hiddenCustomerSiteIds: [],
        userOnPremises: [],
        hiddenOnPremiseIds: [],
      },
    };
  }

  it('accepts a well-formed file', () => {
    const file = validFile();
    expect(() => validateSnapshot(file)).not.toThrow();
  });

  it('rejects non-objects', () => {
    expect(() => validateSnapshot(null)).toThrow(SnapshotValidationError);
    expect(() => validateSnapshot('not a snapshot')).toThrow(SnapshotValidationError);
  });

  it('rejects unsupported schema versions', () => {
    const file = validFile() as unknown as Record<string, unknown>;
    file.schemaVersion = 999;
    expect(() => validateSnapshot(file)).toThrow(/Unsupported snapshot schema version/);
  });

  it('rejects missing redactedView flag', () => {
    const file = validFile() as unknown as Record<string, unknown>;
    delete file.redactedView;
    expect(() => validateSnapshot(file)).toThrow(/redactedView/);
  });

  it('rejects missing topology', () => {
    const file = validFile() as unknown as Record<string, unknown>;
    delete file.topology;
    expect(() => validateSnapshot(file)).toThrow(/topology/);
  });
});
