// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { VifRoutePanel } from '../nodes/VifRoutePanel';
import { useTopologyStore } from '../../store/topology-store';
import type { VifRoute, VifRoutes } from '../../types/aws-resources';

// The panel reads the live viewport to scale itself; a fixed transform keeps the
// assertions about content (not geometry) stable.
vi.mock('@xyflow/react', () => ({
  useViewport: () => ({ x: 0, y: 0, zoom: 1 }),
}));

function route(cidr: string, overrides: Partial<VifRoute> = {}): VifRoute {
  return {
    cidr,
    addressFamily: 'ipv4',
    asPath: [{ pathType: 'seq', path: [65000, 65001] }],
    communities: ['7224:8100'],
    routeDirection: 'accepted',
    ...overrides,
  };
}

function makeRoutes(): VifRoutes {
  return {
    accepted: [route('10.20.0.0/24'), route('10.20.1.0/24')],
    advertised: [route('172.31.0.0/16', { routeDirection: 'advertised', communities: [] })],
  };
}

describe('VifRoutePanel', () => {
  beforeEach(() => {
    useTopologyStore.setState({ theme: 'dark', redactMode: false });
  });
  afterEach(cleanup);

  const renderPanel = (routes: VifRoutes = makeRoutes(), onClose = vi.fn()) => {
    render(
      <VifRoutePanel routes={routes} vifId="dxvif-abc12345" onClose={onClose} anchorX={100} anchorY={200} />,
    );
    return onClose;
  };

  it('shows the VIF id and both direction tabs with counts', () => {
    renderPanel();
    expect(screen.getByText(/BGP Routes —/)).toBeTruthy();
    expect(screen.getByText(/dxvif-abc12345/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Accepted 2/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Advertised 1/ })).toBeTruthy();
  });

  it('opens on the accepted direction and lists its prefixes', () => {
    renderPanel();
    expect(screen.getByText('10.20.0.0/24')).toBeTruthy();
    expect(screen.getByText('10.20.1.0/24')).toBeTruthy();
    // The advertised prefix belongs to the other tab.
    expect(screen.queryByText('172.31.0.0/16')).toBeNull();
  });

  it('switches to advertised routes when that tab is clicked', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: /Advertised 1/ }));
    expect(screen.getByText('172.31.0.0/16')).toBeTruthy();
    expect(screen.queryByText('10.20.0.0/24')).toBeNull();
  });

  it('renders each AS-path hop as its own chip', () => {
    renderPanel();
    // Chips, not one joined string — so each ASN is individually readable.
    expect(screen.getAllByText('65000').length).toBeGreaterThan(0);
    expect(screen.getAllByText('65001').length).toBeGreaterThan(0);
  });

  it('renders communities', () => {
    renderPanel();
    expect(screen.getAllByText(/7224:8100/).length).toBeGreaterThan(0);
  });

  it('decodes documented DX community tags into plain language', () => {
    renderPanel({
      accepted: [route('10.0.0.0/24', { communities: ['7224:7300'] })],
      advertised: [],
    });
    // 7224:7300 = high local preference for AWS's return path.
    expect(screen.getByText(/High return-path preference/)).toBeTruthy();
  });

  it('leaves an unrecognized community undecoded rather than guessing', () => {
    renderPanel({
      accepted: [route('10.0.0.0/24', { communities: ['65000:1234'] })],
      advertised: [],
    });
    const chip = screen.getByText(/65000:1234/);
    expect(chip).toBeTruthy();
    // The chip carries the raw value only — no invented meaning. (The panel
    // footer separately mentions the documented tags, hence scoping to the chip.)
    expect(chip.textContent).toBe('65000:1234');
    expect(chip.getAttribute('title')).toBe('65000:1234');
  });

  it('wraps AS_SET members in braces to distinguish them from AS_SEQUENCE', () => {
    renderPanel({
      accepted: [route('10.0.0.0/24', { asPath: [{ pathType: 'set', path: [65000] }] })],
      advertised: [],
    });
    expect(screen.getAllByText('{65000}').length).toBeGreaterThan(0);
  });

  it('shows an em dash for an empty AS path', () => {
    renderPanel({
      accepted: [route('10.0.0.0/24', { asPath: [] })],
      advertised: [],
    });
    expect(screen.getByTitle(/AS path empty/)).toBeTruthy();
  });

  it('renders route age from routeInstalledAt', () => {
    const now = Date.now();
    const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
    const day = 86_400_000;
    renderPanel({
      accepted: [
        route('10.0.0.0/24', { routeInstalledAt: iso(92 * day) }),
        route('10.0.1.0/24', { routeInstalledAt: iso(5 * day) }),
        route('10.0.2.0/24', { routeInstalledAt: iso(3 * 3600_000) }),
      ],
      advertised: [],
    });
    // Console-style coarse ages: months+days, days, hours.
    expect(screen.getByText('3mo 2d')).toBeTruthy();
    expect(screen.getByText('5d')).toBeTruthy();
    expect(screen.getByText('3h')).toBeTruthy();
  });

  it('marks age unknown when AWS omits routeInstalledAt', () => {
    renderPanel({ accepted: [route('10.0.0.0/24')], advertised: [] });
    expect(screen.getByTitle('Install time not reported')).toBeTruthy();
  });

  it('shows the address family per row spelled out, not abbreviated', () => {
    renderPanel({
      accepted: [route('2001:db8::/32', { addressFamily: 'ipv6' })],
      advertised: [],
    });
    // "v4"/"v6" read as a version number rather than an address family.
    expect(screen.getByText('IPv6')).toBeTruthy();
    expect(screen.queryByText('v6')).toBeNull();
  });

  it('filters by prefix, AS number, and community', () => {
    renderPanel({
      accepted: [
        route('10.20.0.0/24', { asPath: [{ pathType: 'seq', path: [65005] }], communities: ['7224:7100'] }),
        route('192.168.7.0/24', { asPath: [{ pathType: 'seq', path: [64512] }], communities: [] }),
      ],
      advertised: [],
    });
    const box = screen.getByLabelText('Filter BGP routes');

    fireEvent.change(box, { target: { value: '192.168' } });
    expect(screen.getByText('192.168.7.0/24')).toBeTruthy();
    expect(screen.queryByText('10.20.0.0/24')).toBeNull();

    fireEvent.change(box, { target: { value: '65005' } });
    expect(screen.getByText('10.20.0.0/24')).toBeTruthy();
    expect(screen.queryByText('192.168.7.0/24')).toBeNull();

    fireEvent.change(box, { target: { value: '7224:7100' } });
    expect(screen.getByText('10.20.0.0/24')).toBeTruthy();
    expect(screen.queryByText('192.168.7.0/24')).toBeNull();

    fireEvent.change(box, { target: { value: 'nothingmatches' } });
    expect(screen.getByText(/No accepted routes match this filter/)).toBeTruthy();
  });

  describe('IP lookup in the filter box', () => {
    // The overlapping-prefix set an operator actually has to reason about: a
    // covering aggregate, a more-specific inside it, and an unrelated block.
    const overlapping = (): VifRoutes => ({
      accepted: [
        route('10.20.0.0/16'),
        route('10.20.5.0/24'),
        route('192.168.7.0/24'),
      ],
      advertised: [route('172.31.0.0/16', { routeDirection: 'advertised' })],
    });
    const box = () => screen.getByLabelText('Filter BGP routes');

    // The verdict banner names prefixes too, so row assertions read the table
    // itself: every row carries an AS-path cell, and the prefix is its sibling.
    const rowPrefixes = () => [...document.querySelectorAll('span[title^="AS path"]')]
      .map((c) => (c.parentElement!.children[0] as HTMLElement).textContent);

    it('shows the prefixes covering an address typed in full', () => {
      renderPanel(overlapping());
      // "10.20.5.7" is a substring of none of these — text matching alone finds
      // nothing, which is the bug this closes.
      fireEvent.change(box(), { target: { value: '10.20.5.7' } });
      expect(rowPrefixes()).toEqual(['10.20.0.0/16', '10.20.5.0/24']);
    });

    it('names the longest matching prefix as the one that carries the address', () => {
      renderPanel(overlapping());
      fireEvent.change(box(), { target: { value: '10.20.5.7' } });
      const verdict = screen.getByRole('status');
      expect(verdict.textContent).toContain('10.20.5.0/24');
      expect(verdict.textContent).toMatch(/longest matching accepted prefix of 2 overlapping/);
    });

    it('picks the aggregate when no more-specific covers the address', () => {
      renderPanel(overlapping());
      // Inside the /16 but outside the /24.
      fireEvent.change(box(), { target: { value: '10.20.9.1' } });
      const verdict = screen.getByRole('status');
      expect(verdict.textContent).toContain('is carried by');
      expect(verdict.textContent).toContain('10.20.0.0/16');
      expect(screen.queryByText('10.20.5.0/24')).toBeNull();
    });

    it('reads a mask as the block, so a host address with /24 finds that block', () => {
      renderPanel(overlapping());
      fireEvent.change(box(), { target: { value: '10.20.5.7/24' } });
      expect(rowPrefixes()).toEqual(['10.20.0.0/16', '10.20.5.0/24']);
    });

    it('finds the more-specifics inside a block query', () => {
      renderPanel(overlapping());
      fireEvent.change(box(), { target: { value: '10.20.0.0/16' } });
      expect(rowPrefixes()).toEqual(['10.20.0.0/16', '10.20.5.0/24']);
      // An exact prefix is covered by itself, so it is the longest match.
      expect(screen.getByRole('status').textContent).toContain('is carried by');
    });

    it('does not claim a covering route when the query only overlaps more-specifics', () => {
      renderPanel({ accepted: [route('10.20.5.0/24')], advertised: [] });
      fireEvent.change(box(), { target: { value: '10.20.0.0/16' } });
      const verdict = screen.getByRole('status');
      expect(verdict.textContent).toMatch(/overlaps 1 accepted prefix\b/);
      expect(verdict.textContent).not.toContain('is carried by');
    });

    it('says so plainly when nothing covers the address', () => {
      renderPanel(overlapping());
      fireEvent.change(box(), { target: { value: '8.8.8.8' } });
      expect(screen.getByRole('status').textContent).toMatch(/No accepted route covers/);
      expect(screen.getByText(/No accepted routes match this filter/)).toBeTruthy();
    });

    it('points at the other direction when only that side covers the address', () => {
      // The asymmetry operators chase: AWS advertises it back but we never sent it.
      renderPanel(overlapping());
      fireEvent.change(box(), { target: { value: '172.31.4.9' } });
      const verdict = screen.getByRole('status');
      expect(verdict.textContent).toContain('advertised');
      expect(verdict.textContent).toContain('172.31.0.0/16');
    });

    it('resolves an address against the default route', () => {
      renderPanel({ accepted: [route('0.0.0.0/0'), route('10.20.0.0/16')], advertised: [] });
      fireEvent.change(box(), { target: { value: '8.8.8.8' } });
      expect(screen.getByRole('status').textContent).toContain('0.0.0.0/0');
      expect(rowPrefixes()).toEqual(['0.0.0.0/0']);
    });

    it('looks up IPv6 addresses too, not just v4', () => {
      renderPanel({
        accepted: [route('2001:db8::/32', { addressFamily: 'ipv6' })],
        advertised: [],
      });
      fireEvent.change(box(), { target: { value: '2001:db8:1234::5' } });
      expect(rowPrefixes()).toEqual(['2001:db8::/32']);
      expect(screen.getByRole('status').textContent).toContain('is carried by');
    });

    it('never matches a v4 route for a v6 lookup', () => {
      renderPanel({ accepted: [route('10.20.0.0/16')], advertised: [] });
      fireEvent.change(box(), { target: { value: '2001:db8::1' } });
      expect(screen.queryByText('10.20.0.0/16')).toBeNull();
      expect(screen.getByRole('status').textContent).toMatch(/No accepted route covers/);
    });

    it('explains a miss caused by the address-family filter instead of implying a routing gap', () => {
      renderPanel({
        accepted: [route('10.20.0.0/16'), route('2001:db8::/32', { addressFamily: 'ipv6' })],
        advertised: [],
      });
      fireEvent.click(screen.getByRole('button', { name: 'v4' }));
      fireEvent.change(box(), { target: { value: '2001:db8::1' } });
      const verdict = screen.getByRole('status');
      expect(verdict.textContent).toMatch(/is IPv6/);
      expect(verdict.textContent).toMatch(/currently IPv4 only/);
      expect(verdict.textContent).not.toMatch(/No accepted route covers/);
    });

    it('keeps substring filtering for a partial address', () => {
      renderPanel(overlapping());
      // "10.20" is not a complete address, so it must stay a text match — and
      // must not resolve to some range.
      fireEvent.change(box(), { target: { value: '10.20' } });
      expect(screen.getByText('10.20.0.0/16')).toBeTruthy();
      expect(screen.getByText('10.20.5.0/24')).toBeTruthy();
      expect(screen.queryByRole('status')).toBeNull();
    });

    it('does not turn a community filter into an IP lookup', () => {
      // "7224:7100" is two colon-separated numbers; reading it as IPv6 would
      // break community filtering.
      renderPanel({
        accepted: [
          route('10.20.0.0/24', { communities: ['7224:7100'] }),
          route('192.168.7.0/24', { communities: [] }),
        ],
        advertised: [],
      });
      fireEvent.change(box(), { target: { value: '7224:7100' } });
      expect(screen.getByText('10.20.0.0/24')).toBeTruthy();
      expect(screen.queryByText('192.168.7.0/24')).toBeNull();
      expect(screen.queryByRole('status')).toBeNull();
    });

    it('masks the looked-up address in the verdict when redact mode is on', () => {
      useTopologyStore.setState({ redactMode: true });
      renderPanel(overlapping());
      fireEvent.change(box(), { target: { value: '10.20.5.7' } });
      // The typed address is as sensitive as the routes themselves — a redacted
      // screenshot must not leak it back through the summary line.
      const verdict = screen.getByRole('status');
      expect(verdict.textContent).not.toContain('10.20.5.7');
      expect(verdict.textContent).not.toContain('10.20.5.0/24');
    });

    it('still resolves the lookup while redact mode masks the display', () => {
      useTopologyStore.setState({ redactMode: true });
      renderPanel(overlapping());
      fireEvent.change(box(), { target: { value: '10.20.5.7' } });
      // Matching runs on real values, so the operator still gets an answer.
      expect(screen.getByRole('status').textContent).toContain('is carried by');
    });
  });

  it('toggles between prefix and age sort', () => {
    const now = Date.now();
    const day = 86_400_000;
    renderPanel({
      accepted: [
        route('10.9.0.0/24', { routeInstalledAt: new Date(now - 2 * day).toISOString() }),
        route('10.1.0.0/24', { routeInstalledAt: new Date(now - 90 * day).toISOString() }),
      ],
      advertised: [],
    });
    const cidrOrder = () => screen.getAllByTitle(/^10\./).map((e) => e.textContent);
    // Default: numeric prefix order.
    expect(cidrOrder()).toEqual(['10.1.0.0/24', '10.9.0.0/24']);
    fireEvent.click(screen.getByText('Prefix ▾'));
    // Age sort puts the oldest route first.
    expect(cidrOrder()).toEqual(['10.1.0.0/24', '10.9.0.0/24']);
    expect(screen.getByText('Age ▾')).toBeTruthy();
  });

  it('explains that a blank Communities cell is not the same as untagged', () => {
    renderPanel();
    // The ambiguity worth pre-empting: AWS strips its own communities, so empty
    // means "not visible", not "no communities set".
    expect(screen.getByText(/not that the route is untagged/)).toBeTruthy();
    expect(screen.getByText(/strips its own internal communities/)).toBeTruthy();
  });

  it('names the local-preference tags and what they actually control', () => {
    renderPanel();
    // All three documented tags, plus the direction they affect — the tags apply
    // to prefixes YOU advertise and steer AWS's return path.
    expect(screen.getByText('7224:7100')).toBeTruthy();
    expect(screen.getByText('7224:7200')).toBeTruthy();
    expect(screen.getByText('7224:7300')).toBeTruthy();
    expect(screen.getByText(/prefixes you advertise on a private or transit VIF/)).toBeTruthy();
  });

  it('masks CIDRs, AS paths, and communities when redact mode is on', () => {
    useTopologyStore.setState({ redactMode: true });
    renderPanel();
    // Routes are the most sensitive slice in the app — nothing real may render.
    expect(screen.queryByText('10.20.0.0/24')).toBeNull();
    expect(screen.queryByText('65000 65001')).toBeNull();
    expect(screen.queryByText('7224:8100')).toBeNull();
  });

  it('hides the address-family filter unless both families are present', () => {
    renderPanel();
    expect(screen.queryByRole('button', { name: 'v6' })).toBeNull();
  });

  it('filters by address family when both v4 and v6 are present', () => {
    renderPanel({
      accepted: [
        route('10.0.0.0/24'),
        route('2001:db8::/32', { addressFamily: 'ipv6' }),
      ],
      advertised: [],
    });
    fireEvent.click(screen.getByRole('button', { name: 'v6' }));
    expect(screen.getByText('2001:db8::/32')).toBeTruthy();
    expect(screen.queryByText('10.0.0.0/24')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'v4' }));
    expect(screen.getByText('10.0.0.0/24')).toBeTruthy();
    expect(screen.queryByText('2001:db8::/32')).toBeNull();
  });

  it('reports an empty direction instead of rendering a blank list', () => {
    renderPanel({ accepted: [], advertised: [route('10.0.0.0/24', { routeDirection: 'advertised' })] });
    expect(screen.getByText(/No accepted routes/)).toBeTruthy();
  });

  it('invokes onClose from the close button', () => {
    const onClose = renderPanel();
    fireEvent.click(screen.getByTitle('Close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders in both dark and light themes', () => {
    renderPanel();
    expect(screen.getByText('10.20.0.0/24')).toBeTruthy();
    cleanup();
    useTopologyStore.setState({ theme: 'light' });
    renderPanel();
    expect(screen.getByText('10.20.0.0/24')).toBeTruthy();
  });
});
