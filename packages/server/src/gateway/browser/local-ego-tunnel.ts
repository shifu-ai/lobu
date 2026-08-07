export type BrowserToolName = 'browser_read_dom' | 'browser_screenshot' | 'browser_navigate';

export interface LocalEgoBridgeRequest {
  jsonrpc: '2.0';
  id: string;
  method: 'tools/call';
  params: {
    name: BrowserToolName;
    arguments: Record<string, unknown>;
    lease: {
      sessionId: string;
      leaseToken: string;
      runId: string;
      expiresAt: string;
    };
  };
}

export interface LocalEgoBridgeResult {
  ok: true;
  url: string | null;
  title?: string;
  contentType: 'dom' | 'screenshot' | 'navigation';
  text?: string;
  imageBase64?: string;
  metadata?: Record<string, unknown>;
}

export interface LocalEgoBridgeResponse {
  jsonrpc: '2.0';
  id: string;
  result?: LocalEgoBridgeResult;
  error?: { code: string; message: string };
}

export interface RegisteredLocalEgoBridge {
  environment: string;
  ownerUserId: string;
  agentId: string;
  bridgeId: string;
  send(request: LocalEgoBridgeRequest): Promise<LocalEgoBridgeResponse>;
}

export function createLocalEgoTunnelRegistry(input: { now: () => Date }) {
  const inputNow = input.now;
  const bridges = new Map<string, RegisteredLocalEgoBridge>();
  const key = (environment: string, ownerUserId: string, agentId: string, bridgeId: string) =>
    `${environment}:${ownerUserId}:${agentId}:${bridgeId}`;

  return {
    register(bridge: RegisteredLocalEgoBridge) {
      bridges.set(key(bridge.environment, bridge.ownerUserId, bridge.agentId, bridge.bridgeId), bridge);
      return bridge;
    },

    disconnect(input: { environment: string; ownerUserId: string; agentId: string; bridgeId: string }) {
      bridges.delete(key(input.environment, input.ownerUserId, input.agentId, input.bridgeId));
    },

    async callTool(input: {
      environment: string;
      ownerUserId: string;
      agentId: string;
      bridgeId: string;
      toolName: BrowserToolName;
      args: Record<string, unknown>;
      lease: LocalEgoBridgeRequest['params']['lease'];
      timeoutMs: number;
    }): Promise<LocalEgoBridgeResult> {
      const currentNow = inputNow();
      const bridge = bridges.get(key(input.environment, input.ownerUserId, input.agentId, input.bridgeId));
      if (!bridge) throw new Error('bridge_disconnected');
      if (new Date(input.lease.expiresAt).getTime() <= currentNow.getTime()) throw new Error('lease_expired');

      const request: LocalEgoBridgeRequest = {
        jsonrpc: '2.0',
        id: crypto.randomUUID(),
        method: 'tools/call',
        params: {
          name: input.toolName,
          arguments: input.args,
          lease: input.lease,
        },
      };

      let timeout: ReturnType<typeof setTimeout> | undefined;
      const response = await Promise.race([
        bridge.send(request),
        new Promise<LocalEgoBridgeResponse>((resolve) => {
          timeout = setTimeout(
            () =>
              resolve({
                jsonrpc: '2.0',
                id: request.id,
                error: { code: 'timeout', message: 'Browser bridge timed out.' },
              }),
            input.timeoutMs,
          );
        }),
      ]).finally(() => {
        if (timeout) clearTimeout(timeout);
      });

      if (response.error) throw new Error(response.error.code);
      if (response.id !== request.id) throw new Error('tool_failed');
      if (!response.result?.ok) throw new Error('tool_failed');
      return response.result;
    },
  };
}
