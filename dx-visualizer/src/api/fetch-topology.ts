import type { AwsCredentials, DxConnection } from '../types/aws-resources';
import type { TopologyData } from '../types/topology';
import { GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { createDxClient, createEc2Client, createNetworkManagerClient, createSsmClient, createStsClient } from './aws-client';
import { fetchRegionNames } from './regions';
import { fetchCoreNetworks, fetchCloudWanAttachments, fetchCloudWanPeerings, fetchCloudWanRoutes } from './cloud-wan';
import {
  fetchConnections,
  fetchVirtualInterfaces,
  fetchDxGateways,
  fetchDxGatewayAssociations,
  fetchDxGatewayAttachmentRegions,
  fetchLocations,
  fetchLags,
} from './direct-connect';
import { fetchVpcs, fetchVpnGateways, fetchTransitGateways, fetchTransitGatewayAttachments, fetchTransitGatewayPeeringAttachments, fetchVpcPeeringConnections, fetchVpnConnections, fetchCustomerGateways, fetchTgwRouteTablesWithRoutes, fetchVpcRouteTables, fetchEnabledRegions } from './ec2';
import { assumeRoleInAccount } from './organizations';
import { fetchBgpPrefixMetrics } from './cloudwatch-dx';
import { fetchDxMaintenanceEvents } from './health-dx';

function logged<T>(name: string, promise: Promise<T[]>, errors: string[]): Promise<T[]> {
  return promise
    .then((res) => { console.log(`[AWS] ${name}: ${res.length} items`); return res; })
    .catch((err) => {
      const msg = err.message || String(err);
      console.error(`[AWS] ${name} FAILED:`, msg);
      errors.push(`${name}: ${msg}`);
      return [] as T[];
    });
}

export async function fetchAllTopologyData(creds: AwsCredentials): Promise<TopologyData> {
  const fetchErrors: string[] = [];

  // --- Phase 1: Fetch global services (DX Gateways, Cloud WAN, Locations) ---
  // These APIs are global and work from any region.
  const dxClient = createDxClient(creds);
  const nmClient = createNetworkManagerClient(creds);
  const ssmClient = createSsmClient(creds);

  // Resolve the caller's own account ID up front. This is the authoritative
  // source (works for both access-key and SSO auth, and regardless of whether
  // the account has any Transit Gateways) — don't rely on inferring it from
  // resource ownership fields, which are empty in TGW-less topologies.
  const callerAccountId = createStsClient(creds)
    .send(new GetCallerIdentityCommand({}))
    .then((identity) => identity.Account ?? '')
    .catch((err) => {
      console.warn('[AWS] GetCallerIdentity FAILED:', err instanceof Error ? err.message : err);
      return '';
    });

  const [dxGateways, cloudWanCoreNetworks, cloudWanAttachments, cloudWanPeerings] =
    await Promise.all([
      logged('DxGateways', fetchDxGateways(dxClient), fetchErrors),
      logged('CloudWanCoreNetworks', fetchCoreNetworks(nmClient), fetchErrors),
      logged('CloudWanAttachments', fetchCloudWanAttachments(nmClient), fetchErrors),
      logged('CloudWanPeerings', fetchCloudWanPeerings(nmClient), fetchErrors),
    ]);

  // --- Phase 2: Fetch DX GW associations, Cloud WAN routes, AND default region in parallel ---
  // Start the default region fetch immediately — don't wait for region discovery.
  const fetchRegion = async (region: string) => {
    const regionCreds = { ...creds, region };
    const regionDx = createDxClient(regionCreds);
    const regionEc2 = createEc2Client(regionCreds);
    const [rConns, rVifs, rLags, rLocs, rVpcs, rVpnGw, rTgws, rTgwAtt, rTgwPeering, rVpcPeerings, rVpnConns, rCgws, rVpcRouteTables] = await Promise.all([
      logged(`${region}/Connections`, fetchConnections(regionDx), fetchErrors),
      logged(`${region}/VirtualInterfaces`, fetchVirtualInterfaces(regionDx), fetchErrors),
      logged(`${region}/Lags`, fetchLags(regionDx), fetchErrors),
      logged(`${region}/Locations`, fetchLocations(regionDx), fetchErrors),
      logged(`${region}/VPCs`, fetchVpcs(regionEc2, region), fetchErrors),
      logged(`${region}/VpnGateways`, fetchVpnGateways(regionEc2), fetchErrors),
      logged(`${region}/TransitGateways`, fetchTransitGateways(regionEc2), fetchErrors),
      logged(`${region}/TGWAttachments`, fetchTransitGatewayAttachments(regionEc2), fetchErrors),
      logged(`${region}/TGWPeeringAttachments`, fetchTransitGatewayPeeringAttachments(regionEc2), fetchErrors),
      logged(`${region}/VpcPeerings`, fetchVpcPeeringConnections(regionEc2, region), fetchErrors),
      logged(`${region}/VpnConnections`, fetchVpnConnections(regionEc2), fetchErrors),
      logged(`${region}/CustomerGateways`, fetchCustomerGateways(regionEc2), fetchErrors),
      logged(`${region}/VpcRouteTables`, fetchVpcRouteTables(regionEc2), fetchErrors),
    ]);
    // Fetch TGW route tables in parallel for each TGW in this region
    const rTgwRouteTables = new Map<string, import('../types/aws-resources').TgwRouteTableWithRoutes[]>();
    await Promise.all(
      rTgws.map(async (tgw) => {
        const routes = await logged(`${region}/TGWRoutes(${tgw.transitGatewayId.slice(-8)})`, fetchTgwRouteTablesWithRoutes(regionEc2, tgw.transitGatewayId), fetchErrors);
        if (routes.length > 0) rTgwRouteTables.set(tgw.transitGatewayId, routes);
      })
    );
    return { region, rConns, rVifs, rLags, rLocs, rVpcs, rVpnGw, rTgws, rTgwAtt, rTgwPeering, rVpcPeerings, rVpnConns, rCgws, rTgwRouteTables, rVpcRouteTables };
  };

  // Run DX GW associations, Cloud WAN routes, AND default region fetch all in parallel
  const [dxGatewayAssociations, cloudWanRoutes, defaultRegionResult, enabledRegions] = await Promise.all([
    // DX Gateway associations (fan out per gateway, already parallel)
    Promise.all(
      dxGateways.map((g) =>
        logged(`DxGwAssoc(${g.directConnectGatewayId})`, fetchDxGatewayAssociations(dxClient, g.directConnectGatewayId), fetchErrors)
      )
    ).then((results) => results.flat()),
    // Cloud WAN routes
    cloudWanCoreNetworks.length > 0
      ? fetchCloudWanRoutes(nmClient, cloudWanCoreNetworks)
          .then((r) => { console.log(`[AWS] CloudWanRoutes: fetched for ${r.size} core networks`); return r; })
          .catch((err) => { console.warn('[AWS] CloudWanRoutes FAILED:', err); return new Map() as TopologyData['cloudWanRoutes']; })
      : Promise.resolve(new Map() as TopologyData['cloudWanRoutes']),
    // Default region starts immediately — no waiting for region discovery
    fetchRegion(creds.region),
    // All enabled regions — non-DX estates (VPN/TGW/VPC) have no DXGW or
    // Cloud WAN breadcrumbs to discover other regions from, so sweep every
    // enabled region. Denied ec2:DescribeRegions degrades to [] via logged(),
    // falling back to the DX/Cloud-WAN-seeded discovery below.
    logged('EnabledRegions', fetchEnabledRegions(createEc2Client(creds)), fetchErrors),
  ]);

  // --- Phase 3: Discover additional regions and fetch them ---
  const discoveredRegions = new Set<string>();
  for (const r of enabledRegions) discoveredRegions.add(r);
  for (const assoc of dxGatewayAssociations) {
    if (assoc.associatedGateway.region) {
      discoveredRegions.add(assoc.associatedGateway.region);
    }
  }
  for (const cn of cloudWanCoreNetworks) {
    for (const edge of cn.edges) {
      if (edge.edgeLocation) discoveredRegions.add(edge.edgeLocation);
    }
  }
  for (const att of cloudWanAttachments) {
    if (att.edgeLocation) discoveredRegions.add(att.edgeLocation);
  }
  // Remove default region — already fetched
  discoveredRegions.delete(creds.region);

  console.log(`[AWS] Discovered regions: ${creds.region} (pre-fetched)${discoveredRegions.size > 0 ? `, ${[...discoveredRegions].join(', ')}` : ''}`);

  // Fetch friendly names only for the regions we actually touch, in parallel
  // with the extra-region topology fetch so it doesn't add latency.
  const regionNamesPromise = fetchRegionNames(
    ssmClient,
    [creds.region, ...discoveredRegions],
  );

  // Fetch only the additional regions (default region already done)
  const extraRegionResults = discoveredRegions.size > 0
    ? await Promise.all([...discoveredRegions].map(fetchRegion))
    : [];

  // Phase 3b: Discover additional DX regions via DescribeDirectConnectGatewayAttachments.
  // This global API returns virtualInterfaceRegion for each VIF attached to a DXGW,
  // which reveals regions where connections/LAGs live that regional APIs won't expose.
  const allFetchedResults = [defaultRegionResult, ...extraRegionResults];
  const fetchedRegions = new Set([creds.region, ...discoveredRegions]);
  const attachmentRegionSets = await Promise.all(
    dxGateways.map((g) => logged(`DxGwAttachmentRegions(${g.directConnectGatewayId})`, fetchDxGatewayAttachmentRegions(dxClient, g.directConnectGatewayId), fetchErrors))
  );
  const missingRegions = new Set<string>();
  for (const regions of attachmentRegionSets) {
    for (const r of regions) {
      if (!fetchedRegions.has(r)) missingRegions.add(r);
    }
  }
  const extraRegionResults2 = missingRegions.size > 0
    ? await Promise.all([...missingRegions].map(fetchRegion))
    : [];
  if (missingRegions.size > 0) {
    console.log(`[AWS] Discovered DX regions from gateway attachments: ${[...missingRegions].join(', ')}`);
  }

  const regionNames = await regionNamesPromise;

  const regionResults = [...allFetchedResults, ...extraRegionResults2];

  // --- Phase 4: Merge all regional results (deduplicating by ID) ---
  const seenConnIds = new Set<string>();
  const seenVifIds = new Set<string>();
  const seenLagIds = new Set<string>();
  const seenVpcIds = new Set<string>();
  const seenVpnGwIds = new Set<string>();
  const seenTgwIds = new Set<string>();
  const seenTgwAttIds = new Set<string>();
  const seenTgwPeeringIds = new Set<string>();
  const seenVpcPeeringIds = new Set<string>();
  const seenVpnConnIds = new Set<string>();
  const seenCgwIds = new Set<string>();
  const seenLocationCodes = new Set<string>();
  const connections: DxConnection[] = [];
  const virtualInterfaces: TopologyData['virtualInterfaces'] = [];
  const lags: TopologyData['lags'] = [];
  const locations: TopologyData['locations'] = [];
  const vpcs: TopologyData['vpcs'] = [];
  const vpnGateways: TopologyData['vpnGateways'] = [];
  const transitGateways: TopologyData['transitGateways'] = [];
  const transitGatewayAttachments: TopologyData['transitGatewayAttachments'] = [];
  const transitGatewayPeeringAttachments: TopologyData['transitGatewayPeeringAttachments'] = [];
  const vpcPeerings: TopologyData['vpcPeerings'] = [];
  const vpnConnections: TopologyData['vpnConnections'] = [];
  const customerGateways: TopologyData['customerGateways'] = [];
  const tgwRouteTables: TopologyData['tgwRouteTables'] = new Map();
  const vpcRouteTables: TopologyData['vpcRouteTables'] = new Map();

  for (const r of regionResults) {
    for (const c of r.rConns) {
      if (!seenConnIds.has(c.connectionId)) { connections.push(c); seenConnIds.add(c.connectionId); }
    }
    for (const v of r.rVifs) {
      if (!seenVifIds.has(v.virtualInterfaceId)) { virtualInterfaces.push(v); seenVifIds.add(v.virtualInterfaceId); }
    }
    for (const l of r.rLags) {
      if (!seenLagIds.has(l.lagId)) { lags.push(l); seenLagIds.add(l.lagId); }
    }
    for (const l of r.rLocs) {
      if (!seenLocationCodes.has(l.locationCode)) { locations.push(l); seenLocationCodes.add(l.locationCode); }
    }
    for (const v of r.rVpcs) {
      if (!seenVpcIds.has(v.vpcId)) { vpcs.push(v); seenVpcIds.add(v.vpcId); }
    }
    for (const v of r.rVpnGw) {
      if (!seenVpnGwIds.has(v.vpnGatewayId)) { vpnGateways.push(v); seenVpnGwIds.add(v.vpnGatewayId); }
    }
    for (const t of r.rTgws) {
      if (!seenTgwIds.has(t.transitGatewayId)) { transitGateways.push(t); seenTgwIds.add(t.transitGatewayId); }
    }
    for (const a of r.rTgwAtt) {
      if (!seenTgwAttIds.has(a.transitGatewayAttachmentId)) { transitGatewayAttachments.push(a); seenTgwAttIds.add(a.transitGatewayAttachmentId); }
    }
    for (const p of r.rTgwPeering) {
      if (!seenTgwPeeringIds.has(p.transitGatewayAttachmentId)) { transitGatewayPeeringAttachments.push(p); seenTgwPeeringIds.add(p.transitGatewayAttachmentId); }
    }
    for (const p of r.rVpcPeerings) {
      if (!seenVpcPeeringIds.has(p.vpcPeeringConnectionId)) { vpcPeerings.push(p); seenVpcPeeringIds.add(p.vpcPeeringConnectionId); }
    }
    for (const v of r.rVpnConns) {
      if (!seenVpnConnIds.has(v.vpnConnectionId)) { vpnConnections.push(v); seenVpnConnIds.add(v.vpnConnectionId); }
    }
    for (const c of r.rCgws) {
      if (!seenCgwIds.has(c.customerGatewayId)) { customerGateways.push(c); seenCgwIds.add(c.customerGatewayId); }
    }
    for (const [tgwId, routes] of r.rTgwRouteTables) {
      if (!tgwRouteTables.has(tgwId)) tgwRouteTables.set(tgwId, routes);
    }
    for (const rt of r.rVpcRouteTables) {
      if (!rt.vpcId) continue;
      const arr = vpcRouteTables.get(rt.vpcId) ?? [];
      if (!arr.some((existing) => existing.routeTableId === rt.routeTableId)) {
        arr.push(rt);
        vpcRouteTables.set(rt.vpcId, arr);
      }
    }
    console.log(`[AWS] Region ${r.region}: ${r.rConns.length} connections, ${r.rVpcs.length} VPCs, ${r.rTgws.length} TGWs, ${r.rVpcRouteTables.length} VPC route tables`);
  }

  // Infer DX connections from hosted VIFs whose underlying connection isn't
  // in the owned-connections list. This handles two cases in one pass:
  //  (1) accounts that own zero connections (fully hosted-VIF accounts), and
  //  (2) accounts that own some connections but also hold VIFs on hosted
  //      connections owned by another account — the owned connection isn't
  //      returned by DescribeConnections for this account, so without
  //      inference the VIF hangs off a missing connection and the partner/
  //      AWS-device path never gets built in the graph.
  const existingConnIds = new Set(connections.map((c) => c.connectionId));
  const inferredConnections: DxConnection[] = [];
  const inferredMap = new Map<string, DxConnection>();
  for (const vif of virtualInterfaces) {
    if (!vif.connectionId || existingConnIds.has(vif.connectionId)) continue;
    if (inferredMap.has(vif.connectionId)) continue;
    const stub: DxConnection = {
      connectionId: vif.connectionId,
      connectionName: vif.virtualInterfaceName || `Hosted Connection (${vif.connectionId})`,
      connectionState: 'available',
      location: vif.location ?? '',
      bandwidth: '',
      region: vif.region,
      hasBfd: false,
      awsDeviceV2: vif.awsDeviceV2,
      awsLogicalDeviceId: vif.awsLogicalDeviceId,
      isInferred: true,
    };
    inferredMap.set(vif.connectionId, stub);
    inferredConnections.push(stub);
  }
  const effectiveConnections = inferredConnections.length > 0
    ? [...connections, ...inferredConnections]
    : connections;
  if (inferredConnections.length > 0) {
    console.log(`[AWS] Inferred ${inferredConnections.length} connection(s) from hosted VIFs (owned=${connections.length})`);
  }

  // Only abort login for genuine auth failures. Other errors (e.g. a single
  // service returning a malformed response) are logged but not fatal — the
  // app continues with whatever data we did fetch.
  const authPattern = /credential|Unauthorized|InvalidIdentityToken|ExpiredToken|SignatureDoesNotMatch|AccessDenied/i;
  const authError = fetchErrors.find((e) => authPattern.test(e));
  if (authError && effectiveConnections.length === 0 && dxGateways.length === 0 && vpcs.length === 0) {
    throw new Error('Invalid AWS credentials. Please check your Access Key ID and Secret Access Key.');
  }

  // --- Phase 4.5: Fetch CloudWatch BGP prefix metrics + AWS Health maintenance events in parallel (non-blocking) ---
  // VIF + connection utilization are NOT fetched here. They hit CloudWatch
  // GetMetricData (billed per metric) and add latency to every login, but the
  // signal — peak hourly utilization over weeks — is only useful when the user
  // is actively looking at capacity. The "Show utilization" control in the
  // Live overlay calls fetchUtilizationOnDemand() below.
  const [bgpPrefixMetrics, maintenanceEvents] = await Promise.all([
    fetchBgpPrefixMetrics(creds, virtualInterfaces).catch((err) => {
      console.warn('[AWS] BGP prefix metrics FAILED:', err instanceof Error ? err.message : err);
      return new Map() as NonNullable<TopologyData['bgpPrefixMetrics']>;
    }),
    fetchDxMaintenanceEvents(creds).catch((err) => {
      console.warn('[AWS] Health events FAILED:', err instanceof Error ? err.message : err);
      return [] as NonNullable<TopologyData['maintenanceEvents']>;
    }),
  ]);

  console.log('[AWS] Topology summary:', {
    regions: [...discoveredRegions].join(', '),
    connections: effectiveConnections.length,
    vifs: virtualInterfaces.length,
    dxGateways: dxGateways.length,
    associations: dxGatewayAssociations.length,
    locations: locations.length,
    vpcs: vpcs.length,
    vpnGateways: vpnGateways.length,
    vpnConnections: vpnConnections.length,
    customerGateways: customerGateways.length,
    transitGateways: transitGateways.length,
    tgwAttachments: transitGatewayAttachments.length,
    cloudWanCoreNetworks: cloudWanCoreNetworks.length,
  });

  const topology: TopologyData = {
    connections: effectiveConnections,
    virtualInterfaces,
    dxGateways,
    dxGatewayAssociations,
    locations,
    lags,
    vpcs,
    vpnGateways,
    vpnConnections,
    customerGateways,
    transitGateways,
    transitGatewayAttachments,
    transitGatewayPeeringAttachments,
    vpcPeerings,
    tgwRouteTables,
    vpcRouteTables,
    cloudWanCoreNetworks,
    cloudWanAttachments,
    cloudWanPeerings,
    cloudWanRoutes,
    bgpPrefixMetrics,
    maintenanceEvents,
    homeAccountId: (await callerAccountId) || transitGateways[0]?.ownerId || '',
    regionNames,
  };

  // --- Phase 5 (optional): Enrich from spoke accounts ---
  // Fetch VPCs, TGWs, and TGW attachments from spoke accounts so cross-account
  // resources appear in the topology with full details (name, CIDR, routes).
  if (creds.spokeAccounts?.length) {
    const roleName = creds.crossAccountRoleName || 'NetworkReadOnlyRole';
    console.log(`[AWS] Enriching from ${creds.spokeAccounts.length} spoke accounts (role: ${roleName})`);

    const existingVpcIds = new Set(topology.vpcs.map((v) => v.vpcId));
    const existingTgwIds = new Set(topology.transitGateways.map((t) => t.transitGatewayId));
    const existingTgwAttIds = new Set(topology.transitGatewayAttachments.map((a) => a.transitGatewayAttachmentId));

    const spokeResults = await Promise.allSettled(
      creds.spokeAccounts.map(async (accountId) => {
        const spokeCreds = await assumeRoleInAccount(creds, accountId, roleName);
        if (!spokeCreds) return { vpcs: [] as TopologyData['vpcs'], tgws: [] as TopologyData['transitGateways'], tgwAtts: [] as TopologyData['transitGatewayAttachments'], tgwRoutes: new Map() as TopologyData['tgwRouteTables'], vpcRts: [] as import('../types/aws-resources').VpcRouteTable[] };

        // Fetch VPCs, TGWs, and TGW attachments from all discovered regions in parallel
        // (including the home/default region, which was removed from discoveredRegions
        //  at line 113 — spoke VPCs there still need name/CIDR enrichment).
        // discoveredRegions now spans all enabled regions (DescribeRegions sweep),
        // so this fans out N spoke accounts × ~17 regions × 4+ calls — all parallel,
        // all read-only, failures degrade to [] per call.
        const regionData = await Promise.all(
          [creds.region, ...discoveredRegions].map(async (region) => {
            const spokeEc2 = createEc2Client({ ...spokeCreds, region });
            const [rVpcs, rTgws, rTgwAtt, rVpcRts] = await Promise.all([
              logged(`${accountId}/${region}/VPCs`, fetchVpcs(spokeEc2, region), fetchErrors),
              logged(`${accountId}/${region}/TGWs`, fetchTransitGateways(spokeEc2), fetchErrors),
              logged(`${accountId}/${region}/TGWAttachments`, fetchTransitGatewayAttachments(spokeEc2), fetchErrors),
              logged(`${accountId}/${region}/VpcRouteTables`, fetchVpcRouteTables(spokeEc2), fetchErrors),
            ]);
            // Fetch TGW route tables for each spoke TGW
            const rTgwRoutes = new Map<string, import('../types/aws-resources').TgwRouteTableWithRoutes[]>();
            await Promise.all(
              rTgws.map(async (tgw) => {
                const routes = await logged(`${accountId}/${region}/TGWRoutes(${tgw.transitGatewayId.slice(-8)})`, fetchTgwRouteTablesWithRoutes(spokeEc2, tgw.transitGatewayId), fetchErrors);
                if (routes.length > 0) rTgwRoutes.set(tgw.transitGatewayId, routes);
              })
            );
            return { vpcs: rVpcs, tgws: rTgws, tgwAtts: rTgwAtt, tgwRoutes: rTgwRoutes, vpcRts: rVpcRts };
          })
        );

        const allVpcs = regionData.flatMap((r) => r.vpcs).map((v) => ({ ...v, ownerAccountId: accountId }));
        const allTgws = regionData.flatMap((r) => r.tgws);
        const allTgwAtts = regionData.flatMap((r) => r.tgwAtts);
        const allVpcRts = regionData.flatMap((r) => r.vpcRts);
        const allTgwRoutes = new Map<string, import('../types/aws-resources').TgwRouteTableWithRoutes[]>();
        for (const r of regionData) {
          for (const [tgwId, routes] of r.tgwRoutes) allTgwRoutes.set(tgwId, routes);
        }
        return { vpcs: allVpcs, tgws: allTgws, tgwAtts: allTgwAtts, tgwRoutes: allTgwRoutes, vpcRts: allVpcRts };
      })
    );

    let enrichedVpcs = 0, enrichedTgws = 0, enrichedTgwAtts = 0, enrichedVpcRts = 0;
    for (const result of spokeResults) {
      if (result.status !== 'fulfilled') continue;
      const { vpcs: spokeVpcs, tgws: spokeTgws, tgwAtts: spokeTgwAtts, tgwRoutes: spokeTgwRoutes, vpcRts: spokeVpcRts } = result.value;
      for (const vpc of spokeVpcs) {
        if (!existingVpcIds.has(vpc.vpcId)) {
          topology.vpcs.push(vpc);
          existingVpcIds.add(vpc.vpcId);
          enrichedVpcs++;
        }
      }
      for (const tgw of spokeTgws) {
        if (!existingTgwIds.has(tgw.transitGatewayId)) {
          topology.transitGateways.push(tgw);
          existingTgwIds.add(tgw.transitGatewayId);
          enrichedTgws++;
        }
      }
      for (const att of spokeTgwAtts) {
        if (!existingTgwAttIds.has(att.transitGatewayAttachmentId)) {
          topology.transitGatewayAttachments.push(att);
          existingTgwAttIds.add(att.transitGatewayAttachmentId);
          enrichedTgwAtts++;
        }
      }
      for (const [tgwId, routes] of spokeTgwRoutes) {
        if (!topology.tgwRouteTables.has(tgwId)) {
          topology.tgwRouteTables.set(tgwId, routes);
        }
      }
      for (const rt of spokeVpcRts ?? []) {
        if (!rt.vpcId) continue;
        const arr = topology.vpcRouteTables.get(rt.vpcId) ?? [];
        if (!arr.some((existing) => existing.routeTableId === rt.routeTableId)) {
          arr.push(rt);
          topology.vpcRouteTables.set(rt.vpcId, arr);
          enrichedVpcRts++;
        }
      }
    }
    console.log(`[AWS] Enriched from spoke accounts: ${enrichedVpcs} VPCs, ${enrichedTgws} TGWs, ${enrichedTgwAtts} TGW attachments, ${enrichedVpcRts} VPC route tables`);
  }

  return topology;
}
