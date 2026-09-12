import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Same mocking shape as cloudwatch-dx.test.ts: this module builds its own client
// via the aws-client factory. Parameter properties are banned by this project's
// `erasableSyntaxOnly`, so these stubs assign in the body.
const sendMock = vi.fn();

vi.mock('../aws-client', () => ({
  createCloudWatchClient: () => ({ send: sendMock }),
}));

vi.mock('@aws-sdk/client-cloudwatch', () => {
  class ListMetricsCommand {
    input: { Namespace?: string; MetricName?: string; NextToken?: string };
    constructor(input: { Namespace?: string; MetricName?: string; NextToken?: string }) {
      this.input = input;
    }
  }
  class GetMetricDataCommand {
    input: { MetricDataQueries?: unknown[] };
    constructor(input: { MetricDataQueries?: unknown[] }) {
      this.input = input;
    }
  }
  return { ListMetricsCommand, GetMetricDataCommand };
});

const { ListMetricsCommand, GetMetricDataCommand } = await import('@aws-sdk/client-cloudwatch');
const { fetchUtilization } = await import('../cloudwatch-utilization');

const CREDS = { accessKeyId: 'a', secretAccessKey: 'b', sessionToken: 'c', region: 'ap-southeast-1' };

// Mirrors the module-local constant. METRIC_NAMES has two entries, so a
// per-metric cap would allow 1000 calls per region.
const MAX_LIST_METRICS_PAGES = 500;

const VIFS = [{ virtualInterfaceId: 'dxvif-1', region: 'ap-southeast-1' }] as any[];

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

describe('fetchUtilization ListMetrics paging', () => {
  // The ListMetrics paginator is nested in `for (const metricName of
  // METRIC_NAMES)`, so the page budget is shared across the whole loop rather
  // than reset per metric name.
  it('bounds total ListMetrics calls by ONE shared budget across METRIC_NAMES', async () => {
    sendMock.mockImplementation((cmd: unknown) =>
      cmd instanceof ListMetricsCommand
        ? Promise.resolve({ Metrics: [], NextToken: 'again' })
        : Promise.resolve({ MetricDataResults: [] }),
    );

    const out = await fetchUtilization(CREDS, VIFS, [], 30);

    expect(listMetricsCalls()).toHaveLength(MAX_LIST_METRICS_PAGES);
    expect(sendMock.mock.calls.some(([cmd]) => cmd instanceof GetMetricDataCommand)).toBe(false);
    expect(out.vif.size).toBe(0);
    expect(out.connection.size).toBe(0);
  });

  it('still follows NextToken normally and de-duplicates streams across pages', async () => {
    const ingress = {
      Namespace: 'AWS/DX',
      MetricName: 'VirtualInterfaceBpsIngress',
      Dimensions: [{ Name: 'VirtualInterfaceId', Value: 'dxvif-1' }],
    };
    sendMock.mockImplementation((cmd: { input?: { MetricName?: string; NextToken?: string } }) => {
      if (cmd instanceof ListMetricsCommand) {
        if (cmd.input.MetricName === 'VirtualInterfaceBpsIngress') {
          // The same stream comes back on both pages — it must be counted once.
          return cmd.input.NextToken
            ? Promise.resolve({ Metrics: [ingress] })
            : Promise.resolve({ Metrics: [ingress], NextToken: 'p2' });
        }
        return Promise.resolve({ Metrics: [] });
      }
      return Promise.resolve({
        MetricDataResults: [
          { Id: 'm0', Values: [100, 250], Timestamps: [new Date(1), new Date(2)] },
        ],
      });
    });

    const out = await fetchUtilization(CREDS, VIFS, [], 30);

    // 2 pages for ingress + 1 for egress.
    expect(listMetricsCalls()).toHaveLength(3);
    const query = sendMock.mock.calls.find(([cmd]) => cmd instanceof GetMetricDataCommand)?.[0];
    expect(query.input.MetricDataQueries).toHaveLength(1);
    expect(out.vif.get('dxvif-1')?.ingressBpsPeak).toBe(250);
  });
});
