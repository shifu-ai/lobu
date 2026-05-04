import { describe, expect, test } from 'bun:test';
import { isSourceNativeEventType, SOURCE_NATIVE_EVENT_TYPES } from '../event-taxonomy.js';

describe('SOURCE_NATIVE_EVENT_TYPES', () => {
  test('contains expected canonical types', () => {
    expect(SOURCE_NATIVE_EVENT_TYPES).toContain('article');
    expect(SOURCE_NATIVE_EVENT_TYPES).toContain('comment');
    expect(SOURCE_NATIVE_EVENT_TYPES).toContain('issue');
    expect(SOURCE_NATIVE_EVENT_TYPES).toContain('pull_request');
    expect(SOURCE_NATIVE_EVENT_TYPES).toContain('thread');
    expect(SOURCE_NATIVE_EVENT_TYPES).toContain('tweet');
  });

  test('has no duplicate entries', () => {
    const set = new Set<string>(SOURCE_NATIVE_EVENT_TYPES);
    expect(set.size).toBe(SOURCE_NATIVE_EVENT_TYPES.length);
  });

  test('is sorted alphabetically', () => {
    const sorted = [...SOURCE_NATIVE_EVENT_TYPES].sort();
    expect([...SOURCE_NATIVE_EVENT_TYPES]).toEqual(sorted);
  });
});

describe('isSourceNativeEventType', () => {
  test('returns true for every canonical type', () => {
    for (const t of SOURCE_NATIVE_EVENT_TYPES) {
      expect(isSourceNativeEventType(t)).toBe(true);
    }
  });

  test('returns false for unknown strings', () => {
    expect(isSourceNativeEventType('not_an_event')).toBe(false);
    expect(isSourceNativeEventType('')).toBe(false);
  });

  test('returns false for non-string values', () => {
    expect(isSourceNativeEventType(null)).toBe(false);
    expect(isSourceNativeEventType(undefined)).toBe(false);
    // @ts-expect-error
    expect(isSourceNativeEventType(123 as unknown as string)).toBe(false);
    // @ts-expect-error
    expect(isSourceNativeEventType({} as unknown as string)).toBe(false);
  });

  test('is case-sensitive', () => {
    expect(isSourceNativeEventType('Comment')).toBe(false);
    expect(isSourceNativeEventType('COMMENT')).toBe(false);
  });
});
