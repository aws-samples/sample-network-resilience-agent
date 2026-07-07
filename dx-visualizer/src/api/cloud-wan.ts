import {
  NetworkManagerClient,
  ListCoreNetworksCommand,
  GetCoreNetworkCommand,
  ListAttachmentsCommand,
  ListPeeringsCommand,
  GetNetworkRoutesCommand,
} from '@aws-sdk/client-networkmanager';
import type { CloudWanCoreNetwork, CloudWanAttachment, CloudWanPeering, CloudWanSegmentRoutes, CloudWanRoute } from '../types/aws-resources';

function tagsToRecord(tags?: { Key?: string; Value?: string }[]): Record<string, string> {
  const rec: Record<string, string> = {};
  for (const t of tags ?? []) {
    if (t.Key) rec[t.Key] = t.Value ?? '';
  }
  return rec;
}

export async function fetchCoreNetworks(client: NetworkManagerClient): Promise<CloudWanCoreNetwork[]> {
  const listRes = await client.send(new ListCoreNetworksCommand({}));
  const summaries = listRes.CoreNetworks ?? [];

  const results: CloudWanCoreNetwork[] = [];
  for (const summary of summaries) {
    if (!summary.CoreNetworkId) continue;
    const detail = await client.send(new GetCoreNetworkCommand({ CoreNetworkId: summary.CoreNetworkId }));
    const cn = detail.CoreNetwork;
    if (!cn) continue;

    results.push({
      coreNetworkId: cn.CoreNetworkId ?? '',
      coreNetworkArn: cn.CoreNetworkArn ?? '',
      globalNetworkId: cn.GlobalNetworkId ?? '',
      description: cn.Description ?? '',
      state: (cn.State ?? '').toLowerCase(),
      edges: (cn.Edges ?? []).map(e => ({
        edgeLocation: e.EdgeLocation ?? '',
        asn: e.Asn ?? 0,
        insideCidrBlocks: e.InsideCidrBlocks ?? [],
      })),
      segments: (cn.Segments ?? []).map(s => ({
        name: s.Name ?? '',
        edgeLocations: s.EdgeLocations ?? [],
        sharedSegments: s.SharedSegments ?? [],
      })),
    });
  }
  return results;
}

// CloudWan tag values occasionally contain raw control characters (tabs,
// newlines) that break the SDK's JSON.parse step — "Bad control character in
// string literal". When that happens we fall back to parsing the raw body
// ourselves after stripping U+0000–U+001F (except TAB/LF/CR which JSON.parse
// tolerates when they're escaped by us first). CloudWan is optional data —
// returning [] on unrecoverable failures keeps the rest of the topology loading.
async function recoverAttachmentsFromRawResponse(err: unknown): Promise<CloudWanAttachment[] | null> {
  const resp = (err as { $response?: { body?: unknown } })?.$response;
  if (!resp) return null;
  let bodyText: string | null = null;
  const body = resp.body;
  if (typeof body === 'string') {
    bodyText = body;
  } else if (body instanceof Uint8Array) {
    bodyText = new TextDecoder('utf-8').decode(body);
  } else if (body && typeof (body as { transformToString?: unknown }).transformToString === 'function') {
    try { bodyText = await (body as { transformToString: () => Promise<string> }).transformToString(); } catch { /* ignore */ }
  }
  if (!bodyText) return null;
  const sanitized = bodyText.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
  try {
    const parsed = JSON.parse(sanitized) as { Attachments?: Array<Record<string, unknown>> };
    return (parsed.Attachments ?? []).map((a) => ({
      attachmentId: (a.AttachmentId as string) ?? '',
      coreNetworkId: (a.CoreNetworkId as string) ?? '',
      ownerAccountId: (a.OwnerAccountId as string) ?? '',
      attachmentType: (((a.AttachmentType as string) ?? 'VPC').toLowerCase().replace(/_/g, '-')) as CloudWanAttachment['attachmentType'],
      edgeLocation: (a.EdgeLocation as string) ?? '',
      resourceArn: (a.ResourceArn as string) ?? '',
      segmentName: (a.SegmentName as string) ?? '',
      state: ((a.State as string) ?? '').toLowerCase(),
      tags: tagsToRecord(a.Tags as { Key?: string; Value?: string }[] | undefined),
    }));
  } catch {
    return null;
  }
}

export async function fetchCloudWanAttachments(client: NetworkManagerClient): Promise<CloudWanAttachment[]> {
  try {
    const res = await client.send(new ListAttachmentsCommand({}));
    return (res.Attachments ?? []).map(a => ({
      attachmentId: a.AttachmentId ?? '',
      coreNetworkId: a.CoreNetworkId ?? '',
      ownerAccountId: a.OwnerAccountId ?? '',
      attachmentType: (a.AttachmentType ?? 'VPC').toLowerCase().replace(/_/g, '-') as CloudWanAttachment['attachmentType'],
      edgeLocation: a.EdgeLocation ?? '',
      resourceArn: a.ResourceArn ?? '',
      segmentName: a.SegmentName ?? '',
      state: (a.State ?? '').toLowerCase(),
      tags: tagsToRecord(a.Tags),
    }));
  } catch (err) {
    if (err instanceof SyntaxError || /control character|Deserialization/i.test((err as Error).message ?? '')) {
      const recovered = await recoverAttachmentsFromRawResponse(err);
      if (recovered) {
        console.warn('[CloudWAN] Recovered Attachments from raw response after deserialization error');
        return recovered;
      }
      console.warn('[CloudWAN] ListAttachments deserialization failed, returning empty list:', (err as Error).message);
      return [];
    }
    throw err;
  }
}

export async function fetchCloudWanRoutes(
  client: NetworkManagerClient,
  coreNetworks: CloudWanCoreNetwork[],
): Promise<Map<string, CloudWanSegmentRoutes[]>> {
  const routeMap = new Map<string, CloudWanSegmentRoutes[]>();

  for (const cn of coreNetworks) {
    const segmentRoutes: CloudWanSegmentRoutes[] = [];

    for (const segment of cn.segments) {
      for (const edgeLocation of segment.edgeLocations) {
        try {
          const res = await client.send(
            new GetNetworkRoutesCommand({
              GlobalNetworkId: cn.globalNetworkId,
              RouteTableIdentifier: {
                CoreNetworkSegmentEdge: {
                  CoreNetworkId: cn.coreNetworkId,
                  SegmentName: segment.name,
                  EdgeLocation: edgeLocation,
                },
              },
            }),
          );

          const routes: CloudWanRoute[] = (res.NetworkRoutes ?? []).map((r) => ({
            destinationCidrBlock: r.DestinationCidrBlock ?? '',
            destinations: (r.Destinations ?? []).map((d) => ({
              coreNetworkAttachmentId: d.CoreNetworkAttachmentId ?? '',
              segmentName: d.SegmentName ?? '',
              edgeLocation: d.EdgeLocation ?? '',
              resourceType: d.ResourceType ?? '',
              resourceId: d.ResourceId ?? '',
            })),
            type: (r.Type ?? 'PROPAGATED').toLowerCase() as 'static' | 'propagated',
            state: (r.State ?? 'ACTIVE').toLowerCase() as 'active' | 'blackhole',
          }));

          segmentRoutes.push({ segmentName: segment.name, edgeLocation, routes });
        } catch (err) {
          console.warn(`[CloudWAN] Failed to fetch routes for segment=${segment.name} edge=${edgeLocation}:`, err);
        }
      }
    }

    routeMap.set(cn.coreNetworkId, segmentRoutes);
  }

  return routeMap;
}

export async function fetchCloudWanPeerings(client: NetworkManagerClient): Promise<CloudWanPeering[]> {
  const res = await client.send(new ListPeeringsCommand({}));
  return (res.Peerings ?? []).map(p => ({
    peeringId: p.PeeringId ?? '',
    coreNetworkId: p.CoreNetworkId ?? '',
    peeringType: p.PeeringType ?? '',
    edgeLocation: p.EdgeLocation ?? '',
    resourceArn: p.ResourceArn ?? '',
    state: (p.State ?? '').toLowerCase(),
    tags: tagsToRecord(p.Tags),
  }));
}
