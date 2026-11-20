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

/** The banner starts collapsed; most assertions are about the expanded body. */
function renderExpanded() {
  const r = render(<IncompleteDataBanner />);
  fireEvent.click(screen.getByRole('button', { name: 'Details' }));
  return r;
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
    renderExpanded();

    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText(/Topology may be incomplete/)).toBeTruthy();
    // The label has to appear, or the user cannot tell what is missing.
    expect(screen.getByText(/VPC route tables/)).toBeTruthy();
    // Appears twice: once on the row, once in the guidance that names the
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
    const { container } = renderExpanded();
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
    renderExpanded();
    expect(screen.getByText(/not covered by a Describe\* wildcard/)).toBeTruthy();
  });

  it('does not send the user to IAM when the failure is not a permissions error', () => {
    setState(makeTopology([{ label: 'a/VPCs', kind: 'failed', message: 'socket hang up' }]));
    renderExpanded();
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

  it('groups repeated denials of one action into a single row', () => {
    // An SCP deny produces the same ARN-laden sentence for every region; one
    // row per occurrence filled the whole screen.
    const scp = (action: string) =>
      `User: arn:aws:sts::111122223333:assumed-role/RO/x is not authorized to perform: ${action} with an explicit deny in a service control policy: arn:aws:organizations::444455556666:policy/o-abc/service_control_policy/p-xyz`;
    setState(
      makeTopology([
        { label: 'eu-central-1/VpnConnections', kind: 'failed', message: scp('ec2:DescribeVpnConnections') },
        { label: 'sa-east-1/VpnConnections', kind: 'failed', message: scp('ec2:DescribeVpnConnections') },
        { label: 'eu-west-2/TGWAttachments', kind: 'failed', message: scp('ec2:DescribeTransitGatewayAttachments') },
      ]),
    );
    const { container } = renderExpanded();
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(container.querySelector('li')?.textContent).toBe(
      'VPN connections — blocked by organization policy ec2:DescribeVpnConnections · 2 regions',
    );
    expect(screen.getAllByText(/blocked by organization policy/)).toHaveLength(2);
    // The ARNs are kept out of the visible text, but still in the tooltip.
    expect(container.textContent).not.toMatch(/arn:aws:sts/);
    expect(container.querySelector('li')?.getAttribute('title')).toMatch(/arn:aws:sts/);
  });

  it('shows customer-facing names and a region count, details in the tooltip', () => {
    const denied = 'not authorized to perform: ec2:DescribeRouteTables';
    const creds = 'AWS was not able to validate the provided access credentials';
    setState(
      makeTopology([
        { label: '396913707275/ap-south-1/VpcRouteTables', kind: 'failed', message: denied },
        { label: '396913707275/eu-west-1/VpcRouteTables', kind: 'failed', message: denied },
        { label: '396913707275/ap-southeast-4/TGWs', kind: 'failed', message: creds },
        { label: '396913707275/ap-southeast-4/VPCs', kind: 'failed', message: creds },
        { label: 'CloudWatch/BgpPrefixMetrics', kind: 'failed', message: 'boom' },
      ]),
    );
    const { container } = renderExpanded();
    const items = [...container.querySelectorAll('li')].map((li) => li.textContent);
    expect(items).toEqual([
      'VPC route tables — missing permission ec2:DescribeRouteTables · 2 regions',
      'Transit gateways, VPCs — credentials rejected (region may not be enabled) · ap-southeast-4',
      // A non-region prefix is part of the resource name, not a region.
      'CloudWatch/BgpPrefixMetrics — boom',
    ]);
    // Region list and account live in the tooltip, not the visible text.
    const first = container.querySelector('li')?.getAttribute('title') ?? '';
    expect(first).toMatch(/Regions: ap-south-1, eu-west-1/);
    expect(first).toMatch(/Account: 396913707275/);
  });

  it('singularises one failure', () => {
    setState(makeTopology([{ label: 'a/VPCs', kind: 'failed', message: 'boom' }]));
    render(<IncompleteDataBanner />);
    expect(screen.getByText(/1 resource failed to load/)).toBeTruthy();
  });

  it('collapses to a header that still states the problem', () => {
    setState(makeTopology([{ label: 'a/VPCs', kind: 'failed', message: 'boom' }]));
    renderExpanded();

    fireEvent.click(screen.getByRole('button', { name: 'Hide' }));

    // Detail is gone...
    expect(screen.queryByText(/Resiliency scores and exported reports/)).toBeNull();
    // ...but the warning itself survives. A screenshot or an exported report
    // must never be taken from a view that hid this entirely.
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText(/Topology may be incomplete/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Details' })).toBeTruthy();
  });

  it('can be closed, and comes back for a new topology', () => {
    const issues: FetchIssue[] = [{ label: 'a/VPCs', kind: 'failed', message: 'boom' }];
    setState(makeTopology(issues));
    const { container, rerender } = render(<IncompleteDataBanner />);
    fireEvent.click(screen.getByRole('button', { name: 'Close notice' }));
    expect(container.firstChild).toBeNull();

    // A refresh / account switch is a new context: warn again.
    setState(makeTopology(issues));
    rerender(<IncompleteDataBanner />);
    expect(screen.getByRole('alert')).toBeTruthy();
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
