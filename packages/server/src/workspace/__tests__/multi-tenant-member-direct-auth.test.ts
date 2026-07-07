/**
 * Behavioral coverage for the worker-token direct-auth branch in
 * `MultiTenantProvider.resolveAuth` (multi-tenant.ts, "1) Embedded worker
 * direct-auth" section).
 *
 * SHIFU FORK: upstream assumes the agent owner is always an org
 * owner/admin (unattended watcher runs). ShiFu's personal-agent topology
 * hangs agents off member-level coworkers too, so a flag-gated branch grants
 * those a degraded (non-admin) MCP session instead of a hard 403. This file
 * pins:
 *   1. admin owner + header → 200, scopes include 'mcp:admin' (regression)
 *   2. member owner + SHIFU_MEMBER_AGENT_DIRECT_AUTH=1 → 200, scopes are
 *      exactly ['mcp:read','mcp:write'], memberRole 'member',
 *      mcpAuthInfo.agentId === the worker token's agentId
 *   3. member owner + flag unset → 403 (current behavior, unchanged)
 *   4. no member row for the owner + flag=1 → 403 always (non-member is
 *      never let through by the flag)
 *
 * Uses the same embedded-Postgres bun:test harness as the gateway suite
 * (`ensureDbForGatewayTests`) so this runs standalone with `bun test`,
 * no external DATABASE_URL required.
 */

import { generateWorkerToken } from '@lobu/core';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
} from '../../gateway/__tests__/helpers/db-setup';
import {
  addUserToOrganization,
  createTestAgent,
  createTestOrganization,
  createTestUser,
} from '../../__tests__/setup/test-fixtures';
import { MultiTenantProvider } from '../multi-tenant';

beforeAll(async () => {
  await ensureDbForGatewayTests();
}, 60_000);

beforeEach(async () => {
  await resetTestDatabase();
});

afterEach(() => {
  delete process.env.SHIFU_MEMBER_AGENT_DIRECT_AUTH;
});

afterAll(() => {
  delete process.env.SHIFU_MEMBER_AGENT_DIRECT_AUTH;
});

function buildApp() {
  const app = new Hono();
  const provider = new MultiTenantProvider();
  app.use('/mcp/:orgSlug', async (c, next) => {
    // resolveAuth's `next` contract is `() => Promise<Response | void>` (see
    // ResolveAuthNext in workspace/types.ts) — a superset of Hono's plain
    // Next, so passing it straight through is safe.
    return provider.resolveAuth(c as any, next as any);
  });
  app.all('/mcp/:orgSlug', (c) => {
    return c.json({
      mcpIsAuthenticated: c.get('mcpIsAuthenticated' as never),
      organizationId: c.get('organizationId' as never),
      memberRole: c.get('memberRole' as never),
      mcpAuthInfo: c.get('mcpAuthInfo' as never),
    });
  });
  return app;
}

async function requestDirectAuth(
  app: Hono,
  orgSlug: string,
  workerToken: string
): Promise<{ status: number; body: any }> {
  const res = await app.request(`/mcp/${orgSlug}`, {
    headers: {
      Authorization: `Bearer ${workerToken}`,
      'x-lobu-memory-direct-auth': '1',
    },
  });
  const body = await res.json();
  return { status: res.status, body };
}

describe('MultiTenantProvider.resolveAuth — worker direct-auth member branch', () => {
  it('admin owner + direct-auth header → 200, scopes include mcp:admin (regression)', async () => {
    const app = buildApp();
    const org = await createTestOrganization({ name: 'Admin Direct-Auth Org' });
    const owner = await createTestUser({ name: 'Admin Owner' });
    await addUserToOrganization(owner.id, org.id, 'admin');
    const agent = await createTestAgent({ organizationId: org.id, ownerUserId: owner.id });

    const token = generateWorkerToken(owner.id, 'conv-admin', 'deployment-admin', {
      channelId: 'chan-admin',
      agentId: agent.agentId,
    });

    // Flag intentionally unset — admin path must not depend on it.
    const { status, body } = await requestDirectAuth(app, org.slug, token);

    expect(status).toBe(200);
    expect(body.mcpIsAuthenticated).toBe(true);
    expect(body.memberRole).toBe('admin');
    expect(body.mcpAuthInfo.scopes).toEqual(['mcp:read', 'mcp:write', 'mcp:admin']);
    expect(body.mcpAuthInfo.agentId).toBe(agent.agentId);
  });

  it('member owner + flag=1 → 200, degraded scopes, memberRole member, agentId threaded', async () => {
    process.env.SHIFU_MEMBER_AGENT_DIRECT_AUTH = '1';

    const app = buildApp();
    const org = await createTestOrganization({ name: 'Member Direct-Auth Org' });
    const owner = await createTestUser({ name: 'Member Owner' });
    await addUserToOrganization(owner.id, org.id, 'member');
    const agent = await createTestAgent({ organizationId: org.id, ownerUserId: owner.id });

    const token = generateWorkerToken(owner.id, 'conv-member', 'deployment-member', {
      channelId: 'chan-member',
      agentId: agent.agentId,
    });

    const { status, body } = await requestDirectAuth(app, org.slug, token);

    expect(status).toBe(200);
    expect(body.mcpIsAuthenticated).toBe(true);
    expect(body.memberRole).toBe('member');
    expect(body.mcpAuthInfo.scopes).toEqual(['mcp:read', 'mcp:write']);
    expect(body.mcpAuthInfo.scopes).not.toContain('mcp:admin');
    expect(body.mcpAuthInfo.agentId).toBe(agent.agentId);
  });

  it('member owner + flag unset → 403 (current behavior unchanged)', async () => {
    // Explicitly absent — mirrors production default.
    delete process.env.SHIFU_MEMBER_AGENT_DIRECT_AUTH;

    const app = buildApp();
    const org = await createTestOrganization({ name: 'Member No-Flag Org' });
    const owner = await createTestUser({ name: 'Member Owner No Flag' });
    await addUserToOrganization(owner.id, org.id, 'member');
    const agent = await createTestAgent({ organizationId: org.id, ownerUserId: owner.id });

    const token = generateWorkerToken(owner.id, 'conv-member-noflag', 'deployment-member-noflag', {
      channelId: 'chan-member-noflag',
      agentId: agent.agentId,
    });

    const { status, body } = await requestDirectAuth(app, org.slug, token);

    expect(status).toBe(403);
    expect(body.error).toBe('insufficient_scope');
    expect(body.error_description).toBe('Agent owner is not an organization admin');
  });

  it('no member row for the agent owner + flag=1 → 403 always (non-member never passes)', async () => {
    process.env.SHIFU_MEMBER_AGENT_DIRECT_AUTH = '1';

    const app = buildApp();
    const org = await createTestOrganization({ name: 'Non-Member Org' });
    // Owner user exists but is deliberately never added as a member of org.
    const nonMemberOwner = await createTestUser({ name: 'Non Member Owner' });
    const agent = await createTestAgent({
      organizationId: org.id,
      ownerUserId: nonMemberOwner.id,
    });

    const token = generateWorkerToken(nonMemberOwner.id, 'conv-non-member', 'deployment-non-member', {
      channelId: 'chan-non-member',
      agentId: agent.agentId,
    });

    const { status, body } = await requestDirectAuth(app, org.slug, token);

    expect(status).toBe(403);
    expect(body.error).toBe('insufficient_scope');
    expect(body.error_description).toBe('Agent owner is not an organization admin');
  });
});
