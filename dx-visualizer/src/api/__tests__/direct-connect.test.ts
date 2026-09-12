import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { DirectConnectClient } from '@aws-sdk/client-direct-connect';

// Stub the SDK command classes so we can drive the paginated responses and
// assert on the params the caller builds. Parameter properties are banned by
// this project's `erasableSyntaxOnly`, so these stubs assign in the body.
vi.mock('@aws-sdk/client-direct-connect', () => {
  type Input = {
    directConnectGatewayId?: string;
    virtualInterfaceId?: string;
    filters?: { routeDirection?: string };
    nextToken?: string;
  };
  class Base {
    input: Input;
    constructor(input: Input = {}) {
      this.input = input;
    }
  }
  class DirectConnectClient {}
  class DescribeConnectionsCommand extends Base {}
  class DescribeVirtualInterfacesCommand extends Base {}
  class DescribeDirectConnectGatewaysCommand extends Base {}
  class DescribeDirectConnectGatewayAssociationsCommand extends Base {}
  class DescribeDirectConnectGatewayAssociationProposalsCommand extends Base {}
  class DescribeDirectConnectGatewayAttachmentsCommand extends Base {}
  class DescribeLagsCommand extends Base {}
  class DescribeLocationsCommand extends Base {}
  class ListVirtualInterfaceRoutesCommand extends Base {}
  class ListVirtualInterfaceTestHistoryCommand extends Base {}
  return {
    DirectConnectClient,
    DescribeConnectionsCommand,
    DescribeVirtualInterfacesCommand,
    DescribeDirectConnectGatewaysCommand,
    DescribeDirectConnectGatewayAssociationsCommand,
    DescribeDirectConnectGatewayAssociationProposalsCommand,
    DescribeDirectConnectGatewayAttachmentsCommand,
    DescribeLagsCommand,
    DescribeLocationsCommand,
    ListVirtualInterfaceRoutesCommand,
    ListVirtualInterfaceTestHistoryCommand,
  };
});

const {
  DescribeDirectConnectGatewaysCommand,
  DescribeDirectConnectGatewayAssociationsCommand,
  DescribeDirectConnectGatewayAssociationProposalsCommand,
  DescribeDirectConnectGatewayAttachmentsCommand,
  ListVirtualInterfaceRoutesCommand,
} = await import('@aws-sdk/client-direct-connect');
const {
  fetchDxGateways,
  fetchDxGatewayAssociations,
  fetchDxGatewayAttachmentRegions,
  fetchConnections,
  fetchVirtualInterfaces,
  fetchLags,
  fetchVirtualInterfaceRoutes,
  fetchVirtualInterfaceTestHistory,
} = await import('../direct-connect');

const sendMock = vi.fn();
// These functions take an already-constructed client, so a bare `send` is
// enough — no aws-client factory mock needed.
const client = { send: sendMock } as unknown as DirectConnectClient;

const DX_MAX_PAGES = 100;

beforeEach(() => {
  sendMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchDxGateways pagination', () => {
  it('follows nextToken across pages', async () => {
    sendMock.mockImplementation((cmd: { input: { nextToken?: string } }) =>
      cmd.input.nextToken
        ? Promise.resolve({
            directConnectGateways: [{ directConnectGatewayId: 'dxgw-2', amazonSideAsn: 64513 }],
          })
        : Promise.resolve({
            directConnectGateways: [{ directConnectGatewayId: 'dxgw-1', amazonSideAsn: 64512 }],
            nextToken: 'p2',
          }),
    );

    const out = await fetchDxGateways(client);

    expect(out.map((g) => g.directConnectGatewayId)).toEqual(['dxgw-1', 'dxgw-2']);
  });

  // The finding: a DX endpoint that returns a token on every page — a service
  // bug, or a response from a compromised spoke account the user added — used
  // to spin this loop forever and OOM the browser tab. It must now fail loudly
  // and finitely so `logged()` records it instead of hanging. Note it is only
  // RECORDED — `fetchErrors` never reaches the UI (see paginate.ts); the caller
  // still receives `[]`. That gap is tracked separately.
  it('throws at the page cap instead of looping forever when nextToken never clears', async () => {
    sendMock.mockResolvedValue({
      directConnectGateways: [{ directConnectGatewayId: 'dxgw-x' }],
      nextToken: 'again',
    });

    await expect(fetchDxGateways(client)).rejects.toThrow(/safety cap/);
    expect(sendMock).toHaveBeenCalledTimes(DX_MAX_PAGES);
  });
});

describe('fetchDxGatewayAssociations pagination', () => {
  const GOOD = {
    directConnectGatewayId: 'dxgw-1',
    associationId: 'assoc-good',
    associatedGateway: { id: 'tgw-good', type: 'transitGateway', region: 'ap-southeast-1', ownerAccount: '111111111111' },
    associationState: 'associated',
  };
  const STUB = {
    directConnectGatewayId: 'dxgw-1',
    associationState: 'associated',
  };

  // Regression guard for the paginator refactor: stub positions are recorded as
  // indices into the FLAT result, so a stub on page 2 must not be recorded at
  // its page-local offset (0) and clobber the good association from page 1.
  it('records stub indices against the flat result, not per page', async () => {
    sendMock.mockImplementation((cmd: { input: { nextToken?: string } }) => {
      if (cmd instanceof DescribeDirectConnectGatewayAssociationsCommand) {
        return cmd.input.nextToken
          ? Promise.resolve({ directConnectGatewayAssociations: [STUB] })
          : Promise.resolve({ directConnectGatewayAssociations: [GOOD], nextToken: 'p2' });
      }
      if (cmd instanceof DescribeDirectConnectGatewayAssociationProposalsCommand) {
        return Promise.resolve({
          directConnectGatewayAssociationProposals: [
            {
              proposalState: 'accepted',
              associatedGateway: {
                id: 'tgw-backfilled',
                type: 'transitGateway',
                region: 'ap-northeast-1',
                ownerAccount: '222222222222',
              },
            },
          ],
        });
      }
      return Promise.resolve({});
    });

    const out = await fetchDxGatewayAssociations(client, 'dxgw-1');

    expect(out).toHaveLength(2);
    // Page 1's real association survives untouched...
    expect(out[0].associatedGateway.id).toBe('tgw-good');
    // ...and page 2's stub is the one that gets the proposal backfill.
    expect(out[1].associatedGateway.id).toBe('tgw-backfilled');
  });

  it('logs the page count once it has paginated', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    sendMock.mockImplementation((cmd: { input: { nextToken?: string } }) =>
      cmd.input.nextToken
        ? Promise.resolve({ directConnectGatewayAssociations: [GOOD] })
        : Promise.resolve({ directConnectGatewayAssociations: [GOOD], nextToken: 'p2' }),
    );

    await fetchDxGatewayAssociations(client, 'dxgw-1');

    expect(
      log.mock.calls.some(([msg]) =>
        String(msg).includes('DxGwAssoc(dxgw-1) paginated: 2 pages, 2 total'),
      ),
    ).toBe(true);
  });

  it('throws at the page cap when nextToken never clears', async () => {
    sendMock.mockResolvedValue({
      directConnectGatewayAssociations: [GOOD],
      nextToken: 'again',
    });

    await expect(fetchDxGatewayAssociations(client, 'dxgw-1')).rejects.toThrow(/safety cap/);
    expect(sendMock).toHaveBeenCalledTimes(DX_MAX_PAGES);
  });
});

describe('fetchDxGatewayAttachmentRegions pagination', () => {
  it('collects regions across pages and de-duplicates them', async () => {
    sendMock.mockImplementation((cmd: { input: { nextToken?: string } }) =>
      cmd.input.nextToken
        ? Promise.resolve({
            directConnectGatewayAttachments: [
              { virtualInterfaceRegion: 'ap-southeast-1' },
              { virtualInterfaceRegion: 'eu-west-1' },
              { virtualInterfaceRegion: undefined },
            ],
          })
        : Promise.resolve({
            directConnectGatewayAttachments: [{ virtualInterfaceRegion: 'ap-southeast-1' }],
            nextToken: 'p2',
          }),
    );

    const out = await fetchDxGatewayAttachmentRegions(client, 'dxgw-1');

    expect(out).toEqual(['ap-southeast-1', 'eu-west-1']);
  });

  it('throws at the page cap when nextToken never clears', async () => {
    sendMock.mockResolvedValue({
      directConnectGatewayAttachments: [{ virtualInterfaceRegion: 'ap-southeast-1' }],
      nextToken: 'again',
    });

    await expect(fetchDxGatewayAttachmentRegions(client, 'dxgw-1')).rejects.toThrow(/safety cap/);
    expect(sendMock).toHaveBeenCalledTimes(DX_MAX_PAGES);
  });

  it('uses the lowercase nextToken the DX API expects', async () => {
    sendMock.mockResolvedValue({ directConnectGatewayAttachments: [] });
    await fetchDxGatewayAttachmentRegions(client, 'dxgw-1');
    const cmd = sendMock.mock.calls[0][0];
    expect(cmd).toBeInstanceOf(DescribeDirectConnectGatewayAttachmentsCommand);
    expect(Object.keys(cmd.input)).toContain('nextToken');
    expect(Object.keys(cmd.input)).not.toContain('NextToken');
  });
});

// The four paginators below were added to the codebase after the original
// bounded-paginator sweep, so each had reintroduced the exact unbounded
// `do { … } while (nextToken)` the sweep removed. Two of them
// (fetchVirtualInterfaceRoutes, fetchVirtualInterfaceTestHistory) are fanned out
// per VIF, so an endpoint that never clears its token multiplies across every
// VIF on the account rather than costing one runaway loop.
describe('page caps on the DX paginators added after the first sweep', () => {
  it('fetchConnections follows nextToken, then throws at the cap', async () => {
    sendMock.mockImplementation((cmd: { input: { nextToken?: string } }) =>
      cmd.input.nextToken
        ? Promise.resolve({ connections: [{ connectionId: 'dxcon-2' }] })
        : Promise.resolve({ connections: [{ connectionId: 'dxcon-1' }], nextToken: 'p2' }),
    );
    expect((await fetchConnections(client)).map((c) => c.connectionId)).toEqual([
      'dxcon-1',
      'dxcon-2',
    ]);

    sendMock.mockReset();
    sendMock.mockResolvedValue({ connections: [{ connectionId: 'dxcon-x' }], nextToken: 'again' });
    await expect(fetchConnections(client)).rejects.toThrow(/safety cap/);
    expect(sendMock).toHaveBeenCalledTimes(DX_MAX_PAGES);
  });

  it('fetchVirtualInterfaces follows nextToken, then throws at the cap', async () => {
    sendMock.mockImplementation((cmd: { input: { nextToken?: string } }) =>
      cmd.input.nextToken
        ? Promise.resolve({ virtualInterfaces: [{ virtualInterfaceId: 'dxvif-2' }] })
        : Promise.resolve({
            virtualInterfaces: [{ virtualInterfaceId: 'dxvif-1' }],
            nextToken: 'p2',
          }),
    );
    expect((await fetchVirtualInterfaces(client)).map((v) => v.virtualInterfaceId)).toEqual([
      'dxvif-1',
      'dxvif-2',
    ]);

    sendMock.mockReset();
    sendMock.mockResolvedValue({
      virtualInterfaces: [{ virtualInterfaceId: 'dxvif-x' }],
      nextToken: 'again',
    });
    await expect(fetchVirtualInterfaces(client)).rejects.toThrow(/safety cap/);
    expect(sendMock).toHaveBeenCalledTimes(DX_MAX_PAGES);
  });

  it('fetchLags follows nextToken, then throws at the cap', async () => {
    sendMock.mockImplementation((cmd: { input: { nextToken?: string } }) =>
      cmd.input.nextToken
        ? Promise.resolve({ lags: [{ lagId: 'dxlag-2' }] })
        : Promise.resolve({ lags: [{ lagId: 'dxlag-1' }], nextToken: 'p2' }),
    );
    expect((await fetchLags(client)).map((l) => l.lagId)).toEqual(['dxlag-1', 'dxlag-2']);

    sendMock.mockReset();
    sendMock.mockResolvedValue({ lags: [{ lagId: 'dxlag-x' }], nextToken: 'again' });
    await expect(fetchLags(client)).rejects.toThrow(/safety cap/);
    expect(sendMock).toHaveBeenCalledTimes(DX_MAX_PAGES);
  });

  it('caps each route direction separately, so one runaway does not hide the other', async () => {
    sendMock.mockResolvedValue({ routes: [{ cidr: '10.0.0.0/24' }], nextToken: 'again' });

    await expect(fetchVirtualInterfaceRoutes(client, 'dxvif-1')).rejects.toThrow(/safety cap/);
    // Both directions run concurrently, so each gets its own budget: the total is
    // bounded at 2 x cap, not unbounded.
    expect(sendMock.mock.calls.length).toBeLessThanOrEqual(DX_MAX_PAGES * 2);
    const directions = new Set(
      sendMock.mock.calls.map(([cmd]) => cmd.input.filters?.routeDirection),
    );
    expect(sendMock.mock.calls[0][0]).toBeInstanceOf(ListVirtualInterfaceRoutesCommand);
    expect(directions).toEqual(new Set(['accepted', 'advertised']));
  });

  it('fetchVirtualInterfaceTestHistory follows nextToken, then throws at the cap', async () => {
    sendMock.mockImplementation((cmd: { input: { nextToken?: string } }) =>
      cmd.input.nextToken
        ? Promise.resolve({ virtualInterfaceTestHistory: [{ testId: 't2', status: 'completed' }] })
        : Promise.resolve({
            virtualInterfaceTestHistory: [{ testId: 't1', status: 'completed' }],
            nextToken: 'p2',
          }),
    );
    expect(
      (await fetchVirtualInterfaceTestHistory(client, 'dxvif-1')).map((t) => t.testId),
    ).toEqual(['t1', 't2']);

    sendMock.mockReset();
    sendMock.mockResolvedValue({
      virtualInterfaceTestHistory: [{ testId: 'tx' }],
      nextToken: 'again',
    });
    await expect(fetchVirtualInterfaceTestHistory(client, 'dxvif-1')).rejects.toThrow(/safety cap/);
    expect(sendMock).toHaveBeenCalledTimes(DX_MAX_PAGES);
  });
});

describe('DX command wiring', () => {
  it('sends the DescribeDirectConnectGateways command for gateways', async () => {
    sendMock.mockResolvedValue({ directConnectGateways: [] });
    await fetchDxGateways(client);
    expect(sendMock.mock.calls[0][0]).toBeInstanceOf(DescribeDirectConnectGatewaysCommand);
  });
});
