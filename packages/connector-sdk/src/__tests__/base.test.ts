import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Type, type TObject } from '@sinclair/typebox';
import { BaseFeed, RateLimitError } from '../base.js';
import { sdkLogger } from '../logger.js';
import type {
  Checkpoint,
  Content,
  Env,
  FeedOptions,
  FeedSyncResult,
  ScoringConfig,
  SessionState,
} from '../types.js';

// Silence pino during tests
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

class TestFeed extends BaseFeed {
  readonly type = 'testfeed';
  readonly displayName = 'Test';
  readonly apiType = 'api' as const;
  readonly feedMode = 'entity' as const;
  readonly optionsSchema: TObject = Type.Object({
    handle: Type.String({ minLength: 1 }),
    lookback_days: Type.Optional(Type.Integer({ minimum: 1 })),
  });
  readonly defaultScoringConfig: ScoringConfig = SCORING_CONFIG;
  readonly defaultScoringFormula = 'f.score';

  async pull(
    _options: FeedOptions,
    _checkpoint: Checkpoint | null,
    _env: Env,
    _sessionState?: SessionState | null
  ): Promise<FeedSyncResult> {
    return { contents: [], checkpoint: { updated_at: new Date() } };
  }

  urlFromOptions(options: FeedOptions): string {
    return `https://example.com/${options.handle}`;
  }

  displayLabelFromOptions(options: FeedOptions): string {
    return String(options.handle);
  }

  validateOptions(options: FeedOptions): string | null {
    return this.validateWithSchema(options);
  }

  // Expose protected helpers for testing
  exposeIsNewerThan(date: Date, checkpoint: Checkpoint | null): boolean {
    return this.isNewerThan(date, checkpoint);
  }
  exposeGetLookbackDate(options: FeedOptions, defaultDays?: number): Date {
    return this.getLookbackDate(options, defaultDays);
  }
  exposeSleep(ms: number): Promise<void> {
    return this.sleep(ms);
  }
  exposeIsIncrementalMode(checkpoint: Checkpoint | null, token?: string | null): boolean {
    return this.isIncrementalMode(checkpoint, token);
  }
  exposeDeduplicate(contents: Content[], seen: Set<string>): Content[] {
    return this.deduplicate(contents, seen);
  }
  exposeHandleHTTPError(status: number, context: string, platform?: string): never {
    return this.handleHTTPError(status, context, platform);
  }
}

function makeContent(origin_id: string | undefined, occurred_at = new Date()): Content {
  return {
    origin_id: origin_id as string,
    payload_text: 'x',
    source_url: 'https://x',
    occurred_at,
    score: 0,
  };
}

describe('RateLimitError', () => {
  test('sets name and retryAfterMs', () => {
    const err = new RateLimitError('slow down', 1234);
    expect(err.name).toBe('RateLimitError');
    expect(err.message).toBe('slow down');
    expect(err.retryAfterMs).toBe(1234);
    expect(err).toBeInstanceOf(Error);
  });

  test('retryAfterMs is optional', () => {
    const err = new RateLimitError('limit');
    expect(err.retryAfterMs).toBeUndefined();
  });
});

describe('BaseFeed defaults', () => {
  const feed = new TestFeed();

  test('default authSchema is "none"', () => {
    expect(feed.authSchema).toEqual({ methods: [{ type: 'none' }] });
  });

  test('default getRateLimit returns conservative 10/min', () => {
    expect(feed.getRateLimit()).toEqual({
      requests_per_minute: 10,
      recommended_interval_ms: 6000,
    });
  });

  test('default getParentFeedDefinitions returns empty', () => {
    expect(feed.getParentFeedDefinitions({})).toEqual([]);
  });
});

describe('BaseFeed.validateWithSchema', () => {
  const feed = new TestFeed();

  test('returns null on valid options', () => {
    expect(feed.validateOptions({ handle: 'alice' })).toBeNull();
    expect(feed.validateOptions({ handle: 'alice', lookback_days: 7 })).toBeNull();
  });

  test('returns formatted error for missing required field', () => {
    const err = feed.validateOptions({});
    expect(err).not.toBeNull();
    expect(err).toMatch(/handle/);
  });

  test('returns formatted error for wrong type', () => {
    const err = feed.validateOptions({ handle: 'a', lookback_days: 'soon' });
    expect(err).not.toBeNull();
    expect(err).toMatch(/lookback_days/);
  });

  test('handles thrown errors as generic invalid format message', () => {
    // Force a throw by passing a poison schema via prototype trick on a subclass
    class BrokenFeed extends TestFeed {
      readonly optionsSchema = new Proxy(
        {},
        {
          get() {
            throw new Error('boom');
          },
        }
      ) as unknown as TObject;
    }
    const broken = new BrokenFeed();
    expect(broken.validateOptions({ handle: 'a' })).toBe('Invalid feed options format');
  });
});

describe('BaseFeed.isNewerThan', () => {
  const feed = new TestFeed();

  test('true when no checkpoint', () => {
    expect(feed.exposeIsNewerThan(new Date(2023, 0, 1), null)).toBe(true);
  });

  test('true when no last_timestamp on checkpoint', () => {
    expect(feed.exposeIsNewerThan(new Date(2023, 0, 1), { updated_at: new Date() })).toBe(true);
  });

  test('false when content is older than checkpoint', () => {
    const cp = { updated_at: new Date(), last_timestamp: new Date(2024, 5, 1) };
    expect(feed.exposeIsNewerThan(new Date(2024, 0, 1), cp)).toBe(false);
  });

  test('true when content is newer than checkpoint', () => {
    const cp = { updated_at: new Date(), last_timestamp: new Date(2023, 0, 1) };
    expect(feed.exposeIsNewerThan(new Date(2024, 5, 1), cp)).toBe(true);
  });

  test('false when content equals checkpoint exactly', () => {
    const ts = new Date(2024, 5, 1);
    const cp = { updated_at: new Date(), last_timestamp: ts };
    expect(feed.exposeIsNewerThan(ts, cp)).toBe(false);
  });
});

describe('BaseFeed.getLookbackDate', () => {
  const feed = new TestFeed();

  test('uses default of 365 days when not provided', () => {
    const before = Date.now();
    const date = feed.exposeGetLookbackDate({ handle: 'a' });
    const expected = before - 365 * 24 * 60 * 60 * 1000;
    // Loose tolerance for ms drift
    expect(date.getTime()).toBeGreaterThanOrEqual(expected - 1000);
    expect(date.getTime()).toBeLessThanOrEqual(expected + 1000);
  });

  test('uses options.lookback_days when set', () => {
    const before = Date.now();
    const date = feed.exposeGetLookbackDate({ handle: 'a', lookback_days: 7 });
    const expected = before - 7 * 24 * 60 * 60 * 1000;
    expect(date.getTime()).toBeGreaterThanOrEqual(expected - 1000);
    expect(date.getTime()).toBeLessThanOrEqual(expected + 1000);
  });

  test('uses provided defaultDays when option absent', () => {
    const before = Date.now();
    const date = feed.exposeGetLookbackDate({ handle: 'a' }, 30);
    const expected = before - 30 * 24 * 60 * 60 * 1000;
    expect(date.getTime()).toBeGreaterThanOrEqual(expected - 1000);
    expect(date.getTime()).toBeLessThanOrEqual(expected + 1000);
  });
});

describe('BaseFeed.sleep', () => {
  test('resolves after roughly the given ms', async () => {
    const feed = new TestFeed();
    const start = Date.now();
    await feed.exposeSleep(20);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(15);
  });
});

describe('BaseFeed.isIncrementalMode', () => {
  const feed = new TestFeed();

  test('false when no checkpoint', () => {
    expect(feed.exposeIsIncrementalMode(null)).toBe(false);
  });

  test('false when checkpoint has no last_timestamp', () => {
    expect(feed.exposeIsIncrementalMode({ updated_at: new Date() })).toBe(false);
  });

  test('true when checkpoint has last_timestamp and no token', () => {
    expect(
      feed.exposeIsIncrementalMode({ updated_at: new Date(), last_timestamp: new Date() })
    ).toBe(true);
  });

  test('false when pagination token is present', () => {
    expect(
      feed.exposeIsIncrementalMode(
        { updated_at: new Date(), last_timestamp: new Date() },
        'token123'
      )
    ).toBe(false);
  });

  test('treats empty-string token as falsy → incremental', () => {
    expect(
      feed.exposeIsIncrementalMode({ updated_at: new Date(), last_timestamp: new Date() }, '')
    ).toBe(true);
  });
});

describe('BaseFeed.deduplicate', () => {
  const feed = new TestFeed();

  test('removes duplicates within batch', () => {
    const seen = new Set<string>();
    const result = feed.exposeDeduplicate(
      [makeContent('a'), makeContent('b'), makeContent('a')],
      seen
    );
    expect(result.map((c) => c.origin_id)).toEqual(['a', 'b']);
    expect(seen.has('a')).toBe(true);
    expect(seen.has('b')).toBe(true);
  });

  test('drops items with falsy origin_id', () => {
    const seen = new Set<string>();
    const result = feed.exposeDeduplicate(
      [makeContent(undefined), makeContent(''), makeContent('keep')],
      seen
    );
    expect(result.map((c) => c.origin_id)).toEqual(['keep']);
  });

  test('respects pre-populated seen set', () => {
    const seen = new Set<string>(['x']);
    const result = feed.exposeDeduplicate([makeContent('x'), makeContent('y')], seen);
    expect(result.map((c) => c.origin_id)).toEqual(['y']);
  });
});

describe('BaseFeed.handleHTTPError', () => {
  const feed = new TestFeed();

  test('429 throws RateLimitError', () => {
    expect(() => feed.exposeHandleHTTPError(429, 'fetching feed')).toThrow(RateLimitError);
  });

  test('non-429 throws regular Error with status-specific message', () => {
    expect(() => feed.exposeHandleHTTPError(404, 'item 1')).toThrow(/not found/i);
    expect(() => feed.exposeHandleHTTPError(401, 'item 1')).toThrow(/Authentication failed/);
    expect(() => feed.exposeHandleHTTPError(403, 'item 1')).toThrow(/forbidden/i);
    expect(() => feed.exposeHandleHTTPError(400, 'item 1')).toThrow(/Bad request/);
    expect(() => feed.exposeHandleHTTPError(422, 'item 1')).toThrow(/Invalid request/);
    expect(() => feed.exposeHandleHTTPError(500, 'item 1')).toThrow(/server error/i);
    expect(() => feed.exposeHandleHTTPError(502, 'item 1')).toThrow(/bad gateway/i);
    expect(() => feed.exposeHandleHTTPError(503, 'item 1')).toThrow(/service unavailable/i);
  });

  test('unknown status throws generic API error message', () => {
    expect(() => feed.exposeHandleHTTPError(418, 'teapot')).toThrow(/API error: 418/);
  });

  test('uses provided platformName override', () => {
    try {
      feed.exposeHandleHTTPError(404, 'thing', 'CustomPlatform');
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toContain('CustomPlatform');
    }
  });

  test('falls back to displayName when platformName not provided', () => {
    try {
      feed.exposeHandleHTTPError(404, 'thing');
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toContain('Test');
    }
  });
});
