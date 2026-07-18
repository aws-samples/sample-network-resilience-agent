import type { TopologyData, DxNode, DxEdge, DxNodeData, VpcChildInfo, VpcPeerInfo, TgwChildInfo, VgwChildInfo, DxgwChildInfo, HiddenAssocChildInfo, AggregatedVifInfo } from '../types/topology';
import type { Vpc, TransitGateway, TransitGatewayAttachment, TransitGatewayPeeringAttachment, VpnGateway, DxGateway, VpnTunnel } from '../types/aws-resources';
import { LAYOUT, REGION_NAMES } from '../utils/constants';
import { COLORS } from '../utils/colors';

/** Build VPC node details, adding cross-account markers when applicable. */
function vpcDetails(vpc: Vpc, region: string, homeAccountId: string): Record<string, string> {
  const d: Record<string, string> = { cidr: vpc.cidrBlock, region, state: vpc.state };
  if (vpc.ownerAccountId && vpc.ownerAccountId !== homeAccountId) {
    d.crossAccount = 'true';
    d.ownerAccount = vpc.ownerAccountId;
  }
  return d;
}

function toVpcChildInfo(vpc: Vpc, homeAccountId: string): VpcChildInfo {
  const info: VpcChildInfo = {
    vpcId: vpc.vpcId,
    name: vpc.tags.Name || vpc.vpcId,
    cidr: vpc.cidrBlock,
    state: vpc.state,
  };
  if (vpc.ownerAccountId && vpc.ownerAccountId !== homeAccountId) {
    info.crossAccount = true;
    info.ownerAccount = vpc.ownerAccountId;
  }
  return info;
}

function crossAccountAttToVpcChildInfo(att: { resourceId: string; resourceOwnerId: string; state: string }): VpcChildInfo {
  return {
    vpcId: att.resourceId,
    name: att.resourceId,
    cidr: '—',
    state: att.state,
    crossAccount: true,
    ownerAccount: att.resourceOwnerId,
  };
}

const VPC_TABLE_ROW_HEIGHT = 24;
const VPC_TABLE_HEADER_HEIGHT = 70;
const VPC_TABLE_WIDTH = 300;

function toTgwChildInfo(tgw: TransitGateway, homeAccountId: string): TgwChildInfo {
  const info: TgwChildInfo = {
    tgwId: tgw.transitGatewayId,
    name: tgw.tags.Name || tgw.transitGatewayId,
    state: tgw.state,
  };
  if (tgw.amazonSideAsn) info.asn = String(tgw.amazonSideAsn);
  if (tgw.ownerId && homeAccountId && tgw.ownerId !== homeAccountId) {
    info.crossAccount = true;
    info.ownerAccount = tgw.ownerId;
  }
  return info;
}

function toVgwChildInfo(vgw: VpnGateway): VgwChildInfo {
  const info: VgwChildInfo = {
    vgwId: vgw.vpnGatewayId,
    name: vgw.tags.Name || vgw.vpnGatewayId,
    state: vgw.state,
  };
  if (vgw.amazonSideAsn) info.asn = String(vgw.amazonSideAsn);
  // Surface the most meaningful attachment state ("detached" when fully
  // orphaned, or the first non-attached transitional state like "detaching").
  const att = vgw.vpcAttachments[0];
  if (att) info.attachmentState = att.state;
  else info.attachmentState = 'detached';
  return info;
}

function toDxgwChildInfo(gw: DxGateway): DxgwChildInfo {
  return {
    dxgwId: gw.directConnectGatewayId,
    name: gw.directConnectGatewayName || gw.directConnectGatewayId,
    state: gw.directConnectGatewayState,
    asn: String(gw.amazonSideAsn),
  };
}

export function buildGraph(
  topology: TopologyData,
  expandedVpcGroups: Set<string>,
  expandedTgwGroups: Set<string> = new Set(),
  vpcGroupViewMode: Map<string, 'table'> = new Map(),
  _expandedIsolatedTgwGroups: Set<string> = new Set(),
  _isolatedTgwGroupViewMode: Map<string, 'table'> = new Map(),
  showNonDxVpcs: Set<string> = new Set(),
  expandedPartnerGroups: Set<string> = new Set()
): { nodes: DxNode[]; edges: DxEdge[] } {
  const nodes: DxNode[] = [];
  const edges: DxEdge[] = [];
  const nodeIds = new Set<string>(); // O(1) duplicate check
  const nodesById = new Map<string, DxNode>(); // O(1) post-build lookup for flag stamping

  /** Add a node only if its ID hasn't been seen yet. */
  function addNode(node: DxNode): boolean {
    if (nodeIds.has(node.id)) return false;
    nodeIds.add(node.id);
    nodesById.set(node.id, node);
    nodes.push(node);
    return true;
  }

  /** Build VPN connection + on-prem CGW nodes and edges for a given gateway.
   * Groups CGW on-prem nodes by IP address — same IP = same physical router.
   * The VPN connection is tagged with its AWS region so it gets wrapped by the
   * region container. The on-prem router is hosted inside an existing DX
   * Customer Data Center zone (via details.hostSiteId) when one exists — so
   * the DX CGW and VPN CGW share a single container that grows to fit both.
   * Falls back to a dedicated `custsite-vpn-*` container only for pure-VPN
   * topologies that have no DX customer sites. */
  const cgwOnPremByIp = new Map<string, string>(); // IP → onPremNodeId
  function addVpnSubgraph(
    vpn: TopologyData['vpnConnections'][number],
    gatewayNodeId: string,
    region: string,
  ) {
    const vpnNodeId = `vpn-${vpn.vpnConnectionId}`;
    if (!nodeIds.has(vpnNodeId)) {
      const cgw = topology.customerGateways.find((c) => c.customerGatewayId === vpn.customerGatewayId);
      const tunnelDetails: Record<string, string> = {
        type: vpn.type, state: vpn.state, category: vpn.category, region,
      };
      if (cgw?.bgpAsn) tunnelDetails.asn = cgw.bgpAsn;
      if (vpn.tunnels.length > 0) {
        tunnelDetails.tunnelCount = String(vpn.tunnels.length);
        tunnelDetails.tunnelsUp = String(vpn.tunnels.filter((t) => t.status === 'UP').length);
      }
      addNode(makeNode(vpnNodeId, 'cgw', vpn.tags.Name || vpn.vpnConnectionId, {
        resourceId: vpn.vpnConnectionId,
        details: tunnelDetails,
      }));

      // Group on-prem nodes by IP: same IP = same physical device
      const cgwIp = cgw?.ipAddress ?? '';
      let vpnOnPremId = cgwIp ? cgwOnPremByIp.get(cgwIp) : undefined;
      if (!vpnOnPremId) {
        vpnOnPremId = `onprem-vpn-${vpn.customerGatewayId}`;
        const cgwLabel = cgw?.tags.Name || vpn.customerGatewayId;
        const cgwDetails: Record<string, string> = {};
        if (cgw) {
          cgwDetails.ip = cgw.ipAddress;
          cgwDetails.bgpAsn = cgw.bgpAsn;
          cgwDetails.type = cgw.type;
          cgwDetails.state = cgw.state;
        }
        // Prefer hosting the VPN router in an existing DX Customer Data
        // Center zone so both CGWs share one container. Fall back to a
        // dedicated VPN site for pure-VPN topologies (no DX custsites).
        const existingDxSite = nodes.find((n) =>
          n.data.category === 'customerSite' &&
          !n.id.startsWith('custsite-vpn-') &&
          !n.id.startsWith('rec-'),
        );
        if (existingDxSite) {
          cgwDetails.hostSiteId = existingDxSite.id;
        } else {
          const vpnSiteId = `custsite-vpn-${vpn.customerGatewayId}`;
          addNode(makeNode(vpnSiteId, 'customerSite', 'Customer Data Center', {
            details: { customerGatewayId: vpn.customerGatewayId },
          }));
        }
        addNode(makeNode(vpnOnPremId, 'onPremise', cgwLabel, {
          resourceId: vpn.customerGatewayId,
          details: cgwDetails,
        }));
        if (cgwIp) cgwOnPremByIp.set(cgwIp, vpnOnPremId);
      }
      // Smoothstep routes up-over-down so the tunnel edge from the VPN router
      // doesn't cut through the DX flow zones on its way into the AWS region.
      // Target handle 'top' makes the edge drop into the VPN Connection from
      // above, keeping it clear of neighbouring nodes in the region.
      edges.push(makeEdge(vpnOnPremId, vpnNodeId, {
        edgeStyle: 'smoothstep',
        targetHandle: 'top',
      }));
    }
    // VPN Connection sits directly above its destination gateway (VGW / TGW
    // / DXGW) — route the tunnel edge bottom→top for a clean vertical drop
    // instead of right→left, which would curl around the node cluster.
    edges.push(makeEdge(vpnNodeId, gatewayNodeId, {
      label: `VPN Tunnel\n${vpn.tags.Name || vpn.vpnConnectionId}`,
      tunnels: vpn.tunnels,
      labelPosition: 0.4,
      sourceHandle: 'bottom',
      targetHandle: 'top',
    }));
    // Flag the destination gateway so its node renders the top handle —
    // gateways without a VPN attached should not show a disconnected dot.
    const gwNode = nodes.find((n) => n.id === gatewayNodeId);
    if (gwNode) gwNode.data.hasTopHandle = true;
  }

  // --- Build location-to-connections map ---
  const locationConnections = new Map<string, typeof topology.connections>();
  for (const conn of topology.connections) {
    // For inferred hosted connections, location might be empty - try to fill from VIF data
    let loc = conn.location;
    if (!loc) {
      const vif = topology.virtualInterfaces.find((v) => v.connectionId === conn.connectionId);
      if (vif?.location) loc = vif.location;
    }
    if (!loc) continue; // skip connections with no identifiable location

    const existing = locationConnections.get(loc) ?? [];
    existing.push({ ...conn, location: loc });
    locationConnections.set(loc, existing);
  }

  // For hosted VIFs, some locations may not appear in the locations list.
  // Ensure we have location entries for all used location codes.
  const usedLocationCodes = new Set(locationConnections.keys());
  const knownLocationCodes = new Set(topology.locations.map((l) => l.locationCode));

  // Build a combined locations list
  const allLocations = [...topology.locations];
  for (const code of usedLocationCodes) {
    if (!knownLocationCodes.has(code)) {
      // Create a synthetic location entry from whatever info we have
      const region = topology.connections.find((c) => c.location === code)?.region
        ?? topology.virtualInterfaces.find((v) => v.location === code)?.region
        ?? '';
      allLocations.push({
        locationCode: code,
        locationName: '',
        region,
        availablePortSpeeds: [],
      });
    }
  }

  const usedLocations = allLocations.filter((l) => locationConnections.has(l.locationCode));

  // --- VIF diagnostic: count VIFs that will NOT render and explain why ---
  const allConnIdsInLocMap = new Set<string>();
  for (const conns of locationConnections.values()) {
    for (const c of conns) allConnIdsInLocMap.add(c.connectionId);
  }
  const vifsNoConn: string[] = [];
  const vifsNoGateway: string[] = [];
  for (const vif of topology.virtualInterfaces) {
    if (!allConnIdsInLocMap.has(vif.connectionId)) {
      vifsNoConn.push(`${vif.virtualInterfaceId} (conn=${vif.connectionId}, loc=${vif.location || 'NONE'})`);
      continue;
    }
    if (!vif.directConnectGatewayId && !vif.virtualGatewayId && vif.virtualInterfaceType !== 'public') {
      vifsNoGateway.push(`${vif.virtualInterfaceId} (conn=${vif.connectionId}, type=${vif.virtualInterfaceType})`);
    }
  }
  if (vifsNoConn.length > 0 || vifsNoGateway.length > 0) {
    console.warn(`[VIF diagnostic] ${topology.virtualInterfaces.length} total VIFs, ${vifsNoConn.length} dropped (connection missing from location map), ${vifsNoGateway.length} dropped (no gateway target)`);
    if (vifsNoConn.length > 0) console.warn('[VIF diagnostic] No connection in location map:', vifsNoConn.slice(0, 10));
    if (vifsNoGateway.length > 0) console.warn('[VIF diagnostic] No gateway target:', vifsNoGateway.slice(0, 10));
  }

  // Infer on-premise sites - one per DX location
  const onPremSites = usedLocations.map((loc) => ({
    id: `onprem-${loc.locationCode}`,
    siteId: `custsite-${loc.locationCode}`,
    label: 'Customer Gateway',
    siteLabel: 'Customer Data Center',
    locationCode: loc.locationCode,
  }));

  for (const site of onPremSites) {
    // Customer site container (gray zone wrapping the CGW node)
    addNode(makeNode(site.siteId, 'customerSite', site.siteLabel, {
      details: { locationCode: site.locationCode },
    }));

    // CGW node inside the customer site
    const siteConns = locationConnections.get(site.locationCode) ?? [];
    const siteVifs = topology.virtualInterfaces.filter((v) =>
      siteConns.some((c) => c.connectionId === v.connectionId)
    );
    const details: Record<string, string> = {};
    details.connections = String(siteConns.length);
    const customerAsns = new Set<number>();
    const customerAddresses: string[] = [];
    for (const vif of siteVifs) {
      if (vif.asn) customerAsns.add(vif.asn);
      for (const peer of vif.bgpPeers) {
        if (peer.customerAddress) customerAddresses.push(peer.customerAddress);
      }
    }
    if (customerAsns.size > 0) details.customerAsn = [...customerAsns].join(', ');
    if (customerAddresses.length > 0) details.ip = customerAddresses[0];

    addNode(makeNode(site.id, 'onPremise', site.label, { details }));
  }

  // --- LAG nodes ---
  const lagById = new Map<string, typeof topology.lags[0]>();
  for (const lag of topology.lags) {
    lagById.set(lag.lagId, lag);
    const lagNodeId = `lag-${lag.lagId}`;
    addNode(makeNode(lagNodeId, 'lag', lag.lagName || lag.lagId, {
      resourceId: lag.lagId,
      details: {
        state: lag.lagState,
        bandwidth: lag.connectionsBandwidth,
        numberOfConnections: String(lag.numberOfConnections),
        minimumLinks: String(lag.minimumLinks),
        locationCode: lag.location,
      },
    }));
  }

  // --- DX Location group nodes + connections ---
  const publicVifEdges: { awsDevId: string; vif: typeof topology.virtualInterfaces[0]; bgpStatus: string | undefined; prefixes: { accepted?: number; advertised?: number } | undefined; util: { ingressBpsPeak?: number; egressBpsPeak?: number } | undefined; connBandwidth: string | undefined }[] = [];
  // Collect VIF edges per (awsDevice → gateway) pair for aggregation
  type PendingVif = { vifType: 'private' | 'transit' | 'public'; vlan: number; vifState: string; bgpStatus: string | undefined; vifId: string; prefixesAccepted: number | undefined; prefixesAdvertised: number | undefined; utilizationIngressBps: number | undefined; utilizationEgressBps: number | undefined; connectionBandwidth: string | undefined; source: string; target: string };
  const pendingVifEdges = new Map<string, PendingVif[]>();
  for (const loc of usedLocations) {
    const locNodeId = `dxloc-${loc.locationCode}`;
    const label = loc.locationName || `Direct Connect Location ${loc.locationCode}`;
    nodes.push(
      makeNode(locNodeId, 'dxLocation', label, {
        details: { code: loc.locationCode, region: loc.region },
      })
    );

    const conns = locationConnections.get(loc.locationCode) ?? [];
    for (const conn of conns) {
      const isLagMember = !!(conn.lagId && lagById.has(conn.lagId));
      const partnerId = isLagMember
        ? `partner-${conn.lagId}`
        : `partner-${conn.connectionId}`;
      // Collect VIF IDs associated with this connection for display on the AWS Device node
      const connVifs = topology.virtualInterfaces.filter(
        (v) => v.connectionId === conn.connectionId
      );
      // Device info: prefer connection-level, fall back to first VIF-level
      const logicalDeviceId = conn.awsLogicalDeviceId || connVifs[0]?.awsLogicalDeviceId || '';
      const awsDeviceV2 = conn.awsDeviceV2 || connVifs[0]?.awsDeviceV2 || '';
      // Key the AWS Device node by logical device ID when known so two connections
      // terminating on the same physical AWS router collapse into one node — otherwise
      // the diagram shows two identical-looking devices and hides the real SPOF.
      // Fall back to connection ID when the logical device isn't reported (hosted VIFs).
      const awsDevId = logicalDeviceId
        ? `awsdev-${logicalDeviceId}`
        : `awsdev-${conn.connectionId}`;
      const awsDeviceLabel = logicalDeviceId || awsDeviceV2 || 'AWS Device';

      addNode(makeNode(partnerId, 'dxPartnerDevice', conn.partnerName || 'Customer / Partner Device', {
        resourceId: isLagMember ? conn.lagId! : conn.connectionId,
        details: { locationCode: loc.locationCode, state: conn.connectionState },
        ...(conn.isInferred ? { isInferred: true } : {}),
      }));
      // Collect Amazon-side ASN from BGP peers
      const amazonAsns = new Set<number>();
      for (const vif of connVifs) {
        if (vif.asn) amazonAsns.add(vif.asn);
      }
      addNode(makeNode(awsDevId, 'awsDevice', awsDeviceLabel, {
        resourceId: conn.connectionId,
        details: {
          locationCode: loc.locationCode,
          state: conn.connectionState,
          ...(logicalDeviceId ? { logicalDeviceId } : {}),
          ...(awsDeviceV2 ? { awsDeviceV2 } : {}),
          ...(amazonAsns.size > 0 ? { asn: [...amazonAsns].join(', ') } : {}),
        },
        ...(conn.isInferred ? { isInferred: true } : {}),
      }));

      const connState = conn.connectionState || 'unknown';
      const inferredTag = conn.isInferred ? '\nhosted VIF on external cable' : '';
      const connUtil = topology.connectionUtilization?.get(conn.connectionId);

      // When a connection belongs to a LAG, route through the LAG node:
      // partner → LAG and LAG → awsDevice (instead of direct partner → awsDevice).
      //
      // Customer-gateway → LAG side: draw ONE edge + ONE label per member
      // connection (rather than a single edge listing them all) so each physical
      // link in the bundle is individually visible. The parallel edges are fanned
      // apart with distinct source/target handles and their labels are staggered
      // along the path so they don't stack. The LAG → awsDevice side stays a
      // single "LAG Bundle" edge — the bundle is one logical link on that side.
      const lagNodeId = conn.lagId ? `lag-${conn.lagId}` : null;
      if (isLagMember && lagNodeId) {
        // Partner → LAG member edges (only built once per LAG)
        const partnerLagEdgeId = `${partnerId}->${lagNodeId}`;
        if (!nodeIds.has(partnerLagEdgeId)) {
          nodeIds.add(partnerLagEdgeId);
          const lag = lagById.get(conn.lagId!)!;
          // Fall back to the current connection if the LAG reports no members.
          const members = lag.connections.length > 0 ? lag.connections : [conn];
          members.forEach((member, i) => {
            const memberState = member.connectionState || 'unknown';
            const memberUtil = topology.connectionUtilization?.get(member.connectionId);
            edges.push(makeEdge(partnerId, lagNodeId, {
              label: `DX Connection\n${member.connectionName}\n${member.connectionId}${member.bandwidth ? ` (${member.bandwidth})` : ''}\nState: ${memberState}${member.isInferred ? '\nhosted VIF on external cable' : ''}`,
              connectionId: member.connectionId,
              connectionState: memberState,
              // All member edges leave the partner's single right dot and enter
              // the LAG's single left dot; CustomEdge bows each one apart by its
              // parallel index so they render as distinct parallel lines with
              // vertically-separated labels instead of stacking on one path.
              parallelIndex: i,
              parallelCount: members.length,
              ...(member.isInferred ? { isInferred: true } : {}),
              ...(memberUtil?.ingressBpsPeak != null || memberUtil?.egressBpsPeak != null
                ? {
                    utilizationIngressBps: memberUtil.ingressBpsPeak,
                    utilizationEgressBps: memberUtil.egressBpsPeak,
                    connectionBandwidth: member.bandwidth,
                  }
                : {}),
            }));
          });
        }
        // LAG → AWS Device edge (only once per LAG+device pair)
        const lagAwsEdgeId = `${lagNodeId}->${awsDevId}`;
        if (!nodeIds.has(lagAwsEdgeId)) {
          nodeIds.add(lagAwsEdgeId);
          const lag = lagById.get(conn.lagId!)!;
          edges.push(makeEdge(lagNodeId, awsDevId, {
            label: `LAG Bundle\n${lag.numberOfConnections} connections`,
          }));
        }
      } else {
        edges.push(makeEdge(partnerId, awsDevId, {
          label: `DX Connection\n${conn.connectionName}\n${conn.connectionId}${conn.bandwidth ? ` (${conn.bandwidth})` : ''}\nState: ${connState}${inferredTag}`,
          connectionId: conn.connectionId,
          connectionState: connState,
          ...(conn.isInferred ? { isInferred: true } : {}),
          ...(connUtil?.ingressBpsPeak != null || connUtil?.egressBpsPeak != null
            ? {
                utilizationIngressBps: connUtil.ingressBpsPeak,
                utilizationEgressBps: connUtil.egressBpsPeak,
                connectionBandwidth: conn.bandwidth,
              }
            : {}),
        }));
      }

      const vifs = topology.virtualInterfaces.filter(
        (v) => v.connectionId === conn.connectionId
      );
      for (const vif of vifs) {
        // Derive overall BGP status from peers
        const bgpStatus = vif.bgpPeers.length > 0
          ? (vif.bgpPeers.some((p) => p.bgpStatus === 'up') ? 'up' : 'down')
          : undefined;
        const prefixes = topology.bgpPrefixMetrics?.get(vif.virtualInterfaceId);
        const util = topology.vifUtilization?.get(vif.virtualInterfaceId);

        if (vif.directConnectGatewayId) {
          const dxgwId = `dxgw-${vif.directConnectGatewayId}`;
          const vifEdgeKey = `${awsDevId}|${dxgwId}`;
          const bucket = pendingVifEdges.get(vifEdgeKey) ?? [];
          bucket.push({ vifType: vif.virtualInterfaceType, vlan: vif.vlan, vifState: vif.virtualInterfaceState, bgpStatus, vifId: vif.virtualInterfaceId, prefixesAccepted: prefixes?.accepted, prefixesAdvertised: prefixes?.advertised, utilizationIngressBps: util?.ingressBpsPeak, utilizationEgressBps: util?.egressBpsPeak, connectionBandwidth: conn.bandwidth, source: awsDevId, target: dxgwId });
          pendingVifEdges.set(vifEdgeKey, bucket);
        }
        // VIF attached directly to VGW (no DX Gateway)
        if (vif.virtualGatewayId && !vif.directConnectGatewayId) {
          const vgwId = `vgw-${vif.virtualGatewayId}`;
          const vifEdgeKey = `${awsDevId}|${vgwId}`;
          const bucket = pendingVifEdges.get(vifEdgeKey) ?? [];
          bucket.push({ vifType: vif.virtualInterfaceType, vlan: vif.vlan, vifState: vif.virtualInterfaceState, bgpStatus, vifId: vif.virtualInterfaceId, prefixesAccepted: prefixes?.accepted, prefixesAdvertised: prefixes?.advertised, utilizationIngressBps: util?.ingressBpsPeak, utilizationEgressBps: util?.egressBpsPeak, connectionBandwidth: conn.bandwidth, source: awsDevId, target: vgwId });
          pendingVifEdges.set(vifEdgeKey, bucket);
        }
        // Public VIF — no DXGW or VGW, routes to AWS public endpoints
        if (vif.virtualInterfaceType === 'public' && !vif.directConnectGatewayId && !vif.virtualGatewayId) {
          publicVifEdges.push({ awsDevId, vif, bgpStatus, prefixes, util, connBandwidth: conn.bandwidth });
        }
      }
    }
  }

  // --- Emit VIF edges: aggregate when multiple VIFs share the same awsDevice→gateway path ---
  for (const [, bucket] of pendingVifEdges) {
    if (bucket.length === 1) {
      const v = bucket[0];
      edges.push(makeEdge(v.source, v.target, {
        vifType: v.vifType,
        vlan: v.vlan,
        vifState: v.vifState,
        bgpStatus: v.bgpStatus,
        vifId: v.vifId,
        prefixesAccepted: v.prefixesAccepted,
        prefixesAdvertised: v.prefixesAdvertised,
        utilizationIngressBps: v.utilizationIngressBps,
        utilizationEgressBps: v.utilizationEgressBps,
        connectionBandwidth: v.connectionBandwidth,
      }));
    } else {
      const types = new Set(bucket.map((v) => v.vifType));
      const typeLabel = types.size === 1
        ? `${bucket[0].vifType.charAt(0).toUpperCase() + bucket[0].vifType.slice(1)}`
        : 'Mixed';
      const vlans = bucket.map((v) => v.vlan).sort((a, b) => a - b);
      const vlanRange = vlans.length <= 3
        ? vlans.join(', ')
        : `${vlans[0]}–${vlans[vlans.length - 1]}`;
      const downCount = bucket.filter((v) => v.vifState && !/available/i.test(v.vifState)).length;
      const bgpDownCount = bucket.filter((v) => v.bgpStatus && !/up/i.test(v.bgpStatus)).length;
      const totalIngress = bucket.reduce((sum, v) => sum + (v.utilizationIngressBps ?? 0), 0);
      const totalEgress = bucket.reduce((sum, v) => sum + (v.utilizationEgressBps ?? 0), 0);
      const first = bucket[0];
      edges.push(makeEdge(first.source, first.target, {
        vifType: types.size === 1 ? first.vifType : 'private',
        vlan: first.vlan,
        vifState: downCount > 0 ? `${bucket.length - downCount}/${bucket.length} available` : 'available',
        bgpStatus: bgpDownCount > 0 ? `${bucket.length - bgpDownCount}/${bucket.length} up` : 'up',
        vifId: `${bucket.length}-vifs`,
        label: `${bucket.length} ${typeLabel} VIFs\nVLANs ${vlanRange}`,
        utilizationIngressBps: totalIngress || undefined,
        utilizationEgressBps: totalEgress || undefined,
        connectionBandwidth: first.connectionBandwidth,
        aggregatedVifs: bucket.map((v) => ({
          vifId: v.vifId,
          vifType: v.vifType,
          vlan: v.vlan,
          vifState: v.vifState,
          bgpStatus: v.bgpStatus,
          prefixesAccepted: v.prefixesAccepted,
          prefixesAdvertised: v.prefixesAdvertised,
          utilizationIngressBps: v.utilizationIngressBps,
          utilizationEgressBps: v.utilizationEgressBps,
          connectionBandwidth: v.connectionBandwidth,
        })),
      }));
    }
  }

  // --- Single Public Endpoints node (all public VIF edges converge here) ---
  if (publicVifEdges.length > 0) {
    const pubNodeId = 'pub-endpoints';
    const allResources = topology.publicVifResources ?? [];
    const services = allResources.length
      ? allResources.map((r) => `${r.service}: ${r.resourceName || r.resourceId}`).join(' | ')
      : undefined;
    const vifCount = publicVifEdges.length;
    addNode(makeNode(pubNodeId, 'publicResources', 'AWS Public Endpoints', {
      details: {
        ...(services ? { services } : {}),
        vifCount: String(vifCount),
      },
    }));
    for (const { awsDevId, vif, bgpStatus, prefixes, util, connBandwidth } of publicVifEdges) {
      edges.push(
        makeEdge(awsDevId, pubNodeId, {
          vifType: vif.virtualInterfaceType,
          vlan: vif.vlan,
          vifState: vif.virtualInterfaceState,
          bgpStatus,
          vifId: vif.virtualInterfaceId,
          prefixesAccepted: prefixes?.accepted,
          prefixesAdvertised: prefixes?.advertised,
          utilizationIngressBps: util?.ingressBpsPeak,
          utilizationEgressBps: util?.egressBpsPeak,
          connectionBandwidth: connBandwidth,
        })
      );
    }
  }

  // --- DX Gateways ---
  // A DXGW is "unattached" when it has no VIFs AND no associations (no TGW/VGW
  // hanging off it). These collapse into the Unattached zone instead of
  // floating in the canvas with no edges.
  const unattachedDxgws: DxgwChildInfo[] = [];
  for (const gw of topology.dxGateways) {
    const gwId = `dxgw-${gw.directConnectGatewayId}`;
    const hasVif = topology.virtualInterfaces.some(
      (v) => v.directConnectGatewayId === gw.directConnectGatewayId
    );
    const hasAssoc = topology.dxGatewayAssociations.some(
      (a) => a.directConnectGatewayId === gw.directConnectGatewayId
    );
    if (!hasVif && !hasAssoc) {
      unattachedDxgws.push(toDxgwChildInfo(gw));
      continue;
    }
    nodes.push(
      makeNode(gwId, 'dxGateway', gw.directConnectGatewayName, {
        resourceId: gw.directConnectGatewayId,
        details: { asn: String(gw.amazonSideAsn), state: gw.directConnectGatewayState },
      })
    );
  }

  // --- Pre-compute Cloud WAN TGW IDs (needed before region loop to suppress direct DX-GW → TGW edges) ---
  // Only include TGWs discovered from peerings — these get Cloud WAN → TGW peering edges instead.
  const cloudWanTgwIds = new Set<string>();
  for (const cn of topology.cloudWanCoreNetworks) {
    for (const peering of topology.cloudWanPeerings) {
      if (peering.coreNetworkId !== cn.coreNetworkId) continue;
      const arnParts = peering.resourceArn.split('/');
      const tgwId = arnParts[arnParts.length - 1];
      if (tgwId) cloudWanTgwIds.add(tgwId);
    }
  }

  // Core networks that are themselves DXGW-associated (direct DXGW → Cloud WAN
  // attachment). TGWs peered to one of these are effectively on the DX path
  // even if they have no direct DXGW association, so we should NOT treat them
  // as non-DX.
  const dxReachableCoreNetworkIds = new Set<string>();
  for (const assoc of topology.dxGatewayAssociations) {
    const cnId = assoc.associatedCoreNetwork?.id;
    if (cnId) dxReachableCoreNetworkIds.add(cnId);
  }
  for (const att of topology.cloudWanAttachments) {
    if (att.attachmentType === 'direct-connect-gateway') {
      dxReachableCoreNetworkIds.add(att.coreNetworkId);
    }
  }
  const dxReachableViaCloudWanTgwIds = new Set<string>();
  for (const peering of topology.cloudWanPeerings) {
    if (!dxReachableCoreNetworkIds.has(peering.coreNetworkId)) continue;
    const arnParts = peering.resourceArn.split('/');
    const tgwId = arnParts[arnParts.length - 1];
    if (tgwId) dxReachableViaCloudWanTgwIds.add(tgwId);
  }

  // Home (networking) account ID — set during fetch before spoke enrichment
  const homeAccountId = topology.homeAccountId || '';

  // Does this topology have ANY Direct Connect presence? When it doesn't (a
  // pure TGW/VPC or Cloud-WAN-only account), there's no DX story to keep the
  // canvas focused on, so the usual "hide non-DX VPCs by default" behaviour
  // would render an almost-empty graph. In that case we treat everything as
  // on-path so the TGWs and their VPCs show without the user toggling each
  // region's "Show non-DX" control.
  const hasDxPresence =
    topology.dxGateways.length > 0
    || topology.connections.length > 0
    || topology.virtualInterfaces.length > 0;

  // --- Regions ---
  const regions = new Set<string>();
  for (const vpc of topology.vpcs) regions.add(vpc.region);
  for (const tgw of topology.transitGateways) {
    const region = tgw.transitGatewayArn.split(':')[3] || 'unknown';
    regions.add(region);
  }
  for (const vgw of topology.vpnGateways) {
    const assoc = topology.dxGatewayAssociations.find(
      (a) => a.associatedGateway.id === vgw.vpnGatewayId
    );
    if (assoc) regions.add(assoc.associatedGateway.region);
    // Also add region from VPC attachments
    for (const att of vgw.vpcAttachments) {
      const vpc = topology.vpcs.find((v) => v.vpcId === att.vpcId);
      if (vpc) regions.add(vpc.region);
    }
  }

  // Track VPCs already connected (to avoid duplicates)
  const connectedVpcIds = new Set<string>();
  // Track gateway IDs handled by TGW/VGW loops (including collapsed groups) so cross-account code doesn't duplicate them
  const handledGatewayIds = new Set<string>();
  // Count VPCs per region reachable only via non-DX TGWs/VGWs — used by the
  // Region header toggle regardless of whether they're currently shown.
  const nonDxVpcCountByRegion = new Map<string, number>();
  const bumpNonDx = (region: string, n: number) => {
    if (n > 0) nonDxVpcCountByRegion.set(region, (nonDxVpcCountByRegion.get(region) ?? 0) + n);
  };

  // A TGW is "isolated" when it has zero attachments of any kind — no VPC
  // attachments, no VPN connections, no peering (TGW-to-TGW or Cloud WAN),
  // no DX Gateway association, and no TGW Connect attachments. These get
  // collapsed into a stacked-card group per region, mirroring orphan VPCs.
  const cloudWanPeeringTgwIds = cloudWanTgwIds; // already computed above
  const peeringTgwIds = new Set<string>();
  for (const p of topology.transitGatewayPeeringAttachments) {
    peeringTgwIds.add(p.requesterTgwInfo.transitGatewayId);
    peeringTgwIds.add(p.accepterTgwInfo.transitGatewayId);
  }
  // TGW/VGW linkage indexes — built once so anchor and non-DX checks inside
  // the region loop are O(1) instead of rescanning the source arrays per TGW.
  const vpnTgwIds = new Set<string>();
  const vpnVgwIds = new Set<string>();
  for (const v of topology.vpnConnections) {
    if (v.transitGatewayId) vpnTgwIds.add(v.transitGatewayId);
    if (v.vpnGatewayId) vpnVgwIds.add(v.vpnGatewayId);
  }
  const connectAttachmentTgwIds = new Set<string>();
  const vpcAttachmentsByTgwId = new Map<string, TransitGatewayAttachment[]>();
  for (const a of topology.transitGatewayAttachments) {
    if (a.resourceType === 'connect') connectAttachmentTgwIds.add(a.transitGatewayId);
    if (a.resourceType === 'vpc') {
      const arr = vpcAttachmentsByTgwId.get(a.transitGatewayId) ?? [];
      arr.push(a);
      vpcAttachmentsByTgwId.set(a.transitGatewayId, arr);
    }
  }
  const vifVgwIds = new Set<string>();
  for (const vif of topology.virtualInterfaces) {
    if (vif.virtualGatewayId) vifVgwIds.add(vif.virtualGatewayId);
  }
  function isTgwIsolated(tgw: TransitGateway): boolean {
    const tgwId = tgw.transitGatewayId;
    const hasDxgwAssoc = topology.dxGatewayAssociations.some(
      (a) => a.associatedGateway.id === tgwId && a.associatedGateway.type === 'transitGateway'
    );
    if (hasDxgwAssoc) return false;
    const hasAttachments = topology.transitGatewayAttachments.some(
      (a) => a.transitGatewayId === tgwId && (a.resourceType === 'vpc' || a.resourceType === 'connect')
    );
    if (hasAttachments) return false;
    const hasVpn = topology.vpnConnections.some((v) => v.transitGatewayId === tgwId);
    if (hasVpn) return false;
    if (peeringTgwIds.has(tgwId)) return false;
    if (cloudWanPeeringTgwIds.has(tgwId)) return false;
    return true;
  }

  // A VGW is "isolated" when nothing in the topology wires it up: no DXGW
  // association, no VPC attachment in "attached" state, no VPN connection, and
  // no VIF pointing directly at it. Such VGWs (e.g. "vgw-dx-training" that was
  // pre-provisioned but never attached) belong in the Unattached zone so they
  // don't float on the canvas without edges.
  function isVgwIsolated(vgw: VpnGateway): boolean {
    const vgwId = vgw.vpnGatewayId;
    const hasDxgwAssoc = topology.dxGatewayAssociations.some(
      (a) => a.associatedGateway.id === vgwId
    );
    if (hasDxgwAssoc) return false;
    const hasAttachedVpc = vgw.vpcAttachments.some((a) => a.state === 'attached');
    if (hasAttachedVpc) return false;
    const hasVpn = topology.vpnConnections.some((v) => v.vpnGatewayId === vgwId);
    if (hasVpn) return false;
    const hasVif = topology.virtualInterfaces.some((v) => v.virtualGatewayId === vgwId);
    if (hasVif) return false;
    return true;
  }

  // TGW→VPC attachments whose edge was suppressed because the VPC sits off the
  // DX path (region "Show non DXGW association nodes" toggle is off). We hide
  // these edges to keep the canvas focused on the DX story — but a suppressed
  // VPC can still land on the canvas for an unrelated reason (e.g. it's the
  // endpoint of a rendered VPC peering). When that happens, a visible VPC with
  // no line to its visible TGW reads as "attachment missing", which is wrong.
  // We record the suppressed pairs here and, in a post-pass after all node
  // synthesis, draw the attachment edge for any pair whose BOTH endpoints ended
  // up on the canvas.
  const suppressedTgwVpcEdges: { tgwId: string; vpcId: string; region: string }[] = [];
  // Collect isolated TGWs per region — rendered after the region loop so their
  // group node doesn't confuse the per-DXGW rendering paths.
  const isolatedTgwsByRegion = new Map<string, TransitGateway[]>();
  // Region code → region node, populated as region nodes are created so the
  // final non-DX count stamping is O(1) per region.
  const regionNodesByCode = new Map<string, DxNode>();

  for (const region of regions) {
    const regionId = `region-${region}`;
    const friendlyName = getRegionName(region, topology.regionNames);
    const regionNode = makeNode(regionId, 'region', friendlyName, { details: { regionCode: region } });
    if (addNode(regionNode)) regionNodesByCode.set(region, regionNode);
    const showNonDx = showNonDxVpcs.has(region);

    // --- Transit Gateways (grouped per DX Gateway) ---
    const regionTgws = topology.transitGateways.filter((t) => (t.transitGatewayArn.split(':')[3] || '') === region);
    for (const tgw of regionTgws) handledGatewayIds.add(tgw.transitGatewayId);

    // Split off TGWs with zero attachments — they collapse into a per-region
    // "N Isolated TGWs" group rendered after this loop (parallels orphan VPCs).
    const isolatedTgws: typeof regionTgws = [];
    const connectedRegionTgws: typeof regionTgws = [];
    for (const tgw of regionTgws) {
      if (isTgwIsolated(tgw)) isolatedTgws.push(tgw);
      else connectedRegionTgws.push(tgw);
    }
    if (isolatedTgws.length > 0) {
      isolatedTgwsByRegion.set(region, isolatedTgws);
    }

    // Group TGWs by their DX Gateway association so each DXGW can collapse independently
    const tgwsByDxgw = new Map<string, typeof regionTgws>();
    const ungroupedTgws: typeof regionTgws = [];
    for (const tgw of connectedRegionTgws) {
      const assoc = topology.dxGatewayAssociations.find(
        (a) => a.associatedGateway.id === tgw.transitGatewayId && a.associatedGateway.type === 'transitGateway'
      );
      if (assoc) {
        const key = assoc.directConnectGatewayId;
        if (!tgwsByDxgw.has(key)) tgwsByDxgw.set(key, []);
        tgwsByDxgw.get(key)!.push(tgw);
      } else {
        ungroupedTgws.push(tgw);
      }
    }

    // Non-DX TGWs whose only attachments are VPCs have nothing else to anchor
    // once their VPCs are hidden — render them only when the user has opted
    // into showing non-DX VPCs in this region. TGWs with peering / VPN /
    // Cloud WAN / Connect edges stay on the canvas either way.
    const hasNonVpcAnchor = (tgwId: string): boolean =>
      peeringTgwIds.has(tgwId)
      || cloudWanPeeringTgwIds.has(tgwId)
      || vpnTgwIds.has(tgwId)
      || connectAttachmentTgwIds.has(tgwId);
    const ungroupedTgwsToRender: typeof regionTgws = [];
    for (const tgw of ungroupedTgws) {
      if (!hasDxPresence || showNonDx || hasNonVpcAnchor(tgw.transitGatewayId)) {
        ungroupedTgwsToRender.push(tgw);
        continue;
      }
      const vpcAtts = vpcAttachmentsByTgwId.get(tgw.transitGatewayId) ?? [];
      bumpNonDx(region, vpcAtts.length);
      for (const a of vpcAtts) connectedVpcIds.add(a.resourceId);
      handledGatewayIds.add(tgw.transitGatewayId);
    }

    // A TGW MUST render as an individual node (not inside a collapsed tgwGroup)
    // whenever it has non-VPC attachments — VPN Connections, TGW peering,
    // Cloud WAN peering, or TGW Connect. The collapsed tgwGroup card only
    // emits edges to its aggregated VPC fan-out; any other subgraph anchored
    // on the TGW (tunnel edge, peering edge, Connect node) would silently
    // disappear. Only pure-VPC TGWs belong in the collapsed card.
    const tgwMustBeStandalone = (tgwId: string): boolean =>
      vpnTgwIds.has(tgwId)
      || peeringTgwIds.has(tgwId)
      || cloudWanPeeringTgwIds.has(tgwId)
      || connectAttachmentTgwIds.has(tgwId);

    // Helper: render a set of TGWs as a collapsed group or individual nodes.
    // `groupKeyOverride` lets callers render a single standalone TGW under a
    // TGW-scoped key so its `vpcgroup-{groupKey}` id doesn't collide with
    // another subset sharing the same dxgwId.
    const renderTgwGroup = (tgws: typeof regionTgws, dxgwId: string | null, groupKeyOverride?: string) => {
      const groupKey = groupKeyOverride
        ?? (dxgwId ? `tgwgroup-${region}-${dxgwId}` : `tgwgroup-${region}`);
      const canCollapse = tgws.length >= LAYOUT.tgwCollapseThreshold;
      const isExpanded = expandedTgwGroups.has(groupKey);
      // VPCs reachable only through TGWs with no DXGW association aren't on the
      // DX path — hide them by default so the canvas loads focused on the DX
      // story. A TGW that's Cloud-WAN-peered to a DXGW-associated core network
      // counts as on-path via that indirect hop. The user opts in per-region
      // via the Region header toggle (showNonDxVpcs). The TGW itself still
      // renders so peering/VPN context remains visible.
      const allTgwsDxReachable = tgws.every((t) =>
        dxReachableViaCloudWanTgwIds.has(t.transitGatewayId),
      );
      // With no DX anywhere in the topology there's nothing to keep the canvas
      // focused on, so don't treat these TGWs as an off-path subtree to hide.
      const isNonDxPath = hasDxPresence && dxgwId === null && !allTgwsDxReachable;

      if (canCollapse && !isExpanded) {
        // --- Collapsed TGW group ---
        addNode(makeNode(groupKey, 'tgwGroup', `${tgws.length} TGWs`, { childCount: tgws.length, details: { region } }));

        // DX Gateway → TGW group edge
        if (dxgwId) {
          edges.push(makeEdge(`dxgw-${dxgwId}`, groupKey));
        }

        // TGW group → VPCs (aggregate all VPC attachments)
        const allVpcAttachments: typeof topology.transitGatewayAttachments = [];
        for (const tgw of tgws) {
          const vpcAttachments = topology.transitGatewayAttachments.filter(
            (a) => a.transitGatewayId === tgw.transitGatewayId && a.resourceType === 'vpc'
          );
          allVpcAttachments.push(...vpcAttachments);
        }
        const allAttachedVpcIds = new Set(allVpcAttachments.map((a) => a.resourceId));
        const groupVpcs = topology.vpcs.filter((v) => v.region === region && allAttachedVpcIds.has(v.vpcId));
        const groupCrossAccountAtts = allVpcAttachments.filter(
          (a) => a.resourceOwnerId && !topology.vpcs.some((v) => v.vpcId === a.resourceId)
        );

        const totalVpcCount = groupVpcs.length + groupCrossAccountAtts.length;

        if (isNonDxPath) bumpNonDx(region, totalVpcCount);
        // Non-DX subtree hidden: skip rendering, but mark VPCs connected so
        // they don't spill into the Unattached zone below.
        if (isNonDxPath && !showNonDx) {
          groupVpcs.forEach((v) => connectedVpcIds.add(v.vpcId));
          groupCrossAccountAtts.forEach((a) => connectedVpcIds.add(a.resourceId));
          return;
        }

        if (totalVpcCount >= LAYOUT.vpcCollapseThreshold && !expandedVpcGroups.has(groupKey)) {
          const vpcGroupId = `vpcgroup-${groupKey}`;
          if (!nodeIds.has( vpcGroupId)) {
            const vpcChildren = [
              ...groupVpcs.map((v) => toVpcChildInfo(v, homeAccountId)),
              ...groupCrossAccountAtts.map(crossAccountAttToVpcChildInfo),
            ];
            const isTable = vpcGroupViewMode.has(groupKey);
            const extra: Partial<DxNodeData> = { childCount: totalVpcCount, vpcChildren, details: { region, groupKey } };
            if (isTable) {
              extra.computedWidth = VPC_TABLE_WIDTH;
              extra.computedHeight = VPC_TABLE_HEADER_HEIGHT + vpcChildren.length * VPC_TABLE_ROW_HEIGHT;
            }
            addNode(makeNode(vpcGroupId, 'vpcGroup', `${totalVpcCount} VPCs`, extra));
          }
          edges.push(makeEdge(groupKey, vpcGroupId));
          groupVpcs.forEach((v) => connectedVpcIds.add(v.vpcId));
          groupCrossAccountAtts.forEach((a) => connectedVpcIds.add(a.resourceId));
        } else {
          for (const vpc of groupVpcs) {
            const vpcId = `vpc-${vpc.vpcId}`;
            if (!nodeIds.has( vpcId)) {
              addNode(makeNode(vpcId, 'vpc', vpc.tags.Name || vpc.vpcId, {
                resourceId: vpc.vpcId,
                details: vpcDetails(vpc, region, homeAccountId),
              }));
            }
            edges.push(makeEdge(groupKey, vpcId));
            connectedVpcIds.add(vpc.vpcId);
          }
          for (const att of groupCrossAccountAtts) {
            const vpcId = `vpc-${att.resourceId}`;
            if (!nodeIds.has( vpcId)) {
              addNode(makeNode(vpcId, 'vpc', att.resourceId, {
                resourceId: att.resourceId,
                details: {
                  region,
                  state: att.state,
                  ownerAccount: att.resourceOwnerId,
                  crossAccount: 'true',
                },
              }));
            }
            edges.push(makeEdge(groupKey, vpcId));
            connectedVpcIds.add(att.resourceId);
          }
        }
      } else {
        // --- Individual TGWs ---

        // Count total VPCs across all TGWs in this group for the collapse decision
        const allGroupVpcIds = new Set<string>();
        for (const tgw of tgws) {
          const atts = topology.transitGatewayAttachments.filter(
            (a) => a.transitGatewayId === tgw.transitGatewayId && a.resourceType === 'vpc'
          );
          for (const a of atts) allGroupVpcIds.add(a.resourceId);
        }

        if (isNonDxPath) bumpNonDx(region, allGroupVpcIds.size);
        const hideNonDxVpcs = isNonDxPath && !showNonDx;
        if (hideNonDxVpcs) {
          allGroupVpcIds.forEach((id) => connectedVpcIds.add(id));
        }

        const collapseVpcs =
          !hideNonDxVpcs &&
          allGroupVpcIds.size >= LAYOUT.vpcCollapseThreshold &&
          !expandedVpcGroups.has(groupKey);

        if (collapseVpcs) {
          const vpcGroupId = `vpcgroup-${groupKey}`;
          if (!nodeIds.has(vpcGroupId)) {
            const groupVpcs = topology.vpcs.filter((v) => v.region === region && allGroupVpcIds.has(v.vpcId));
            // Gather cross-account attachments (VPCs not in topology.vpcs) across all TGWs
            const seenCrossAccount = new Set<string>();
            const groupCrossAccountAtts: { resourceId: string; resourceOwnerId: string; state: string }[] = [];
            for (const tgw of tgws) {
              const atts = topology.transitGatewayAttachments.filter(
                (a) => a.transitGatewayId === tgw.transitGatewayId && a.resourceType === 'vpc'
                  && a.resourceOwnerId && !topology.vpcs.some((v) => v.vpcId === a.resourceId)
              );
              for (const a of atts) {
                if (seenCrossAccount.has(a.resourceId)) continue;
                seenCrossAccount.add(a.resourceId);
                groupCrossAccountAtts.push(a);
              }
            }
            const vpcChildren = [
              ...groupVpcs.map((v) => toVpcChildInfo(v, homeAccountId)),
              ...groupCrossAccountAtts.map(crossAccountAttToVpcChildInfo),
            ];
            const isTable = vpcGroupViewMode.has(groupKey);
            const extra: Partial<DxNodeData> = { childCount: allGroupVpcIds.size, vpcChildren, details: { region, groupKey } };
            if (isTable) {
              extra.computedWidth = VPC_TABLE_WIDTH;
              extra.computedHeight = VPC_TABLE_HEADER_HEIGHT + vpcChildren.length * VPC_TABLE_ROW_HEIGHT;
            }
            addNode(makeNode(vpcGroupId, 'vpcGroup', `${allGroupVpcIds.size} VPCs`, extra));
          }
          allGroupVpcIds.forEach((id) => connectedVpcIds.add(id));
        }

        for (const tgw of tgws) {
          const tgwId = `tgw-${tgw.transitGatewayId}`;
          const tgwCrossAccount = homeAccountId && tgw.ownerId && tgw.ownerId !== homeAccountId;
          addNode(makeNode(tgwId, 'tgw', tgw.tags.Name || tgw.transitGatewayId, {
            resourceId: tgw.transitGatewayId,
            details: {
              region, state: tgw.state,
              ...(tgw.amazonSideAsn ? { asn: String(tgw.amazonSideAsn) } : {}),
              ...(tgwCrossAccount ? { crossAccount: 'true', ownerAccount: tgw.ownerId } : {}),
            },
          }));

          // DX Gateway → TGW edges (skip if Cloud WAN handles this path)
          for (const assoc of topology.dxGatewayAssociations) {
            if (assoc.associatedGateway.id === tgw.transitGatewayId && assoc.associatedGateway.type === 'transitGateway') {
              if (cloudWanTgwIds.has(tgw.transitGatewayId)) continue; // routed via Core Network instead
              const prefixes = assoc.allowedPrefixes;
              const labelParts: string[] = [];
              if (prefixes.length > 0) labelParts.push(`Allowed Prefixes\n${prefixes.join('\n')}`);
              if (assoc.associationState) labelParts.push(`State: ${assoc.associationState}`);
              edges.push(makeEdge(`dxgw-${assoc.directConnectGatewayId}`, tgwId, {
                label: labelParts.length > 0 ? labelParts.join('\n') : undefined,
                connectionState: assoc.associationState,
                labelPosition: 0.35,
              }));
            }
          }

          // TGW → VPC edges
          const vpcAttachments = topology.transitGatewayAttachments.filter(
            (a) => a.transitGatewayId === tgw.transitGatewayId && a.resourceType === 'vpc'
          );
          const attachedVpcIds = vpcAttachments.map((a) => a.resourceId);
          const tgwVpcs = topology.vpcs.filter(
            (v) => v.region === region && attachedVpcIds.includes(v.vpcId)
          );
          const crossAccountVpcAtts = vpcAttachments.filter(
            (a) => a.resourceOwnerId && !topology.vpcs.some((v) => v.vpcId === a.resourceId)
          );

          if (collapseVpcs) {
            const vpcGroupId = `vpcgroup-${groupKey}`;
            edges.push(makeEdge(tgwId, vpcGroupId));
          } else if (!hideNonDxVpcs) {
            for (const vpc of tgwVpcs) {
              const vpcId = `vpc-${vpc.vpcId}`;
              if (!nodeIds.has( vpcId)) {
                addNode(makeNode(vpcId, 'vpc', vpc.tags.Name || vpc.vpcId, {
                  resourceId: vpc.vpcId,
                  details: vpcDetails(vpc, region, homeAccountId),
                }));
              }
              edges.push(makeEdge(tgwId, vpcId));
              connectedVpcIds.add(vpc.vpcId);
            }
          } else {
            // Non-DX VPCs hidden by the region toggle: record the suppressed
            // pair so the post-pass can restore the edge if the VPC lands on
            // the canvas anyway (e.g. as a VPC-peering endpoint).
            for (const vpc of tgwVpcs) suppressedTgwVpcEdges.push({ tgwId, vpcId: `vpc-${vpc.vpcId}`, region });
          }

          // Cross-account VPCs from TGW attachments (not in topology.vpcs).
          // When hidden (collapsed group or non-DX subtree), mark connected so
          // they don't spill into the Unattached zone.
          if (collapseVpcs || hideNonDxVpcs) {
            for (const att of crossAccountVpcAtts) {
              connectedVpcIds.add(att.resourceId);
              if (hideNonDxVpcs) suppressedTgwVpcEdges.push({ tgwId, vpcId: `vpc-${att.resourceId}`, region });
            }
          } else for (const att of crossAccountVpcAtts) {
            const vpcId = `vpc-${att.resourceId}`;
            if (!nodeIds.has( vpcId)) {
              addNode(makeNode(vpcId, 'vpc', att.resourceId, {
                resourceId: att.resourceId,
                details: {
                  region,
                  state: att.state,
                  ownerAccount: att.resourceOwnerId,
                  crossAccount: 'true',
                },
              }));
            }
            edges.push(makeEdge(tgwId, vpcId));
            connectedVpcIds.add(att.resourceId);
          }

          // TGW ← VPN connection edges
          for (const vpn of topology.vpnConnections) {
            if (vpn.transitGatewayId === tgw.transitGatewayId) {
              addVpnSubgraph(vpn, tgwId, region);
            }
          }

          // TGW Connect attachments — render as dedicated nodes so they don't
          // collapse into a phantom VPC node or stack on top of other TGWs.
          const connectAtts = topology.transitGatewayAttachments.filter(
            (a) => a.transitGatewayId === tgw.transitGatewayId && a.resourceType === 'connect'
          );
          for (const att of connectAtts) {
            const connectNodeId = `tgwconnect-${att.transitGatewayAttachmentId}`;
            if (!nodeIds.has(connectNodeId)) {
              addNode(makeNode(connectNodeId, 'tgwConnect', att.name || att.transitGatewayAttachmentId, {
                resourceId: att.transitGatewayAttachmentId,
                details: { region, state: att.state },
              }));
            }
            edges.push(makeEdge(tgwId, connectNodeId));
          }
        }
      }
    };

    // Render each DX Gateway's TGW group independently.
    // Split each bucket into standalone TGWs (those with VPN / peering /
    // Cloud WAN / Connect anchors — must render individually so those
    // subgraphs have a real TGW to attach to) and the remainder, which may
    // collapse into a `tgwGroup` card when it hits the threshold.
    for (const [dxgwId, tgws] of tgwsByDxgw) {
      const standalone = tgws.filter((t) => tgwMustBeStandalone(t.transitGatewayId));
      const collapsible = tgws.filter((t) => !tgwMustBeStandalone(t.transitGatewayId));
      for (const t of standalone) {
        renderTgwGroup([t], dxgwId, `tgwgroup-${region}-${dxgwId}-${t.transitGatewayId}`);
      }
      if (collapsible.length > 0) renderTgwGroup(collapsible, dxgwId);
    }
    // Ungrouped TGWs — same split. `ungroupedTgwsToRender` excludes non-DX
    // TGWs whose only anchor was VPCs hidden behind the region toggle.
    if (ungroupedTgwsToRender.length > 0) {
      const standalone = ungroupedTgwsToRender.filter((t) => tgwMustBeStandalone(t.transitGatewayId));
      const collapsible = ungroupedTgwsToRender.filter((t) => !tgwMustBeStandalone(t.transitGatewayId));
      for (const t of standalone) {
        renderTgwGroup([t], null, `tgwgroup-${region}-${t.transitGatewayId}`);
      }
      if (collapsible.length > 0) renderTgwGroup(collapsible, null);
    }

    // --- VPN Gateways ---
    for (const vgw of topology.vpnGateways) {
      // Isolated VGWs surface in the Unattached zone below — don't render
      // them as standalone nodes in the region.
      if (isVgwIsolated(vgw)) continue;
      // Check if VGW belongs to this region via DX Gateway association
      const assoc = topology.dxGatewayAssociations.find(
        (a) => a.associatedGateway.id === vgw.vpnGatewayId
      );
      // Also check via VPC attachments
      const vgwRegion = assoc?.associatedGateway.region
        ?? topology.vpcs.find((v) => vgw.vpcAttachments.some((a) => a.vpcId === v.vpcId))?.region;

      if (vgwRegion !== region) continue;

      // Non-DX VGW = no DXGW association, no VPN attached, no VIF pointing at
      // it. Its VPCs are off-DX-path; hide VGW and VPCs unless the user has
      // opted in to showing non-DX in this region. In a DX-less topology
      // everything is on-path (mirrors the ungrouped-TGW escape above), so
      // the suppression only applies when there's a DX story to focus on.
      const vgwIsNonDx = !assoc && !vpnVgwIds.has(vgw.vpnGatewayId) && !vifVgwIds.has(vgw.vpnGatewayId);
      handledGatewayIds.add(vgw.vpnGatewayId);
      if (vgwIsNonDx && hasDxPresence) {
        const attachedVpcIds = vgw.vpcAttachments
          .filter((a) => a.state === 'attached')
          .map((a) => a.vpcId);
        bumpNonDx(region, attachedVpcIds.length);
        if (!showNonDx) {
          for (const id of attachedVpcIds) connectedVpcIds.add(id);
          continue;
        }
      }

      const vgwId = `vgw-${vgw.vpnGatewayId}`;
      if (!nodeIds.has( vgwId)) {
        addNode(makeNode(vgwId, 'vgw', vgw.tags.Name || vgw.vpnGatewayId, {
          resourceId: vgw.vpnGatewayId,
          details: { region, state: vgw.state, ...(vgw.amazonSideAsn ? { asn: String(vgw.amazonSideAsn) } : {}) },
        }));
      }

      // DX Gateway → VGW edge
      if (assoc) {
        const prefixes = assoc.allowedPrefixes;
        const labelParts: string[] = [];
        if (prefixes.length > 0) labelParts.push(`Allowed Prefixes\n${prefixes.join('\n')}`);
        if (assoc.associationState) labelParts.push(`State: ${assoc.associationState}`);
        edges.push(makeEdge(`dxgw-${assoc.directConnectGatewayId}`, vgwId, {
          label: labelParts.length > 0 ? labelParts.join('\n') : undefined,
          connectionState: assoc.associationState,
          labelPosition: 0.35,
        }));
      }

      // VGW → VPC edges
      for (const attachment of vgw.vpcAttachments) {
        if (attachment.state !== 'attached') continue;
        const vpc = topology.vpcs.find((v) => v.vpcId === attachment.vpcId);
        if (!vpc) continue;
        const vpcId = `vpc-${vpc.vpcId}`;
        if (!nodeIds.has( vpcId)) {
          addNode(makeNode(vpcId, 'vpc', vpc.tags.Name || vpc.vpcId, {
            resourceId: vpc.vpcId,
            details: { cidr: vpc.cidrBlock, region, state: vpc.state },
          }));
        }
        edges.push(makeEdge(vgwId, vpcId));
        connectedVpcIds.add(vpc.vpcId);
      }

      // VGW ← VPN connection edges
      for (const vpn of topology.vpnConnections) {
        if (vpn.vpnGatewayId === vgw.vpnGatewayId) {
          addVpnSubgraph(vpn, vgwId, region);
        }
      }
    }
  }

  for (const [region, count] of nonDxVpcCountByRegion) {
    const regionNode = regionNodesByCode.get(region);
    if (regionNode) regionNode.data.nonDxVpcCount = count;
  }

  // Collect stub associations whose target gateway AWS refuses to identify
  // (prefix-pool / EDGLESS DXGWs). These get surfaced in a side panel instead
  // of fake nodes on the canvas — see the Hidden Associations zone below.
  const hiddenAssocChildren: HiddenAssocChildInfo[] = [];
  const hiddenCountByDxgw = new Map<string, number>();

  // --- Cross-account: render VGWs/TGWs from association data when not found via EC2 ---
  for (const assoc of topology.dxGatewayAssociations) {
    // Direct DXGW → Cloud WAN core network associations are handled in the
    // Cloud WAN section below — skip so we don't render them as orphan VGWs.
    if (assoc.associatedCoreNetwork?.id) continue;
    if (assoc.isPrefixPoolStub) {
      const dxgw = topology.dxGateways.find((g) => g.directConnectGatewayId === assoc.directConnectGatewayId);
      hiddenAssocChildren.push({
        dxGatewayId: assoc.directConnectGatewayId,
        dxGatewayName: dxgw?.directConnectGatewayName || assoc.directConnectGatewayId,
        state: assoc.associationState,
        reason: 'prefixPool',
      });
      hiddenCountByDxgw.set(
        assoc.directConnectGatewayId,
        (hiddenCountByDxgw.get(assoc.directConnectGatewayId) ?? 0) + 1
      );
      continue;
    }
    const gw = assoc.associatedGateway;
    if (gw.id && handledGatewayIds.has(gw.id)) continue; // already rendered (or collapsed) from EC2 data

    // Infer gateway type from the ID prefix when AWS omits it (common for
    // cross-account associations where we don't own the target gateway).
    // vgw-* → VGW, tgw-* → TGW; fall back to the API-provided `type` if any.
    let resolvedType: 'transitGateway' | 'virtualPrivateGateway' | undefined = gw.type;
    if (!resolvedType && gw.id) {
      if (gw.id.startsWith('tgw-')) resolvedType = 'transitGateway';
      else if (gw.id.startsWith('vgw-')) resolvedType = 'virtualPrivateGateway';
    }
    const isTgw = resolvedType === 'transitGateway';
    const category = isTgw ? 'tgw' : 'vgw';
    // Fallback unique id: when AWS omits the gateway id we key on the
    // associationId so multiple orphan associations don't collide under the
    // same `vgw-` / `tgw-` node.
    const stableKey = gw.id || assoc.associationId || `${assoc.directConnectGatewayId}-unknown`;
    const nodeId = isTgw ? `tgw-${stableKey}` : `vgw-${stableKey}`;
    const label = gw.id || (resolvedType ? (isTgw ? 'Transit Gateway' : 'Virtual Private Gateway') : 'Unknown Gateway');

    // Ensure region exists — fall back to any known region from the same DX Gateway's other associations
    let gwRegion = gw.region;
    if (!gwRegion) {
      const siblingAssoc = topology.dxGatewayAssociations.find(
        (a) => a.directConnectGatewayId === assoc.directConnectGatewayId && a.associatedGateway.region
      );
      gwRegion = siblingAssoc?.associatedGateway.region ?? [...regions][0] ?? '';
    }
    if (gwRegion && !regions.has(gwRegion)) {
      regions.add(gwRegion);
      const regionId = `region-${gwRegion}`;
      const friendlyName = getRegionName(gwRegion, topology.regionNames);
      addNode(makeNode(regionId, 'region', friendlyName, { details: { regionCode: gwRegion } }));
    }

    const details: Record<string, string> = {};
    if (gwRegion) details.region = gwRegion;
    if (assoc.associationState) details.state = assoc.associationState;
    // Trace info so the user can cross-reference in the AWS console even when
    // the gateway id itself is missing.
    if (assoc.directConnectGatewayId) details.dxGatewayId = assoc.directConnectGatewayId;
    if (assoc.associationId) details.associationId = assoc.associationId;
    const isCrossAccount =
      !!gw.ownerAccount && !!homeAccountId && gw.ownerAccount !== homeAccountId;
    if (isCrossAccount) {
      details.crossAccount = 'true';
      details.ownerAccount = gw.ownerAccount;
    }

    addNode(makeNode(nodeId, category as DxNodeData['category'], label, {
      resourceId: gw.id,
      details,
    }));

    // DX Gateway → VGW/TGW edge
    const prefixes = assoc.allowedPrefixes;
    const labelParts: string[] = [];
    if (prefixes.length > 0) labelParts.push(`Allowed Prefixes\n${prefixes.join('\n')}`);
    if (assoc.associationState) labelParts.push(`State: ${assoc.associationState}`);
    edges.push(makeEdge(`dxgw-${assoc.directConnectGatewayId}`, nodeId, {
      label: labelParts.length > 0 ? labelParts.join('\n') : undefined,
      connectionState: assoc.associationState,
      labelPosition: 0.35,
    }));
  }

  // --- Cloud WAN Core Networks ---
  for (const cn of topology.cloudWanCoreNetworks) {
    const cnId = `cwan-${cn.coreNetworkId}`;
    const segmentNames = cn.segments.map((s) => s.name).join(', ');
    const edgeLocs = cn.edges.map((e) => e.edgeLocation).join(', ');
    addNode(makeNode(cnId, 'coreNetwork', cn.description || cn.coreNetworkId, {
      resourceId: cn.coreNetworkId,
      details: {
        state: cn.state,
        ...(segmentNames ? { segments: segmentNames } : {}),
        ...(edgeLocs ? { edgeLocations: edgeLocs } : {}),
      },
    }));

    // Create DX-GW → Core Network edges (with Allowed Prefixes) for each DX Gateway
    // that either (a) associates with TGWs peered through this core network, or
    // (b) associates directly with this core network (AWS exposes these via the
    // `associatedCoreNetwork` field on DescribeDirectConnectGatewayAssociations).
    const handledDxgws = new Set<string>();
    for (const assoc of topology.dxGatewayAssociations) {
      const directCwan = assoc.associatedCoreNetwork?.id === cn.coreNetworkId;
      const viaTgw =
        assoc.associatedGateway.type === 'transitGateway' &&
        cloudWanTgwIds.has(assoc.associatedGateway.id);
      if (!directCwan && !viaTgw) continue;
      const dxgwNodeId = `dxgw-${assoc.directConnectGatewayId}`;
      if (handledDxgws.has(dxgwNodeId)) continue;
      handledDxgws.add(dxgwNodeId);

      // Collect all unique allowed prefixes across associations for this DX-GW
      // (both direct Cloud WAN and TGW-peered paths contribute).
      const allPrefixes = new Set<string>();
      const labelParts: string[] = [];
      let associationState: string | undefined;
      for (const a of topology.dxGatewayAssociations) {
        if (`dxgw-${a.directConnectGatewayId}` !== dxgwNodeId) continue;
        const aDirect = a.associatedCoreNetwork?.id === cn.coreNetworkId;
        const aViaTgw =
          a.associatedGateway.type === 'transitGateway' &&
          cloudWanTgwIds.has(a.associatedGateway.id);
        if (!aDirect && !aViaTgw) continue;
        for (const p of a.allowedPrefixes) allPrefixes.add(p);
        if (aDirect && !associationState) associationState = a.associationState;
      }
      const prefixes = [...allPrefixes];
      if (prefixes.length > 0) labelParts.push(`Allowed Prefixes\n${prefixes.join('\n')}`);
      if (associationState) labelParts.push(`State: ${associationState}`);
      edges.push(makeEdge(dxgwNodeId, cnId, {
        label: labelParts.length > 0 ? labelParts.join('\n') : undefined,
        connectionState: associationState,
        labelPosition: 0.4,
      }));
    }

    // Cloud WAN → TGW peering edges
    const cwanEdgeTargets = new Set<string>(); // track to avoid duplicate edges
    for (const peering of topology.cloudWanPeerings) {
      if (peering.coreNetworkId !== cn.coreNetworkId) continue;
      const arnParts = peering.resourceArn.split('/');
      const tgwId = arnParts[arnParts.length - 1];
      if (!tgwId) continue;
      const tgwNodeId = `tgw-${tgwId}`;
      cwanEdgeTargets.add(tgwNodeId);
      const attachment = topology.cloudWanAttachments.find(
        (a) => a.coreNetworkId === cn.coreNetworkId && a.resourceArn === peering.resourceArn
      );
      const labelParts: string[] = [];
      if (attachment?.segmentName) labelParts.push(`Segment: ${attachment.segmentName}`);
      if (!labelParts.length) labelParts.push('Cloud WAN Peering');
      if (peering.state) labelParts.push(`State: ${peering.state}`);
      edges.push(makeEdge(cnId, tgwNodeId, {
        label: labelParts.join('\n'),
        connectionState: peering.state,
        targetHandle: 'peering-left-target',
        isPeering: true,
      }));
      const tgwNode = nodesById.get(tgwNodeId);
      if (tgwNode) tgwNode.data.hasPeeringHandle = true;
    }

    // Cloud WAN → VPC attachment edges (also create VPC nodes if they don't exist yet)
    for (const att of topology.cloudWanAttachments) {
      if (att.coreNetworkId !== cn.coreNetworkId) continue;
      if (att.attachmentType === 'vpc' && att.resourceArn) {
        const vpcId = att.resourceArn.split('/').pop() ?? '';
        const vpcNodeId = `vpc-${vpcId}`;
        if (!vpcId) continue;
        // Ensure VPC node exists (create from topology data or from attachment metadata)
        if (!nodeIds.has( vpcNodeId)) {
          const vpc = topology.vpcs.find((v) => v.vpcId === vpcId);
          if (vpc) {
            addNode(makeNode(vpcNodeId, 'vpc', vpc.tags.Name || vpc.vpcId, {
              resourceId: vpc.vpcId,
              details: vpcDetails(vpc, vpc.region, homeAccountId),
            }));
            connectedVpcIds.add(vpc.vpcId);
          } else {
            // VPC not in fetched data (e.g. cross-account) — create node from attachment info
            addNode(makeNode(vpcNodeId, 'vpc', att.tags.Name || vpcId, {
              resourceId: vpcId,
              details: { region: att.edgeLocation, state: att.state },
            }));
            connectedVpcIds.add(vpcId);
          }
        }
        if (!cwanEdgeTargets.has(vpcNodeId)) {
          cwanEdgeTargets.add(vpcNodeId);
          edges.push(makeEdge(cnId, vpcNodeId, {
            label: att.state ? `State: ${att.state}` : undefined,
            connectionState: att.state,
          }));
        }
      }
    }

    // Cloud WAN → TGW edges from transit-gateway-route-table attachments
    // (only for TGWs not already handled by peering edges above)
    for (const att of topology.cloudWanAttachments) {
      if (att.coreNetworkId !== cn.coreNetworkId) continue;
      if (att.attachmentType !== 'transit-gateway-route-table') continue;
      // Match TGW by region: find TGWs in the same region as this attachment's edge location
      for (const tgw of topology.transitGateways) {
        const tgwRegion = tgw.transitGatewayArn.split(':')[3] || '';
        if (att.edgeLocation !== tgwRegion) continue;
        const tgwNodeId = `tgw-${tgw.transitGatewayId}`;
        if (!cwanEdgeTargets.has(tgwNodeId)) {
          cwanEdgeTargets.add(tgwNodeId);
          const tgwLabelParts: string[] = [];
          if (att.segmentName) tgwLabelParts.push(`Segment: ${att.segmentName}`);
          if (!tgwLabelParts.length) tgwLabelParts.push('TGW Attachment');
          if (att.state) tgwLabelParts.push(`State: ${att.state}`);
          edges.push(makeEdge(cnId, tgwNodeId, {
            label: tgwLabelParts.join('\n'),
            connectionState: att.state,
          }));
        }
      }
    }
  }

  // --- TGW Peering edges ---
  function ensurePeerTgwNode(
    transitGatewayId: string,
    region: string,
    ownerId: string,
  ): boolean {
    // Cloud WAN↔TGW peerings surface here too, but the Cloud WAN side has no
    // TGW id (AWS returns an empty string). That side is already drawn as a
    // "Cloud WAN Peering" edge from the core network node, so bail rather than
    // synthesizing a nameless, id-less phantom TGW node for it.
    if (!transitGatewayId) return false;
    const nodeId = `tgw-${transitGatewayId}`;
    if (nodeIds.has(nodeId)) return true;
    if (!region) return false;

    if (!regions.has(region)) {
      regions.add(region);
      const regionNodeId = `region-${region}`;
      if (!nodeIds.has(regionNodeId)) {
        const friendlyName = getRegionName(region, topology.regionNames);
        addNode(makeNode(regionNodeId, 'region', friendlyName, { details: { regionCode: region } }));
      }
    }

    const isCrossAccount = !!ownerId && !!homeAccountId && ownerId !== homeAccountId;
    const details: Record<string, string> = { region, state: 'available' };
    if (isCrossAccount) {
      details.crossAccount = 'true';
      details.ownerAccount = ownerId;
    }
    addNode(makeNode(nodeId, 'tgw', transitGatewayId, {
      resourceId: transitGatewayId,
      details,
    }));
    return true;
  }

  // One logical TGW peering surfaces as two per-side attachment objects (one on
  // each TGW) with distinct attachment IDs but identical requester/accepter
  // info. Only the requester-side object carries the Name tag, and AWS returns
  // the two in arbitrary order — so collapse by unordered TGW pair, and when a
  // pair has both a named and an unnamed record prefer the named one. A naive
  // first-wins dedup would render a bare "TGW Peering" (dropping the Name) and
  // could even flap between refreshes as fetch ordering changes.
  const peeringByPair = new Map<string, TransitGatewayPeeringAttachment>();
  for (const peering of topology.transitGatewayPeeringAttachments) {
    const pairKey = [peering.requesterTgwInfo.transitGatewayId, peering.accepterTgwInfo.transitGatewayId].sort().join('|');
    const existing = peeringByPair.get(pairKey);
    if (!existing || (!existing.tags.Name && peering.tags.Name)) {
      peeringByPair.set(pairKey, peering);
    }
  }
  for (const peering of peeringByPair.values()) {
    const reqOk = ensurePeerTgwNode(
      peering.requesterTgwInfo.transitGatewayId,
      peering.requesterTgwInfo.region,
      peering.requesterTgwInfo.ownerId,
    );
    const accOk = ensurePeerTgwNode(
      peering.accepterTgwInfo.transitGatewayId,
      peering.accepterTgwInfo.region,
      peering.accepterTgwInfo.ownerId,
    );
    if (!reqOk || !accOk) continue;

    const requesterNodeId = `tgw-${peering.requesterTgwInfo.transitGatewayId}`;
    const accepterNodeId = `tgw-${peering.accepterTgwInfo.transitGatewayId}`;

    const peeringLabel = peering.tags.Name
      ? `TGW Peering\n${peering.tags.Name}`
      : 'TGW Peering';
    edges.push(makeEdge(requesterNodeId, accepterNodeId, {
      label: peeringLabel,
      sourceHandle: 'peering-left',
      targetHandle: 'peering-left-target',
      edgeStyle: 'smoothstep',
      connectionState: peering.state,
      isPeering: true,
    }));
    const requesterNode = nodesById.get(requesterNodeId);
    const accepterNode = nodesById.get(accepterNodeId);
    if (requesterNode) requesterNode.data.hasPeeringHandle = true;
    if (accepterNode) accepterNode.data.hasPeeringHandle = true;
  }

  // --- VPC Peering edges ---
  // Draws an edge for every accepted VPC peering. When the peer VPC isn't in
  // topology.vpcs (cross-account without spoke enrichment, or cross-region we
  // didn't discover) we synthesize a minimal external VPC node so the edge
  // has somewhere to land. The node is marked crossAccount so it renders with
  // the same dashed cross-account treatment as TGW-discovered peer VPCs.
  function ensurePeerVpcNode(
    vpcId: string,
    cidrBlock: string,
    ownerId: string,
    region: string,
  ): boolean {
    const nodeId = `vpc-${vpcId}`;
    if (nodeIds.has(nodeId)) return true;
    if (!region) return false; // can't place a node without a region

    // If this region isn't in our region set yet (cross-region peer to a
    // region we didn't otherwise discover), add a region container for it
    // so the synthesized VPC has a parent to nest under.
    if (!regions.has(region)) {
      regions.add(region);
      const regionNodeId = `region-${region}`;
      if (!nodeIds.has(regionNodeId)) {
        const friendlyName = getRegionName(region, topology.regionNames);
        addNode(makeNode(regionNodeId, 'region', friendlyName, { details: { regionCode: region } }));
      }
    }

    // Prefer the rich VPC record (name tag, CIDR, real state) when this peer is
    // a VPC we already know about — common for same-account cross-region peers.
    // Falls back to the peering-supplied id/cidr for cross-account peers that
    // never appear in DescribeVpcs.
    const knownVpc = topology.vpcs.find((v) => v.vpcId === vpcId);
    const isCrossAccount = !!ownerId && !!homeAccountId && ownerId !== homeAccountId;
    const details: Record<string, string> = {
      region,
      state: knownVpc?.state || 'available',
    };
    const resolvedCidr = knownVpc?.cidrBlock || cidrBlock;
    if (resolvedCidr) details.cidr = resolvedCidr;
    if (isCrossAccount) {
      details.crossAccount = 'true';
      details.ownerAccount = ownerId;
    }
    addNode(makeNode(nodeId, 'vpc', knownVpc?.tags.Name || vpcId, {
      resourceId: vpcId,
      details,
    }));
    return true;
  }

  // Resolve one side of a peering into display fields, preferring the rich VPC
  // record when we know it (same logic ensurePeerVpcNode uses to name the node)
  // and falling back to the peering-supplied id/cidr for cross-account peers.
  function describePeerSide(side: { vpcId: string; cidrBlock: string; ownerId: string; region: string }) {
    const knownVpc = topology.vpcs.find((v) => v.vpcId === side.vpcId);
    return {
      vpcId: side.vpcId,
      name: knownVpc?.tags.Name || side.vpcId,
      region: side.region,
      cidr: knownVpc?.cidrBlock || side.cidrBlock,
      crossAccount: !!side.ownerId && !!homeAccountId && side.ownerId !== homeAccountId,
      ownerAccount: side.ownerId,
    };
  }

  // Accumulate peer lists per local VPC node so both endpoints of each peering
  // can render "who am I peered with". Stamped onto node data after the loop.
  const vpcPeersByNodeId = new Map<string, VpcPeerInfo[]>();
  function addPeerEntry(localNodeId: string, entry: VpcPeerInfo) {
    let list = vpcPeersByNodeId.get(localNodeId);
    if (!list) { list = []; vpcPeersByNodeId.set(localNodeId, list); }
    list.push(entry);
  }

  for (const peering of topology.vpcPeerings) {
    const reqOk = ensurePeerVpcNode(
      peering.requesterVpc.vpcId,
      peering.requesterVpc.cidrBlock,
      peering.requesterVpc.ownerId,
      peering.requesterVpc.region,
    );
    const accOk = ensurePeerVpcNode(
      peering.accepterVpc.vpcId,
      peering.accepterVpc.cidrBlock,
      peering.accepterVpc.ownerId,
      peering.accepterVpc.region,
    );
    if (!reqOk || !accOk) continue;

    const reqNodeId = `vpc-${peering.requesterVpc.vpcId}`;
    const accNodeId = `vpc-${peering.accepterVpc.vpcId}`;
    const labelParts: string[] = ['VPC Peering'];
    if (peering.tags.Name) labelParts.push(peering.tags.Name);
    labelParts.push(peering.vpcPeeringConnectionId);
    if (peering.state) labelParts.push(`State: ${peering.state}`);

    // Same-region peering stays inside the region box (fixed lane); cross-region
    // routes outside the region but inside AWS. Both sides always carry a region.
    const peeringScope: 'intra' | 'cross' =
      peering.requesterVpc.region === peering.accepterVpc.region ? 'intra' : 'cross';

    const edgeId = `e-vpcpeer-${peering.vpcPeeringConnectionId}`;
    edges.push({
      ...makeEdge(reqNodeId, accNodeId, {
        label: labelParts.join('\n'),
        sourceHandle: 'peering-right',
        targetHandle: 'peering-right-target',
        edgeStyle: 'smoothstep',
        connectionState: peering.state,
        isPeering: true,
        peeringScope,
      }),
      id: edgeId,
    });

    const reqNode = nodesById.get(reqNodeId);
    const accNode = nodesById.get(accNodeId);
    if (reqNode) reqNode.data.hasPeeringHandle = true;
    if (accNode) accNode.data.hasPeeringHandle = true;

    // Record the relationship from each endpoint's perspective. The requester
    // sees the accepter as an outbound peer, and vice versa.
    const req = describePeerSide(peering.requesterVpc);
    const acc = describePeerSide(peering.accepterVpc);
    addPeerEntry(reqNodeId, {
      edgeId, pcxId: peering.vpcPeeringConnectionId, state: peering.state,
      peerVpcId: acc.vpcId, peerName: acc.name, peerRegion: acc.region, peerCidr: acc.cidr,
      direction: 'out', crossAccount: acc.crossAccount, peerOwnerAccount: acc.ownerAccount,
    });
    addPeerEntry(accNodeId, {
      edgeId, pcxId: peering.vpcPeeringConnectionId, state: peering.state,
      peerVpcId: req.vpcId, peerName: req.name, peerRegion: req.region, peerCidr: req.cidr,
      direction: 'in', crossAccount: req.crossAccount, peerOwnerAccount: req.ownerAccount,
    });

    // Suppress orphan/unattached treatment: a peered VPC with no other
    // attachments is intentionally peered, not orphaned.
    connectedVpcIds.add(peering.requesterVpc.vpcId);
    connectedVpcIds.add(peering.accepterVpc.vpcId);
  }

  // Stamp the accumulated peer lists onto their VPC nodes, sorted by region then
  // name for a stable, scannable order.
  for (const [nodeId, peers] of vpcPeersByNodeId) {
    const node = nodesById.get(nodeId);
    if (!node) continue;
    peers.sort((a, b) => a.peerRegion.localeCompare(b.peerRegion) || a.peerName.localeCompare(b.peerName));
    node.data.vpcPeers = peers;
  }

  // Restore suppressed TGW→VPC attachment edges when BOTH endpoints ended up on
  // the canvas anyway. A non-DX VPC hidden by the region toggle can still be
  // rendered as a VPC-peering endpoint; leaving its TGW attachment edge out
  // would make a visible, genuinely-attached VPC look unattached. Runs after all
  // node synthesis so nodeIds reflects the final node set. Deduped against edges
  // already present (source+target) to avoid React Flow key collisions.
  const existingEdgePairs = new Set(edges.map((e) => `${e.source}|${e.target}`));
  // Count badge is per-VPC-node (bumped once even for a VPC on multiple TGWs),
  // so decrement at most once per unique VPC to avoid under-reporting.
  const uncountedVpcs = new Set<string>();
  for (const { tgwId, vpcId, region } of suppressedTgwVpcEdges) {
    if (!nodeIds.has(tgwId) || !nodeIds.has(vpcId)) continue;
    if (existingEdgePairs.has(`${tgwId}|${vpcId}`) || existingEdgePairs.has(`${vpcId}|${tgwId}`)) continue;
    existingEdgePairs.add(`${tgwId}|${vpcId}`);
    edges.push(makeEdge(tgwId, vpcId));
    // This VPC is now visible AND wired to its TGW, so it's no longer part of
    // the region's hidden non-DX count. Decrement the badge (already stamped
    // above) so "Show non DXGW association nodes (N)" stays truthful.
    const countKey = `${region}|${vpcId}`;
    if (uncountedVpcs.has(countKey)) continue;
    uncountedVpcs.add(countKey);
    const regionNode = regionNodesByCode.get(region);
    if (regionNode && regionNode.data.nonDxVpcCount) {
      regionNode.data.nonDxVpcCount = Math.max(0, regionNode.data.nonDxVpcCount - 1);
    }
  }

  // --- Unattached resources: aggregate orphan VPCs + isolated TGWs across
  // all regions into two flat tables displayed inside the unattached zone.
  // We intentionally DO NOT create region containers for accounts whose
  // only presence is orphan items — those regions would render empty.
  const orphanVpcChildren: VpcChildInfo[] = [];
  for (const vpc of topology.vpcs) {
    if (connectedVpcIds.has(vpc.vpcId)) continue;
    const vpcNodeId = `vpc-${vpc.vpcId}`;
    if (nodeIds.has(vpcNodeId)) continue;
    const info = toVpcChildInfo(vpc, homeAccountId);
    info.region = vpc.region;
    orphanVpcChildren.push(info);
  }

  const isolatedTgwChildren: TgwChildInfo[] = [];
  for (const [region, isolated] of isolatedTgwsByRegion) {
    for (const tgw of isolated) {
      const info = toTgwChildInfo(tgw, homeAccountId);
      info.region = region;
      isolatedTgwChildren.push(info);
    }
  }

  // Unattached VGWs: no DXGW association, no "attached"-state VPC attachment,
  // no VPN connection, and no VIF pointing at it. Surface them in the
  // Unattached zone so users can see detached VGWs like "vgw-dx-bastion" or
  // pre-provisioned "vgw-dx-training" that exist in the account but aren't
  // wired up.
  const unattachedVgwChildren: VgwChildInfo[] = [];
  for (const vgw of topology.vpnGateways) {
    if (!isVgwIsolated(vgw)) continue;
    unattachedVgwChildren.push(toVgwChildInfo(vgw));
  }

  // --- AWS Cloud container (wraps DX Gateways + Core Networks + Regions) ---
  const hasDxGateways = topology.dxGateways.length > 0;
  const hasCoreNetworks = topology.cloudWanCoreNetworks.length > 0;
  const hasRegions = regions.size > 0;
  if (hasDxGateways || hasCoreNetworks || hasRegions) {
    addNode(makeNode('aws-cloud', 'awsCloud', 'AWS Cloud', {}));
  }

  // --- Unattached zone: a single container holding inline tables
  // (Unattached DXGWs, VGWs, VPCs, TGWs). Lives inside AWS Cloud, collapsed
  // by default so the canvas loads focused on DX-connected topology. ---
  const totalUnattached =
    orphanVpcChildren.length +
    isolatedTgwChildren.length +
    unattachedVgwChildren.length +
    unattachedDxgws.length;
  // --- Hidden associations zone: prefix-pool / EDGLESS DXGW associations
  // whose target gateway identity AWS withholds from the public API. We
  // surface them in a collapsed table instead of a misleading canvas node.
  if (hiddenAssocChildren.length > 0) {
    addNode(makeNode('hidden-assoc-zone', 'hiddenAssocZone', 'Hidden associations', {
      hiddenAssocChildren,
      childCount: hiddenAssocChildren.length,
    }));
    // Annotate the affected DXGW nodes so users know why they're not seeing
    // the expected TGWs directly on the canvas.
    for (const [dxgwId, count] of hiddenCountByDxgw) {
      const dxgwNode = nodes.find((n) => n.id === `dxgw-${dxgwId}`);
      if (!dxgwNode) continue;
      const badges = dxgwNode.data.badges ?? [];
      badges.push({
        type: 'info',
        label: `${count} hidden`,
        description: `${count} prefix-pool association${count === 1 ? '' : 's'} — target gateway details not exposed by AWS API. See "Hidden associations" zone.`,
      });
      dxgwNode.data.badges = badges;
    }
  }

  if (totalUnattached > 0) {
    addNode(makeNode('unattached-zone', 'unattachedZone', 'Unattached resources', {
      vpcChildren: orphanVpcChildren,
      tgwChildren: isolatedTgwChildren,
      vgwChildren: unattachedVgwChildren,
      dxgwChildren: unattachedDxgws,
      childCount: totalUnattached,
    }));
  }

  // --- Collapse partner devices terminating on the same AWS device ---
  // When 3+ partners (Customer / Partner Devices at the same DX location) all
  // land on a single AWS logical device, collapse them into one
  // `dxPartnerDeviceGroup` card with a single aggregated edge. Mirrors the TGW
  // and VPC collapse cards to cut visual noise for fan-in topologies (e.g. a
  // customer with many hosted VIFs across many connections, all terminating
  // on the same physical AWS router).
  const partnerBuckets = new Map<string, { locCode: string; awsDevId: string; partnerIds: string[] }>();
  for (const edge of edges) {
    if (!edge.source.startsWith('partner-') || !edge.target.startsWith('awsdev-')) continue;
    const partnerNode = nodesById.get(edge.source);
    if (!partnerNode || partnerNode.data.category !== 'dxPartnerDevice') continue;
    const locCode = (partnerNode.data.details as Record<string, string> | undefined)?.locationCode ?? '';
    if (!locCode) continue;
    const groupKey = `partnergroup-${locCode}-${edge.target}`;
    const bucket = partnerBuckets.get(groupKey)
      ?? { locCode, awsDevId: edge.target, partnerIds: [] };
    if (!bucket.partnerIds.includes(edge.source)) bucket.partnerIds.push(edge.source);
    partnerBuckets.set(groupKey, bucket);
  }

  const partnersToRemove = new Set<string>();
  const partnerGroupNodes: DxNode[] = [];
  const partnerGroupEdges: DxEdge[] = [];
  for (const [groupKey, bucket] of partnerBuckets) {
    if (bucket.partnerIds.length < LAYOUT.partnerCollapseThreshold) continue;
    if (expandedPartnerGroups.has(groupKey)) {
      // User expanded this group — surface the collapse affordance on the DX
      // Location container header (mirrors the VPC/TGW "Collapse" control).
      // dxLocation nodes are pushed via `nodes.push(...)` directly rather than
      // the addNode() helper, so they're absent from `nodesById`.
      const locNode = nodes.find((n) => n.id === `dxloc-${bucket.locCode}`);
      if (locNode) {
        const existing = (locNode.data.details as Record<string, string> | undefined) ?? {};
        const prev = existing.expandedPartnerGroupKeys ?? '';
        const next = prev ? `${prev},${groupKey}` : groupKey;
        locNode.data.details = { ...existing, expandedPartnerGroupKeys: next };
      }
      continue;
    }
    partnerGroupNodes.push(
      makeNode(groupKey, 'dxPartnerDeviceGroup', `${bucket.partnerIds.length} Customer Gateways`, {
        childCount: bucket.partnerIds.length,
        details: { locationCode: bucket.locCode },
      }),
    );
    partnerGroupEdges.push(
      makeEdge(groupKey, bucket.awsDevId, {
        label: `${bucket.partnerIds.length} × DX Connections`,
      }),
    );
    for (const pid of bucket.partnerIds) partnersToRemove.add(pid);
  }

  if (partnersToRemove.size > 0) {
    // Drop collapsed partner nodes and any edge touching them (the partner →
    // awsDevice edges we're replacing, plus any stray ghosts). User-drawn
    // onPremise → partner edges live in the Zustand store, not `edges`, so
    // they survive rebuilds — they just won't render until the user expands
    // the group (target partner node is gone).
    const filteredNodes = nodes.filter((n) => !partnersToRemove.has(n.id));
    const filteredEdges = edges.filter(
      (e) => !partnersToRemove.has(e.source) && !partnersToRemove.has(e.target),
    );
    filteredNodes.push(...partnerGroupNodes);
    filteredEdges.push(...partnerGroupEdges);
    return { nodes: filteredNodes, edges: filteredEdges };
  }

  return { nodes, edges };
}

function makeNode(
  id: string,
  category: DxNodeData['category'],
  label: string,
  extra?: Partial<DxNodeData>
): DxNode {
  return {
    id,
    type: category,
    position: { x: 0, y: 0 },
    data: { label, category, ...extra },
  };
}

function makeEdge(source: string, target: string, data?: DxEdge['data'] & { tunnels?: VpnTunnel[]; aggregatedVifs?: AggregatedVifInfo[] }): DxEdge {
  // Auto-generate header label for VIF edges. Detail rows (status, prefixes,
  // utilization) are rendered structurally by CustomEdge from the raw data
  // fields — keeping the string label short avoids width-driven wrapping.
  let label = data?.label;
  if (data?.vifType && !data?.aggregatedVifs) {
    const parts = [`${data.vifType.charAt(0).toUpperCase() + data.vifType.slice(1)} VIF${data.vlan ? ` · VLAN ${data.vlan}` : ''}`];
    if (data.vifId) parts.push(data.vifId);
    label = parts.join('\n');
  }

  // VIF ID is included in the key so two VIFs sharing source+target+VLAN
  // don't collide (e.g. two connections on the same logical AWS device where
  // VLAN is unique per-connection, not per-device). Connection ID disambiguates
  // the parallel partner → LAG member edges, which share source+target and carry
  // no VIF/VLAN of their own.
  const edgeKey = data?.vifId ?? data?.connectionId ?? (data?.vlan != null ? String(data.vlan) : '');
  return {
    id: `e-${source}-${target}-${edgeKey}`,
    source,
    target,
    ...(data?.sourceHandle ? { sourceHandle: data.sourceHandle } : {}),
    ...(data?.targetHandle ? { targetHandle: data.targetHandle } : {}),
    type: 'customEdge',
    data: data ? { ...data, label } : undefined,
    style: data?.vifType
      ? { stroke: COLORS.vifTypes[data.vifType] }
      : { stroke: COLORS.existing.edge },
  };
}

/**
 * Resolve a region code to a user-facing label like "Tokyo region".
 *
 * Source of truth is the `regionNames` map on TopologyData, populated from
 * AWS SSM public parameters (`/aws/service/global-infrastructure/regions/.../longName`).
 * Falls back to the REGION_NAMES map used by the Pricing API, then to the raw code.
 */
function getRegionName(code: string, regionNames?: Map<string, string>): string {
  const friendly = regionNames?.get(code) ?? extractCityFromPricingName(code);
  return `${friendly || code} region`;
}

function extractCityFromPricingName(code: string): string | null {
  const longName = REGION_NAMES[code];
  if (!longName) return null;
  const match = longName.match(/\(([^)]+)\)\s*$/);
  return match ? match[1].trim() : longName;
}
