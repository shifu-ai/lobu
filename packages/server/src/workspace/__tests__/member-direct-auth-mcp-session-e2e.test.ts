/**
 * SHIFU FORK: end-to-end coverage for the member-owned direct-auth MCP
 * session — through the REAL session layer (`handleMcp` in mcp-handler.ts),
 * driven exactly the way the gateway MCP proxy drives it.
 *
 * The two review-round Criticals both lived in code paths that
 * building-block unit tests (checkToolAccess matrices, reconstructed
 * tools/list filters) could not see:
 *
 *   1. `syncAgentBinding` reset `authCtx.agentId = null` and only rebound
 *      from a client-supplied `x-lobu-agent-id` header or
 *      `clientInfo.agentId`. The proxy sends NEITHER — its initialize body
 *      is `clientInfo: { name: "lobu-gateway", version: "1.0.0" }` (see
 *      INITIALIZE_BODY in gateway/auth/mcp/proxy.ts) — so the org-verified
 *      token agentId died at initialize.
 *   2. The ListTools handler dropped manage_schedules at
 *      `maxAccessLevel: 'write'` (its default tier is admin) before the
 *      whitelist filter ever ran.
 *
 * This file therefore initializes with the proxy's REAL body and headers
 * (worker token + x-lobu-memory-direct-auth, NO agent header), then walks
 * tools/list and tools/call through the same transport/session machinery
 * production uses. Uses the embedded-Postgres bun:test harness
 * (`ensureDbForGatewayTests`) like the neighboring multi-tenant
 * direct-auth test, so it runs standalone with `bun test`.
 */

import { generateWorkerToken } from '@lobu/core';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import {
  addUserToOrganization,
  createTestAgent,
  createTestOrganization,
  createTestUser,
} from '../../__tests__/setup/test-fixtures';
import { clearInMemoryMcpSessionsForTests, handleMcp } from '../../mcp-handler';
import { MultiTenantProvider } from '../multi-tenant';
import { ensureDbForGatewayTests, resetTestDatabase } from '../../gateway/__tests__/helpers/db-setup';

beforeAll(async () => {
  await ensureDbForGatewayTests();
}, 60_000);

beforeEach(async () => {
  await resetTestDatabase();
  clearInMemoryMcpSessionsForTests();
  process.env.SHIFU_MEMBER_AGENT_DIRECT_AUTH = '1';
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
    return provider.resolveAuth(c as any, next as any);
  });
  app.all('/mcp/:orgSlug', (c) => handleMcp(c as any));
  return app;
}

/**
 * POST a JSON-RPC message exactly like the gateway direct-auth proxy:
 * worker-token bearer + x-lobu-memory-direct-auth header, and — critically —
 * NO x-lobu-agent-id header. Accept stays JSON-only so the handler's
 * sseToJson conversion returns plain JSON bodies.
 */
async function proxyPost(
  app: Hono,
  orgSlug: string,
  workerToken: string,
  body: unknown,
  sessionId?: string
): Promise<Response> {
  return app.request(`/mcp/${orgSlug}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${workerToken}`,
      'x-lobu-memory-direct-auth': '1',
      'content-type': 'application/json',
      accept: 'application/json',
      'x-mcp-format': 'json',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
}

/** The proxy's REAL initialize body — mirror INITIALIZE_BODY in proxy.ts. */
const PROXY_INITIALIZE_BODY = {
  jsonrpc: '2.0',
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'lobu-gateway', version: '1.0.0' },
  },
  id: 0,
};

describe('member direct-auth MCP session — real handleMcp session layer (E2E)', () => {
  it('initialize → tools/list shows the whitelist incl. manage_schedules → tools/call manage_schedules list succeeds', async () => {
    const app = buildApp();
    const org = await createTestOrganization({ name: 'E2E Member Direct-Auth Org' });
    const owner = await createTestUser({ name: 'E2E Member Owner' });
    await addUserToOrganization(owner.id, org.id, 'member');
    const agent = await createTestAgent({ organizationId: org.id, ownerUserId: owner.id });

    const workerToken = generateWorkerToken(owner.id, 'conv-e2e', 'deployment-e2e', {
      channelId: 'chan-e2e',
      agentId: agent.agentId,
    });

    // --- initialize, exactly as the proxy does (no agent header/clientInfo) ---
    const initRes = await proxyPost(app, org.slug, workerToken, PROXY_INITIALIZE_BODY);
    expect(initRes.status).toBe(200);
    const sessionId = initRes.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();

    await proxyPost(
      app,
      org.slug,
      workerToken,
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      sessionId!
    );

    // --- tools/list ---
    const listRes = await proxyPost(
      app,
      org.slug,
      workerToken,
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      sessionId!
    );
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();
    expect(listBody.error).toBeUndefined();
    const toolNames: string[] = listBody.result.tools.map((t: any) => t.name);

    // manage_schedules must be present — Critical #2 dropped it at the
    // maxAccessLevel='write' pass; Critical #1 killed the agentId the
    // re-append exception keys on.
    expect(toolNames).toContain('manage_schedules');
    // …alongside the other three whitelist tools.
    expect(toolNames).toContain('save_memory');
    expect(toolNames).toContain('search_memory');
    expect(toolNames).toContain('read_knowledge');
    // A non-whitelisted internal tool stays hidden.
    expect(toolNames).not.toContain('manage_connections');

    // --- tools/call manage_schedules {action:'list'} ---
    const callRes = await proxyPost(
      app,
      org.slug,
      workerToken,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'manage_schedules', arguments: { action: 'list' } },
      },
      sessionId!
    );
    expect(callRes.status).toBe(200);
    const callBody = await callRes.json();
    expect(callBody.error).toBeUndefined();
    const resultText: string = callBody.result?.content?.[0]?.text ?? '';
    // Must NOT be an access-control rejection (the pre-fix failure modes).
    expect(callBody.result?.isError).not.toBe(true);
    expect(resultText).not.toMatch(/requires organization admin access/i);
    expect(resultText).not.toMatch(/admin or owner access/i);
    expect(resultText).not.toMatch(/read-only/i);
    // x-mcp-format: json → raw JSON result; a member list over an empty org
    // yields an empty schedules array.
    expect(JSON.parse(resultText)).toEqual({ schedules: [] });
  });

  it('control: non-whitelisted internal tool call is rejected on the same session', async () => {
    const app = buildApp();
    const org = await createTestOrganization({ name: 'E2E Control Org' });
    const owner = await createTestUser({ name: 'E2E Control Owner' });
    await addUserToOrganization(owner.id, org.id, 'member');
    const agent = await createTestAgent({ organizationId: org.id, ownerUserId: owner.id });

    const workerToken = generateWorkerToken(owner.id, 'conv-e2e-ctl', 'deployment-e2e-ctl', {
      channelId: 'chan-e2e-ctl',
      agentId: agent.agentId,
    });

    const initRes = await proxyPost(app, org.slug, workerToken, PROXY_INITIALIZE_BODY);
    const sessionId = initRes.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();

    const callRes = await proxyPost(
      app,
      org.slug,
      workerToken,
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'manage_connections', arguments: { action: 'delete', _id: 1 } },
      },
      sessionId!
    );
    expect(callRes.status).toBe(200);
    const callBody = await callRes.json();
    expect(callBody.result?.isError).toBe(true);
    expect(callBody.result?.content?.[0]?.text).toMatch(/requires organization admin access/i);
  });
});
