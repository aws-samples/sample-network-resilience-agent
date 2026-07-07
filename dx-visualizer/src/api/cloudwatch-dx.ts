import { GetMetricDataCommand, ListMetricsCommand } from '@aws-sdk/client-cloudwatch';
import type { MetricDataQuery, Metric } from '@aws-sdk/client-cloudwatch';
import type { AwsCredentials, DxVirtualInterface } from '../types/aws-resources';
import { createCloudWatchClient } from './aws-client';

export interface BgpPrefixMetrics {
  accepted?: number;
  advertised?: number;
}

const METRIC_NAMES = [
  'VirtualInterfaceBgpPrefixesAccepted',
  'VirtualInterfaceBgpPrefixesAdvertised',
] as const;

/**
 * Fetch BGP prefix metrics (Accepted & Advertised) for all VIFs via CloudWatch.
 *
 * AWS/DX publishes these metrics with VirtualInterfaceId plus an address-family
 * dimension (IPv4/IPv6) that isn't in the public docs. We discover the real
 * dimensions with ListMetrics so queries match the actual metric streams, then
 * sum IPv4+IPv6 into a single number per VIF.
 */
export async function fetchBgpPrefixMetrics(
  creds: AwsCredentials,
  vifs: DxVirtualInterface[],
): Promise<Map<string, BgpPrefixMetrics>> {
  const result = new Map<string, BgpPrefixMetrics>();
  if (vifs.length === 0) return result;

  const byRegion = new Map<string, DxVirtualInterface[]>();
  for (const vif of vifs) {
    const region = vif.region || creds.region;
    const list = byRegion.get(region) ?? [];
    list.push(vif);
    byRegion.set(region, list);
  }

  const now = new Date();
  const startTime = new Date(now.getTime() - 30 * 60 * 1000);

  const regionFetches = [...byRegion.entries()].map(async ([region, regionVifs]) => {
    try {
      const client = createCloudWatchClient({ ...creds, region });
      const vifIds = new Set(regionVifs.map((v) => v.virtualInterfaceId));

      // Phase 1: discover which metric streams actually exist for these VIFs
      const streams: Metric[] = [];
      for (const metricName of METRIC_NAMES) {
        let nextToken: string | undefined;
        do {
          const lm = await client.send(
            new ListMetricsCommand({
              Namespace: 'AWS/DX',
              MetricName: metricName,
              NextToken: nextToken,
            }),
          );
          for (const m of lm.Metrics ?? []) {
            const vifDim = m.Dimensions?.find((d) => d.Name === 'VirtualInterfaceId');
            if (vifDim?.Value && vifIds.has(vifDim.Value)) streams.push(m);
          }
          nextToken = lm.NextToken;
        } while (nextToken);
      }

      if (streams.length === 0) {
        console.log(`[AWS] ${region}/BGP prefix metrics: no streams found for ${vifIds.size} VIFs`);
        return;
      }

      // Phase 2: query every discovered stream with its exact dimensions
      const queries: MetricDataQuery[] = streams.map((m, idx) => ({
        Id: `m${idx}`,
        MetricStat: {
          Metric: { Namespace: m.Namespace, MetricName: m.MetricName, Dimensions: m.Dimensions },
          Period: 300,
          Stat: 'Average',
        },
        ReturnData: true,
      }));

      const lookup = new Map<string, { vifId: string; isAccepted: boolean }>();
      streams.forEach((m, idx) => {
        const vifId = m.Dimensions?.find((d) => d.Name === 'VirtualInterfaceId')?.Value;
        if (vifId) {
          lookup.set(`m${idx}`, {
            vifId,
            isAccepted: m.MetricName === 'VirtualInterfaceBgpPrefixesAccepted',
          });
        }
      });

      const BATCH_SIZE = 500;
      for (let i = 0; i < queries.length; i += BATCH_SIZE) {
        const batch = queries.slice(i, i + BATCH_SIZE);
        const res = await client.send(
          new GetMetricDataCommand({
            MetricDataQueries: batch,
            StartTime: startTime,
            EndTime: now,
          }),
        );
        for (const mdr of res.MetricDataResults ?? []) {
          if (!mdr.Id || !mdr.Values?.length) continue;
          const info = lookup.get(mdr.Id);
          if (!info) continue;
          const value = Math.round(mdr.Values[0]);
          const entry = result.get(info.vifId) ?? {};
          if (info.isAccepted) {
            entry.accepted = (entry.accepted ?? 0) + value;
          } else {
            entry.advertised = (entry.advertised ?? 0) + value;
          }
          result.set(info.vifId, entry);
        }
      }

      console.log(
        `[AWS] ${region}/BGP prefix metrics: ${streams.length} streams → ${result.size} VIFs with data`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[AWS] ${region}/BGP prefix metrics FAILED:`, msg);
    }
  });

  await Promise.all(regionFetches);
  return result;
}
