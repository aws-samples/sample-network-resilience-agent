// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { IncompleteDataBanner } from '../IncompleteDataBanner';
import { useTopologyStore } from '../../store/topology-store';
import type { FetchIssue, TopologyData } from '../../types/topology';

function makeTopology(fetchIssues?: FetchIssue[]): TopologyData {
  return {
    connections: [],
    virtualInterfaces: [],
    dxGateways: [],
    dxGatewayAssociations: [],
    locations: [],
    lags: [],
    vpcs: [],
    vpnGateways: [],
    vpnConnections: [],
    transitGateways: [],
    transitGatewayAttachments: [],
    transitGatewayPeeringAttachments: [],
    vpcPeerings: [],
    customerGateways: [],
    cloudWanCoreNetworks: [],
    cloudWanAttachments: [],
    cloudWanPeerings: [],
    tgwRouteTables: new Map(),
    vpcRouteTables: new Map(),
    cloudWanRoutes: new Map(),
    ...(fetchIssues ? { fetchIssues } : {}),
  } as unknown as TopologyData;
}

function setState(topologyData: TopologyData | null, extra: Record<string, unknown> = {}) {
  useTopologyStore.setState({ topologyData, isLoading: false, error: null, ...extra } as never);
}

beforeEach(() => {
  setState(null);
});
afterEach(() => {
  cleanup();
});

describe('IncompleteDataBanner', () => {
  it('renders nothing for a clean topology', () => {
    setState(makeTopology());
    const { container } = render(<IncompleteDataBanner />);
    // Silence is the point: a banner on a healthy fetch trains users to ignore
    // the real one.
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing for a pre-fetchIssues snapshot', () => {
    // The field is optional so older snapshots still import; absent must be
    // treated as "nothing known to have failed", not as unknown.
    const t = makeTopology();
    expect(t.fetchIssues).toBeUndefined();
    setState(t);
    const { container } = render(<IncompleteDataBanner />);
    expect(container.firstChild).toBeNull();
  });

  it('warns, names the resource, and says scores may be wrong', () => {
    setState(
      makeTopology([
        {
          label: 'ap-southeast-1/VpcRouteTables',
          kind: 'failed',
          message:
            'User: arn:aws:iam::111122223333:user/auditor is not authorized to perform: ec2:DescribeRouteTables',
        },
      ]),
    );
    render(<IncompleteDataBanner />);

    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText(/Topology may be incomplete/)).toBeTruthy();
    // The label has to appear, or the user cannot tell what is missing.
    expect(screen.getByText('ap-southeast-1/VpcRouteTables')).toBeTruthy();
    // Appears twice now: once on the row, once in the guidance that names the
    // action to grant. Both are wanted.
    expect(screen.getAllByText(/ec2:DescribeRouteTables/).length).toBeGreaterThanOrEqual(2);
    // The consequence, not just the fact — this is the reviewer's actual point.
    expect(screen.getByText(/Resiliency scores and exported reports may be inaccurate/)).toBeTruthy();
    // Names the exact IAM action to grant, rather than "check your permissions".
    expect(screen.getByText(/Check your IAM policy grants ec2:DescribeRouteTables/)).toBeTruthy();
    expect(screen.getByText(/docs\/iam-policy.json/)).toBeTruthy();
  });

  it('never tells the user to retry, refresh, or re-run', () => {
    // Refreshing does not fix a missing IAM permission. Telling the user to try
    // again produces the same incomplete review and teaches them the warning is
    // noise, so this wording is banned outright.
    setState(
      makeTopology([
        { label: 'a/VPCs', kind: 'failed', message: 'not authorized to perform: ec2:DescribeVpcs' },
        { label: 'Health: issues', kind: 'truncated', message: 'stopped after 25 pages' },
      ]),
    );
    const { container } = render(<IncompleteDataBanner />);
    expect(container.textContent).not.toMatch(/retry|refresh|re-run/i);
  });

  it('warns that List*/Get* actions escape a Describe* wildcard', () => {
    // The reference policy uses a Describe* wildcard, so someone comparing their
    // policy against it will wrongly conclude it already covers this.
    setState(
      makeTopology([
        {
          label: 'ap-southeast-1/VifRoutes',
          kind: 'failed',
          message: 'not authorized to perform: directconnect:ListVirtualInterfaceRoutes',
        },
      ]),
    );
    render(<IncompleteDataBanner />);
    expect(screen.getByText(/not covered by a Describe\* wildcard/)).toBeTruthy();
  });

  it('does not send the user to IAM when the failure is not a permissions error', () => {
    setState(makeTopology([{ label: 'a/VPCs', kind: 'failed', message: 'socket hang up' }]));
    render(<IncompleteDataBanner />);
    expect(screen.getByText(/These are not permission errors/)).toBeTruthy();
    expect(screen.queryByText(/Check your IAM policy/)).toBeNull();
  });

  it('counts failed and truncated separately, because the fix differs', () => {
    setState(
      makeTopology([
        { label: 'a/VPCs', kind: 'failed', message: 'boom' },
        { label: 'b/TGWs', kind: 'failed', message: 'boom' },
        { label: 'Health: issues', kind: 'truncated', message: 'stopped after 25 pages' },
      ]),
    );
    render(<IncompleteDataBanner />);
    expect(screen.getByText(/2 resources failed to load, 1 loaded incompletely/)).toBeTruthy();
  });

  it('singularises one failure', () => {
    setState(makeTopology([{ label: 'a/VPCs', kind: 'failed', message: 'boom' }]));
    render(<IncompleteDataBanner />);
    expect(screen.getByText(/1 resource failed to load/)).toBeTruthy();
  });

  it('collapses to a header that still states the problem, and never fully dismisses', () => {
    setState(makeTopology([{ label: 'a/VPCs', kind: 'failed', message: 'boom' }]));
    render(<IncompleteDataBanner />);

    fireEvent.click(screen.getByRole('button', { name: 'Hide' }));

    // Detail is gone...
    expect(screen.queryByText(/Resiliency scores and exported reports/)).toBeNull();
    // ...but the warning itself survives. A screenshot or an exported report
    // must never be taken from a view that hid this entirely.
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText(/Topology may be incomplete/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Details' })).toBeTruthy();
  });

  it('stays out of the way while loading or when App owns the error screen', () => {
    const issues: FetchIssue[] = [{ label: 'a/VPCs', kind: 'failed', message: 'boom' }];

    setState(makeTopology(issues), { isLoading: true });
    const loading = render(<IncompleteDataBanner />);
    expect(loading.container.firstChild).toBeNull();
    cleanup();

    setState(makeTopology(issues), { error: 'Invalid AWS credentials.' });
    const errored = render(<IncompleteDataBanner />);
    expect(errored.container.firstChild).toBeNull();
  });
});
