import { describe, expect, test } from 'bun:test';
import { createLocalEgoTunnelRegistry } from './local-ego-tunnel';

describe('local ego browser tunnel', () => {
  test('routes browser_read_dom to the registered owner bridge', async () => {
    const registry = createLocalEgoTunnelRegistry({
      now: () => new Date('2026-08-07T08:00:00.000Z'),
    });
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

    const result = await registry.callTool({
      environment: 'staging',
      ownerUserId: 'user-1',
      agentId: 'shifu-u-user-1',
      bridgeId: bridge.bridgeId,
      toolName: 'browser_read_dom',
      args: {},
      lease: {
        sessionId: 'browser_session_1',
        leaseToken: 'lease-token',
        runId: 'run-1',
        expiresAt: '2026-08-07T08:05:00.000Z',
      },
      timeoutMs: 500,
    });

    expect(result).toEqual({
      ok: true,
      url: 'https://example.com/course',
      title: 'Course dashboard',
      contentType: 'dom',
      text: 'Course dashboard: 3 pending students.',
    });
  });
});
