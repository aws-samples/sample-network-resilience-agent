// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { TopologyData } from '../../types/topology';
import type { VifRoutes } from '../../types/aws-resources';

const fetchVifRoutesMock = vi.fn();
vi.mock('../../api/dx-routes', () => ({
  fetchVifRoutes: (...args: unknown[]) => fetchVifRoutesMock(...args),
}));

const { useTopologyStore } = await import('../topology-store');

function routes(cidr = '10.0.0.0/24'): VifRoutes {
  return {
    accepted: [{
      cidr,
      addressFamily: 'ipv4',
      asPath: [{ pathType: 'seq', path: [65000] }],
      communities: [],
      routeDirection: 'accepted',
    }],
    advertised: [],
  };
}

function makeTopology(overrides: Partial<TopologyData> = {}): TopologyData {
  return {
    connections: [],
    virtualInterfaces: [],
    dxGateways: [],
    dxGatewayAssociations: [],
    locations: [],
    lags: [],
    vpcs: [],
    vpnGateways: [],
    vpnConnections: [],
    transitGateways: [],
    transitGatewayAttachments: [],
    transitGatewayPeeringAttachments: [],
    vpcPeerings: [],
    customerGateways: [],
    cloudWanCoreNetworks: [],
    cloudWanAttachments: [],
    cloudWanPeerings: [],
    tgwRouteTables: new Map(),
    vpcRouteTables: new Map(),
    cloudWanRoutes: new Map(),
    ...overrides,
  };
}

describe('loadVifRoutes', () => {
  beforeEach(() => {
    fetchVifRoutesMock.mockReset();
    useTopologyStore.setState({
      topologyData: null,
      credentials: null,
      useMock: false,
      importedSnapshot: null,
      vifRoutesCache: null,
      vifRoutesError: null,
      vifRoutesLoading: false,
      expandedVifRoutePanels: new Set(),
    });
  });

  it('does nothing without a topology', async () => {
    await useTopologyStore.getState().loadVifRoutes();
    expect(fetchVifRoutesMock).not.toHaveBeenCalled();
  });

  it('seeds the cache from the fixture in mock mode without calling AWS', async () => {
    // Regression: the edge Routes button treats a non-null cache as "routes are
    // ready". Mock mode used to return early without seeding it, so clicking
    // Routes in a demo scenario silently did nothing.
    const r = routes();
    useTopologyStore.setState({
      useMock: true,
      topologyData: makeTopology({ vifRoutes: new Map([['dxvif-1', r]]) }),
    });
    await useTopologyStore.getState().loadVifRoutes();
    const s = useTopologyStore.getState();
    expect(fetchVifRoutesMock).not.toHaveBeenCalled();
    expect(s.vifRoutesCache?.get('dxvif-1')).toEqual(r);
    expect(s.vifRoutesError).toBeNull();
  });

  it('reports a clear error for a mock scenario with no baked routes', async () => {
    useTopologyStore.setState({ useMock: true, topologyData: makeTopology() });
    await useTopologyStore.getState().loadVifRoutes();
    const s = useTopologyStore.getState();
    expect(s.vifRoutesCache).toBeNull();
    expect(s.vifRoutesError).toMatch(/no bgp route data/i);
  });

  it('fails soft in imported mode rather than attempting a fetch', async () => {
    useTopologyStore.setState({
      importedSnapshot: { exportedAt: '2026-08-01T00:00:00Z', redactedView: false },
      topologyData: makeTopology(),
    });
    await useTopologyStore.getState().loadVifRoutes();
    expect(fetchVifRoutesMock).not.toHaveBeenCalled();
    expect(useTopologyStore.getState().vifRoutesError).toMatch(/snapshot/i);
  });

  it('asks for credentials when there are none', async () => {
    useTopologyStore.setState({ topologyData: makeTopology() });
    await useTopologyStore.getState().loadVifRoutes();
    expect(fetchVifRoutesMock).not.toHaveBeenCalled();
    expect(useTopologyStore.getState().vifRoutesError).toMatch(/connect to aws/i);
  });

  it('fetches, caches, and stamps routes onto a fresh topology object', async () => {
    const r = routes();
    fetchVifRoutesMock.mockResolvedValue(new Map([['dxvif-1', r]]));
    const before = makeTopology();
    useTopologyStore.setState({
      credentials: { accessKeyId: 'A', secretAccessKey: 'S', region: 'us-east-1' },
      topologyData: before,
    });
    await useTopologyStore.getState().loadVifRoutes();
    const s = useTopologyStore.getState();
    expect(fetchVifRoutesMock).toHaveBeenCalledTimes(1);
    expect(s.vifRoutesCache?.get('dxvif-1')).toEqual(r);
    expect(s.topologyData?.vifRoutes?.get('dxvif-1')).toEqual(r);
    // A new object reference is what the graph-rebuild effect watches.
    expect(s.topologyData).not.toBe(before);
  });

  it('serves a second call from cache without re-hitting the API', async () => {
    const r = routes();
    fetchVifRoutesMock.mockResolvedValue(new Map([['dxvif-1', r]]));
    useTopologyStore.setState({
      credentials: { accessKeyId: 'A', secretAccessKey: 'S', region: 'us-east-1' },
      topologyData: makeTopology(),
    });
    await useTopologyStore.getState().loadVifRoutes();
    await useTopologyStore.getState().loadVifRoutes();
    expect(fetchVifRoutesMock).toHaveBeenCalledTimes(1);
  });

  it('names the likely permission gap when the fetch returns nothing', async () => {
    fetchVifRoutesMock.mockResolvedValue(new Map());
    useTopologyStore.setState({
      credentials: { accessKeyId: 'A', secretAccessKey: 'S', region: 'us-east-1' },
      topologyData: makeTopology(),
    });
    await useTopologyStore.getState().loadVifRoutes();
    const s = useTopologyStore.getState();
    expect(s.vifRoutesCache).toBeNull();
    expect(s.vifRoutesError).toMatch(/ListVirtualInterfaceRoutes/);
  });

  it('surfaces a thrown error and clears the loading flag', async () => {
    fetchVifRoutesMock.mockRejectedValue(new Error('AccessDeniedException'));
    useTopologyStore.setState({
      credentials: { accessKeyId: 'A', secretAccessKey: 'S', region: 'us-east-1' },
      topologyData: makeTopology(),
    });
    await useTopologyStore.getState().loadVifRoutes();
    const s = useTopologyStore.getState();
    expect(s.vifRoutesLoading).toBe(false);
    expect(s.vifRoutesError).toMatch(/AccessDenied/);
  });
});

describe('ensureVifRoutes', () => {
  const creds = { accessKeyId: 'A', secretAccessKey: 'S', region: 'us-east-1' };

  beforeEach(() => {
    fetchVifRoutesMock.mockReset();
    useTopologyStore.setState({
      topologyData: null,
      credentials: creds,
      useMock: false,
      importedSnapshot: null,
      vifRoutesCache: null,
      vifRoutesError: null,
      vifRoutesLoading: false,
    });
  });

  it('fetches once and stamps the routes onto the topology', async () => {
    const r = routes();
    fetchVifRoutesMock.mockResolvedValue(new Map([['dxvif-1', r]]));
    useTopologyStore.setState({ topologyData: makeTopology() });
    await useTopologyStore.getState().ensureVifRoutes();
    expect(useTopologyStore.getState().topologyData?.vifRoutes?.get('dxvif-1')).toEqual(r);
    // Already stamped: a second call must not rebuild the graph by replacing
    // topologyData with an equivalent object.
    const stamped = useTopologyStore.getState().topologyData;
    await useTopologyStore.getState().ensureVifRoutes();
    expect(fetchVifRoutesMock).toHaveBeenCalledTimes(1);
    expect(useTopologyStore.getState().topologyData).toBe(stamped);
  });

  it('serves a warm cache without calling AWS', async () => {
    // The cache survives leaving live mode, but a topology rebuild drops the
    // stamped routes — re-entering live has to re-stamp them, not refetch.
    const cache = new Map([['dxvif-1', routes()]]);
    useTopologyStore.setState({ topologyData: makeTopology(), vifRoutesCache: cache });
    await useTopologyStore.getState().ensureVifRoutes();
    expect(fetchVifRoutesMock).not.toHaveBeenCalled();
    expect(useTopologyStore.getState().topologyData?.vifRoutes).toBe(cache);
  });

  it('does not retry an attempt that already failed', async () => {
    // This runs on every live toggle. Without the guard, an account missing
    // directconnect:ListVirtualInterfaceRoutes would fire a fresh burst of
    // AccessDenied calls each time live mode came on.
    fetchVifRoutesMock.mockRejectedValue(new Error('AccessDeniedException'));
    useTopologyStore.setState({ topologyData: makeTopology() });
    await useTopologyStore.getState().ensureVifRoutes();
    expect(useTopologyStore.getState().vifRoutesError).toMatch(/AccessDenied/);
    await useTopologyStore.getState().ensureVifRoutes();
    expect(fetchVifRoutesMock).toHaveBeenCalledTimes(1);
    // An explicit Routes / Route diff click still retries.
    await useTopologyStore.getState().loadVifRoutes();
    expect(fetchVifRoutesMock).toHaveBeenCalledTimes(2);
  });

  it('does nothing without a topology', async () => {
    await useTopologyStore.getState().ensureVifRoutes();
    expect(fetchVifRoutesMock).not.toHaveBeenCalled();
  });
});

describe('toggleLiveStatus', () => {
  beforeEach(() => {
    fetchVifRoutesMock.mockReset();
    useTopologyStore.setState({
      showLiveStatus: false,
      topologyData: null,
      vifRoutesCache: null,
      vifRoutesError: null,
      vifRoutesLoading: false,
      expandedVifRoutePanels: new Set(),
    });
  });

  it('pulls BGP routes on entering live mode, and not on leaving', async () => {
    // The DX Gateway gap count is unreadable without route data, so a warning
    // that only appears after a second click appears too late to be a warning.
    const r = routes();
    fetchVifRoutesMock.mockResolvedValue(new Map([['dxvif-1', r]]));
    useTopologyStore.setState({
      topologyData: makeTopology(),
      credentials: { accessKeyId: 'A', secretAccessKey: 'S', region: 'us-east-1' },
      useMock: false,
      importedSnapshot: null,
    });
    useTopologyStore.getState().toggleLiveStatus();
    await vi.waitFor(() => {
      expect(useTopologyStore.getState().vifRoutesCache?.get('dxvif-1')).toEqual(r);
    });
    useTopologyStore.getState().toggleLiveStatus();
    expect(fetchVifRoutesMock).toHaveBeenCalledTimes(1);
  });

  it('closes open route panels on leaving live mode but keeps the cache', () => {
    const cache = new Map([['dxvif-1', routes()]]);
    useTopologyStore.setState({
      showLiveStatus: true,
      vifRoutesCache: cache,
      expandedVifRoutePanels: new Set(['dxvif-1']),
    });
    useTopologyStore.getState().toggleLiveStatus();
    const s = useTopologyStore.getState();
    expect(s.showLiveStatus).toBe(false);
    expect(s.expandedVifRoutePanels.size).toBe(0);
    // Re-entering live mode must not cost another fetch.
    expect(s.vifRoutesCache).toBe(cache);
  });

  it('leaves panel state alone when entering live mode', () => {
    useTopologyStore.setState({ showLiveStatus: false, expandedVifRoutePanels: new Set(['dxvif-1']) });
    useTopologyStore.getState().toggleLiveStatus();
    const s = useTopologyStore.getState();
    expect(s.showLiveStatus).toBe(true);
    expect(s.expandedVifRoutePanels.has('dxvif-1')).toBe(true);
  });
});
