import { describe, expect, test } from 'bun:test';
import { ConnectorRuntime } from '../connector-runtime.js';
import type {
  ActionContext,
  ActionResult,
  AuthContext,
  AuthResult,
  ConnectorDefinition,
  SyncContext,
  SyncResult,
} from '../connector-types.js';

class TestConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: 'test.connector',
    name: 'Test Connector',
    version: '0.0.1',
  };

  async sync(ctx: SyncContext): Promise<SyncResult> {
    return {
      events: [
        {
          origin_id: ctx.feedKey,
          payload_text: 'hello',
          occurred_at: new Date(0),
        },
      ],
      checkpoint: { last: ctx.feedKey },
      metadata: { items_found: 1 },
    };
  }

  async execute(ctx: ActionContext): Promise<ActionResult> {
    return { success: true, output: { echoed: ctx.actionKey } };
  }
}

class AuthOverrideConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: 'test.auth',
    name: 'Auth Test Connector',
    version: '0.0.1',
  };

  async sync(): Promise<SyncResult> {
    return { events: [], checkpoint: null };
  }

  async execute(): Promise<ActionResult> {
    return { success: true };
  }

  async authenticate(_ctx: AuthContext): Promise<AuthResult> {
    return { credentials: { token: 'abc' }, metadata: { account_id: '42' } };
  }
}

describe('ConnectorRuntime', () => {
  test('is an abstract base — instantiable only via subclass', () => {
    const connector = new TestConnector();
    expect(connector).toBeInstanceOf(ConnectorRuntime);
    expect(connector.definition.key).toBe('test.connector');
    expect(connector.definition.name).toBe('Test Connector');
    expect(connector.definition.version).toBe('0.0.1');
  });

  test('subclass sync() returns events + checkpoint', async () => {
    const connector = new TestConnector();
    const result = await connector.sync({
      feedKey: 'inbox',
      config: {},
      checkpoint: null,
      credentials: null,
      entityIds: [],
    });
    expect(result.events).toHaveLength(1);
    expect(result.events[0].origin_id).toBe('inbox');
    expect(result.checkpoint).toEqual({ last: 'inbox' });
    expect(result.metadata?.items_found).toBe(1);
  });

  test('subclass execute() returns ActionResult', async () => {
    const connector = new TestConnector();
    const result = await connector.execute({
      actionKey: 'send_email',
      input: { to: 'a@b.c' },
      credentials: null,
      config: {},
    });
    expect(result.success).toBe(true);
    expect(result.output).toEqual({ echoed: 'send_email' });
  });

  test('default authenticate() throws with connector key in message', async () => {
    const connector = new TestConnector();
    const fakeCtx = {
      config: {},
      previousCredentials: null,
      emit: async () => {},
      awaitSignal: async () => ({}),
      signal: new AbortController().signal,
    } as unknown as AuthContext;

    await expect(connector.authenticate(fakeCtx)).rejects.toThrow(
      'test.connector does not support interactive authentication'
    );
  });

  test('subclass can override authenticate()', async () => {
    const connector = new AuthOverrideConnector();
    const fakeCtx = {
      config: {},
      previousCredentials: null,
      emit: async () => {},
      awaitSignal: async () => ({}),
      signal: new AbortController().signal,
    } as unknown as AuthContext;

    const result = await connector.authenticate(fakeCtx);
    expect(result.credentials).toEqual({ token: 'abc' });
    expect(result.metadata?.account_id).toBe('42');
  });
});
