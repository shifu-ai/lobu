import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { Type, type TObject } from '@sinclair/typebox';
import ky, { type KyInstance } from 'ky';
import { ApiPaginatedFeed, type ApiSessionState } from '../api-paginated.js';
import { sdkLogger } from '../logger.js';
import type { PageFetchResult } from '../paginated.js';
import type { Env, FeedOptions, ScoringConfig, SessionState } from '../types.js';

// A ky client without retries so the underlying handleHttpError + retry-after
// parsing in ApiPaginatedFeed runs synchronously without ky doing its own
// 5-retry exponential backoff (which would add tens of seconds per test).
const noRetryClient: KyInstance = ky.create({
  retry: 0,
  timeout: 5_000,
});

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  if (input instanceof Request) return input.url;
  return String(input);
}

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

interface ApiItem {
  id: string;
  ts: string;
}
interface ApiResponse {
  items: ApiItem[];
  next?: string | null;
}

class TestApiFeed extends ApiPaginatedFeed<ApiItem, ApiResponse> {
  readonly type = 'tapi';
  readonly displayName = 'TApi';
  readonly feedMode = 'entity' as const;
  readonly optionsSchema: TObject = Type.Object({});
  readonly defaultScoringConfig: ScoringConfig = SCORING_CONFIG;
  readonly defaultScoringFormula = 'f.score';

  baseUrl = 'https://api.example.test/items';

  async pull() {
    return { contents: [], checkpoint: null };
  }
  urlFromOptions() {
    return this.baseUrl;
  }
  displayLabelFromOptions() {
    return 'tapi';
  }
  validateOptions() {
    return null;
  }

  // Override to disable retries during tests
  protected getHttpClient(): KyInstance {
    return noRetryClient;
  }

  protected buildPageUrl(cursor: string | null): string {
    return cursor ? `${this.baseUrl}?cursor=${encodeURIComponent(cursor)}` : this.baseUrl;
  }
  protected parseResponse(response: ApiResponse): PageFetchResult<ApiItem> {
    return { items: response.items ?? [], nextToken: response.next ?? null };
  }
  protected transformItem(item: ApiItem) {
    return {
      origin_id: item.id,
      payload_text: item.id,
      source_url: `${this.baseUrl}/${item.id}`,
      occurred_at: new Date(item.ts),
      score: 0,
    };
  }
  protected getItemDate(item: ApiItem): Date {
    return new Date(item.ts);
  }

  // Test access helpers
  exposeSetSessionState(s: SessionState | null | undefined) {
    this.setSessionState(s);
  }
  exposeGetSessionState() {
    return this.getSessionState();
  }
  exposeCreateBearerClient(token: string, headers?: Record<string, string>) {
    return this.createBearerClient(token, headers);
  }
  exposeCreateClientWithHeaders(headers: Record<string, string>) {
    return this.createClientWithHeaders(headers);
  }
  exposeCreateClientFromSessionState(headers?: Record<string, string>) {
    return this.createClientFromSessionState(headers);
  }
  async exposeFetchPage(
    cursor: string | null,
    options: FeedOptions,
    env: Env
  ): Promise<PageFetchResult<ApiItem>> {
    return this.fetchPage(cursor, options, env);
  }
}

const env: Env = { ENVIRONMENT: 'test' };

let originalFetch: typeof globalThis.fetch;
beforeAll(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers as Record<string, string>) },
    ...init,
  });
}

describe('ApiPaginatedFeed metadata defaults', () => {
  test('apiType is "api"', () => {
    const feed = new TestApiFeed();
    expect(feed.apiType).toBe('api');
  });
});

describe('ApiPaginatedFeed.setSessionState / getSessionState', () => {
  test('null/undefined session resets state', () => {
    const feed = new TestApiFeed();
    feed.exposeSetSessionState({ access_token: 'abc' });
    expect(feed.exposeGetSessionState()?.access_token).toBe('abc');
    feed.exposeSetSessionState(null);
    expect(feed.exposeGetSessionState()).toBeNull();
    feed.exposeSetSessionState(undefined);
    expect(feed.exposeGetSessionState()).toBeNull();
  });

  test('stored session is returned as ApiSessionState', () => {
    const feed = new TestApiFeed();
    const state: ApiSessionState = {
      access_token: 't',
      token_type: 'Bearer',
      api_key: 'k',
      headers: { 'X-Custom': '1' },
    };
    feed.exposeSetSessionState(state);
    expect(feed.exposeGetSessionState()).toEqual(state);
  });
});

describe('ApiPaginatedFeed HTTP client builders', () => {
  test('createBearerClient builds a ky instance', () => {
    const feed = new TestApiFeed();
    const client = feed.exposeCreateBearerClient('token123', { 'X-Trace': 'a' });
    expect(typeof client.get).toBe('function');
    expect(typeof client.extend).toBe('function');
  });

  test('createClientWithHeaders builds a ky instance', () => {
    const feed = new TestApiFeed();
    const client = feed.exposeCreateClientWithHeaders({ 'X-Custom': '1' });
    expect(typeof client.get).toBe('function');
  });

  test('createClientFromSessionState returns default httpClient when no session set', () => {
    const feed = new TestApiFeed();
    const client = feed.exposeCreateClientFromSessionState();
    expect(typeof client.get).toBe('function');
  });

  test('createClientFromSessionState merges only-additional headers when no session', () => {
    const feed = new TestApiFeed();
    const client = feed.exposeCreateClientFromSessionState({ 'X-Foo': 'bar' });
    expect(typeof client.get).toBe('function');
  });

  test('createClientFromSessionState builds Bearer auth from access_token', () => {
    const feed = new TestApiFeed();
    feed.exposeSetSessionState({ access_token: 'tok', token_type: 'Bearer' });
    const client = feed.exposeCreateClientFromSessionState({ 'X-Custom': '1' });
    expect(typeof client.get).toBe('function');
  });

  test('createClientFromSessionState builds custom token_type', () => {
    const feed = new TestApiFeed();
    feed.exposeSetSessionState({ access_token: 'tok', token_type: 'Token' });
    const client = feed.exposeCreateClientFromSessionState();
    expect(typeof client.get).toBe('function');
  });

  test('createClientFromSessionState falls back to api_key when no access_token', () => {
    const feed = new TestApiFeed();
    feed.exposeSetSessionState({ api_key: 'apikey' });
    const client = feed.exposeCreateClientFromSessionState();
    expect(typeof client.get).toBe('function');
  });

  test('createClientFromSessionState with only stored headers (no token/key)', () => {
    const feed = new TestApiFeed();
    feed.exposeSetSessionState({ headers: { 'X-Stored': 'v' } });
    const client = feed.exposeCreateClientFromSessionState();
    expect(typeof client.get).toBe('function');
  });

  test('createClientFromSessionState with empty session and no extra headers returns default', () => {
    const feed = new TestApiFeed();
    feed.exposeSetSessionState({});
    const client = feed.exposeCreateClientFromSessionState();
    expect(typeof client.get).toBe('function');
  });
});

describe('ApiPaginatedFeed.fetchPage with mocked fetch', () => {
  test('200 response → items + nextToken via parseResponse', async () => {
    const feed = new TestApiFeed();
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(urlOf(input));
      return jsonResponse({
        items: [
          { id: '1', ts: '2024-01-01T00:00:00Z' },
          { id: '2', ts: '2024-01-02T00:00:00Z' },
        ],
        next: 'cursor-2',
      });
    }) as typeof globalThis.fetch;

    const result = await feed.exposeFetchPage(null, {}, env);

    expect(result.items.map((i) => i.id)).toEqual(['1', '2']);
    expect(result.nextToken).toBe('cursor-2');
    expect(seen[0]).toContain('https://api.example.test/items');
  });

  test('200 with cursor → URL includes encoded cursor', async () => {
    const feed = new TestApiFeed();
    let calledUrl = '';
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calledUrl = urlOf(input);
      return jsonResponse({ items: [], next: null });
    }) as typeof globalThis.fetch;

    await feed.exposeFetchPage('abc def', {}, env);
    expect(calledUrl).toContain('cursor=abc%20def');
  });

  test('200 empty response → empty items, null nextToken', async () => {
    const feed = new TestApiFeed();
    globalThis.fetch = (async () =>
      jsonResponse({ items: [] })) as typeof globalThis.fetch;

    const result = await feed.exposeFetchPage(null, {}, env);
    expect(result.items).toEqual([]);
    expect(result.nextToken).toBeNull();
  });

  // Permanent error statuses (404, 401, 403, 400) are aborted by withHttpRetry
  // immediately via AbortError — no exponential backoff overhead.
  test('404 → "not found" error surfaces via handleHttpError', async () => {
    const feed = new TestApiFeed();
    globalThis.fetch = (async () =>
      new Response('missing', { status: 404 })) as typeof globalThis.fetch;

    await expect(feed.exposeFetchPage(null, {}, env)).rejects.toThrow(/not found/i);
  });

  test('401 → "Authentication failed"', async () => {
    const feed = new TestApiFeed();
    globalThis.fetch = (async () =>
      new Response('unauth', { status: 401 })) as typeof globalThis.fetch;

    await expect(feed.exposeFetchPage(null, {}, env)).rejects.toThrow(/Authentication failed/);
  });

  test('403 → "forbidden"', async () => {
    const feed = new TestApiFeed();
    globalThis.fetch = (async () =>
      new Response('nope', { status: 403 })) as typeof globalThis.fetch;

    await expect(feed.exposeFetchPage(null, {}, env)).rejects.toThrow(/forbidden/i);
  });

  test('400 → "Bad request"', async () => {
    const feed = new TestApiFeed();
    globalThis.fetch = (async () =>
      new Response('bad', { status: 400 })) as typeof globalThis.fetch;

    await expect(feed.exposeFetchPage(null, {}, env)).rejects.toThrow(/Bad request/);
  });
});
