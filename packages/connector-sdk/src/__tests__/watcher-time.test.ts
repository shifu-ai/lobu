import { describe, expect, test } from 'bun:test';
import {
  addWatcherPeriod,
  alignToWatcherWindowStart,
  getAvailableWatcherGranularities,
  getFinerWatcherGranularities,
  getNextWatcherGranularity,
  getWatcherDateTruncUnit,
  inferWatcherGranularityFromDays,
  inferWatcherGranularityFromSchedule,
  isWatcherTimeGranularity,
  shiftWatcherPeriod,
  subtractWatcherPeriod,
  WATCHER_TIME_GRANULARITIES,
} from '../watcher-time.js';

describe('WATCHER_TIME_GRANULARITIES constant', () => {
  test('contains daily, weekly, monthly, quarterly in order', () => {
    expect([...WATCHER_TIME_GRANULARITIES]).toEqual(['daily', 'weekly', 'monthly', 'quarterly']);
  });
});

describe('isWatcherTimeGranularity', () => {
  test('accepts each canonical granularity', () => {
    for (const g of WATCHER_TIME_GRANULARITIES) {
      expect(isWatcherTimeGranularity(g)).toBe(true);
    }
  });

  test('rejects unknown strings', () => {
    expect(isWatcherTimeGranularity('hourly')).toBe(false);
    expect(isWatcherTimeGranularity('')).toBe(false);
  });

  test('rejects non-strings', () => {
    expect(isWatcherTimeGranularity(null)).toBe(false);
    expect(isWatcherTimeGranularity(undefined)).toBe(false);
    expect(isWatcherTimeGranularity(123)).toBe(false);
    expect(isWatcherTimeGranularity({})).toBe(false);
  });
});

describe('inferWatcherGranularityFromDays', () => {
  test('<=14 days → daily', () => {
    expect(inferWatcherGranularityFromDays(0)).toBe('daily');
    expect(inferWatcherGranularityFromDays(14)).toBe('daily');
  });

  test('15..90 → weekly', () => {
    expect(inferWatcherGranularityFromDays(15)).toBe('weekly');
    expect(inferWatcherGranularityFromDays(90)).toBe('weekly');
  });

  test('91..365 → monthly', () => {
    expect(inferWatcherGranularityFromDays(91)).toBe('monthly');
    expect(inferWatcherGranularityFromDays(365)).toBe('monthly');
  });

  test('>365 → quarterly', () => {
    expect(inferWatcherGranularityFromDays(366)).toBe('quarterly');
    expect(inferWatcherGranularityFromDays(10000)).toBe('quarterly');
  });
});

describe('inferWatcherGranularityFromSchedule', () => {
  test('null/undefined/empty → weekly default', () => {
    expect(inferWatcherGranularityFromSchedule(null)).toBe('weekly');
    expect(inferWatcherGranularityFromSchedule(undefined)).toBe('weekly');
    expect(inferWatcherGranularityFromSchedule('')).toBe('weekly');
  });

  test('malformed cron (too few fields) → weekly', () => {
    expect(inferWatcherGranularityFromSchedule('* * *')).toBe('weekly');
  });

  test('annual cron (specific month + dom) → quarterly', () => {
    expect(inferWatcherGranularityFromSchedule('0 0 1 1 *')).toBe('quarterly');
  });

  test('day-of-month set, month wildcard → monthly', () => {
    expect(inferWatcherGranularityFromSchedule('0 0 1 * *')).toBe('monthly');
  });

  test('day-of-week set with wildcard dom → weekly', () => {
    expect(inferWatcherGranularityFromSchedule('0 0 * * 1')).toBe('weekly');
  });

  test('hour set with wildcard dom → daily', () => {
    expect(inferWatcherGranularityFromSchedule('0 9 * * *')).toBe('daily');
  });

  test('hour wildcard (every hour) → daily', () => {
    expect(inferWatcherGranularityFromSchedule('0 * * * *')).toBe('daily');
  });

  test('hour using step (e.g. */2) → daily', () => {
    // Note: hour=*/2 -> dom='*' so it matches the hour-with-wildcard-dom branch (daily).
    expect(inferWatcherGranularityFromSchedule('0 */2 * * *')).toBe('daily');
  });
});

describe('getAvailableWatcherGranularities', () => {
  test('returns all when no base passed', () => {
    expect(getAvailableWatcherGranularities()).toEqual([
      'daily',
      'weekly',
      'monthly',
      'quarterly',
    ]);
  });

  test('returns subset starting from base', () => {
    expect(getAvailableWatcherGranularities('weekly')).toEqual(['weekly', 'monthly', 'quarterly']);
    expect(getAvailableWatcherGranularities('quarterly')).toEqual(['quarterly']);
  });

  test('returns all when base is unknown', () => {
    expect(
      getAvailableWatcherGranularities('hourly' as unknown as 'daily')
    ).toEqual(['daily', 'weekly', 'monthly', 'quarterly']);
  });
});

describe('getFinerWatcherGranularities', () => {
  test('daily has no finer', () => {
    expect(getFinerWatcherGranularities('daily')).toEqual([]);
  });

  test('weekly → [daily]', () => {
    expect(getFinerWatcherGranularities('weekly')).toEqual(['daily']);
  });

  test('quarterly → [monthly, weekly, daily]', () => {
    expect(getFinerWatcherGranularities('quarterly')).toEqual(['monthly', 'weekly', 'daily']);
  });
});

describe('getNextWatcherGranularity', () => {
  test('daily → weekly', () => {
    expect(getNextWatcherGranularity('daily')).toBe('weekly');
  });

  test('monthly → quarterly', () => {
    expect(getNextWatcherGranularity('monthly')).toBe('quarterly');
  });

  test('quarterly → null (terminal)', () => {
    expect(getNextWatcherGranularity('quarterly')).toBeNull();
  });
});

describe('getWatcherDateTruncUnit', () => {
  test('maps every granularity to a SQL date_trunc unit', () => {
    expect(getWatcherDateTruncUnit('daily')).toBe('day');
    expect(getWatcherDateTruncUnit('weekly')).toBe('week');
    expect(getWatcherDateTruncUnit('monthly')).toBe('month');
    expect(getWatcherDateTruncUnit('quarterly')).toBe('quarter');
  });
});

describe('shiftWatcherPeriod', () => {
  const base = new Date('2024-06-15T12:00:00.000Z');

  test('daily +1', () => {
    const out = shiftWatcherPeriod(base, 'daily', 1);
    expect(out.toISOString()).toBe('2024-06-16T12:00:00.000Z');
  });

  test('daily -1', () => {
    const out = shiftWatcherPeriod(base, 'daily', -1);
    expect(out.toISOString()).toBe('2024-06-14T12:00:00.000Z');
  });

  test('weekly +1 adds 7 days', () => {
    const out = shiftWatcherPeriod(base, 'weekly', 1);
    expect(out.toISOString()).toBe('2024-06-22T12:00:00.000Z');
  });

  test('monthly +1 adds a month', () => {
    const out = shiftWatcherPeriod(base, 'monthly', 1);
    expect(out.toISOString()).toBe('2024-07-15T12:00:00.000Z');
  });

  test('quarterly +1 adds 3 months', () => {
    const out = shiftWatcherPeriod(base, 'quarterly', 1);
    expect(out.toISOString()).toBe('2024-09-15T12:00:00.000Z');
  });

  test('does not mutate input', () => {
    const beforeIso = base.toISOString();
    shiftWatcherPeriod(base, 'monthly', 1);
    expect(base.toISOString()).toBe(beforeIso);
  });
});

describe('addWatcherPeriod / subtractWatcherPeriod', () => {
  const base = new Date('2024-06-15T12:00:00.000Z');

  test('addWatcherPeriod(weekly) === shift +7 days', () => {
    expect(addWatcherPeriod(base, 'weekly').toISOString()).toBe('2024-06-22T12:00:00.000Z');
  });

  test('subtractWatcherPeriod(monthly) === shift back 1 month', () => {
    expect(subtractWatcherPeriod(base, 'monthly').toISOString()).toBe('2024-05-15T12:00:00.000Z');
  });
});

describe('alignToWatcherWindowStart', () => {
  test('daily zeros out time-of-day in UTC', () => {
    const d = new Date('2024-06-15T13:45:30.123Z');
    const out = alignToWatcherWindowStart(d, 'daily');
    expect(out.toISOString()).toBe('2024-06-15T00:00:00.000Z');
  });

  test('weekly snaps to Monday 00:00 UTC', () => {
    // 2024-06-15 is a Saturday → previous Monday is 2024-06-10
    const d = new Date('2024-06-15T13:45:30.123Z');
    const out = alignToWatcherWindowStart(d, 'weekly');
    expect(out.toISOString()).toBe('2024-06-10T00:00:00.000Z');
  });

  test('weekly when given Sunday rolls back 6 days', () => {
    // 2024-06-16 is a Sunday → previous Monday is 2024-06-10
    const d = new Date('2024-06-16T13:45:30.123Z');
    const out = alignToWatcherWindowStart(d, 'weekly');
    expect(out.toISOString()).toBe('2024-06-10T00:00:00.000Z');
  });

  test('weekly when given Monday returns same day at 00:00', () => {
    const d = new Date('2024-06-10T13:45:30.123Z');
    const out = alignToWatcherWindowStart(d, 'weekly');
    expect(out.toISOString()).toBe('2024-06-10T00:00:00.000Z');
  });

  test('monthly snaps to first of month at 00:00 UTC', () => {
    const d = new Date('2024-06-15T13:45:30.123Z');
    const out = alignToWatcherWindowStart(d, 'monthly');
    expect(out.toISOString()).toBe('2024-06-01T00:00:00.000Z');
  });

  test('quarterly snaps to start of quarter (Q2 begins April)', () => {
    const d = new Date('2024-06-15T13:45:30.123Z');
    const out = alignToWatcherWindowStart(d, 'quarterly');
    expect(out.toISOString()).toBe('2024-04-01T00:00:00.000Z');
  });

  test('quarterly snaps to start of quarter (Q1)', () => {
    const d = new Date('2024-02-29T13:45:30.123Z');
    const out = alignToWatcherWindowStart(d, 'quarterly');
    expect(out.toISOString()).toBe('2024-01-01T00:00:00.000Z');
  });

  test('quarterly snaps to start of quarter (Q4)', () => {
    const d = new Date('2024-12-31T13:45:30.123Z');
    const out = alignToWatcherWindowStart(d, 'quarterly');
    expect(out.toISOString()).toBe('2024-10-01T00:00:00.000Z');
  });
});
