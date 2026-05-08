import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Type, type TObject } from '@sinclair/typebox';
import { RateLimitError } from '../base.js';
import { sdkLogger } from '../logger.js';
import {
  PaginatedFeed,
  type PageFetchResult,
  type PaginatedCheckpoint,
  type PaginationConfig,
} from '../paginated.js';
import type {
  Checkpoint,
  Content,
  Env,
  FeedOptions,
  ScoringConfig,
  SessionState,
} from '../types.js';

let originalLogLevel: string;
beforeAll(() => {
  originalLogLevel = sdkLogger.level;
  sdkLogger.level = 'silent';
});
afterAll(() => {
  sdkLogger.level = originalLogLevel;
});

const SCORING_CONFIG: ScoringConfig = {
  engagement_weight: 0.4,
  inverse_rating_weight: 0.2,
  content_length_weight: 0.2,
  platform_weight: 0.2,
};

interface Item {
  id: string;
  date: Date;
  parent?: string | null;
  drop?: boolean;
}

class TestPaginatedFeed extends PaginatedFeed<Item> {
  readonly type = 'tpag';
  readonly displayName = 'TPag';
  readonly apiType = 'api' as const;
  readonly feedMode = 'entity' as const;
  readonly optionsSchema: TObject = Type.Object({});
  readonly defaultScoringConfig: ScoringConfig = SCORING_CONFIG;
  readonly defaultScoringFormula = 'f.score';

  pages: Array<PageFetchResult<Item> | { throw: Error }> = [];
  fetchPageCalls: Array<string | null> = [];
  paginationConfigOverride: Partial<PaginationConfig> = { rateLimitMs: 0, pageSize: 100 };

  protected getPaginationConfig(): PaginationConfig {
    return {
      maxPages: 50,
      pageSize: 100,
      rateLimitMs: 0,
      incrementalCheckpoint: false,
      ...this.paginationConfigOverride,
    };
  }

  async pull(): Promise<{ contents: Content[]; checkpoint: Checkpoint | null }> {
    return { contents: [], checkpoint: null };
  }

  urlFromOptions(): string {
    return 'https://example.com';
  }
  displayLabelFromOptions(): string {
    return 'tpag';
  }
  validateOptions(): string | null {
    return null;
  }

  protected async fetchPage(
    cursor: string | null,
    _options: FeedOptions,
    _env: Env
  ): Promise<PageFetchResult<Item>> {
    this.fetchPageCalls.push(cursor);
    const next = this.pages.shift();
    if (!next) {
      return { items: [], nextToken: null };
    }
    if ('throw' in next) {
      throw next.throw;
    }
    return next;
  }

  protected transformItem(item: Item): Content {
    return {
      origin_id: item.id,
      payload_text: `text ${item.id}`,
      source_url: `https://x/${item.id}`,
      occurred_at: item.date,
      score: 0,
    };
  }

  protected getItemDate(item: Item): Date {
    return item.date;
  }

  protected filterItem(item: Item): boolean {
    return !item.drop;
  }

  protected getParentId(item: Item): string | null {
    return item.parent ?? null;
  }

  // Expose for tests
  async runPaginate(
    options: FeedOptions,
    checkpoint: PaginatedCheckpoint | null,
    env: Env,
    update?: (cp: Checkpoint) => Promise<void>
  ) {
    return this.paginate(options, checkpoint, env, update);
  }
}

const env: Env = { ENVIRONMENT: 'test' };

function recentDate(daysAgo = 1): Date {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
}

describe('PaginatedFeed.paginate', () => {
  test('empty page → returns empty contents, stops immediately', async () => {
    const feed = new TestPaginatedFeed();
    feed.pages = [{ items: [], nextToken: null }];

    const result = await feed.runPaginate({ lookback_days: 30 }, null, env);

    expect(result.contents).toEqual([]);
    expect(result.checkpoint.initial_complete).toBe(true);
    expect(result.checkpoint.pagination_token).toBeNull();
    expect(feed.fetchPageCalls).toEqual([null]);
  });

  test('single page → all items in result, partial-page stop', async () => {
    const feed = new TestPaginatedFeed();
    const items = [
      { id: '1', date: recentDate(1) },
      { id: '2', date: recentDate(2) },
    ];
    feed.pages = [{ items, nextToken: null }];

    const result = await feed.runPaginate({ lookback_days: 30 }, null, env);

    expect(result.contents).toHaveLength(2);
    expect(result.contents.map((c) => c.origin_id)).toEqual(['1', '2']);
    expect(result.checkpoint.pagination_token).toBeNull();
    expect(result.checkpoint.initial_complete).toBe(true);
    expect(result.checkpoint.total_items_processed).toBe(2);
  });

  test('multi-page → walks pages until partial page', async () => {
    const feed = new TestPaginatedFeed();
    feed.paginationConfigOverride = { rateLimitMs: 0, pageSize: 2 };
    feed.pages = [
      {
        items: [
          { id: '1', date: recentDate(1) },
          { id: '2', date: recentDate(2) },
        ],
        nextToken: 'cursor-2',
      },
      {
        items: [
          { id: '3', date: recentDate(3) },
          { id: '4', date: recentDate(4) },
        ],
        nextToken: 'cursor-3',
      },
      {
        // Partial page - signals end
        items: [{ id: '5', date: recentDate(5) }],
        nextToken: null,
      },
    ];

    const result = await feed.runPaginate({ lookback_days: 30 }, null, env);

    expect(result.contents).toHaveLength(5);
    expect(feed.fetchPageCalls).toEqual([null, 'cursor-2', 'cursor-3']);
    expect(result.checkpoint.pagination_token).toBeNull();
  });

  test('end-of-stream via no_next_token (full page, no nextToken)', async () => {
    const feed = new TestPaginatedFeed();
    feed.paginationConfigOverride = { rateLimitMs: 0, pageSize: 2 };
    feed.pages = [
      {
        items: [
          { id: '1', date: recentDate(1) },
          { id: '2', date: recentDate(2) },
        ],
        nextToken: null,
      },
    ];

    const result = await feed.runPaginate({ lookback_days: 30 }, null, env);

    expect(result.contents).toHaveLength(2);
    expect(result.checkpoint.pagination_token).toBeNull();
    expect(result.checkpoint.initial_complete).toBe(true);
  });

  test('boundary stop: items older than lookback exhaust contents', async () => {
    const feed = new TestPaginatedFeed();
    feed.paginationConfigOverride = { rateLimitMs: 0, pageSize: 2 };
    feed.pages = [
      {
        // Both items way older than 1-day lookback → boundaryContents = 0
        items: [
          { id: 'old1', date: new Date(2000, 0, 1) },
          { id: 'old2', date: new Date(2000, 0, 2) },
        ],
        nextToken: 'next',
      },
    ];

    const result = await feed.runPaginate({ lookback_days: 1 }, null, env);

    expect(result.contents).toEqual([]);
    expect(feed.fetchPageCalls).toEqual([null]);
    expect(result.checkpoint.initial_complete).toBe(true);
  });

  test('max-pages cap → leaves resume token, marks initial_complete=false', async () => {
    const feed = new TestPaginatedFeed();
    feed.paginationConfigOverride = { rateLimitMs: 0, pageSize: 1, maxPages: 2 };
    feed.pages = [
      { items: [{ id: '1', date: recentDate(1) }], nextToken: 'c1' },
      { items: [{ id: '2', date: recentDate(2) }], nextToken: 'c2' },
      { items: [{ id: '3', date: recentDate(3) }], nextToken: 'c3' }, // never reached
    ];

    const result = await feed.runPaginate({ lookback_days: 30 }, null, env);

    expect(result.contents).toHaveLength(2);
    expect(result.checkpoint.pagination_token).toBe('c2');
    expect(result.checkpoint.initial_complete).toBe(false);
  });

  test('filterItem drops items before transform', async () => {
    const feed = new TestPaginatedFeed();
    feed.paginationConfigOverride = { rateLimitMs: 0, pageSize: 3 };
    feed.pages = [
      {
        items: [
          { id: '1', date: recentDate(1) },
          { id: '2', date: recentDate(1), drop: true },
          { id: '3', date: recentDate(1) },
        ],
        nextToken: null,
      },
    ];

    const result = await feed.runPaginate({ lookback_days: 30 }, null, env);

    expect(result.contents.map((c) => c.origin_id)).toEqual(['1', '3']);
  });

  test('parentMap is populated via getParentId and origin_parent_id is backfilled', async () => {
    const feed = new TestPaginatedFeed();
    feed.paginationConfigOverride = { rateLimitMs: 0, pageSize: 2 };
    feed.pages = [
      {
        items: [
          { id: 'reply', date: recentDate(1), parent: 'thread1' },
          { id: 'top', date: recentDate(1) },
        ],
        nextToken: null,
      },
    ];

    const result = await feed.runPaginate({ lookback_days: 30 }, null, env);

    expect(result.parentMap).toBeDefined();
    expect(result.parentMap?.get('reply')).toBe('thread1');
    const reply = result.contents.find((c) => c.origin_id === 'reply');
    expect(reply?.origin_parent_id).toBe('thread1');
  });

  test('parentMap is undefined when no parents are present', async () => {
    const feed = new TestPaginatedFeed();
    feed.pages = [
      {
        items: [{ id: 'a', date: recentDate(1) }],
        nextToken: null,
      },
    ];

    const result = await feed.runPaginate({ lookback_days: 30 }, null, env);

    expect(result.parentMap).toBeUndefined();
  });

  test('error mid-stream is propagated to caller', async () => {
    const feed = new TestPaginatedFeed();
    feed.paginationConfigOverride = { rateLimitMs: 0, pageSize: 2 };
    feed.pages = [
      {
        items: [
          { id: '1', date: recentDate(1) },
          { id: '2', date: recentDate(1) },
        ],
        nextToken: 'cursor-2',
      },
      { throw: new Error('boom') },
    ];

    await expect(feed.runPaginate({ lookback_days: 30 }, null, env)).rejects.toThrow('boom');
  });

  test('RateLimitError stops pagination, sets resume token, schedules retry', async () => {
    const feed = new TestPaginatedFeed();
    feed.paginationConfigOverride = { rateLimitMs: 0, pageSize: 2 };
    feed.pages = [
      {
        items: [
          { id: '1', date: recentDate(1) },
          { id: '2', date: recentDate(1) },
        ],
        nextToken: 'cursor-2',
      },
      { throw: new RateLimitError('slow', 5000) },
    ];

    const result = await feed.runPaginate({ lookback_days: 30 }, null, env);

    expect(result.contents).toHaveLength(2);
    expect(result.checkpoint.pagination_token).toBe('cursor-2');
    expect(result.checkpoint.initial_complete).toBe(false);
    expect(result.nextSyncRecommendedAt).toBeInstanceOf(Date);
    const future = result.nextSyncRecommendedAt!.getTime();
    expect(future).toBeGreaterThan(Date.now() - 100);
  });

  test('incremental sync resumes from existing pagination token', async () => {
    const feed = new TestPaginatedFeed();
    feed.paginationConfigOverride = { rateLimitMs: 0, pageSize: 2 };
    feed.pages = [
      {
        items: [
          { id: '10', date: recentDate(1) },
          { id: '11', date: recentDate(1) },
        ],
        nextToken: null,
      },
    ];
    const checkpoint: PaginatedCheckpoint = {
      updated_at: new Date(),
      last_timestamp: new Date(2024, 0, 1),
      pagination_token: 'resume-token',
      initial_complete: false,
    };

    const result = await feed.runPaginate({ lookback_days: 30 }, checkpoint, env);

    expect(feed.fetchPageCalls[0]).toBe('resume-token');
    expect(result.contents).toHaveLength(2);
  });

  test('initial_complete + no token → incremental mode, ignores pagination_token, starts fresh', async () => {
    const feed = new TestPaginatedFeed();
    feed.paginationConfigOverride = { rateLimitMs: 0, pageSize: 2 };
    feed.pages = [
      {
        items: [{ id: 'new', date: recentDate(0) }],
        nextToken: null,
      },
    ];
    const checkpoint: PaginatedCheckpoint = {
      updated_at: new Date(),
      last_timestamp: new Date(Date.now() - 60_000),
      pagination_token: null,
      initial_complete: true,
    };

    const result = await feed.runPaginate({ lookback_days: 30 }, checkpoint, env);

    expect(feed.fetchPageCalls[0]).toBeNull();
    expect(result.contents.map((c) => c.origin_id)).toEqual(['new']);
  });

  test('incrementalCheckpoint=true triggers updateCheckpointFn after each page', async () => {
    const feed = new TestPaginatedFeed();
    feed.paginationConfigOverride = {
      rateLimitMs: 0,
      pageSize: 2,
      incrementalCheckpoint: true,
    };
    feed.pages = [
      {
        items: [
          { id: '1', date: recentDate(1) },
          { id: '2', date: recentDate(1) },
        ],
        nextToken: 'c2',
      },
      {
        items: [{ id: '3', date: recentDate(1) }],
        nextToken: null,
      },
    ];

    const updates: Checkpoint[] = [];
    const updateFn = async (cp: Checkpoint) => {
      updates.push(cp);
    };

    await feed.runPaginate({ lookback_days: 30 }, null, env, updateFn);

    // Two pages with content → two incremental updates
    expect(updates).toHaveLength(2);
  });

  test('createCheckpoint preserves total_items_processed across runs', async () => {
    const feed = new TestPaginatedFeed();
    feed.pages = [
      {
        items: [{ id: '1', date: recentDate(1) }],
        nextToken: null,
      },
    ];
    const existing: PaginatedCheckpoint = {
      updated_at: new Date(),
      total_items_processed: 10,
    };

    const result = await feed.runPaginate({ lookback_days: 30 }, existing, env);

    expect(result.checkpoint.total_items_processed).toBe(11);
  });
});
