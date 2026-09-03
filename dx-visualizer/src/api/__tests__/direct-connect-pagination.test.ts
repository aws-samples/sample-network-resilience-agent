import { describe, it, expect, beforeEach, vi } from 'vitest';

// Regression guard: DescribeConnections, DescribeVirtualInterfaces and
// DescribeLags all paginate. Reading only page 1 is worse than an error —
// every resiliency rule counts connections and VIFs per location, so a
// truncated list yields a confidently *wrong* score instead of a visible
// failure.

const sendMock = vi.fn();

vi.mock('@aws-sdk/client-direct-connect', () => {
  class Base {
    input: { nextToken?: string };
    constructor(input: { nextToken?: string } = {}) {
      this.input = input;
    }
  }
  return {
    DirectConnectClient: class {},
    DescribeConnectionsCommand: class extends Base {},
    DescribeVirtualInterfacesCommand: class extends Base {},
    DescribeLagsCommand: class extends Base {},
    DescribeLocationsCommand: class extends Base {},
    DescribeDirectConnectGatewaysCommand: class extends Base {},
    DescribeDirectConnectGatewayAssociationsCommand: class extends Base {},
    DescribeDirectConnectGatewayAssociationProposalsCommand: class extends Base {},
    DescribeDirectConnectGatewayAttachmentsCommand: class extends Base {},
    ListVirtualInterfaceRoutesCommand: class extends Base {},
  };
});

const { fetchConnections, fetchVirtualInterfaces, fetchLags, fetchLocations } =
  await import('../direct-connect');

const client = { send: sendMock } as never;

beforeEach(() => {
  sendMock.mockReset();
});

describe('fetchConnections pagination', () => {
  it('follows nextToken across pages', async () => {
    sendMock
      .mockResolvedValueOnce({ connections: [{ connectionId: 'dxcon-1' }], nextToken: 'p2' })
      .mockResolvedValueOnce({ connections: [{ connectionId: 'dxcon-2' }], nextToken: 'p3' })
      .mockResolvedValueOnce({ connections: [{ connectionId: 'dxcon-3' }] });

    const out = await fetchConnections(client);

    expect(out.map((c) => c.connectionId)).toEqual(['dxcon-1', 'dxcon-2', 'dxcon-3']);
    expect(sendMock).toHaveBeenCalledTimes(3);
    // The token from each page must be sent on the next request.
    expect(sendMock.mock.calls[1][0].input.nextToken).toBe('p2');
    expect(sendMock.mock.calls[2][0].input.nextToken).toBe('p3');
  });

  it('stops after one call when there is no nextToken', async () => {
    sendMock.mockResolvedValueOnce({ connections: [{ connectionId: 'dxcon-1' }] });
    const out = await fetchConnections(client);
    expect(out).toHaveLength(1);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('preserves fields that arrive on later pages', async () => {
    sendMock
      .mockResolvedValueOnce({ connections: [{ connectionId: 'dxcon-1' }], nextToken: 'p2' })
      .mockResolvedValueOnce({
        connections: [{ connectionId: 'dxcon-2', bandwidth: '10Gbps', lagId: 'dxlag-1' }],
      });
    const out = await fetchConnections(client);
    expect(out[1].bandwidth).toBe('10Gbps');
    expect(out[1].lagId).toBe('dxlag-1');
  });
});

describe('fetchVirtualInterfaces pagination', () => {
  it('follows nextToken across pages', async () => {
    sendMock
      .mockResolvedValueOnce({
        virtualInterfaces: [{ virtualInterfaceId: 'dxvif-1' }],
        nextToken: 'p2',
      })
      .mockResolvedValueOnce({ virtualInterfaces: [{ virtualInterfaceId: 'dxvif-2' }] });

    const out = await fetchVirtualInterfaces(client);

    expect(out.map((v) => v.virtualInterfaceId)).toEqual(['dxvif-1', 'dxvif-2']);
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it('maps routeFilterPrefixes and drops entries with no cidr', async () => {
    sendMock.mockResolvedValueOnce({
      virtualInterfaces: [{
        virtualInterfaceId: 'dxvif-pub',
        virtualInterfaceType: 'public',
        routeFilterPrefixes: [{ cidr: '203.0.113.0/24' }, {}],
      }],
    });
    const out = await fetchVirtualInterfaces(client);
    expect(out[0].routeFilterPrefixes).toEqual([{ cidr: '203.0.113.0/24' }]);
  });
});

describe('fetchLags pagination', () => {
  it('follows nextToken across pages', async () => {
    sendMock
      .mockResolvedValueOnce({ lags: [{ lagId: 'dxlag-1' }], nextToken: 'p2' })
      .mockResolvedValueOnce({ lags: [{ lagId: 'dxlag-2' }] });

    const out = await fetchLags(client);

    expect(out.map((l) => l.lagId)).toEqual(['dxlag-1', 'dxlag-2']);
    expect(sendMock).toHaveBeenCalledTimes(2);
  });
});

describe('fetchLocations', () => {
  // DescribeLocations has no nextToken on its response shape, so it must stay a
  // single call — adding a pagination loop here would spin forever.
  it('issues exactly one call and maps the provider fields', async () => {
    sendMock.mockResolvedValueOnce({
      locations: [{
        locationCode: 'EqDC2',
        locationName: 'Equinix DC2',
        region: 'us-east-1',
        availablePortSpeeds: ['1Gbps', '10Gbps'],
        availableProviders: ['Equinix', 'Megaport'],
        availableMacSecPortSpeeds: ['10Gbps'],
      }],
    });

    const out = await fetchLocations(client);

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(out[0].availableProviders).toEqual(['Equinix', 'Megaport']);
    expect(out[0].availableMacSecPortSpeeds).toEqual(['10Gbps']);
  });
});
