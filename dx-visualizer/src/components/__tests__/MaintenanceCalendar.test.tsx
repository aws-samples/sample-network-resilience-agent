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

function primeStore(events: DxMaintenanceEvent[], opts?: { nodes?: DxNode[]; edges?: DxEdge[] }) {
  spotlightNode = vi.fn<SpotlightSetter>();
  spotlightEdge = vi.fn<SpotlightSetter>();
  useTopologyStore.setState({
    // Only `maintenanceEvents` is read off topologyData by this component.
    topologyData: { maintenanceEvents: events } as unknown as TopologyData,
    currentNodes: opts?.nodes ?? [PARTNER_NODE, AWS_DEVICE_NODE],
    currentEdges: opts?.edges ?? [CONN_EDGE, VIF_EDGE],
    theme: 'dark',
    setSpotlightNode: spotlightNode,
    setSpotlightEdge: spotlightEdge,
  });
}

// Open the calendar and jump to (and auto-select) the next maintenance day so
// the details panel renders.
function openAndSelectNextEvent() {
  fireEvent.click(screen.getByRole('button', { name: 'Planned maintenance calendar' }));
  fireEvent.click(screen.getByRole('button', { name: /Go to next maintenance/ }));
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
});
