// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { DxgwRouteDiffPanel, type TgwPanelContext } from '../nodes/DxgwRouteDiffPanel';
import { computeDxgwRouteDiff } from '../../engine/vif-route-diff';
import { useTopologyStore } from '../../store/topology-store';
import { makeEmptyTopology } from '../../engine/__tests__/helpers';
import type { TgwRouteTableWithRoutes, VifRoute } from '../../types/aws-resources';

vi.mock('@xyflow/react', () => ({
  useViewport: () => ({ x: 0, y: 0, zoom: 1 }),
  useReactFlow: () => ({
    getNode: () => ({ position: { x: 0, y: 0 }, measured: { width: 160, height: 60 } }),
  }),
}));

const route = (cidr: string): VifRoute => ({
  cidr, addressFamily: 'ipv4', asPath: [{ pathType: 'seq', path: [65000] }], communities: [], routeDirection: 'accepted',
});

/**
 * Two DX gateways feeding one TGW. gwA has two VIFs at Tokyo (separate devices),
 * gwB one at Osaka. Prefixes:
 *   10.1.0.0/16 — gwA VIF 1 only               → No backup
 *   10.2.0.0/16 — both gwA VIFs, Tokyo only     → 1 site
 *   10.3.0.0/16 — gwA VIF 1 and gwB             → High
 */
function setup(routeTables?: TgwRouteTableWithRoutes[]) {
  const t = makeEmptyTopology();
  t.dxGateways = [
    { directConnectGatewayId: 'gwA', directConnectGatewayName: 'tokyo-dxgw', amazonSideAsn: 1, directConnectGatewayState: 'available' },
    { directConnectGatewayId: 'gwB', directConnectGatewayName: 'osaka-dxgw', amazonSideAsn: 2, directConnectGatewayState: 'available' },
  ];
  const place = { v1: ['gwA', 'TY2', 'ty-a'], v2: ['gwA', 'TY2', 'ty-b'], v3: ['gwB', 'OSA2', 'os-a'] } as const;
  const accepts: Record<string, string[]> = {
    v1: ['10.1.0.0/16', '10.2.0.0/16', '10.3.0.0/16'],
    v2: ['10.2.0.0/16'],
    v3: ['10.3.0.0/16'],
  };
  t.virtualInterfaces = Object.entries(place).map(([id, [gw, loc, dev]]) => ({
    virtualInterfaceId: id, virtualInterfaceName: id, virtualInterfaceType: 'transit', virtualInterfaceState: 'available',
    connectionId: `c-${id}`, directConnectGatewayId: gw, vlan: 1, asn: 1, bgpPeers: [], region: 'r',
    location: loc, awsLogicalDeviceId: dev,
  }));
  t.vifRoutes = new Map(Object.entries(accepts).map(([id, cidrs]) => [id, { accepted: cidrs.map(route), advertised: [] }]));
  useTopologyStore.setState({ topologyData: t });
  const scope = new Set(['gwA', 'gwB']);
  const diff = computeDxgwRouteDiff(t, scope)!;
  const tgw: TgwPanelContext = {
    tgwId: 'tgw-1',
    sinkNodeId: 'tgw-tgw-1',
    routeTables,
    gatewayName: (id) => t.dxGateways.find((g) => g.directConnectGatewayId === id)?.directConnectGatewayName ?? id,
  };
  render(<DxgwRouteDiffPanel diff={diff} gatewayName="Core TGW" onClose={() => {}} nodeId="tgw-tgw-1" dxGatewayId={scope} tgw={tgw} />);
}

const table = (routes: { cidr: string; dxgw: string }[]): TgwRouteTableWithRoutes => ({
  routeTable: { transitGatewayRouteTableId: 'rt-1' },
  routes: routes.map(({ cidr, dxgw }) => ({
    destinationCidrBlock: cidr,
    transitGatewayAttachments: [{ transitGatewayAttachmentId: `att-${dxgw}`, resourceType: 'direct-connect-gateway', resourceId: dxgw }],
    type: 'propagated',
    state: 'active',
  })),
} as TgwRouteTableWithRoutes);

/** The rows, as [prefix, grade] in render order. */
function gradedRows(): [string, string][] {
  return [...document.querySelectorAll('[role="button"][aria-pressed]')].map((row) => {
    const text = row.textContent ?? '';
    // Second cell is the prefix; the first is the row number, which would
    // otherwise run into it ("2" + "10.2.0.0/16").
    const cidr = (row.children[1]?.textContent ?? '').replace('⚠ ', '').replace(/[⚡⚑].*$/, '').trim();
    const grade = text.match(/(✖ No backup|△ Partial|⚡ 1 device|⚑ 1 site|✓ High|✓ Maximum|\? Unknown)/)?.[0] ?? '';
    return [cidr, grade];
  });
}

beforeEach(() => {
  useTopologyStore.setState({ routeDiffPickedVifIds: new Set(), routeDiffPickedSinkNodeId: null });
});
afterEach(cleanup);

describe('Transit Gateway route resilience panel', () => {
  it('titles itself for the TGW and groups VIF columns by DX gateway', () => {
    setup();
    expect(screen.getByText(/Route resilience — Core TGW/)).toBeTruthy();
    expect(screen.getByText('tokyo-dxgw')).toBeTruthy();
    expect(screen.getByText('osaka-dxgw')).toBeTruthy();
  });

  it('grades every prefix across both gateways, worst first', () => {
    setup();
    expect(gradedRows()).toEqual([
      ['10.1.0.0/16', '✖ No backup'],
      ['10.2.0.0/16', '⚑ 1 site'],
      ['10.3.0.0/16', '✓ High'],
    ]);
  });

  it('shows the active DX gateway from the TGW route table, and flags a missing prefix', () => {
    setup([table([{ cidr: '10.1.0.0/16', dxgw: 'gwA' }, { cidr: '10.3.0.0/16', dxgw: 'gwB' }])]);
    expect(screen.getByText('Active via')).toBeTruthy();
    const rows = [...document.querySelectorAll('[role="button"][aria-pressed]')].map((r) => r.textContent ?? '');
    expect(rows.find((t) => t.includes('10.1.0.0/16'))).toContain('tokyo-dxgw');
    expect(rows.find((t) => t.includes('10.3.0.0/16'))).toContain('osaka-dxgw');
    expect(rows.find((t) => t.includes('10.2.0.0/16'))).toContain('✖ not in TGW');
  });

  it('hides Active via when the route table is unreadable', () => {
    setup(undefined);
    expect(screen.queryByText('Active via')).toBeNull();
  });

  it('lights the picked prefix path into the TGW, and clears it on a second click', () => {
    setup();
    const row = [...document.querySelectorAll('[role="button"][aria-pressed]')]
      .find((r) => (r.textContent ?? '').includes('10.3.0.0/16'))!;
    fireEvent.click(row);
    const s = useTopologyStore.getState();
    expect([...s.routeDiffPickedVifIds].sort()).toEqual(['v1', 'v3']);
    expect(s.routeDiffPickedSinkNodeId).toBe('tgw-tgw-1');
    fireEvent.click(row);
    expect([...useTopologyStore.getState().routeDiffPickedVifIds]).toEqual([]);
  });
});
