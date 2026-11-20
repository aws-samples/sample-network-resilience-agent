import { describe, it, expect } from 'vitest';
import { mergeSpokeCloudWan, type SpokeCloudWan } from '../spoke-cloudwan';
import { buildGraph } from '../../engine/topology-builder';
import { makeEmptyTopology } from '../../engine/__tests__/helpers';
import type { TopologyData } from '../../types/topology';

// The estate a customer exported: Direct Connect in one account, the Cloud WAN
// core network in a hub account. Signed in to the DX account, the DXGW's
// association names a core network that account cannot read, so the canvas
// drew the DXGW with nothing behind it.

const DX_ACCOUNT = '111111111111';
const HUB_ACCOUNT = '222222222222';
const CN = 'core-network-0aaa1111';
const DXGW = 'dxgw-0001';

const coreNetwork = (id: string): TopologyData['cloudWanCoreNetworks'][number] => ({
  coreNetworkId: id,
  coreNetworkArn: `arn:aws:networkmanager::${HUB_ACCOUNT}:core-network/${id}`,
  globalNetworkId: 'global-network-01',
  description: 'hub',
  state: 'AVAILABLE',
  edges: [{ edgeLocation: 'ap-southeast-1', asn: 64520, insideCidrBlocks: [] }],
  segments: [{ name: 'prod', edgeLocations: ['ap-southeast-1'], sharedSegments: [] }],
});

const dxgwAttachment = (id: string): TopologyData['cloudWanAttachments'][number] => ({
  attachmentId: id,
  coreNetworkId: CN,
  ownerAccountId: DX_ACCOUNT,
  attachmentType: 'direct-connect-gateway',
  edgeLocation: '',
  resourceArn: `arn:aws:directconnect::${DX_ACCOUNT}:dx-gateway/${DXGW}`,
  segmentName: 'prod',
  state: 'AVAILABLE',
  tags: {},
});

const vpcAttachment = (id: string): TopologyData['cloudWanAttachments'][number] => ({
  attachmentId: id,
  coreNetworkId: CN,
  ownerAccountId: HUB_ACCOUNT,
  attachmentType: 'vpc',
  edgeLocation: 'ap-southeast-1',
  resourceArn: `arn:aws:ec2:ap-southeast-1:${HUB_ACCOUNT}:vpc/vpc-0bbb2222`,
  segmentName: 'prod',
  state: 'AVAILABLE',
  tags: {},
});

/** What the DX owner account fetches on its own. */
function dxAccountTopology(): TopologyData {
  const topo = makeEmptyTopology();
  topo.homeAccountId = DX_ACCOUNT;
  topo.dxGateways = [
    { directConnectGatewayId: DXGW, directConnectGatewayName: 'prod-dxgw', directConnectGatewayState: 'available', amazonSideAsn: 64512 },
  ];
  topo.dxGatewayAssociations = [{
    directConnectGatewayId: DXGW,
    associatedGateway: { id: '', type: undefined, region: '', ownerAccount: '' },
    associatedCoreNetwork: { id: CN, ownerAccount: HUB_ACCOUNT, attachmentId: 'attachment-dx1' },
    associationState: 'associated',
    allowedPrefixes: ['10.0.0.0/16'],
  }];
  // The DX account lists its own attachment to the hub's core network.
  topo.cloudWanAttachments = [dxgwAttachment('attachment-dx1')];
  return topo;
}

/** What the hub account returns through the spoke role. */
function hubCloudWan(): SpokeCloudWan {
  return {
    coreNetworks: [coreNetwork(CN)],
    // The hub lists the DX account's attachment again, alongside its own.
    attachments: [dxgwAttachment('attachment-dx1'), vpcAttachment('attachment-vpc1')],
    peerings: [],
    routes: new Map([[CN, [{ segmentName: 'prod', edgeLocation: 'ap-southeast-1', routes: [] }]]]),
  };
}

const dxgwToCoreNetwork = (topo: TopologyData) =>
  buildGraph(topo, new Set()).edges.filter((e) => e.source === `dxgw-${DXGW}` && e.target === `cwan-${CN}`);

describe('mergeSpokeCloudWan', () => {
  it('adds the hub core network, so the DXGW → Core Network edge is drawn', () => {
    const topo = dxAccountTopology();
    expect(dxgwToCoreNetwork(topo)).toHaveLength(0);

    mergeSpokeCloudWan(topo, hubCloudWan());

    expect(topo.cloudWanCoreNetworks.map((c) => c.coreNetworkId)).toEqual([CN]);
    expect(dxgwToCoreNetwork(topo)).toHaveLength(1);
  });

  it('does not duplicate an attachment both accounts list', () => {
    const topo = dxAccountTopology();
    const counts = mergeSpokeCloudWan(topo, hubCloudWan());
    expect(topo.cloudWanAttachments.map((a) => a.attachmentId).sort()).toEqual(['attachment-dx1', 'attachment-vpc1']);
    expect(counts).toEqual({ coreNetworks: 1, attachments: 1, peerings: 0 });
  });

  it('keeps what the signed-in account already fetched', () => {
    const topo = dxAccountTopology();
    const own = { ...coreNetwork(CN), description: 'from signed-in account' };
    topo.cloudWanCoreNetworks = [own];
    mergeSpokeCloudWan(topo, hubCloudWan());
    expect(topo.cloudWanCoreNetworks).toEqual([own]);
  });

  it('is idempotent across two spokes returning the same core network', () => {
    const topo = dxAccountTopology();
    mergeSpokeCloudWan(topo, hubCloudWan());
    const second = mergeSpokeCloudWan(topo, hubCloudWan());
    expect(second).toEqual({ coreNetworks: 0, attachments: 0, peerings: 0 });
    expect(topo.cloudWanCoreNetworks).toHaveLength(1);
    expect(topo.cloudWanAttachments).toHaveLength(2);
  });

  it('carries the hub routes for the Cloud WAN route panel', () => {
    const topo = dxAccountTopology();
    mergeSpokeCloudWan(topo, hubCloudWan());
    expect(topo.cloudWanRoutes.get(CN)?.[0].segmentName).toBe('prod');
  });
});

// The DX account has ACCEPTED a RAM share of the hub's core network, so its
// own fetch already returns it — but only as a list summary (GetCoreNetwork on
// a shared core network is ResourceNotFound; see fetchCoreNetworks). Verified
// against a live lab with one owned and one shared core network.
const summaryOnly = (id: string): TopologyData['cloudWanCoreNetworks'][number] => ({
  ...coreNetwork(id),
  edges: [],
  segments: [],
  summaryOnly: true,
});

describe('mergeSpokeCloudWan with a RAM-shared core network', () => {
  it('replaces the summary-only copy with the owner’s full one', () => {
    const topo = dxAccountTopology();
    topo.cloudWanCoreNetworks = [summaryOnly(CN)];

    const counts = mergeSpokeCloudWan(topo, hubCloudWan());

    expect(topo.cloudWanCoreNetworks).toHaveLength(1);
    expect(topo.cloudWanCoreNetworks[0].summaryOnly).toBeUndefined();
    expect(topo.cloudWanCoreNetworks[0].segments.map((s) => s.name)).toEqual(['prod']);
    expect(counts.coreNetworks).toBe(1);
  });

  it('takes the owner’s routes for the upgraded core network, even over an existing entry', () => {
    const topo = dxAccountTopology();
    topo.cloudWanCoreNetworks = [summaryOnly(CN)];
    topo.cloudWanRoutes.set(CN, []);
    mergeSpokeCloudWan(topo, hubCloudWan());
    expect(topo.cloudWanRoutes.get(CN)?.[0].segmentName).toBe('prod');
  });

  it('never replaces a full copy with a spoke’s summary-only one', () => {
    const topo = dxAccountTopology();
    const full = coreNetwork(CN);
    topo.cloudWanCoreNetworks = [full];
    const counts = mergeSpokeCloudWan(topo, { ...hubCloudWan(), coreNetworks: [summaryOnly(CN)], routes: new Map() });
    expect(topo.cloudWanCoreNetworks).toEqual([full]);
    expect(counts.coreNetworks).toBe(0);
  });

  it('end to end: owned + shared core network, owner added as a spoke', () => {
    const OWN_CN = 'core-network-0own00000000000';
    const topo = dxAccountTopology();
    topo.cloudWanCoreNetworks = [{ ...coreNetwork(OWN_CN), description: 'own' }, summaryOnly(CN)];

    mergeSpokeCloudWan(topo, hubCloudWan());

    expect(topo.cloudWanCoreNetworks.map((c) => [c.coreNetworkId, !!c.summaryOnly])).toEqual([
      [OWN_CN, false],
      [CN, false],
    ]);
    expect(topo.cloudWanRoutes.has(CN)).toBe(true);
    expect(dxgwToCoreNetwork(topo)).toHaveLength(1);
  });
});

describe('core network node ownership', () => {
  const nodeFor = (topo: TopologyData, id: string) =>
    buildGraph(topo, new Set()).nodes.find((n) => n.id === `cwan-${id}`);

  it('marks a core network owned by another account as cross-account, naming the owner', () => {
    const topo = dxAccountTopology();
    mergeSpokeCloudWan(topo, hubCloudWan());
    const node = nodeFor(topo, CN);
    expect(node?.data.details?.crossAccount).toBe('true');
    expect(node?.data.details?.ownerAccount).toBe(HUB_ACCOUNT);
  });

  it('marks a summary-only shared copy too — the ARN names the owner either way', () => {
    const topo = dxAccountTopology();
    topo.cloudWanCoreNetworks = [summaryOnly(CN)];
    expect(nodeFor(topo, CN)?.data.details?.crossAccount).toBe('true');
  });

  it('does not mark the signed-in account’s own core network', () => {
    const topo = dxAccountTopology();
    topo.homeAccountId = HUB_ACCOUNT;
    topo.cloudWanCoreNetworks = [coreNetwork(CN)];
    expect(nodeFor(topo, CN)?.data.details?.crossAccount).toBeUndefined();
  });
});
