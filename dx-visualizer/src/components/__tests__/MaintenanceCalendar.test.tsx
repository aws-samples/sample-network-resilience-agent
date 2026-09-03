// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MaintenanceCalendar } from '../MaintenanceCalendar';
import { useTopologyStore } from '../../store/topology-store';
import type { DxNode, DxEdge, TopologyData } from '../../types/topology';
import type { DxMaintenanceEvent } from '../../types/aws-resources';

// Passthrough — the component only uses this to style its trigger button.
const iconBtnClass = () => 'icon-btn';

// The real AWS PHD description does NOT list the affected dxcon-*/dxvif-* IDs
// inline — only the notification email and console's "Affected resources" tab
// do. These tests pin the fix that surfaces `affectedResourceIds` (which we
// already fetch via DescribeAffectedEntities) as its own chip section, so the
// description string deliberately omits the IDs to mirror production.
const DESCRIPTION_WITHOUT_IDS =
  'Planned maintenance has been scheduled on an AWS Direct Connect endpoint in ' +
  'KDDI Telehouse Osaka 2. During this maintenance window, your AWS Direct Connect ' +
  'services associated with this event may become unavailable.';

function makeEvent(overrides: Partial<DxMaintenanceEvent> = {}): DxMaintenanceEvent {
  return {
    arn: 'arn:aws:health:ap-northeast-3::event/DIRECTCONNECT/AWS_DIRECTCONNECT_MAINTENANCE_SCHEDULED/ABC',
    eventTypeCode: 'AWS_DIRECTCONNECT_MAINTENANCE_SCHEDULED',
    region: 'ap-northeast-3',
    startTime: '2026-07-30T13:00:00.000Z',
    endTime: '2026-07-30T15:00:00.000Z',
    lastUpdatedTime: '2026-07-16T00:00:00.000Z',
    statusCode: 'upcoming',
    affectedResourceIds: ['dxcon-fgv0etma', 'dxvif-fgcoi6fa'],
    description: DESCRIPTION_WITHOUT_IDS,
    ...overrides,
  };
}

// The DX Connection is the EDGE between the Customer/Partner Device and the AWS
// device — both endpoint nodes carry `resourceId === connectionId`, so a naive
// node scan would (wrongly) light up the customer gateway. dxcon must resolve to
// the connection edge; dxvif resolves to the VIF edge.
const PARTNER_NODE: DxNode = {
  id: 'partner-dxcon-fgv0etma',
  position: { x: 0, y: 0 },
  data: { label: 'conn', category: 'dxPartnerDevice', resourceId: 'dxcon-fgv0etma' },
};
const AWS_DEVICE_NODE: DxNode = {
  id: 'awsdev-dxcon-fgv0etma',
  position: { x: 100, y: 0 },
  data: { label: 'aws dev', category: 'awsDevice', resourceId: 'dxcon-fgv0etma' },
};
const CONN_EDGE: DxEdge = {
  id: 'edge-conn-1',
  source: 'partner-dxcon-fgv0etma',
  target: 'awsdev-dxcon-fgv0etma',
  data: { connectionId: 'dxcon-fgv0etma' },
};
const VIF_EDGE: DxEdge = {
  id: 'edge-vif-1',
  source: 'awsdev-dxcon-fgv0etma',
  target: 'dxgw-xyz',
  data: { vifId: 'dxvif-fgcoi6fa' },
};

type SpotlightSetter = (id: string | null) => void;
let spotlightNode: ReturnType<typeof vi.fn<SpotlightSetter>>;
let spotlightEdge: ReturnType<typeof vi.fn<SpotlightSetter>>;

function primeStore(
  events: DxMaintenanceEvent[],
  opts?: { nodes?: DxNode[]; edges?: DxEdge[]; dxRegions?: string[] },
) {
  spotlightNode = vi.fn<SpotlightSetter>();
  spotlightEdge = vi.fn<SpotlightSetter>();
  useTopologyStore.setState({
    topologyData: {
      maintenanceEvents: events,
      // The off-footprint filter derives the account's DX regions from
      // connections/VIFs/LAGs. Leaving `dxRegions` unset yields an empty
      // footprint, which deliberately disables filtering — that is what every
      // test predating the filter wants, so they keep passing untouched.
      connections: (opts?.dxRegions ?? []).map((region, i) => ({
        connectionId: `dxcon-footprint-${i}`,
        region,
      })),
    } as unknown as TopologyData,
    currentNodes: opts?.nodes ?? [PARTNER_NODE, AWS_DEVICE_NODE],
    currentEdges: opts?.edges ?? [CONN_EDGE, VIF_EDGE],
    theme: 'dark',
    setSpotlightNode: spotlightNode,
    setSpotlightEdge: spotlightEdge,
  });
}

function openCalendar() {
  fireEvent.click(screen.getByRole('button', { name: 'Direct Connect events calendar' }));
}

// Open the calendar and jump to (and auto-select) the next maintenance day so
// the details panel renders.
function openAndSelectNextEvent() {
  openCalendar();
  fireEvent.click(screen.getByRole('button', { name: /Go to next maintenance/ }));
}

/**
 * Find a day cell in the open grid by a pattern matched against its aria-label.
 * Scoped to cells via `aria-pressed`, which only the grid buttons carry — the
 * "Go to next maintenance" banner repeats the same date in its own label.
 */
function findDayCell(labelPattern: RegExp) {
  return screen
    .getAllByRole('button')
    .find((b) => b.getAttribute('aria-pressed') !== null && labelPattern.test(b.getAttribute('aria-label') ?? ''));
}

/** Click a day cell in the open grid by its UTC date number. */
function selectDay(dayOfMonth: number) {
  const cell = screen
    .getAllByRole('button')
    .find((b) => b.textContent?.trim() === String(dayOfMonth) && b.getAttribute('aria-pressed') !== null);
  if (!cell) throw new Error(`day cell ${dayOfMonth} not found`);
  fireEvent.click(cell);
}

// An AWS-side fault, as returned by the `issue` category query. Past-dated and
// closed, which is the common case by the time we fetch it.
function makeIssue(overrides: Partial<DxMaintenanceEvent> = {}): DxMaintenanceEvent {
  return makeEvent({
    arn: 'arn:aws:health:ap-northeast-3::event/DIRECTCONNECT/AWS_DIRECTCONNECT_OPERATIONAL_ISSUE/XYZ',
    eventTypeCode: 'AWS_DIRECTCONNECT_OPERATIONAL_ISSUE',
    eventTypeCategory: 'issue',
    statusCode: 'closed',
    startTime: '2026-06-10T04:00:00.000Z',
    endTime: '2026-06-10T06:00:00.000Z',
    description: 'Between 4:00 AM and 6:00 AM PDT we experienced increased packet loss for some Direct Connect connections.',
    ...overrides,
  });
}

describe('MaintenanceCalendar', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Anchor "today" to July 2026 so the Jul 30 event is upcoming and the
    // calendar opens on the month that contains it.
    vi.setSystemTime(new Date('2026-07-01T00:00:00.000Z'));
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('renders nothing when there are no maintenance events', () => {
    primeStore([]);
    const { container } = render(<MaintenanceCalendar iconBtnClass={iconBtnClass} />);
    expect(container.innerHTML).toBe('');
  });

  it('surfaces affected dxcon/dxvif IDs as chips even when the description omits them', () => {
    primeStore([makeEvent()]);
    render(<MaintenanceCalendar iconBtnClass={iconBtnClass} />);
    openAndSelectNextEvent();

    // The regression this guards: IDs are absent from the description text...
    expect(screen.getByText(/services associated with this event/)).toBeTruthy();
    // ...but still shown in a dedicated section.
    expect(screen.getByText('Affected resources')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'dxcon-fgv0etma' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'dxvif-fgcoi6fa' })).toBeTruthy();
  });

  it('hovering a resolvable chip spotlights the matching edge (connection or VIF)', () => {
    primeStore([makeEvent()]);
    render(<MaintenanceCalendar iconBtnClass={iconBtnClass} />);
    openAndSelectNextEvent();

    // dxcon -> the DX Connection EDGE, not the customer-gateway endpoint node.
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'dxcon-fgv0etma' }));
    expect(spotlightEdge).toHaveBeenCalledWith('edge-conn-1');
    expect(spotlightNode).not.toHaveBeenCalledWith('partner-dxcon-fgv0etma');

    // dxvif -> edge spotlight (VIFs live on edges, not nodes)
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'dxvif-fgcoi6fa' }));
    expect(spotlightEdge).toHaveBeenCalledWith('edge-vif-1');
  });

  it('falls back to the AWS device node when the connection edge is collapsed away', () => {
    // Partner devices collapsed into a group → the partner→awsDevice connection
    // edge is gone. dxcon should then point at the AWS device it terminates on,
    // never the (also-absent) customer gateway.
    primeStore([makeEvent({ affectedResourceIds: ['dxcon-fgv0etma'] })], {
      nodes: [AWS_DEVICE_NODE],
      edges: [],
    });
    render(<MaintenanceCalendar iconBtnClass={iconBtnClass} />);
    openAndSelectNextEvent();

    fireEvent.mouseEnter(screen.getByRole('button', { name: 'dxcon-fgv0etma' }));
    expect(spotlightNode).toHaveBeenCalledWith('awsdev-dxcon-fgv0etma');
    expect(spotlightEdge).not.toHaveBeenCalled();
  });

  it('resolves a VIF folded into an aggregated "N VIFs" edge', () => {
    const aggEdge: DxEdge = {
      id: 'edge-agg-1',
      source: 'awsdev-dxcon-fgv0etma',
      target: 'dxgw-xyz',
      data: {
        vifId: '2-vifs',
        aggregatedVifs: [
          { vifId: 'dxvif-fgcoi6fa', vifType: 'private', vlan: 100, vifState: 'available' },
          { vifId: 'dxvif-other', vifType: 'private', vlan: 101, vifState: 'available' },
        ],
      },
    };
    primeStore([makeEvent({ affectedResourceIds: ['dxvif-fgcoi6fa'] })], {
      nodes: [AWS_DEVICE_NODE],
      edges: [aggEdge],
    });
    render(<MaintenanceCalendar iconBtnClass={iconBtnClass} />);
    openAndSelectNextEvent();

    fireEvent.mouseEnter(screen.getByRole('button', { name: 'dxvif-fgcoi6fa' }));
    expect(spotlightEdge).toHaveBeenCalledWith('edge-agg-1');
  });

  it('dedupes repeated affected resource IDs', () => {
    primeStore([makeEvent({ affectedResourceIds: ['dxcon-fgv0etma', 'dxcon-fgv0etma', 'dxvif-fgcoi6fa'] })]);
    render(<MaintenanceCalendar iconBtnClass={iconBtnClass} />);
    openAndSelectNextEvent();

    expect(screen.getAllByRole('button', { name: 'dxcon-fgv0etma' })).toHaveLength(1);
  });

  it('renders unresolvable IDs as a disabled chip', () => {
    primeStore([makeEvent({ affectedResourceIds: ['dxcon-notintopology'] })], { nodes: [], edges: [] });
    render(<MaintenanceCalendar iconBtnClass={iconBtnClass} />);
    openAndSelectNextEvent();

    const chip = screen.getByRole('button', { name: 'dxcon-notintopology' });
    expect((chip as HTMLButtonElement).disabled).toBe(true);
  });

  it('hides the Affected resources section when the event has none', () => {
    primeStore([makeEvent({ affectedResourceIds: [] })]);
    render(<MaintenanceCalendar iconBtnClass={iconBtnClass} />);
    openAndSelectNextEvent();

    // Description still shows; the section header does not.
    expect(screen.getByText(/services associated with this event/)).toBeTruthy();
    expect(screen.queryByText('Affected resources')).toBeNull();
  });

  // The Health API returns two categories and this panel shows both. An `issue`
  // is an AWS-side fault that already happened — presenting it as planned
  // maintenance tells the customer the opposite of what occurred.
  describe('event categories', () => {
    it('labels a scheduled change as planned maintenance', () => {
      primeStore([makeEvent()]);
      render(<MaintenanceCalendar iconBtnClass={iconBtnClass} />);
      openAndSelectNextEvent();

      expect(screen.getByText('Planned maintenance')).toBeTruthy();
      expect(screen.queryByText(/AWS issue/)).toBeNull();
    });

    it('labels a closed issue as a resolved AWS issue, never planned maintenance', () => {
      primeStore([makeIssue()]);
      render(<MaintenanceCalendar iconBtnClass={iconBtnClass} />);
      openCalendar();
      // Navigate back to June 2026, where the issue sits.
      fireEvent.click(screen.getByRole('button', { name: 'Previous month' }));
      selectDay(10);

      expect(screen.getByText('AWS issue · resolved')).toBeTruthy();
      // The regression: the card must not claim this was planned work.
      expect(screen.queryByText('Planned maintenance')).toBeNull();
    });

    it('marks an open issue as ongoing', () => {
      primeStore([makeIssue({ statusCode: 'open', startTime: '2026-07-01T00:00:00.000Z', endTime: undefined })]);
      render(<MaintenanceCalendar iconBtnClass={iconBtnClass} />);
      openCalendar();
      selectDay(1);

      expect(screen.getByText('AWS issue · ongoing')).toBeTruthy();
      expect(screen.queryByText('Planned maintenance')).toBeNull();
    });

    it('describes an issue day as an AWS issue in its aria-label, not maintenance', () => {
      primeStore([makeIssue({ startTime: '2026-07-08T04:00:00.000Z', endTime: '2026-07-08T06:00:00.000Z' })]);
      render(<MaintenanceCalendar iconBtnClass={iconBtnClass} />);
      openCalendar();

      const day = findDayCell(/Wed, 08 Jul 2026/);
      expect(day?.getAttribute('aria-label')).toContain('AWS issue');
      expect(day?.getAttribute('aria-label')).not.toContain('planned maintenance');
    });

    it('names both categories when they fall on the same day', () => {
      primeStore([
        makeEvent({ startTime: '2026-07-20T13:00:00.000Z', endTime: '2026-07-20T15:00:00.000Z' }),
        makeIssue({ startTime: '2026-07-20T04:00:00.000Z', endTime: '2026-07-20T06:00:00.000Z' }),
      ]);
      render(<MaintenanceCalendar iconBtnClass={iconBtnClass} />);
      openCalendar();

      const day = findDayCell(/Mon, 20 Jul 2026/);
      expect(day?.getAttribute('aria-label')).toContain('AWS issue and planned maintenance');
    });

    it('keeps an issue and a scheduled change on separate cards in one window', () => {
      // Same window and same resources — only the category differs. These must
      // not merge, or the outage inherits the other card's label.
      const window = { startTime: '2026-07-20T13:00:00.000Z', endTime: '2026-07-20T15:00:00.000Z' };
      primeStore([makeEvent(window), makeIssue(window)]);
      render(<MaintenanceCalendar iconBtnClass={iconBtnClass} />);
      openCalendar();
      selectDay(20);

      expect(screen.getByText('Planned maintenance')).toBeTruthy();
      expect(screen.getByText('AWS issue · resolved')).toBeTruthy();
    });

    it('treats a missing category as a scheduled change so old snapshots still read correctly', () => {
      // Snapshots written before issue fetching carry no eventTypeCategory, and
      // scheduledChange was all the app requested back then.
      primeStore([makeEvent({ eventTypeCategory: undefined })]);
      render(<MaintenanceCalendar iconBtnClass={iconBtnClass} />);
      openAndSelectNextEvent();

      expect(screen.getByText('Planned maintenance')).toBeTruthy();
    });

    it('excludes issues from the forward "next activity" jump', () => {
      // A past fault is not upcoming activity; only the Jul 30 maintenance is.
      primeStore([makeEvent(), makeIssue({ startTime: '2026-07-25T04:00:00.000Z', endTime: '2026-07-25T06:00:00.000Z' })]);
      render(<MaintenanceCalendar iconBtnClass={iconBtnClass} />);
      openCalendar();

      const jump = screen.getByRole('button', { name: /Go to next maintenance/ });
      expect(jump.getAttribute('aria-label')).toContain('30 Jul 2026');
    });

    it('counts and names each category on the trigger button', () => {
      primeStore([
        makeEvent(),                                  // upcoming maintenance
        makeIssue({ statusCode: 'open' }),            // ongoing fault
        makeIssue({ arn: 'arn:closed-2' }),           // past, closed fault
      ]);
      render(<MaintenanceCalendar iconBtnClass={iconBtnClass} />);

      const trigger = screen.getByRole('button', { name: 'Direct Connect events calendar' });
      const title = trigger.getAttribute('title') ?? '';
      expect(title).toContain('1 planned maintenance');
      expect(title).toContain('1 ongoing AWS issue');
      expect(title).toContain('1 past AWS issue');
      // Badge counts what is live now (maintenance + open fault), not the closed one.
      expect(trigger.textContent).toContain('2');
    });
  });

  // AWS pushes `PUBLIC` events to every account in every region regardless of
  // footprint, so a Frankfurt DX fault reaches an account that has never had a
  // Frankfurt presence — a red day it was never affected by and can do nothing
  // about. These pin which events that filter may and may not remove.
  describe('off-footprint region filter', () => {
    // Region-wide fault in a region the test account has no presence in. Its
    // affectedResourceIds are empty because the only entity AWS returns for a
    // PUBLIC event is the sentinel "UNKNOWN", stripped at the fetch layer.
    const FRANKFURT = makeIssue({
      arn: 'arn:aws:health:eu-central-1::event/DIRECTCONNECT/AWS_DIRECTCONNECT_OPERATIONAL_ISSUE/FRA',
      region: 'eu-central-1',
      eventScopeCode: 'PUBLIC',
      startTime: '2026-07-20T04:00:00.000Z',
      endTime: '2026-07-20T06:00:00.000Z',
      affectedResourceIds: [],
      description: 'We can confirm packet loss impacting Direct Connect connections in the EU-CENTRAL-1 Region.',
    });

    /**
     * A dropped event must leave no trace in the UI — no card, no badge, and no
     * footnote or reveal control either. An event in a region the account has
     * nothing in is not a finding, so offering to review it is just clutter.
     */
    function anyHiddenEventUi() {
      return screen.queryByText((_, el) => /region-wide AWS event/i.test(el?.textContent ?? ''));
    }

    it('hides a PUBLIC event in a region where the account has no Direct Connect', () => {
      primeStore([makeEvent(), FRANKFURT], { dxRegions: ['ap-northeast-3'] });
      render(<MaintenanceCalendar iconBtnClass={iconBtnClass} />);
      openCalendar();
      selectDay(20);

      // The day carries no event at all now, so it reads as empty rather than
      // as an incident.
      expect(screen.getByText(/No Direct Connect events on/)).toBeTruthy();
      expect(screen.queryByText(/EU-CENTRAL-1 Region/)).toBeNull();
    });

    it('keeps the day unmarked so it never paints as a red incident day', () => {
      primeStore([makeEvent(), FRANKFURT], { dxRegions: ['ap-northeast-3'] });
      render(<MaintenanceCalendar iconBtnClass={iconBtnClass} />);
      openCalendar();

      expect(findDayCell(/Mon, 20 Jul 2026/)?.getAttribute('aria-label')).not.toContain('AWS issue');
    });

    it('leaves it out of the trigger badge and counts', () => {
      // Only the Jul 30 maintenance is live; the hidden Frankfurt fault must not
      // inflate the count that makes the user open the panel in the first place.
      primeStore([makeEvent(), FRANKFURT], { dxRegions: ['ap-northeast-3'] });
      render(<MaintenanceCalendar iconBtnClass={iconBtnClass} />);

      const trigger = screen.getByRole('button', { name: 'Direct Connect events calendar' });
      expect(trigger.textContent).toContain('1');
      expect(trigger.getAttribute('title') ?? '').not.toContain('AWS issue');
    });

    it('keeps an ACCOUNT_SPECIFIC event even when its region is off-footprint', () => {
      // AWS is asserting THIS account was hit. An unrecognised region means our
      // topology is stale or that region's fetch failed — hiding it would suppress
      // a confirmed impact on the strength of data we know can be incomplete.
      primeStore([
        makeIssue({
          region: 'us-east-1',
          eventScopeCode: 'ACCOUNT_SPECIFIC',
          startTime: '2026-07-21T04:00:00.000Z',
          endTime: '2026-07-21T06:00:00.000Z',
        }),
      ], { dxRegions: ['ap-northeast-3'] });
      render(<MaintenanceCalendar iconBtnClass={iconBtnClass} />);
      openCalendar();
      selectDay(21);

      expect(screen.getByText(/increased packet loss/)).toBeTruthy();
      expect(anyHiddenEventUi()).toBeNull();
    });

    it('filters nothing when the footprint is unknown', () => {
      // No connections/VIFs/LAGs at all: topology not loaded, or every regional
      // fetch failed. An empty footprint is ignorance, not evidence — treating it
      // as evidence would blank the whole calendar off one failed call.
      primeStore([FRANKFURT]);
      render(<MaintenanceCalendar iconBtnClass={iconBtnClass} />);
      openCalendar();
      selectDay(20);

      expect(screen.getByText(/EU-CENTRAL-1 Region/)).toBeTruthy();
      expect(anyHiddenEventUi()).toBeNull();
    });

    it('offers no footnote or reveal control for what it dropped', () => {
      primeStore([makeEvent(), FRANKFURT], { dxRegions: ['ap-northeast-3'] });
      render(<MaintenanceCalendar iconBtnClass={iconBtnClass} />);
      openCalendar();

      expect(anyHiddenEventUi()).toBeNull();
      expect(screen.queryByRole('button', { name: 'show' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'hide' })).toBeNull();
    });

    it('renders no calendar at all when every event was dropped', () => {
      // An empty grid still invites a click and still implies there is something
      // to look at. There is not.
      primeStore([FRANKFURT], { dxRegions: ['ap-northeast-3'] });
      const { container } = render(<MaintenanceCalendar iconBtnClass={iconBtnClass} />);

      expect(container.innerHTML).toBe('');
    });

    it('records what it dropped on the console, so a wrong call stays diagnosable', () => {
      // No UI must not mean unaccountable: this line is the first place to look
      // when an event the user expected is missing.
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      primeStore([makeEvent(), FRANKFURT], { dxRegions: ['ap-northeast-3'] });
      render(<MaintenanceCalendar iconBtnClass={iconBtnClass} />);

      const line = log.mock.calls.map(([m]) => String(m)).find((m) => m.includes('[Calendar]'));
      expect(line).toContain('Hiding 1 region-wide AWS event(s)');
      expect(line).toContain('eu-central-1');
      log.mockRestore();
    });

    // None of connections/VIFs/LAGs is a superset of the others — a hosted-VIF
    // account owns no connections at all, and a LAG can sit in a region whose VIFs
    // failed to fetch. A footprint built from any one of them alone would judge
    // those regions empty and hide events that do apply.
    it.each([
      ['VIFs, on an account that owns no connections', { virtualInterfaces: [{ virtualInterfaceId: 'dxvif-x', region: 'eu-central-1' }] }],
      ['LAGs, when no VIF in that region was fetched', { lags: [{ lagId: 'dxlag-x', region: 'eu-central-1' }] }],
    ])('derives the footprint from %s', (_label, resources) => {
      useTopologyStore.setState({
        topologyData: {
          maintenanceEvents: [FRANKFURT],
          connections: [],
          virtualInterfaces: [],
          lags: [],
          ...resources,
        } as unknown as TopologyData,
      });
      render(<MaintenanceCalendar iconBtnClass={iconBtnClass} />);
      openCalendar();
      selectDay(20);

      expect(screen.getByText(/EU-CENTRAL-1 Region/)).toBeTruthy();
      expect(anyHiddenEventUi()).toBeNull();
    });
  });

  // DescribeAffectedEntities always answers, and when AWS holds no resource-level
  // mapping it answers with a placeholder string rather than omitting the entity.
  // Rendering that placeholder as a resource chip produced a dead chip reading
  // "UNKNOWN" — the string was AWS's, presenting it as a resource ID was ours.
  describe('unmapped affected resources', () => {
    it('never renders a sentinel entity value as a resource chip', () => {
      // Snapshots captured before the fetch-layer filter still carry these.
      primeStore([
        makeIssue({
          eventScopeCode: 'ACCOUNT_SPECIFIC',
          affectedResourceIds: ['AWS_ACCOUNT'],
          startTime: '2026-07-09T04:00:00.000Z',
          endTime: '2026-07-09T06:00:00.000Z',
        }),
      ]);
      render(<MaintenanceCalendar iconBtnClass={iconBtnClass} />);
      openCalendar();
      selectDay(9);

      expect(screen.queryByRole('button', { name: 'AWS_ACCOUNT' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'UNKNOWN' })).toBeNull();
    });

    it('says a region-wide event is not attributed to individual resources', () => {
      primeStore([
        makeIssue({
          region: 'eu-central-1',
          eventScopeCode: 'PUBLIC',
          affectedResourceIds: ['UNKNOWN'],
          startTime: '2026-07-09T04:00:00.000Z',
          endTime: '2026-07-09T06:00:00.000Z',
        }),
      ], { dxRegions: ['eu-central-1'] });
      render(<MaintenanceCalendar iconBtnClass={iconBtnClass} />);
      openCalendar();
      selectDay(9);

      expect(screen.getByText(/region-wide event in eu-central-1/)).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'UNKNOWN' })).toBeNull();
    });

    it('says an account-scoped event named no specific resource', () => {
      primeStore([
        makeIssue({
          eventScopeCode: 'ACCOUNT_SPECIFIC',
          affectedResourceIds: [],
          startTime: '2026-07-09T04:00:00.000Z',
          endTime: '2026-07-09T06:00:00.000Z',
        }),
      ]);
      render(<MaintenanceCalendar iconBtnClass={iconBtnClass} />);
      openCalendar();
      selectDay(9);

      expect(screen.getByText(/without naming a connection or virtual interface/)).toBeTruthy();
    });

    it('stays silent when the scope is unknown, rather than guessing', () => {
      // Pre-`eventScopeCode` snapshots cannot be classified either way.
      primeStore([makeEvent({ affectedResourceIds: [], eventScopeCode: undefined })]);
      render(<MaintenanceCalendar iconBtnClass={iconBtnClass} />);
      openAndSelectNextEvent();

      expect(screen.queryByText('Affected resources')).toBeNull();
    });
  });
});
