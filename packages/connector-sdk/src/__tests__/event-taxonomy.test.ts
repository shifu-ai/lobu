import { describe, expect, test } from 'bun:test';
import { isSourceNativeEventType, SOURCE_NATIVE_EVENT_TYPES } from '../event-taxonomy.js';

describe('SOURCE_NATIVE_EVENT_TYPES', () => {
  test('has no duplicate entries', () => {
    expect(new Set(SOURCE_NATIVE_EVENT_TYPES).size).toBe(SOURCE_NATIVE_EVENT_TYPES.length);
  });
});

describe('isSourceNativeEventType', () => {
  test('returns true for every canonical type', () => {
    for (const t of SOURCE_NATIVE_EVENT_TYPES) {
      expect(isSourceNativeEventType(t)).toBe(true);
    }
  });

  test.each<[unknown, boolean]>([
    ['not_an_event', false],
    ['', false],
    [null, false],
    [undefined, false],
    [123, false],
    [{}, false],
    ['Comment', false], // case-sensitive
    ['COMMENT', false],
  ])('isSourceNativeEventType(%p) → %s', (input, expected) => {
    expect(isSourceNativeEventType(input as string)).toBe(expected);
  });
});
