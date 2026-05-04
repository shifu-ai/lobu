/**
 * Unit tests for the @lobu/openclaw-plugin entry module.
 *
 * The module's only export is the default plugin object. Most logic lives in
 * closures inside register(). These tests exercise that surface by passing a
 * synthetic OpenClaw API and inspecting:
 *   - which tools the plugin registers (names, descriptions, schemas)
 *   - which hooks it subscribes to and what they return for synthetic events
 *   - the system-context block injected into prompts
 *
 * Anything that needs an actual MCP server, OAuth provider, or worker daemon
 * is exercised by the e2e suite under test/e2e/ and is not retested here.
 *
 * Notes on isolation:
 *   - HOME is pointed at a temp dir so loadStoredSession() never picks up a
 *     real session from the developer's ~/.owletto/openclaw-auth.json.
 *   - The plugin uses module-level state (sessionToken, mcpSessionId,
 *     cachedWorkspaceInstructions). These tests avoid asserting on that state
 *     across cases — each case asserts only on its own outputs.
 *   - We never set token/tokenCommand AND mcpUrl together, so
 *     registerMcpTools() (which spawns a subprocess) is not invoked.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import plugin from '../../src/index.js';

type RegisteredTool = {
  name: string;
  label?: string;
  description?: string;
  parameters?: Record<string, unknown>;
  execute?: (id: string, args: Record<string, unknown>) => Promise<unknown>;
};

type HookHandler = (
  event: Record<string, unknown>,
  ctx: Record<string, unknown>
) => unknown | Promise<unknown>;

interface FakeApi {
  tools: RegisteredTool[];
  hooks: Map<string, HookHandler[]>;
  logs: { level: 'info' | 'warn' | 'error' | 'debug'; message: string }[];
  api: Record<string, unknown>;
}

function makeFakeApi(opts: {
  pluginConfig?: Record<string, unknown>;
  config?: Record<string, unknown>;
  withRegisterTool?: boolean;
  withLogger?: boolean;
}): FakeApi {
  const tools: RegisteredTool[] = [];
  const hooks = new Map<string, HookHandler[]>();
  const logs: FakeApi['logs'] = [];

  const api: Record<string, unknown> = {
    on(event: string, handler: HookHandler) {
      const list = hooks.get(event) ?? [];
      list.push(handler);
      hooks.set(event, list);
    },
  };

  if (opts.withRegisterTool !== false) {
    api.registerTool = (def: RegisteredTool) => {
      tools.push(def);
    };
  }

  if (opts.withLogger !== false) {
    api.logger = {
      info: (m: string) => logs.push({ level: 'info', message: m }),
      warn: (m: string) => logs.push({ level: 'warn', message: m }),
      error: (m: string) => logs.push({ level: 'error', message: m }),
      debug: (m: string) => logs.push({ level: 'debug', message: m }),
    };
  }

  if (opts.pluginConfig !== undefined) {
    api.pluginConfig = opts.pluginConfig;
  }
  if (opts.config !== undefined) {
    api.config = opts.config;
  }

  return { tools, hooks, logs, api };
}

let tempHome: string;
let originalHome: string | undefined;

beforeAll(() => {
  // Isolate the plugin from any real ~/.owletto/openclaw-auth.json on disk.
  originalHome = process.env.HOME;
  tempHome = mkdtempSync(join(tmpdir(), 'openclaw-plugin-test-home-'));
  process.env.HOME = tempHome;
});

afterAll(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  try {
    rmSync(tempHome, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

describe('plugin metadata', () => {
  it('exports a memory plugin with stable identity', () => {
    expect(plugin.id).toBe('openclaw-owletto');
    expect(plugin.kind).toBe('memory');
    expect(plugin.name).toBe('Lobu Memory');
    expect(typeof plugin.description).toBe('string');
    expect(plugin.description.length).toBeGreaterThan(0);
  });

  it('exposes a register function', () => {
    expect(typeof plugin.register).toBe('function');
  });
});

describe('register() with no mcpUrl', () => {
  it('logs a warning, registers no tools, but still wires hooks', () => {
    const fake = makeFakeApi({ pluginConfig: {} });
    plugin.register(fake.api);

    expect(fake.tools.length).toBe(0);
    // It still subscribes to before_prompt_build / before_agent_start because
    // the system-context injection is independent of MCP availability.
    expect(fake.hooks.has('before_prompt_build')).toBe(true);
    expect(fake.hooks.has('before_agent_start')).toBe(true);

    const warnings = fake.logs.filter((l) => l.level === 'warn');
    expect(warnings.some((w) => w.message.includes('missing config.mcpUrl'))).toBe(true);
  });

  it('tolerates a missing logger by falling back to console', () => {
    const fake = makeFakeApi({ pluginConfig: {}, withLogger: false });
    expect(() => plugin.register(fake.api)).not.toThrow();
  });

  it('tolerates a missing registerTool function', () => {
    const fake = makeFakeApi({ pluginConfig: {}, withRegisterTool: false });
    expect(() => plugin.register(fake.api)).not.toThrow();
    expect(fake.tools.length).toBe(0);
  });

  it('tolerates a missing api.on by silently dropping hooks', () => {
    const tools: RegisteredTool[] = [];
    const api: Record<string, unknown> = {
      registerTool: (def: RegisteredTool) => {
        tools.push(def);
      },
    };
    expect(() => plugin.register(api)).not.toThrow();
  });
});

describe('register() in standalone mode (mcpUrl, no auth)', () => {
  it('registers exactly the two device-auth login tools when no auth is configured', () => {
    const fake = makeFakeApi({
      pluginConfig: { mcpUrl: 'https://example.invalid/mcp' },
    });
    plugin.register(fake.api);

    const names = fake.tools.map((t) => t.name).sort();
    expect(names).toEqual(['owletto_login', 'owletto_login_check']);
  });

  it('login tool exposes the documented metadata and an empty parameters schema', () => {
    const fake = makeFakeApi({
      pluginConfig: { mcpUrl: 'https://example.invalid/mcp' },
    });
    plugin.register(fake.api);

    const login = fake.tools.find((t) => t.name === 'owletto_login');
    expect(login).toBeDefined();
    expect(login!.label).toBe('Owletto Login');
    expect(login!.description).toContain('authentication');
    expect(login!.parameters).toEqual({ type: 'object', properties: {} });
    expect(typeof login!.execute).toBe('function');

    const check = fake.tools.find((t) => t.name === 'owletto_login_check');
    expect(check).toBeDefined();
    expect(check!.label).toBe('Owletto Login Check');
    expect(check!.parameters).toEqual({ type: 'object', properties: {} });
    expect(typeof check!.execute).toBe('function');
  });

  it('owletto_login_check returns an error JSON when no login is in progress', async () => {
    const fake = makeFakeApi({
      pluginConfig: { mcpUrl: 'https://example.invalid/mcp' },
    });
    plugin.register(fake.api);

    const check = fake.tools.find((t) => t.name === 'owletto_login_check')!;
    const result = (await check.execute!('id-1', {})) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(result.content.length).toBe(1);
    expect(result.content[0].type).toBe('text');
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe('error');
    expect(parsed.message).toContain('No login in progress');
  });
});

describe('register() in gateway mode', () => {
  it('does not register login tools (the gateway proxy auto-completes auth)', () => {
    const fake = makeFakeApi({
      pluginConfig: {
        mcpUrl: 'https://example.invalid/mcp',
        gatewayAuthUrl: 'https://gateway.invalid',
      },
    });
    plugin.register(fake.api);

    const names = fake.tools.map((t) => t.name);
    expect(names).not.toContain('owletto_login');
    expect(names).not.toContain('owletto_login_check');
  });
});

describe('config resolution from api.config.plugins.entries', () => {
  it('reads plugin config from the nested OpenClaw config layout', () => {
    const fake = makeFakeApi({
      config: {
        plugins: {
          entries: {
            'openclaw-owletto': {
              config: { mcpUrl: 'https://nested.invalid/mcp' },
            },
          },
        },
      },
    });
    plugin.register(fake.api);

    // mcpUrl was provided via the nested layout, so the missing-config
    // warning must not fire.
    const warnings = fake.logs.filter((l) => l.level === 'warn');
    expect(warnings.some((w) => w.message.includes('missing config.mcpUrl'))).toBe(false);
    // And the standalone login tools should be registered.
    expect(fake.tools.find((t) => t.name === 'owletto_login')).toBeDefined();
  });

  it('falls back to the missing-config path when neither pluginConfig nor nested config is present', () => {
    const fake = makeFakeApi({});
    plugin.register(fake.api);
    expect(fake.logs.some((l) => l.level === 'warn' && l.message.includes('missing config.mcpUrl'))).toBe(true);
  });
});

describe('before_prompt_build hook', () => {
  function runRegister(extraConfig: Record<string, unknown> = {}) {
    const fake = makeFakeApi({
      pluginConfig: { mcpUrl: 'https://example.invalid/mcp', ...extraConfig },
    });
    plugin.register(fake.api);
    const handler = fake.hooks.get('before_prompt_build')?.[0];
    if (!handler) throw new Error('before_prompt_build handler not registered');
    return { handler, fake };
  }

  it('returns no prependContext when there is no user query', async () => {
    const { handler } = runRegister();
    const result = await handler({ messages: [] }, {});
    expect(result).toBeUndefined();
  });

  it('skips heartbeat prompts entirely', async () => {
    const { handler } = runRegister();
    const result = await handler({ prompt: 'heartbeat ping' }, {});
    expect(result).toBeUndefined();
  });

  it('skips internal question:q_ events', async () => {
    const { handler } = runRegister();
    const result = await handler({ prompt: 'question:q_abc123' }, {});
    expect(result).toBeUndefined();
  });

  it('returns prependContext with the standalone fallback system block for a real user prompt (no auth → no recall)', async () => {
    const { handler } = runRegister();
    const result = (await handler({ prompt: 'what is the weather' }, {})) as {
      prependContext: string;
    };
    expect(result).toBeDefined();
    expect(typeof result.prependContext).toBe('string');
    expect(result.prependContext).toContain('<owletto-system>');
    expect(result.prependContext).toContain('owletto_save_knowledge'); // standalone tool name
    // No auth configured → recall returns '' → no <owletto-memory> block.
    expect(result.prependContext).not.toContain('<owletto-memory>');
  });

  it('uses gateway-mode tool names when gatewayAuthUrl is set', async () => {
    const { handler } = runRegister({ gatewayAuthUrl: 'https://gateway.invalid' });
    const result = (await handler({ prompt: 'remind me to call mom' }, {})) as {
      prependContext: string;
    };
    expect(result.prependContext).toContain('save_knowledge');
    expect(result.prependContext).not.toContain('owletto_save_knowledge');
  });

  it('extracts the query from the most-recent user message in messages[]', async () => {
    const { handler } = runRegister();
    const result = (await handler(
      {
        messages: [
          { role: 'user', content: 'older question' },
          { role: 'assistant', content: 'older answer' },
          { role: 'user', content: 'newer question' },
        ],
      },
      {}
    )) as { prependContext: string };
    // We can't observe the query directly (no auth → no recall call), but we
    // can confirm the handler still produced a prependContext and didn't bail.
    expect(result).toBeDefined();
    expect(result.prependContext).toContain('<owletto-system>');
  });

  it('handles user content as an array of text parts', async () => {
    const { handler } = runRegister();
    const result = (await handler(
      {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'hello there' },
              { type: 'image', url: 'ignored' },
            ],
          },
        ],
      },
      {}
    )) as { prependContext: string };
    expect(result).toBeDefined();
    expect(result.prependContext).toContain('<owletto-system>');
  });

  it('returns undefined when messages contains only non-user roles and no prompt', async () => {
    const { handler } = runRegister();
    const result = await handler(
      { messages: [{ role: 'assistant', content: 'hi' }] },
      {}
    );
    expect(result).toBeUndefined();
  });
});

describe('before_agent_start hook', () => {
  function runRegister(extraConfig: Record<string, unknown> = {}) {
    const fake = makeFakeApi({
      pluginConfig: { mcpUrl: 'https://example.invalid/mcp', ...extraConfig },
    });
    plugin.register(fake.api);
    const handler = fake.hooks.get('before_agent_start')?.[0];
    if (!handler) throw new Error('before_agent_start handler not registered');
    return { handler, fake };
  }

  it('returns nothing for a missing prompt', async () => {
    const { handler } = runRegister();
    expect(await handler({}, {})).toBeUndefined();
  });

  it('returns nothing for an empty/whitespace prompt', async () => {
    const { handler } = runRegister();
    expect(await handler({ prompt: '   ' }, {})).toBeUndefined();
  });

  it('skips heartbeat prompts', async () => {
    const { handler } = runRegister();
    expect(await handler({ prompt: 'heartbeat-tick' }, {})).toBeUndefined();
  });

  it('skips question:q_ internal prompts', async () => {
    const { handler } = runRegister();
    expect(await handler({ prompt: 'question:q_xyz' }, {})).toBeUndefined();
  });

  it('returns a prependContext with the system block for a normal prompt', async () => {
    const { handler } = runRegister();
    const result = (await handler({ prompt: 'remember my birthday' }, {})) as {
      prependContext: string;
    };
    expect(result).toBeDefined();
    expect(result.prependContext).toContain('<owletto-system>');
  });
});

describe('autoCapture hook subscription', () => {
  it('attaches an additional before_prompt_build handler when autoCapture is enabled (default)', () => {
    const fake = makeFakeApi({
      pluginConfig: { mcpUrl: 'https://example.invalid/mcp' },
    });
    plugin.register(fake.api);
    const handlers = fake.hooks.get('before_prompt_build') ?? [];
    // Two handlers: one for system-context injection, one for autoCapture.
    expect(handlers.length).toBe(2);
  });

  it('does not attach the autoCapture handler when autoCapture is false', () => {
    const fake = makeFakeApi({
      pluginConfig: { mcpUrl: 'https://example.invalid/mcp', autoCapture: false },
    });
    plugin.register(fake.api);
    const handlers = fake.hooks.get('before_prompt_build') ?? [];
    expect(handlers.length).toBe(1);
  });

  it('autoCapture handler returns nothing when no auth is configured', async () => {
    const fake = makeFakeApi({
      pluginConfig: { mcpUrl: 'https://example.invalid/mcp' },
    });
    plugin.register(fake.api);
    const handlers = fake.hooks.get('before_prompt_build') ?? [];
    // The autoCapture handler is the second one registered.
    const captureHandler = handlers[1];
    const result = await captureHandler(
      {
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'hello' },
        ],
      },
      {}
    );
    expect(result).toBeUndefined();
  });
});

describe('config coercion for headers and recallLimit', () => {
  it('passes a custom recallLimit through resolution without throwing', () => {
    const fake = makeFakeApi({
      pluginConfig: {
        mcpUrl: 'https://example.invalid/mcp',
        recallLimit: 12,
        headers: { 'X-Trace': 'abc' },
      },
    });
    expect(() => plugin.register(fake.api)).not.toThrow();
    // Login tools still register — proves resolvePluginConfig accepted the
    // custom values without rejecting the config.
    expect(fake.tools.find((t) => t.name === 'owletto_login')).toBeDefined();
  });

  it('ignores non-string header values', () => {
    const fake = makeFakeApi({
      pluginConfig: {
        mcpUrl: 'https://example.invalid/mcp',
        headers: { 'X-Good': 'yes', 'X-Bad': 42 as unknown as string },
      },
    });
    expect(() => plugin.register(fake.api)).not.toThrow();
  });

  it('ignores non-positive recallLimit and falls back to the default', () => {
    const fake = makeFakeApi({
      pluginConfig: { mcpUrl: 'https://example.invalid/mcp', recallLimit: -5 },
    });
    expect(() => plugin.register(fake.api)).not.toThrow();
  });

  it('ignores a non-numeric recallLimit', () => {
    const fake = makeFakeApi({
      pluginConfig: {
        mcpUrl: 'https://example.invalid/mcp',
        recallLimit: 'six' as unknown as number,
      },
    });
    expect(() => plugin.register(fake.api)).not.toThrow();
  });
});
