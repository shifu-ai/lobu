/**
 * Aggregation utilities for merging watcher windows
 * Shared watcher-window aggregation helpers for the current web app.
 */

import { differenceInDays } from 'date-fns';
import type { TimeGranularity, WatcherWindow } from '@/hooks/use-watchers';
import {
  getAvailableWatcherGranularities,
  inferWatcherGranularityFromDays,
} from '@/lib/watcher-time';

export interface AggregatedData {
  data: Record<string, unknown>;
  metadata: {
    contentCount: number;
    dateRange: {
      from: Date;
      to: Date;
    };
    windowCount: number;
    deduplicationApplied: boolean;
    granularities: TimeGranularity[];
    skippedIncompatibleWindows?: number;
  };
}

/**
 * Auto-calculate granularity based on date range
 */
export function autoCalculateGranularity(dateRange?: { from: Date; to: Date }): TimeGranularity {
  if (!dateRange) return 'quarterly';

  const days = differenceInDays(dateRange.to, dateRange.from);
  return inferWatcherGranularityFromDays(days);
}

/**
 * Detect the key field for an array of objects
 */
function detectKeyField(items: unknown[]): string | null {
  if (!items.length || typeof items[0] !== 'object' || items[0] === null) return null;

  const keyFieldCandidates = ['category', 'problem_name', 'name', 'id', 'key', 'slug'];
  const firstItem = items[0] as Record<string, unknown>;

  for (const field of keyFieldCandidates) {
    if (field in firstItem && typeof firstItem[field] === 'string') {
      return field;
    }
  }
  return null;
}

/**
 * Merge two objects, combining arrays and summing numbers
 */
function mergeObjects(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...target };

  for (const key in source) {
    if (!(key in result)) {
      result[key] = source[key];
    } else if (Array.isArray(result[key]) && Array.isArray(source[key])) {
      const combined = [...(result[key] as unknown[]), ...(source[key] as unknown[])];
      if (combined.length > 0 && typeof combined[0] !== 'object') {
        result[key] = Array.from(new Set(combined));
      } else {
        result[key] = combined;
      }
    } else if (typeof result[key] === 'number' && typeof source[key] === 'number') {
      result[key] = (result[key] as number) + (source[key] as number);
    } else {
      // Type conflict or non-mergeable: newer window wins
      result[key] = source[key];
    }
  }

  return result;
}

/**
 * Deduplicate and merge array items by key field
 */
function deduplicateItems(items: unknown[]): unknown[] {
  if (!Array.isArray(items) || items.length === 0) return items;

  const firstItem = items[0];

  if (typeof firstItem === 'string') {
    return Array.from(new Set(items));
  }

  if (typeof firstItem === 'number') {
    return Array.from(new Set(items));
  }

  if (typeof firstItem === 'object' && firstItem !== null) {
    const keyField = detectKeyField(items);

    if (keyField) {
      const grouped = new Map<string, Record<string, unknown>>();

      for (const item of items) {
        const itemObj = item as Record<string, unknown>;
        const key = itemObj[keyField] as string;
        const existing = grouped.get(key);
        if (existing) {
          grouped.set(key, mergeObjects(existing, itemObj));
        } else {
          grouped.set(key, { ...itemObj });
        }
      }

      return Array.from(grouped.values());
    }

    const firstObj = firstItem as Record<string, unknown>;
    if ('id' in firstObj && typeof firstObj.id === 'number') {
      const seen = new Set<number>();
      return items.filter((item) => {
        const id = (item as Record<string, unknown>).id as number;
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
    }

    const stableStringify = (obj: unknown): string =>
      JSON.stringify(obj, Object.keys(obj as Record<string, unknown>).sort());
    const seen = new Set<string>();
    return items.filter((item) => {
      const str = stableStringify(item);
      if (seen.has(str)) return false;
      seen.add(str);
      return true;
    });
  }

  return items;
}

/**
 * Deep merge two objects
 */
function deepMerge(target: unknown, source: unknown): unknown {
  if (typeof target !== 'object' || target === null) return source;
  if (typeof source !== 'object' || source === null) return target;

  const result = { ...(target as Record<string, unknown>) };
  const sourceObj = source as Record<string, unknown>;

  for (const key in sourceObj) {
    if (!(key in result)) {
      result[key] = sourceObj[key];
    } else if (Array.isArray(result[key]) && Array.isArray(sourceObj[key])) {
      result[key] = [...(result[key] as unknown[]), ...(sourceObj[key] as unknown[])];
    } else if (
      typeof result[key] === 'object' &&
      typeof sourceObj[key] === 'object' &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(result[key], sourceObj[key]);
    } else if (typeof result[key] === 'number' && typeof sourceObj[key] === 'number') {
      result[key] = (result[key] as number) + (sourceObj[key] as number);
    } else {
      result[key] = sourceObj[key];
    }
  }

  return result;
}

/**
 * Merge multiple watcher windows into aggregated data
 */
export function mergeWindows(windows: WatcherWindow[]): AggregatedData {
  if (windows.length === 0) {
    return {
      data: {},
      metadata: {
        contentCount: 0,
        dateRange: {
          from: new Date(),
          to: new Date(),
        },
        windowCount: 0,
        deduplicationApplied: false,
        granularities: [],
      },
    };
  }

  const sortedWindows = [...windows].sort(
    (a, b) => new Date(a.window_start).getTime() - new Date(b.window_start).getTime()
  );

  // Filter to only merge windows with compatible template versions
  const latestVersionId = sortedWindows[sortedWindows.length - 1].version_id;
  const compatibleWindows = sortedWindows.filter(
    (w) => w.version_id === latestVersionId || !w.version_id
  );
  const skippedIncompatibleWindows = sortedWindows.length - compatibleWindows.length;

  const firstWindow = compatibleWindows[0] ?? sortedWindows[0];
  const lastWindow =
    compatibleWindows[compatibleWindows.length - 1] ?? sortedWindows[sortedWindows.length - 1];
  const contentCount = compatibleWindows.reduce((sum, w) => sum + (w.content_analyzed || 0), 0);
  const granularities = Array.from(new Set(compatibleWindows.map((w) => w.granularity)));

  let mergedData: Record<string, unknown> = {};
  for (const window of compatibleWindows) {
    if (window.extracted_data) {
      mergedData = deepMerge(mergedData, window.extracted_data) as Record<string, unknown>;
    }
  }

  let deduplicationApplied = false;
  function deduplicateArrays(obj: unknown): unknown {
    if (Array.isArray(obj)) {
      const deduplicated = deduplicateItems(obj);
      if (deduplicated.length !== obj.length) {
        deduplicationApplied = true;
      }
      return deduplicated;
    } else if (typeof obj === 'object' && obj !== null) {
      const result: Record<string, unknown> = {};
      for (const key in obj as Record<string, unknown>) {
        result[key] = deduplicateArrays((obj as Record<string, unknown>)[key]);
      }
      return result;
    }
    return obj;
  }

  mergedData = deduplicateArrays(mergedData) as Record<string, unknown>;

  return {
    data: mergedData,
    metadata: {
      contentCount,
      dateRange: {
        from: new Date(firstWindow.window_start),
        to: new Date(lastWindow.window_end),
      },
      windowCount: compatibleWindows.length,
      deduplicationApplied,
      granularities,
      skippedIncompatibleWindows:
        skippedIncompatibleWindows > 0 ? skippedIncompatibleWindows : undefined,
    },
  };
}

/**
 * Format date range for display
 */
export function formatDateRange(from: Date, to: Date): string {
  const formatter = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  return `${formatter.format(from)} - ${formatter.format(to)}`;
}

/**
 * Format window date range with granularity context
 */
export function formatWindowDateRange(
  windowStart: string,
  windowEnd: string,
  granularity: TimeGranularity
): string {
  const start = new Date(windowStart);
  const end = new Date(windowEnd);

  const dateFormatter = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
  });

  const yearFormatter = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
  });

  const startStr = dateFormatter.format(start);
  const endStr = dateFormatter.format(end);
  const year = yearFormatter.format(end);

  // For daily, just show the single date
  if (granularity === 'daily') {
    return `${startStr}, ${year}`;
  }

  return `${startStr} - ${endStr}, ${year}`;
}

/**
 * Get available granularities based on base granularity
 */
export function getAvailableGranularities(baseGranularity?: TimeGranularity): TimeGranularity[] {
  if (!baseGranularity || baseGranularity === 'auto') {
    return getAvailableWatcherGranularities();
  }
  return getAvailableWatcherGranularities(baseGranularity);
}
