import { describe, expect, it } from 'vitest';
import { edgeMatchesTag, filterTopologyByTags, getTagMatchIds, getTaggedResources, getTagOptions, matchesTagFilters, scopeTagRecommendations, tagFilteredCustomNodeIds, tagFitNodeIds } from '../tag-filter';
import { buildGraph } from '../topology-builder';
import { analyzeTopology, getRecommendedGraph } from '../recommendation-engine';
import { makeTaggedTopology } from './fixtures/tagged-topology';
import type { DxNode } from '../../types/topology';

describe('AWS tag matching', () => {
  it('offers sorted keys and distinct values from the full resource inventory', () => {
    const topology = makeTaggedTopology();
    expect(getTagOptions(getTaggedResources(topology)).find((o) => o.key === 'Environment'))
      .toEqual({ key: 'Environment', values: ['prod', 'stage', 'test'] });
    expect(getTagOptions(getTaggedResources(topology)).find((o) => o.key === 'Empty'))
      .toEqual({ key: 'Empty', values: [''] });
    expect(getTagOptions(getTaggedResources(topology)).find((o) => o.key === 'Path')?.values)
      .toEqual(['backup', 'other', 'primary']);
  });

  it('matches keys and values exactly, distinguishing missing tags from empty values', () => {
    expect(matchesTagFilters({ Empty: '' }, [{ key: 'Empty', value: '' }])).toBe(true);
    expect(matchesTagFilters({}, [{ key: 'Empty', value: null }])).toBe(false);
    expect(matchesTagFilters(undefined, [{ key: 'Environment', value: null }])).toBe(false);
    expect(matchesTagFilters({ Environment: 'Prod' }, [{ key: 'Environment', value: 'prod' }])).toBe(false);
    expect(matchesTagFilters({ environment: 'prod' }, [{ key: 'Environment', value: null }])).toBe(false);
    expect(matchesTagFilters({}, [{ key: 'constructor', value: null }])).toBe(false);
  });

  it('requires all keys on the same resource', () => {
    const topology = makeTaggedTopology();
    const filtered = filterTopologyByTags(topology, [
      { key: 'Environment', value: 'prod' }, { key: 'Team', value: 'support' },
    ]);
    expect(filtered.vpcs).toEqual([]);
    expect(filtered.connections).toEqual([]);
    expect(filtered.transitGateways).toEqual([]);
  });

  it('accepts any value and an explicitly empty value', () => {
    const topology = makeTaggedTopology();
    expect(filterTopologyByTags(topology, [{ key: 'Environment', value: null }]).vpcs).toHaveLength(3);
    expect(filterTopologyByTags(topology, [{ key: 'Empty', value: '' }]).vpcs.map((v) => v.vpcId))
      .toEqual(['vpc-prod']);
  });
});

describe('tag match markers', () => {
  it('matches only resources carrying the tag, never their path context', () => {
    const topology = makeTaggedTopology();
    expect(getTagMatchIds(topology, [])).toEqual(new Set());
    expect(getTagMatchIds(topology, [{ key: 'Team', value: 'payments' }])).toEqual(new Set(['vpc-prod', 'vpc-stage']));
    // The filter keeps the primary VIF's downstream VPCs, but only the VIF is a match.
    const filters = [{ key: 'Path', value: 'primary' }];
    expect(filterTopologyByTags(topology, filters).vpcs.length).toBeGreaterThan(0);
    expect(getTagMatchIds(topology, filters)).toEqual(new Set(['dxvif-primary']));
  });

  it('matches VIF and connection edges by id, and aggregated VIF edges by any member', () => {
    const ids = new Set(['dxvif-a', 'dxcon-b']);
    expect(edgeMatchesTag({ vifId: 'dxvif-a' }, ids)).toBe(true);
    expect(edgeMatchesTag({ connectionId: 'dxcon-b' }, ids)).toBe(true);
    expect(edgeMatchesTag({ vifId: '3-vifs', aggregatedVifs: [{ vifId: 'x' }, { vifId: 'dxvif-a' }] }, ids)).toBe(true);
    expect(edgeMatchesTag({ vifId: 'dxvif-z', connectionId: 'dxcon-z' }, ids)).toBe(false);
    expect(edgeMatchesTag(undefined, ids)).toBe(false);
    expect(edgeMatchesTag({ vifId: 'dxvif-a' }, new Set())).toBe(false);
  });

  it('frames matched cards, both ends of matched edges, and groups holding a matched row', () => {
    const topology = makeTaggedTopology();
    const filters = [{ key: 'Path', value: 'primary' }];
    const matchIds = getTagMatchIds(topology, filters);
    const { nodes, edges } = buildGraph(filterTopologyByTags(topology, filters), new Set());
    const vifEdge = edges.find((e) => e.data?.vifId === 'dxvif-primary');
    expect(vifEdge).toBeDefined();
    const fit = tagFitNodeIds(nodes, edges, matchIds, new Set());
    expect(fit).toEqual(expect.arrayContaining([vifEdge!.source, vifEdge!.target]));
    expect(fit.some((id) => id.startsWith('vpc-'))).toBe(false);

    const group = { id: 'vpcgroup-g', data: { vpcChildren: [{ vpcId: 'vpc-prod' }] } } as DxNode;
    const card = { id: 'vgw-card', data: {} } as DxNode;
    const tgwGroup = { id: 'tgwgroup-g', data: { memberResourceIds: ['tgw-x', 'tgw-a'] } } as DxNode;
    expect(tagFitNodeIds([group, card, tgwGroup], [], new Set(['vpc-prod', 'tgw-a']), new Set(['vgw-card'])))
      .toEqual(['vpcgroup-g', 'vgw-card', 'tgwgroup-g']);
  });
});

describe('tag-filtered network paths', () => {
  it('returns the original topology when filters are cleared', () => {
    const topology = makeTaggedTopology();
    expect(filterTopologyByTags(topology, [])).toBe(topology);
  });

  it('retains a tagged VPC’s redundant ingress and VPN without revealing sibling VPCs', () => {
    const topology = makeTaggedTopology();
    const before = structuredClone(topology);
    const filtered = filterTopologyByTags(topology, [{ key: 'Environment', value: 'prod' }]);
    expect(filtered.vpcs.map((v) => v.vpcId)).toEqual(['vpc-prod']);
    expect(filtered.transitGateways.map((v) => v.transitGatewayId)).toEqual(['tgw-a']);
    expect(filtered.dxGateways.map((g) => g.directConnectGatewayId)).toEqual(['dxgw-a']);
    expect(filtered.virtualInterfaces.map((v) => v.virtualInterfaceId)).toEqual(['dxvif-primary', 'dxvif-backup']);
    expect(filtered.connections).toHaveLength(2);
    expect(filtered.vpnConnections).toHaveLength(1);
    expect(filtered.customerGateways).toHaveLength(1);
    expect(filtered.transitGatewayAttachments.map((a) => a.resourceId)).toEqual(['vpc-prod']);
    expect(topology).toEqual(before);
  });

  it('does not pull a sibling VIF back through its shared physical connection', () => {
    const filtered = filterTopologyByTags(makeTaggedTopology(), [{ key: 'Path', value: 'primary' }]);
    expect(filtered.virtualInterfaces.map((v) => v.virtualInterfaceId)).toEqual(['dxvif-primary']);
    expect(filtered.connections.map((v) => v.connectionId)).toEqual(['dxcon-a']);
    expect(filtered.dxGateways.map((g) => g.directConnectGatewayId)).toEqual(['dxgw-a']);
    expect(filtered.vpcs.map((v) => v.vpcId)).toEqual(['vpc-prod', 'vpc-stage']);
  });

  it('keeps downstream paths when a connection or DX gateway has the tag', () => {
    const topology = makeTaggedTopology();
    topology.connections[0].tags = { Circuit: 'customer' };
    expect(filterTopologyByTags(topology, [{ key: 'Circuit', value: 'customer' }]).vpcs).toHaveLength(3);
    const filtered = filterTopologyByTags(topology, [{ key: 'Gateway', value: 'b' }]);
    expect(filtered.vpcs.map((v) => v.vpcId)).toEqual(['vpc-other']);
    expect(filtered.virtualInterfaces.map((v) => v.virtualInterfaceId)).toEqual(['dxvif-other']);
  });

  it('uses attachment and route-table tags as anchors for their network paths', () => {
    const topology = makeTaggedTopology();
    topology.vpcRouteTables.set('vpc-prod', [{
      routeTableId: 'rtb-prod', vpcId: 'vpc-prod', isMain: true, associatedSubnetIds: [],
      tags: { Routing: 'payments' }, routes: [],
    }]);
    for (const filter of [{ key: 'Attachment', value: 'prod' }, { key: 'Routing', value: 'payments' }]) {
      const filtered = filterTopologyByTags(topology, [filter]);
      expect(filtered.vpcs.map((v) => v.vpcId)).toEqual(['vpc-prod']);
      expect(filtered.virtualInterfaces).toHaveLength(2);
    }
  });

  it('preserves the inferred connections collected for hosted VIFs without inventing tags', () => {
    const topology = makeTaggedTopology();
    // fetch-topology creates these stubs before the graph sees hosted VIFs.
    topology.connections = topology.connections.map((c) => ({ ...c, isInferred: true, tags: undefined }));
    const filtered = filterTopologyByTags(topology, [{ key: 'Path', value: 'primary' }]);
    const graph = buildGraph(filtered, new Set());
    expect(filtered.connections).toHaveLength(1);
    expect(filtered.connections[0].isInferred).toBe(true);
    expect(filtered.connections[0].tags).toBeUndefined();
    expect(graph.edges.some((e) => e.data?.vifId === 'dxvif-primary')).toBe(true);
    expect(graph.edges.some((e) => e.data?.vifId === 'dxvif-other')).toBe(false);
  });

  it('keeps LAG members and their VIFs while counting duplicate member records once', () => {
    const topology = makeTaggedTopology();
    topology.connections.forEach((c) => { c.lagId = 'dxlag-shared'; });
    topology.lags = [{
      lagId: 'dxlag-shared', lagName: 'Shared bundle', connectionsBandwidth: '1Gbps',
      numberOfConnections: 2, minimumLinks: 1, location: 'Location-a', region: 'ap-southeast-1',
      lagState: 'available', connections: structuredClone(topology.connections), tags: { Bundle: 'shared' },
    }];
    const filtered = filterTopologyByTags(topology, [{ key: 'Bundle', value: 'shared' }]);
    expect(filtered.connections).toHaveLength(2);
    expect(filtered.virtualInterfaces).toHaveLength(3);
    expect(filtered.lags[0].connections).toHaveLength(2);
    expect(getTaggedResources(topology).filter((r) => r.id === 'dxcon-a')).toHaveLength(1);
  });

  it('retains direct VGW paths without requiring a DX gateway', () => {
    const topology = makeTaggedTopology();
    topology.virtualInterfaces[0].directConnectGatewayId = undefined;
    topology.virtualInterfaces[0].virtualGatewayId = 'vgw-direct';
    topology.transitGatewayAttachments = [];
    topology.vpnGateways = [{
      vpnGatewayId: 'vgw-direct', vpcAttachments: [{ vpcId: 'vpc-prod', state: 'attached' }],
      type: 'ipsec.1', amazonSideAsn: 64512, state: 'available', tags: {},
    }];
    const filtered = filterTopologyByTags(topology, [{ key: 'Environment', value: 'prod' }]);
    expect(filtered.vpnGateways).toHaveLength(1);
    expect(filtered.virtualInterfaces.map((v) => v.virtualInterfaceId)).toEqual(['dxvif-primary']);
    expect(filtered.dxGateways).toEqual([]);
  });

  it('keeps a tagged peering’s endpoints but does not expand through unrelated peerings', () => {
    const topology = makeTaggedTopology();
    topology.vpcPeerings = [{
      vpcPeeringConnectionId: 'pcx-prod-stage', state: 'active', tags: { Peering: 'selected' },
      requesterVpc: { vpcId: 'vpc-prod', cidrBlock: '10.0.0.0/16', ownerId: '111111111111', region: 'ap-southeast-1' },
      accepterVpc: { vpcId: 'vpc-stage', cidrBlock: '10.1.0.0/16', ownerId: '111111111111', region: 'ap-southeast-1' },
    }];
    expect(filterTopologyByTags(topology, [{ key: 'Environment', value: 'prod' }]).vpcPeerings).toEqual([]);
    const filtered = filterTopologyByTags(topology, [{ key: 'Peering', value: 'selected' }]);
    expect(filtered.vpcPeerings).toHaveLength(1);
    expect(filtered.vpcs.map((v) => v.vpcId)).toEqual(['vpc-prod', 'vpc-stage']);
  });

  it('supports Cloud WAN core and attachment tags', () => {
    const topology = makeTaggedTopology();
    topology.cloudWanCoreNetworks = [{
      coreNetworkId: 'core-network-test', coreNetworkArn: '', globalNetworkId: '', description: '',
      state: 'available', edges: [], segments: [], tags: { Network: 'selected' },
    }];
    topology.cloudWanAttachments = [{
      attachmentId: 'attachment-test', coreNetworkId: 'core-network-test', ownerAccountId: '111111111111',
      attachmentType: 'vpc', edgeLocation: 'ap-southeast-1',
      resourceArn: 'arn:aws:ec2:ap-southeast-1:111111111111:vpc/vpc-prod',
      segmentName: 'prod', state: 'available', tags: { Segment: 'selected' },
    }];
    for (const key of ['Network', 'Segment']) {
      const filtered = filterTopologyByTags(topology, [{ key, value: 'selected' }]);
      expect(filtered.cloudWanCoreNetworks).toHaveLength(1);
      expect(filtered.cloudWanAttachments).toHaveLength(1);
      expect(filtered.vpcs.map((v) => v.vpcId)).toEqual(['vpc-prod']);
    }
  });
});

describe('recommended view with tag filters', () => {
  it('does not resurrect hidden gateways or leave dangling recommendation edges', () => {
    const topology = makeTaggedTopology();
    const current = buildGraph(filterTopologyByTags(topology, [{ key: 'Gateway', value: 'b' }]), new Set());
    const recommendations = scopeTagRecommendations(current.nodes, getRecommendedGraph(analyzeTopology(topology, {})));
    const ids = new Set([...current.nodes, ...recommendations.nodes].map((n) => n.id));
    expect(recommendations.edges.length).toBeGreaterThan(0);
    expect(recommendations.edges.every((e) => ids.has(e.source) && ids.has(e.target))).toBe(true);
    expect(recommendations.edges.some((e) => e.target === 'dxgw-dxgw-a')).toBe(false);
    expect(scopeTagRecommendations([], getRecommendedGraph(analyzeTopology(topology, {}))))
      .toEqual({ nodes: [], edges: [] });
  });

  it('removes an unrelated ghost location while retaining the selected ghost’s container', () => {
    const node = (id: string, category: DxNode['data']['category'], details = {}): DxNode =>
      ({ id, type: category, position: { x: 0, y: 0 }, data: { category, label: id, details } });
    const recommendations = {
      nodes: [
        node('rec-location-a', 'dxLocation', { code: 'a' }),
        node('rec-location-b', 'dxLocation', { code: 'b' }),
        node('rec-device-a', 'awsDevice', { locationCode: 'a' }),
        node('rec-device-b', 'awsDevice', { locationCode: 'b' }),
      ],
      edges: [
        { id: 'a', source: 'rec-device-a', target: 'gateway-a' },
        { id: 'b', source: 'rec-device-b', target: 'gateway-b' },
      ],
    };
    expect(scopeTagRecommendations([node('gateway-a', 'dxGateway')], recommendations).nodes.map((n) => n.id))
      .toEqual(['rec-location-a', 'rec-device-a']);
  });
});

it('keeps only custom routers and sites connected to a visible path', () => {
  const node = (id: string, parentId?: string): DxNode => ({
    id, parentId, type: 'onPremise', position: { x: 0, y: 0 },
    data: { label: id, category: 'onPremise' },
  });
  const custom = [node('site-a'), node('router-a', 'site-a'), node('site-b'), node('router-b', 'site-b')];
  const edges = [
    { source: 'router-a', target: 'visible-device' },
    { source: 'router-b', target: 'hidden-device' },
  ];
  const retained = tagFilteredCustomNodeIds([node('visible-device')], custom, edges);
  expect(retained.has('router-a')).toBe(true);
  expect(retained.has('site-a')).toBe(true);
  expect(retained.has('site-b')).toBe(false);
  expect(tagFilteredCustomNodeIds([], custom, edges).size).toBe(0);
});
