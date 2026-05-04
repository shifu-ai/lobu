import { describe, expect, test } from 'bun:test';
import { getActionOutput, normalizeEventEnvelope } from '../executor/runtime.js';
import type { FeedSyncResult } from '../executor/interface.js';

describe('normalizeEventEnvelope', () => {
  test('passes canonical fields through', () => {
    const event = {
      origin_id: 'evt_1',
      payload_text: 'hello',
      title: 'Greeting',
      author_name: 'alice',
      source_url: 'https://example.com/p/1',
      occurred_at: '2024-01-02T03:04:05.000Z',
      origin_type: 'post',
      semantic_type: 'note',
      score: 0.42,
      origin_parent_id: 'parent_1',
      metadata: { tag: 'x' },
    };
    const out = normalizeEventEnvelope(event);
    expect(out.origin_id).toBe('evt_1');
    expect(out.payload_text).toBe('hello');
    expect(out.title).toBe('Greeting');
    expect(out.author_name).toBe('alice');
    expect(out.source_url).toBe('https://example.com/p/1');
    expect(out.occurred_at).toBeInstanceOf(Date);
    expect((out.occurred_at as Date).toISOString()).toBe('2024-01-02T03:04:05.000Z');
    expect(out.origin_type).toBe('post');
    expect(out.semantic_type).toBe('note');
    expect(out.score).toBe(0.42);
    expect(out.origin_parent_id).toBe('parent_1');
    expect(out.metadata).toEqual({ tag: 'x' });
  });

  test('falls back to legacy field names', () => {
    const event = {
      external_id: 'legacy_1',
      content: 'legacy body',
      author: 'bob',
      url: 'https://legacy.example.com/q',
      published_at: '2023-12-31T23:59:59.000Z',
      origin_type: 'comment',
      parent_external_id: 'legacy_parent',
    };
    const out = normalizeEventEnvelope(event);
    expect(out.origin_id).toBe('legacy_1');
    expect(out.payload_text).toBe('legacy body');
    expect(out.author_name).toBe('bob');
    expect(out.source_url).toBe('https://legacy.example.com/q');
    expect((out.occurred_at as Date).toISOString()).toBe('2023-12-31T23:59:59.000Z');
    expect(out.origin_parent_id).toBe('legacy_parent');
    // semantic_type defaults to origin_type when missing
    expect(out.semantic_type).toBe('comment');
  });

  test('defaults missing fields safely', () => {
    const before = Date.now();
    const out = normalizeEventEnvelope({ origin_id: 'x' });
    const after = Date.now();

    expect(out.payload_text).toBe('');
    expect(out.source_url).toBe('');
    expect(out.score).toBe(0);
    expect(out.metadata).toEqual({});
    expect(out.origin_parent_id).toBeNull();
    expect(out.occurred_at).toBeInstanceOf(Date);
    const ts = (out.occurred_at as Date).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  test('coerces non-numeric score to 0', () => {
    expect(normalizeEventEnvelope({ origin_id: 'x', score: 'high' as any }).score).toBe(0);
    expect(normalizeEventEnvelope({ origin_id: 'x', score: null as any }).score).toBe(0);
    expect(normalizeEventEnvelope({ origin_id: 'x', score: 1 }).score).toBe(1);
    expect(normalizeEventEnvelope({ origin_id: 'x', score: 0 }).score).toBe(0);
  });

  test('prefers occurred_at over published_at when both are present', () => {
    const out = normalizeEventEnvelope({
      origin_id: 'x',
      occurred_at: '2024-06-01T00:00:00.000Z',
      published_at: '2020-01-01T00:00:00.000Z',
    });
    expect((out.occurred_at as Date).toISOString()).toBe('2024-06-01T00:00:00.000Z');
  });
});

describe('getActionOutput', () => {
  test('returns the metadata of the first content item', () => {
    const result: FeedSyncResult = {
      contents: [
        { metadata: { ok: true, value: 42 } } as any,
        { metadata: { other: 'ignored' } } as any,
      ],
      checkpoint: null,
    };
    expect(getActionOutput(result)).toEqual({ ok: true, value: 42 });
  });

  test('returns an empty object when contents is empty', () => {
    const result: FeedSyncResult = { contents: [], checkpoint: null };
    expect(getActionOutput(result)).toEqual({});
  });

  test('returns an empty object when first content has no metadata', () => {
    const result: FeedSyncResult = {
      contents: [{} as any],
      checkpoint: null,
    };
    expect(getActionOutput(result)).toEqual({});
  });
});
