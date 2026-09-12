import { describe, it, expect } from 'vitest';
import { buildHtmlReport } from '../useExportReport';
import { analyzeTopology } from '../../engine/recommendation-engine';
import { getMockTopology } from '../../utils/mock-data';
import type { TopologyData } from '../../types/topology';
import type { BgpPeer, VifRoute } from '../../types/aws-resources';

/**
 * The per-gateway VIF table has to print the DENOMINATOR, not just the count.
 *
 * A reader who sees "21 accepted" and a CRITICAL saying "of 20 allocated" has no
 * way to check either number from the report — the allocation was only ever inside
 * the finding's prose. The two are also different measurements (distinct prefixes
 * on the wire vs the allocation's In use counter, which no released SDK exposes),
 * so the report has to say so where the numbers are, not only in the finding.
 *
 * They are printed as one `accepted/allocated` fraction PER ADDRESS FAMILY, because
 * the quota is enforced per family — 100 each for IPv4 and IPv6, not 100 pooled.
 * A single pooled fraction is the wrong number for both: 60 v4 + 55 v6 is healthy
 * per family but reads 115/100 pooled, which looks like imminent teardown.
 */

const peerUp: BgpPeer = {
  bgpPeerId: 'p1',
  bgpPeerState: 'available',
  bgpStatus: 'up',
  asn: 65000,
  customerAddress: '169.254.0.1/30',
  amazonAddress: '169.254.0.2/30',
};

const accepted = (count: number, offset = 0): VifRoute[] =>
  Array.from({ length: count }, (_, i) => ({
    cidr: `10.${offset}.${i}.0/24`,
    addressFamily: 'ipv4' as const,
    asPath: [{ pathType: 'seq' as const, path: [65000] }],
    communities: [],
    routeDirection: 'accepted' as const,
  }));

const acceptedV6 = (count: number): VifRoute[] =>
  Array.from({ length: count }, (_, i) => ({
    cidr: `2001:db8:${i}::/48`,
    addressFamily: 'ipv6' as const,
    asPath: [{ pathType: 'seq' as const, path: [65000] }],
    communities: [],
    routeDirection: 'accepted' as const,
  }));

/**
 * A topology whose first two VIFs carry routes and a reported allocation. Built
 * from a stock scenario so every other section of the report still renders.
 */
function withPool(opts: {
  accepted: number;
  acceptedIpv6?: number;
  allocatedIpv4?: number;
  allocatedIpv6?: number;
  sessionUp?: boolean;
  poolSize?: number;
  poolFree?: number;
  duplicateDevices?: boolean;
}): TopologyData {
  const t = structuredClone(getMockTopology('high')) as TopologyData;
  const vif = t.virtualInterfaces[0]!;
  vif.bgpPeers = opts.sessionUp === false
    ? [{ ...peerUp, bgpStatus: 'down' }]
    : [peerUp];
  // Set OR clear, never inherit: the stock scenario ships its own allocation, so
  // omitting these options used to leave the mock's 100 in place while the test
  // believed it had removed it.
  vif.prefixPool = opts.allocatedIpv4 !== undefined || opts.allocatedIpv6 !== undefined
    ? {
      ...(opts.allocatedIpv4 !== undefined ? { allocatedIpv4: opts.allocatedIpv4 } : {}),
      ...(opts.allocatedIpv6 !== undefined ? { allocatedIpv6: opts.allocatedIpv6 } : {}),
    }
    : undefined;
  const conn = t.connections.find((c) => c.connectionId === vif.connectionId);
  if (conn && opts.poolSize !== undefined) {
    conn.prefixPool = { sizeIpv4: opts.poolSize, unallocatedIpv4: opts.poolFree };
  }
  const routes = [...accepted(opts.accepted), ...acceptedV6(opts.acceptedIpv6 ?? 0)];
  t.vifRoutes = new Map([[vif.virtualInterfaceId, {
    // A prefix installed on two AWS logical devices comes back twice.
    accepted: opts.duplicateDevices ? [...routes, ...routes] : routes,
    advertised: accepted(2, 200),
  }]]);
  return t;
}

const render = (t: TopologyData) =>
  buildHtmlReport(t, analyzeTopology(t), 'high', 'light');

/**
 * The virtual-interface table of the FIRST gateway card, so a figure elsewhere in the
 * document cannot satisfy an assertion.
 *
 * This used to be a single estate-wide "Routes per VIF" table. It was deleted along
 * with the rest of the estate-wide route section: a VIF's accepted-vs-allocated figure
 * is only actionable beside the gateway it reaches, and the fixture's VIFs all hang off
 * the same gateway, so one card carries them.
 */
function routesTable(html: string): string {
  const start = html.indexOf('id="gw1-vifs"');
  expect(start, 'first gateway card is missing its VIF inventory').toBeGreaterThan(-1);
  const end = html.indexOf('</table>', start);
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}

describe('per-gateway VIF table — allocation and pool', () => {
  it('prints accepted over allocated as one fraction, labelled by family', () => {
    const table = routesTable(render(withPool({ accepted: 18, allocatedIpv4: 20 })));
    expect(table).toContain('<th style="text-align:right">Accepted / Allocated</th>');
    expect(table).toContain('18/20');
    expect(table).toContain('(ipv4)');
    // Two separate columns are what this replaced; neither header may come back,
    // or the same pair is reported twice in two shapes.
    expect(table).not.toContain('>Allocated</th>');
    expect(table).not.toContain('>Port pool</th>');
  });

  it('gives IPv4 and IPv6 a fraction each, since the quota is per family', () => {
    const table = routesTable(render(withPool({
      accepted: 60, acceptedIpv6: 55, allocatedIpv4: 100, allocatedIpv6: 100,
    })));
    expect(table).toContain('60/100');
    expect(table).toContain('(ipv4)');
    expect(table).toContain('55/100');
    expect(table).toContain('(ipv6)');
    // Pooling them would read 115/100 and call a healthy dual-stack VIF critical.
    expect(table).not.toContain('115');
  });

  it('still reports a family that has an allocation but no routes', () => {
    // The common real shape: AWS allocates IPv6 headroom the customer never uses.
    // Silence would be indistinguishable from "no IPv6 allocation exists".
    const table = routesTable(render(withPool({
      accepted: 17, allocatedIpv4: 100, allocatedIpv6: 100,
    })));
    expect(table).toContain('17/100');
    expect(table).toContain('0/100');
    expect(table).toContain('(ipv6)');
  });

  it('omits a family with neither routes nor an allocation', () => {
    // `0/not reported (ipv6)` on every single-stack VIF is noise, not a measurement.
    const table = routesTable(render(withPool({ accepted: 18, allocatedIpv4: 20 })));
    expect(table).not.toContain('(ipv6)');
  });

  it('prints the fixed session limit for a public VIF, which prefix controls do not manage', () => {
    const t = withPool({ accepted: 3 });
    const vif = t.virtualInterfaces[0]!;
    vif.virtualInterfaceType = 'public';
    vif.prefixPool = undefined;
    const table = routesTable(render(t));
    expect(table).toContain('3/1,000');
    expect(table).toContain('per session');
  });

  it('says "not reported" rather than 0 when AWS returned no allocation', () => {
    // Undefined is UNKNOWN — a hosted connection, an older SDK, mock data or a
    // v1 snapshot. Printing 0 would claim the VIF can accept nothing.
    //
    // Asserted as the numerator followed by the phrase, not a bare 'not reported':
    // the removed Port pool column also printed that string, so this test used to
    // pass while reading the wrong figure entirely.
    const table = routesTable(render(withPool({ accepted: 18 })));
    expect(table).toMatch(/18\/<span class="sub">not reported<\/span>/);
    expect(table).not.toContain('18/0');
  });

  it('counts distinct prefixes, not route entries, so a two-device install is not doubled', () => {
    const table = routesTable(render(withPool({
      accepted: 18, allocatedIpv4: 20, duplicateDevices: true,
    })));
    // 18 distinct prefixes returned twice each. Counting entries produced 36,
    // which read as 180% of the allocation.
    expect(table).toContain('18/20');
    expect(table).not.toContain('36/20');
  });

  it('marks a count above the allocation and says the session could go down', () => {
    const html = render(withPool({ accepted: 21, allocatedIpv4: 20 }));
    expect(routesTable(html)).toContain('&gt; allocation');
    expect(html).toContain('Accepted above the allocation');
    expect(html).toContain('the BGP session could');
    expect(html).toContain('In use');
  });

  it('marks it the same way when the BGP session is down', () => {
    // The BGP state does not change the verdict: over the allocation is over the
    // allocation, and the reader's action is identical either way.
    const html = render(withPool({ accepted: 21, allocatedIpv4: 20, sessionUp: false }));
    expect(routesTable(html)).toContain('&gt; allocation');
    expect(html).toContain('Accepted above the allocation');
  });

  // The column footnote no longer explains that the SDK does not model AWS's own
  // In use counter. It was three sentences of provenance the reader could not act on,
  // and it ran on every export whether or not any VIF was near its allocation. The
  // actionable half — "check In use in the console" — survives in the over-allocation
  // warning above, which only appears when a VIF actually is over.
  it('keeps the footnote to what the reader has to act on', () => {
    const html = render(withPool({ accepted: 18, allocatedIpv4: 20 }));
    expect(html).not.toContain('client-direct-connect');
    // The two facts that do change what the reader does with the numbers.
    expect(html).toContain('per address family');
    expect(html).toContain('is unknown, not zero');
  });
});
