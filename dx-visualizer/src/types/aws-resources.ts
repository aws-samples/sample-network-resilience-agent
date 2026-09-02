export interface DxConnection {
  connectionId: string;
  connectionName: string;
  connectionState: string;
  location: string;
  bandwidth: string;
  lagId?: string;
  partnerName?: string;
  vlan?: number;
  region: string;
  hasBfd?: boolean;
  awsDeviceV2?: string;
  awsLogicalDeviceId?: string;
  // True when this record was synthesized from a VIF whose underlying cable
  // is owned by another account (hosted VIF on external connection). The
  // visualizer renders these with an amber accent so it's clear the physical
  // path was reconstructed rather than observed via DescribeConnections.
  isInferred?: boolean;
  rateLimiterStatus?: RateLimiterStatus;
}

export interface BgpPeer {
  bgpPeerId: string;
  bgpPeerState: string;
  bgpStatus: string;
  asn: number;
  customerAddress: string;
  amazonAddress: string;
}

export interface DxVirtualInterface {
  virtualInterfaceId: string;
  virtualInterfaceName: string;
  virtualInterfaceType: 'private' | 'public' | 'transit';
  virtualInterfaceState: string;
  connectionId: string;
  directConnectGatewayId?: string;
  virtualGatewayId?: string;
  vlan: number;
  asn: number;
  addressFamily?: 'ipv4' | 'ipv6';
  mtu?: number;
  bgpPeers: BgpPeer[];
  routeFilterPrefixes?: { cidr: string }[];
  region: string;
  location?: string;
  ownerAccount?: string;
  awsDeviceV2?: string;
  awsLogicalDeviceId?: string;
  // Bandwidth allocation applied to this VIF (e.g. "50Mbps", "1.6Tbps"). When
  // set, it — not the parent connection's bandwidth — is the ceiling this VIF's
  // traffic can reach, so it's the correct denominator for utilization. AWS
  // guarantees it cannot exceed the parent connection or LAG bandwidth.
  rateLimit?: string;
}

// Rate-limiter quota on a connection or LAG: AWS allows a finite number of
// per-VIF rate limiters per port.
export interface RateLimiterStatus {
  maxAllowed?: number;
  inUse?: number;
  remaining?: number;
  /** Total bandwidth allocated across all rate limiters on the connection. */
  totalBandwidth?: string;
}

// One AS_PATH segment of a BGP route. `pathType` is 'seq' (ordered AS_SEQUENCE)
// or 'set' (unordered AS_SET) per the DX API.
export interface VifRouteAsPathSegment {
  pathType?: 'seq' | 'set';
  path: number[];
}

// A single BGP route on a virtual interface, from ListVirtualInterfaceRoutes
// (AWS Direct Connect BGP route visibility, launched 2026-07-30).
export interface VifRoute {
  cidr: string;
  addressFamily?: 'ipv4' | 'ipv6';
  asPath: VifRouteAsPathSegment[];
  // BGP community values as "asn:value" strings (e.g. "7224:8100").
  communities: string[];
  routeDirection: 'accepted' | 'advertised';
  // ISO-8601 string, not the SDK's Date — snapshots are JSON, and the rest of
  // this file already normalizes AWS timestamps this way (see DxMaintenanceEvent).
  routeInstalledAt?: string;
  awsLogicalDeviceId?: string;
}

// Routes for one VIF, split by direction. `accepted` are routes AWS received
// from the customer router; `advertised` are routes AWS sends to it.
export interface VifRoutes {
  accepted: VifRoute[];
  advertised: VifRoute[];
}

// One recorded BGP failover test on a VIF, from ListVirtualInterfaceTestHistory.
// This is the only AWS-side evidence that a customer's redundancy was ever
// actually exercised, rather than merely configured.
export interface VifFailoverTest {
  testId: string;
  virtualInterfaceId: string;
  /** BGP peer IDs that were taken down for the test. */
  bgpPeers: string[];
  /** AWS returns a free-form string, e.g. 'running' | 'completed' | 'cancelled'. */
  status: string;
  /** Account that ran the test — an account ID, so it must be sanitized. */
  ownerAccount?: string;
  testDurationInMinutes?: number;
  /** ISO-8601; snapshots are JSON, so the SDK's Date is normalized. */
  startTime?: string;
  endTime?: string;
}

// CloudWatch AWS/DX BGP prefix counts for one VIF.
export interface BgpPrefixMetrics {
  /** IPv4 + IPv6 combined. Display only — see byFamily for limit checks. */
  accepted?: number;
  advertised?: number;
  /**
   * Per-address-family counts, from the documented `IpAddressFamily` dimension.
   * The quota is "100 each for IPv4 and IPv6", so a limit check must read this
   * rather than the pooled totals above. Absent when the dimension was not
   * reported, or in snapshots written before the split existed.
   */
  byFamily?: Partial<Record<'ipv4' | 'ipv6', { accepted?: number; advertised?: number }>>;
}

// BGP session stability for one VIF, derived from the AWS/DX
// VirtualInterfaceBgpStatus metric (1 = up, 0 = down). DescribeVirtualInterfaces
// only reports the state right now, so without this a VIF that flapped 11 times
// last week is indistinguishable from one solid for a year.
export interface BgpSessionStability {
  /** up→down transitions in the window. 0 = never dropped. */
  flapCount: number;
  /** Sampled periods where the session was down for at least part of the interval. */
  downPeriods: number;
  /** Periods sampled — the denominator for "down 3 of 2016 intervals". */
  totalPeriods: number;
  /** ISO-8601 timestamp of the most recent observed drop. */
  lastFlapAt?: string;
  /** Days actually sampled. CloudWatch retention caps this: 63d at 5-min resolution. */
  windowDays: number;
  byFamily?: Partial<Record<'ipv4' | 'ipv6', { flapCount: number; downPeriods: number }>>;
}

export interface DxGateway {
  directConnectGatewayId: string;
  directConnectGatewayName: string;
  amazonSideAsn: number;
  directConnectGatewayState: string;
}

export interface DxGatewayAssociation {
  directConnectGatewayId: string;
  associationId?: string;
  associatedGateway: {
    id: string;
    type: 'virtualPrivateGateway' | 'transitGateway' | undefined;
    region: string;
    ownerAccount: string;
  };
  // Populated when the DXGW is associated directly to a Cloud WAN core
  // network (AWS returns this in `associatedCoreNetwork` instead of
  // `associatedGateway`). Topology-builder draws a DXGW → Core Network edge
  // for these.
  associatedCoreNetwork?: {
    id: string;
    ownerAccount: string;
    attachmentId: string;
  };
  associationState: string;
  allowedPrefixes: string[];
  // True when AWS returned a stub (no gateway id/type) AND the proposals
  // backfill couldn't resolve it. These are typically prefix-pool / EDGLESS
  // associations where AWS redacts the associated gateway's identity from
  // the DXGW-owner view. Surfaced in the Hidden Associations zone.
  isPrefixPoolStub?: boolean;
}

export interface DxLocation {
  locationCode: string;
  locationName: string;
  region: string;
  availablePortSpeeds: string[];
  /**
   * Partners (providers) who can deliver a circuit at this facility. Lets the
   * partner-diversity rule name the customer's real alternatives instead of
   * advising "use a second provider" in the abstract.
   */
  availableProviders?: string[];
  /** Port speeds at this location that support MACsec. */
  availableMacSecPortSpeeds?: string[];
}

export interface DxLag {
  lagId: string;
  lagName: string;
  connectionsBandwidth: string;
  numberOfConnections: number;
  minimumLinks: number;
  location: string;
  region: string;
  lagState: string;
  connections: DxConnection[];
  rateLimiterStatus?: RateLimiterStatus;
}

export interface Vpc {
  vpcId: string;
  cidrBlock: string;
  tags: Record<string, string>;
  region: string;
  state: string;
  ownerAccountId?: string;
}

export interface VpnGateway {
  vpnGatewayId: string;
  vpcAttachments: { vpcId: string; state: string }[];
  type: string;
  amazonSideAsn: number;
  state: string;
  tags: Record<string, string>;
}

export interface TransitGateway {
  transitGatewayId: string;
  transitGatewayArn: string;
  state: string;
  ownerId: string;
  description: string;
  amazonSideAsn: number;
  tags: Record<string, string>;
}

export interface TransitGatewayAttachment {
  transitGatewayAttachmentId: string;
  transitGatewayId: string;
  resourceType: 'vpc' | 'vpn' | 'direct-connect-gateway' | 'peering' | 'connect' | 'network-function';
  resourceId: string;
  resourceOwnerId: string;
  state: string;
  /** Tag-derived display name, populated for categories that render as standalone nodes (e.g. connect). */
  name?: string;
}

export interface VpcPeeringConnection {
  vpcPeeringConnectionId: string;
  state: string;
  requesterVpc: {
    vpcId: string;
    cidrBlock: string;
    ownerId: string;
    region: string;
  };
  accepterVpc: {
    vpcId: string;
    cidrBlock: string;
    ownerId: string;
    region: string;
  };
  tags: Record<string, string>;
}

export interface TransitGatewayPeeringAttachment {
  transitGatewayAttachmentId: string;
  requesterTgwInfo: {
    transitGatewayId: string;
    region: string;
    ownerId: string;
  };
  accepterTgwInfo: {
    transitGatewayId: string;
    region: string;
    ownerId: string;
  };
  state: string;
  tags: Record<string, string>;
}

export interface VpnTunnel {
  outsideIpAddress: string;
  status: 'UP' | 'DOWN';
  statusMessage?: string;
  acceptedRouteCount?: number;
  // AWS-side DPD config from DescribeVpnConnections → Options.TunnelOptions.
  // Customer-gateway-side DPD config is not exposed by any AWS API.
  dpdTimeoutSeconds?: number;
  dpdTimeoutAction?: string;
  /**
   * When this tunnel last changed state, as ISO-8601 (the SDK returns a Date;
   * normalized here because snapshots are JSON). Turns "tunnel is DOWN" into
   * "DOWN for 6 days" — a tunnel down for months is a different finding from
   * one that just dropped.
   */
  lastStatusChange?: string;
}

export interface VpnConnection {
  vpnConnectionId: string;
  vpnGatewayId?: string;
  transitGatewayId?: string;
  customerGatewayId: string;
  state: string;
  type: string;
  category: string;
  customerGatewayAddress: string;
  tunnels: VpnTunnel[];
  /**
   * True when the VPN uses static routes instead of BGP. A static-routes-only
   * VPN cannot re-route dynamically, so it is a weak DX backup — AWS recommends
   * BGP Site-to-Site VPN for TGW attachments.
   */
  staticRoutesOnly?: boolean;
  tags: Record<string, string>;
}

export interface CustomerGateway {
  customerGatewayId: string;
  bgpAsn: string;
  ipAddress: string;
  state: string;
  type: string;
  tags: Record<string, string>;
}

export interface CloudWanCoreNetwork {
  coreNetworkId: string;
  coreNetworkArn: string;
  globalNetworkId: string;
  description: string;
  state: string;
  edges: {
    edgeLocation: string;
    asn: number;
    insideCidrBlocks: string[];
  }[];
  segments: {
    name: string;
    edgeLocations: string[];
    sharedSegments: string[];
  }[];
}

export interface CloudWanAttachment {
  attachmentId: string;
  coreNetworkId: string;
  ownerAccountId: string;
  attachmentType: 'vpc' | 'site-to-site-vpn' | 'transit-gateway-route-table' | 'connect' | 'direct-connect-gateway';
  edgeLocation: string;
  resourceArn: string;
  segmentName: string;
  state: string;
  tags: Record<string, string>;
}

export interface CloudWanPeering {
  peeringId: string;
  coreNetworkId: string;
  peeringType: string;
  edgeLocation: string;
  resourceArn: string;
  state: string;
  tags: Record<string, string>;
}

export interface CloudWanRoute {
  destinationCidrBlock: string;
  destinations: {
    coreNetworkAttachmentId: string;
    segmentName: string;
    edgeLocation: string;
    resourceType: string;
    resourceId: string;
  }[];
  type: 'static' | 'propagated';
  state: 'active' | 'blackhole';
}

export interface CloudWanSegmentRoutes {
  segmentName: string;
  edgeLocation: string;
  routes: CloudWanRoute[];
}

export interface VpcRoute {
  destinationCidrBlock?: string;
  destinationIpv6CidrBlock?: string;
  destinationPrefixListId?: string;
  /** Target identifier — only one of the *Id / *Arn fields will be populated */
  gatewayId?: string;
  natGatewayId?: string;
  transitGatewayId?: string;
  vpcPeeringConnectionId?: string;
  networkInterfaceId?: string;
  egressOnlyInternetGatewayId?: string;
  carrierGatewayId?: string;
  localGatewayId?: string;
  coreNetworkArn?: string;
  instanceId?: string;
  /** AWS-reported origin: CreateRouteTable, CreateRoute, EnableVgwRoutePropagation */
  origin?: string;
  state?: 'active' | 'blackhole';
}

export interface VpcRouteTable {
  routeTableId: string;
  vpcId: string;
  /** True when this is the VPC's main route table (default for unassociated subnets) */
  isMain: boolean;
  /** Subnet IDs explicitly associated with this route table */
  associatedSubnetIds: string[];
  tags: Record<string, string>;
  routes: VpcRoute[];
}

export interface TgwRouteTable {
  transitGatewayRouteTableId: string;
  transitGatewayId: string;
  state: string;
  defaultAssociationRouteTable: boolean;
  defaultPropagationRouteTable: boolean;
  tags: Record<string, string>;
}

export interface TgwRoute {
  destinationCidrBlock: string;
  transitGatewayAttachments: {
    transitGatewayAttachmentId: string;
    resourceType: string;
    resourceId: string;
  }[];
  type: 'static' | 'propagated';
  state: 'active' | 'blackhole';
}

// One attachment propagating routes into a TGW route table.
export interface TgwRouteTablePropagation {
  transitGatewayAttachmentId: string;
  resourceId: string;
  /** e.g. 'vpc', 'vpn', 'direct-connect-gateway', 'peering'. */
  resourceType: string;
  /** 'enabled' | 'enabling' | 'disabled' | 'disabling'. */
  state: string;
}

export interface TgwRouteTableWithRoutes {
  routeTable: TgwRouteTable;
  routes: TgwRoute[];
  /**
   * Attachments propagating into this table. `undefined` means "not fetched or
   * permission denied" — distinct from `[]`, which means AWS confirmed nothing
   * propagates here. Rules must not treat unknown as absent.
   */
  propagations?: TgwRouteTablePropagation[];
}

export interface DxMaintenanceEvent {
  arn: string;
  eventTypeCode: string;
  region: string;
  startTime?: string;
  endTime?: string;
  lastUpdatedTime?: string;
  statusCode: string;
  affectedResourceIds: string[];
  description: string;
  accountId?: string;
  /**
   * Health event category: 'scheduledChange' (planned maintenance) or 'issue'
   * (an actual AWS-side DX problem). Absent in snapshots written before issue
   * events were fetched — treat missing as 'scheduledChange', which is all the
   * app used to request.
   */
  eventTypeCategory?: 'scheduledChange' | 'issue';
  /**
   * Health event scope, verbatim from DescribeEvents.
   *
   *  - `PUBLIC` — a region-wide AWS announcement, broadcast to every account
   *    regardless of whether that account owns anything in the region. AWS does
   *    not map these to individual resources, so DescribeAffectedEntities answers
   *    with the sentinel `"UNKNOWN"` rather than a connection or VIF.
   *  - `ACCOUNT_SPECIFIC` — AWS asserts *this* account was affected. Scheduled
   *    maintenance names the exact `dxcon-*`/`dxvif-*`; an account-level issue
   *    answers with the sentinel `"AWS_ACCOUNT"` and names nothing.
   *
   * Absent in snapshots written before the field was captured. Treat missing as
   * unknown — never as `PUBLIC`, or the off-footprint filter would hide events
   * from older snapshots it cannot actually classify.
   */
  eventScopeCode?: 'PUBLIC' | 'ACCOUNT_SPECIFIC' | 'NONE';
}

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
  /** Optional list of spoke account IDs to enrich cross-account VPCs with name/CIDR */
  spokeAccounts?: string[];
  /** IAM role name to assume in spoke accounts (default: NetworkReadOnlyRole) */
  crossAccountRoleName?: string;
  /** Authentication method used to obtain these credentials */
  authMethod?: 'accessKey' | 'sso';
  /** SSO session metadata (display + expiry tracking only — access token is NOT persisted) */
  ssoMeta?: {
    expiration: number;
    ssoRegion: string;
    accountId: string;
    roleName: string;
  };
}
