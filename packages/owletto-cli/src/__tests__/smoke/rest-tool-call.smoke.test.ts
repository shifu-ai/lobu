/**
 * Smoke test for `restToolCall` against a deployed Owletto backend.
 *
 * Exercises the same code path as `browser-auth.ts`: auth resolution from the
 * `~/.owletto/openclaw-auth.json` store (with refresh-on-expiry), URL
 * construction (`/api/{orgSlug}/{toolName}`), POST body shape, and JSON
 * response parsing — for the two `manage_*` tools that PR #439 demoted to
 * `internal: true` and migrated off MCP `tools/call`.
 *
 * ## Running
 *
 * Skipped by default to keep CI green and local `bun test` fast. Opt in:
 *
 *     bun run test:smoke
 *     # or, directly:
 *     SMOKE=1 bun test src/__tests__/smoke/rest-tool-call.smoke.test.ts
 *
 * ## Required state
 *
 * - A logged-in CLI session at `~/.owletto/openclaw-auth.json` for the target
 *   MCP URL (default `https://app.lobu.ai/mcp/commercial-lender-demo`). Run
 *   `owletto login https://app.lobu.ai/mcp/<org>` once if missing.
 *
 * ## Optional env vars
 *
 * - `SMOKE_MCP_URL` — override the MCP URL (default
 *   `https://app.lobu.ai/mcp/commercial-lender-demo`). The host must already
 *   have a session in the auth store.
 *
 * ## What we assert
 *
 * 1. `manage_connections` `list_connector_definitions` returns
 *    `{ action: 'list_connector_definitions', connector_definitions: [...] }`
 *    (not a 401, not an HTML error page, not the legacy MCP envelope).
 * 2. `manage_auth_profiles` `list_auth_profiles` returns
 *    `{ action: 'list_auth_profiles', auth_profiles: [...] }`.
 *
 * If either tool resurfaces on the public MCP `tools/list` accidentally, REST
 * still works — that's a different drift detector (see
 * `packages/owletto-backend/src/auth/__tests__/tool-access.test.ts`).
 */

import { describe, expect, test } from 'bun:test';
import { restToolCall } from '../../commands/mcp.ts';

const SMOKE_ENABLED = process.env.SMOKE === '1';
const MCP_URL = process.env.SMOKE_MCP_URL ?? 'https://app.lobu.ai/mcp/commercial-lender-demo';

const describeSmoke = SMOKE_ENABLED ? describe : describe.skip;

describeSmoke('restToolCall against deployed backend', () => {
  test('list_connector_definitions returns a JSON array (not 401, not HTML)', async () => {
    const result = await restToolCall<{
      action?: string;
      connector_definitions?: unknown[];
      error?: string;
    }>(MCP_URL, 'manage_connections', { action: 'list_connector_definitions' });

    if (result.error) {
      throw new Error(`manage_connections returned error: ${result.error}`);
    }

    expect(result.action).toBe('list_connector_definitions');
    expect(Array.isArray(result.connector_definitions)).toBe(true);
  });

  test('list_auth_profiles returns a JSON array (not 401, not HTML)', async () => {
    const result = await restToolCall<{
      action?: string;
      auth_profiles?: unknown[];
      error?: string;
    }>(MCP_URL, 'manage_auth_profiles', { action: 'list_auth_profiles' });

    if (result.error) {
      throw new Error(`manage_auth_profiles returned error: ${result.error}`);
    }

    expect(result.action).toBe('list_auth_profiles');
    expect(Array.isArray(result.auth_profiles)).toBe(true);
  });
});
