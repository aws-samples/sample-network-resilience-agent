import { describe, it, expect } from 'vitest';
import { buildQuickView, QUICKVIEW_COLUMNS } from '../report-quickview';
import type { QuickViewCell, QuickViewColumnId, QuickViewRow } from '../report-quickview';
import { analyzeTopology } from '../recommendation-engine';
import { getMockTopology } from '../../utils/mock-data';
import type { MockScenario } from '../../utils/shared';
import type { TopologyData } from '../../types/topology';

/**
 * The numeric impact table that heads the report.
 *
 * The assertions here guard the two properties that make it readable and that a
 * refactor can silently break: every cell is a count over a stated population
 * (so the table ranks itself), and an unmeasured cell reads as unmeasured rather
 * than as a pass. The `sharedDevice` counting rule gets the most coverage because
 * it is the one column whose rule is not obvious from its label — four links over
 * two devices is fine, two links over one device is not, and a lone link is
 * neither.
 */

const SCENARIOS: MockScenario[] = ['noResiliency', 'devTest', 'high', 'maximum', 'crossAccount'];

function view(scenario: MockScenario) {
  const topology = getMockTopology(scenario);
  return buildQuickView(topology, analyzeTopology(topology));
}

const cell = (row: QuickViewRow, id: QuickViewColumnId) => {
  const c = row.cells.get(id);
  expect(c, `row ${row.key} is missing column ${id}`).toBeDefined();
  return c!;
};

const totalRow = (rows: QuickViewRow[]) => {
  const r = rows.find((x) => x.kind === 'total');
  expect(r).toBeDefined();
  return r!;
};

type ConnSpec = { connectionId: string; location: string; awsLogicalDeviceId?: string };

/** A topology carrying only connections — enough for the locations and sharedDevice columns. */
const withConnections = (conns: ConnSpec[]): TopologyData => {
  const base = getMockTopology('noResiliency');
  return {
    ...base,
    connections: conns.map((c) => ({
      ...base.connections[0],
      connectionId: c.connectionId,
      location: c.location,
      awsLogicalDeviceId: c.awsLogicalDeviceId,
    })),
  };
};

describe('quick-view shape', () => {
  it.each(SCENARIOS)('gives every row a cell for every column (%s)', (scenario) => {
    const qv = view(scenario);
    expect(qv.rows.length).toBeGreaterThan(0);
    for (const row of qv.rows) {
      // A missing cell renders as an empty td, which reads as "nothing wrong".
      for (const col of QUICKVIEW_COLUMNS) expect(row.cells.has(col.id)).toBe(true);
    }
  });

  it.each(SCENARIOS)('ends with exactly one account-total row (%s)', (scenario) => {
    const rows = view(scenario).rows;
    expect(rows.filter((r) => r.kind === 'total')).toHaveLength(1);
    expect(rows[rows.length - 1].kind).toBe('total');
  });

  it.each(SCENARIOS)('never states a figure without a population or a reason (%s)', (scenario) => {
    for (const row of view(scenario).rows) {
      for (const col of QUICKVIEW_COLUMNS) {
        // `scale` is `na` because it is not a verdict at all, not because it went
        // unmeasured — it is the population the columns to its right are counted over.
        if (col.id === 'scale') continue;
        const c = cell(row, col.id);
        if (c.severity !== 'na') continue;
        // An ungraded cell must always say why. A bare integer is the one figure it
        // may not carry: `0` with no denominator reads as a measured pass, whereas
        // `—`, prose, or an explicit `0 of 1` do not.
        expect(c.detail.length).toBeGreaterThan(0);
        expect(c.figure).not.toMatch(/^\d+$/);
      }
    }
  });

  it('orders gateway rows by the order the report already uses', () => {
    const topology = getMockTopology('noResiliency');
    const assessment = analyzeTopology(topology);
    const ids = assessment.perDxGateway.map((g) => g.dxGatewayId);
    expect(ids.length).toBeGreaterThan(1);
    const reversed = buildQuickView(topology, assessment, [...ids].reverse());
    const seen = reversed.rows.filter((r) => r.kind === 'dxgw').map((r) => r.targetId);
    expect(seen).toEqual([...ids].reverse());
  });
});

describe('links on one device', () => {
  const exposure = (conns: ConnSpec[]) => {
    const topology = withConnections(conns);
    const qv = buildQuickView(topology, analyzeTopology(topology));
    return cell(totalRow(qv.rows), 'sharedDevice');
  };

  it('flags two links sharing one device at one site', () => {
    const c = exposure([
      { connectionId: 'dxcon-a', location: 'EqSG2', awsLogicalDeviceId: 'EqSG2-lg1a' },
      { connectionId: 'dxcon-b', location: 'EqSG2', awsLogicalDeviceId: 'EqSG2-lg1a' },
    ]);
    expect(c.figure).toBe('2 of 2');
    expect(c.severity).toBe('critical');
    expect(c.detail).toContain('EqSG2');
  });

  it('does not flag four links spread over two devices at one site', () => {
    const c = exposure([
      { connectionId: 'dxcon-a', location: 'EqSG2', awsLogicalDeviceId: 'EqSG2-lg1a' },
      { connectionId: 'dxcon-b', location: 'EqSG2', awsLogicalDeviceId: 'EqSG2-lg1a' },
      { connectionId: 'dxcon-c', location: 'EqSG2', awsLogicalDeviceId: 'EqSG2-lg1b' },
      { connectionId: 'dxcon-d', location: 'EqSG2', awsLogicalDeviceId: 'EqSG2-lg1b' },
    ]);
    expect(c.figure).toBe('0 of 4');
    expect(c.severity).toBe('ok');
  });

  it('does not flag a lone link — it has no false redundancy to expose', () => {
    const c = exposure([
      { connectionId: 'dxcon-a', location: 'EqSG2', awsLogicalDeviceId: 'EqSG2-lg1a' },
    ]);
    expect(c.figure).toBe('0 of 1');
    expect(c.severity).not.toBe('critical');
  });

  it('counts each affected site and names them all', () => {
    // Naming only the worst site beside a figure of "4 of 4" would read as if the
    // other two links were fine.
    const c = exposure([
      { connectionId: 'dxcon-a', location: 'EqSG2', awsLogicalDeviceId: 'EqSG2-lg1a' },
      { connectionId: 'dxcon-b', location: 'EqSG2', awsLogicalDeviceId: 'EqSG2-lg1a' },
      { connectionId: 'dxcon-c', location: 'EqTY2', awsLogicalDeviceId: 'EqTY2-lg1a' },
      { connectionId: 'dxcon-d', location: 'EqTY2', awsLogicalDeviceId: 'EqTY2-lg1a' },
    ]);
    expect(c.figure).toBe('4 of 4');
    expect(c.detail).toContain('EqSG2');
    expect(c.detail).toContain('EqTY2');
  });

  it('reports an unreadable device as unconfirmed, not as a pass', () => {
    // Partner-hosted connections carry no awsLogicalDeviceId. Two such links at one
    // site could be on one device or two, and AWS will not say which.
    const c = exposure([
      { connectionId: 'dxcon-a', location: 'EqSG2' },
      { connectionId: 'dxcon-b', location: 'EqSG2' },
    ]);
    expect(c.severity).toBe('warning');
    expect(c.detail).toMatch(/not reported/);
  });

  it('is not a sum of the gateway rows', () => {
    // One device spanning several gateways gives each gateway row 0 — each survives
    // on its other site — while the account loses links from all of them at once.
    // `high` puts four links on one EqSG2 device and two on one EqSG3 device.
    const qv = view('high');
    const total = cell(totalRow(qv.rows), 'sharedDevice');
    const perGateway = qv.rows
      .filter((r) => r.kind !== 'total')
      .map((r) => Number.parseInt(cell(r, 'sharedDevice').figure, 10) || 0)
      .reduce((a, b) => a + b, 0);
    expect(total.figure).toBe('6 of 6');
    expect(Number.parseInt(total.figure, 10)).toBeGreaterThan(perGateway);
  });
});

/**
 * The `conn·dev` chips folded into this column from the per-gateway assessment
 * table. They answer "where do I add a link", which a bare location count cannot:
 * 2+1, 1+2 and a 2+1 whose pair shares one AWS device all read as "2 locations".
 *
 * The load-bearing property is the one the last two tests here guard — the chips
 * are built from `groupBySite`, the same grouping the `sharedDevice` column counts
 * over, and not from `getLocationLinkCounts` in `sla-gating.ts`, which treats a
 * link with no `awsLogicalDeviceId` as a device of its own. Swapping the source
 * back would print `2·2` in green immediately left of a `device not reported`
 * warning about the same two links.
 */
describe('links per site (conn·dev) chips', () => {
  const rowsFor = (conns: ConnSpec[]) => {
    const topology = withConnections(conns);
    const qv = buildQuickView(topology, analyzeTopology(topology));
    const row = totalRow(qv.rows);
    return { locations: cell(row, 'locations'), sharedDevice: cell(row, 'sharedDevice') };
  };

  const shape = (c: QuickViewCell) =>
    (c.chips ?? []).map((x) => `${x.label} ${x.value} [${x.state}]`);

  it('splits connections from devices, so full bandwidth on one device is not a pass', () => {
    const { locations } = rowsFor([
      { connectionId: 'dxcon-a', location: 'EqSG2', awsLogicalDeviceId: 'EqSG2-lg1a' },
      { connectionId: 'dxcon-b', location: 'EqSG2', awsLogicalDeviceId: 'EqSG2-lg1a' },
    ]);
    expect(shape(locations)).toEqual(['EqSG2 2·1 [weak]']);
    // The figure stays the location COUNT; the chips are the detail line.
    expect(locations.figure).toBe('1');
    expect(locations.chips?.[0].title).toContain('2 connections on 1 AWS logical device');
    expect(locations.chips?.[0].title).toContain('a device outage cuts this location entirely');
  });

  it('reads a device-redundant site as ok', () => {
    const { locations } = rowsFor([
      { connectionId: 'dxcon-a', location: 'EqSG2', awsLogicalDeviceId: 'EqSG2-lg1a' },
      { connectionId: 'dxcon-b', location: 'EqSG2', awsLogicalDeviceId: 'EqSG2-lg1b' },
    ]);
    expect(shape(locations)).toEqual(['EqSG2 2·2 [ok]']);
    expect(locations.chips?.[0].title).not.toContain('cuts this location');
  });

  it('leads with the site to fix', () => {
    // The 2+1 shape. The reader's question is where to add a link, so the answer has
    // to be the leftmost chip rather than something to hunt for.
    const { locations } = rowsFor([
      { connectionId: 'dxcon-a', location: 'EqSG2', awsLogicalDeviceId: 'EqSG2-lg1a' },
      { connectionId: 'dxcon-b', location: 'EqSG2', awsLogicalDeviceId: 'EqSG2-lg1b' },
      { connectionId: 'dxcon-c', location: 'EqTY2', awsLogicalDeviceId: 'EqTY2-lg1a' },
    ]);
    expect(shape(locations)).toEqual(['EqTY2 1·1 [weak]', 'EqSG2 2·2 [ok]']);
  });

  it('will not claim redundancy AWS never confirmed, and agrees with the cell beside it', () => {
    // Partner-hosted connections carry no awsLogicalDeviceId. `getLocationLinkCounts`
    // would count these as two devices and render `2·2` in green — directly left of
    // the sharedDevice cell warning that the device was not reported.
    const { locations, sharedDevice } = rowsFor([
      { connectionId: 'dxcon-a', location: 'EqSG2' },
      { connectionId: 'dxcon-b', location: 'EqSG2' },
    ]);
    expect(shape(locations)).toEqual(['EqSG2 2·? [unknown]']);
    expect(locations.chips?.[0].title).toMatch(/unconfirmed/);
    // The two adjacent cells must not disagree about the same two links.
    expect(sharedDevice.severity).toBe('warning');
    expect(sharedDevice.detail).toMatch(/not reported/);
  });

  it('reads a lone device-less link as one link on one device, never zero', () => {
    // A single link IS one link on one device whatever AWS calls it, so `1·?` would
    // invent a doubt and `1·0` would just be wrong.
    const { locations } = rowsFor([{ connectionId: 'dxcon-a', location: 'EqSG2' }]);
    expect(shape(locations)).toEqual(['EqSG2 1·1 [weak]']);
  });

  it('does not turn links AWS gave no location for into a location', () => {
    const { locations } = rowsFor([
      { connectionId: 'dxcon-a', location: 'EqSG2', awsLogicalDeviceId: 'EqSG2-lg1a' },
      { connectionId: 'dxcon-b', location: '', awsLogicalDeviceId: 'orphan-lg1a' },
    ]);
    // One chip, and the chip count matches the figure. A synthetic `unknown 1·1`
    // chip would name a site the reader cannot go and add a link at.
    expect(shape(locations)).toEqual(['EqSG2 1·1 [weak]']);
    expect(locations.figure).toBe('1');
  });

  it('says so, and emits no chips, when a gateway carries no connections', () => {
    const qv = view('maximum');
    const empty = qv.rows.find((r) => cell(r, 'scale').figure === '0 / 0');
    expect(empty, 'maximum should carry an unattached gateway').toBeDefined();
    const c = cell(empty!, 'locations');
    expect(c.chips).toBeUndefined();
    expect(c.detail).toBe('no connections');
  });

  it('gives the account total its own chips rather than reusing a gateway row', () => {
    // `high` puts four EqSG2 links on one device but only two of them reach any one
    // gateway, so the two rows must differ.
    const qv = view('high');
    expect(shape(cell(totalRow(qv.rows), 'locations'))).toContain('EqSG2 4·1 [weak]');
    const gw = qv.rows.find((r) => r.kind === 'dxgw');
    expect(shape(cell(gw!, 'locations'))).toContain('EqSG2 2·1 [weak]');
  });

  it.each(SCENARIOS)('gives every located connection exactly one chip (%s)', (scenario) => {
    for (const row of view(scenario).rows) {
      const c = cell(row, 'locations');
      // The count above the chips and the number of chips are the same fact. If they
      // can drift, one of them is lying.
      expect(shape(c)).toHaveLength(Number(c.figure));
    }
  });
});

describe('prefixes with one path', () => {
  it('counts a prefix once for the account however many gateways single-path it', () => {
    const qv = view('devTest');
    const total = cell(totalRow(qv.rows), 'soloPrefixes');
    // Ratio, not a bare count, so a 0 is visibly out of a real population.
    expect(total.figure).toMatch(/^\d+ of \d+$/);
    const [solo, all] = total.figure.split(' of ').map(Number);
    expect(solo).toBeLessThanOrEqual(all);
    expect(total.section).toBe('route-analysis');
  });

  it('reads as unmeasured, not as zero, when BGP routes were never fetched', () => {
    const base = getMockTopology('devTest');
    const topology: TopologyData = { ...base, vifRoutes: undefined };
    const qv = buildQuickView(topology, analyzeTopology(topology));
    expect(qv.routesUnavailable).toBe(true);
    for (const row of qv.rows) {
      const c = cell(row, 'soloPrefixes');
      expect(c.severity).toBe('na');
      expect(c.figure).toBe('—');
      expect(c.detail).toMatch(/not fetched/);
    }
  });
});

describe('prefix quota', () => {
  it.each(SCENARIOS)('only calls a VIF over quota when it is past 100% (%s)', (scenario) => {
    for (const row of view(scenario).rows) {
      const c = cell(row, 'prefixQuota');
      if (c.severity === 'critical') expect(c.detail).toMatch(/over quota/);
      if (/none over/.test(c.detail)) expect(c.severity).not.toBe('critical');
    }
  });

  it('names the VIFs behind the figure so the report can flash them', () => {
    const qv = view('devTest');
    const flagged = qv.rows
      .map((r) => cell(r, 'prefixQuota'))
      .filter((c) => c.severity === 'warning' || c.severity === 'critical');
    expect(flagged.length).toBeGreaterThan(0);
    for (const c of flagged) expect(c.focusIds?.length).toBeGreaterThan(0);
  });
});

/**
 * The tier is a property of the ROW, not a cell: it is the one fact here that is not
 * a count over a population, and it renders as badges in the row head beside the
 * gateway name. See `renderRowTier` in `useExportReport.ts`.
 */
describe('resiliency tier', () => {
  it('grades per gateway and reports the weakest for the account', () => {
    const total = totalRow(view('maximum').rows).tier;
    expect(total.currentLevel).toBe('maximum');
    expect(total.note).toMatch(/^weakest of /);
    // No account-level target: each gateway carries its own, and adopting the weakest
    // gateway's target would understate the work across the rest of the estate.
    expect(total.targetLevel).toBeNull();
  });

  it.each(SCENARIOS)('never claims Maximum Resiliency is anything but ok (%s)', (scenario) => {
    for (const row of view(scenario).rows) {
      if (row.tier.currentLevel === 'maximum') expect(row.tier.severity).toBe('ok');
    }
  });

  it('offers no target when the gateway is already at its ceiling', () => {
    for (const scenario of SCENARIOS) {
      for (const row of view(scenario).rows) {
        if (row.tier.currentLevel === 'maximum') expect(row.tier.targetLevel).toBeNull();
      }
    }
  });

  it('grades no tier for a gateway that carries no VIF, rather than grading it zero', () => {
    // `maximum` has an unattached second gateway. Asserting a tier for a path that
    // does not exist would assert an SLA for it too.
    const qv = view('maximum');
    const unattached = qv.rows.find((r) => cell(r, 'scale').figure === '0 / 0');
    expect(unattached).toBeDefined();
    expect(unattached!.tier.currentLevel).toBeNull();
    expect(unattached!.tier.note.length).toBeGreaterThan(0);
  });

  it.each(SCENARIOS)('gives every row a tier object, so the row head never renders blank (%s)', (scenario) => {
    for (const row of view(scenario).rows) {
      expect(row.tier).toBeDefined();
      // Either a badge or a stated reason there is none — never nothing.
      expect(row.tier.currentLevel !== null || row.tier.note.length > 0).toBe(true);
    }
  });
});

describe('column definitions', () => {
  it('states a counting rule for every column', () => {
    for (const col of QUICKVIEW_COLUMNS) {
      expect(col.label.length).toBeGreaterThan(0);
      expect(col.sublabel.length).toBeGreaterThan(0);
      // The blurb is the legend, and it is where the rule behind the number lives.
      expect(col.blurb.length).toBeGreaterThan(40);
    }
  });

  it('has unique column ids', () => {
    const ids = QUICKVIEW_COLUMNS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
