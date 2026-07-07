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
} from '@aws-sdk/client-direct-connect';
import type {
  DxConnection,
  DxVirtualInterface,
  DxGateway,
  DxGatewayAssociation,
  DxLocation,
  DxLag,
} from '../types/aws-resources';

export async function fetchConnections(client: DirectConnectClient): Promise<DxConnection[]> {
  const res = await client.send(new DescribeConnectionsCommand({}));
  return (res.connections ?? []).map((c) => ({
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
  }));
}

export async function fetchVirtualInterfaces(client: DirectConnectClient): Promise<DxVirtualInterface[]> {
  const res = await client.send(new DescribeVirtualInterfacesCommand({}));
  return (res.virtualInterfaces ?? []).map((v) => ({
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
  }));
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
  const res = await client.send(new DescribeLocationsCommand({}));
  return (res.locations ?? []).map((l) => ({
    locationCode: l.locationCode ?? '',
    locationName: l.locationName ?? '',
    region: l.region ?? '',
    availablePortSpeeds: l.availablePortSpeeds ?? [],
  }));
}

export async function fetchLags(client: DirectConnectClient): Promise<DxLag[]> {
  const res = await client.send(new DescribeLagsCommand({}));
  return (res.lags ?? []).map((l) => ({
    lagId: l.lagId ?? '',
    lagName: l.lagName ?? '',
    connectionsBandwidth: l.connectionsBandwidth ?? '',
    numberOfConnections: l.numberOfConnections ?? 0,
    minimumLinks: l.minimumLinks ?? 0,
    location: l.location ?? '',
    region: l.region ?? '',
    lagState: l.lagState ?? '',
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
  }));
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
