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
import { isDirectAuthMemberScheduleWrite } from '../../auth/tool-access';
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

// Mirrors the `tools/list` handler in mcp-handler.ts's
// ListToolsRequestSchema handler — INCLUDING its role/scope-derived
// `maxAccessLevel` computation and the direct-auth manage_schedules
// re-append. An earlier version of this helper took a pre-collapsed
// `isPrivileged` boolean and called `getAllTools` WITHOUT `maxAccessLevel`,
// which produced a false-green: the test asserted manage_schedules was
// member-visible while the real handler had already dropped it at
// `maxAccessLevel: 'write'` (manage_schedules defaults to admin tier),
// before the whitelist filter ever ran. Kept in sync manually since the
// handler's filter isn't exported as a standalone function — mirror EVERY
// step, not just the whitelist.
function listVisibleToolNames(session: {
  memberRole: string | null;
  scopes: string[] | null;
  agentId?: string | null;
}): string[] {
  const includeInternalTools = true; // authCtx.allowInternalTools === true
  const roleAccessLevel = !session.memberRole
    ? 'read'
    : session.memberRole === 'owner' || session.memberRole === 'admin'
      ? 'admin'
      : 'write';
  const scopeAccessLevel = !session.scopes
    ? 'admin'
    : session.scopes.includes('mcp:admin')
      ? 'admin'
      : session.scopes.includes('mcp:write')
        ? 'write'
        : 'read';
  const maxAccessLevel =
    roleAccessLevel === 'read' || scopeAccessLevel === 'read'
      ? 'read'
      : roleAccessLevel === 'write' || scopeAccessLevel === 'write'
        ? 'write'
        : 'admin';
  const staticTools = getAllTools({ includeInternalTools, maxAccessLevel });
  const isPrivileged = roleAccessLevel === 'admin' || scopeAccessLevel === 'admin';
  const memberScoped = includeInternalTools && !isPrivileged;
  let filtered = memberScoped
    ? staticTools.filter((t) => {
        const src = getTool(t.name);
        return !src?.internal || MEMBER_INTERNAL_TOOL_WHITELIST.has(t.name);
      })
    : staticTools;
  if (
    isDirectAuthMemberScheduleWrite(
      'manage_schedules',
      session.memberRole,
      session.agentId ?? null,
      session.scopes
    ) &&
    !filtered.some((t) => t.name === 'manage_schedules')
  ) {
    const scheduleEntry = getAllTools({
      includeInternalTools: true,
      maxAccessLevel: 'admin',
    }).find((t) => t.name === 'manage_schedules');
    if (scheduleEntry) filtered = [...filtered, scheduleEntry];
  }
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
    // SHIFU FORK: manage_schedules is on the reachability whitelist, but
    // (post tool-access.ts fix) it's still admin-tier by default — the
    // direct-auth exception in checkToolAccess also requires `agentId`,
    // which only the member-owned direct-auth agent session populates.
    // `baseAuth` alone (member role + mcp:write, no agentId) is exactly the
    // PAT/OAuth shape a plain member session can have, so it must NOT be
    // enough on its own — see the CONFIRMED-vuln regression test below.
    expect(getTool('manage_schedules')?.internal).toBe(true);
    expect(() =>
      checkToolAccess('manage_schedules', {}, { ...baseAuth, agentId: 'shifu-u-agent1' })
    ).not.toThrow();
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
  const memberSession = { memberRole: 'member', scopes: ['mcp:read', 'mcp:write'] };
  const directAuthMemberSession = { ...memberSession, agentId: 'shifu-u-agent1' };
  // Note: role and scope BOTH need to be admin-tier for the full list —
  // `maxAccessLevel` is the MIN of the two (a member-role session with an
  // mcp:admin-scoped token still computes 'write' and loses admin-tier
  // tools like manage_schedules; the whitelist bypass via scope only
  // affects the internal-tool filter, not the tier filter).
  const adminSession = {
    memberRole: 'admin',
    scopes: ['mcp:read', 'mcp:write', 'mcp:admin'],
  };

  test('5a. plain member scope (no agentId): whitelist narrows internals AND write tier drops manage_schedules', () => {
    const names = new Set(listVisibleToolNames(memberSession));
    // No direct-auth exception without an agentId: manage_schedules'
    // default admin tier means the maxAccessLevel='write' pass already
    // removed it — the false-green the old helper produced was asserting
    // the opposite.
    expect(names.has('manage_schedules')).toBe(false);
    expect(names.has('manage_connections')).toBe(false);
    // Whitelisted read-tier internal tool survives both passes.
    expect(names.has('read_knowledge')).toBe(true);
    // Every visible internal tool is on the whitelist (tier filtering may
    // hide additional whitelist entries, but never reveal extra internals).
    const visibleInternal = [...names].filter((name) => getTool(name)?.internal);
    for (const name of visibleInternal) {
      expect(MEMBER_INTERNAL_TOOL_WHITELIST.has(name)).toBe(true);
    }
  });

  test('5a-direct-auth. member scope + agentId + mcp:write: manage_schedules is re-appended', () => {
    const names = new Set(listVisibleToolNames(directAuthMemberSession));
    expect(names.has('manage_schedules')).toBe(true);
    expect(names.has('manage_connections')).toBe(false);
    // Only whitelist entries that are *actually* `internal: true` show up
    // in the internal subset — `save_memory`/`search_memory` are on the
    // public MCP surface (not internal), covered by the OR clause instead.
    const visibleInternal = [...names].filter((name) => getTool(name)?.internal);
    for (const name of visibleInternal) {
      expect(MEMBER_INTERNAL_TOOL_WHITELIST.has(name)).toBe(true);
    }
  });

  test('5b. admin role + admin scope: full internal tool set is returned, unfiltered', () => {
    const memberNames = new Set(listVisibleToolNames(directAuthMemberSession));
    const adminNames = new Set(listVisibleToolNames(adminSession));
    expect(adminNames.has('manage_connections')).toBe(true);
    expect(adminNames.has('manage_schedules')).toBe(true);
    // Admin list is a strict superset of the member-visible list (adding
    // back the tools the whitelist gate hid).
    for (const name of memberNames) {
      expect(adminNames.has(name)).toBe(true);
    }
    expect(adminNames.size).toBeGreaterThan(memberNames.size);
  });
});

// SHIFU FORK: regression coverage for the manage_schedules write-tier drop.
// d98c58e5 added `manage_schedules: null` to `MEMBER_WRITE_ACTIONS`
// (tool-access.ts), which was UNCONDITIONAL: any ordinary web-app
// session-cookie member (`memberRole: 'member'`, `scopes: null` — and
// `hasRequiredMcpScope` treats null scopes as privileged by pre-existing
// convention) could create/pause/cancel/delete ANY schedule in the org via
// the generic REST tool proxy. That entry has been reverted (manage_schedules
// is admin-only by default again), and a narrow exception was added to
// `checkToolAccess` (tools/execute.ts) that only re-opens write access when
// `authCtx.agentId` is set — a signal ONLY the direct-auth worker-token path
// (multi-tenant.ts's direct-auth branch) populates. Web session / PAT / OAuth
// paths never set `agentId`.
describe('manage_schedules write-tier — direct-auth-only exception (security regression)', () => {
  const plainMemberSession: AuthContext = {
    organizationId: 'org_123',
    tokenOrganizationId: null,
    userId: 'user_123',
    memberRole: 'member',
    agentId: null,
    requestedAgentId: null,
    isAuthenticated: true,
    clientId: null,
    scopes: null,
    tokenType: 'session',
    requestUrl: 'http://localhost/mcp/acme',
    baseUrl: 'http://localhost',
    scopedToOrg: true,
    allowCrossOrg: false,
    allowInternalTools: true,
  };

  test('the exact reviewer probe: plain member session-cookie (scopes null, no agentId) → create THROWS', () => {
    expect(() =>
      checkToolAccess('manage_schedules', { action: 'create' }, plainMemberSession)
    ).toThrow(/admin or owner access/i);
  });

  test('the exact reviewer probe: plain member session-cookie (scopes null, no agentId) → cancel THROWS', () => {
    expect(() =>
      checkToolAccess('manage_schedules', { action: 'cancel', id: 1 }, plainMemberSession)
    ).toThrow(/admin or owner access/i);
  });

  test('direct-auth member session (mcp:write scope + agentId) → manage_schedules passes', () => {
    expect(() =>
      checkToolAccess('manage_schedules', { action: 'create' }, {
        ...plainMemberSession,
        agentId: 'shifu-u-x',
        scopes: ['mcp:read', 'mcp:write'],
        tokenType: 'pat',
      })
    ).not.toThrow();
  });

  test('admin/owner via web session (scopes null, memberRole owner) → manage_schedules still passes', () => {
    expect(() =>
      checkToolAccess('manage_schedules', { action: 'create' }, {
        ...plainMemberSession,
        memberRole: 'owner',
        agentId: null,
      })
    ).not.toThrow();
  });

  test('control: manage_connections still throws for the plain member session', () => {
    // `create` is intentionally member-writable on manage_connections (members
    // install their own OAuth connections) AND `scopes: null` bypasses the
    // scope-based reachability gate by pre-existing convention, so use
    // `delete` (owner/admin-only action, see OWNER_ADMIN_ACTIONS in
    // tool-access.ts) to pin a genuinely admin-gated action that must stay
    // blocked for a plain member regardless of the manage_schedules fix.
    expect(() =>
      checkToolAccess('manage_connections', { action: 'delete' }, plainMemberSession)
    ).toThrow(/admin or owner access/i);
  });

  test('control: manage_connections still throws for the direct-auth member session (exception is manage_schedules-only)', () => {
    expect(() =>
      checkToolAccess('manage_connections', { action: 'delete' }, {
        ...plainMemberSession,
        agentId: 'shifu-u-x',
        scopes: ['mcp:read', 'mcp:write'],
        tokenType: 'pat',
      })
    ).toThrow(/requires organization admin access/i);
  });
});
