// Snapshot file format + (de)serialization for export/import.
//
// The snapshot is a single JSON file the customer ships to their SA. It must
// reconstruct the customer's exact view (live overlay, utilization, expanded
// groups, recommendation focus) on the SA's machine without any AWS access.
//
// Map serialization: TopologyData has 7 Map fields. We store each as
// `[key, value][]` tuples — Object.fromEntries would coerce numeric keys to
// strings and be lossy for `utilizationCache`-shaped keys.

import type { TopologyData, DxEdge, DxNode, ViewMode } from '../types/topology';
import type { ResiliencyTarget } from '../engine/resiliency-rules';
import type {
  TgwRouteTableWithRoutes,
  VpcRouteTable,
  CloudWanSegmentRoutes,
} from '../types/aws-resources';

export const SNAPSHOT_SCHEMA_VERSION = 1;

type Tuple<K, V> = [K, V];

export interface SerializedTopologyData {
  connections: TopologyData['connections'];
  virtualInterfaces: TopologyData['virtualInterfaces'];
  dxGateways: TopologyData['dxGateways'];
  dxGatewayAssociations: TopologyData['dxGatewayAssociations'];
  locations: TopologyData['locations'];
  lags: TopologyData['lags'];
  vpcs: TopologyData['vpcs'];
  vpnGateways: TopologyData['vpnGateways'];
  vpnConnections: TopologyData['vpnConnections'];
  transitGateways: TopologyData['transitGateways'];
  transitGatewayAttachments: TopologyData['transitGatewayAttachments'];
  transitGatewayPeeringAttachments: TopologyData['transitGatewayPeeringAttachments'];
  vpcPeerings: TopologyData['vpcPeerings'];
  customerGateways: TopologyData['customerGateways'];
  cloudWanCoreNetworks: TopologyData['cloudWanCoreNetworks'];
  cloudWanAttachments: TopologyData['cloudWanAttachments'];
  cloudWanPeerings: TopologyData['cloudWanPeerings'];
  tgwRouteTables: Tuple<string, TgwRouteTableWithRoutes[]>[];
  vpcRouteTables: Tuple<string, VpcRouteTable[]>[];
  cloudWanRoutes: Tuple<string, CloudWanSegmentRoutes[]>[];
  bgpPrefixMetrics?: Tuple<string, { accepted?: number; advertised?: number }>[];
  vifUtilization?: Tuple<string, { ingressBpsPeak?: number; egressBpsPeak?: number }>[];
  connectionUtilization?: Tuple<string, { ingressBpsPeak?: number; egressBpsPeak?: number }>[];
  utilizationWindowDays?: 30 | 60 | 90;
  maintenanceEvents?: TopologyData['maintenanceEvents'];
  homeAccountId?: string;
  regionNames?: Tuple<string, string>[];
}

export type UtilizationWindowEntry = Tuple<30 | 60 | 90, {
  vif: Tuple<string, { ingressBpsPeak?: number; egressBpsPeak?: number }>[];
  connection: Tuple<string, { ingressBpsPeak?: number; egressBpsPeak?: number }>[];
}>;

export interface SerializedView {
  viewMode: ViewMode;
  showLiveStatus: boolean;
  showUtilization: boolean;
  utilizationWindowDays: 30 | 60 | 90;
  focusedDxGatewayId: string | null;
  resiliencyTargets: Record<string, ResiliencyTarget>;
  expandedVpcGroups: string[];
  expandedTgwGroups: string[];
  expandedPartnerGroups: string[];
  expandedIsolatedTgwGroups: string[];
  expandedTgwRoutePanels: string[];
  expandedVpcRoutePanels: string[];
  expandedVpcPeerPanels: string[];
  expandedCloudWanRoutePanels: string[];
  vpcGroupViewMode: Tuple<string, 'table'>[];
  isolatedTgwGroupViewMode: Tuple<string, 'table'>[];
  showVpcs: boolean;
  showNonDxVpcs: string[];
  expandedUnattachedZone: boolean;
  expandedHiddenAssocZone: boolean;
  // Full utilization cache by window (30/60/90). Captures every window the
  // customer fetched so the SA can flip windows post-import without
  // re-hitting CloudWatch (which would fail without credentials anyway).
  utilizationCache?: UtilizationWindowEntry[];
}

export interface SerializedCustomizations {
  userEdges: DxEdge[];
  hiddenEdgeIds: string[];
  edgeReconnectOverrides: Tuple<string, { source: string; target: string }>[];
  userCustomerSites: DxNode[];
  hiddenCustomerSiteIds: string[];
  userOnPremises: DxNode[];
  hiddenOnPremiseIds: string[];
}

export interface SnapshotFile {
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  exportedAt: string;
  appVersion?: string;
  redactedView: boolean;
  customerNote?: string;
  topology: SerializedTopologyData;
  view: SerializedView;
  customizations: SerializedCustomizations;
}

export function serializeTopologyData(td: TopologyData): SerializedTopologyData {
  return {
    connections: td.connections,
    virtualInterfaces: td.virtualInterfaces,
    dxGateways: td.dxGateways,
    dxGatewayAssociations: td.dxGatewayAssociations,
    locations: td.locations,
    lags: td.lags,
    vpcs: td.vpcs,
    vpnGateways: td.vpnGateways,
    vpnConnections: td.vpnConnections,
    transitGateways: td.transitGateways,
    transitGatewayAttachments: td.transitGatewayAttachments,
    transitGatewayPeeringAttachments: td.transitGatewayPeeringAttachments,
    vpcPeerings: td.vpcPeerings,
    customerGateways: td.customerGateways,
    cloudWanCoreNetworks: td.cloudWanCoreNetworks,
    cloudWanAttachments: td.cloudWanAttachments,
    cloudWanPeerings: td.cloudWanPeerings,
    tgwRouteTables: [...td.tgwRouteTables.entries()],
    vpcRouteTables: [...td.vpcRouteTables.entries()],
    cloudWanRoutes: [...td.cloudWanRoutes.entries()],
    bgpPrefixMetrics: td.bgpPrefixMetrics ? [...td.bgpPrefixMetrics.entries()] : undefined,
    vifUtilization: td.vifUtilization ? [...td.vifUtilization.entries()] : undefined,
    connectionUtilization: td.connectionUtilization ? [...td.connectionUtilization.entries()] : undefined,
    utilizationWindowDays: td.utilizationWindowDays,
    maintenanceEvents: td.maintenanceEvents,
    homeAccountId: td.homeAccountId,
    regionNames: td.regionNames ? [...td.regionNames.entries()] : undefined,
  };
}

export function deserializeTopologyData(s: SerializedTopologyData): TopologyData {
  return {
    connections: s.connections ?? [],
    virtualInterfaces: s.virtualInterfaces ?? [],
    dxGateways: s.dxGateways ?? [],
    dxGatewayAssociations: s.dxGatewayAssociations ?? [],
    locations: s.locations ?? [],
    lags: s.lags ?? [],
    vpcs: s.vpcs ?? [],
    vpnGateways: s.vpnGateways ?? [],
    vpnConnections: s.vpnConnections ?? [],
    transitGateways: s.transitGateways ?? [],
    transitGatewayAttachments: s.transitGatewayAttachments ?? [],
    transitGatewayPeeringAttachments: s.transitGatewayPeeringAttachments ?? [],
    vpcPeerings: s.vpcPeerings ?? [],
    customerGateways: s.customerGateways ?? [],
    cloudWanCoreNetworks: s.cloudWanCoreNetworks ?? [],
    cloudWanAttachments: s.cloudWanAttachments ?? [],
    cloudWanPeerings: s.cloudWanPeerings ?? [],
    tgwRouteTables: new Map(s.tgwRouteTables ?? []),
    vpcRouteTables: new Map(s.vpcRouteTables ?? []),
    cloudWanRoutes: new Map(s.cloudWanRoutes ?? []),
    bgpPrefixMetrics: s.bgpPrefixMetrics ? new Map(s.bgpPrefixMetrics) : undefined,
    vifUtilization: s.vifUtilization ? new Map(s.vifUtilization) : undefined,
    connectionUtilization: s.connectionUtilization ? new Map(s.connectionUtilization) : undefined,
    utilizationWindowDays: s.utilizationWindowDays,
    maintenanceEvents: s.maintenanceEvents,
    homeAccountId: s.homeAccountId,
    regionNames: s.regionNames ? new Map(s.regionNames) : undefined,
  };
}

export class SnapshotValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotValidationError';
  }
}

// Lightweight runtime validation. We don't pull in a schema library — the
// shape comes from a trusted source (our own export), so we check the load-
// bearing pieces and accept that downstream code will fail loudly on garbage.
export function validateSnapshot(parsed: unknown): SnapshotFile {
  if (!parsed || typeof parsed !== 'object') {
    throw new SnapshotValidationError('Snapshot is not a JSON object.');
  }
  const file = parsed as Record<string, unknown>;
  if (file.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    throw new SnapshotValidationError(
      `Unsupported snapshot schema version: ${String(file.schemaVersion)}. ` +
        `Expected ${SNAPSHOT_SCHEMA_VERSION}.`,
    );
  }
  if (typeof file.exportedAt !== 'string') {
    throw new SnapshotValidationError('Snapshot is missing exportedAt timestamp.');
  }
  if (typeof file.redactedView !== 'boolean') {
    throw new SnapshotValidationError('Snapshot is missing redactedView flag.');
  }
  if (!file.topology || typeof file.topology !== 'object') {
    throw new SnapshotValidationError('Snapshot is missing topology data.');
  }
  if (!file.view || typeof file.view !== 'object') {
    throw new SnapshotValidationError('Snapshot is missing view state.');
  }
  if (!file.customizations || typeof file.customizations !== 'object') {
    throw new SnapshotValidationError('Snapshot is missing customizations slice.');
  }
  return parsed as SnapshotFile;
}
