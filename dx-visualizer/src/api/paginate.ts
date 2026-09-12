/**
 * Shared, bounded driver for AWS token-paginated APIs.
 *
 * Two separate hazards make a hand-rolled `do { … } while (nextToken)` a bad
 * idea, and this helper exists so neither can be reintroduced per call site:
 *
 * 1. **Silent data loss.** Nearly every AWS `Describe*` / `List*` call returns a
 *    partial page plus a `nextToken`, and `maxResults` is a page size, never a
 *    total. A caller that ignores the token gets no error — just a short array
 *    that looks complete. Routing every paginator through one helper means that
 *    mistake can only be made once.
 *
 * 2. **Runaway loops.** This code runs in the browser tab. An endpoint that
 *    hands back a non-empty `nextToken` on every page — a service bug, a broken
 *    proxy, or a response from a compromised cross-account spoke the user added
 *    themselves — turns an untapped loop into an unbounded request storm that
 *    grows `all` until the tab OOMs, with no way for the user to stop it short
 *    of killing the tab. A page cap is the only thing standing between a
 *    malformed response and a dead browser, so `maxPages` is required, not
 *    optional.
 */

export type PageLimitBehaviour = 'throw' | 'truncate';

export interface DrainPagesOptions {
  /**
   * Hard ceiling on calls made for this one drain. Required — pick a number
   * comfortably above the largest plausible real result and treat exceeding it
   * as a malfunction, not as "this account is big".
   */
  maxPages: number;
  /**
   * What to do when the cap is reached while a token is still outstanding.
   * Defaults to `'throw'`.
   *
   * `'throw'` is the default because a throw *cannot be mistaken for success*.
   * Every DX/EC2 call site is wrapped by `logged()` in `fetch-topology.ts`,
   * which catches, records the failure on `TopologyData.fetchIssues`, and
   * returns `[]`. The UI renders a persistent "topology may be incomplete"
   * banner whenever that array is non-empty.
   *
   * Note that `[]` is still what the caller receives, so the *data* remains
   * indistinguishable from "none exist" — the banner is what makes the
   * difference visible, and it is load-bearing rather than cosmetic. Several
   * rules read absence as a pass: an empty `vpcRouteTables` means
   * `ruleBlackholeRoutes` finds no blackholes and `ruleVpcNoHybridRoute` finds
   * nothing missing, so a failed fetch can RAISE the resiliency score. Letting
   * individual rules report *unknown* instead of *pass* is the remaining step
   * and is deliberately not done here.
   *
   * An earlier version of this comment claimed the UI surfaced these errors
   * when nothing did — they were collected into a local array and dropped. If
   * you are adding a new failure path, check it actually reaches `fetchIssues`
   * rather than trusting this comment.
   *
   * Only choose `'truncate'` where a partial answer is genuinely better than
   * none, and pass `onTruncate` when you do, or the truncation is invisible
   * again.
   */
  onLimit?: PageLimitBehaviour;
  /**
   * Called when `onLimit: 'truncate'` actually truncates.
   *
   * Without this, choosing `'truncate'` meant the caller had no way to learn it
   * happened — the console warning below was the only record, so a truncated
   * list reached the UI looking complete. Optional so existing `'throw'` call
   * sites are unaffected; it is never called on the throw path, where the
   * exception is already the signal.
   */
  onTruncate?: (label: string, maxPages: number) => void;
}

/**
 * Drain a token-paginated AWS call, following `nextToken` until it clears or
 * the page cap is hit.
 *
 * @param label Human-readable name of what is being paged, used verbatim in the
 *   warning or error text (e.g. `'Health: affected entities'`).
 * @param fetchPage Issues one call for the given token and returns that page's
 *   items plus the token for the next page (`undefined` when done).
 */
export async function drainPages<T>(
  label: string,
  fetchPage: (nextToken: string | undefined) => Promise<{ items: T[]; nextToken?: string }>,
  opts: DrainPagesOptions,
): Promise<T[]> {
  const { maxPages, onLimit = 'throw', onTruncate } = opts;
  const all: T[] = [];
  let nextToken: string | undefined;
  let pages = 0;

  do {
    const { items, nextToken: token } = await fetchPage(nextToken);
    all.push(...items);
    nextToken = token;
    pages++;
  } while (nextToken && pages < maxPages);

  if (nextToken) {
    if (onLimit === 'truncate') {
      console.warn(
        `[AWS] stopped paging ${label} at ${maxPages} pages; some results may be missing`,
      );
      onTruncate?.(label, maxPages);
    } else {
      throw new Error(
        `stopped paging ${label} at the ${maxPages}-page safety cap: the API kept returning a pagination token`,
      );
    }
  }

  return all;
}
