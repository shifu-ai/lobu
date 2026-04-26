import { describe, expect, it } from 'vitest';
import {
  convertFiltersToApiParams,
  hasEventCursor,
  parseEventFiltersFromUrl,
  serializeEventFiltersToSearch,
} from './event-filters';

describe('event filters cursor support', () => {
  it('parses at cursor param from the URL', () => {
    const filters = parseEventFiltersFromUrl(
      new URLSearchParams({ at: '2026-04-07T10:00:00.000Z,42' })
    );

    expect(filters.beforeOccurredAt).toBe('2026-04-07T10:00:00.000Z');
    expect(filters.beforeId).toBe(42);
    expect(hasEventCursor(filters)).toBe(true);
  });

  it('serializes cursor as combined at param', () => {
    const search = serializeEventFiltersToSearch({
      beforeOccurredAt: '2026-04-07T10:00:00.000Z',
      beforeId: 42,
    });

    expect(search.at).toBe('2026-04-07T10:00:00.000Z,42');
  });

  it('zeros API offset when cursor navigation is active', () => {
    const params = convertFiltersToApiParams({
      page: 5,
      beforeOccurredAt: '2026-04-07T10:00:00.000Z',
      beforeId: 42,
      sortBy: 'date',
      sortOrder: 'desc',
    });

    expect(params.offset).toBe(0);
    expect(params.before_occurred_at).toBe('2026-04-07T10:00:00.000Z');
    expect(params.before_id).toBe(42);
  });
});
