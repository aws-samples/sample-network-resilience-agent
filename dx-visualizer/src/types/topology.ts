import type { Node, Edge } from '@xyflow/react';
import type {
  DxConnection,
  DxVirtualInterface,
  DxGateway,
  DxGatewayAssociation,
  DxLocation,
  DxLag,
  Vpc,
  VpnGateway,
  VpnConnection,
  VpnTunnel,
  TransitGateway,
  TransitGatewayAttachment,
  TransitGatewayPeeringAttachment,
  VpcPeeringConnection,
  CustomerGateway,
  CloudWanCoreNetwork,
  CloudWanAttachment,
  CloudWanPeering,
  TgwRouteTableWithRoutes,
  VpcRouteTable,
  CloudWanSegmentRoutes,
  DxMaintenanceEvent,
} from './aws-resources';

export interface TopologyData {
  connections: DxConnection[];
  virtualInterfaces: DxVirtualInterface[];
  dxGateways: DxGateway[];
  dxGatewayAssociations: DxGatewayAssociation[];
  locations: DxLocation[];
  lags: DxLag[];
  vpcs: Vpc[];
  vpnGateways: VpnGateway[];
  vpnConnections: VpnConnection[];
  transitGateways: TransitGateway[];
  transitGatewayAttachments: TransitGatewayAttachment[];
  transitGatewayPeeringAttachments: TransitGatewayPeeringAttachment[];
  vpcPeerings: VpcPeeringConnection[];
  customerGateways: CustomerGateway[];
  cloudWanCoreNetworks: CloudWanCoreNetwork[];
  cloudWanAttachments: CloudWanAttachment[];
  cloudWanPeerings: CloudWanPeering[];
  tgwRouteTables: Map<string, TgwRouteTableWithRoutes[]>;
  /** VPC route tables keyed by vpcId. Each entry includes routes + subnet associations. */
  vpcRouteTables: Map<string, VpcRouteTable[]>;
  cloudWanRoutes: Map<string, CloudWanSegmentRoutes[]>;
  bgpPrefixMetrics?: Map<string, { accepted?: number; advertised?: number }>;
  vifUtilization?: Map<string, { ingressBpsPeak?: number; egressBpsPeak?: number }>;
  connectionUtilization?: Map<string, { ingressBpsPeak?: number; egressBpsPeak?: number }>;
  utilizationWindowDays?: 30 | 60 | 90;
  maintenanceEvents?: DxMaintenanceEvent[];
  homeAccountId?: string;
  regionNames?: Map<string, string>;
  publicVifResources?: PublicVifResource[];
}

export interface PublicVifResource {
  virtualInterfaceId: string;
  service: 'S3' | 'CloudFront' | 'EC2' | 'DynamoDB' | 'API Gateway' | 'Route 53' | 'Elastic IP';
  resourceId: string;
  resourceName?: string;
}

export type ViewMode = 'current' | 'recommended';

export interface GraphData {
  nodes: Node[];
  edges: Edge[];
}

export type NodeCategory =
  | 'customerSite'
  | 'onPremise'
  | 'cgw'
  | 'dxLocation'
  | 'dxPartnerDevice'
  | 'dxPartnerDeviceGroup'
  | 'lag'
  | 'awsDevice'
  | 'dxGateway'
  | 'tgw'
  | 'tgwConnect'
  | 'vgw'
  | 'vpc'
  | 'vpcGroup'
  | 'tgwGroup'
  | 'isolatedTgwGroup'
  | 'region'
  | 'unattachedZone'
  | 'hiddenAssocZone'
  | 'awsCloud'
  | 'coreNetwork'
  | 'publicResources';

export interface VpcChildInfo {
  vpcId: string;
  name: string;
  cidr: string;
  state: string;
  region?: string;
  crossAccount?: boolean;
  ownerAccount?: string;
}

// One VPC-peering relationship as seen from a specific VPC node's perspective.
// Precomputed at build time (where peer names/regions resolve) and stamped onto
// the local VPC's node data so the node can list "who am I peered with" without
// forcing the user to trace bundled peering edges on the canvas.
export interface VpcPeerInfo {
  // The React Flow edge id of the peering edge, so hovering a row can spotlight
  // exactly that edge on the canvas.
  edgeId: string;
  pcxId: string;
  state?: string;
  // The *other* VPC in the relationship.
  peerVpcId: string;
  peerName: string;
  peerRegion: string;
  peerCidr?: string;
  // 'out' when this VPC is the peering requester, 'in' when it is the accepter.
  direction: 'in' | 'out';
  crossAccount?: boolean;
  peerOwnerAccount?: string;
}

export interface TgwChildInfo {
  tgwId: string;
  name: string;
  state: string;
  asn?: string;
  region?: string;
  crossAccount?: boolean;
  ownerAccount?: string;
}

export interface VgwChildInfo {
  vgwId: string;
  name: string;
  state: string;
  asn?: string;
  region?: string;
  attachmentState?: string;
}

export interface DxgwChildInfo {
  dxgwId: string;
  name: string;
  state: string;
  asn?: string;
}

export interface HiddenAssocChildInfo {
  dxGatewayId: string;
  dxGatewayName: string;
  state: string;
  reason: 'prefixPool';
}

export interface DxNodeData extends Record<string, unknown> {
  label: string;
  category: NodeCategory;
  isRecommended?: boolean;
  isInferred?: boolean;
  isOrphan?: boolean;
  // Orphan VPCs (no TGW/VGW/Cloud WAN attachment) and isolated TGWs
  // (no attachments of any kind) — marked so the "Show unattached" toolbar
  // toggle can hide them en masse without touching the rest of the graph.
  isUnattached?: boolean;
  resourceId?: string;
  details?: Record<string, string>;
  badges?: NodeBadge[];
  childCount?: number;
  isExpanded?: boolean;
  targetHandleIds?: string[];
  hasTopHandle?: boolean;
  // TGWs involved in a TGW↔TGW or Cloud WAN↔TGW peering need named left
  // handles for the peering edges to anchor to. Flagged per-node so the
  // handles only render when an edge actually references them — otherwise
  // ReactFlow picks the left source handle ahead of the default Right
  // source handle for unqualified edges (e.g. TGW→VPC).
  hasPeeringHandle?: boolean;
  // VPC-peering relationships for this VPC, precomputed so the node can render a
  // "Peers ▾" list — the readable alternative to tracing many bundled peering
  // edges that all leave the same handle.
  vpcPeers?: VpcPeerInfo[];
  vpcChildren?: VpcChildInfo[];
  tgwChildren?: TgwChildInfo[];
  vgwChildren?: VgwChildInfo[];
  dxgwChildren?: DxgwChildInfo[];
  hiddenAssocChildren?: HiddenAssocChildInfo[];
  // Total VPCs reachable only via non-DX TGWs/VGWs — drives the Region header
  // "Show/Hide non-DX" toggle label. Whether they're currently hidden is
  // derived from `showNonDxVpcs.has(regionCode)` in the store.
  nonDxVpcCount?: number;
}

export interface NodeBadge {
  type: 'warning' | 'info' | 'error';
  label: string;
  description: string;
}

export type DxNode = Node<DxNodeData>;
export type DxEdge = Edge & {
  data?: {
    isRecommended?: boolean;
    isInferred?: boolean;
    vifType?: 'private' | 'transit' | 'public';
    vlan?: number;
    label?: string;
    connectionId?: string;
    connectionState?: string;
    tunnels?: VpnTunnel[];
    vifState?: string;
    bgpStatus?: string;
    vifId?: string;
    prefixesAccepted?: number;
    prefixesAdvertised?: number;
    // Peak hourly bitrate over the user-selected window (30/60/90 days) from
    // CloudWatch (AWS/DX namespace). Populated only when the user enables
    // "Show utilization" in live mode.
    utilizationIngressBps?: number;
    utilizationEgressBps?: number;
    // Underlying connection bandwidth string (e.g. "1Gbps") — used to format
    // utilization as a percentage of capacity on VIF edges.
    connectionBandwidth?: string;
    labelPosition?: number;
    sourceHandle?: string;
    targetHandle?: string;
    edgeStyle?: 'smoothstep';
    // Lateral peering edges (VPC↔VPC, TGW↔TGW, Cloud WAN↔TGW). Hovering these
    // highlights only the single edge + its two endpoints, not a full E2E BFS
    // path — a peering is a point-to-point relationship, not an upstream path.
    isPeering?: boolean;
    // For VPC↔VPC peering edges: whether both endpoints sit in the SAME region
    // ('intra') or different regions ('cross'). Drives lane routing — intra
    // peerings stay inside their region box with a fixed lane offset; cross
    // peerings route outside the region (but inside AWS) via the existing scan.
    peeringScope?: 'intra' | 'cross';
    aggregatedVifs?: AggregatedVifInfo[];
    // Parallel-edge bowing: when several edges connect the SAME two nodes (e.g.
    // the customer-gateway → LAG member links), each shares one source/target
    // dot. CustomEdge bows edge `parallelIndex` of `parallelCount` off the
    // straight chord by a per-index offset so they read as distinct lines with
    // vertically-separated labels.
    parallelIndex?: number;
    parallelCount?: number;
  };
};

export interface AggregatedVifInfo {
  vifId: string;
  vifType: 'private' | 'transit' | 'public';
  vlan: number;
  vifState: string;
  bgpStatus?: string;
  prefixesAccepted?: number;
  prefixesAdvertised?: number;
  utilizationIngressBps?: number;
  utilizationEgressBps?: number;
  connectionBandwidth?: string;
}
