import { describe, expect, test } from 'bun:test';
import type { ReactionContext, ReactionEntity } from '../reaction-sdk.js';

// reaction-sdk.ts contains only type/interface definitions; there are no
// runtime exports. These tests verify the published shape stays usable by
// constructing values that satisfy the interfaces.

describe('ReactionEntity', () => {
  test('accepts a minimal valid object', () => {
    const e: ReactionEntity = {
      id: 1,
      name: 'Alice',
      entity_type: 'member',
      metadata: {},
    };
    expect(e.id).toBe(1);
    expect(e.entity_type).toBe('member');
    expect(e.metadata).toEqual({});
  });

  test('accepts arbitrary metadata keys', () => {
    const e: ReactionEntity = {
      id: 42,
      name: 'Bob',
      entity_type: 'member',
      metadata: { foo: 'bar', count: 7, flag: true, nested: { ok: 1 } },
    };
    expect(e.metadata.foo).toBe('bar');
  });
});

describe('ReactionContext', () => {
  test('accepts a fully populated context object', () => {
    const ctx: ReactionContext = {
      extracted_data: { sentiment: 'positive', topics: ['x', 'y'] },
      entities: [
        { id: 1, name: 'Alice', entity_type: 'member', metadata: {} },
      ],
      window: {
        id: 100,
        watcher_id: 7,
        window_start: '2024-01-01T00:00:00.000Z',
        window_end: '2024-01-08T00:00:00.000Z',
        granularity: 'weekly',
        content_analyzed: 25,
      },
      watcher: {
        id: 7,
        slug: 'my-watcher',
        name: 'My Watcher',
        version: 3,
      },
      organization_id: 'org_abc123',
    };

    expect(ctx.entities.length).toBe(1);
    expect(ctx.window.granularity).toBe('weekly');
    expect(ctx.watcher.slug).toBe('my-watcher');
    expect(ctx.organization_id).toBe('org_abc123');
  });
});
