import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import {
  authStash,
  coreServicesStash,
  installRouteTestMocks,
} from './helpers/route-test-mocks';

installRouteTestMocks();

const ORG_ID = 'org-toolbox';
const OWNER_USER_ID = 'user-agent-001';
const AGENT_ID = 'pm-agent';
const SOURCE_AGENT_ID = 'source-agent';
const CONNECTION_REF = 'google_workspace';
const SOURCE_CONNECTION_REF = 'owner-google-workspace';
const MATERIALIZED_CONNECTION_REF =
  'toolbox-mcp:user-agent-001:pm-agent:google_workspace';
const fakeAgents = new Map<string, any>();
const fakeConnections = new Map<string, any>();
let executeToolDirectMock: ReturnType<typeof mock>;

mock.module('../stores/postgres-stores', () => ({
  AGENT_ID_PATTERN: /^[a-z][a-z0-9-]{2,59}$/,
  isValidAgentId: (agentId: string) => /^[a-z][a-z0-9-]{2,59}$/.test(agentId),
  agentExistsInOrganization: async (_organizationId: string, agentId: string) =>
    fakeAgents.has(agentId),
  touchAgentLastUsed: async () => {},
  createPostgresAgentConfigStore: () => ({
    getMetadata: async (agentId: string) => fakeAgents.get(agentId) ?? null,
    listAgents: async () => [...fakeAgents.values()],
    hasAgent: async (agentId: string) => fakeAgents.has(agentId),
    getSettings: async () => null,
    saveSettings: async () => {},
    updateSettings: async () => {},
    updateMetadata: async () => {},
    deleteMetadata: async () => {},
  }),
  createPostgresAgentConnectionStore: () => ({
    getConnection: async (connectionId: string) => fakeConnections.get(connectionId) ?? null,
    listConnections: async () => [...fakeConnections.values()],
    saveConnection: async (connection: any) => {
      fakeConnections.set(connection.id, connection);
    },
    updateConnection: async (connectionId: string, updates: Record<string, unknown>) => {
      const existing = fakeConnections.get(connectionId);
      if (existing) fakeConnections.set(connectionId, { ...existing, ...updates });
    },
    deleteConnection: async (connectionId: string) => {
      fakeConnections.delete(connectionId);
    },
  }),
}));

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
    fakeConnections.clear();
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
    await expect(res.json()).resolves.toEqual({ status: 'ready' });
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
    await expect(res.json()).resolves.toEqual({ status: 'not_connected' });
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
    await expect(res.json()).resolves.toEqual({ status: 'not_connected' });
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
    });
    await expect(second.json()).resolves.toEqual({
      status: 'ready',
      lobuConnectionRef: MATERIALIZED_CONNECTION_REF,
    });
    expect(
      [...fakeConnections.values()].filter((connection) => connection.agentId === AGENT_ID)
    ).toHaveLength(1);
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
    await expect(res.json()).resolves.toEqual({ status: 'needs_reauth' });
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
    await expect(res.json()).resolves.toEqual({ status: 'not_connected' });
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
      errorCode: 'lobu_mcp_invalid_request',
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
