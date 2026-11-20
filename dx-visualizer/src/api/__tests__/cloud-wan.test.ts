import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NetworkManagerClient } from '@aws-sdk/client-networkmanager';

// Stub the SDK command classes so each call can be answered by type.
// Parameter properties are banned by this project's `erasableSyntaxOnly`, so
// these stubs assign in the body.
vi.mock('@aws-sdk/client-networkmanager', () => {
  type Input = {
    CoreNetworkId?: string;
    RouteTableIdentifier?: { CoreNetworkSegmentEdge?: { CoreNetworkId?: string } };
  };
  class Base {
    input: Input;
    constructor(input: Input = {}) {
      this.input = input;
    }
  }
  class NetworkManagerClient {}
  class ListCoreNetworksCommand extends Base {}
  class GetCoreNetworkCommand extends Base {}
  class ListAttachmentsCommand extends Base {}
  class ListPeeringsCommand extends Base {}
  class GetNetworkRoutesCommand extends Base {}
  return {
    NetworkManagerClient,
    ListCoreNetworksCommand,
    GetCoreNetworkCommand,
    ListAttachmentsCommand,
    ListPeeringsCommand,
    GetNetworkRoutesCommand,
  };
});

const { ListCoreNetworksCommand, GetCoreNetworkCommand } = await import('@aws-sdk/client-networkmanager');
const { fetchCoreNetworks, fetchCloudWanRoutes } = await import('../cloud-wan');

const sendMock = vi.fn();
const client = { send: sendMock } as unknown as NetworkManagerClient;

beforeEach(() => {
  sendMock.mockReset();
});

const OWN = 'core-network-0own00000000000';
const SHARED = 'core-network-0shared0000000000';

const summary = (id: string, owner: string) => ({
  CoreNetworkId: id,
  CoreNetworkArn: `arn:aws:networkmanager::${owner}:core-network/${id}`,
  GlobalNetworkId: `global-network-${owner}`,
  OwnerAccountId: owner,
  State: 'AVAILABLE',
  Description: `${id} description`,
  Tags: [{ Key: 'Name', Value: id }],
});

const detail = (id: string) => ({
  CoreNetwork: {
    ...summary(id, '111111111111'),
    Edges: [{ EdgeLocation: 'us-east-2', Asn: 64520, InsideCidrBlocks: [] }],
    Segments: [{ Name: 'Production', EdgeLocations: ['us-east-2'], SharedSegments: [] }],
  },
});

const awsError = (name: string, message: string) => Object.assign(new Error(message), { name });

/**
 * The account owns OWN and has accepted a RAM share of SHARED. Verified live:
 * ListCoreNetworks returns both, and GetCoreNetwork on the shared one answers
 * ResourceNotFoundException ("Resource not found.") — a receiving account can
 * list a shared core network but not describe it.
 */
function answer(getSharedError: Error) {
  sendMock.mockImplementation((cmd: { input: { CoreNetworkId?: string } }) => {
    if (cmd instanceof ListCoreNetworksCommand) {
      return Promise.resolve({ CoreNetworks: [summary(OWN, '111111111111'), summary(SHARED, '222222222222')] });
    }
    if (cmd instanceof GetCoreNetworkCommand) {
      return cmd.input.CoreNetworkId === SHARED ? Promise.reject(getSharedError) : Promise.resolve(detail(OWN));
    }
    return Promise.reject(new Error('unexpected command'));
  });
}

describe('fetchCoreNetworks with a RAM-shared core network', () => {
  it('keeps the owned core network when the shared one cannot be described', async () => {
    answer(awsError('ResourceNotFoundException', 'Resource not found.'));
    const out = await fetchCoreNetworks(client);
    const own = out.find((c) => c.coreNetworkId === OWN);
    expect(own?.edges.map((e) => e.edgeLocation)).toEqual(['us-east-2']);
    expect(own?.segments.map((s) => s.name)).toEqual(['Production']);
  });

  it('keeps the shared core network from its list summary, without edges or segments', async () => {
    answer(awsError('ResourceNotFoundException', 'Resource not found.'));
    const out = await fetchCoreNetworks(client);
    expect(out.map((c) => c.coreNetworkId)).toEqual([OWN, SHARED]);
    expect(out[1]).toEqual({
      coreNetworkId: SHARED,
      coreNetworkArn: `arn:aws:networkmanager::222222222222:core-network/${SHARED}`,
      globalNetworkId: 'global-network-222222222222',
      description: `${SHARED} description`,
      tags: { Name: SHARED },
      state: 'available',
      edges: [],
      segments: [],
      summaryOnly: true,
    });
    expect(out[0].summaryOnly).toBeUndefined();
  });

  it('still fails on any other GetCoreNetwork error, so a real fault is reported', async () => {
    answer(awsError('AccessDeniedException', 'not authorized'));
    await expect(fetchCoreNetworks(client)).rejects.toThrow('not authorized');
  });
});

describe('fetchCloudWanRoutes with a summary-only core network', () => {
  it('records no route entry and makes no call for it', async () => {
    answer(awsError('ResourceNotFoundException', 'Resource not found.'));
    const coreNetworks = await fetchCoreNetworks(client);
    sendMock.mockReset();
    sendMock.mockResolvedValue({ NetworkRoutes: [] });

    const routes = await fetchCloudWanRoutes(client, coreNetworks);

    // An empty entry would read as "no routes" and block the owner's real
    // routes when the owner is added as a spoke.
    expect(routes.has(SHARED)).toBe(false);
    expect(routes.has(OWN)).toBe(true);
    expect(sendMock.mock.calls.every(([cmd]) => cmd.input.RouteTableIdentifier?.CoreNetworkSegmentEdge?.CoreNetworkId === OWN)).toBe(true);
  });
});
