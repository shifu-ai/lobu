import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { WorkerClient } from '../daemon/client.js';

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

const originalFetch = globalThis.fetch;

function installFetch(handler: (call: RecordedCall) => Response | Promise<Response>): {
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url;
    const headers: Record<string, string> = {};
    const initHeaders = (init?.headers ?? {}) as Record<string, string>;
    for (const [k, v] of Object.entries(initHeaders)) {
      headers[k] = v;
    }
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const call: RecordedCall = {
      url,
      method: init?.method ?? 'GET',
      headers,
      body,
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('WorkerClient', () => {
  test('exposes the worker id via the readonly accessor', () => {
    const client = new WorkerClient({
      apiUrl: 'https://api.example.com',
      workerId: 'worker-7',
      capabilities: { browser: false },
    });
    expect(client.id).toBe('worker-7');
  });

  test('trims trailing slashes off apiUrl before building request URLs', async () => {
    const { calls } = installFetch(() => jsonResponse({}));
    const client = new WorkerClient({
      apiUrl: 'https://api.example.com////',
      workerId: 'w',
      capabilities: { browser: false },
    });
    await client.poll();
    expect(calls[0].url).toBe('https://api.example.com/api/workers/poll');
  });

  test('attaches Bearer auth header when authToken is provided', async () => {
    const { calls } = installFetch(() => jsonResponse({}));
    const client = new WorkerClient({
      apiUrl: 'https://api.example.com',
      workerId: 'w',
      authToken: '  tok-abc  ',
      capabilities: { browser: false },
    });
    await client.poll();
    expect(calls[0].headers['Authorization']).toBe('Bearer tok-abc');
  });

  test('omits Authorization header when authToken is empty/whitespace', async () => {
    const { calls } = installFetch(() => jsonResponse({}));
    const client = new WorkerClient({
      apiUrl: 'https://api.example.com',
      workerId: 'w',
      authToken: '   ',
      capabilities: { browser: false },
    });
    await client.poll();
    expect(calls[0].headers['Authorization']).toBeUndefined();
  });

  test('poll() POSTs worker_id, capabilities, and version', async () => {
    const { calls } = installFetch(() => jsonResponse({ run_id: 42 }));
    const client = new WorkerClient({
      apiUrl: 'https://api.example.com',
      workerId: 'w',
      capabilities: { browser: true },
      version: '6.6.6',
    });
    const resp = await client.poll();
    expect(resp.run_id).toBe(42);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toEqual({
      worker_id: 'w',
      capabilities: { browser: true },
      version: '6.6.6',
    });
  });

  test('poll() defaults version to 1.0.0', async () => {
    const { calls } = installFetch(() => jsonResponse({}));
    const client = new WorkerClient({
      apiUrl: 'https://api.example.com',
      workerId: 'w',
      capabilities: { browser: false },
    });
    await client.poll();
    expect((calls[0].body as any).version).toBe('1.0.0');
  });

  test('throws a descriptive error when poll() returns non-2xx', async () => {
    installFetch(() => new Response('boom', { status: 500, statusText: 'Internal' }));
    const client = new WorkerClient({
      apiUrl: 'https://api.example.com',
      workerId: 'w',
      capabilities: { browser: false },
    });
    let err: Error | null = null;
    try {
      await client.poll();
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toContain('/api/workers/poll');
    expect(err!.message).toContain('500');
    expect(err!.message).toContain('boom');
  });

  test('heartbeat() POSTs run_id, worker_id, and progress', async () => {
    const { calls } = installFetch(() => new Response('', { status: 204 }));
    const client = new WorkerClient({
      apiUrl: 'https://api.example.com',
      workerId: 'w',
      capabilities: { browser: false },
    });
    await client.heartbeat(7, { items_collected_so_far: 3 });
    expect(calls[0].url).toBe('https://api.example.com/api/workers/heartbeat');
    expect(calls[0].body).toEqual({
      run_id: 7,
      worker_id: 'w',
      progress: { items_collected_so_far: 3 },
    });
  });

  test('stream() forwards the batch payload as-is', async () => {
    const { calls } = installFetch(() => new Response('', { status: 204 }));
    const client = new WorkerClient({
      apiUrl: 'https://api.example.com',
      workerId: 'w',
      capabilities: { browser: false },
    });
    const batch = {
      type: 'batch' as const,
      run_id: 11,
      items: [
        { id: 'a', payload_text: 'x', occurred_at: '2024-01-01T00:00:00Z' },
      ],
    };
    await client.stream(batch);
    expect(calls[0].url).toBe('https://api.example.com/api/workers/stream');
    expect(calls[0].body).toEqual(batch);
  });

  test('complete() routes to /api/workers/complete', async () => {
    const { calls } = installFetch(() => new Response('', { status: 204 }));
    const client = new WorkerClient({
      apiUrl: 'https://api.example.com',
      workerId: 'w',
      capabilities: { browser: false },
    });
    await client.complete({
      run_id: 1,
      worker_id: 'w',
      status: 'success',
      items_collected: 2,
    });
    expect(calls[0].url).toBe('https://api.example.com/api/workers/complete');
    expect((calls[0].body as any).status).toBe('success');
  });

  test('completeAction() routes to /api/workers/complete-action', async () => {
    const { calls } = installFetch(() => new Response('', { status: 204 }));
    const client = new WorkerClient({
      apiUrl: 'https://api.example.com',
      workerId: 'w',
      capabilities: { browser: false },
    });
    await client.completeAction({
      run_id: 1,
      worker_id: 'w',
      status: 'failed',
      error_message: 'nope',
    });
    expect(calls[0].url).toBe('https://api.example.com/api/workers/complete-action');
    expect(calls[0].body).toMatchObject({ status: 'failed', error_message: 'nope' });
  });

  test('fetchEventsForEmbedding() unwraps the events array from the response', async () => {
    installFetch(() =>
      jsonResponse({ events: [{ id: 1, content: 'a', title: null }] })
    );
    const client = new WorkerClient({
      apiUrl: 'https://api.example.com',
      workerId: 'w',
      capabilities: { browser: false },
    });
    const events = await client.fetchEventsForEmbedding([1, 2]);
    expect(events).toEqual([{ id: 1, content: 'a', title: null }]);
  });

  test('completeEmbeddings() routes to /api/workers/complete-embeddings', async () => {
    const { calls } = installFetch(() => new Response('', { status: 204 }));
    const client = new WorkerClient({
      apiUrl: 'https://api.example.com',
      workerId: 'w',
      capabilities: { browser: false },
    });
    await client.completeEmbeddings({
      run_id: 1,
      worker_id: 'w',
      embeddings: [{ event_id: 1, embedding: [0.1, 0.2] }],
    });
    expect(calls[0].url).toBe('https://api.example.com/api/workers/complete-embeddings');
  });

  test('healthCheck() returns true on 2xx and false on network error', async () => {
    installFetch(() => new Response('ok', { status: 200 }));
    const client = new WorkerClient({
      apiUrl: 'https://api.example.com',
      workerId: 'w',
      capabilities: { browser: false },
    });
    expect(await client.healthCheck()).toBe(true);

    installFetch(() => {
      throw new Error('connection refused');
    });
    expect(await client.healthCheck()).toBe(false);
  });
});
