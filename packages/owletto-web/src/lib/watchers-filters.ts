/**
 * Type-safe utilities for watcher filter URL parameters
 */

import type { TimeGranularity } from '@/hooks/use-watchers';
import { isWatcherTimeGranularity } from '@/lib/watcher-time';
import {
  type ClassificationFilters,
  getParam as getParamValue,
  parseClassificationParams,
  parseInt10,
  serializeClassificationParams,
  validateDateString,
} from './filter-utils';

export type { ClassificationFilters };

export interface WatcherFilters {
  since?: string; // ISO date YYYY-MM-DD
  until?: string; // ISO date YYYY-MM-DD
  granularity?: TimeGranularity;
  version?: number;
  entityIds?: number[];
  classificationFilters: ClassificationFilters;
}

export type PartialWatcherFilters = Partial<WatcherFilters>;

export function parseWatcherFiltersFromUrl(
  searchParams: URLSearchParams | Record<string, string | undefined>
): PartialWatcherFilters {
  const filters: PartialWatcherFilters = {};
  const get = (key: string) => getParamValue(searchParams, key);

  const since = get('since');
  if (since) filters.since = validateDateString(since);

  const until = get('until');
  if (until) filters.until = validateDateString(until);

  const granularity = get('granularity');
  if (isWatcherTimeGranularity(granularity)) {
    filters.granularity = granularity;
  }

  const versionStr = get('version');
  if (versionStr) filters.version = parseInt10(versionStr);

  const entityIds = get('entityIds');
  if (entityIds) {
    const parsed = entityIds
      .split(',')
      .map((value) => parseInt10(value.trim()))
      .filter((value): value is number => Number.isFinite(value));
    if (parsed.length > 0) filters.entityIds = parsed;
  }

  const classificationFilters = parseClassificationParams(searchParams);
  if (Object.keys(classificationFilters).length > 0) {
    filters.classificationFilters = classificationFilters;
  }

  return filters;
}

export function serializeWatcherFiltersToSearch(
  filters: PartialWatcherFilters
): Record<string, string | undefined> {
  const params: Record<string, string | undefined> = {};

  if (filters.since) params.since = filters.since;
  if (filters.until) params.until = filters.until;
  if (filters.granularity) params.granularity = filters.granularity;
  if (filters.version !== undefined) params.version = filters.version.toString();
  if (filters.entityIds && filters.entityIds.length > 0) {
    params.entityIds = filters.entityIds.join(',');
  }

  Object.assign(params, serializeClassificationParams(filters.classificationFilters));

  return params;
}
