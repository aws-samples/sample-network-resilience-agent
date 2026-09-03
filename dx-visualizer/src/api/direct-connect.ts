import {
  DirectConnectClient,
  DescribeConnectionsCommand,
  DescribeVirtualInterfacesCommand,
  DescribeDirectConnectGatewaysCommand,
  DescribeDirectConnectGatewayAssociationsCommand,
  DescribeDirectConnectGatewayAssociationProposalsCommand,
  DescribeDirectConnectGatewayAttachmentsCommand,
  DescribeLagsCommand,
  DescribeLocationsCommand,
  ListVirtualInterfaceRoutesCommand,
  ListVirtualInterfaceTestHistoryCommand,
} from '@aws-sdk/client-direct-connect';
import type { RouteDirection } from '@aws-sdk/client-direct-connect';
import type {
  DxConnection,
  DxVirtualInterface,
  DxGateway,
  DxGatewayAssociation,
  DxLocation,
  DxLag,
  VifRoute,
  VifRoutes,
  VifFailoverTest,
} from '../types/aws-resources';

// DescribeConnections, DescribeVirtualInterfaces and DescribeLags all paginate.
// Reading only page 1 is worse than an error here: every resiliency rule counts
// connections and VIFs per location, so a truncated list yields a confidently
// *wrong* score rather than a visible failure. Follow nextToken like
// fetchDxGateways does.
export async function fetchConnections(client: DirectConnectClient): Promise<DxConnection[]> {
  const out: DxConnection[] = [];
  let nextToken: string | undefined;
  do {
    const res = await client.send(new DescribeConnectionsCommand({ nextToken }));
    for (const c of res.connections ?? []) {
      out.push({
        connectionId: c.connectionId ?? '',
        connectionName: c.connectionName ?? '',
        connectionState: c.connectionState ?? '',
        location: c.location ?? '',
        bandwidth: c.bandwidth ?? '',
        region: c.region ?? '',
        lagId: c.lagId,
        partnerName: c.partnerName,
        vlan: c.vlan,
        hasBfd: false,
        awsDeviceV2: c.awsDeviceV2,
        awsLogicalDeviceId: c.awsLogicalDeviceId,
        rateLimiterStatus: c.rateLimiterStatus,
      });
    }
    nextToken = res.nextToken;
  } while (nextToken);
  return out;
}

export async function fetchVirtualInterfaces(client: DirectConnectClient): Promise<DxVirtualInterface[]> {
  const out: DxVirtualInterface[] = [];
  let nextToken: string | undefined;
  do {
    const res = await client.send(new DescribeVirtualInterfacesCommand({ nextToken }));
    for (const v of res.virtualInterfaces ?? []) {
      out.push({
        virtualInterfaceId: v.virtualInterfaceId ?? '',
        virtualInterfaceName: v.virtualInterfaceName ?? '',
        virtualInterfaceType: (v.virtualInterfaceType ?? 'private') as 'private' | 'public' | 'transit',
        virtualInterfaceState: v.virtualInterfaceState ?? '',
        connectionId: v.connectionId ?? '',
        directConnectGatewayId: v.directConnectGatewayId,
        virtualGatewayId: v.virtualGatewayId,
        vlan: v.vlan ?? 0,
        asn: v.asn ?? 0,
        bgpPeers: (v.bgpPeers ?? []).map((p) => ({
          bgpPeerId: p.bgpPeerId ?? '',
          bgpPeerState: p.bgpPeerState ?? '',
          bgpStatus: p.bgpStatus ?? '',
          asn: p.asn ?? 0,
          customerAddress: p.customerAddress ?? '',
          amazonAddress: p.amazonAddress ?? '',
        })),
        region: v.region ?? '',
        location: v.location,
        ownerAccount: v.ownerAccount,
        awsDeviceV2: v.awsDeviceV2,
        awsLogicalDeviceId: v.awsLogicalDeviceId,
        rateLimit: v.rateLimit,
        // Public-VIF prefix allowlist. Previously declared on the type but only
        // ever populated by mock-data, so any rule reading it passed its tests
        // and silently no-opped against live accounts.
        routeFilterPrefixes: v.routeFilterPrefixes
          ?.map((p) => ({ cidr: p.cidr ?? '' }))
          .filter((p) => p.cidr !== ''),
      });
    }
    nextToken = res.nextToken;
  } while (nextToken);
  return out;
}

export async function fetchDxGateways(client: DirectConnectClient): Promise<DxGateway[]> {
  const out: DxGateway[] = [];
  let nextToken: string | undefined;
  do {
    const res = await client.send(new DescribeDirectConnectGatewaysCommand({ nextToken }));
    for (const g of res.directConnectGateways ?? []) {
      out.push({
        directConnectGatewayId: g.directConnectGatewayId ?? '',
        directConnectGatewayName: g.directConnectGatewayName ?? '',
        amazonSideAsn: Number(g.amazonSideAsn ?? 0),
        directConnectGatewayState: g.directConnectGatewayState ?? '',
      });
    }
    nextToken = res.nextToken;
  } while (nextToken);
  return out;
}

type ProposalBackfill = {
  id: string;
  type: 'virtualPrivateGateway' | 'transitGateway' | undefined;
  region: string;
  ownerAccount: string;
  allowedPrefixes: string[];
};

// DescribeDirectConnectGatewayAssociations can return stub records (associationId,
// associatedGateway, allowedPrefixes all undefined) for cross-account EDGLESS-origin
// associations viewed from the DXGW owner account. Proposals retain the associated
// gateway identity, so we use them as a backfill when the direct associations call
// redacts it.
async function fetchProposalBackfills(
  client: DirectConnectClient,
  gatewayId: string
): Promise<ProposalBackfill[]> {
  const out: ProposalBackfill[] = [];
  let nextToken: string | undefined;
  do {
    const res = await client.send(
      new DescribeDirectConnectGatewayAssociationProposalsCommand({
        directConnectGatewayId: gatewayId,
        nextToken,
      })
    );
    for (const p of res.directConnectGatewayAssociationProposals ?? []) {
      if (p.proposalState !== 'accepted') continue;
      const g = p.associatedGateway;
      if (!g?.id) continue;
      out.push({
        id: g.id,
        type: g.type as 'virtualPrivateGateway' | 'transitGateway' | undefined,
        region: g.region ?? '',
        ownerAccount: g.ownerAccount ?? '',
        allowedPrefixes: (p.requestedAllowedPrefixesToDirectConnectGateway
          ?? p.existingAllowedPrefixesToDirectConnectGateway
          ?? []).map((r) => r.cidr ?? '').filter(Boolean),
      });
    }
    nextToken = res.nextToken;
  } while (nextToken);
  return out;
}

export async function fetchDxGatewayAssociations(
  client: DirectConnectClient,
  gatewayId: string
): Promise<DxGatewayAssociation[]> {
  const mapped: DxGatewayAssociation[] = [];
  const stubIndices: number[] = [];
  let nextToken: string | undefined;
  let pages = 0;
  do {
    const res = await client.send(
      new DescribeDirectConnectGatewayAssociationsCommand({
        directConnectGatewayId: gatewayId,
        nextToken,
      })
    );
    const raw = res.directConnectGatewayAssociations ?? [];
    for (const a of raw) {
      const hasCoreNetwork = !!a.associatedCoreNetwork?.id;
      // Cloud WAN associations populate `associatedCoreNetwork` instead of
      // `associatedGateway`, so a missing gateway id here is expected — don't
      // treat them as stubs to backfill from proposals.
      const isStub = !hasCoreNetwork && (!a.associatedGateway?.id || !a.associatedGateway?.type);
      if (isStub) stubIndices.push(mapped.length);
      mapped.push({
        directConnectGatewayId: a.directConnectGatewayId ?? '',
        associationId: a.associationId,
        associatedGateway: {
          id: a.associatedGateway?.id ?? '',
          type: a.associatedGateway?.type as
            | 'virtualPrivateGateway'
            | 'transitGateway'
            | undefined,
          region: a.associatedGateway?.region ?? '',
          ownerAccount: a.associatedGateway?.ownerAccount ?? '',
        },
        associatedCoreNetwork: hasCoreNetwork
          ? {
              id: a.associatedCoreNetwork?.id ?? '',
              ownerAccount: a.associatedCoreNetwork?.ownerAccount ?? '',
              attachmentId: a.associatedCoreNetwork?.attachmentId ?? '',
            }
          : undefined,
        associationState: a.associationState ?? '',
        allowedPrefixes: (a.allowedPrefixesToDirectConnectGateway ?? []).map((p) => p.cidr ?? '').filter(Boolean),
      });
    }
    nextToken = res.nextToken;
    pages++;
  } while (nextToken);
  if (pages > 1) {
    console.log(`[dx] DxGwAssoc(${gatewayId}) paginated: ${pages} pages, ${mapped.length} total`);
  }

  if (stubIndices.length > 0) {
    let backfills: ProposalBackfill[] = [];
    try {
      backfills = await fetchProposalBackfills(client, gatewayId);
    } catch (err) {
      console.warn(`[dx] proposal backfill failed for ${gatewayId}:`, (err as Error).message);
    }
    const claimed = new Set<number>();
    for (const b of backfills) {
      // Claim the first unclaimed stub — stubs don't carry identifiers we can
      // match on, so ordering is our only signal. Multiple stubs + multiple
      // proposals line up 1:1 in practice for EDGLESS associations.
      const slot = stubIndices.find((i) => !claimed.has(i));
      if (slot === undefined) break;
      claimed.add(slot);
      mapped[slot] = {
        ...mapped[slot],
        associatedGateway: {
          id: b.id,
          type: b.type,
          region: b.region,
          ownerAccount: b.ownerAccount,
        },
        allowedPrefixes: b.allowedPrefixes.length > 0 ? b.allowedPrefixes : mapped[slot].allowedPrefixes,
      };
    }
    const remaining = stubIndices.filter((i) => !claimed.has(i));
    if (claimed.size > 0) {
      console.log(`[dx] DxGwAssoc(${gatewayId}): backfilled ${claimed.size}/${stubIndices.length} stub(s) from proposals`);
    }
    for (const i of remaining) {
      mapped[i].isPrefixPoolStub = true;
      console.warn('[dx] incomplete DX gateway association (no matching proposal):', {
        dxGatewayId: mapped[i].directConnectGatewayId,
        associationState: mapped[i].associationState,
      });
    }
  }

  return mapped;
}

export async function fetchLocations(client: DirectConnectClient): Promise<DxLocation[]> {
  // DescribeLocations does not paginate — its response carries no nextToken.
  const res = await client.send(new DescribeLocationsCommand({}));
  return (res.locations ?? []).map((l) => ({
    locationCode: l.locationCode ?? '',
    locationName: l.locationName ?? '',
    region: l.region ?? '',
    availablePortSpeeds: l.availablePortSpeeds ?? [],
    availableProviders: l.availableProviders,
    availableMacSecPortSpeeds: l.availableMacSecPortSpeeds,
  }));
}

export async function fetchLags(client: DirectConnectClient): Promise<DxLag[]> {
  const out: DxLag[] = [];
  let nextToken: string | undefined;
  do {
    const res = await client.send(new DescribeLagsCommand({ nextToken }));
    for (const l of res.lags ?? []) {
      out.push({
        lagId: l.lagId ?? '',
        lagName: l.lagName ?? '',
        connectionsBandwidth: l.connectionsBandwidth ?? '',
        numberOfConnections: l.numberOfConnections ?? 0,
        minimumLinks: l.minimumLinks ?? 0,
        location: l.location ?? '',
        region: l.region ?? '',
        lagState: l.lagState ?? '',
        rateLimiterStatus: l.rateLimiterStatus,
        connections: (l.connections ?? []).map((c) => ({
          connectionId: c.connectionId ?? '',
          connectionName: c.connectionName ?? '',
          connectionState: c.connectionState ?? '',
          location: c.location ?? '',
          bandwidth: c.bandwidth ?? '',
          region: c.region ?? '',
          lagId: c.lagId,
          partnerName: c.partnerName,
          vlan: c.vlan,
        })),
      });
    }
    nextToken = res.nextToken;
  } while (nextToken);
  return out;
}

// Fetch the BGP routes for one direction on one VIF, following pagination.
// maxResults is capped at 100 by the service regardless of what we ask for.
async function fetchRoutesInDirection(
  client: DirectConnectClient,
  vifId: string,
  direction: 'accepted' | 'advertised'
): Promise<VifRoute[]> {
  const out: VifRoute[] = [];
  let nextToken: string | undefined;
  do {
    const res = await client.send(
      new ListVirtualInterfaceRoutesCommand({
        virtualInterfaceId: vifId,
        filters: { routeDirection: direction as RouteDirection },
        nextToken,
      })
    );
    for (const r of res.routes ?? []) {
      out.push({
        cidr: r.cidr ?? '',
        addressFamily: r.addressFamily as 'ipv4' | 'ipv6' | undefined,
        asPath: (r.asPath ?? []).map((seg) => ({
          pathType: seg.pathType as 'seq' | 'set' | undefined,
          path: seg.path ?? [],
        })),
        communities: r.communities ?? [],
        // Trust the filter we asked for — the service echoes routeDirection back,
        // but defaulting to the requested direction keeps the union type honest
        // if a route ever comes back without it.
        routeDirection: (r.routeDirection as 'accepted' | 'advertised' | undefined) ?? direction,
        routeInstalledAt: r.routeInstalledAt
          ? new Date(r.routeInstalledAt).toISOString()
          : undefined,
        awsLogicalDeviceId: r.awsLogicalDeviceId,
      });
    }
    nextToken = res.nextToken;
  } while (nextToken);
  return out;
}

/**
 * Fetch accepted + advertised BGP routes for a single virtual interface.
 *
 * ListVirtualInterfaceRoutes returns both directions mixed together when
 * unfiltered, so we issue one paginated pass per direction and keep them
 * separate — that's how the UI and the symmetry rules consume them.
 *
 * This is a REGIONAL DX call (unlike the global gateway APIs), so the client
 * must be built for the VIF's own region.
 */
export async function fetchVirtualInterfaceRoutes(
  client: DirectConnectClient,
  vifId: string
): Promise<VifRoutes> {
  const [accepted, advertised] = await Promise.all([
    fetchRoutesInDirection(client, vifId, 'accepted'),
    fetchRoutesInDirection(client, vifId, 'advertised'),
  ]);
  return { accepted, advertised };
}

/**
 * Recorded BGP failover tests for one VIF, following pagination.
 *
 * Read-only. Its mutating siblings (StartBgpFailoverTest / StopBgpFailoverTest)
 * force a production BGP peer DOWN for up to 4,320 minutes and must never enter
 * this codebase.
 *
 * Only tests started through the AWS API are recorded, so an empty result means
 * "no tests found in available history" — never "the customer never tested".
 */
export async function fetchVirtualInterfaceTestHistory(
  client: DirectConnectClient,
  vifId: string
): Promise<VifFailoverTest[]> {
  const out: VifFailoverTest[] = [];
  let nextToken: string | undefined;
  do {
    const res = await client.send(
      new ListVirtualInterfaceTestHistoryCommand({
        virtualInterfaceId: vifId,
        nextToken,
      })
    );
    for (const h of res.virtualInterfaceTestHistory ?? []) {
      out.push({
        testId: h.testId ?? '',
        virtualInterfaceId: h.virtualInterfaceId ?? vifId,
        bgpPeers: h.bgpPeers ?? [],
        status: h.status ?? '',
        ownerAccount: h.ownerAccount,
        testDurationInMinutes: h.testDurationInMinutes,
        startTime: h.startTime ? new Date(h.startTime).toISOString() : undefined,
        endTime: h.endTime ? new Date(h.endTime).toISOString() : undefined,
      });
    }
    nextToken = res.nextToken;
  } while (nextToken);
  return out;
}

export async function fetchDxGatewayAttachmentRegions(
  client: DirectConnectClient,
  gatewayId: string
): Promise<string[]> {
  const regions = new Set<string>();
  let nextToken: string | undefined;
  do {
    const res = await client.send(
      new DescribeDirectConnectGatewayAttachmentsCommand({
        directConnectGatewayId: gatewayId,
        nextToken,
      })
    );
    for (const att of res.directConnectGatewayAttachments ?? []) {
      if (att.virtualInterfaceRegion) regions.add(att.virtualInterfaceRegion);
    }
    nextToken = res.nextToken;
  } while (nextToken);
  return [...regions];
}
