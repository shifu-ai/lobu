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

/**
 * Captures every header that hits the wire for a given client build. Returns
 * the request `Headers` object so the caller can inspect Authorization, custom
 * keys, etc. Restores `globalThis.fetch` automatically via the outer afterEach.
 */
async function captureHeaders(
  build: () => KyInstance
): Promise<Record<string, string>> {
  let captured: Record<string, string> = {};
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const headers =
      input instanceof Request
        ? new Headers(input.headers)
        : new Headers();
    captured = Object.fromEntries(headers.entries());
    return new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
  await build().get('https://api.example.test/probe').json();
  return captured;
}

describe('ApiPaginatedFeed HTTP client builders — request header contract', () => {
  test('createBearerClient sets Authorization: Bearer <token> and merges custom headers', async () => {
    const feed = new TestApiFeed();
    const headers = await captureHeaders(() =>
      feed.exposeCreateBearerClient('token123', { 'x-trace': 'abc' })
    );
    expect(headers.authorization).toBe('Bearer token123');
    expect(headers['x-trace']).toBe('abc');
  });

  test('createClientWithHeaders sets the supplied custom headers and emits no Authorization', async () => {
    const feed = new TestApiFeed();
    const headers = await captureHeaders(() =>
      feed.exposeCreateClientWithHeaders({ 'x-custom': '1' })
    );
    expect(headers['x-custom']).toBe('1');
    expect(headers.authorization).toBeUndefined();
  });

  test('createClientFromSessionState with no session emits no auth and merges only the additional headers', async () => {
    const feed = new TestApiFeed();
    const withHeaders = await captureHeaders(() =>
      feed.exposeCreateClientFromSessionState({ 'x-foo': 'bar' })
    );
    expect(withHeaders['x-foo']).toBe('bar');
    expect(withHeaders.authorization).toBeUndefined();

    const withoutHeaders = await captureHeaders(() =>
      feed.exposeCreateClientFromSessionState()
    );
    expect(withoutHeaders.authorization).toBeUndefined();
  });

  // Source-of-truth table: each row describes a session shape and the auth
  // header it must produce. Documents the precedence rules in the source
  // (`access_token` wins over `api_key`, `token_type` defaults to `Bearer`).
  const sessionAuthCases: Array<{
    name: string;
    session: ApiSessionState;
    extra?: Record<string, string>;
    expectedAuthorization?: string;
    expectedExtra?: Record<string, string>;
  }> = [
    {
      name: 'access_token + default token_type → "Bearer <token>"',
      session: { access_token: 'tok' },
      expectedAuthorization: 'Bearer tok',
    },
    {
      name: 'access_token + token_type=Bearer (explicit) → "Bearer <token>"',
      session: { access_token: 'tok', token_type: 'Bearer' },
      expectedAuthorization: 'Bearer tok',
    },
    {
      name: 'access_token + custom token_type → "<type> <token>"',
      session: { access_token: 'tok', token_type: 'Token' },
      expectedAuthorization: 'Token tok',
    },
    {
      name: 'access_token wins over api_key',
      session: { access_token: 'tok', api_key: 'apikey' },
      expectedAuthorization: 'Bearer tok',
    },
    {
      name: 'api_key alone → Authorization: <api_key> (no scheme prefix)',
      session: { api_key: 'apikey' },
      expectedAuthorization: 'apikey',
    },
    {
      name: 'stored headers without token/key → headers passthrough, no Authorization',
      session: { headers: { 'x-stored': 'v' } },
      expectedExtra: { 'x-stored': 'v' },
    },
    {
      name: 'empty session → no auth, no custom headers',
      session: {},
    },
  ];

  for (const c of sessionAuthCases) {
    test(`createClientFromSessionState — ${c.name}`, async () => {
      const feed = new TestApiFeed();
      feed.exposeSetSessionState(c.session);
      const headers = await captureHeaders(() =>
        feed.exposeCreateClientFromSessionState(c.extra)
      );
      if (c.expectedAuthorization === undefined) {
        expect(headers.authorization).toBeUndefined();
      } else {
        expect(headers.authorization).toBe(c.expectedAuthorization);
      }
      for (const [k, v] of Object.entries(c.expectedExtra ?? {})) {
        expect(headers[k]).toBe(v);
      }
    });
  }

  test('additionalHeaders override stored session headers (later spread wins)', async () => {
    const feed = new TestApiFeed();
    feed.exposeSetSessionState({ headers: { 'x-shared': 'from-session' } });
    const headers = await captureHeaders(() =>
      feed.exposeCreateClientFromSessionState({ 'x-shared': 'from-extra' })
    );
    expect(headers['x-shared']).toBe('from-extra');
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
