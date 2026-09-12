import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// cloudwatch-dx.ts builds its own client through the aws-client factory, so the
// factory has to be mocked as well as the command classes. Parameter properties
// are banned by this project's `erasableSyntaxOnly`, so these stubs assign in
// the body.
const sendMock = vi.fn();

vi.mock('../aws-client', () => ({
  createCloudWatchClient: () => ({ send: sendMock }),
}));

vi.mock('@aws-sdk/client-cloudwatch', () => {
  class ListMetricsCommand {
    input: Record<string, unknown>;
    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  }

  class GetMetricDataCommand {
    input: {
      MetricDataQueries?: Array<{
        Id?: string;
        MetricStat?: { Metric?: { Dimensions?: Array<{ Name?: string; Value?: string }> } };
      }>;
    };
    constructor(input: GetMetricDataCommand['input']) {
      this.input = input;
    }
  }

  return { GetMetricDataCommand, ListMetricsCommand };
});

const { GetMetricDataCommand, ListMetricsCommand } =
  await import('@aws-sdk/client-cloudwatch');
const { fetchBgpSessionStability, fetchBgpPrefixMetrics } = await import('../cloudwatch-dx');

const REGION = 'ap-southeast-1';

const CREDS = {
  accessKeyId: 'a',
  secretAccessKey: 'b',
  sessionToken: 'c',
  region: REGION,
};

// Mirrors the module-local constants under test. METRIC_NAMES has two entries,
// so a *per-metric* cap would allow 2 x 500 = 1000 calls per region.
const MAX_LIST_METRICS_PAGES = 500;
const METRIC_NAME_COUNT = 2;

const VIF = {
  virtualInterfaceId: 'dxvif-ipv4',
  virtualInterfaceName: 'ipv4-vif',
  virtualInterfaceType: 'transit' as const,
  virtualInterfaceState: 'available',
  connectionId: 'dxcon-1',
  vlan: 101,
  asn: 64512,
  addressFamily: 'ipv4' as const,
  bgpPeers: [],
  region: REGION,
};

function dimensions(family: 'IPv4' | 'IPv6') {
  return [
    { Name: 'VirtualInterfaceId', Value: VIF.virtualInterfaceId },
    { Name: 'ConnectionId', Value: VIF.connectionId },
    { Name: 'IpAddressFamily', Value: family },
  ];
}

// A discovered stream for the paging tests. `IpAddressFamily` is not optional
// here: fetchBgpSessionStability only accepts the stream whose family matches
// the VIF's configured one, so a stream without the dimension is discarded and
// the paging assertions would pass for the wrong reason.
function stream(metricName: string, family: 'IPv4' | 'IPv6' = 'IPv4') {
  return {
    Namespace: 'AWS/DX',
    MetricName: metricName,
    Dimensions: dimensions(family),
  };
}

function listMetricsCalls() {
  return sendMock.mock.calls.filter(([cmd]) => cmd instanceof ListMetricsCommand);
}

beforeEach(() => {
  sendMock.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchBgpSessionStability', () => {
  it('queries only the VIF configured address family', async () => {
    sendMock.mockImplementation((command: unknown) => {
      if (command instanceof ListMetricsCommand) {
        return Promise.resolve({
          Metrics: [
            {
              Namespace: 'AWS/DX',
              MetricName: 'VirtualInterfaceBgpStatus',
              Dimensions: dimensions('IPv6'),
            },
            {
              Namespace: 'AWS/DX',
              MetricName: 'VirtualInterfaceBgpStatus',
              Dimensions: dimensions('IPv4'),
            },
          ],
        });
      }
      if (command instanceof GetMetricDataCommand) {
        return Promise.resolve({
          MetricDataResults: [{
            Id: 's0',
            Values: [1, 0, 1],
            Timestamps: [
              new Date('2026-09-01T00:00:00Z'),
              new Date('2026-09-01T01:00:00Z'),
              new Date('2026-09-01T02:00:00Z'),
            ],
          }],
        });
      }
      return Promise.resolve({});
    });

    const result = await fetchBgpSessionStability(CREDS, [VIF], 30);

    const getCall = sendMock.mock.calls
      .map(([command]) => command)
      .find((command) => command instanceof GetMetricDataCommand);
    const queries = getCall?.input.MetricDataQueries ?? [];
    expect(queries).toHaveLength(1);
    expect(
      queries[0].MetricStat?.Metric?.Dimensions?.find(
        (dimension) => dimension.Name === 'IpAddressFamily',
      )?.Value,
    ).toBe('IPv4');
    expect(result.get(VIF.virtualInterfaceId)).toMatchObject({
      flapCount: 1,
      downPeriods: 1,
      totalPeriods: 3,
      byFamily: { ipv4: { flapCount: 1, downPeriods: 1 } },
    });
  });

  it('does not assess BGP history when the configured family is unavailable', async () => {
    sendMock.mockResolvedValue({
      Metrics: [{
        Namespace: 'AWS/DX',
        MetricName: 'VirtualInterfaceBgpStatus',
        Dimensions: dimensions('IPv6'),
      }],
    });

    const result = await fetchBgpSessionStability(
      CREDS,
      [{ ...VIF, addressFamily: undefined }],
      30,
    );

    expect(result.size).toBe(0);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0]).toBeInstanceOf(ListMetricsCommand);
  });
});

describe('fetchBgpPrefixMetrics', () => {
  // One stream per (metric, family) pair, mirroring what ListMetrics returns.
  function prefixStreams(families: Array<'IPv4' | 'IPv6'>) {
    return families.flatMap((family) => [
      {
        Namespace: 'AWS/DX',
        MetricName: 'VirtualInterfaceBgpPrefixesAccepted',
        Dimensions: dimensions(family),
      },
      {
        Namespace: 'AWS/DX',
        MetricName: 'VirtualInterfaceBgpPrefixesAdvertised',
        Dimensions: dimensions(family),
      },
    ]);
  }

  // `valuesById` is keyed by the query id the fetcher assigns in stream order —
  // and discovery runs one ListMetrics per metric NAME, so every Accepted stream
  // is numbered before the first Advertised one (m0/m1 = accepted v4/v6).
  function mockPrefixes(
    streams: ReturnType<typeof prefixStreams>,
    valuesById: Record<string, number[]>,
  ) {
    sendMock.mockImplementation((command: unknown) => {
      if (command instanceof ListMetricsCommand) {
        // ListMetrics is called once per metric name; answer with the matching subset.
        const name = (command.input as { MetricName?: string }).MetricName;
        return Promise.resolve({ Metrics: streams.filter((s) => s.MetricName === name) });
      }
      if (command instanceof GetMetricDataCommand) {
        const ids = (command.input.MetricDataQueries ?? []).map((q) => q.Id);
        return Promise.resolve({
          MetricDataResults: ids
            .filter((id): id is string => !!id && !!valuesById[id])
            .map((id) => ({ Id: id, Values: valuesById[id] })),
        });
      }
      return Promise.resolve({});
    });
  }

  it('queries Maximum, not Average — a fractional mean is a prefix count that never existed', async () => {
    const streams = prefixStreams(['IPv4']);
    mockPrefixes(streams, { m0: [18], m1: [1] });

    await fetchBgpPrefixMetrics(CREDS, [VIF]);

    const getCall = sendMock.mock.calls
      .map(([command]) => command)
      .find((command) => command instanceof GetMetricDataCommand);
    for (const q of getCall?.input.MetricDataQueries ?? []) {
      expect((q.MetricStat as { Stat?: string }).Stat).toBe('Maximum');
    }
  });

  it('folds the whole window into a peak, a floor, and a sample count', async () => {
    const streams = prefixStreams(['IPv4']);
    // TimestampDescending: Values[0] is merely the newest reading, so reading it
    // alone would report 19 with no evidence the count ever moved.
    mockPrefixes(streams, { m0: [19, 27, 21, 19], m1: [1, 1, 1, 1] });

    const result = await fetchBgpPrefixMetrics(CREDS, [VIF]);

    expect(result.get(VIF.virtualInterfaceId)).toMatchObject({
      accepted: 27,
      acceptedFloor: 19,
      samples: 4,
      advertised: 1,
    });
  });

  it('keeps both the pooled total and the per-family split', async () => {
    const streams = prefixStreams(['IPv4', 'IPv6']);
    mockPrefixes(streams, { m0: [60], m1: [55], m2: [2], m3: [2] });

    const result = await fetchBgpPrefixMetrics(CREDS, [VIF]);

    // 60 v4 + 55 v6 is healthy per family and would read as critical if pooled
    // against a single 100 — the split is what prevents that.
    expect(result.get(VIF.virtualInterfaceId)).toMatchObject({
      accepted: 115,
      byFamily: { ipv4: { accepted: 60 }, ipv6: { accepted: 55 } },
    });
  });

  it('rounds each datapoint before folding, so counts stay integral', async () => {
    const streams = prefixStreams(['IPv4']);
    mockPrefixes(streams, { m0: [17.5, 11.4] });

    const result = await fetchBgpPrefixMetrics(CREDS, [VIF]);

    expect(result.get(VIF.virtualInterfaceId)).toMatchObject({ accepted: 18, acceptedFloor: 11 });
  });

  it('returns nothing when no stream exists for the VIF', async () => {
    sendMock.mockResolvedValue({ Metrics: [] });

    const result = await fetchBgpPrefixMetrics(CREDS, [VIF]);

    expect(result.size).toBe(0);
    // ListMetrics for each of the two metric names, then no GetMetricData.
    expect(sendMock.mock.calls.every(([c]) => c instanceof ListMetricsCommand)).toBe(true);
  });
});

describe('fetchBgpPrefixMetrics ListMetrics paging', () => {
  it('follows NextToken and collects streams for every metric name', async () => {
    sendMock.mockImplementation((cmd: { input: { MetricName?: string; NextToken?: string } }) => {
      if (cmd instanceof ListMetricsCommand) {
        if (cmd.input.MetricName === 'VirtualInterfaceBgpPrefixesAccepted') {
          return cmd.input.NextToken
            ? Promise.resolve({ Metrics: [stream('VirtualInterfaceBgpPrefixesAccepted')] })
            : Promise.resolve({ Metrics: [], NextToken: 'p2' });
        }
        return Promise.resolve({ Metrics: [stream('VirtualInterfaceBgpPrefixesAdvertised')] });
      }
      return Promise.resolve({
        MetricDataResults: [
          { Id: 'm0', Values: [7] },
          { Id: 'm1', Values: [9] },
        ],
      });
    });

    const out = await fetchBgpPrefixMetrics(CREDS, [VIF]);

    // 2 pages for the first metric name + 1 for the second.
    expect(listMetricsCalls()).toHaveLength(3);
    expect(out.get(VIF.virtualInterfaceId)).toMatchObject({ accepted: 7, advertised: 9 });
  });

  // THE trap this finding is about for CloudWatch: the paginator sits inside a
  // `for (const metricName of METRIC_NAMES)` loop, so a cap applied per `do`
  // block would still permit METRIC_NAMES.length x cap calls per region. The
  // budget is shared across the whole loop instead — this asserts the total, not
  // the per-metric count.
  it('bounds total ListMetrics calls by ONE shared budget, not one per metric name', async () => {
    sendMock.mockImplementation((cmd: unknown) => {
      if (cmd instanceof ListMetricsCommand) {
        // Never clears the token — a misbehaving endpoint.
        return Promise.resolve({ Metrics: [], NextToken: 'again' });
      }
      return Promise.resolve({ MetricDataResults: [] });
    });

    const out = await fetchBgpPrefixMetrics(CREDS, [VIF]);

    expect(listMetricsCalls()).toHaveLength(MAX_LIST_METRICS_PAGES);
    expect(listMetricsCalls().length).toBeLessThan(MAX_LIST_METRICS_PAGES * METRIC_NAME_COUNT);
    // Phase 2 never runs: the cap breach aborts the region.
    expect(sendMock.mock.calls.some(([cmd]) => cmd instanceof GetMetricDataCommand)).toBe(false);
    expect(out.size).toBe(0);
  });

  // Sharper version of the above: the first metric name legitimately drains most
  // of the budget and CLEARS its token, so it never trips the cap itself. Only a
  // genuinely shared budget stops the second metric name from starting over at
  // 500 — a per-metric cap would total 300 + 500 = 800 calls here.
  it('carries the remaining budget over to the next metric name', async () => {
    const FIRST_METRIC_PAGES = 300;
    let firstMetricCalls = 0;
    sendMock.mockImplementation((cmd: { input?: { MetricName?: string } }) => {
      if (cmd instanceof ListMetricsCommand) {
        if (cmd.input.MetricName === 'VirtualInterfaceBgpPrefixesAccepted') {
          firstMetricCalls++;
          return Promise.resolve({
            Metrics: [],
            NextToken: firstMetricCalls < FIRST_METRIC_PAGES ? 'more' : undefined,
          });
        }
        return Promise.resolve({ Metrics: [], NextToken: 'again' });
      }
      return Promise.resolve({ MetricDataResults: [] });
    });

    await fetchBgpPrefixMetrics(CREDS, [VIF]);

    expect(firstMetricCalls).toBe(FIRST_METRIC_PAGES);
    expect(listMetricsCalls()).toHaveLength(MAX_LIST_METRICS_PAGES);
  });

  it('surfaces the cap breach as a region-level warning rather than hanging', async () => {
    const warn = vi.spyOn(console, 'warn');
    sendMock.mockImplementation((cmd: unknown) =>
      cmd instanceof ListMetricsCommand
        ? Promise.resolve({ Metrics: [], NextToken: 'again' })
        : Promise.resolve({ MetricDataResults: [] }),
    );

    await fetchBgpPrefixMetrics(CREDS, [VIF]);

    expect(
      warn.mock.calls.some(([msg]) =>
        String(msg).includes(`${REGION}/BGP prefix metrics FAILED`),
      ),
    ).toBe(true);
  });
});

// fetchBgpSessionStability was added after the first bounded-paginator sweep, so
// its ListMetrics loop had reintroduced the unbounded shape. Unlike the prefix
// metrics it queries ONE metric name, so a plain per-drain cap is the right
// bound here — but it still needs one, and the breach has to abort the region
// rather than fall through to a billed GetMetricData on an empty stream list.
describe('fetchBgpSessionStability ListMetrics paging', () => {
  it('follows NextToken and reads flaps as up→down edges', async () => {
    sendMock.mockImplementation((cmd: { input: { NextToken?: string } }) => {
      if (cmd instanceof ListMetricsCommand) {
        return cmd.input.NextToken
          ? Promise.resolve({ Metrics: [stream('VirtualInterfaceBgpStatus')] })
          : Promise.resolve({ Metrics: [], NextToken: 'p2' });
      }
      // One long outage in the middle: two up→down edges would be wrong.
      return Promise.resolve({ MetricDataResults: [{ Id: 's0', Values: [1, 1, 0, 0, 1] }] });
    });

    const out = await fetchBgpSessionStability(CREDS, [VIF]);

    expect(listMetricsCalls()).toHaveLength(2);
    expect(out.get(VIF.virtualInterfaceId)?.flapCount).toBe(1);
    expect(out.get(VIF.virtualInterfaceId)?.downPeriods).toBe(2);
  });

  it('stops at the page cap and never reaches the billed GetMetricData call', async () => {
    sendMock.mockImplementation((cmd: unknown) =>
      cmd instanceof ListMetricsCommand
        ? Promise.resolve({ Metrics: [], NextToken: 'again' })
        : Promise.resolve({ MetricDataResults: [] }),
    );

    const out = await fetchBgpSessionStability(CREDS, [VIF]);

    expect(listMetricsCalls()).toHaveLength(MAX_LIST_METRICS_PAGES);
    expect(sendMock.mock.calls.some(([cmd]) => cmd instanceof GetMetricDataCommand)).toBe(false);
    expect(out.size).toBe(0);
  });

  it('surfaces the cap breach as a region-level warning rather than hanging', async () => {
    const warn = vi.spyOn(console, 'warn');
    sendMock.mockImplementation((cmd: unknown) =>
      cmd instanceof ListMetricsCommand
        ? Promise.resolve({ Metrics: [], NextToken: 'again' })
        : Promise.resolve({ MetricDataResults: [] }),
    );

    await fetchBgpSessionStability(CREDS, [VIF]);

    expect(
      warn.mock.calls.some(([msg]) => String(msg).includes(`${REGION}/BGP stability FAILED`)),
    ).toBe(true);
  });
});
