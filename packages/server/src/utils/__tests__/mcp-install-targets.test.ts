import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

// This file lives in @lobu/server but exercises a helper from the @owletto/web
// submodule. CI checks the submodule out via OWLETTO_WEB_DEPLOY_KEY, but local
// runs without an authorized clone (and images that don't ship the frontend)
// won't have packages/web at all. Skip the suite then rather than failing —
// the submodule's own CI covers this helper directly.
const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_SOURCE = resolve(__dirname, '../../../../web/src/lib/mcp-install-targets.ts');
const WEB_AVAILABLE = existsSync(WEB_SOURCE);

describe.skipIf(!WEB_AVAILABLE)('getMcpInstallTargets', () => {
  const mcpUrl = 'http://localhost:4821/mcp/public-owletto';

  // Lazy import so the missing path doesn't blow up parsing when the submodule
  // isn't checked out — top-level static imports run before describe.skipIf
  // can decide to skip.
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import without a build-time path
  let getMcpInstallTargets!: (url: string) => any[];
  beforeAll(async () => {
    ({ getMcpInstallTargets } = await import(
      '../../../../web/src/lib/mcp-install-targets'
    ));
  });

  it('returns all first-class MCP targets', () => {
    const targets = getMcpInstallTargets(mcpUrl);

    expect(targets.map((target) => target.id)).toEqual([
      'codex',
      'chatgpt',
      'claude-desktop',
      'claude-code',
      'gemini-cli',
      'cursor',
      'openclaw',
    ]);
  });

  it('uses the runtime mcpUrl in generated commands', () => {
    const targets = getMcpInstallTargets(mcpUrl);
    const codex = targets.find((target) => target.id === 'codex');
    const openclaw = targets.find((target) => target.id === 'openclaw');

    expect(codex?.actions).toContainEqual({
      type: 'command',
      label: 'Add MCP server',
      value: `codex mcp add owletto --url ${mcpUrl}`,
    });

    expect(openclaw?.actions).toContainEqual({
      type: 'command',
      label: 'Install plugin',
      value: 'openclaw plugins install @lobu/openclaw-plugin',
    });
    expect(openclaw?.actions).toContainEqual({
      type: 'command',
      label: 'Log in to Lobu',
      value: 'lobu login',
    });
    expect(openclaw?.actions).toContainEqual({
      type: 'command',
      label: 'Write plugin config',
      value: `lobu memory configure --url ${mcpUrl}`,
    });
    expect(openclaw?.actions).toContainEqual({
      type: 'command',
      label: 'Verify connectivity',
      value: `lobu memory health --url ${mcpUrl}`,
    });
  });

  it('encodes the runtime mcpUrl into the Cursor install link', () => {
    const targets = getMcpInstallTargets(mcpUrl);
    const cursor = targets.find((target) => target.id === 'cursor');
    const link = cursor?.actions.find(
      (action: { type: string }) => action.type === 'link'
    );

    expect(link?.type).toBe('link');

    const href = new URL((link as { href: string }).href);
    expect(href.searchParams.get('name')).toBe('owletto');

    const encodedConfig = href.searchParams.get('config');
    expect(encodedConfig).toBeTruthy();

    const configJson = Buffer.from(encodedConfig!, 'base64').toString('utf-8');
    expect(JSON.parse(configJson)).toEqual({ url: mcpUrl });
  });
});
