import { GetMetricDataCommand, ListMetricsCommand } from '@aws-sdk/client-cloudwatch';
import type { MetricDataQuery, Metric } from '@aws-sdk/client-cloudwatch';
import type { AwsCredentials, DxConnection, DxVirtualInterface } from '../types/aws-resources';
import { createCloudWatchClient } from './aws-client';

export type UtilizationWindowDays = 30 | 60 | 90;

// Peak hourly bitrate over the configured window from AWS-side perspective.
// "Ingress" matches the AWS/DX metric naming: data INTO AWS (customer → AWS);
// "Egress" is data OUT of AWS (AWS → customer).
export interface VifUtilization {
  ingressBpsPeak?: number;
  egressBpsPeak?: number;
}

export interface ConnectionUtilization {
  ingressBpsPeak?: number;
  egressBpsPeak?: number;
}

export interface UtilizationResult {
  vif: Map<string, VifUtilization>;
  connection: Map<string, ConnectionUtilization>;
}

const METRIC_NAMES = [
  'VirtualInterfaceBpsIngress',
  'VirtualInterfaceBpsEgress',
] as const;

// 1-hour buckets. CloudWatch retains 1-hour datapoints for ~15 months, which
// covers all supported windows. Granularity is intentionally coarse — this
// view is for capacity planning, not troubleshooting.
const PERIOD_SECONDS = 3600;

/**
 * Fetch peak hourly bitrate per VIF *and* per DX Connection from CloudWatch
 * (AWS/DX namespace) over a 30, 60, or 90 day window in a single pass.
 *
 * AWS does NOT publish a ConnectionBps* metric — the only bps metrics are at
 * the VIF level, but each stream carries BOTH `VirtualInterfaceId` and
 * `ConnectionId` dimensions. So we issue one `ListMetrics` + one
 * `GetMetricData` per region and route each datapoint into both:
 *   - per-VIF buckets keyed by VirtualInterfaceId, and
 *   - per-connection buckets keyed by ConnectionId.
 *
 * For each (key, direction, hour) bucket we sum across streams (e.g.
 * address-family splits for VIFs, or sibling VIFs for connections); the
 * reported peak is the max bucket — i.e. the worst hour observed in the
 * window.
 *
 * The connection figure is what the AWS console's "Monitoring" tab shows for
 * a DX Connection: per-VIF traffic overlaid on the port. It misses any
 * non-VIF overhead (LACP/BFD keepalives), so it's a slight underestimate of
 * true port utilization.
 */
export async function fetchUtilization(
  creds: AwsCredentials,
  vifs: DxVirtualInterface[],
  connections: DxConnection[],
  windowDays: UtilizationWindowDays,
): Promise<UtilizationResult> {
  const vifResult = new Map<string, VifUtilization>();
  const connResult = new Map<string, ConnectionUtilization>();
  if (vifs.length === 0 && connections.length === 0) return { vif: vifResult, connection: connResult };

  // Group both kinds of resource by region. A VIF's region is authoritative;
  // a connection without VIFs (rare, but possible) still needs its own region
  // even when no VIF lives there.
  const regions = new Set<string>();
  const vifIdsByRegion = new Map<string, Set<string>>();
  const connIdsByRegion = new Map<string, Set<string>>();
  for (const v of vifs) {
    const r = v.region || creds.region;
    regions.add(r);
    const s = vifIdsByRegion.get(r) ?? new Set<string>();
    s.add(v.virtualInterfaceId);
    vifIdsByRegion.set(r, s);
  }
  for (const c of connections) {
    const r = c.region || creds.region;
    regions.add(r);
    const s = connIdsByRegion.get(r) ?? new Set<string>();
    s.add(c.connectionId);
    connIdsByRegion.set(r, s);
  }

  const now = new Date();
  const startTime = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

  type DirAccum = Map<number, number>;
  type KeyAccum = { ingressByBucket: DirAccum; egressByBucket: DirAccum };

  await Promise.all([...regions].map(async (region) => {
    try {
      const client = createCloudWatchClient({ ...creds, region });
      const wantedVifs = vifIdsByRegion.get(region) ?? new Set<string>();
      const wantedConns = connIdsByRegion.get(region) ?? new Set<string>();

      // Phase 1: discover metric streams matching either dimension. A single
      // stream may match both (the typical case for owned VIFs on owned
      // connections); filter so we don't double-issue queries for it.
      const streams: Metric[] = [];
      const seenStreamKey = new Set<string>();
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
            const vifId = m.Dimensions?.find((d) => d.Name === 'VirtualInterfaceId')?.Value;
            const connId = m.Dimensions?.find((d) => d.Name === 'ConnectionId')?.Value;
            const matchesVif = vifId && wantedVifs.has(vifId);
            const matchesConn = connId && wantedConns.has(connId);
            if (!matchesVif && !matchesConn) continue;
            // Dimensions uniquely identify a stream — fingerprint them so we
            // don't add the same Metric twice if it shows up via separate
            // pages or matches both filters.
            const dimsKey = (m.Dimensions ?? [])
              .map((d) => `${d.Name}=${d.Value}`)
              .sort()
              .join('|');
            const key = `${m.MetricName}::${dimsKey}`;
            if (seenStreamKey.has(key)) continue;
            seenStreamKey.add(key);
            streams.push(m);
          }
          nextToken = lm.NextToken;
        } while (nextToken);
      }

      if (streams.length === 0) {
        console.log(`[AWS] ${region}/Utilization: no streams found (VIFs=${wantedVifs.size}, conns=${wantedConns.size})`);
        return;
      }

      const queries: MetricDataQuery[] = streams.map((m, idx) => ({
        Id: `m${idx}`,
        MetricStat: {
          Metric: { Namespace: m.Namespace, MetricName: m.MetricName, Dimensions: m.Dimensions },
          Period: PERIOD_SECONDS,
          Stat: 'Average',
        },
        ReturnData: true,
      }));

      // Each stream contributes to up to two accumulators: one keyed by VIF
      // (if VirtualInterfaceId matches a wanted VIF) and one keyed by
      // connection (if ConnectionId matches a wanted connection).
      type StreamInfo = {
        vifId?: string;
        connId?: string;
        direction: 'ingress' | 'egress';
      };
      const lookup = new Map<string, StreamInfo>();
      streams.forEach((m, idx) => {
        const vifId = m.Dimensions?.find((d) => d.Name === 'VirtualInterfaceId')?.Value;
        const connId = m.Dimensions?.find((d) => d.Name === 'ConnectionId')?.Value;
        lookup.set(`m${idx}`, {
          vifId: vifId && wantedVifs.has(vifId) ? vifId : undefined,
          connId: connId && wantedConns.has(connId) ? connId : undefined,
          direction: m.MetricName === 'VirtualInterfaceBpsIngress' ? 'ingress' : 'egress',
        });
      });

      const vifAccum = new Map<string, KeyAccum>();
      const connAccum = new Map<string, KeyAccum>();

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
          if (!mdr.Id || !mdr.Values?.length || !mdr.Timestamps?.length) continue;
          const info = lookup.get(mdr.Id);
          if (!info) continue;
          for (let j = 0; j < mdr.Values.length; j++) {
            const ts = mdr.Timestamps[j];
            const v = mdr.Values[j];
            if (ts == null || v == null) continue;
            const bucket = new Date(ts).getTime();
            if (info.vifId) {
              const a = vifAccum.get(info.vifId) ?? { ingressByBucket: new Map(), egressByBucket: new Map() };
              const target = info.direction === 'ingress' ? a.ingressByBucket : a.egressByBucket;
              target.set(bucket, (target.get(bucket) ?? 0) + v);
              vifAccum.set(info.vifId, a);
            }
            if (info.connId) {
              const a = connAccum.get(info.connId) ?? { ingressByBucket: new Map(), egressByBucket: new Map() };
              const target = info.direction === 'ingress' ? a.ingressByBucket : a.egressByBucket;
              target.set(bucket, (target.get(bucket) ?? 0) + v);
              connAccum.set(info.connId, a);
            }
          }
        }
      }

      const peakOf = (buckets: DirAccum): number | undefined => {
        if (buckets.size === 0) return undefined;
        let peak = 0;
        for (const v of buckets.values()) if (v > peak) peak = v;
        return peak;
      };

      for (const [vifId, a] of vifAccum) {
        const entry: VifUtilization = {
          ingressBpsPeak: peakOf(a.ingressByBucket),
          egressBpsPeak: peakOf(a.egressByBucket),
        };
        if (entry.ingressBpsPeak != null || entry.egressBpsPeak != null) vifResult.set(vifId, entry);
      }
      for (const [connId, a] of connAccum) {
        const entry: ConnectionUtilization = {
          ingressBpsPeak: peakOf(a.ingressByBucket),
          egressBpsPeak: peakOf(a.egressByBucket),
        };
        if (entry.ingressBpsPeak != null || entry.egressBpsPeak != null) connResult.set(connId, entry);
      }

      console.log(
        `[AWS] ${region}/Utilization (${windowDays}d peak): ${streams.length} streams → ${vifResult.size} VIFs, ${connResult.size} connections`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[AWS] ${region}/Utilization FAILED:`, msg);
    }
  }));

  return { vif: vifResult, connection: connResult };
}
