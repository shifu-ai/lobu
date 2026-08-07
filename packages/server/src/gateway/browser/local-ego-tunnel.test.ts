import { describe, expect, test } from 'bun:test';
import {
  createLocalEgoTunnelRegistry,
  type LocalEgoBridgeRequest,
  type LocalEgoBridgeResponse,
} from './local-ego-tunnel';

const now = () => new Date('2026-08-07T08:00:00.000Z');

const validLease = {
  sessionId: 'browser_session_1',
  leaseToken: 'lease-token',
  runId: 'run-1',
  expiresAt: '2026-08-07T08:05:00.000Z',
};

const callBrowserReadDom = (
  registry: ReturnType<typeof createLocalEgoTunnelRegistry>,
  input?: {
    environment?: string;
    ownerUserId?: string;
    agentId?: string;
    bridgeId?: string;
    args?: Record<string, unknown>;
    lease?: typeof validLease;
    timeoutMs?: number;
  },
) =>
  registry.callTool({
    environment: input?.environment ?? 'staging',
    ownerUserId: input?.ownerUserId ?? 'user-1',
    agentId: input?.agentId ?? 'shifu-u-user-1',
    bridgeId: input?.bridgeId ?? 'ego-local-1',
    toolName: 'browser_read_dom',
    args: input?.args ?? {},
    lease: input?.lease ?? validLease,
    timeoutMs: input?.timeoutMs ?? 500,
  });

describe('local ego browser tunnel', () => {
  test('routes browser_read_dom to the registered owner bridge', async () => {
    const registry = createLocalEgoTunnelRegistry({ now });
    const bridge = registry.register({
      environment: 'staging',
      ownerUserId: 'user-1',
      agentId: 'shifu-u-user-1',
      bridgeId: 'ego-local-1',
      send: async (request) => ({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          ok: true,
          url: 'https://example.com/course',
          title: 'Course dashboard',
          contentType: 'dom',
          text: 'Course dashboard: 3 pending students.',
        },
      }),
    });

    const result = await callBrowserReadDom(registry, { bridgeId: bridge.bridgeId });

    expect(result).toEqual({
      ok: true,
      url: 'https://example.com/course',
      title: 'Course dashboard',
      contentType: 'dom',
      text: 'Course dashboard: 3 pending students.',
    });
  });

  test('sends the expected JSON-RPC tool request shape', async () => {
    const registry = createLocalEgoTunnelRegistry({ now });
    let capturedRequest: LocalEgoBridgeRequest | undefined;
    registry.register({
      environment: 'staging',
      ownerUserId: 'user-1',
      agentId: 'shifu-u-user-1',
      bridgeId: 'ego-local-1',
      send: async (request) => {
        capturedRequest = request;
        return {
          jsonrpc: '2.0',
          id: request.id,
          result: {
            ok: true,
            url: 'https://example.com/course',
            contentType: 'dom',
            text: 'Course dashboard',
          },
        };
      },
    });

    await callBrowserReadDom(registry, { args: { selector: '#main' } });

    expect(capturedRequest).toMatchObject({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'browser_read_dom',
        arguments: { selector: '#main' },
        lease: validLease,
      },
    });
    expect(capturedRequest?.id).toBeString();
  });

  test('rejects exact-key mismatch as bridge_disconnected', async () => {
    const registry = createLocalEgoTunnelRegistry({ now });
    registry.register({
      environment: 'staging',
      ownerUserId: 'user-1',
      agentId: 'shifu-u-user-1',
      bridgeId: 'ego-local-1',
      send: async (request) => ({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          ok: true,
          url: 'https://example.com/course',
          contentType: 'dom',
        },
      }),
    });

    await expect(callBrowserReadDom(registry, { ownerUserId: 'user-2' })).rejects.toThrow('bridge_disconnected');
  });

  test('disconnect removes the bridge', async () => {
    const registry = createLocalEgoTunnelRegistry({ now });
    registry.register({
      environment: 'staging',
      ownerUserId: 'user-1',
      agentId: 'shifu-u-user-1',
      bridgeId: 'ego-local-1',
      send: async (request) => ({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          ok: true,
          url: 'https://example.com/course',
          contentType: 'dom',
        },
      }),
    });

    registry.disconnect({
      environment: 'staging',
      ownerUserId: 'user-1',
      agentId: 'shifu-u-user-1',
      bridgeId: 'ego-local-1',
    });

    await expect(callBrowserReadDom(registry)).rejects.toThrow('bridge_disconnected');
  });

  test('rejects expired leases using the injected clock', async () => {
    const registry = createLocalEgoTunnelRegistry({ now });
    registry.register({
      environment: 'staging',
      ownerUserId: 'user-1',
      agentId: 'shifu-u-user-1',
      bridgeId: 'ego-local-1',
      send: async (request) => ({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          ok: true,
          url: 'https://example.com/course',
          contentType: 'dom',
        },
      }),
    });

    await expect(
      callBrowserReadDom(registry, {
        lease: {
          ...validLease,
          expiresAt: '2026-08-07T08:00:00.000Z',
        },
      }),
    ).rejects.toThrow('lease_expired');
  });

  test('rejects bridge timeouts', async () => {
    const registry = createLocalEgoTunnelRegistry({ now });
    registry.register({
      environment: 'staging',
      ownerUserId: 'user-1',
      agentId: 'shifu-u-user-1',
      bridgeId: 'ego-local-1',
      send: async () => new Promise<LocalEgoBridgeResponse>(() => {}),
    });

    await expect(callBrowserReadDom(registry, { timeoutMs: 1 })).rejects.toThrow('timeout');
  });

  test('clears the timeout when the bridge responds first', async () => {
    const registry = createLocalEgoTunnelRegistry({ now });
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const timerHandles: Array<ReturnType<typeof setTimeout>> = [];
    const clearedHandles: Array<ReturnType<typeof setTimeout>> = [];

    globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...arguments_: unknown[]) => {
      const handle = originalSetTimeout(handler, timeout, ...arguments_);
      timerHandles.push(handle);
      return handle;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((handle?: ReturnType<typeof setTimeout>) => {
      if (handle) clearedHandles.push(handle);
      return originalClearTimeout(handle);
    }) as typeof clearTimeout;

    try {
      registry.register({
        environment: 'staging',
        ownerUserId: 'user-1',
        agentId: 'shifu-u-user-1',
        bridgeId: 'ego-local-1',
        send: async (request) => ({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            ok: true,
            url: 'https://example.com/course',
            contentType: 'dom',
          },
        }),
      });

      await callBrowserReadDom(registry);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }

    expect(timerHandles).toHaveLength(1);
    expect(clearedHandles).toEqual(timerHandles);
  });

  test('throws bridge response error code', async () => {
    const registry = createLocalEgoTunnelRegistry({ now });
    registry.register({
      environment: 'staging',
      ownerUserId: 'user-1',
      agentId: 'shifu-u-user-1',
      bridgeId: 'ego-local-1',
      send: async (request) => ({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: 'tool_denied', message: 'Denied.' },
      }),
    });

    await expect(callBrowserReadDom(registry)).rejects.toThrow('tool_denied');
  });

  test('throws tool_failed when the bridge returns no result', async () => {
    const registry = createLocalEgoTunnelRegistry({ now });
    registry.register({
      environment: 'staging',
      ownerUserId: 'user-1',
      agentId: 'shifu-u-user-1',
      bridgeId: 'ego-local-1',
      send: async (request) => ({
        jsonrpc: '2.0',
        id: request.id,
      }),
    });

    await expect(callBrowserReadDom(registry)).rejects.toThrow('tool_failed');
  });

  test('throws tool_failed when the bridge responds with a mismatched id', async () => {
    const registry = createLocalEgoTunnelRegistry({ now });
    registry.register({
      environment: 'staging',
      ownerUserId: 'user-1',
      agentId: 'shifu-u-user-1',
      bridgeId: 'ego-local-1',
      send: async () => ({
        jsonrpc: '2.0',
        id: 'wrong-id',
        result: {
          ok: true,
          url: 'https://example.com/course',
          contentType: 'dom',
        },
      }),
    });

    await expect(callBrowserReadDom(registry)).rejects.toThrow('tool_failed');
  });
});
