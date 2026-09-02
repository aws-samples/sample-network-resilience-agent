// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { DxgwRouteDiffPanel } from '../nodes/DxgwRouteDiffPanel';
import { computeDxgwRouteDiff, type DxgwRouteDiff } from '../../engine/vif-route-diff';
import { useTopologyStore } from '../../store/topology-store';
import { makeEmptyTopology } from '../../engine/__tests__/helpers';
import type { VifRoute } from '../../types/aws-resources';

// The panel reads the live viewport to scale itself and the node position to
// anchor itself; fixed values keep the assertions about content, not geometry.
vi.mock('@xyflow/react', () => ({
  useViewport: () => ({ x: 0, y: 0, zoom: 1 }),
  useReactFlow: () => ({
    getNode: () => ({ position: { x: 0, y: 0 }, measured: { width: 160, height: 60 } }),
  }),
}));

function route(cidr: string): VifRoute {
  return {
    cidr,
    addressFamily: cidr.includes(':') ? 'ipv6' : 'ipv4',
    asPath: [{ pathType: 'seq', path: [65000] }],
    communities: [],
    routeDirection: 'accepted',
  };
}

// A flagged row renders "⚠ 10.9.9.0/24" in one cell, so an exact-text query
// would miss precisely the rows these tests care about.
const prefixCell = (cidr: string) => (content: string) => content.replace('⚠ ', '') === cidr;

/**
 * Prefix cells in render order — the sort assertions need the sequence.
 * A shared-fate row renders its chip inside the prefix cell, so the cell's
 * textContent is "10.0.0.0/24⚡ 1 device"; strip the chip as well as the ⚠.
 */
function prefixOrder(): string[] {
  return [...document.querySelectorAll('[title]')]
    .map((el) => el.textContent ?? '')
    .filter((txt) => /^(⚠ )?(\d|[0-9a-f]*:)/.test(txt) && /\//.test(txt))
    .map((txt) => txt.replace('⚠ ', '').replace(/[⚡⚑].*$/, '').trim());
}

/** Column header cells, which are the VIF numbers — labels, not controls. */
function columnHeaders(): string[] {
  return [...document.querySelectorAll('[title]')]
    .filter((el) => /^Column \d/.test(el.getAttribute('title') ?? ''))
    .map((el) => el.textContent ?? '');
}

/**
 * Build the gateway-wide diff AND publish its topology to the store, because
 * narrowing the comparison to a subset recomputes from `topologyData` rather
 * than re-slicing the diff it was handed.
 */
function makeDiff(
  vifs: Record<string, string[]>,
  names?: Record<string, string>,
  /** Failure domains per VIF. Omitted leaves them unknown, which is never "shared". */
  placement?: Record<string, { device?: string; site?: string }>,
): DxgwRouteDiff {
  const t = makeEmptyTopology();
  t.dxGateways = [{
    directConnectGatewayId: 'dxgw-1',
    directConnectGatewayName: 'prod-dxgw',
    amazonSideAsn: 64512,
    ownerAccount: '123456789012',
    directConnectGatewayState: 'available',
  } as any];
  t.virtualInterfaces = Object.keys(vifs).map((id) => ({
    virtualInterfaceId: id,
    virtualInterfaceName: names?.[id] ?? id,
    virtualInterfaceType: 'transit',
    virtualInterfaceState: 'available',
    connectionId: `dxcon-${id}`,
    directConnectGatewayId: 'dxgw-1',
    bgpPeers: [{ bgpStatus: 'up' }],
    awsLogicalDeviceId: placement?.[id]?.device,
    location: placement?.[id]?.site,
    tags: {},
  } as any));
  t.vifRoutes = new Map(
    Object.entries(vifs).map(([id, prefixes]) => [
      id,
      { accepted: prefixes.map(route), advertised: [] },
    ]),
  );
  useTopologyStore.setState({ topologyData: t });
  return computeDxgwRouteDiff(t, 'dxgw-1')!;
}

describe('DxgwRouteDiffPanel', () => {
  beforeEach(() => {
    useTopologyStore.setState({
      theme: 'dark',
      redactMode: false,
      routeDiffPickedVifIds: new Set(),
    });
  });
  afterEach(cleanup);

  const renderPanel = (diff: DxgwRouteDiff, onClose = vi.fn()) => {
    render(
      <DxgwRouteDiffPanel
        diff={diff}
        gatewayName="prod-dxgw"
        onClose={onClose}
        nodeId="dxgw-1"
        dxGatewayId="dxgw-1"
      />,
    );
    return onClose;
  };

  /**
   * Toggle a VIF's tab by its number. The tab bar is the one selector: one tab
   * filters rows, two or more narrow the comparison.
   */
  const toggleTab = (index: number) => fireEvent.click(tab(index));

  const tab = (index: number) => screen.getByRole('button', { name: new RegExp(`^${index}\\.`) });

  /** The one search box: a substring filter for partial text, a range lookup for a
   *  complete address or block. */
  const filterBox = () => screen.getByLabelText('Filter prefixes or look up an IP');

  /**
   * Every status region's text joined. The panel has up to three — the range-lookup
   * verdict, the in-scope verdict, and the shared-fate notes — so a singular
   * `getByRole('status')` would throw on exactly the states worth asserting.
   */
  const statusText = () => screen.queryAllByRole('status').map((el) => el.textContent ?? '').join(' | ');

  it('shows the gateway name, an ALL tab, and one tab per VIF', () => {
    renderPanel(makeDiff({
      'vif-a': ['10.0.0.0/24'],
      'vif-b': ['10.0.0.0/24'],
      'vif-c': ['10.0.0.0/24'],
      'vif-d': ['10.0.0.0/24'],
    }));
    expect(screen.getByText(/Route differences —/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /^ALL/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /1\.\s*vif-a/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /4\.\s*vif-d/ })).toBeTruthy();
  });

  it('gives a 4-VIF gateway 4 columns, on the ALL tab and on every VIF tab', () => {
    // The point of the fixed-column layout: a VIF's own column is present, so
    // the table keeps its shape no matter which tab is open.
    renderPanel(makeDiff({
      'vif-a': ['10.0.0.0/24'],
      'vif-b': ['10.0.0.0/24'],
      'vif-c': ['10.0.0.0/24'],
      'vif-d': ['10.0.0.0/24'],
    }));
    expect(columnHeaders()).toEqual(['1', '2', '3', '4']);
    fireEvent.click(screen.getByRole('button', { name: /2\.\s*vif-b/ }));
    expect(columnHeaders()).toEqual(['1', '2', '3', '4']);
  });

  it('opens on ALL, showing every prefix on the gateway', () => {
    // Prefixes unique to different VIFs must all be visible without switching
    // tabs — the old per-peer layout could only ever show one VIF's list.
    renderPanel(makeDiff({
      'vif-a': ['10.1.1.0/24'],
      'vif-b': ['10.2.2.0/24'],
    }));
    expect(screen.getByText(prefixCell('10.1.1.0/24'))).toBeTruthy();
    expect(screen.getByText(prefixCell('10.2.2.0/24'))).toBeTruthy();
  });

  it('narrows rows to one VIF\'s prefixes when its tab is selected', () => {
    renderPanel(makeDiff({
      'vif-a': ['10.1.1.0/24'],
      'vif-b': ['10.2.2.0/24'],
    }));
    fireEvent.click(screen.getByRole('button', { name: /1\.\s*vif-a/ }));
    expect(screen.getByText(prefixCell('10.1.1.0/24'))).toBeTruthy();
    expect(screen.queryByText(prefixCell('10.2.2.0/24'))).toBeNull();
  });

  it('shows a VIF as carrying its own prefix', () => {
    renderPanel(makeDiff({ 'vif-a': ['10.9.9.0/24'], 'vif-b': ['10.0.0.0/24'] }));
    expect(screen.getByTitle(/vif-a accepts 10\.9\.9\.0\/24/)).toBeTruthy();
    expect(screen.getByTitle(/vif-b cannot reach 10\.9\.9\.0\/24/)).toBeTruthy();
  });

  it('sorts prefixes with no other path above redundant ones', () => {
    renderPanel(makeDiff({
      // The solo prefix sorts LAST numerically, so plain prefix order would bury
      // it below the two that are already protected.
      'vif-a': ['10.0.1.0/24', '10.0.2.0/24', '10.9.9.0/24'],
      'vif-b': ['10.0.1.0/24', '10.0.2.0/24'],
    }));
    expect(prefixOrder()).toEqual(['10.9.9.0/24', '10.0.1.0/24', '10.0.2.0/24']);
  });

  it('falls back to plain prefix order when warning-first is switched off', () => {
    renderPanel(makeDiff({
      'vif-a': ['10.0.1.0/24', '10.0.2.0/24', '10.9.9.0/24'],
      'vif-b': ['10.0.1.0/24', '10.0.2.0/24'],
    }));
    fireEvent.click(screen.getByTitle(/click to sort by prefix only/));
    expect(prefixOrder()).toEqual(['10.0.1.0/24', '10.0.2.0/24', '10.9.9.0/24']);
  });

  it('ranks a total gap above a partial one', () => {
    renderPanel(makeDiff({
      'vif-a': ['10.0.0.0/16', '192.168.1.0/24'],
      'vif-b': ['10.0.1.0/24', '192.168.1.0/24'],
    }));
    // 10.0.1.0/24 is covered by the /16; the /16 is only partly covered by it;
    // 192.168.1.0/24 is on both. Solo → partial → covered → redundant.
    expect(prefixOrder()).toEqual(['10.0.0.0/16', '10.0.1.0/24', '192.168.1.0/24']);
  });

  it('states how many prefixes have no other path', () => {
    renderPanel(makeDiff({
      'vif-a': ['10.0.1.0/24', '10.9.9.0/24'],
      'vif-b': ['10.0.1.0/24'],
    }));
    expect(screen.getByRole('status').textContent).toMatch(/single VIF with no other path/);
    expect(screen.getByRole('status').textContent).toMatch(/1 of 2/);
  });

  it('confirms redundancy when every prefix is on two or more VIFs', () => {
    renderPanel(makeDiff({ 'vif-a': ['10.0.1.0/24'], 'vif-b': ['10.0.1.0/24'] }));
    expect(screen.getByRole('status').textContent).toMatch(/carried by two or more VIFs/);
  });

  it('marks an exact match, a covering route, and an absent prefix differently', () => {
    renderPanel(makeDiff({
      'vif-a': ['10.0.1.0/24', '10.5.5.0/24', '10.9.9.0/24'],
      'vif-b': ['10.0.1.0/24', '10.5.0.0/16'],
    }));
    expect(screen.getByTitle(/vif-b accepts 10\.0\.1\.0\/24/)).toBeTruthy();
    // Covered — named with the less specific route, so the operator can tell
    // "works, coarser" from "does not work".
    expect(screen.getByTitle(/covers it via 10\.5\.0\.0\/16/)).toBeTruthy();
    expect(screen.getByTitle(/vif-b cannot reach 10\.9\.9\.0\/24/)).toBeTruthy();
  });

  it('distinguishes a partly covered aggregate from an unreachable prefix', () => {
    // vif-a's /16 is only partly carried by vif-b's two /24s. Rendering that as
    // "not reachable" would claim traffic is dropped that still flows.
    renderPanel(makeDiff({
      'vif-a': ['10.30.0.0/16'],
      'vif-b': ['10.30.1.0/24', '10.30.2.0/24'],
    }));
    const cell = screen.getByTitle(/vif-b carries only part of 10\.30\.0\.0\/16/);
    expect(cell.textContent).toBe('◐');
    // The tooltip has to name the pieces, or "partly" is not actionable.
    expect(cell.getAttribute('title')).toMatch(/10\.30\.1\.0\/24, 10\.30\.2\.0\/24/);
    expect(screen.getByRole('status').textContent).toMatch(/only partly carried by another VIF/);
    expect(screen.getByRole('status').textContent).not.toMatch(/carried by two or more VIFs/);
  });

  it('counts both gap kinds on the ALL badge', () => {
    renderPanel(makeDiff({
      // /16 partly covered by the /24, plus one prefix reachable from nowhere.
      'vif-a': ['10.30.0.0/16', '192.168.9.0/24'],
      'vif-b': ['10.30.1.0/24'],
    }));
    expect(screen.getByRole('button', { name: /^ALL/ }).textContent).toMatch(/⚠ 2/);
  });

  it('filters prefixes by text', () => {
    renderPanel(makeDiff({
      'vif-a': ['10.0.1.0/24', '192.168.5.0/24'],
      'vif-b': ['10.0.1.0/24', '192.168.5.0/24'],
    }));
    // A partial address does not parse as a range, so it stays a substring filter.
    fireEvent.change(filterBox(), { target: { value: '192.168' } });
    expect(screen.getByText('192.168.5.0/24')).toBeTruthy();
    expect(screen.queryByText('10.0.1.0/24')).toBeNull();
  });

  describe('IP lookup', () => {
    it('finds the prefix carrying a host address that is not a substring of it', () => {
      // The bug this fixes: "100.0.0.1" does not appear anywhere in the string
      // "100.0.0.0/24", so a substring filter answered "No prefixes match" for an
      // address the gateway demonstrably carries.
      renderPanel(makeDiff({
        'vif-a': ['100.0.0.0/24'],
        'vif-b': ['100.0.0.0/24'],
      }));
      fireEvent.change(filterBox(), { target: { value: '100.0.0.1' } });
      expect(statusText()).toMatch(/100\.0\.0\.1 is carried by 100\.0\.0\.0\/24/);
      expect(statusText()).toMatch(/longest matching accepted prefix/);
      expect(screen.queryByText('No prefixes match this filter')).toBeNull();
    });

    it('names the columns that reach the looked-up address', () => {
      // The follow-up question after "which prefix carries it" is "and if I lose a
      // VIF, does it still have a path" — the column numbers answer that directly.
      renderPanel(makeDiff({
        'vif-a': ['100.0.0.0/24'],
        'vif-b': ['100.0.0.0/24'],
      }));
      fireEvent.change(filterBox(), { target: { value: '100.0.0.1' } });
      expect(statusText()).toMatch(/Reachable from columns 1, 2/);
    });

    it('says there is no second path when only one column reaches it', () => {
      renderPanel(makeDiff({
        'vif-a': ['100.0.0.0/24', '10.7.0.0/24'],
        'vif-b': ['100.0.0.0/24'],
      }));
      fireEvent.change(filterBox(), { target: { value: '10.7.0.9' } });
      expect(statusText()).toMatch(/Only column 1 reaches it — no second path here/);
    });

    it('picks the longest match when prefixes overlap', () => {
      // Forwarding is longest-prefix match, so naming the /24 rather than the /16 is
      // the whole point of a lookup on a gateway carrying an aggregate.
      renderPanel(makeDiff({
        'vif-a': ['10.30.0.0/16', '10.30.7.0/24'],
        'vif-b': ['10.30.0.0/16', '10.30.7.0/24'],
      }));
      fireEvent.change(filterBox(), { target: { value: '10.30.7.9' } });
      expect(statusText()).toMatch(/is carried by 10\.30\.7\.0\/24/);
      expect(statusText()).toMatch(/of 2 overlapping/);
    });

    it('does not claim a carrier when nothing covers the query whole', () => {
      // A host address that only overlaps more specific pieces has no single
      // covering route, so the panel must not name one.
      renderPanel(makeDiff({
        'vif-a': ['10.30.1.0/24'],
        'vif-b': ['10.30.1.0/24'],
      }));
      fireEvent.change(filterBox(), { target: { value: '10.30.0.0/16' } });
      expect(statusText()).toMatch(/overlaps 1 prefix on this gateway/);
      // Scoped to the query as subject: the in-scope verdict below legitimately
      // says "carried by two or more VIFs" about the row itself.
      expect(statusText()).not.toMatch(/10\.30\.0\.0\/16 is carried by/);
    });

    it('reports an address no prefix covers', () => {
      renderPanel(makeDiff({
        'vif-a': ['10.0.1.0/24'],
        'vif-b': ['10.0.1.0/24'],
      }));
      fireEvent.change(filterBox(), { target: { value: '192.0.2.5' } });
      expect(statusText()).toMatch(/No accepted prefix on this gateway covers 192\.0\.2\.5/);
    });
  });

  describe('shared-fate warnings', () => {
    const oneDevice = () => makeDiff(
      { 'vif-a': ['10.0.0.0/24', '10.0.1.0/24'], 'vif-b': ['10.0.0.0/24', '10.0.1.0/24'] },
      undefined,
      { 'vif-a': { device: 'EqSG2-lg1a', site: 'EqSG2' }, 'vif-b': { device: 'EqSG2-lg1a', site: 'EqSG2' } },
    );

    const oneSite = () => makeDiff(
      { 'vif-a': ['10.0.0.0/24'], 'vif-b': ['10.0.0.0/24'] },
      undefined,
      { 'vif-a': { device: 'lg1a', site: 'EqSG2' }, 'vif-b': { device: 'lg1b', site: 'EqSG2' } },
    );

    it('chips every shared-logical-device row inside its prefix cell', () => {
      renderPanel(oneDevice());
      // The chip lives in the prefix cell, so the row still sorts and reads as a
      // prefix — the finding is attached to the row it is about, not to a note the
      // reader has to map back onto the matrix.
      expect(prefixOrder()).toEqual(['10.0.0.0/24', '10.0.1.0/24']);
      expect(document.body.textContent).toMatch(/10\.0\.0\.0\/24⚡ 1 device/);
      expect(screen.getAllByText('⚡ 1 device')).toHaveLength(2);
      expect(document.body.textContent).not.toMatch(/⚑ 1 site/);
    });

    it('names the device and the carriers in the row tooltip', () => {
      renderPanel(oneDevice());
      const cell = screen.getByText('10.0.0.0/24').closest('[title]')!;
      expect(cell.getAttribute('title')).toMatch(
        /carried by 2 VIFs \(1\. vif-a, 2\. vif-b\), but all of them terminate on AWS logical device EqSG2-lg1a/,
      );
      expect(cell.getAttribute('title')).toMatch(/takes every path to this prefix at once/);
    });

    it('chips a site row when the carriers differ by device', () => {
      renderPanel(oneSite());
      expect(screen.getByText('⚑ 1 site')).toBeTruthy();
      expect(document.body.textContent).not.toMatch(/⚡ 1 device/);
      const cell = screen.getByText('10.0.0.0/24').closest('[title]')!;
      expect(cell.getAttribute('title')).toMatch(/all of them sit in DX location EqSG2/);
      expect(cell.getAttribute('title')).toMatch(/Device maintenance is survivable/);
    });

    it('summarises the shared domains under the tab bar', () => {
      renderPanel(oneDevice());
      expect(statusText()).toMatch(
        /All 2 prefixes are carried by two or more VIFs — but not by independent ones:/,
      );
      expect(statusText()).toMatch(
        /⚡ 2 prefixes have NO AWS Logical Device resiliency - Direct Connect maintenance may impact them/,
      );
    });

    it('summarises a site-only gap as missing location resiliency', () => {
      renderPanel(oneSite());
      expect(statusText()).toMatch(
        /⚑ 1 prefix has NO location resiliency - a DX site event may impact it/,
      );
      expect(statusText()).not.toMatch(/AWS Logical Device resiliency/);
    });

    it('keeps the same sentence when only some of the visible rows are flagged', () => {
      // The wording must not change with the proportion affected — only the number
      // and its agreement. A count-dependent qualifier made one finding read as two.
      renderPanel(makeDiff(
        {
          'vif-a': ['10.0.0.0/24', '10.0.1.0/24'],
          'vif-b': ['10.0.0.0/24'],
          'vif-c': ['10.0.1.0/24'],
        },
        undefined,
        {
          'vif-a': { device: 'EqSG2-lg1a', site: 'EqSG2' },
          'vif-b': { device: 'EqSG2-lg1a', site: 'EqSG2' },
          'vif-c': { device: 'EqSY4-lg9z', site: 'EqSY4' },
        },
      ));
      expect(statusText()).toMatch(
        /⚡ 1 prefix has NO AWS Logical Device resiliency - Direct Connect maintenance may impact it/,
      );
    });

    it('names the shared domain per tick in the tooltip, but leaves the tick green', () => {
      // The tooltip is per column, so it earns its place. The COLOUR did not: every
      // in-scope ✓ on a flagged row would be amber (a fate exists only when all
      // carriers share a domain), making it a row-level flag repainted across the
      // data cells that the chip, prefix text, wash and outline already carry.
      renderPanel(oneDevice());
      const ticks = [...document.querySelectorAll('[title]')]
        .filter((el) => el.textContent === '✓') as HTMLElement[];
      expect(ticks).toHaveLength(4);
      for (const el of ticks) {
        expect(el.getAttribute('title')).toMatch(
          /but so do all the other carriers, from the same logical device EqSG2-lg1a/,
        );
        // Dark theme: okColor #4ade80, never warnColor #fcd34d.
        expect(el.style.color).toBe('#4ade80');
      }
    });

    it('counts shared-fate rows on the ALL tab badge', () => {
      renderPanel(oneDevice());
      const all = screen.getByRole('button', { name: /ALL/ });
      expect(all.textContent).toMatch(/⚡ 2/);
      expect(all.getAttribute('title')).toMatch(
        /2 of them read as redundant but every carrier terminates on one AWS logical device/,
      );
    });

    it('says nothing when the carriers are diverse', () => {
      renderPanel(makeDiff(
        { 'vif-a': ['10.0.0.0/24'], 'vif-b': ['10.0.0.0/24'] },
        undefined,
        { 'vif-a': { device: 'lg1a', site: 'EqSG2' }, 'vif-b': { device: 'lg9z', site: 'EqSY4' } },
      ));
      expect(document.body.textContent).not.toMatch(/⚡ 1 device|⚑ 1 site/);
    });

    it('says nothing when the failure domains are unknown', () => {
      // A mock, a v1 snapshot, or an older API response. Unknown is not shared.
      renderPanel(makeDiff({ 'vif-a': ['10.0.0.0/24'], 'vif-b': ['10.0.0.0/24'] }));
      expect(document.body.textContent).not.toMatch(/⚡ 1 device|⚑ 1 site/);
    });

    it('rescopes the summary count to the rows on screen', () => {
      // The summary is computed over what is visible, so a filter that hides a
      // chipped row must not leave it claiming that row.
      renderPanel(oneDevice());
      expect(statusText()).toMatch(/⚡ 2 prefixes have NO AWS Logical Device resiliency/);
      fireEvent.change(filterBox(), { target: { value: '10.0.1.0/24' } });
      expect(statusText()).toMatch(/⚡ 1 prefix has NO AWS Logical Device resiliency/);
    });
  });

  it('holds the prefix column steady while the address lookup narrows the rows', () => {
    // Sizing the column off the VISIBLE rows resized the panel under the cursor:
    // two characters into the lookup, the long prefixes left the view, the column
    // shrank to whatever was left, and every matrix column shifted mid-keystroke.
    // Width comes from the gateway-wide row set, which no filter can change.
    renderPanel(makeDiff({
      'vif-a': ['10.0.0.0/24', '203.0.113.128/25', '2001:db8:aaaa:bbbb::/64'],
      'vif-b': ['10.0.0.0/24', '203.0.113.128/25', '2001:db8:aaaa:bbbb::/64'],
    }));
    const header = () => screen.getByText('Prefix').style.width;
    const before = header();
    expect(before).not.toBe('');
    // Narrows to the single shortest prefix — the case that used to shrink it most.
    fireEvent.change(filterBox(), { target: { value: '10' } });
    expect(prefixOrder()).toEqual(['10.0.0.0/24']);
    expect(header()).toBe(before);
    // And a query that matches nothing at all still leaves the column alone.
    fireEvent.change(filterBox(), { target: { value: '198.51' } });
    expect(prefixOrder()).toEqual([]);
    expect(header()).toBe(before);
  });

  it('offers an address-family filter only on a dual-stack gateway', () => {
    renderPanel(makeDiff({ 'vif-a': ['10.0.1.0/24'], 'vif-b': ['10.0.1.0/24'] }));
    expect(screen.queryByRole('button', { name: 'v6' })).toBeNull();
    cleanup();
    renderPanel(makeDiff({
      'vif-a': ['10.0.1.0/24', '2001:db8::/48'],
      'vif-b': ['10.0.1.0/24', '2001:db8::/48'],
    }));
    fireEvent.click(screen.getByRole('button', { name: 'v6' }));
    expect(screen.getByText('2001:db8::/48')).toBeTruthy();
    expect(screen.queryByText('10.0.1.0/24')).toBeNull();
  });

  it('masks prefixes in redact mode', () => {
    useTopologyStore.setState({ redactMode: true });
    renderPanel(makeDiff({ 'vif-a': ['10.44.55.0/24'], 'vif-b': ['10.44.55.0/24'] }));
    expect(screen.queryByText('10.44.55.0/24')).toBeNull();
  });

  it('identifies a tab by VIF name and VIF ID, not by connection', () => {
    // On a hosted-VIF account an inferred connection is named after its VIF, so
    // the name alone cannot say which of the two a tab refers to.
    renderPanel(makeDiff(
      { 'dxvif-aaa': ['10.0.0.0/24'], 'dxvif-bbb': ['10.0.0.0/24'] },
      { 'dxvif-aaa': 'poc-primary', 'dxvif-bbb': 'poc-secondary' },
    ));
    const tab = screen.getByRole('button', { name: /1\.\s*poc-primary/ });
    expect(tab.textContent).toMatch(/dxvif-aaa/);
    expect(tab.getAttribute('title')).toMatch(
      /VIF poc-primary \(dxvif-aaa, transit\) on connection dxcon-dxvif-aaa/,
    );
  });

  it('does not repeat the ID on a tab for an unnamed VIF', () => {
    renderPanel(makeDiff({ 'vif-a': ['10.0.0.0/24'], 'vif-b': ['10.0.0.0/24'] }));
    expect(screen.getByRole('button', { name: /1\.\s*vif-a/ }).textContent).toBe('1.vif-a');
  });

  it('leaves the grading gateway-wide with a single tab selected', () => {
    // One selected VIF is a row filter, not a comparison: a VIF compared against
    // itself says nothing, so the verdicts must still be the gateway's. Here
    // 10.1.1.0/24 is on vif-a and vif-b, and it stays redundant.
    renderPanel(makeDiff({
      'vif-a': ['10.1.1.0/24'],
      'vif-b': ['10.1.1.0/24'],
      'vif-c': ['10.3.3.0/24'],
    }));
    toggleTab(1);
    expect(screen.getByText(prefixCell('10.1.1.0/24'))).toBeTruthy();
    expect(screen.queryByText(prefixCell('10.3.3.0/24'))).toBeNull();
    expect(screen.getByRole('status').textContent).toMatch(/carried by two or more VIFs/);
  });

  it('names the action before anything is selected', () => {
    // The tab bar carries two meanings now; the strip under it has to say so, or
    // the comparison is a feature nobody finds.
    renderPanel(makeDiff({ 'vif-a': ['10.1.1.0/24'], 'vif-b': ['10.1.1.0/24'] }));
    expect(screen.getByText(/Click a VIF tab for its own prefixes/)).toBeTruthy();
  });

  it('says which stage the selection is in after one tab', () => {
    // A single tab changes the rows but not the verdicts, so the strip has to
    // distinguish that from a comparison and point at the next click.
    renderPanel(makeDiff({
      'vif-a': ['10.1.1.0/24'],
      'vif-b': ['10.1.1.0/24'],
      'vif-c': ['10.3.3.0/24'],
    }));
    toggleTab(1);
    expect(screen.getByText(/click a second tab/).textContent)
      .toMatch(/graded against all 3 VIFs/);
    expect(tab(1).getAttribute('title')).toMatch(/click another tab to compare/i);
    expect(tab(2).getAttribute('title')).toMatch(/Click to add it/);
    expect(screen.getByRole('button', { name: /clear/ })).toBeTruthy();
  });

  it('regrades a prefix as solo inside a pair that excludes its other carrier', () => {
    // 10.1.1.0/24 is on vif-a and vif-b, so it is redundant gateway-wide. Compare
    // only vif-a and vif-c and it has no second path — that gap is the whole
    // reason for narrowing, and keeping the gateway-wide verdict would hide it.
    renderPanel(makeDiff({
      'vif-a': ['10.1.1.0/24'],
      'vif-b': ['10.1.1.0/24'],
      'vif-c': ['10.3.3.0/24'],
    }));
    expect(screen.getByRole('button', { name: /^ALL/ }).textContent).toMatch(/⚠ 1/);
    toggleTab(1);
    toggleTab(3);
    // Both prefixes are now solo, and both sort above nothing else — the badge
    // counts them.
    expect(screen.getByRole('button', { name: /^ALL/ }).textContent).toMatch(/⚠ 2/);
    expect(screen.getByTitle(/vif-c cannot reach 10\.1\.1\.0\/24/)).toBeTruthy();
  });

  it('shows the union of a compared pair, not just one side\'s prefixes', () => {
    // Two tabs is a comparison, so the row filter that applies to a single tab
    // must not also apply: vif-c's prefix has to stay visible next to vif-a's or
    // the pair can only ever be read one way round.
    renderPanel(makeDiff({
      'vif-a': ['10.1.1.0/24'],
      'vif-b': ['10.2.2.0/24'],
      'vif-c': ['10.3.3.0/24'],
    }));
    toggleTab(1);
    toggleTab(3);
    expect(screen.getByText(prefixCell('10.1.1.0/24'))).toBeTruthy();
    expect(screen.getByText(prefixCell('10.3.3.0/24'))).toBeTruthy();
    // vif-b is out of the comparison, so its prefix is out of the union.
    expect(screen.queryByText(prefixCell('10.2.2.0/24'))).toBeNull();
  });

  it('keeps a newly solo prefix at the top of a narrowed comparison', () => {
    // Same warning-first ordering as the gateway-wide view: 10.9.9.0/24 sorts
    // last numerically, so plain prefix order would bury the gap.
    renderPanel(makeDiff({
      'vif-a': ['10.0.1.0/24', '10.9.9.0/24'],
      'vif-b': ['10.0.1.0/24'],
      'vif-c': ['10.0.1.0/24'],
    }));
    toggleTab(1);
    toggleTab(2);
    expect(prefixOrder()).toEqual(['10.9.9.0/24', '10.0.1.0/24']);
  });

  it('keeps column numbers stable when the comparison narrows', () => {
    // "Column 3" must mean the same VIF before and after a click, so out-of-scope
    // columns stay on screen rather than renumbering the table.
    renderPanel(makeDiff({
      'vif-a': ['10.1.1.0/24'],
      'vif-b': ['10.2.2.0/24'],
      'vif-c': ['10.3.3.0/24'],
    }));
    expect(columnHeaders()).toEqual(['1', '2', '3']);
    toggleTab(1);
    toggleTab(3);
    expect(columnHeaders()).toEqual(['1', '2', '3']);
  });

  it('re-adds a VIF from its own dimmed tab', () => {
    // The tab is the only selector, so an out-of-scope tab must still toggle —
    // otherwise the way back is somewhere the reader has to be told about.
    renderPanel(makeDiff({
      'vif-a': ['10.1.1.0/24'],
      'vif-b': ['10.2.2.0/24'],
      'vif-c': ['10.3.3.0/24'],
    }));
    toggleTab(1);
    toggleTab(3);
    expect(screen.queryByText(prefixCell('10.2.2.0/24'))).toBeNull();
    toggleTab(2);
    expect(screen.getByText(prefixCell('10.2.2.0/24'))).toBeTruthy();
    expect([...useTopologyStore.getState().routeDiffPickedVifIds].sort())
      .toEqual(['vif-a', 'vif-b', 'vif-c']);
  });

  it('publishes the selected VIFs for the canvas to highlight, and clears them', () => {
    // A lone selection is lit too: the tab bar means "which VIFs are in play",
    // and one in play is still worth showing on the canvas.
    renderPanel(makeDiff({
      'vif-a': ['10.1.1.0/24'],
      'vif-b': ['10.2.2.0/24'],
      'vif-c': ['10.3.3.0/24'],
    }));
    toggleTab(1);
    expect([...useTopologyStore.getState().routeDiffPickedVifIds]).toEqual(['vif-a']);
    toggleTab(3);
    expect([...useTopologyStore.getState().routeDiffPickedVifIds].sort())
      .toEqual(['vif-a', 'vif-c']);
    fireEvent.click(screen.getByRole('button', { name: /clear/ }));
    expect(useTopologyStore.getState().routeDiffPickedVifIds.size).toBe(0);
    expect(columnHeaders()).toEqual(['1', '2', '3']);
  });

  it('returns to the gateway-wide view from the ALL tab', () => {
    renderPanel(makeDiff({
      'vif-a': ['10.1.1.0/24'],
      'vif-b': ['10.2.2.0/24'],
      'vif-c': ['10.3.3.0/24'],
    }));
    toggleTab(1);
    toggleTab(3);
    fireEvent.click(screen.getByRole('button', { name: /^ALL/ }));
    expect(screen.getByText(prefixCell('10.2.2.0/24'))).toBeTruthy();
    expect(useTopologyStore.getState().routeDiffPickedVifIds.size).toBe(0);
  });

  it('drops the canvas highlight when the panel unmounts', () => {
    // Edges lit with no panel to explain them read as a rendering bug.
    renderPanel(makeDiff({ 'vif-a': ['10.1.1.0/24'], 'vif-b': ['10.2.2.0/24'] }));
    toggleTab(1);
    toggleTab(2);
    expect(useTopologyStore.getState().routeDiffPickedVifIds.size).toBe(2);
    cleanup();
    expect(useTopologyStore.getState().routeDiffPickedVifIds.size).toBe(0);
  });

  it('calls onClose from the close button', () => {
    const onClose = renderPanel(makeDiff({ 'vif-a': ['10.0.0.0/24'], 'vif-b': ['10.0.0.0/24'] }));
    fireEvent.click(screen.getByTitle('Close'));
    expect(onClose).toHaveBeenCalled();
  });
});
