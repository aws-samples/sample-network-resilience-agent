import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AwsCredentials, DxVirtualInterface } from '../../types/aws-resources';

// Stub the SDK command class so we can assert on the params the caller builds
// and drive the paginated responses ourselves.
const sendMock = vi.fn();
const createDxClientMock = vi.fn((_creds: AwsCredentials) => ({ send: sendMock }));

vi.mock('../aws-client', () => ({
  createDxClient: (creds: AwsCredentials) => createDxClientMock(creds),
}));

// Parameter properties are banned by this project's `erasableSyntaxOnly`, so
// this stub assigns in the body.
vi.mock('@aws-sdk/client-direct-connect', () => {
  class ListVirtualInterfaceRoutesCommand {
    input: {
      virtualInterfaceId?: string;
      filters?: { routeDirection?: string };
      nextToken?: string;
    };
    constructor(input: {
      virtualInterfaceId?: string;
      filters?: { routeDirection?: string };
      nextToken?: string;
    }) {
      this.input = input;
    }
  }
  return { ListVirtualInterfaceRoutesCommand };
});

const { fetchVifRoutes } = await import('../dx-routes');

const creds: AwsCredentials = {
  accessKeyId: 'AKIA',
  secretAccessKey: 'secret',
  region: 'us-east-1',
};

function makeVif(overrides: Partial<DxVirtualInterface> = {}): DxVirtualInterface {
  return {
    virtualInterfaceId: 'dxvif-1',
    virtualInterfaceName: 'vif-1',
    virtualInterfaceType: 'private',
    virtualInterfaceState: 'available',
    connectionId: 'dxcon-1',
    vlan: 101,
    asn: 65000,
    bgpPeers: [],
    region: 'us-east-1',
    ...overrides,
  };
}

// Route the mock by the direction filter so each pass returns its own data.
function respondByDirection(byDir: Record<string, unknown[]>) {
  sendMock.mockImplementation((cmd: { input: { filters?: { routeDirection?: string } } }) => {
    const dir = cmd.input.filters?.routeDirection ?? 'accepted';
    return Promise.resolve({ routes: byDir[dir] ?? [] });
  });
}

describe('fetchVifRoutes', () => {
  beforeEach(() => {
    sendMock.mockReset();
    createDxClientMock.mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('returns an empty map without calling AWS when there are no VIFs', async () => {
    const out = await fetchVifRoutes(creds, []);
    expect(out.size).toBe(0);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('skips VIFs that are not available — no BGP session means no routes', async () => {
    const out = await fetchVifRoutes(creds, [makeVif({ virtualInterfaceState: 'down' })]);
    expect(out.size).toBe(0);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('splits accepted and advertised into separate directions', async () => {
    respondByDirection({
      accepted: [{ cidr: '10.0.0.0/24', routeDirection: 'accepted' }],
      advertised: [
        { cidr: '172.31.0.0/16', routeDirection: 'advertised' },
        { cidr: '172.32.0.0/16', routeDirection: 'advertised' },
      ],
    });
    const out = await fetchVifRoutes(creds, [makeVif()]);
    const entry = out.get('dxvif-1')!;
    expect(entry.accepted.map((r) => r.cidr)).toEqual(['10.0.0.0/24']);
    expect(entry.advertised.map((r) => r.cidr)).toEqual(['172.31.0.0/16', '172.32.0.0/16']);
    // One paginated pass per direction.
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it('follows pagination until nextToken is exhausted', async () => {
    let call = 0;
    sendMock.mockImplementation((cmd: { input: { filters?: { routeDirection?: string } } }) => {
      if (cmd.input.filters?.routeDirection !== 'accepted') return Promise.resolve({ routes: [] });
      call++;
      return call === 1
        ? Promise.resolve({ routes: [{ cidr: '10.0.0.0/24' }], nextToken: 'page2' })
        : Promise.resolve({ routes: [{ cidr: '10.0.1.0/24' }] });
    });
    const out = await fetchVifRoutes(creds, [makeVif()]);
    expect(out.get('dxvif-1')!.accepted.map((r) => r.cidr)).toEqual(['10.0.0.0/24', '10.0.1.0/24']);
  });

  it('normalizes routeInstalledAt to an ISO string so snapshots stay JSON-safe', async () => {
    respondByDirection({
      accepted: [{ cidr: '10.0.0.0/24', routeInstalledAt: new Date('2026-08-01T09:15:00.000Z') }],
    });
    const out = await fetchVifRoutes(creds, [makeVif()]);
    expect(out.get('dxvif-1')!.accepted[0].routeInstalledAt).toBe('2026-08-01T09:15:00.000Z');
  });

  it('defaults asPath and communities to arrays when AWS omits them', async () => {
    respondByDirection({ accepted: [{ cidr: '10.0.0.0/24' }] });
    const out = await fetchVifRoutes(creds, [makeVif()]);
    const r = out.get('dxvif-1')!.accepted[0];
    expect(r.asPath).toEqual([]);
    expect(r.communities).toEqual([]);
    // Direction falls back to the filter we asked for.
    expect(r.routeDirection).toBe('accepted');
  });

  it('omits VIFs that returned no routes in either direction', async () => {
    respondByDirection({});
    const out = await fetchVifRoutes(creds, [makeVif()]);
    // A present-but-empty entry would make `has()` mean "we tried" rather than
    // "we have routes", which the rules rely on.
    expect(out.has('dxvif-1')).toBe(false);
  });

  it('builds one client per region from each VIF own region', async () => {
    respondByDirection({ accepted: [{ cidr: '10.0.0.0/24' }] });
    await fetchVifRoutes(creds, [
      makeVif({ virtualInterfaceId: 'dxvif-1', region: 'us-east-1' }),
      makeVif({ virtualInterfaceId: 'dxvif-2', region: 'ap-southeast-1' }),
    ]);
    const regions = createDxClientMock.mock.calls.map(([c]) => c.region);
    expect(new Set(regions)).toEqual(new Set(['us-east-1', 'ap-southeast-1']));
  });

  it('degrades a single failing VIF to an omitted entry instead of failing the batch', async () => {
    sendMock.mockImplementation((cmd: { input: { virtualInterfaceId?: string } }) => {
      if (cmd.input.virtualInterfaceId === 'dxvif-bad') {
        return Promise.reject(new Error('AccessDeniedException'));
      }
      return Promise.resolve({ routes: [{ cidr: '10.0.0.0/24' }] });
    });
    const out = await fetchVifRoutes(creds, [
      makeVif({ virtualInterfaceId: 'dxvif-bad' }),
      makeVif({ virtualInterfaceId: 'dxvif-ok' }),
    ]);
    expect(out.has('dxvif-bad')).toBe(false);
    expect(out.has('dxvif-ok')).toBe(true);
  });
});
