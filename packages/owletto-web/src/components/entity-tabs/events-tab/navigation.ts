import type { ExtendedContentItem } from '@/lib/api';
import { applyEventTabDefaults, type PartialEventFilters } from '@/lib/event-filters';

const SCROLL_POSITION_KEYS = new Set([
  'page',
  'beforeOccurredAt',
  'beforeId',
  'afterOccurredAt',
  'afterId',
]);

/** Returns a stable identity for filters excluding scroll-position params. */
export function getFilterIdentity(
  filters: PartialEventFilters
): Omit<
  PartialEventFilters,
  'page' | 'beforeOccurredAt' | 'beforeId' | 'afterOccurredAt' | 'afterId'
> {
  const { page, beforeOccurredAt, beforeId, afterOccurredAt, afterId, ...rest } = filters;
  return rest;
}

export function mergeEventTabFilters(
  current: PartialEventFilters,
  updates: Partial<PartialEventFilters>
): PartialEventFilters {
  const merged = {
    ...applyEventTabDefaults(current),
    ...updates,
  };
  const changedKeys = Object.keys(updates);
  const scrollOnly =
    changedKeys.length > 0 && changedKeys.every((key) => SCROLL_POSITION_KEYS.has(key));

  if (!scrollOnly) {
    merged.beforeOccurredAt = undefined;
    merged.beforeId = undefined;
    merged.afterOccurredAt = undefined;
    merged.afterId = undefined;
    return merged;
  }

  if ('beforeOccurredAt' in updates || 'beforeId' in updates) {
    merged.afterOccurredAt = undefined;
    merged.afterId = undefined;
  }

  if ('afterOccurredAt' in updates || 'afterId' in updates) {
    merged.beforeOccurredAt = undefined;
    merged.beforeId = undefined;
  }

  return merged;
}

export function getThreadGroupKey(
  item: Pick<ExtendedContentItem, 'id' | 'origin_id' | 'root_origin_id'>
): string {
  return item.root_origin_id || item.origin_id || String(item.id);
}

export interface ThreadGroup {
  root: ExtendedContentItem | null;
  replies: ExtendedContentItem[];
  hasParentContext: boolean;
}

export function groupContentByThread(contents: ExtendedContentItem[]): Map<string, ThreadGroup> {
  const groups = new Map<string, ThreadGroup>();

  for (const item of contents) {
    const rootId = getThreadGroupKey(item);
    if (!groups.has(rootId)) {
      groups.set(rootId, { root: null, replies: [], hasParentContext: false });
    }

    const group = groups.get(rootId);
    if (!group) {
      continue;
    }

    if (item.depth === 0) {
      group.root = item;
      group.hasParentContext = !!item.parent_context;
    } else {
      group.replies.push(item);
    }
  }

  return groups;
}
