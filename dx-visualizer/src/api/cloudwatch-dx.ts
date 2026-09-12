import { GetMetricDataCommand, ListMetricsCommand } from '@aws-sdk/client-cloudwatch';
import type { MetricDataQuery, Metric } from '@aws-sdk/client-cloudwatch';
import type {
  AwsCredentials,
  BgpPrefixMetrics,
  BgpSessionStability,
  DxVirtualInterface,
} from '../types/aws-resources';
import { createCloudWatchClient } from './aws-client';
import { drainPages } from './paginate';

// Re-exported for existing importers; the shapes live in types/aws-resources.ts
// so types/topology.ts can reference them without importing from api/.
export type { BgpPrefixMetrics, BgpSessionStability };

const METRIC_NAMES = [
  'VirtualInterfaceBgpPrefixesAccepted',
  'VirtualInterfaceBgpPrefixesAdvertised',
] as const;

/** One metric stream folded over the whole query window. */
type Fold = { peak: number; floor: number; samples: number };

/**
 * Folds keyed by address family. `pooled` is the fallback bucket for a stream
 * that carries no `IpAddressFamily` dimension — older accounts, and any casing
 * we did not recognise, land there rather than being dropped.
 */
type FamilyFolds = Partial<Record<'ipv4' | 'ipv6' | 'pooled', Fold>>;

/**
 * Collapse the per-family folds into the single figure the UI displays.
 *
 * Families are SUMMED, because this total answers "how many prefixes does the VIF
 * carry" while the *quota* is graded per family from `byFamily`. The grading path
 * never reads this number, so summing here cannot reintroduce the dual-stack
 * mis-scoring the split exists to prevent.
 *
 * Explicit families win over `pooled` rather than adding to it: AWS publishes a
 * stream either with the dimension or without it, so counting both would double
 * every prefix on an account that reports the dimension inconsistently.
 *
 * `samples` is the max across families, not the sum. It is the number of
 * datapoints in the window, and both families are sampled over the same window,
 * so adding them would report a four-point window as eight and let the churn rule
 * believe it had twice the evidence it has.
 */
function reconcile(folds: FamilyFolds): Fold | undefined {
  const families = (['ipv4', 'ipv6'] as const)
    .map((f) => folds[f])
    .filter((f): f is Fold => !!f);
  if (families.length === 0) return folds.pooled;
  return {
    peak: families.reduce((n, f) => n + f.peak, 0),
    floor: families.reduce((n, f) => n + f.floor, 0),
    samples: families.reduce((n, f) => Math.max(n, f.samples), 0),
  };
}

/**
 * Total ListMetrics pages allowed per region, deliberately SHARED across every
 * entry in METRIC_NAMES rather than applied per metric name — a per-metric cap
 * would still let a misbehaving endpoint drive METRIC_NAMES.length × cap calls.
 * ListMetrics returns 500 metrics per page, so 500 pages covers 250k AWS/DX
 * streams in one region.
 */
const MAX_LIST_METRICS_PAGES = 500;

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
      // One page budget for the WHOLE loop, not one per metric name: each
      // drain is capped at whatever is left, and each page it fetches
      // decrements the shared counter. So the total ListMetrics calls for this
      // region can never exceed MAX_LIST_METRICS_PAGES however many metric
      // names are listed.
      let pageBudget = MAX_LIST_METRICS_PAGES;
      for (const metricName of METRIC_NAMES) {
        if (pageBudget <= 0) {
          throw new Error(
            `stopped paging ListMetrics for ${region} at the ${MAX_LIST_METRICS_PAGES}-page safety cap`,
          );
        }
        const found = await drainPages<Metric>(
          `ListMetrics ${metricName} in ${region}`,
          async (nextToken) => {
            pageBudget--;
            const lm = await client.send(
              new ListMetricsCommand({
                Namespace: 'AWS/DX',
                MetricName: metricName,
                NextToken: nextToken,
              }),
            );
            const items = (lm.Metrics ?? []).filter((m) => {
              const vifDim = m.Dimensions?.find((d) => d.Name === 'VirtualInterfaceId');
              return !!vifDim?.Value && vifIds.has(vifDim.Value);
            });
            return { items, nextToken: lm.NextToken };
          },
          { maxPages: pageBudget },
        );
        streams.push(...found);
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
          // Maximum, not Average. Two reasons, both seen on a real account:
          //  - The question is quota headroom, and a peak that touched the
          //    ceiling tears the session down whether or not the five-minute
          //    mean stayed comfortable. Average understates exactly the case the
          //    rule exists to catch.
          //  - Average returns fractions (17.5, 11.66) that round to a prefix
          //    count which never actually existed, and a fabricated 18 beside a
          //    sibling's real 20 reads as a route asymmetry that isn't there.
          Stat: 'Maximum',
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

      // Accumulated across GetMetricData batches, then reconciled per VIF below.
      const acc = new Map<string, { accepted: FamilyFolds; advertised: FamilyFolds }>();

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
          // Fold the WHOLE window, not Values[0]. GetMetricData defaults to
          // TimestampDescending, so Values[0] is merely the newest reading; the
          // other datapoints are the only evidence of whether the count is
          // steady, and reading one of six discarded it.
          const values = mdr.Values.map((v) => Math.round(v));
          const entry = acc.get(info.vifId) ?? { accepted: {}, advertised: {} };
          const view = info.isAccepted ? entry.accepted : entry.advertised;
          view[info.family ?? 'pooled'] = {
            peak: Math.max(...values),
            floor: Math.min(...values),
            samples: values.length,
          };
          acc.set(info.vifId, entry);
        }
      }

      for (const [vifId, entry] of acc) {
        const accepted = reconcile(entry.accepted);
        const advertised = reconcile(entry.advertised);
        if (!accepted && !advertised) continue;
        const metrics: BgpPrefixMetrics = {};
        if (accepted) {
          metrics.accepted = accepted.peak;
          metrics.acceptedFloor = accepted.floor;
          metrics.samples = accepted.samples;
        }
        if (advertised) metrics.advertised = advertised.peak;
        const byFamily: NonNullable<BgpPrefixMetrics['byFamily']> = {};
        for (const family of ['ipv4', 'ipv6'] as const) {
          const a = entry.accepted[family];
          const d = entry.advertised[family];
          if (!a && !d) continue;
          byFamily[family] = {
            ...(a ? { accepted: a.peak } : {}),
            ...(d ? { advertised: d.peak } : {}),
          };
        }
        if (Object.keys(byFamily).length > 0) metrics.byFamily = byFamily;
        result.set(vifId, metrics);
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

function normalizeAddressFamily(value: string | undefined): 'ipv4' | 'ipv6' | undefined {
  const normalized = value?.toLowerCase();
  return normalized === 'ipv4' || normalized === 'ipv6' ? normalized : undefined;
}

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
      const vifById = new Map(regionVifs.map((v) => [v.virtualInterfaceId, v]));

      // Discover the real streams: the IpAddressFamily dimension means one VIF
      // can publish more than one series, and querying a dimension set that was
      // never published returns empty. AWS can also publish an all-zero series
      // for the family the VIF is not configured to use, so only that VIF's
      // configured family is session-state evidence.
      const streams = await drainPages<Metric>(
        `ListMetrics ${BGP_STATUS_METRIC} in ${region}`,
        async (nextToken) => {
          const lm = await client.send(
            new ListMetricsCommand({
              Namespace: 'AWS/DX',
              MetricName: BGP_STATUS_METRIC,
              NextToken: nextToken,
            }),
          );
          const items = (lm.Metrics ?? []).filter((m) => {
            const vifDim = m.Dimensions?.find((d) => d.Name === 'VirtualInterfaceId');
            if (!vifDim?.Value || !vifIds.has(vifDim.Value)) return false;

            const configuredFamily = normalizeAddressFamily(
              vifById.get(vifDim.Value)?.addressFamily,
            );
            const streamFamily = normalizeAddressFamily(
              m.Dimensions?.find((d) => d.Name === 'IpAddressFamily')?.Value,
            );
            return !!configuredFamily && streamFamily === configuredFamily;
          });
          return { items, nextToken: lm.NextToken };
        },
        { maxPages: MAX_LIST_METRICS_PAGES },
      );

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
          // Retain the worst result if AWS publishes multiple matching streams
          // for a VIF rather than depending on response order.
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
