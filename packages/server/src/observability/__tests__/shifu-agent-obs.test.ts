import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { emitAgentObsEvent, redactAgentObsValue } from '@lobu/core';

const OBS_ENV_KEYS = [
  'SHIFU_AGENT_OBS_ENABLED',
  'SHIFU_AGENT_OBS_INGEST_URL',
  'SHIFU_AGENT_OBS_TOKEN',
  'SHIFU_AGENT_OBS_SOURCE',
  'SHIFU_AGENT_OBS_TIMEOUT_MS',
] as const;

const originalEnv = new Map<string, string | undefined>();
let originalFetch: typeof globalThis.fetch;

function restoreObsEnv() {
  for (const key of OBS_ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe('ShiFu Agent Obs event emitter', () => {
  beforeEach(() => {
    for (const key of OBS_ENV_KEYS) {
      originalEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    restoreObsEnv();
    globalThis.fetch = originalFetch;
  });

  test('posts a journey.trace.v1 event when enabled with an ingest URL', async () => {
    process.env.SHIFU_AGENT_OBS_ENABLED = 'true';
    process.env.SHIFU_AGENT_OBS_INGEST_URL = 'https://obs.example.test/ingest';
    process.env.SHIFU_AGENT_OBS_TOKEN = 'obs-token';
    process.env.SHIFU_AGENT_OBS_SOURCE = 'lobu-test';
    const fetchMock = mock(async () => new Response('{}', { status: 202 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await emitAgentObsEvent({
      traceId: 'trace-001',
      eventName: 'mcp.tool_call.started',
      status: 'started',
      stage: 'mcp.tool_call',
      agentId: 'agent-001',
      userId: 'user-001',
      toolboxUserId: 'user-001',
      connectorKey: 'google_workspace',
      toolName: 'drive_search',
      metadata: { route: '/mcp/tools/call', method: 'POST' },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://obs.example.test/ingest');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer obs-token',
    });
    const payload = JSON.parse(String(init.body));
    expect(payload).toMatchObject({
      schemaVersion: 'journey.trace.v1',
      source: 'lobu-test',
      traceId: 'trace-001',
      eventName: 'mcp.tool_call.started',
      status: 'started',
      stage: 'mcp.tool_call',
      agentId: 'agent-001',
      userId: 'user-001',
      toolboxUserId: 'user-001',
      connectorKey: 'google_workspace',
      toolName: 'drive_search',
      metadata: { route: '/mcp/tools/call', method: 'POST' },
    });
    expect(typeof payload.timestamp).toBe('string');
  });

  test('does not fetch when disabled or missing ingest URL', async () => {
    const fetchMock = mock(async () => new Response('{}', { status: 202 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await emitAgentObsEvent({
      traceId: 'trace-disabled',
      eventName: 'mcp.tool_call.started',
      status: 'started',
      stage: 'mcp.tool_call',
    });

    process.env.SHIFU_AGENT_OBS_ENABLED = 'true';
    await emitAgentObsEvent({
      traceId: 'trace-missing-url',
      eventName: 'mcp.tool_call.started',
      status: 'started',
      stage: 'mcp.tool_call',
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('redacts nested secrets and authorization bearer values', () => {
    const redacted = redactAgentObsValue({
      nested: {
        apiKey: 'sk-live-123',
        authorization: 'Bearer abc.def.ghi',
        regular: 'hello',
      },
      values: ['token=secret-token', 'Bearer nested-token', 'safe'],
    });

    expect(redacted).toEqual({
      nested: {
        apiKey: '[REDACTED]',
        authorization: '[REDACTED]',
        regular: 'hello',
      },
      values: ['[REDACTED]', '[REDACTED]', 'safe'],
    });
  });

  test('redacts camelCase opaque secret keys', () => {
    const redacted = redactAgentObsValue({
      accessToken: 'opaque123',
      refreshToken: 'opaque456',
      clientSecret: 'opaque789',
      apiKey: 'opaque000',
    });

    expect(redacted).toEqual({
      accessToken: '[REDACTED]',
      refreshToken: '[REDACTED]',
      clientSecret: '[REDACTED]',
      apiKey: '[REDACTED]',
    });
  });

  test('ingest failures and fetch throws do not throw to callers', async () => {
    process.env.SHIFU_AGENT_OBS_ENABLED = 'true';
    process.env.SHIFU_AGENT_OBS_INGEST_URL = 'https://obs.example.test/ingest';
    const fetchMock = mock(async () => new Response('nope', { status: 500 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      emitAgentObsEvent({
        traceId: 'trace-500',
        eventName: 'mcp.tool_call.started',
        status: 'started',
        stage: 'mcp.tool_call',
      })
    ).resolves.toBeUndefined();

    globalThis.fetch = mock(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    await expect(
      emitAgentObsEvent({
        traceId: 'trace-throw',
        eventName: 'mcp.tool_call.started',
        status: 'started',
        stage: 'mcp.tool_call',
      })
    ).resolves.toBeUndefined();
  });

  test('aborts a hung ingest fetch after the configured timeout', async () => {
    process.env.SHIFU_AGENT_OBS_ENABLED = 'true';
    process.env.SHIFU_AGENT_OBS_INGEST_URL = 'https://obs.example.test/ingest';
    process.env.SHIFU_AGENT_OBS_TIMEOUT_MS = '10';
    let sawSignal = false;
    const fetchMock = mock((_url: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal instanceof AbortSignal) {
          sawSignal = true;
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      Promise.race([
        emitAgentObsEvent({
          traceId: 'trace-hung',
          eventName: 'mcp.tool_call.started',
          status: 'started',
          stage: 'mcp.tool_call',
        }).then(() => 'resolved'),
        Bun.sleep(100).then(() => 'timed-out'),
      ])
    ).resolves.toBe('resolved');
    expect(sawSignal).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('redaction is deterministic', () => {
    const input = {
      token: 'secret-token',
      nested: [{ password: 'pw' }, { message: 'Authorization: Bearer abc' }],
    };

    expect(redactAgentObsValue(input)).toEqual(redactAgentObsValue(input));
  });
});
