/**
 * SHIFU FORK: member-scoped (non-admin) MCP/PAT sessions may reach internal
 * tools (via the direct-auth branch in multi-tenant.ts, or the REST proxy)
 * subject to a default-deny whitelist — `MEMBER_INTERNAL_TOOL_WHITELIST` in
 * `../execute.ts`. Two enforcement points are covered here:
 *
 * 1. `checkToolAccess` (call layer, security-critical) — throws for
 *    non-whitelisted internal tools when the session lacks `mcp:admin`.
 * 2. The `tools/list` filter in `../../mcp-handler.ts` (UX layer) — mirrors
 *    the same whitelist so member sessions don't even see tools they can't
 *    call. That filter is inlined in the request handler rather than
 *    exported as a standalone function, so this file reconstructs it from
 *    the same building blocks (`getAllTools`, `getTool`,
 *    `MEMBER_INTERNAL_TOOL_WHITELIST`) the handler itself uses — any drift
 *    between this helper and the handler is a real bug in one of them, not a
 *    quirk of the test.
 */
import { describe, expect, test } from 'bun:test';
import { type AuthContext, checkToolAccess, MEMBER_INTERNAL_TOOL_WHITELIST } from '../execute';
import { getAllTools, getTool } from '../registry';

const baseAuth: AuthContext = {
  organizationId: 'org_123',
  tokenOrganizationId: null,
  userId: 'user_123',
  memberRole: 'member',
  agentId: null,
  requestedAgentId: null,
  isAuthenticated: true,
  clientId: 'client_123',
  scopes: ['mcp:read', 'mcp:write'],
  tokenType: 'pat',
  requestUrl: 'http://localhost/mcp/acme',
  baseUrl: 'http://localhost',
  scopedToOrg: true,
  allowCrossOrg: false,
  allowInternalTools: true,
};

// Mirrors the `tools/list` filter in mcp-handler.ts's ListToolsRequestSchema
// handler: same whitelist, same "internal tool the session can't reach
// should not even be listed" rule. Kept in sync manually since that filter
// isn't exported as a standalone function. `isPrivileged` collapses that
// handler's `roleAccessLevel === 'admin' || scopeAccessLevel === 'admin'`
// (role and OAuth scope are independent — either one being admin-tier
// exempts the session from the whitelist) into a single flag; this test only
// exercises the whitelist-filtering behavior, not the role/scope derivation
// itself.
function listVisibleToolNames(isPrivileged: boolean): string[] {
  const staticTools = getAllTools({ includeInternalTools: true });
  const memberScoped = !isPrivileged;
  const filtered = memberScoped
    ? staticTools.filter((t) => {
        const src = getTool(t.name);
        return !src?.internal || MEMBER_INTERNAL_TOOL_WHITELIST.has(t.name);
      })
    : staticTools;
  return filtered.map((t) => t.name);
}

describe('MEMBER_INTERNAL_TOOL_WHITELIST', () => {
  test('is exactly the four tools the plan specifies', () => {
    expect(new Set(MEMBER_INTERNAL_TOOL_WHITELIST)).toEqual(
      new Set(['manage_schedules', 'save_memory', 'search_memory', 'read_knowledge'])
    );
  });
});

describe('checkToolAccess — internal tool whitelist (call layer)', () => {
  test('1. whitelisted internal tool + member scopes (no mcp:admin) + allowInternalTools → passes', () => {
    expect(getTool('manage_schedules')?.internal).toBe(true);
    expect(() => checkToolAccess('manage_schedules', {}, baseAuth)).not.toThrow();
  });

  test('2. non-whitelisted internal tool + same member scopes → throws, listing allowed tools', () => {
    expect(getTool('manage_connections')?.internal).toBe(true);
    expect(MEMBER_INTERNAL_TOOL_WHITELIST.has('manage_connections')).toBe(false);
    expect(() => checkToolAccess('manage_connections', {}, baseAuth)).toThrow(
      /requires organization admin access.*manage_schedules.*save_memory.*search_memory.*read_knowledge/is
    );
  });

  test('3. non-whitelisted internal tool + scopes including mcp:admin → passes (admin unrestricted)', () => {
    expect(() =>
      checkToolAccess('manage_connections', {}, { ...baseAuth, scopes: ['mcp:read', 'mcp:write', 'mcp:admin'] })
    ).not.toThrow();
  });

  test('4. non-internal tool + member scopes → behavior unchanged (whitelist gate is a no-op)', () => {
    expect(getTool('save_memory')?.internal).toBeFalsy();
    expect(() => checkToolAccess('save_memory', {}, baseAuth)).not.toThrow();
  });

  test('regression: owner/admin role bypasses the whitelist even with a scope-limited OAuth token', () => {
    // Pins the fix for a real break this gate caused: `resolve_path` (an
    // internal, non-whitelisted, frontend-only tool) is called via REST with
    // a plain OAuth access token whose default scope is `mcp:read mcp:write`
    // (see test-fixtures.ts's createTestAccessToken) — no `mcp:admin` — even
    // though the calling user is the org owner. Org role and OAuth grant
    // breadth are independent; gating on scope alone 403'd this legitimate,
    // pre-existing traffic (packages/server/src/__tests__/integration/pages/
    // resolve-path-contract.test.ts). `checkToolAccess`'s gate must treat
    // owner/admin role as privileged even when the scope isn't mcp:admin.
    expect(getTool('resolve_path')?.internal).toBe(true);
    expect(MEMBER_INTERNAL_TOOL_WHITELIST.has('resolve_path')).toBe(false);
    expect(() =>
      checkToolAccess('resolve_path', { path: '/acme' }, {
        ...baseAuth,
        memberRole: 'owner',
        scopes: ['mcp:read', 'mcp:write'],
      })
    ).not.toThrow();
  });
});

describe('tools/list filtering (UX layer) — mirrors mcp-handler.ts', () => {
  test('5a. member scope (no mcp:admin): internal tools are narrowed to exactly the whitelist', () => {
    const names = new Set(listVisibleToolNames(false));
    const visibleInternal = [...names].filter((name) => getTool(name)?.internal);
    // Only whitelist entries that are *actually* `internal: true` show up
    // here — `save_memory`/`search_memory` are already on the public MCP
    // surface (not internal at all), so the internal-tool filter never
    // touches them; they're covered by the "internal or whitelisted" OR
    // clause, not by being in this internal-only subset.
    expect(new Set(visibleInternal)).toEqual(
      new Set([...MEMBER_INTERNAL_TOOL_WHITELIST].filter((name) => getTool(name)?.internal))
    );
    // Sanity: a real non-whitelisted internal tool is excluded, a
    // whitelisted one remains.
    expect(names.has('manage_connections')).toBe(false);
    expect(names.has('manage_schedules')).toBe(true);
  });

  test('5b. admin scope: full internal tool set is returned, unfiltered', () => {
    const memberNames = new Set(listVisibleToolNames(false));
    const adminNames = new Set(listVisibleToolNames(true));
    expect(adminNames.has('manage_connections')).toBe(true);
    // Admin list is a strict superset of the member-visible list (adding
    // back the tools the whitelist gate hid).
    for (const name of memberNames) {
      expect(adminNames.has(name)).toBe(true);
    }
    expect(adminNames.size).toBeGreaterThan(memberNames.size);
  });
});
