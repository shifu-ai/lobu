export const WATCHER_TIME_GRANULARITIES = ['daily', 'weekly', 'monthly', 'quarterly'] as const;

export type WatcherTimeGranularity = (typeof WATCHER_TIME_GRANULARITIES)[number];

export function isWatcherTimeGranularity(value: unknown): value is WatcherTimeGranularity {
  return (
    typeof value === 'string' && (WATCHER_TIME_GRANULARITIES as readonly string[]).includes(value)
  );
}

export function inferWatcherGranularityFromDays(daysDiff: number): WatcherTimeGranularity {
  if (daysDiff <= 14) return 'daily';
  if (daysDiff <= 90) return 'weekly';
  if (daysDiff <= 365) return 'monthly';
  return 'quarterly';
}

export function inferWatcherGranularityFromSchedule(
  schedule: string | null | undefined
): WatcherTimeGranularity {
  if (!schedule) return 'weekly';

  const parts = schedule.trim().split(/\s+/);
  if (parts.length < 5) return 'weekly';

  const [, hour, dom, month, dow] = parts;

  if (month !== '*' && dom !== '*') return 'quarterly';
  if (dom !== '*' && month === '*') return 'monthly';
  if (dow !== '*' && dom === '*') return 'weekly';
  if (hour !== '*' && dom === '*') return 'daily';
  if (hour === '*' || hour.includes('/') || hour.includes(',')) return 'daily';

  return 'weekly';
}

export function getAvailableWatcherGranularities(
  baseGranularity?: WatcherTimeGranularity
): WatcherTimeGranularity[] {
  if (!baseGranularity) return [...WATCHER_TIME_GRANULARITIES];

  const baseIndex = WATCHER_TIME_GRANULARITIES.indexOf(baseGranularity);
  return baseIndex === -1
    ? [...WATCHER_TIME_GRANULARITIES]
    : [...WATCHER_TIME_GRANULARITIES.slice(baseIndex)];
}
