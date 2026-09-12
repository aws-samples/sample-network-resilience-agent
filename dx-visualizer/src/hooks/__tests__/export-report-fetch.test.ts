// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useExportReport } from '../useExportReport';
import { useTopologyStore } from '../../store/topology-store';
import { getMockTopology } from '../../utils/mock-data';
import type { TopologyData } from '../../types/topology';
import type { AwsCredentials } from '../../types/aws-resources';

const CREDS = {
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'secret',
  region: 'ap-southeast-1',
} as AwsCredentials;

/** The report is downloaded as a Blob — intercept the object URL to read it back. */
function captureDownload() {
  const blobs: Blob[] = [];
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob: Blob | MediaSource) => {
    blobs.push(blob as Blob);
    return 'blob:mock';
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  return async () => {
    expect(blobs).toHaveLength(1);
    return blobs[0].text();
  };
}

/** A live session whose topology carries neither routes nor CloudWatch metrics. */
function seedLiveWithoutOnDemandData(): TopologyData {
  const full = getMockTopology('maximum');
  const bare: TopologyData = { ...full };
  delete bare.vifRoutes;
  delete bare.vifUtilization;
  delete bare.connectionUtilization;
  delete bare.utilizationWindowDays;
  useTopologyStore.setState({
    topologyData: bare,
    credentials: CREDS,
    useMock: false,
    mockScenario: 'maximum',
    importedSnapshot: null,
    utilizationCache: new Map(),
    vifRoutesCache: null,
    vifRoutesError: null,
    utilizationError: null,
    utilizationWindowDays: 30,
    redactMode: false,
    theme: 'light',
  });
  return full;
}

describe('report export fetches its own on-demand data', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    useTopologyStore.setState({ credentials: null, importedSnapshot: null, useMock: true });
  });

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('fetches BGP routes and utilization, then reports on what came back', async () => {
    const full = seedLiveWithoutOnDemandData();
    const read = captureDownload();

    // Stand in for the real loaders: stamp the data onto the store the way
    // loadVifRoutes / loadUtilization do, so the sections have something to render.
    const loadVifRoutes = vi.fn(async () => {
      const td = useTopologyStore.getState().topologyData!;
      useTopologyStore.setState({ topologyData: { ...td, vifRoutes: full.vifRoutes } });
    });
    const loadUtilization = vi.fn(async (windowDays: 30 | 60 | 90) => {
      const td = useTopologyStore.getState().topologyData!;
      useTopologyStore.setState({
        topologyData: {
          ...td,
          vifUtilization: full.vifUtilization,
          connectionUtilization: full.connectionUtilization,
          utilizationWindowDays: windowDays,
        },
      });
    });
    useTopologyStore.setState({ loadVifRoutes, loadUtilization });

    const { result } = renderHook(() => useExportReport());
    await result.current();

    expect(loadVifRoutes).toHaveBeenCalledTimes(1);
    expect(loadUtilization).toHaveBeenCalledWith(30);

    const html = await read();
    // Both must now carry data rather than a "not assessed" stub. The route
    // comparison lives inside the gateway cards, one matrix per gateway, so the
    // per-gateway band is what has to be non-empty.
    const route = html.slice(html.indexOf('id="per-dx-gateway"'), html.indexOf('id="findings"'));
    const util = html.slice(html.indexOf('id="vif-utilization"'), html.indexOf('id="inventory"'));
    expect(route).toContain('Accepted / Allocated');
    expect(route).toContain('Prefix consistency');
    expect(route).not.toContain('is not assessed on any gateway');
    expect(util).toContain('Failover headroom (N-1)');
    expect(util).toContain('last <strong>30 days</strong>');
    expect(util).not.toContain('Not assessed');
  });

  it('quotes what AWS said when the fetch it ran came back empty', async () => {
    seedLiveWithoutOnDemandData();
    const read = captureDownload();
    useTopologyStore.setState({
      loadVifRoutes: vi.fn(async () => {
        useTopologyStore.setState({
          vifRoutesError: 'No BGP routes returned — check directconnect:ListVirtualInterfaceRoutes permission',
        });
      }),
      loadUtilization: vi.fn(async () => {
        useTopologyStore.setState({ utilizationError: 'User is not authorized to perform cloudwatch:GetMetricData' });
      }),
    });

    const { result } = renderHook(() => useExportReport());
    await result.current();

    const html = await read();
    // "Asked and denied" is a permission fact the reader can act on; "not fetched"
    // would hide it.
    expect(html).toContain('this report requested them and the call did not return any');
    expect(html).toContain('check directconnect:ListVirtualInterfaceRoutes permission');
    expect(html).toContain('this report requested them and CloudWatch returned none');
    expect(html).toContain('cloudwatch:GetMetricData');
  });

  it('fetches nothing in mock mode — the fixtures already carry both datasets', async () => {
    const topology = getMockTopology('maximum');
    const loadVifRoutes = vi.fn();
    const loadUtilization = vi.fn();
    useTopologyStore.setState({
      topologyData: topology,
      credentials: null,
      useMock: true,
      mockScenario: 'maximum',
      importedSnapshot: null,
      loadVifRoutes,
      loadUtilization,
      vifRoutesError: null,
      utilizationError: null,
    });
    const read = captureDownload();

    const { result } = renderHook(() => useExportReport());
    await result.current();

    expect(loadVifRoutes).not.toHaveBeenCalled();
    expect(loadUtilization).not.toHaveBeenCalled();
    const html = await read();
    expect(html).toContain('Accepted / Allocated');
    expect(html).toContain('bundled mock');
  });
});
