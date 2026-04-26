import { describe, expect, it } from 'vitest';
import type { ExtendedContentItem } from '@/lib/api';
import { applyEventTabDefaults, isDateFeedMode } from '@/lib/event-filters';
import { getThreadGroupKey, groupContentByThread, mergeEventTabFilters } from './navigation';

function makeItem(overrides: Partial<ExtendedContentItem>): ExtendedContentItem {
  return {
    id: 1,
    entity_ids: [1],
    platform: 'test',
    origin_id: 'origin-1',
    semantic_type: 'content',
    author_name: null,
    title: null,
    text_content: 'text',
    rating: null,
    source_url: null,
    score: 0,
    metadata: {},
    classifications: {},
    created_at: '2026-04-07T10:00:00.000Z',
    occurred_at: '2026-04-07T10:00:00.000Z',
    origin_parent_id: null,
    root_origin_id: 'origin-1',
    depth: 0,
    attachments: [],
    ...overrides,
  };
}

describe('events navigation helpers', () => {
  it('defaults the events tab to newest-first date browsing', () => {
    expect(applyEventTabDefaults({})).toMatchObject({
      sortBy: 'date',
      sortOrder: 'desc',
    });
    expect(isDateFeedMode({})).toBe(true);
    expect(isDateFeedMode({ sortBy: 'score' })).toBe(false);
  });

  it('clears cursor state when non-scroll filters change', () => {
    const merged = mergeEventTabFilters(
      {
        sortBy: 'date',
        sortOrder: 'desc',
        beforeOccurredAt: '2026-04-07T10:00:00.000Z',
        beforeId: 42,
      },
      { platforms: ['reddit'] }
    );

    expect(merged.beforeOccurredAt).toBeUndefined();
    expect(merged.beforeId).toBeUndefined();
  });

  it('keeps only one cursor direction active at a time', () => {
    const merged = mergeEventTabFilters(
      {
        sortBy: 'date',
        sortOrder: 'desc',
        afterOccurredAt: '2026-04-07T12:00:00.000Z',
        afterId: 100,
      },
      {
        beforeOccurredAt: '2026-04-07T09:00:00.000Z',
        beforeId: 50,
      }
    );

    expect(merged.beforeOccurredAt).toBe('2026-04-07T09:00:00.000Z');
    expect(merged.beforeId).toBe(50);
    expect(merged.afterOccurredAt).toBeUndefined();
    expect(merged.afterId).toBeUndefined();
  });

  it('falls back to origin_id when root_origin_id is missing', () => {
    const first = makeItem({ id: 1, origin_id: 'origin-1', root_origin_id: '' as any });
    const second = makeItem({ id: 2, origin_id: 'origin-2', root_origin_id: null as any });

    expect(getThreadGroupKey(first)).toBe('origin-1');
    expect(getThreadGroupKey(second)).toBe('origin-2');

    const groups = groupContentByThread([first, second]);
    expect(groups.size).toBe(2);
  });
});
