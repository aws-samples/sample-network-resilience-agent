// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useTopologyStore, isRecPathActive } from '../topology-store';
import type { DxNode, DxEdge } from '../../types/topology';

vi.stubGlobal('localStorage', {
  getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {},
});

const node = (id: string, category: DxNode['data']['category'] = 'awsDevice'): DxNode => ({ id, type: category, position: { x: 0, y: 0 }, data: { category, label: id } });
const edge = (id: string, source: string, target: string): DxEdge => ({ id, source, target });

beforeEach(() => {
  useTopologyStore.setState({ viewMode: 'recommended', focusedDxGatewayId: 'dxgw-1' });
});

describe('recommended-path highlight state', () => {
  it('derives path nodes from ghost nodes AND the endpoints its edges attach to', () => {
    // A ghost device, and a ghost edge onto an EXISTING gateway node that is not
    // itself in the ghost node list — both must light.
    useTopologyStore.getState().setRecommendedGraph(
      [node('rec-dev-B')],
      [edge('e1', 'rec-dev-B', 'dxgw-dxgw-1')],
      [],
    );
    const s = useTopologyStore.getState();
    expect(s.recPathNodeIds).toEqual(new Set(['rec-dev-B', 'dxgw-dxgw-1']));
    expect(s.recPathEdgeIds).toEqual(new Set(['e1']));
  });

  it('is active only in recommended view with a focus and a path', () => {
    useTopologyStore.getState().setRecommendedGraph([node('g')], [edge('e', 'g', 'dxgw-dxgw-1')], []);
    expect(isRecPathActive(useTopologyStore.getState())).toBe(true);

    useTopologyStore.setState({ focusedDxGatewayId: null });
    expect(isRecPathActive(useTopologyStore.getState())).toBe(false); // view-all: no single path to feature

    useTopologyStore.setState({ focusedDxGatewayId: 'dxgw-1', viewMode: 'current' });
    expect(isRecPathActive(useTopologyStore.getState())).toBe(false); // current view draws no ghosts

    useTopologyStore.setState({ viewMode: 'recommended' });
    useTopologyStore.getState().setRecommendedGraph([], [], []);
    expect(isRecPathActive(useTopologyStore.getState())).toBe(false); // nothing recommended
  });

  it('extends a TGW option to the TGW and its VPCs along the existing lines', () => {
    // onprem → dev-A → dxgw-1 → tgw-T → vpc-1, plus a VPN into the same TGW, a
    // sibling TGW the same gateway feeds, and a peered VPC — none of which the
    // option protects.
    const current = [
      node('onprem-A', 'onPremise'), node('dev-A'), node('dxgw-dxgw-1', 'dxGateway'),
      node('tgw-tgw-T', 'tgw'), node('tgw-tgw-other', 'tgw'), node('vpc-1', 'vpc'), node('vpc-peer', 'vpc'),
      node('vpn-1', 'cgw'), node('vpc-other', 'vpc'),
    ];
    const currentEdges = [
      edge('c1', 'onprem-A', 'dev-A'), edge('c2', 'dev-A', 'dxgw-dxgw-1'), edge('c3', 'dxgw-dxgw-1', 'tgw-tgw-T'),
      edge('c4', 'tgw-tgw-T', 'vpc-1'), edge('c5', 'vpn-1', 'tgw-tgw-T'), edge('c6', 'dxgw-dxgw-1', 'tgw-tgw-other'),
      edge('c7', 'vpc-1', 'vpc-peer'), edge('c8', 'tgw-tgw-other', 'vpc-other'),
    ];
    useTopologyStore.setState({ focusedDxGatewayId: 'tgw-T', currentEdges, userEdges: [] });
    useTopologyStore.getState().setRecommendedGraph(
      [node('rec-dev-B')], [edge('g1', 'rec-dev-B', 'dxgw-dxgw-1')], current, ['tgw-tgw-T'],
    );
    const s = useTopologyStore.getState();
    expect(s.recPathEdgeIds).toEqual(new Set(['g1', 'c1', 'c2', 'c3', 'c4']));
    expect(s.recPathNodeIds).toEqual(new Set(['rec-dev-B', 'onprem-A', 'dev-A', 'dxgw-dxgw-1', 'tgw-tgw-T', 'vpc-1']));
  });

  it('a DX gateway option walks through its VGW to the VPC behind it', () => {
    const current = [node('dxgw-dxgw-1', 'dxGateway'), node('vgw-vgw-1', 'vgw'), node('vpc-1', 'vpc')];
    const currentEdges = [edge('c1', 'dxgw-dxgw-1', 'vgw-vgw-1'), edge('c2', 'vgw-vgw-1', 'vpc-1')];
    useTopologyStore.setState({ currentEdges, userEdges: [] });
    useTopologyStore.getState().setRecommendedGraph(
      [node('rec-dev-B')], [edge('g1', 'rec-dev-B', 'dxgw-dxgw-1')], current, ['dxgw-dxgw-1'],
    );
    expect(useTopologyStore.getState().recPathEdgeIds).toEqual(new Set(['g1', 'c1', 'c2']));
  });

  it('lights no existing line when the option draws no ghost', () => {
    const current = [node('dxgw-dxgw-1', 'dxGateway'), node('vgw-vgw-1', 'vgw')];
    useTopologyStore.setState({ currentEdges: [edge('c1', 'dxgw-dxgw-1', 'vgw-vgw-1')], userEdges: [] });
    useTopologyStore.getState().setRecommendedGraph([], [], current, ['dxgw-dxgw-1']);
    expect(isRecPathActive(useTopologyStore.getState())).toBe(false);
  });

  it('above a shared AWS device, lights only the connections whose VIFs enter the path', () => {
    // dev-A terminates two connections: c-mine (VIF into dxgw-1) and c-other
    // (VIF into a different gateway). Only c-mine's partner is on this path.
    const current = [
      node('partner-mine', 'dxPartnerDevice'), node('partner-other', 'dxPartnerDevice'), node('dev-A'),
      node('dxgw-dxgw-1', 'dxGateway'), node('dxgw-dxgw-2', 'dxGateway'), node('vgw-vgw-1', 'vgw'),
    ];
    const withData = (e: DxEdge, data: Record<string, unknown>): DxEdge => ({ ...e, data: data as DxEdge['data'] });
    const currentEdges = [
      withData(edge('p1', 'partner-mine', 'dev-A'), { connectionId: 'c-mine' }),
      withData(edge('p2', 'partner-other', 'dev-A'), { connectionId: 'c-other' }),
      withData(edge('v1', 'dev-A', 'dxgw-dxgw-1'), { vifId: 'vif-mine' }),
      withData(edge('v2', 'dev-A', 'dxgw-dxgw-2'), { vifId: 'vif-other' }),
      edge('g', 'dxgw-dxgw-1', 'vgw-vgw-1'),
    ];
    useTopologyStore.setState({
      currentEdges, userEdges: [],
      topologyData: { virtualInterfaces: [
        { virtualInterfaceId: 'vif-mine', connectionId: 'c-mine' },
        { virtualInterfaceId: 'vif-other', connectionId: 'c-other' },
      ] } as never,
    });
    useTopologyStore.getState().setRecommendedGraph(
      [node('rec-dev-B')], [edge('r1', 'rec-dev-B', 'dxgw-dxgw-1')], current, ['dxgw-dxgw-1'],
    );
    const s = useTopologyStore.getState();
    expect(s.recPathEdgeIds).toEqual(new Set(['r1', 'v1', 'p1', 'g']));
    expect(s.recPathNodeIds.has('partner-other')).toBe(false);
  });
});
