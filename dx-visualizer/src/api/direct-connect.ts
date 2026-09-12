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
  PrefixPool,
  VifRoute,
  VifRoutes,
  VifFailoverTest,
} from '../types/aws-resources';
import { drainPages } from './paginate';

/**
 * Page cap for every DX control-plane paginator below. These APIs return ~100
 * records per page, and the largest real estates have single-digit pages of
 * gateways, associations, proposals, or attachments — so 100 pages is orders of
 * magnitude of headroom, and reaching it means the endpoint is malfunctioning
 * rather than that the account is unusually large.
 */
const DX_MAX_PAGES = 100;

// DescribeConnections, DescribeVirtualInterfaces and DescribeLags all paginate.
// Reading only page 1 is worse than an error here: every resiliency rule counts
// connections and VIFs per location, so a truncated list yields a confidently
// *wrong* score rather than a visible failure. Follow nextToken like
// fetchDxGateways does.
/**
 * Collapse the four flat `prefixPool*` members AWS returns into one object, or
 * `undefined` when the API sent none of them.
 *
 * The distinction matters: these fields are documented as "not applicable to
 * hosted connections or interconnects", and an account made entirely of
 * partner-hosted ports gets nothing back. Returning `{}` would let a rule read
 * `unallocatedIpv4 ?? 0` and report an exhausted pool on a port that never had
 * one, so absence has to stay absent rather than becoming a zero.
 */
function prefixPool(src: {
  prefixPoolSizeIpv4?: number;
  prefixPoolSizeIpv6?: number;
  prefixPoolUnallocatedCountIpv4?: number;
  prefixPoolUnallocatedCountIpv6?: number;
  prefixPoolAllocatedCountIpv4?: number;
  prefixPoolAllocatedCountIpv6?: number;
}): PrefixPool | undefined {
  const pool: PrefixPool = {
    sizeIpv4: src.prefixPoolSizeIpv4,
    sizeIpv6: src.prefixPoolSizeIpv6,
    unallocatedIpv4: src.prefixPoolUnallocatedCountIpv4,
    unallocatedIpv6: src.prefixPoolUnallocatedCountIpv6,
    allocatedIpv4: src.prefixPoolAllocatedCountIpv4,
    allocatedIpv6: src.prefixPoolAllocatedCountIpv6,
  };
  return Object.values(pool).some((v) => v !== undefined) ? pool : undefined;
}

export async function fetchConnections(client: DirectConnectClient): Promise<DxConnection[]> {
  return drainPages<DxConnection>(
    'DX connections',
    async (nextToken) => {
      const res = await client.send(new DescribeConnectionsCommand({ nextToken }));
      const items = (res.connections ?? []).map((c) => ({
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
        hasLogicalRedundancy: c.hasLogicalRedundancy,
        jumboFrameCapable: c.jumboFrameCapable,
        prefixPool: prefixPool(c),
      }));
      return { items, nextToken: res.nextToken };
    },
    { maxPages: DX_MAX_PAGES },
  );
}

export async function fetchVirtualInterfaces(client: DirectConnectClient): Promise<DxVirtualInterface[]> {
  return drainPages<DxVirtualInterface>(
    'virtual interfaces',
    async (nextToken) => {
      const res = await client.send(new DescribeVirtualInterfacesCommand({ nextToken }));
      const items = (res.virtualInterfaces ?? []).map((v) => ({
        virtualInterfaceId: v.virtualInterfaceId ?? '',
        virtualInterfaceName: v.virtualInterfaceName ?? '',
        virtualInterfaceType: (v.virtualInterfaceType ?? 'private') as 'private' | 'public' | 'transit',
        virtualInterfaceState: v.virtualInterfaceState ?? '',
        connectionId: v.connectionId ?? '',
        directConnectGatewayId: v.directConnectGatewayId,
        virtualGatewayId: v.virtualGatewayId,
        vlan: v.vlan ?? 0,
        asn: v.asn ?? 0,
        addressFamily: v.addressFamily,
        bgpPeers: (v.bgpPeers ?? []).map((p) => ({
          bgpPeerId: p.bgpPeerId ?? '',
          bgpPeerState: p.bgpPeerState ?? '',
          bgpStatus: p.bgpStatus ?? '',
          asn: p.asn ?? 0,
          customerAddress: p.customerAddress ?? '',
          amazonAddress: p.amazonAddress ?? '',
          // Presence only. `authKey` is the live MD5 secret; capturing the value
          // would put it in the store, every snapshot export, and the Bedrock
          // context. A boolean answers the only question a rule asks of it.
          hasAuthKey: (v.authKey ?? '') !== '',
        })),
        region: v.region ?? '',
        location: v.location,
        ownerAccount: v.ownerAccount,
        awsDeviceV2: v.awsDeviceV2,
        awsLogicalDeviceId: v.awsLogicalDeviceId,
        rateLimit: v.rateLimit,
        mtu: v.mtu,
        jumboFrameCapable: v.jumboFrameCapable,
        siteLinkEnabled: v.siteLinkEnabled,
        prefixPool: prefixPool(v),
        // Public-VIF prefix allowlist. Previously declared on the type but only
        // ever populated by mock-data, so any rule reading it passed its tests
        // and silently no-opped against live accounts.
        routeFilterPrefixes: v.routeFilterPrefixes
          ?.map((p) => ({ cidr: p.cidr ?? '' }))
          .filter((p) => p.cidr !== ''),
      }));
      return { items, nextToken: res.nextToken };
    },
    { maxPages: DX_MAX_PAGES },
  );
}

export async function fetchDxGateways(client: DirectConnectClient): Promise<DxGateway[]> {
  return drainPages<DxGateway>(
    'DX gateways',
    async (nextToken) => {
      const res = await client.send(new DescribeDirectConnectGatewaysCommand({ nextToken }));
      const items = (res.directConnectGateways ?? []).map((g) => ({
        directConnectGatewayId: g.directConnectGatewayId ?? '',
        directConnectGatewayName: g.directConnectGatewayName ?? '',
        amazonSideAsn: Number(g.amazonSideAsn ?? 0),
        directConnectGatewayState: g.directConnectGatewayState ?? '',
      }));
      return { items, nextToken: res.nextToken };
    },
    { maxPages: DX_MAX_PAGES },
  );
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
  return drainPages<ProposalBackfill>(
    `DX gateway association proposals (${gatewayId})`,
    async (nextToken) => {
      const res = await client.send(
        new DescribeDirectConnectGatewayAssociationProposalsCommand({
          directConnectGatewayId: gatewayId,
          nextToken,
        })
      );
      const items: ProposalBackfill[] = [];
      for (const p of res.directConnectGatewayAssociationProposals ?? []) {
        if (p.proposalState !== 'accepted') continue;
        const g = p.associatedGateway;
        if (!g?.id) continue;
        items.push({
          id: g.id,
          type: g.type as 'virtualPrivateGateway' | 'transitGateway' | undefined,
          region: g.region ?? '',
          ownerAccount: g.ownerAccount ?? '',
          allowedPrefixes: (p.requestedAllowedPrefixesToDirectConnectGateway
            ?? p.existingAllowedPrefixesToDirectConnectGateway
            ?? []).map((r) => r.cidr ?? '').filter(Boolean),
        });
      }
      return { items, nextToken: res.nextToken };
    },
    { maxPages: DX_MAX_PAGES },
  );
}

export async function fetchDxGatewayAssociations(
  client: DirectConnectClient,
  gatewayId: string
): Promise<DxGatewayAssociation[]> {
  const stubIndices: number[] = [];
  // `drainPages` owns the accumulator, so track how many records earlier pages
  // already contributed: a stub's index in the flat result is that running
  // total plus its offset within the current page. The page counter is kept
  // only to preserve the pagination log line below.
  let emitted = 0;
  let pages = 0;
  const mapped = await drainPages<DxGatewayAssociation>(
    `DX gateway associations (${gatewayId})`,
    async (nextToken) => {
      const res = await client.send(
        new DescribeDirectConnectGatewayAssociationsCommand({
          directConnectGatewayId: gatewayId,
          nextToken,
        })
      );
      const raw = res.directConnectGatewayAssociations ?? [];
      const items: DxGatewayAssociation[] = [];
      for (const a of raw) {
        const hasCoreNetwork = !!a.associatedCoreNetwork?.id;
        // Cloud WAN associations populate `associatedCoreNetwork` instead of
        // `associatedGateway`, so a missing gateway id here is expected — don't
        // treat them as stubs to backfill from proposals.
        const isStub = !hasCoreNetwork && (!a.associatedGateway?.id || !a.associatedGateway?.type);
        if (isStub) stubIndices.push(emitted + items.length);
        items.push({
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
      emitted += items.length;
      pages++;
      return { items, nextToken: res.nextToken };
    },
    { maxPages: DX_MAX_PAGES },
  );
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
  return drainPages<DxLag>(
    'LAGs',
    async (nextToken) => {
      const res = await client.send(new DescribeLagsCommand({ nextToken }));
      const items = (res.lags ?? []).map((l) => ({
        lagId: l.lagId ?? '',
        lagName: l.lagName ?? '',
        connectionsBandwidth: l.connectionsBandwidth ?? '',
        numberOfConnections: l.numberOfConnections ?? 0,
        minimumLinks: l.minimumLinks ?? 0,
        location: l.location ?? '',
        region: l.region ?? '',
        lagState: l.lagState ?? '',
        rateLimiterStatus: l.rateLimiterStatus,
        prefixPool: prefixPool(l),
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
          awsDeviceV2: c.awsDeviceV2,
          awsLogicalDeviceId: c.awsLogicalDeviceId,
          hasLogicalRedundancy: c.hasLogicalRedundancy,
          jumboFrameCapable: c.jumboFrameCapable,
          prefixPool: prefixPool(c),
        })),
      }));
      return { items, nextToken: res.nextToken };
    },
    { maxPages: DX_MAX_PAGES },
  );
}

// Fetch the BGP routes for one direction on one VIF, following pagination.
// maxResults is capped at 100 by the service regardless of what we ask for.
async function fetchRoutesInDirection(
  client: DirectConnectClient,
  vifId: string,
  direction: 'accepted' | 'advertised'
): Promise<VifRoute[]> {
  return drainPages<VifRoute>(
    `${direction} routes on ${vifId}`,
    async (nextToken) => {
      const res = await client.send(
        new ListVirtualInterfaceRoutesCommand({
          virtualInterfaceId: vifId,
          filters: { routeDirection: direction as RouteDirection },
          nextToken,
        })
      );
      const items = (res.routes ?? [])
        // Trust the filter, but verify the echo. Everything downstream treats the
        // `accepted` list as prefixes the customer router advertised — it is the
        // numerator of every prefix-quota percentage — so one advertised route
        // leaking in inflates that count with no visible symptom. When the service
        // states a direction and it is not the one we asked for, drop the route
        // rather than relabelling it.
        .filter((r) => !r.routeDirection || r.routeDirection === direction)
        .map((r) => ({
          cidr: r.cidr ?? '',
          addressFamily: r.addressFamily as 'ipv4' | 'ipv6' | undefined,
          asPath: (r.asPath ?? []).map((seg) => ({
            pathType: seg.pathType as 'seq' | 'set' | undefined,
            path: seg.path ?? [],
          })),
          communities: r.communities ?? [],
          // The service echoes routeDirection back, but defaulting to the
          // requested direction keeps the union type honest if a route ever
          // comes back without it.
          routeDirection: (r.routeDirection as 'accepted' | 'advertised' | undefined) ?? direction,
          routeInstalledAt: r.routeInstalledAt
            ? new Date(r.routeInstalledAt).toISOString()
            : undefined,
          awsLogicalDeviceId: r.awsLogicalDeviceId,
        }));
      return { items, nextToken: res.nextToken };
    },
    { maxPages: DX_MAX_PAGES },
  );
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
  return drainPages<VifFailoverTest>(
    `failover test history on ${vifId}`,
    async (nextToken) => {
      const res = await client.send(
        new ListVirtualInterfaceTestHistoryCommand({
          virtualInterfaceId: vifId,
          nextToken,
        })
      );
      const items = (res.virtualInterfaceTestHistory ?? []).map((h) => ({
        testId: h.testId ?? '',
        virtualInterfaceId: h.virtualInterfaceId ?? vifId,
        bgpPeers: h.bgpPeers ?? [],
        status: h.status ?? '',
        ownerAccount: h.ownerAccount,
        testDurationInMinutes: h.testDurationInMinutes,
        startTime: h.startTime ? new Date(h.startTime).toISOString() : undefined,
        endTime: h.endTime ? new Date(h.endTime).toISOString() : undefined,
      }));
      return { items, nextToken: res.nextToken };
    },
    { maxPages: DX_MAX_PAGES },
  );
}

export async function fetchDxGatewayAttachmentRegions(
  client: DirectConnectClient,
  gatewayId: string
): Promise<string[]> {
  const regions = await drainPages<string>(
    `DX gateway attachments (${gatewayId})`,
    async (nextToken) => {
      const res = await client.send(
        new DescribeDirectConnectGatewayAttachmentsCommand({
          directConnectGatewayId: gatewayId,
          nextToken,
        })
      );
      const items = (res.directConnectGatewayAttachments ?? [])
        .map((att) => att.virtualInterfaceRegion)
        .filter((r): r is string => !!r);
      return { items, nextToken: res.nextToken };
    },
    { maxPages: DX_MAX_PAGES },
  );
  return [...new Set(regions)];
}
