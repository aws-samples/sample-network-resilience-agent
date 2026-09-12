import { describe, it, expect } from 'vitest';
import { renderIncompleteDataNoticeHtml } from '../useExportReport';
import type { FetchIssue, TopologyData } from '../../types/topology';

/**
 * The on-screen banner says "exported reports may be inaccurate". That sentence
 * was a promise the exporter did not keep — the HTML report left the app with no
 * trace of the warning, and the report is the artifact that actually reaches a
 * customer, since most readers never open the app.
 */
function topologyWith(fetchIssues?: FetchIssue[]): TopologyData {
  return { fetchIssues } as unknown as TopologyData;
}

describe('exported report carries the incomplete-data warning', () => {
  it('emits nothing for a clean topology', () => {
    expect(renderIncompleteDataNoticeHtml(topologyWith())).toBe('');
    expect(renderIncompleteDataNoticeHtml(topologyWith([]))).toBe('');
  });

  it('names the resource and says the scores may be optimistic', () => {
    const html = renderIncompleteDataNoticeHtml(
      topologyWith([
        {
          label: 'ap-southeast-1/VpcRouteTables',
          kind: 'failed',
          message:
            'User: arn:aws:iam::111122223333:user/auditor is not authorized to perform: ec2:DescribeRouteTables',
        },
      ]),
    );

    expect(html).toContain('incomplete data');
    expect(html).toContain('ap-southeast-1/VpcRouteTables');
    expect(html).toContain('ec2:DescribeRouteTables');
    // The consequence, not just the fact. A reader who is not told the score may
    // be wrong will treat it as authoritative.
    expect(html).toContain('optimistic');
    expect(html).toContain('1 resource failed to load');
    // Names the action to grant, and points at the reference policy in-repo.
    expect(html).toContain('Check your IAM policy grants ec2:DescribeRouteTables');
    expect(html).toContain('docs/iam-policy.json');
  });

  it('never tells the reader to retry, refresh, or re-run', () => {
    // Same rule as the on-screen banner: re-running does not fix a missing
    // permission, and the report's readers often cannot run it at all.
    const html = renderIncompleteDataNoticeHtml(
      topologyWith([
        { label: 'a/VPCs', kind: 'failed', message: 'not authorized to perform: ec2:DescribeVpcs' },
        { label: 'Health: issues', kind: 'truncated', message: 'stopped after 25 pages' },
      ]),
    );
    expect(html).not.toMatch(/retry|refresh|re-run/i);
  });

  it('says what truncation means rather than implying data is wrong', () => {
    const html = renderIncompleteDataNoticeHtml(
      topologyWith([{ label: 'Health: issues', kind: 'truncated', message: 'stopped after 25 pages' }]),
    );
    expect(html).toContain('what is shown is accurate');
  });

  it('counts failed and truncated separately', () => {
    const html = renderIncompleteDataNoticeHtml(
      topologyWith([
        { label: 'a/VPCs', kind: 'failed', message: 'boom' },
        { label: 'b/TGWs', kind: 'failed', message: 'boom' },
        { label: 'Health: issues', kind: 'truncated', message: 'stopped after 25 pages' },
      ]),
    );
    expect(html).toContain('2 resources failed to load, 1 loaded incompletely');
    expect(html).toContain('incomplete');
  });

  it('escapes the label and message, which are attacker-influenced', () => {
    // `label` embeds a region and account id, and `message` is raw AWS text —
    // neither is trusted input for an HTML document the user opens locally.
    const html = renderIncompleteDataNoticeHtml(
      topologyWith([
        {
          label: '<img src=x onerror=alert(1)>',
          kind: 'failed',
          message: '"><script>alert(2)</script>',
        },
      ]),
    );
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;img src=x');
  });

  it('renders before the first report section, not as a footnote', () => {
    // Placement is the point: a caveat printed after the scores has already been
    // read past.
    const html = renderIncompleteDataNoticeHtml(
      topologyWith([{ label: 'a/VPCs', kind: 'failed', message: 'boom' }]),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain('class="incomplete-data"');
  });
});
