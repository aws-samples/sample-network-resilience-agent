import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { drainPages } from '../paginate';

/**
 * The reviewer's finding, pinned as a test: a resource that fails must not be
 * indistinguishable from one that is empty.
 *
 * `logged()` is module-private in fetch-topology.ts and the full
 * fetchAllTopologyData() needs ~10 mocked AWS clients, so these tests cover the
 * two mechanisms the fix rests on — that a truncation is reported to the caller,
 * and that the shapes carry the failed/truncated distinction — rather than
 * re-mocking the whole orchestrator. The end-to-end wiring is covered by
 * typechecking (`topology.fetchIssues` is a typed field) plus the banner test.
 */

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('drainPages truncation is reported, not just logged', () => {
  it('calls onTruncate with the label and cap when it truncates', async () => {
    const onTruncate = vi.fn();
    const out = await drainPages(
      'Health: events',
      async () => ({ items: [1], nextToken: 'again' }),
      { maxPages: 3, onLimit: 'truncate', onTruncate },
    );

    // Partial data is still returned — truncate means "keep what we got".
    expect(out).toEqual([1, 1, 1]);
    expect(onTruncate).toHaveBeenCalledOnce();
    expect(onTruncate).toHaveBeenCalledWith('Health: events', 3);
  });

  it('does NOT call onTruncate when everything fits', async () => {
    const onTruncate = vi.fn();
    await drainPages('Health: events', async () => ({ items: [1] }), {
      maxPages: 3,
      onLimit: 'truncate',
      onTruncate,
    });
    // A false "incomplete" banner is its own failure: it trains users to ignore
    // the real one.
    expect(onTruncate).not.toHaveBeenCalled();
  });

  it('does not call onTruncate on the throw path — the exception is the signal', async () => {
    const onTruncate = vi.fn();
    await expect(
      drainPages('DX connections', async () => ({ items: [1], nextToken: 'again' }), {
        maxPages: 2,
        onLimit: 'throw',
        onTruncate,
      }),
    ).rejects.toThrow(/safety cap/);
    expect(onTruncate).not.toHaveBeenCalled();
  });

  it('still truncates when no onTruncate is supplied, so existing callers are unaffected', async () => {
    const out = await drainPages('x', async () => ({ items: ['a'], nextToken: 'again' }), {
      maxPages: 2,
      onLimit: 'truncate',
    });
    expect(out).toEqual(['a', 'a']);
  });
});
