import { GetMetricDataCommand, ListMetricsCommand } from '@aws-sdk/client-cloudwatch';
import type { MetricDataQuery, Metric } from '@aws-sdk/client-cloudwatch';
import type {
  AwsCredentials,
  BgpPrefixMetrics,
  BgpSessionStability,
  DxVirtualInterface,
} from '../types/aws-resources';
import { createCloudWatchClient } from './aws-client';

// Re-exported for existing importers; the shapes live in types/aws-resources.ts
// so types/topology.ts can reference them without importing from api/.
export type { BgpPrefixMetrics, BgpSessionStability };

const METRIC_NAMES = [
  'VirtualInterfaceBgpPrefixesAccepted',
  'VirtualInterfaceBgpPrefixesAdvertised',
] as const;

/**
 * Fetch BGP prefix metrics (Accepted & Advertised) for all VIFs via CloudWatch.
 *
 * AWS/DX publishes these metrics with VirtualInterfaceId plus an `IpAddressFamily`
 * dimension (valid values `ipv4`/`ipv6`) — documented on exactly the three BGP
 * metrics. We discover the real dimensions with ListMetrics so queries match the
 * actual streams, then keep BOTH views: the pooled total for display, and the
 * per-family split, because the quota is 100 *each* for IPv4 and IPv6.
 * Pooling them mis-scores dual-stack VIFs in both directions — 60 v4 + 60 v6
 * looks critical when it is healthy, and 95 v4 + 3 v6 looks fine when v4 is
 * nearly at teardown.
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

      const lookup = new Map<
        string,
        { vifId: string; isAccepted: boolean; family?: 'ipv4' | 'ipv6' }
      >();
      streams.forEach((m, idx) => {
        const vifId = m.Dimensions?.find((d) => d.Name === 'VirtualInterfaceId')?.Value;
        if (vifId) {
          // Case-insensitive: the dimension documents lowercase ipv4/ipv6, but
          // an unexpected casing should degrade to "family unknown" (pooled
          // only) rather than silently drop the datapoint.
          const raw = m.Dimensions?.find((d) => d.Name === 'IpAddressFamily')?.Value?.toLowerCase();
          lookup.set(`m${idx}`, {
            vifId,
            isAccepted: m.MetricName === 'VirtualInterfaceBgpPrefixesAccepted',
            family: raw === 'ipv4' || raw === 'ipv6' ? raw : undefined,
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
          if (info.family) {
            const byFamily = entry.byFamily ?? {};
            const fam = byFamily[info.family] ?? {};
            if (info.isAccepted) {
              fam.accepted = (fam.accepted ?? 0) + value;
            } else {
              fam.advertised = (fam.advertised ?? 0) + value;
            }
            byFamily[info.family] = fam;
            entry.byFamily = byFamily;
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

/** How many days of BGP session history to sample. */
export type BgpStabilityWindowDays = 7 | 30 | 63;

const BGP_STATUS_METRIC = 'VirtualInterfaceBgpStatus';

/**
 * Fetch BGP session stability (flap history) per VIF from the AWS/DX
 * `VirtualInterfaceBgpStatus` metric, where 1 = up and 0 = down.
 *
 * Why this exists: DescribeVirtualInterfaces only reports the BGP state *right
 * now*, so a VIF that flapped 11 times last week is indistinguishable from one
 * that has been solid for a year. Both read "up".
 *
 * Statistic is `Minimum`, not `Average`: a session that dropped for 90 seconds
 * inside a 5-minute period averages to ~0.7 and rounds away, but its minimum is
 * 0. We count a period as down when the minimum dips below 1, and count a flap
 * on each up→down edge.
 *
 * Retention bounds the answer, so callers must not claim more than they sampled:
 * 5-minute data is kept 63 days, 1-hour data 455 days. A 7-day window uses
 * 5-minute resolution to catch brief drops; longer windows fall back to 1 hour,
 * which can hide a flap that healed inside the same hour.
 *
 * Billed per metric retrieved (GetMetricData), so this is on-demand only —
 * never part of the login fetch.
 */
export async function fetchBgpSessionStability(
  creds: AwsCredentials,
  vifs: DxVirtualInterface[],
  windowDays: BgpStabilityWindowDays = 7,
): Promise<Map<string, BgpSessionStability>> {
  const result = new Map<string, BgpSessionStability>();
  if (vifs.length === 0) return result;

  // 5-minute resolution only survives 63 days; past that CloudWatch has already
  // rolled the data up to 1 hour, so asking for 300 returns nothing.
  const periodSeconds = windowDays <= 7 ? 300 : 3600;

  const byRegion = new Map<string, DxVirtualInterface[]>();
  for (const vif of vifs) {
    const region = vif.region || creds.region;
    const list = byRegion.get(region) ?? [];
    list.push(vif);
    byRegion.set(region, list);
  }

  const now = new Date();
  const startTime = new Date(now.getTime() - windowDays * 86_400_000);

  const regionFetches = [...byRegion.entries()].map(async ([region, regionVifs]) => {
    try {
      const client = createCloudWatchClient({ ...creds, region });
      const vifIds = new Set(regionVifs.map((v) => v.virtualInterfaceId));

      // Discover the real streams: the IpAddressFamily dimension means one VIF
      // can publish more than one series, and querying a dimension set that was
      // never published returns empty.
      const streams: Metric[] = [];
      let nextToken: string | undefined;
      do {
        const lm = await client.send(
          new ListMetricsCommand({
            Namespace: 'AWS/DX',
            MetricName: BGP_STATUS_METRIC,
            NextToken: nextToken,
          }),
        );
        for (const m of lm.Metrics ?? []) {
          const vifDim = m.Dimensions?.find((d) => d.Name === 'VirtualInterfaceId');
          if (vifDim?.Value && vifIds.has(vifDim.Value)) streams.push(m);
        }
        nextToken = lm.NextToken;
      } while (nextToken);

      if (streams.length === 0) {
        console.log(`[AWS] ${region}/BGP stability: no streams found for ${vifIds.size} VIFs`);
        return;
      }

      const queries: MetricDataQuery[] = streams.map((m, idx) => ({
        Id: `s${idx}`,
        MetricStat: {
          Metric: { Namespace: m.Namespace, MetricName: m.MetricName, Dimensions: m.Dimensions },
          Period: periodSeconds,
          // Minimum, so a sub-period drop is not averaged away.
          Stat: 'Minimum',
        },
        ReturnData: true,
      }));

      const lookup = new Map<string, { vifId: string; family?: 'ipv4' | 'ipv6' }>();
      streams.forEach((m, idx) => {
        const vifId = m.Dimensions?.find((d) => d.Name === 'VirtualInterfaceId')?.Value;
        if (vifId) {
          const raw = m.Dimensions?.find((d) => d.Name === 'IpAddressFamily')?.Value?.toLowerCase();
          lookup.set(`s${idx}`, {
            vifId,
            family: raw === 'ipv4' || raw === 'ipv6' ? raw : undefined,
          });
        }
      });

      const BATCH_SIZE = 500;
      for (let i = 0; i < queries.length; i += BATCH_SIZE) {
        const batch = queries.slice(i, i + BATCH_SIZE);
        // GetMetricData returns newest-first by default; ascending order lets us
        // read up→down transitions in real time order.
        const res = await client.send(
          new GetMetricDataCommand({
            MetricDataQueries: batch,
            StartTime: startTime,
            EndTime: now,
            ScanBy: 'TimestampAscending',
          }),
        );
        for (const mdr of res.MetricDataResults ?? []) {
          if (!mdr.Id || !mdr.Values?.length) continue;
          const info = lookup.get(mdr.Id);
          if (!info) continue;

          let flapCount = 0;
          let downPeriods = 0;
          let lastFlapAt: string | undefined;
          let prevUp: boolean | undefined;
          mdr.Values.forEach((v, i) => {
            const isUp = v >= 1;
            if (!isUp) downPeriods++;
            // Count the edge, not the duration: one long outage is one flap.
            if (prevUp === true && !isUp) {
              flapCount++;
              const ts = mdr.Timestamps?.[i];
              if (ts) lastFlapAt = ts.toISOString();
            }
            prevUp = isUp;
          });

          const entry = result.get(info.vifId) ?? {
            flapCount: 0,
            downPeriods: 0,
            totalPeriods: 0,
            windowDays,
          };
          // A VIF with both families publishes two series; the VIF-level figure
          // is the worst case across them, since either family dropping is a
          // real event on that session.
          entry.flapCount = Math.max(entry.flapCount, flapCount);
          entry.downPeriods = Math.max(entry.downPeriods, downPeriods);
          entry.totalPeriods = Math.max(entry.totalPeriods, mdr.Values.length);
          if (lastFlapAt && (!entry.lastFlapAt || lastFlapAt > entry.lastFlapAt)) {
            entry.lastFlapAt = lastFlapAt;
          }
          if (info.family) {
            const byFamily = entry.byFamily ?? {};
            byFamily[info.family] = { flapCount, downPeriods };
            entry.byFamily = byFamily;
          }
          result.set(info.vifId, entry);
        }
      }

      const flapping = [...result.values()].filter((s) => s.flapCount > 0).length;
      console.log(
        `[AWS] ${region}/BGP stability (${windowDays}d @ ${periodSeconds}s): ${streams.length} streams → ${result.size} VIFs, ${flapping} with flaps`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[AWS] ${region}/BGP stability FAILED:`, msg);
    }
  });

  await Promise.all(regionFetches);
  return result;
}
