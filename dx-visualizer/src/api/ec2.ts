import {
  EC2Client,
  DescribeVpcsCommand,
  DescribeVpnGatewaysCommand,
  DescribeVpnConnectionsCommand,
  DescribeTransitGatewaysCommand,
  DescribeTransitGatewayAttachmentsCommand,
  DescribeTransitGatewayPeeringAttachmentsCommand,
  DescribeVpcPeeringConnectionsCommand,
  DescribeCustomerGatewaysCommand,
  DescribeTransitGatewayRouteTablesCommand,
  SearchTransitGatewayRoutesCommand,
  DescribeRouteTablesCommand,
  DescribeRegionsCommand,
} from '@aws-sdk/client-ec2';
import type { Vpc, VpnGateway, VpnConnection, TransitGateway, TransitGatewayAttachment, TransitGatewayPeeringAttachment, VpcPeeringConnection, CustomerGateway, TgwRouteTable, TgwRoute, TgwRouteTableWithRoutes, VpcRouteTable, VpcRoute } from '../types/aws-resources';

function tagsToRecord(tags: { Key?: string; Value?: string }[] | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const t of tags ?? []) {
    if (t.Key) result[t.Key] = t.Value ?? '';
  }
  return result;
}

export async function fetchEnabledRegions(client: EC2Client): Promise<string[]> {
  // AllRegions defaults to false — returns only regions enabled for this
  // account, so the multi-region sweep never touches opted-out regions.
  const res = await client.send(new DescribeRegionsCommand({}));
  return (res.Regions ?? []).map((r) => r.RegionName ?? '').filter(Boolean);
}

export async function fetchVpcs(client: EC2Client, region: string): Promise<Vpc[]> {
  const res = await client.send(new DescribeVpcsCommand({}));
  return (res.Vpcs ?? []).map((v) => ({
    vpcId: v.VpcId ?? '',
    cidrBlock: v.CidrBlock ?? '',
    tags: tagsToRecord(v.Tags),
    region,
    state: v.State ?? '',
  }));
}

export async function fetchVpnGateways(client: EC2Client): Promise<VpnGateway[]> {
  const res = await client.send(
    new DescribeVpnGatewaysCommand({
      Filters: [{ Name: 'state', Values: ['available'] }],
    })
  );
  return (res.VpnGateways ?? []).map((g) => ({
    vpnGatewayId: g.VpnGatewayId ?? '',
    vpcAttachments: (g.VpcAttachments ?? []).map((a) => ({
      vpcId: a.VpcId ?? '',
      state: a.State ?? '',
    })),
    type: g.Type ?? '',
    amazonSideAsn: Number(g.AmazonSideAsn ?? 0),
    state: g.State ?? '',
    tags: tagsToRecord(g.Tags),
  }));
}

export async function fetchTransitGateways(client: EC2Client): Promise<TransitGateway[]> {
  const res = await client.send(new DescribeTransitGatewaysCommand({}));
  return (res.TransitGateways ?? []).map((t) => ({
    transitGatewayId: t.TransitGatewayId ?? '',
    transitGatewayArn: t.TransitGatewayArn ?? '',
    state: t.State ?? '',
    ownerId: t.OwnerId ?? '',
    description: t.Description ?? '',
    amazonSideAsn: Number(t.Options?.AmazonSideAsn ?? 0),
    tags: tagsToRecord(t.Tags),
  }));
}

export async function fetchTransitGatewayAttachments(
  client: EC2Client
): Promise<TransitGatewayAttachment[]> {
  const res = await client.send(new DescribeTransitGatewayAttachmentsCommand({}));
  return (res.TransitGatewayAttachments ?? []).map((a) => {
    const tags = tagsToRecord(a.Tags);
    return {
      transitGatewayAttachmentId: a.TransitGatewayAttachmentId ?? '',
      transitGatewayId: a.TransitGatewayId ?? '',
      resourceType: (a.ResourceType ?? 'vpc') as TransitGatewayAttachment['resourceType'],
      resourceId: a.ResourceId ?? '',
      resourceOwnerId: a.ResourceOwnerId ?? '',
      state: a.State ?? '',
      name: tags.Name,
    };
  });
}

export async function fetchTransitGatewayPeeringAttachments(
  client: EC2Client
): Promise<TransitGatewayPeeringAttachment[]> {
  const res = await client.send(new DescribeTransitGatewayPeeringAttachmentsCommand({}));
  return (res.TransitGatewayPeeringAttachments ?? [])
    .filter((p) => p.State !== 'deleted' && p.State !== 'deleting' && p.State !== 'failed' && p.State !== 'rejected')
    .map((p) => ({
      transitGatewayAttachmentId: p.TransitGatewayAttachmentId ?? '',
      requesterTgwInfo: {
        transitGatewayId: p.RequesterTgwInfo?.TransitGatewayId ?? '',
        region: p.RequesterTgwInfo?.Region ?? '',
        ownerId: p.RequesterTgwInfo?.OwnerId ?? '',
      },
      accepterTgwInfo: {
        transitGatewayId: p.AccepterTgwInfo?.TransitGatewayId ?? '',
        region: p.AccepterTgwInfo?.Region ?? '',
        ownerId: p.AccepterTgwInfo?.OwnerId ?? '',
      },
      state: p.State ?? '',
      tags: tagsToRecord(p.Tags),
    }));
}

export async function fetchVpcPeeringConnections(
  client: EC2Client,
  region: string,
): Promise<VpcPeeringConnection[]> {
  const res = await client.send(new DescribeVpcPeeringConnectionsCommand({}));
  return (res.VpcPeeringConnections ?? [])
    .filter((p) => {
      const s = p.Status?.Code ?? '';
      return s !== 'deleted' && s !== 'deleting' && s !== 'failed' && s !== 'rejected' && s !== 'expired';
    })
    .map((p) => ({
      vpcPeeringConnectionId: p.VpcPeeringConnectionId ?? '',
      state: p.Status?.Code ?? '',
      requesterVpc: {
        vpcId: p.RequesterVpcInfo?.VpcId ?? '',
        cidrBlock: p.RequesterVpcInfo?.CidrBlock ?? '',
        ownerId: p.RequesterVpcInfo?.OwnerId ?? '',
        region: p.RequesterVpcInfo?.Region ?? region,
      },
      accepterVpc: {
        vpcId: p.AccepterVpcInfo?.VpcId ?? '',
        cidrBlock: p.AccepterVpcInfo?.CidrBlock ?? '',
        ownerId: p.AccepterVpcInfo?.OwnerId ?? '',
        region: p.AccepterVpcInfo?.Region ?? region,
      },
      tags: tagsToRecord(p.Tags),
    }));
}

export async function fetchCustomerGateways(client: EC2Client): Promise<CustomerGateway[]> {
  const res = await client.send(new DescribeCustomerGatewaysCommand({}));
  return (res.CustomerGateways ?? []).map((c) => ({
    customerGatewayId: c.CustomerGatewayId ?? '',
    bgpAsn: c.BgpAsn ?? '',
    ipAddress: c.IpAddress ?? '',
    state: c.State ?? '',
    type: c.Type ?? '',
    tags: tagsToRecord(c.Tags),
  }));
}

export async function fetchVpnConnections(client: EC2Client): Promise<VpnConnection[]> {
  const res = await client.send(new DescribeVpnConnectionsCommand({}));
  return (res.VpnConnections ?? []).map((v) => {
    const tunnelOptsByIp = new Map<string, { dpdTimeoutSeconds?: number; dpdTimeoutAction?: string }>();
    for (const opt of v.Options?.TunnelOptions ?? []) {
      if (!opt.OutsideIpAddress) continue;
      tunnelOptsByIp.set(opt.OutsideIpAddress, {
        dpdTimeoutSeconds: opt.DpdTimeoutSeconds,
        dpdTimeoutAction: opt.DpdTimeoutAction,
      });
    }
    return {
      vpnConnectionId: v.VpnConnectionId ?? '',
      vpnGatewayId: v.VpnGatewayId,
      transitGatewayId: v.TransitGatewayId,
      customerGatewayId: v.CustomerGatewayId ?? '',
      state: v.State ?? '',
      type: v.Type ?? '',
      category: v.Category ?? '',
      customerGatewayAddress: v.CustomerGatewayConfiguration ?? '',
      tunnels: (v.VgwTelemetry ?? []).map((t) => {
        const ip = t.OutsideIpAddress ?? '';
        const opts = tunnelOptsByIp.get(ip);
        return {
          outsideIpAddress: ip,
          status: (t.Status === 'UP' ? 'UP' : 'DOWN') as 'UP' | 'DOWN',
          statusMessage: t.StatusMessage,
          acceptedRouteCount: t.AcceptedRouteCount,
          dpdTimeoutSeconds: opts?.dpdTimeoutSeconds,
          dpdTimeoutAction: opts?.dpdTimeoutAction,
        };
      }),
      tags: tagsToRecord(v.Tags),
    };
  });
}

export async function fetchTgwRouteTables(client: EC2Client, transitGatewayId: string): Promise<TgwRouteTable[]> {
  const res = await client.send(new DescribeTransitGatewayRouteTablesCommand({
    Filters: [{ Name: 'transit-gateway-id', Values: [transitGatewayId] }],
  }));
  return (res.TransitGatewayRouteTables ?? []).map((rt) => ({
    transitGatewayRouteTableId: rt.TransitGatewayRouteTableId ?? '',
    transitGatewayId: rt.TransitGatewayId ?? '',
    state: rt.State ?? '',
    defaultAssociationRouteTable: rt.DefaultAssociationRouteTable ?? false,
    defaultPropagationRouteTable: rt.DefaultPropagationRouteTable ?? false,
    tags: tagsToRecord(rt.Tags),
  }));
}

export async function fetchTgwRoutes(client: EC2Client, routeTableId: string): Promise<TgwRoute[]> {
  const res = await client.send(new SearchTransitGatewayRoutesCommand({
    TransitGatewayRouteTableId: routeTableId,
    Filters: [{ Name: 'state', Values: ['active', 'blackhole'] }],
  }));
  return (res.Routes ?? []).map((r) => ({
    destinationCidrBlock: r.DestinationCidrBlock ?? '',
    transitGatewayAttachments: (r.TransitGatewayAttachments ?? []).map((a) => ({
      transitGatewayAttachmentId: a.TransitGatewayAttachmentId ?? '',
      resourceType: a.ResourceType ?? '',
      resourceId: a.ResourceId ?? '',
    })),
    type: (r.Type === 'static' ? 'static' : 'propagated') as 'static' | 'propagated',
    state: (r.State === 'blackhole' ? 'blackhole' : 'active') as 'active' | 'blackhole',
  }));
}

export async function fetchVpcRouteTables(client: EC2Client): Promise<VpcRouteTable[]> {
  // DescribeRouteTables returns every route table in the account+region in a
  // single call (paginated). One trip handles all VPCs we care about.
  const result: VpcRouteTable[] = [];
  let nextToken: string | undefined;
  do {
    const res = await client.send(new DescribeRouteTablesCommand({ NextToken: nextToken }));
    for (const rt of res.RouteTables ?? []) {
      const associations = rt.Associations ?? [];
      const isMain = associations.some((a) => a.Main === true);
      const associatedSubnetIds = associations
        .map((a) => a.SubnetId)
        .filter((s): s is string => Boolean(s));
      const routes: VpcRoute[] = (rt.Routes ?? []).map((r) => ({
        destinationCidrBlock: r.DestinationCidrBlock,
        destinationIpv6CidrBlock: r.DestinationIpv6CidrBlock,
        destinationPrefixListId: r.DestinationPrefixListId,
        gatewayId: r.GatewayId,
        natGatewayId: r.NatGatewayId,
        transitGatewayId: r.TransitGatewayId,
        vpcPeeringConnectionId: r.VpcPeeringConnectionId,
        networkInterfaceId: r.NetworkInterfaceId,
        egressOnlyInternetGatewayId: r.EgressOnlyInternetGatewayId,
        carrierGatewayId: r.CarrierGatewayId,
        localGatewayId: r.LocalGatewayId,
        coreNetworkArn: r.CoreNetworkArn,
        instanceId: r.InstanceId,
        origin: r.Origin,
        state: (r.State === 'blackhole' ? 'blackhole' : 'active') as 'active' | 'blackhole',
      }));
      result.push({
        routeTableId: rt.RouteTableId ?? '',
        vpcId: rt.VpcId ?? '',
        isMain,
        associatedSubnetIds,
        tags: tagsToRecord(rt.Tags),
        routes,
      });
    }
    nextToken = res.NextToken;
  } while (nextToken);
  return result;
}

export async function fetchTgwRouteTablesWithRoutes(client: EC2Client, transitGatewayId: string): Promise<TgwRouteTableWithRoutes[]> {
  const routeTables = await fetchTgwRouteTables(client, transitGatewayId);
  const results = await Promise.all(
    routeTables.map(async (rt) => ({
      routeTable: rt,
      routes: await fetchTgwRoutes(client, rt.transitGatewayRouteTableId),
    }))
  );
  return results;
}
