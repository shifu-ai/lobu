import { describe, expect, mock, test } from 'bun:test';
import { paginateByCursor, paginateByOffset } from '../pagination.js';

describe('paginateByOffset', () => {
  test('advances the offset by pageSize and stops when hasMore is false', async () => {
    const calls: Array<[number, number]> = [];
    const pages = [
      { items: [1, 2], hasMore: true },
      { items: [3, 4], hasMore: true },
      { items: [5], hasMore: false },
    ];
    let i = 0;
    const batches: number[][] = [];
    for await (const batch of paginateByOffset(
      async (offset, pageSize) => {
        calls.push([offset, pageSize]);
        return pages[i++];
      },
      { pageSize: 2, maxPages: 10 }
    )) {
      batches.push(batch);
    }
    expect(batches).toEqual([[1, 2], [3, 4], [5]]);
    expect(calls).toEqual([
      [0, 2],
      [2, 2],
      [4, 2],
    ]);
  });

  test('caps at maxPages even when more pages remain', async () => {
    const fetchPage = mock(async () => ({ items: ['x'], hasMore: true }));
    const batches: string[][] = [];
    for await (const batch of paginateByOffset(fetchPage, { pageSize: 1, maxPages: 3 })) {
      batches.push(batch);
    }
    expect(batches).toEqual([['x'], ['x'], ['x']]);
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  test('respects startOffset', async () => {
    const calls: number[] = [];
    for await (const _batch of paginateByOffset(
      async (offset) => {
        calls.push(offset);
        return { items: [], hasMore: false };
      },
      { pageSize: 50, maxPages: 5, startOffset: 100 }
    )) {
      /* drain */
    }
    expect(calls).toEqual([100]);
  });

  test('breaking out of the loop stops further fetches', async () => {
    const fetchPage = mock(async () => ({ items: [1], hasMore: true }));
    for await (const _batch of paginateByOffset(fetchPage, { pageSize: 1, maxPages: 10 })) {
      break;
    }
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });
});

describe('paginateByCursor', () => {
  test('threads the cursor through pages and stops on null', async () => {
    const seenCursors: Array<string | null> = [];
    const pages: Array<{ items: string[]; nextCursor: string | null }> = [
      { items: ['a'], nextCursor: 'c1' },
      { items: ['b'], nextCursor: 'c2' },
      { items: ['c'], nextCursor: null },
    ];
    let i = 0;
    const batches: string[][] = [];
    for await (const batch of paginateByCursor(async (cursor) => {
      seenCursors.push(cursor);
      return pages[i++];
    })) {
      batches.push(batch);
    }
    expect(batches).toEqual([['a'], ['b'], ['c']]);
    expect(seenCursors).toEqual([null, 'c1', 'c2']);
  });

  test('stops on undefined nextCursor', async () => {
    const fetchPage = mock(async () => ({ items: [1], nextCursor: undefined }));
    const batches: number[][] = [];
    for await (const batch of paginateByCursor(fetchPage, { maxPages: 5 })) {
      batches.push(batch);
    }
    expect(batches).toEqual([[1]]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  test('passes initialCursor to the first fetch and caps at maxPages', async () => {
    const seenCursors: Array<string | null> = [];
    const fetchPage = mock(async (cursor: string | null) => {
      seenCursors.push(cursor);
      return { items: ['x'], nextCursor: `${cursor}+` };
    });
    const batches: string[][] = [];
    for await (const batch of paginateByCursor(fetchPage, {
      maxPages: 2,
      initialCursor: 'start',
    })) {
      batches.push(batch);
    }
    expect(batches).toEqual([['x'], ['x']]);
    expect(seenCursors).toEqual(['start', 'start+']);
  });

  test('yields the final empty batch before stopping', async () => {
    const pages = [
      { items: [1], nextCursor: 'next' },
      { items: [] as number[], nextCursor: null },
    ];
    let i = 0;
    const batches: number[][] = [];
    for await (const batch of paginateByCursor(async () => pages[i++])) {
      batches.push(batch);
    }
    expect(batches).toEqual([[1], []]);
  });
});
