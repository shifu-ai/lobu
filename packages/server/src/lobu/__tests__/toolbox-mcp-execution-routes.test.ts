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
const CONNECTION_REF = 'google_workspace';
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
  const { agentRoutes } = await import('../agent-routes.js');
  const app = new Hono();
  app.route('/lobu/api/v1', agentRoutes);
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
      content: { items: [{ id: 'doc-001', name: '技術分析全攻略課程 課綱' }] },
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
      content: { items: [{ id: 'doc-001', name: '技術分析全攻略課程 課綱' }] },
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
      content: { items: [{ id: 'doc-001', name: '技術分析全攻略課程 課綱' }] },
    });
    expect(executeToolDirectMock).toHaveBeenCalledWith(
      AGENT_ID,
      OWNER_USER_ID,
      CONNECTION_REF,
      'drive_search',
      { query: 'course', limit: 5 }
    );
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
});
