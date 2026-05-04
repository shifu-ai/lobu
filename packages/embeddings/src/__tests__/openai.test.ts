import { afterEach, describe, expect, mock, test } from 'bun:test';
import { generateOpenAIEmbeddings } from '../openai';

const originalFetch = globalThis.fetch;

interface CapturedRequest {
  url: string;
  init: RequestInit | undefined;
}

function installFetchMock(
  responder: (request: CapturedRequest) => Response | Promise<Response>
): { calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  globalThis.fetch = mock(async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as URL | Request).toString();
    const captured = { url, init };
    calls.push(captured);
    return responder(captured);
  }) as unknown as typeof fetch;
  return { calls };
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function baseConfig(overrides: Partial<Parameters<typeof generateOpenAIEmbeddings>[0]> = {}) {
  return {
    texts: ['hello world'],
    apiUrl: 'https://api.openai.com/v1/embeddings',
    apiKey: 'sk-test-key',
    model: 'text-embedding-3-small',
    expectedDimensions: 3,
    normalize: false,
    timeoutMs: 5_000,
    ...overrides,
  };
}

describe('generateOpenAIEmbeddings', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('builds the OpenAI request with the correct method, headers, and body', async () => {
    const { calls } = installFetchMock(() =>
      jsonResponse({
        data: [
          { embedding: [1, 2, 3], index: 0 },
          { embedding: [4, 5, 6], index: 1 },
        ],
      })
    );

    const config = baseConfig({ texts: ['hello', 'world'], expectedDimensions: 3 });
    const result = await generateOpenAIEmbeddings(config);

    expect(result).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
    expect(calls).toHaveLength(1);

    const [{ url, init }] = calls;
    expect(url).toBe(config.apiUrl);
    expect(init?.method).toBe('POST');

    const headers = init?.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Authorization).toBe('Bearer sk-test-key');

    const body = JSON.parse(init?.body as string);
    expect(body).toEqual({
      model: config.model,
      input: ['hello', 'world'],
    });

    expect(init?.signal).toBeDefined();
  });

  test('normalizes the returned embeddings when normalize is true', async () => {
    installFetchMock(() =>
      jsonResponse({
        data: [{ embedding: [3, 4], index: 0 }],
      })
    );

    const result = await generateOpenAIEmbeddings(
      baseConfig({ texts: ['foo'], expectedDimensions: 2, normalize: true })
    );

    expect(result[0][0]).toBeCloseTo(0.6, 10);
    expect(result[0][1]).toBeCloseTo(0.8, 10);
  });

  test('throws when the response is not ok, including the status and error body', async () => {
    installFetchMock(
      () =>
        new Response('rate limited', {
          status: 429,
          headers: { 'content-type': 'text/plain' },
        })
    );

    await expect(generateOpenAIEmbeddings(baseConfig())).rejects.toThrow(
      'OpenAI embeddings error (429): rate limited'
    );
  });

  test('truncates long error bodies to 300 chars in the error message', async () => {
    const long = 'x'.repeat(500);
    installFetchMock(
      () => new Response(long, { status: 500 })
    );

    let caught: unknown;
    try {
      await generateOpenAIEmbeddings(baseConfig());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message.startsWith('OpenAI embeddings error (500): ')).toBe(true);
    // 'OpenAI embeddings error (500): ' prefix + 300 chars of body
    expect(message.length).toBe('OpenAI embeddings error (500): '.length + 300);
  });

  test('throws when payload.data is missing or not an array', async () => {
    installFetchMock(() => jsonResponse({ not_data: 'oops' }));

    await expect(generateOpenAIEmbeddings(baseConfig())).rejects.toThrow(
      'OpenAI embeddings response missing data array'
    );
  });

  test('throws when the embedding count does not match the input count', async () => {
    installFetchMock(() =>
      jsonResponse({
        data: [{ embedding: [1, 2, 3], index: 0 }],
      })
    );

    await expect(
      generateOpenAIEmbeddings(baseConfig({ texts: ['a', 'b'], expectedDimensions: 3 }))
    ).rejects.toThrow('OpenAI embeddings response returned 1 embeddings for 2 texts');
  });

  test('throws when an embedding has wrong dimensions', async () => {
    installFetchMock(() =>
      jsonResponse({
        data: [{ embedding: [1, 2], index: 0 }],
      })
    );

    await expect(
      generateOpenAIEmbeddings(baseConfig({ texts: ['x'], expectedDimensions: 5 }))
    ).rejects.toThrow(
      'OpenAI embeddings response: unexpected embedding dimensions 2 (expected 5)'
    );
  });

  test('aborts the fetch when timeoutMs elapses', async () => {
    let receivedSignal: AbortSignal | undefined;
    globalThis.fetch = mock(
      (_input: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          receivedSignal = init?.signal as AbortSignal;
          receivedSignal.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        })
    ) as unknown as typeof fetch;

    await expect(
      generateOpenAIEmbeddings(baseConfig({ timeoutMs: 1 }))
    ).rejects.toThrow();
    expect(receivedSignal?.aborted).toBe(true);
  });

  test('clears the timeout after a successful response', async () => {
    installFetchMock(() =>
      jsonResponse({ data: [{ embedding: [1, 2, 3], index: 0 }] })
    );

    const result = await generateOpenAIEmbeddings(
      baseConfig({ texts: ['x'], expectedDimensions: 3, timeoutMs: 50_000 })
    );
    // If the timer were not cleared, bun's test would hang for 50s.
    expect(result).toEqual([[1, 2, 3]]);
  });
});
