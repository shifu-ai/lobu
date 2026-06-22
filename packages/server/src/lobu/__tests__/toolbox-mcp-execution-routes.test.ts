import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { generateWorkerToken } from '@lobu/core';
import { Hono } from 'hono';
import {
  authStash,
  coreServicesStash,
  fakeRouteAgents as fakeAgents,
  fakeRouteConnections as fakeConnections,
  fakeRouteSettings as fakeSettings,
  installRouteTestMocks,
  routeStoreStash,
} from './helpers/route-test-mocks';

installRouteTestMocks();

const ORG_ID = 'org-toolbox';
const OWNER_USER_ID = 'user-agent-001';
const AGENT_ID = 'pm-agent';
const SOURCE_AGENT_ID = 'source-agent';
const CONNECTION_REF = 'google_workspace';
const SOURCE_CONNECTION_REF = 'owner-google-workspace';
const MATERIALIZED_CONNECTION_REF = `toolbox-mcp:${createHash('sha256')
  .update(JSON.stringify([ORG_ID, OWNER_USER_ID, AGENT_ID, 'google_workspace']))
  .digest('hex')}`;
const OTHER_ORG_ID = 'org-other';
const OTHER_ORG_MATERIALIZED_CONNECTION_REF = `toolbox-mcp:${createHash('sha256')
  .update(JSON.stringify([OTHER_ORG_ID, OWNER_USER_ID, AGENT_ID, 'google_workspace']))
  .digest('hex')}`;
const GOOGLE_WORKSPACE_DISCOVERY_TOOLS = [
  'drive_search',
  'docs_read',
  'sheets_read',
  'google_workspace_drive_search',
  'google_workspace_docs_read',
  'google_workspace_sheets_read',
];
const SHIFU_TOOLBOX_DISCOVERY_TOOLS = ['meeting_search'];
let executeToolDirectMock: ReturnType<typeof mock>;

async function importMountedAgentRoutes() {
  const { toolboxMcpRoutes } = await import('../agent-routes.js');
  const app = new Hono();
  app.route('/lobu/api/v1', toolboxMcpRoutes);
  return app;
}

function seedOrgAgentAndConnection() {
  fakeAgents.set(AGENT_ID, {
    agentId: AGENT_ID,
    name: 'PM Agent',
    owner: { platform: 'toolbox', userId: OWNER_USER_ID },
    organizationId: ORG_ID,
    createdAt: Date.now(),
  });
  fakeConnections.set(CONNECTION_REF, {
    id: CONNECTION_REF,
    organizationId: ORG_ID,
    agentId: AGENT_ID,
    platform: 'google_workspace',
    config: {},
    settings: {},
    metadata: { ownerUserId: OWNER_USER_ID },
    status: 'active',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}

function seedSourceConnectionForMaterialize(overrides: Record<string, unknown> = {}) {
  fakeAgents.set(SOURCE_AGENT_ID, {
    agentId: SOURCE_AGENT_ID,
    name: 'Source Agent',
    owner: { platform: 'toolbox', userId: OWNER_USER_ID },
    organizationId: ORG_ID,
    createdAt: Date.now(),
  });
  fakeConnections.delete(CONNECTION_REF);
  fakeConnections.set(SOURCE_CONNECTION_REF, {
    id: SOURCE_CONNECTION_REF,
    organizationId: ORG_ID,
    agentId: SOURCE_AGENT_ID,
    platform: 'google_workspace',
    config: { credentialRef: 'lobu_secret_safe_ref' },
    settings: { allowGroups: false },
    metadata: {
      ownerUserId: OWNER_USER_ID,
      connectorKey: 'google_workspace',
      provider: 'google_workspace',
      accountEmail: 'owner@test.local',
    },
    status: 'active',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  });
}

describe('Toolbox MCP execution routes', () => {
  beforeEach(() => {
    fakeAgents.clear();
    fakeSettings.clear();
    fakeConnections.clear();
    routeStoreStash.failSaveConnection = false;
    seedOrgAgentAndConnection();
    authStash.user = {
      id: 'toolbox-server',
      name: 'Toolbox Server',
      email: 'toolbox@test.local',
      emailVerified: true,
    };
    authStash.organizationId = ORG_ID;
    authStash.authSource = 'pat';
    authStash.mcpAuthInfo = { scopes: ['mcp:read', 'mcp:write', 'mcp:admin'] };
    authStash.memberRole = null;
    authStash.mcpAuthCalls = 0;
    authStash.rejectMcpAuth = false;
    executeToolDirectMock = mock(async () => ({
      content: [{ type: 'text', text: '{"items":[{"id":"doc-001"}]}' }],
      isError: false,
    }));
    coreServicesStash.services = {
      getMcpProxy: () => ({
        executeToolDirect: executeToolDirectMock,
      }),
    };
  });

  test('POST /mcp/tools/call executes a scoped MCP tool call for Toolbox', async () => {
    const app = await importMountedAgentRoutes();

    const res = await app.request('/lobu/api/v1/mcp/tools/call', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer admin-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ownerUserId: OWNER_USER_ID,
        agentId: AGENT_ID,
        connectorKey: 'google_workspace',
        connectionRef: CONNECTION_REF,
        toolName: 'drive_search',
        args: { query: '"技術分析全攻略課程"', limit: 10 },
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      content: [{ type: 'text', text: '{"items":[{"id":"doc-001"}]}' }],
    });
    expect(executeToolDirectMock).toHaveBeenCalledWith(
      AGENT_ID,
      OWNER_USER_ID,
      CONNECTION_REF,
      'drive_search',
      { query: '"技術分析全攻略課程"', limit: 10 }
    );
  });

  test('POST /mcp/tools/call accepts full Toolbox discovery tool aliases', async () => {
    const app = await importMountedAgentRoutes();

    const res = await app.request('/lobu/api/v1/mcp/tools/call', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer admin-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ownerUserId: OWNER_USER_ID,
        agentId: AGENT_ID,
        connectorKey: 'google_workspace',
        connectionRef: CONNECTION_REF,
        toolName: 'google_workspace_drive_search',
        args: { query: 'course', limit: 5 },
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true });
    expect(executeToolDirectMock).toHaveBeenCalledWith(
      AGENT_ID,
      OWNER_USER_ID,
      CONNECTION_REF,
      'drive_search',
      { query: 'course', limit: 5 }
    );
  });

  test('POST /mcp/tools/call returns safe diagnostic code for connector execution failure results', async () => {
    executeToolDirectMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'private upstream body must not leak' }],
      isError: true,
      diagnosticCode: 'upstream_forbidden',
    });
    const app = await importMountedAgentRoutes();

    const res = await app.request('/lobu/api/v1/mcp/tools/call', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer admin-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ownerUserId: OWNER_USER_ID,
        agentId: AGENT_ID,
        connectorKey: 'google_workspace',
        connectionRef: CONNECTION_REF,
        toolName: 'google_workspace_drive_search',
        args: { query: 'test', limit: 1 },
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      content: null,
      errorCode: 'lobu_mcp_tool_error',
      errorMessage: 'MCP tool execution failed',
      diagnosticCode: 'upstream_forbidden',
    });
    expect(executeToolDirectMock).toHaveBeenCalledWith(
      AGENT_ID,
      OWNER_USER_ID,
      CONNECTION_REF,
      'drive_search',
      { query: 'test', limit: 1 }
    );
  });

  test('POST /mcp/tools/call omits non-whitelisted diagnostic codes', async () => {
    executeToolDirectMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'sensitive provider details' }],
      isError: true,
      diagnosticCode: 'raw_provider_payload',
    });
    const app = await importMountedAgentRoutes();

    const res = await app.request('/lobu/api/v1/mcp/tools/call', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer admin-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ownerUserId: OWNER_USER_ID,
        agentId: AGENT_ID,
        connectorKey: 'google_workspace',
        connectionRef: CONNECTION_REF,
        toolName: 'google_workspace_drive_search',
        args: { query: 'test', limit: 1 },
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      content: null,
      errorCode: 'lobu_mcp_tool_error',
      errorMessage: 'MCP tool execution failed',
    });
  });

  test('POST /mcp/tools/call returns safe diagnostic code for thrown connector execution failures', async () => {
    executeToolDirectMock.mockRejectedValueOnce(
      Object.assign(new Error('upstream 403'), {
        diagnosticCode: 'connector_unavailable',
      })
    );
    const app = await importMountedAgentRoutes();

    const res = await app.request('/lobu/api/v1/mcp/tools/call', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer admin-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ownerUserId: OWNER_USER_ID,
        agentId: AGENT_ID,
        connectorKey: 'google_workspace',
        connectionRef: CONNECTION_REF,
        toolName: 'google_workspace_drive_search',
        args: { query: 'test', limit: 1 },
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      content: null,
      errorCode: 'lobu_mcp_tool_error',
      errorMessage: 'MCP tool execution failed',
      diagnosticCode: 'connector_unavailable',
    });
    expect(executeToolDirectMock).toHaveBeenCalledWith(
      AGENT_ID,
      OWNER_USER_ID,
      CONNECTION_REF,
      'drive_search',
      { query: 'test', limit: 1 }
    );
  });

  test('does not intercept Agent API worker-token routes mounted after Toolbox MCP routes', async () => {
    const { toolboxMcpRoutes } = await import('../agent-routes.js');
    const app = new Hono();
    app.route('/lobu/api/v1', toolboxMcpRoutes);
    app.post('/lobu/api/v1/agents/:agentId/messages', async (c) =>
      c.json({
        reachedAgentApi: true,
        agentId: c.req.param('agentId'),
        authHeader: c.req.header('authorization')?.startsWith('Bearer ') ?? false,
      })
    );

    const priorEncryptionKey = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY =
      priorEncryptionKey ??
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    authStash.rejectMcpAuth = true;
    try {
      const workerToken = generateWorkerToken('toolbox-user', 'conversation-1', 'api-agent', {
        channelId: 'api-toolbox-user',
        agentId: AGENT_ID,
        organizationId: ORG_ID,
        platform: 'api',
        sessionKey: 'toolbox-user',
      });

      const res = await app.request('/lobu/api/v1/agents/conversation-1/messages', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${workerToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: 'hello' }),
      });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        reachedAgentApi: true,
        agentId: 'conversation-1',
        authHeader: true,
      });
      expect(authStash.mcpAuthCalls).toBe(0);
    } finally {
      authStash.rejectMcpAuth = false;
      if (priorEncryptionKey === undefined) {
        delete process.env.ENCRYPTION_KEY;
      } else {
        process.env.ENCRYPTION_KEY = priorEncryptionKey;
      }
    }
  });

  test('POST /mcp/tools/call accepts non-admin mcp:execute bearer scope', async () => {
    authStash.user = {
      id: OWNER_USER_ID,
      name: 'Owner',
      email: 'owner@test.local',
      emailVerified: true,
    };
    authStash.authSource = 'pat';
    authStash.mcpAuthInfo = { scopes: ['mcp:execute'] };
    const app = await importMountedAgentRoutes();

    const res = await app.request('/lobu/api/v1/mcp/tools/call', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer execute-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ownerUserId: OWNER_USER_ID,
        agentId: AGENT_ID,
        connectorKey: 'google_workspace',
        connectionRef: CONNECTION_REF,
        toolName: 'drive_search',
        args: { query: 'course', limit: 5 },
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      content: [{ type: 'text', text: '{"items":[{"id":"doc-001"}]}' }],
    });
    expect(executeToolDirectMock).toHaveBeenCalledWith(
      AGENT_ID,
      OWNER_USER_ID,
      CONNECTION_REF,
      'drive_search',
      { query: 'course', limit: 5 }
    );
  });

  test('POST /mcp/tools/call accepts an owner web session', async () => {
    authStash.user = {
      id: OWNER_USER_ID,
      name: 'Owner',
      email: 'owner@test.local',
      emailVerified: true,
    };
    authStash.authSource = 'session';
    authStash.mcpAuthInfo = null;
    const app = await importMountedAgentRoutes();

    const res = await app.request('/lobu/api/v1/mcp/tools/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ownerUserId: OWNER_USER_ID,
        agentId: AGENT_ID,
        connectorKey: 'google_workspace',
        connectionRef: CONNECTION_REF,
        toolName: 'docs_read',
        args: { documentId: 'doc-001' },
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true });
    expect(executeToolDirectMock).toHaveBeenCalledWith(
      AGENT_ID,
      OWNER_USER_ID,
      CONNECTION_REF,
      'docs_read',
      { documentId: 'doc-001' }
    );
  });

  test('POST /mcp/tools/call executes using the materialized connection mcpId metadata', async () => {
    fakeConnections.set(MATERIALIZED_CONNECTION_REF, {
      id: MATERIALIZED_CONNECTION_REF,
      organizationId: ORG_ID,
      agentId: AGENT_ID,
      platform: 'google_workspace',
      config: {},
      settings: {},
      metadata: {
        ownerUserId: OWNER_USER_ID,
        connectorKey: 'google_workspace',
        mcpId: 'google_workspace',
      },
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const app = await importMountedAgentRoutes();

    const res = await app.request('/lobu/api/v1/mcp/tools/call', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer admin-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ownerUserId: OWNER_USER_ID,
        agentId: AGENT_ID,
        connectorKey: 'google_workspace',
        connectionRef: MATERIALIZED_CONNECTION_REF,
        toolName: 'drive_search',
        args: { query: 'course', limit: 5 },
      }),
    });

    expect(res.status).toBe(200);
    expect(executeToolDirectMock).toHaveBeenCalledWith(
      AGENT_ID,
      OWNER_USER_ID,
      'google_workspace',
      'drive_search',
      { query: 'course', limit: 5 }
    );
  });

  test('POST /mcp/tools/call rejects a session for a different owner', async () => {
    authStash.user = {
      id: 'different-user',
      name: 'Different',
      email: 'different@test.local',
      emailVerified: true,
    };
    authStash.authSource = 'session';
    authStash.mcpAuthInfo = null;
    const app = await importMountedAgentRoutes();

    const res = await app.request('/lobu/api/v1/mcp/tools/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ownerUserId: OWNER_USER_ID,
        agentId: AGENT_ID,
        connectorKey: 'google_workspace',
        connectionRef: CONNECTION_REF,
        toolName: 'drive_search',
        args: {},
      }),
    });

    expect(res.status).toBe(403);
    expect(executeToolDirectMock).not.toHaveBeenCalled();
  });

  test('POST /mcp/tools/call rejects mcp:execute bearer for a different owner', async () => {
    authStash.user = {
      id: 'different-user',
      name: 'Different',
      email: 'different@test.local',
      emailVerified: true,
    };
    authStash.authSource = 'pat';
    authStash.mcpAuthInfo = { scopes: ['mcp:execute'] };
    const app = await importMountedAgentRoutes();

    const res = await app.request('/lobu/api/v1/mcp/tools/call', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer execute-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ownerUserId: OWNER_USER_ID,
        agentId: AGENT_ID,
        connectorKey: 'google_workspace',
        connectionRef: CONNECTION_REF,
        toolName: 'drive_search',
        args: {},
      }),
    });

    expect(res.status).toBe(403);
    expect(executeToolDirectMock).not.toHaveBeenCalled();
  });

  test('POST /mcp/tools/call rejects tools outside the discovery allowlist', async () => {
    const app = await importMountedAgentRoutes();

    const res = await app.request('/lobu/api/v1/mcp/tools/call', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer admin-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ownerUserId: OWNER_USER_ID,
        agentId: AGENT_ID,
        connectorKey: 'google_workspace',
        connectionRef: CONNECTION_REF,
        toolName: 'send_email',
        args: { to: 'user@example.com' },
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      content: null,
      errorCode: 'lobu_mcp_tool_not_allowed',
      errorMessage: 'MCP tool is not allowed for discovery',
    });
    expect(executeToolDirectMock).not.toHaveBeenCalled();
  });

  test('POST /mcp/tools/call rejects unauthenticated callers', async () => {
    authStash.user = null;
    authStash.organizationId = null;
    authStash.authSource = null;
    authStash.mcpAuthInfo = null;
    const app = await importMountedAgentRoutes();

    const res = await app.request('/lobu/api/v1/mcp/tools/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ownerUserId: OWNER_USER_ID,
        agentId: AGENT_ID,
        connectorKey: 'google_workspace',
        connectionRef: CONNECTION_REF,
        toolName: 'drive_search',
        args: {},
      }),
    });

    expect([401, 403]).toContain(res.status);
  });

  test('GET /mcp/connections/status returns ready for an attached connection', async () => {
    const app = await importMountedAgentRoutes();

    const res = await app.request(
      `/lobu/api/v1/mcp/connections/status?agentId=${AGENT_ID}&ownerUserId=${OWNER_USER_ID}&connectorKey=google_workspace&connectionRef=${CONNECTION_REF}`,
      {
        headers: { Authorization: 'Bearer admin-token' },
      }
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      status: 'ready',
      toolsDiscovered: GOOGLE_WORKSPACE_DISCOVERY_TOOLS,
    });
  });

  test('GET /mcp/connections/status accepts shifu_toolbox for shifu-toolbox materialized rows', async () => {
    const connectionRef = `toolbox-mcp:${createHash('sha256')
      .update(JSON.stringify([ORG_ID, OWNER_USER_ID, AGENT_ID, 'shifu-toolbox']))
      .digest('hex')}`;
    fakeConnections.set(connectionRef, {
      id: connectionRef,
      organizationId: ORG_ID,
      agentId: AGENT_ID,
      platform: 'shifu-toolbox',
      config: {},
      settings: {},
      metadata: {
        ownerUserId: OWNER_USER_ID,
        connectorKey: 'shifu-toolbox',
        mcpId: 'shifu-toolbox',
        authSource: 'lobu_oauth',
      },
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const app = await importMountedAgentRoutes();

    const res = await app.request(
      `/lobu/api/v1/mcp/connections/status?agentId=${AGENT_ID}&ownerUserId=${OWNER_USER_ID}&connectorKey=shifu_toolbox&connectionRef=${connectionRef}`,
      {
        headers: { Authorization: 'Bearer admin-token' },
      }
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      status: 'ready',
      toolsDiscovered: SHIFU_TOOLBOX_DISCOVERY_TOOLS,
    });
  });

  test('GET /mcp/connections/status maps unknown connections to not_connected', async () => {
    const app = await importMountedAgentRoutes();

    const res = await app.request(
      `/lobu/api/v1/mcp/connections/status?agentId=${AGENT_ID}&ownerUserId=${OWNER_USER_ID}&connectorKey=google_workspace&connectionRef=missing-connection`,
      {
        headers: { Authorization: 'Bearer admin-token' },
      }
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      status: 'not_connected',
      toolsDiscovered: [],
    });
  });

  test('GET /mcp/connections/status maps owner metadata mismatch to not_connected', async () => {
    const connection = fakeConnections.get(CONNECTION_REF);
    fakeConnections.set(CONNECTION_REF, {
      ...connection,
      metadata: { ownerUserId: 'different-user' },
    });
    const app = await importMountedAgentRoutes();

    const res = await app.request(
      `/lobu/api/v1/mcp/connections/status?agentId=${AGENT_ID}&ownerUserId=${OWNER_USER_ID}&connectorKey=google_workspace&connectionRef=${CONNECTION_REF}`,
      {
        headers: { Authorization: 'Bearer admin-token' },
      }
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      status: 'not_connected',
      toolsDiscovered: [],
    });
  });

  test('POST /mcp/connections/materialize returns ready and a ref for an owner connector', async () => {
    seedSourceConnectionForMaterialize();
    const app = await importMountedAgentRoutes();

    const res = await app.request('/lobu/api/v1/mcp/connections/materialize', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer admin-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ownerUserId: OWNER_USER_ID,
        agentId: AGENT_ID,
        connectorKey: 'google_workspace',
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      status: 'ready',
      lobuConnectionRef: MATERIALIZED_CONNECTION_REF,
      toolsDiscovered: GOOGLE_WORKSPACE_DISCOVERY_TOOLS,
    });
    expect(fakeConnections.get(MATERIALIZED_CONNECTION_REF)).toMatchObject({
      id: MATERIALIZED_CONNECTION_REF,
      agentId: AGENT_ID,
      platform: 'google_workspace',
      config: { credentialRef: 'lobu_secret_safe_ref' },
      settings: { allowGroups: false },
      metadata: {
        ownerUserId: OWNER_USER_ID,
        connectorKey: 'google_workspace',
        provider: 'google_workspace',
        materializedFromConnectionRef: SOURCE_CONNECTION_REF,
      },
      status: 'active',
    });
  });

  test('POST /mcp/connections/materialize returns shifu_toolbox discovered tools when ready', async () => {
    fakeAgents.set(SOURCE_AGENT_ID, {
      agentId: SOURCE_AGENT_ID,
      name: 'Source Agent',
      owner: { platform: 'toolbox', userId: OWNER_USER_ID },
      organizationId: ORG_ID,
      createdAt: Date.now(),
    });
    fakeConnections.delete(CONNECTION_REF);
    fakeConnections.set('owner-shifu-toolbox', {
      id: 'owner-shifu-toolbox',
      organizationId: ORG_ID,
      agentId: SOURCE_AGENT_ID,
      platform: 'shifu-toolbox',
      config: {},
      settings: {},
      metadata: {
        ownerUserId: OWNER_USER_ID,
        connectorKey: 'shifu-toolbox',
        mcpId: 'shifu-toolbox',
        authSource: 'lobu_oauth',
      },
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const app = await importMountedAgentRoutes();

    const res = await app.request('/lobu/api/v1/mcp/connections/materialize', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer admin-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ownerUserId: OWNER_USER_ID,
        agentId: AGENT_ID,
        connectorKey: 'shifu_toolbox',
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      status: 'ready',
      toolsDiscovered: SHIFU_TOOLBOX_DISCOVERY_TOOLS,
    });
    expect(body.lobuConnectionRef).toEqual(expect.any(String));
  });

  test('POST /mcp/connections/materialize accepts an existing deterministic Lobu OAuth row without materialized metadata', async () => {
    fakeConnections.delete(CONNECTION_REF);
    fakeConnections.set(MATERIALIZED_CONNECTION_REF, {
      id: MATERIALIZED_CONNECTION_REF,
      organizationId: ORG_ID,
      agentId: AGENT_ID,
      platform: 'google_workspace',
      config: { credentialRef: 'lobu_secret_oauth_ref' },
      settings: {},
      metadata: {
        ownerUserId: OWNER_USER_ID,
        connectorKey: 'google_workspace',
        mcpId: 'google_workspace',
        authSource: 'lobu_oauth',
      },
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const app = await importMountedAgentRoutes();

    const res = await app.request('/lobu/api/v1/mcp/connections/materialize', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer admin-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ownerUserId: OWNER_USER_ID,
        agentId: AGENT_ID,
        connectorKey: 'google_workspace',
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      status: 'ready',
      lobuConnectionRef: MATERIALIZED_CONNECTION_REF,
      toolsDiscovered: GOOGLE_WORKSPACE_DISCOVERY_TOOLS,
    });
    expect(fakeConnections.get(MATERIALIZED_CONNECTION_REF)).toMatchObject({
      id: MATERIALIZED_CONNECTION_REF,
      agentId: AGENT_ID,
      status: 'active',
      metadata: {
        ownerUserId: OWNER_USER_ID,
        connectorKey: 'google_workspace',
        authSource: 'lobu_oauth',
      },
    });
  });

  test('POST /mcp/connections/materialize refuses a colliding materialized ref for another agent', async () => {
    seedSourceConnectionForMaterialize();
    fakeConnections.set(MATERIALIZED_CONNECTION_REF, {
      id: MATERIALIZED_CONNECTION_REF,
      organizationId: ORG_ID,
      agentId: 'different-agent',
      platform: 'google_workspace',
      config: { credentialRef: 'lobu_secret_other_ref' },
      settings: {},
      metadata: {
        ownerUserId: OWNER_USER_ID,
        connectorKey: 'google_workspace',
        materializedFromConnectionRef: SOURCE_CONNECTION_REF,
      },
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const app = await importMountedAgentRoutes();

    const res = await app.request('/lobu/api/v1/mcp/connections/materialize', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer admin-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ownerUserId: OWNER_USER_ID,
        agentId: AGENT_ID,
        connectorKey: 'google_workspace',
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      status: 'error',
      lobuConnectionRef: null,
      errorCode: 'lobu_mcp_materialize_failed',
    });
    expect(fakeConnections.get(MATERIALIZED_CONNECTION_REF)).toMatchObject({
      agentId: 'different-agent',
      config: { credentialRef: 'lobu_secret_other_ref' },
    });
  });

  test('POST /mcp/connections/materialize uses org-scoped refs and leaves another org row untouched', async () => {
    seedSourceConnectionForMaterialize();
    fakeConnections.set(OTHER_ORG_MATERIALIZED_CONNECTION_REF, {
      id: OTHER_ORG_MATERIALIZED_CONNECTION_REF,
      organizationId: OTHER_ORG_ID,
      agentId: AGENT_ID,
      platform: 'google_workspace',
      config: { credentialRef: 'lobu_secret_other_org_ref' },
      settings: { allowGroups: true },
      metadata: {
        ownerUserId: OWNER_USER_ID,
        connectorKey: 'google_workspace',
        materializedFromConnectionRef: 'other-org-source',
      },
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const otherOrgBefore = fakeConnections.get(OTHER_ORG_MATERIALIZED_CONNECTION_REF);
    const app = await importMountedAgentRoutes();

    const res = await app.request('/lobu/api/v1/mcp/connections/materialize', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer admin-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ownerUserId: OWNER_USER_ID,
        agentId: AGENT_ID,
        connectorKey: 'google_workspace',
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      status: 'ready',
      lobuConnectionRef: MATERIALIZED_CONNECTION_REF,
      toolsDiscovered: GOOGLE_WORKSPACE_DISCOVERY_TOOLS,
    });
    expect(MATERIALIZED_CONNECTION_REF).not.toBe(OTHER_ORG_MATERIALIZED_CONNECTION_REF);
    expect(fakeConnections.get(OTHER_ORG_MATERIALIZED_CONNECTION_REF)).toEqual(otherOrgBefore);
    expect(fakeConnections.get(MATERIALIZED_CONNECTION_REF)).toMatchObject({
      id: MATERIALIZED_CONNECTION_REF,
      organizationId: ORG_ID,
      agentId: AGENT_ID,
      config: { credentialRef: 'lobu_secret_safe_ref' },
    });
  });

  test('POST /mcp/connections/materialize does not select a source that spoofs owner or connector fields', async () => {
    fakeAgents.set(SOURCE_AGENT_ID, {
      agentId: SOURCE_AGENT_ID,
      name: 'Source Agent',
      owner: { platform: 'toolbox', userId: 'different-user' },
      organizationId: ORG_ID,
      createdAt: Date.now(),
    });
    fakeConnections.delete(CONNECTION_REF);
    fakeConnections.set(SOURCE_CONNECTION_REF, {
      id: SOURCE_CONNECTION_REF,
      organizationId: ORG_ID,
      agentId: SOURCE_AGENT_ID,
      platform: 'slack',
      config: {
        credentialRef: 'lobu_secret_wrong_owner_ref',
        ownerUserId: OWNER_USER_ID,
        connectorKey: 'google_workspace',
      },
      settings: {
        ownerUserId: OWNER_USER_ID,
        provider: 'google_workspace',
      },
      metadata: {},
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const app = await importMountedAgentRoutes();

    const res = await app.request('/lobu/api/v1/mcp/connections/materialize', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer admin-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ownerUserId: OWNER_USER_ID,
        agentId: AGENT_ID,
        connectorKey: 'google_workspace',
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      status: 'not_connected',
      lobuConnectionRef: null,
    });
    expect(fakeConnections.has(MATERIALIZED_CONNECTION_REF)).toBe(false);
  });

  test('POST /mcp/connections/materialize is idempotent for the same owner agent connector', async () => {
    seedSourceConnectionForMaterialize();
    const app = await importMountedAgentRoutes();
    const request = {
      method: 'POST',
      headers: {
        Authorization: 'Bearer admin-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ownerUserId: OWNER_USER_ID,
        agentId: AGENT_ID,
        connectorKey: 'google_workspace',
      }),
    };

    const first = await app.request('/lobu/api/v1/mcp/connections/materialize', request);
    const second = await app.request('/lobu/api/v1/mcp/connections/materialize', request);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    await expect(first.json()).resolves.toEqual({
      status: 'ready',
      lobuConnectionRef: MATERIALIZED_CONNECTION_REF,
      toolsDiscovered: GOOGLE_WORKSPACE_DISCOVERY_TOOLS,
    });
    await expect(second.json()).resolves.toEqual({
      status: 'ready',
      lobuConnectionRef: MATERIALIZED_CONNECTION_REF,
      toolsDiscovered: GOOGLE_WORKSPACE_DISCOVERY_TOOLS,
    });
    expect(
      [...fakeConnections.values()].filter((connection) => connection.agentId === AGENT_ID)
    ).toHaveLength(1);
  });

  test('POST /mcp/connections/materialize ignores a stale target connection when an owner source is ready', async () => {
    seedSourceConnectionForMaterialize();
    fakeConnections.set('stale-target-google-workspace', {
      id: 'stale-target-google-workspace',
      organizationId: ORG_ID,
      agentId: AGENT_ID,
      platform: 'google_workspace',
      config: {},
      settings: {},
      metadata: {
        ownerUserId: OWNER_USER_ID,
        connectorKey: 'google_workspace',
      },
      status: 'error',
      errorMessage: 'OAuth token expired',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const app = await importMountedAgentRoutes();

    const res = await app.request('/lobu/api/v1/mcp/connections/materialize', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer admin-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ownerUserId: OWNER_USER_ID,
        agentId: AGENT_ID,
        connectorKey: 'google_workspace',
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      status: 'ready',
      lobuConnectionRef: MATERIALIZED_CONNECTION_REF,
      toolsDiscovered: GOOGLE_WORKSPACE_DISCOVERY_TOOLS,
    });
    expect(fakeConnections.get(MATERIALIZED_CONNECTION_REF)).toMatchObject({
      agentId: AGENT_ID,
      status: 'active',
      metadata: {
        ownerUserId: OWNER_USER_ID,
        connectorKey: 'google_workspace',
        materializedFromConnectionRef: SOURCE_CONNECTION_REF,
      },
    });
  });

  test('POST /mcp/connections/materialize returns needs_reauth for an auth-failed owner connector', async () => {
    seedSourceConnectionForMaterialize({
      status: 'error',
      errorMessage: 'OAuth token expired',
    });
    const app = await importMountedAgentRoutes();

    const res = await app.request('/lobu/api/v1/mcp/connections/materialize', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer admin-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ownerUserId: OWNER_USER_ID,
        agentId: AGENT_ID,
        connectorKey: 'google_workspace',
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      status: 'needs_reauth',
      lobuConnectionRef: null,
    });
    expect(fakeConnections.has(MATERIALIZED_CONNECTION_REF)).toBe(false);
  });

  test('POST /mcp/connections/materialize returns not_connected when no owner connector exists', async () => {
    fakeConnections.delete(CONNECTION_REF);
    const app = await importMountedAgentRoutes();

    const res = await app.request('/lobu/api/v1/mcp/connections/materialize', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer admin-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ownerUserId: OWNER_USER_ID,
        agentId: AGENT_ID,
        connectorKey: 'google_workspace',
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      status: 'not_connected',
      lobuConnectionRef: null,
    });
  });

  test('POST /mcp/connections/materialize rejects invalid connector keys', async () => {
    const app = await importMountedAgentRoutes();

    const res = await app.request('/lobu/api/v1/mcp/connections/materialize', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer admin-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ownerUserId: OWNER_USER_ID,
        agentId: AGENT_ID,
        connectorKey: 'slack',
      }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      status: 'error',
      lobuConnectionRef: null,
      errorCode: 'lobu_mcp_invalid_request',
    });
  });

  test('POST /mcp/connections/materialize rejects invalid JSON with a null ref', async () => {
    const app = await importMountedAgentRoutes();

    const res = await app.request('/lobu/api/v1/mcp/connections/materialize', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer admin-token',
        'Content-Type': 'application/json',
      },
      body: '{',
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      status: 'error',
      lobuConnectionRef: null,
      errorCode: 'lobu_mcp_invalid_request',
    });
  });

  test('POST /mcp/connections/materialize returns not_connected with a null ref for target owner mismatch', async () => {
    fakeAgents.set(AGENT_ID, {
      ...(fakeAgents.get(AGENT_ID) ?? {}),
      owner: { platform: 'toolbox', userId: 'different-user' },
    });
    seedSourceConnectionForMaterialize();
    const app = await importMountedAgentRoutes();

    const res = await app.request('/lobu/api/v1/mcp/connections/materialize', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer admin-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ownerUserId: OWNER_USER_ID,
        agentId: AGENT_ID,
        connectorKey: 'google_workspace',
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      status: 'not_connected',
      lobuConnectionRef: null,
    });
  });

  test('POST /mcp/connections/materialize returns error with a null ref when materialization fails', async () => {
    seedSourceConnectionForMaterialize();
    routeStoreStash.failSaveConnection = true;
    const app = await importMountedAgentRoutes();

    const res = await app.request('/lobu/api/v1/mcp/connections/materialize', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer admin-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ownerUserId: OWNER_USER_ID,
        agentId: AGENT_ID,
        connectorKey: 'google_workspace',
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      status: 'error',
      lobuConnectionRef: null,
      errorCode: 'lobu_mcp_materialize_failed',
    });
  });

  test('POST /mcp/connections/materialize rejects mcp:execute bearer for a different owner', async () => {
    authStash.user = {
      id: 'different-user',
      name: 'Different',
      email: 'different@test.local',
      emailVerified: true,
    };
    authStash.authSource = 'pat';
    authStash.mcpAuthInfo = { scopes: ['mcp:execute'] };
    seedSourceConnectionForMaterialize();
    const app = await importMountedAgentRoutes();

    const res = await app.request('/lobu/api/v1/mcp/connections/materialize', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer execute-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ownerUserId: OWNER_USER_ID,
        agentId: AGENT_ID,
        connectorKey: 'google_workspace',
      }),
    });

    expect(res.status).toBe(403);
    expect(fakeConnections.has(MATERIALIZED_CONNECTION_REF)).toBe(false);
  });
});
