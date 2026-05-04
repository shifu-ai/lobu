import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  createAuthenticatedClient,
  createHttpClient,
  httpClient,
  jsonHttpClient,
} from '../http.js';

/**
 * Resolve the effective headers for a fetch invocation.
 * ky passes a `Request` object as the first arg, so init.headers is usually
 * empty — the real headers live on the Request itself.
 */
function headersFor(input: unknown, init?: RequestInit): Headers {
  if (input instanceof Request) return new Headers(input.headers);
  return new Headers(init?.headers);
}

function urlFor(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof Request) return input.url;
  return String(input);
}

describe('http clients', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('exports a default httpClient', () => {
    expect(httpClient).toBeDefined();
    expect(typeof httpClient.get).toBe('function');
    expect(typeof httpClient.post).toBe('function');
  });

  test('exports a jsonHttpClient', () => {
    expect(jsonHttpClient).toBeDefined();
    expect(typeof jsonHttpClient.get).toBe('function');
  });

  test('createHttpClient returns an instance with HTTP verb methods', () => {
    const client = createHttpClient();
    expect(typeof client.get).toBe('function');
    expect(typeof client.post).toBe('function');
    expect(typeof client.put).toBe('function');
    expect(typeof client.delete).toBe('function');
  });

  test('createHttpClient sends configured User-Agent via fetch', async () => {
    let capturedHeaders: Headers | null = null;
    const fetchMock = mock(async (input: any, init?: RequestInit) => {
      capturedHeaders = headersFor(input, init);
      return new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await httpClient.get('https://example.test/path').json();

    expect(fetchMock).toHaveBeenCalled();
    expect(capturedHeaders).not.toBeNull();
    expect(capturedHeaders!.get('user-agent')).toBe('UserResearchBot/1.0');
  });

  test('jsonHttpClient sets JSON Accept and Content-Type headers', async () => {
    let capturedHeaders: Headers | null = null;
    globalThis.fetch = mock(async (input: any, init?: RequestInit) => {
      capturedHeaders = headersFor(input, init);
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    await jsonHttpClient.get('https://example.test/').json();

    expect(capturedHeaders!.get('accept')).toBe('application/json');
    expect(capturedHeaders!.get('content-type')).toBe('application/json');
  });

  test('createAuthenticatedClient injects Authorization header', async () => {
    const client = createAuthenticatedClient('Bearer secret-token');

    let capturedHeaders: Headers | null = null;
    globalThis.fetch = mock(async (input: any, init?: RequestInit) => {
      capturedHeaders = headersFor(input, init);
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    await client.get('https://example.test/me');

    expect(capturedHeaders!.get('authorization')).toBe('Bearer secret-token');
    expect(capturedHeaders!.get('user-agent')).toBe('UserResearchBot/1.0');
  });

  test('createAuthenticatedClient merges additional headers', async () => {
    const client = createAuthenticatedClient('Bearer t', { 'X-Trace-Id': 'abc' });

    let capturedHeaders: Headers | null = null;
    globalThis.fetch = mock(async (input: any, init?: RequestInit) => {
      capturedHeaders = headersFor(input, init);
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    await client.get('https://example.test/me');

    expect(capturedHeaders!.get('x-trace-id')).toBe('abc');
    expect(capturedHeaders!.get('authorization')).toBe('Bearer t');
  });

  test('createHttpClient accepts a numeric retry override (limit only)', () => {
    const client = createHttpClient({ retry: 0 });
    // The instance construction must not throw and must still expose verbs.
    expect(typeof client.get).toBe('function');
  });

  test('createHttpClient accepts a retry config object override', () => {
    const client = createHttpClient({
      retry: { limit: 1, methods: ['get'], statusCodes: [503] },
    });
    expect(typeof client.get).toBe('function');
  });

  test('createHttpClient passes through caller options (prefixUrl)', async () => {
    const client = createHttpClient({ prefixUrl: 'https://api.example.test' });

    let capturedUrl = '';
    globalThis.fetch = mock(async (input: any) => {
      capturedUrl = urlFor(input);
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    await client.get('v1/items').json();

    expect(capturedUrl).toBe('https://api.example.test/v1/items');
  });
});
