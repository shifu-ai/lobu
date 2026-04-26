/**
 * Type-safe utilities for event filter URL parameters
 */

import {
  type ClassificationFilters,
  getParam as getParamValue,
  normalizeClassificationFilters,
  parseClassificationParams,
  parseDateToObject,
  parseInt10,
  parseStringArray,
} from './filter-utils';

export type { ClassificationFilters };
export { parseStringArray };

export interface EventFilters {
  dateRange: [Date, Date] | null;
  engagementRange: [number, number];
  classificationFilters: ClassificationFilters;
  searchQuery: string;
  platforms: string[];
  page: number;
  sortBy: 'date' | 'score';
  sortOrder: 'asc' | 'desc';
  reviewStatus: 'all' | 'user' | 'system' | 'llm';
  windowId: number | null;
  contentIds: number[] | null;
  beforeOccurredAt: string | null;
  beforeId: number | null;
  afterOccurredAt: string | null;
  afterId: number | null;
  interactionStatus: string | null;
}

export type PartialEventFilters = Partial<EventFilters>;

export function parseEventFiltersFromUrl(
  searchParams: URLSearchParams | Record<string, string | undefined>
): PartialEventFilters {
  const filters: PartialEventFilters = {};
  const get = (key: string) => getParamValue(searchParams, key);

  // Platforms
  const platformsStr = get('platforms') || get('platform');
  if (platformsStr) {
    const platforms = platformsStr
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    if (platforms.length > 0) {
      filters.platforms = platforms;
    }
  }

  // Date range
  const dateStart = get('date_start');
  const dateEnd = get('date_end');
  if (dateStart && dateEnd) {
    const startDate = parseDateToObject(dateStart);
    const endDate = parseDateToObject(dateEnd);
    if (startDate && endDate) {
      filters.dateRange = [startDate, endDate];
    }
  }

  // Engagement range
  const engagementMin = get('engagement_min');
  const engagementMax = get('engagement_max');
  if (engagementMin || engagementMax) {
    const min = parseInt10(engagementMin) ?? 0;
    const max = parseInt10(engagementMax) ?? 100;
    if (min !== 0 || max !== 100) {
      filters.engagementRange = [min, max];
    }
  }

  // Classification filters — JSON format first, then clf_* params
  const classificationFilters: ClassificationFilters = {};
  const classificationsStr = get('classifications');
  if (classificationsStr) {
    try {
      const parsed = JSON.parse(classificationsStr);
      Object.assign(classificationFilters, normalizeClassificationFilters(parsed));
    } catch (err) {
      console.error('Failed to parse classifications from URL:', err);
    }
  }
  Object.assign(classificationFilters, parseClassificationParams(searchParams));

  if (Object.keys(classificationFilters).length > 0) {
    filters.classificationFilters = classificationFilters;
  }

  // Search query
  const searchQuery = get('q');
  if (searchQuery && searchQuery.trim().length >= 3) {
    filters.searchQuery = searchQuery.trim();
  }

  // Page
  const pageStr = get('page');
  if (pageStr) {
    const page = parseInt10(pageStr);
    if (page != null && page > 0) {
      filters.page = page;
    }
  }

  // Sort options
  const sortBy = get('sort_by');
  if (sortBy === 'date' || sortBy === 'score') {
    filters.sortBy = sortBy;
  }

  const sortOrder = get('sort_order');
  if (sortOrder === 'asc' || sortOrder === 'desc') {
    filters.sortOrder = sortOrder;
  }

  // Review status
  const reviewStatus = get('review_status');
  if (
    reviewStatus === 'all' ||
    reviewStatus === 'user' ||
    reviewStatus === 'system' ||
    reviewStatus === 'llm'
  ) {
    filters.reviewStatus = reviewStatus;
  }

  // Window ID (from watcher source knowledge link)
  const windowIdStr = get('window_id');
  if (windowIdStr) {
    const windowId = parseInt10(windowIdStr);
    if (windowId != null) filters.windowId = windowId;
  }

  // Content IDs (from knowledge item permalink)
  const contentIdsStr = get('content_ids');
  if (contentIdsStr) {
    const ids = contentIdsStr
      .split(',')
      .map((s) => parseInt10(s.trim()))
      .filter((n): n is number => n != null);
    if (ids.length > 0) filters.contentIds = ids;
  }

  // Cursor param: "at=<timestamp>,<id>" (scroll position for infinite scroll)
  const atParam = get('at');
  if (atParam) {
    const lastComma = atParam.lastIndexOf(',');
    if (lastComma > 0) {
      const timestamp = atParam.slice(0, lastComma);
      const id = parseInt10(atParam.slice(lastComma + 1));
      if (timestamp && id != null) {
        filters.beforeOccurredAt = timestamp;
        filters.beforeId = id;
      }
    }
  }

  const interactionStatus = get('interaction_status');
  if (interactionStatus) {
    filters.interactionStatus = interactionStatus;
  }

  return filters;
}

export function serializeEventFiltersToSearch(
  filters: PartialEventFilters
): Record<string, string | undefined> {
  const params: Record<string, string | undefined> = {};

  if (filters.platforms && filters.platforms.length > 0) {
    params.platforms = filters.platforms.join(',');
  }

  if (filters.dateRange) {
    params.date_start = filters.dateRange[0].toISOString().split('T')[0];
    params.date_end = filters.dateRange[1].toISOString().split('T')[0];
  }

  if (filters.engagementRange) {
    if (filters.engagementRange[0] !== 0) {
      params.engagement_min = filters.engagementRange[0].toString();
    }
    if (filters.engagementRange[1] !== 100) {
      params.engagement_max = filters.engagementRange[1].toString();
    }
  }

  if (filters.classificationFilters && Object.keys(filters.classificationFilters).length > 0) {
    const normalized = normalizeClassificationFilters(filters.classificationFilters);
    if (Object.keys(normalized).length > 0) {
      params.classifications = JSON.stringify(normalized);
    }
  }

  if (filters.searchQuery && filters.searchQuery.trim().length >= 3) {
    params.q = filters.searchQuery.trim();
  }

  if (filters.sortBy && filters.sortBy !== 'score') {
    params.sort_by = filters.sortBy;
  }

  if (filters.sortOrder && filters.sortOrder !== 'desc') {
    params.sort_order = filters.sortOrder;
  }

  if (filters.reviewStatus && filters.reviewStatus !== 'all') {
    params.review_status = filters.reviewStatus;
  }

  if (filters.windowId != null) {
    params.window_id = filters.windowId.toString();
  }

  if (filters.contentIds && filters.contentIds.length > 0) {
    params.content_ids = filters.contentIds.join(',');
  }

  if (filters.beforeOccurredAt && filters.beforeId != null) {
    params.at = `${filters.beforeOccurredAt},${filters.beforeId}`;
  }

  if (filters.interactionStatus) {
    params.interaction_status = filters.interactionStatus;
  }

  return params;
}

export function hasEventCursor(filters: PartialEventFilters): boolean {
  return (
    (filters.beforeOccurredAt != null && filters.beforeId != null) ||
    (filters.afterOccurredAt != null && filters.afterId != null)
  );
}

export function convertFiltersToApiParams(
  filters: PartialEventFilters,
  entityId?: number,
  options: {
    limit?: number;
    offset?: number;
    includeClassifications?: boolean;
    includeClassification?: 'summary' | 'timeline' | 'summary,timeline' | 'timeline,summary';
    sort_by?: 'date' | 'score';
    sort_order?: 'asc' | 'desc';
  } = {}
): Record<string, unknown> {
  const limit = options.limit ?? 50;
  const page = filters.page ?? 1;
  const hasCursor = hasEventCursor(filters);
  const useDateFeed =
    (filters.sortBy ?? options.sort_by ?? 'score') === 'date' &&
    (filters.sortOrder ?? options.sort_order ?? 'desc') === 'desc';
  const params: Record<string, unknown> = {
    limit,
    offset: hasCursor || useDateFeed ? 0 : (options.offset ?? (page - 1) * limit),
    include_classifications: options.includeClassifications ?? true,
    include_classification: options.includeClassification ?? 'summary',
  };

  if (entityId !== undefined) {
    params.entity_id = entityId;
  }

  params.sort_by = filters.sortBy ?? options.sort_by ?? 'score';
  params.sort_order = filters.sortOrder ?? options.sort_order ?? 'desc';

  if (filters.platforms && filters.platforms.length > 0) {
    params.platforms = filters.platforms;
  }

  if (filters.dateRange) {
    params.since = filters.dateRange[0].toISOString().split('T')[0];
    params.until = filters.dateRange[1].toISOString().split('T')[0];
  }

  if (filters.engagementRange) {
    if (filters.engagementRange[0] !== 0) {
      params.engagement_min = filters.engagementRange[0];
    }
    if (filters.engagementRange[1] !== 100) {
      params.engagement_max = filters.engagementRange[1];
    }
  }

  if (filters.classificationFilters) {
    const normalized = normalizeClassificationFilters(filters.classificationFilters);
    if (Object.keys(normalized).length > 0) {
      params.classification_filters = normalized;
    }
  }

  if (filters.searchQuery && filters.searchQuery.trim().length >= 3) {
    params.query = filters.searchQuery.trim();
  }

  if (filters.reviewStatus && filters.reviewStatus !== 'all') {
    params.classification_source =
      filters.reviewStatus === 'system' ? 'embedding' : filters.reviewStatus;
  }

  if (filters.windowId != null) {
    params.window_id = filters.windowId;
  }

  if (filters.contentIds && filters.contentIds.length > 0) {
    params.content_ids = filters.contentIds;
  }

  if (filters.beforeOccurredAt && filters.beforeId != null) {
    params.before_occurred_at = filters.beforeOccurredAt;
    params.before_id = filters.beforeId;
  }

  if (filters.afterOccurredAt && filters.afterId != null) {
    params.after_occurred_at = filters.afterOccurredAt;
    params.after_id = filters.afterId;
  }

  if (filters.interactionStatus) {
    params.interaction_status = filters.interactionStatus;
  }

  return params;
}

export const DEFAULT_FILTERS: EventFilters = {
  dateRange: null,
  engagementRange: [0, 100],
  classificationFilters: {},
  searchQuery: '',
  platforms: [],
  page: 1,
  sortBy: 'score',
  sortOrder: 'desc',
  reviewStatus: 'all',
  windowId: null,
  contentIds: null,
  beforeOccurredAt: null,
  beforeId: null,
  afterOccurredAt: null,
  afterId: null,
  interactionStatus: null,
};

export function mergeWithDefaults(partial: PartialEventFilters): EventFilters {
  return { ...DEFAULT_FILTERS, ...partial };
}

export function applyEventTabDefaults(filters: PartialEventFilters): PartialEventFilters {
  return {
    sortBy: filters.sortBy ?? 'date',
    sortOrder: filters.sortOrder ?? 'desc',
    ...filters,
  };
}

export function isDateFeedMode(filters: PartialEventFilters): boolean {
  const resolved = applyEventTabDefaults(filters);
  return resolved.sortBy === 'date' && resolved.sortOrder === 'desc';
}

export function hasActiveFilters(filters: PartialEventFilters): boolean {
  return (
    (filters.searchQuery?.trim() ?? '').length > 0 ||
    (filters.platforms?.length ?? 0) > 0 ||
    (filters.dateRange !== null && filters.dateRange !== undefined) ||
    (filters.engagementRange?.[0] ?? 0) !== 0 ||
    (filters.engagementRange?.[1] ?? 100) !== 100 ||
    (filters.reviewStatus ?? 'all') !== 'all' ||
    Object.keys(filters.classificationFilters ?? {}).length > 0 ||
    filters.windowId != null ||
    (filters.contentIds != null && filters.contentIds.length > 0) ||
    (filters.interactionStatus != null && filters.interactionStatus !== '')
  );
}
