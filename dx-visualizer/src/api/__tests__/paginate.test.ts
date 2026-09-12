import { describe, it, expect, vi, afterEach } from 'vitest';
import { drainPages } from '../paginate';

afterEach(() => {
  vi.restoreAllMocks();
});

/** A fetchPage that hands back one item per page and NEVER clears the token. */
function neverClearing() {
  return vi.fn(async (token: string | undefined) => ({
    items: [`item-${token ?? 'first'}`],
    nextToken: 'again',
  }));
}

describe('drainPages', () => {
  it('aggregates items across pages in order and threads the token through', async () => {
    const seenTokens: (string | undefined)[] = [];
    const fetchPage = vi.fn(async (token: string | undefined) => {
      seenTokens.push(token);
      if (token === undefined) return { items: ['a', 'b'], nextToken: 'p2' };
      if (token === 'p2') return { items: ['c'], nextToken: 'p3' };
      return { items: ['d'], nextToken: undefined };
    });

    const out = await drainPages('things', fetchPage, { maxPages: 10 });

    expect(out).toEqual(['a', 'b', 'c', 'd']);
    expect(seenTokens).toEqual([undefined, 'p2', 'p3']);
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it('makes exactly one call when the first page already clears the token', async () => {
    const fetchPage = vi.fn(async () => ({ items: [1], nextToken: undefined }));
    await expect(drainPages('things', fetchPage, { maxPages: 1 })).resolves.toEqual([1]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('throws at the cap by default rather than looping forever', async () => {
    const fetchPage = neverClearing();

    await expect(drainPages('gateways', fetchPage, { maxPages: 4 })).rejects.toThrow(
      /stopped paging gateways at the 4-page safety cap/,
    );
    // The cap is a hard call ceiling, not a soft target.
    expect(fetchPage).toHaveBeenCalledTimes(4);
  });

  it('throws with an explicit onLimit of throw too', async () => {
    const fetchPage = neverClearing();
    await expect(
      drainPages('gateways', fetchPage, { maxPages: 2, onLimit: 'throw' }),
    ).rejects.toThrow(/2-page safety cap/);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('warns and returns what it collected when onLimit is truncate', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchPage = neverClearing();

    const out = await drainPages('events', fetchPage, { maxPages: 3, onLimit: 'truncate' });

    expect(out).toHaveLength(3);
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('stopped paging events at 3 pages');
  });

  it('does not warn or throw when the token clears exactly on the last allowed page', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let calls = 0;
    const fetchPage = vi.fn(async () => {
      calls++;
      return { items: [calls], nextToken: calls < 3 ? 'more' : undefined };
    });

    await expect(
      drainPages('things', fetchPage, { maxPages: 3, onLimit: 'truncate' }),
    ).resolves.toEqual([1, 2, 3]);
    expect(warn).not.toHaveBeenCalled();
  });
});
