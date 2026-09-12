import type { FetchIssue } from '../types/topology';

/**
 * Shared wording for the incomplete-data warnings.
 *
 * The on-screen banner and the exported HTML report must say the same thing —
 * they are the same claim to two audiences, and the report's readers usually
 * cannot see the app. Keeping the text here means a copy change lands in both
 * instead of drifting apart.
 *
 * Deliberately does NOT tell the user to retry, refresh, or re-run. The dominant
 * cause is a missing IAM permission, and re-running changes nothing — it just
 * produces the same incomplete review a second time and teaches the user the
 * warning is noise. Every message below either names something concrete to
 * check, or says plainly that no action is available.
 */

/** One-line count for a header, keeping the two kinds distinct. */
export function summariseIssues(issues: FetchIssue[]): string {
  const failed = issues.filter((i) => i.kind === 'failed').length;
  const truncated = issues.filter((i) => i.kind === 'truncated').length;
  return [
    failed > 0 ? `${failed} resource${failed === 1 ? '' : 's'} failed to load` : '',
    truncated > 0 ? `${truncated} loaded incompletely` : '',
  ]
    .filter(Boolean)
    .join(', ');
}

/**
 * Pull the denied API action out of an AWS authorization error.
 *
 * AccessDenied reads "User: arn:aws:iam::…:user/x is not authorized to perform:
 * ec2:DescribeRouteTables because no identity-based policy allows…". The action
 * is the single most useful thing on screen — it turns "something failed" into
 * one line to add to a policy — so it is worth extracting rather than leaving
 * the user to read an ARN-laden sentence.
 *
 * Returns undefined when the message is not an authorization error, which is how
 * the caller decides between permissions guidance and "no action available".
 */
export function deniedAction(message: string): string | undefined {
  return /(?:perform|call)\s*:?\s+([a-z0-9-]+:[A-Za-z0-9]+)/.exec(message)?.[1];
}

/** Distinct denied actions across every failed issue, in first-seen order. */
export function deniedActions(issues: FetchIssue[]): string[] {
  const seen = new Set<string>();
  for (const i of issues) {
    if (i.kind !== 'failed') continue;
    const action = deniedAction(i.message);
    if (action) seen.add(action);
  }
  return [...seen];
}

/**
 * What the user should check, as plain sentences.
 *
 * Split by cause because the actions genuinely differ, and a single generic
 * "common causes" footer made all three look equally likely — which is how a
 * permissions problem ends up being read as a transient glitch.
 */
export function guidanceFor(issues: FetchIssue[]): string[] {
  const out: string[] = [];
  const failed = issues.filter((i) => i.kind === 'failed');
  const truncated = issues.filter((i) => i.kind === 'truncated');
  const actions = deniedActions(issues);

  if (actions.length > 0) {
    out.push(
      `Check your IAM policy grants ${actions.join(', ')}. The reference policy is docs/iam-policy.json.`,
    );
    // A real trap in this codebase, and invisible from the error text: the
    // example policy uses a Describe* wildcard, which does not cover List* or
    // Get*. Someone comparing their policy to the reference will conclude it is
    // already correct.
    if (actions.some((a) => /:(List|Get)/.test(a))) {
      out.push(
        'Note: List* and Get* actions are not covered by a Describe* wildcard and need their own entry.',
      );
    }
  } else if (failed.length > 0) {
    // Not an authorization error, so pointing at IAM would send the user down
    // the wrong path.
    out.push(
      'These are not permission errors — see the message on each row for the cause reported by AWS.',
    );
  }

  if (truncated.length > 0) {
    out.push(
      'Truncated results stopped at a page limit: what is shown is accurate, but older or additional entries are omitted.',
    );
  }

  return out;
}
