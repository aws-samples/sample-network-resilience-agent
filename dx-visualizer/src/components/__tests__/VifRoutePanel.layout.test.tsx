// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { VifRoutePanel } from '../nodes/VifRoutePanel';
import { useTopologyStore } from '../../store/topology-store';
import type { VifRoute, VifRoutes } from '../../types/aws-resources';

// Zoom is fixed at 1 so widths are readable in px.
vi.mock('@xyflow/react', () => ({
  useViewport: () => ({ x: 0, y: 0, zoom: 1 }),
}));

function route(cidr: string, hops: number[]): VifRoute {
  return {
    cidr,
    addressFamily: 'ipv4',
    asPath: hops.length ? [{ pathType: 'seq', path: hops }] : [],
    communities: [],
    routeDirection: 'accepted',
  };
}

const px = (v: string) => Number.parseFloat(v.replace('px', '')) || 0;

// The panel portals into document.body. Identify it by the width/left/top inline
// styles the component sets, which is what these assertions are about.
function panelEl(): HTMLElement {
  const el = [...document.body.querySelectorAll('div')].find((d) => {
    const s = (d as HTMLElement).style;
    return s.width !== '' && s.left !== '' && s.top !== '' && s.maxHeight !== '';
  });
  if (!el) throw new Error('panel not rendered');
  return el as HTMLElement;
}

// The prefix cell is the first child of the row that holds the AS-path cell.
function prefixCellWidths(): number[] {
  return [...document.querySelectorAll('span[title^="AS path"]')].map((c) => {
    const cell = c.parentElement!.children[0] as HTMLElement;
    return px(cell.style.width);
  });
}

function renderPanel(routes: VifRoutes) {
  render(
    <VifRoutePanel routes={routes} vifId="dxvif-1" onClose={() => {}} anchorX={100} anchorY={100} />,
  );
}

describe('VifRoutePanel layout', () => {
  beforeEach(() => {
    useTopologyStore.setState({ theme: 'dark', redactMode: false });
  });
  afterEach(cleanup);

  it('sizes the prefix column to the longest prefix, not a fixed width', () => {
    renderPanel({ accepted: [route('10.1.0.0/16', [65006])], advertised: [] });
    const narrow = prefixCellWidths()[0];
    cleanup();

    renderPanel({
      accepted: [route('2001:0db8:85a3:0000:0000:8a2e:0370:7334/128', [65006])],
      advertised: [],
    });
    const wide = prefixCellWidths()[0];

    // A table of short IPv4 prefixes must not reserve IPv6-sized space.
    expect(wide).toBeGreaterThan(narrow);
  });

  it('never shrinks a column below its own header label', () => {
    // A single /32 should not collapse the column so far that "Prefix" clips.
    renderPanel({ accepted: [route('1.1.1.1/32', [65006])], advertised: [] });
    expect(prefixCellWidths()[0]).toBeGreaterThanOrEqual('Prefix'.length * 4.6);
  });

  it('keeps the panel within the viewport even for a very long prefix', () => {
    // No arbitrary character cap: the panel widens to fit its content, and the
    // zoom clamp still guarantees it stays on screen.
    const veryLong = '2001:0db8:85a3:0000:0000:8a2e:0370:7334/128'.padEnd(80, '0');
    renderPanel({ accepted: [route(veryLong, [65006])], advertised: [] });
    const panel = panelEl();
    expect(px(panel.style.width)).toBeLessThanOrEqual(window.innerWidth);
    expect(px(panel.style.left) + px(panel.style.width)).toBeLessThanOrEqual(window.innerWidth);
  });

  it('sizes the AS path column to its widest path rather than flexing', () => {
    const deep = [65006, 65002, 65010, 65005, 65003, 65001];
    renderPanel({ accepted: [route('10.1.0.0/16', deep)], advertised: [] });
    const wide = px((document.querySelector('span[title^="AS path"]') as HTMLElement).style.width);
    cleanup();

    renderPanel({ accepted: [route('10.1.0.0/16', [65006])], advertised: [] });
    const cell = document.querySelector('span[title^="AS path"]') as HTMLElement;
    const narrow = px(cell.style.width);

    // The bug: the column flexed to 482px for content needing ~286px, so a
    // single-hop table reserved room for a 6-hop path.
    expect(wide).toBeGreaterThan(narrow);
    expect(cell.style.width).not.toBe('');
    expect(cell.style.overflow).not.toBe('hidden');
  });

  it('narrows the whole panel when every column holds short content', () => {
    renderPanel({ accepted: [route('1.1.1.1/32', [65006])], advertised: [] });
    const narrowPanel = px(panelEl().style.width);
    cleanup();

    const deep = [65006, 65002, 65010, 65005, 65003, 65001];
    renderPanel({ accepted: [route('172.16.255.128/32', deep)], advertised: [] });
    expect(px(panelEl().style.width)).toBeGreaterThan(narrowPanel);
  });

  it('reserves the scrollbar width in the header so columns stay aligned', () => {
    renderPanel({ accepted: [route('10.1.0.0/16', [65006])], advertised: [] });
    const header = [...document.querySelectorAll('span')]
      .find((s) => s.textContent === 'Prefix')!.parentElement!;
    const spacer = header.lastElementChild as HTMLElement;
    // The body scrolls and the header does not, so without a gutter the columns
    // drifted apart by the scrollbar width.
    expect(spacer.getAttribute('aria-hidden')).toBe('true');
    expect(px(spacer.style.width)).toBeGreaterThan(0);
  });

  it('renders every hop of a deep real-world AS path', () => {
    // Observed on a live transit VIF fronting an aggregation network.
    const hops = [65006, 65002, 65010, 65005, 65003, 65001];
    renderPanel({ accepted: [route('100.65.0.0/30', hops)], advertised: [] });
    for (const h of hops) {
      expect(screen.getAllByText(String(h)).length).toBeGreaterThan(0);
    }
    expect(screen.getByTitle(`AS path: ${hops.join(' → ')}`)).toBeTruthy();
  });

  it('keeps the panel inside the viewport when anchored past the right edge', () => {
    // happy-dom defaults to 1024x768; anchor far beyond it.
    renderPanel({ accepted: [route('10.1.0.0/16', [65006])], advertised: [] });
    cleanup();
    render(
      <VifRoutePanel
        routes={{ accepted: [route('10.1.0.0/16', [65006])], advertised: [] }}
        vifId="dxvif-1"
        onClose={() => {}}
        anchorX={99999}
        anchorY={99999}
      />,
    );
    const panel = panelEl();
    const left = px(panel.style.left);
    const top = px(panel.style.top);
    const width = px(panel.style.width);
    // Clamped so the panel can't be pushed off-screen with no way to reach it.
    expect(left + width).toBeLessThanOrEqual(window.innerWidth);
    expect(top).toBeLessThanOrEqual(window.innerHeight);
    expect(left).toBeGreaterThanOrEqual(0);
  });

  it('never renders wider than the viewport, even at high canvas zoom', () => {
    // Regression: panelWidth was `640 * zoom`, so zooming in pushed the AS path
    // column off-screen entirely.
    renderPanel({ accepted: [route('10.1.0.0/16', [65006])], advertised: [] });
    const panel = panelEl();
    expect(px(panel.style.width)).toBeLessThanOrEqual(window.innerWidth);
  });
});
