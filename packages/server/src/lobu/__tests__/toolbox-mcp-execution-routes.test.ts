import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { generateWorkerToken } from '@lobu/core';
import { Type } from '@sinclair/typebox';
import { Hono } from 'hono';

// connectUrl signing derives its HMAC key from ENCRYPTION_KEY; pin a
// deterministic canonical 32-byte key (hex) so token mint/verify works and
// @lobu/core `encrypt` (used by the worker-token passthrough test) accepts it.
process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY ??
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

import { verifyConnectLinkToken } from '../../gateway/auth/mcp/connect-link-token';
import {
  authStash,
  coreServicesStash,
  fakeRouteAgents as fakeAgents,
  fakeRouteConnections as fakeConnections,
  fakeRouteSettings as fakeSettings,
  installRouteTestMocks,
  routeStoreStash,
} from './helpers/route-test-mocks';

mock.module('@lobu/connector-sdk', () => ({
  AssuranceLevel: Type.Any(),
  AutoCreateWhenRule: Type.Any(),
  CLAIM_COLLISION_SEMANTIC_TYPE: 'claim_collision',
  ClaimCollisionPayload: Type.Any(),
  ConnectorFact: Type.Any(),
  ConnectorIdentityCapability: Type.Any(),
  DerivedFromProvenance: Type.Any(),
  DerivedRelationshipMetadata: Type.Any(),
  FactEventMetadata: Type.Any(),
  IDENTITY: {},
  IDENTITY_FACT_SEMANTIC_TYPE: 'identity_fact',
  RelationshipTypeIdentityMetadata: Type.Any(),
  WATCHER_TIME_GRANULARITIES: ['daily'],
  addWatcherPeriod: (date: Date) => date,
  alignToWatcherWindowStart: (date: Date) => date,
  assuranceMeets: () => true,
  getAvailableWatcherGranularities: () => ['daily'],
  getFinerWatcherGranularities: () => [],
  getNextWatcherGranularity: () => 'daily',
  getWatcherDateTruncUnit: () => 'day',
  inferWatcherGranularityFromDays: () => 'daily',
  inferWatcherGranularityFromSchedule: () => 'daily',
  isWatcherTimeGranularity: () => true,
  normalizeAuthUserId: (value: string | null | undefined) =>
    typeof value === 'string' ? value.trim().toLowerCase() : null,
  normalizeEmail: (value: string | null | undefined) =>
    typeof value === 'string' && value.includes('@') ? value.trim().toLowerCase() : null,
  normalizeGithubLogin: (value: string | null | undefined) =>
    typeof value === 'string' ? value.trim().toLowerCase() : null,
  normalizeGithubRepoFullName: (value: string | null | undefined) =>
    typeof value === 'string' ? value.trim().toLowerCase() : null,
  normalizeGoogleContactId: (value: string | null | undefined) =>
    typeof value === 'string' ? value.trim() : null,
  normalizeIdentifier: (value: string | null | undefined) =>
    typeof value === 'string' ? value.trim().toLowerCase() : null,
  normalizeNumericId: (value: string | number | null | undefined) =>
    value === null || value === undefined ? null : String(value).trim(),
  normalizePhone: (value: string | null | undefined) =>
    typeof value === 'string' ? value.trim() : null,
  normalizeSlackUserId: (value: string | null | undefined) =>
    typeof value === 'string' ? value.trim() : null,
  normalizeWaJid: (value: string | null | undefined) =>
    typeof value === 'string' ? value.trim() : null,
  shiftWatcherPeriod: (date: Date) => date,
  subtractWatcherPeriod: (date: Date) => date,
}));

mock.module('@lobu/connector-worker/executor/runtime', () => ({
  executeCompiledConnector: async () => ({
    mode: 'query',
    rows: [],
    columns: [],
  }),
}));

mock.module('@lobu/connector-worker/compile', () => ({
  EXTERNAL_RUNTIME_DEPS: [],
  assertExternalDepsResolvable: () => {},
  createConnectorCompiler: () => ({
    compile: async () => ({
      code: '',
      metadata: {},
      warnings: [],
    }),
  }),
  findBundledConnectorFile: () => null,
}));

installRouteTestMocks();

const ORG_ID = 'org-toolbox';
const OWNER_USER_ID = 'user-agent-001';
const AGENT_ID = 'pm-agent';
const SOURCE_AGENT_ID = 'source-agent';
const CONNECTION_REF = 'google_workspace';
const NOTION_CONNECTION_REF = 'notion';
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
  'google_workspace_drive_search',
  'gws_drive_search',
  'docs_read',
  'google_workspace_docs_read',
  'gws_docs_read',
  'sheets_read',
  'google_workspace_sheets_read',
  'gws_sheets_read',
  'slides_read',
  'google_workspace_slides_read',
  'gws_slides_read',
  'calendar_events_list',
  'google_workspace_calendar_events_list',
  'gws_calendar_events_list',
  'chat_spaces_list',
  'google_workspace_chat_spaces_list',
  'gws_chat_spaces_list',
  'chat_messages_list',
  'google_workspace_chat_messages_list',
  'gws_chat_messages_list',
];
const SHIFU_TOOLBOX_DISCOVERY_TOOLS = [
  'meeting_search',
  'meeting_get',
  'subtitle_get',
  'transcript_get',
  'meeting_transcribe_audio',
  'submit_course_pm_profile',
];
let executeToolDirectMock: ReturnType<typeof mock>;
let listToolsDirectMock: ReturnType<typeof mock>;
let getHttpServerMock: ReturnType<typeof mock>;
let getAllHttpServersMock: ReturnType<typeof mock>;
const OBS_ENV_KEYS = [
  'SHIFU_AGENT_OBS_ENABLED',
  'SHIFU_AGENT_OBS_INGEST_URL',
  'SHIFU_AGENT_OBS_TOKEN',
  'SHIFU_AGENT_OBS_SOURCE',
  'SHIFU_AGENT_OBS_TIMEOUT_MS',
] as const;
const originalObsEnv = new Map<string, string | undefined>();
let originalFetch: typeof globalThis.fetch;

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
    for (const key of OBS_ENV_KEYS) {
      originalObsEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    originalFetch = globalThis.fetch;
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
    listToolsDirectMock = mock(async (_agentId: string, _userId: string, mcpId: string) => ({
      tools: (mcpId === 'shifu-toolbox'
        ? SHIFU_TOOLBOX_DISCOVERY_TOOLS
        : GOOGLE_WORKSPACE_DISCOVERY_TOOLS
      ).map((name) => ({ name })),
    }));
    getHttpServerMock = mock(async () => ({
      id: 'google_workspace',
      upstreamUrl: 'https://mcp.test.local/google-workspace',
    }));
    getAllHttpServersMock = mock(async () => new Map());
    coreServicesStash.services = {
      getMcpProxy: () => ({
        executeToolDirect: executeToolDirectMock,
        listToolsDirect: listToolsDirectMock,
      }),
      getMcpConfigService: () => ({
        getHttpServer: getHttpServerMock,
        getAllHttpServers: getAllHttpServersMock,
      }),
    };
  });

  afterEach(() => {
    for (const key of OBS_ENV_KEYS) {
      const value = originalObsEnv.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    globalThis.fetch = originalFetch;
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
      'gws_drive_search',
      { query: '"技術分析全攻略課程"', limit: 10 }
    );
  });

  test('POST /mcp/tools/call emits a durable observability started event', async () => {
    process.env.SHIFU_AGENT_OBS_ENABLED = 'true';
    process.env.SHIFU_AGENT_OBS_INGEST_URL = 'https://obs.example.test/ingest';
    const fetchMock = mock(async () => new Response('{}', { status: 202 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const app = await importMountedAgentRoutes();

    const res = await app.request('/lobu/api/v1/mcp/tools/call', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer admin-token',
        'Content-Type': 'application/json',
        'X-Shifu-Trace-Id': 'trace-route-001',
        'X-Shifu-Span-Id': 'sp_parent',
        'X-Shifu-Journey': 'line_text_agent_turn',
        'X-Shifu-Turn-Id': 'turn_1',
        'X-Shifu-Actor': 'line',
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
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const payload = JSON.parse(String(init.body));
    expect(payload).toMatchObject({
      schemaVersion: 'journey.trace.v1',
      traceId: 'trace-route-001',
      turnId: 'turn_1',
      eventName: 'lobu.mcp.tool_call.started',
      status: 'started',
      stage: 'lobu.mcp.tool_call',
      agentId: AGENT_ID,
      userId: OWNER_USER_ID,
      toolboxUserId: OWNER_USER_ID,
      connectorKey: 'google_workspace',
      toolName: 'drive_search',
      metadata: {
        route: '/mcp/tools/call',
        method: 'POST',
        journey_id: 'line_text_agent_turn',
        parent_span_id: 'sp_parent',
        trace_source: 'incoming',
      },
    });
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
      'gws_drive_search',
      { query: 'course', limit: 5 }
    );
  });

  test('POST /mcp/tools/call maps Google Workspace discovery aliases to the upstream MCP tool name', async () => {
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
        source: 'toolbox-personal-agent-materialized',
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
        toolName: 'google_workspace_drive_search',
        args: { query: '大h line bot sheet', limit: 5 },
      }),
    });

    expect(res.status).toBe(200);
    expect(executeToolDirectMock).toHaveBeenCalledWith(
      AGENT_ID,
      OWNER_USER_ID,
      'google_workspace',
      'gws_drive_search',
      { query: '大h line bot sheet', limit: 5 }
    );
  });

  test('POST /mcp/tools/call maps Google Workspace calendar aliases to the upstream MCP tool name', async () => {
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
        source: 'toolbox-personal-agent-materialized',
      },
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const app = await importMountedAgentRoutes();

    const args = {
      calendarId: 'primary',
      timeMin: '2026-06-25T00:00:00+08:00',
      timeMax: '2026-06-26T00:00:00+08:00',
      maxResults: 10,
    };

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
        toolName: 'google_workspace_calendar_events_list',
        args,
      }),
    });

    expect(res.status).toBe(200);
    expect(executeToolDirectMock).toHaveBeenCalledWith(
      AGENT_ID,
      OWNER_USER_ID,
      'google_workspace',
      'gws_calendar_events_list',
      args
    );
  });

  test('POST /mcp/tools/call maps Notion database read aliases to the upstream MCP tool name', async () => {
    fakeConnections.set(NOTION_CONNECTION_REF, {
      id: NOTION_CONNECTION_REF,
      organizationId: ORG_ID,
      agentId: AGENT_ID,
      platform: 'notion',
      config: {},
      settings: {},
      metadata: { ownerUserId: OWNER_USER_ID },
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
        connectorKey: 'notion',
        connectionRef: NOTION_CONNECTION_REF,
        toolName: 'notion_read_database',
        args: { databaseId: 'db-001' },
      }),
    });

    expect(res.status).toBe(200);
    expect(executeToolDirectMock).toHaveBeenCalledWith(
      AGENT_ID,
      OWNER_USER_ID,
      NOTION_CONNECTION_REF,
      'notion-fetch',
      { databaseId: 'db-001' }
    );
  });

  test('POST /mcp/tools/call maps materialized Notion search to the upstream MCP tool name', async () => {
    fakeConnections.set(MATERIALIZED_CONNECTION_REF, {
      id: MATERIALIZED_CONNECTION_REF,
      organizationId: ORG_ID,
      agentId: AGENT_ID,
      platform: 'notion',
      config: {},
      settings: {},
      metadata: {
        ownerUserId: OWNER_USER_ID,
        connectorKey: 'notion',
        mcpId: 'notion',
        source: 'toolbox-personal-agent-materialized',
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
        connectorKey: 'notion',
        connectionRef: MATERIALIZED_CONNECTION_REF,
        toolName: 'notion_search',
        args: { query: '大h line bot', limit: 5 },
      }),
    });

    expect(res.status).toBe(200);
    expect(executeToolDirectMock).toHaveBeenCalledWith(
      AGENT_ID,
      OWNER_USER_ID,
      'notion',
      'notion-search',
      { query: '大h line bot', limit: 5 }
    );
  });

  test('POST /mcp/tools/call keeps provider write tools out of the direct discovery route', async () => {
    const app = await importMountedAgentRoutes();

    for (const request of [
      {
        connectorKey: 'notion',
        connectionRef: NOTION_CONNECTION_REF,
        toolName: 'notion-create-pages',
        args: { parent: { page_id: 'page-1' }, pages: [] },
      },
      {
        connectorKey: 'google_workspace',
        connectionRef: CONNECTION_REF,
        toolName: 'docs_create',
        args: { title: 'PM summary' },
      },
    ] as const) {
      const res = await app.request('/lobu/api/v1/mcp/tools/call', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer admin-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ownerUserId: OWNER_USER_ID,
          agentId: AGENT_ID,
          ...request,
        }),
      });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        ok: false,
        errorCode: 'lobu_mcp_tool_not_allowed',
      });
    }

    expect(executeToolDirectMock).not.toHaveBeenCalled();
  });

  test('POST /mcp/tools/call executes a shifu_toolbox course PM profile tool call', async () => {
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

    const args = {
      toolboxUserId: OWNER_USER_ID,
      agentId: AGENT_ID,
      courses: [{ courseName: '超級AI個體' }],
    };
    const res = await app.request('/lobu/api/v1/mcp/tools/call', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer admin-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ownerUserId: OWNER_USER_ID,
        agentId: AGENT_ID,
        connectorKey: 'shifu_toolbox',
        connectionRef,
        toolName: 'submit_course_pm_profile',
        args,
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true });
    expect(executeToolDirectMock).toHaveBeenCalledWith(
      AGENT_ID,
      OWNER_USER_ID,
      'shifu-toolbox',
      'submit_course_pm_profile',
      args
    );
  });

  test('POST /mcp/tools/call returns safe diagnostic code and classifies upstream_forbidden isError result as needs_reauth', async () => {
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
      classification: 'needs_reauth',
    });
    expect(executeToolDirectMock).toHaveBeenCalledWith(
      AGENT_ID,
      OWNER_USER_ID,
      CONNECTION_REF,
      'gws_drive_search',
      { query: 'test', limit: 1 }
    );
  });

  test('POST /mcp/tools/call classifies upstream_unauthorized isError result as needs_reauth', async () => {
    executeToolDirectMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'private upstream body must not leak' }],
      isError: true,
      diagnosticCode: 'upstream_unauthorized',
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
      diagnosticCode: 'upstream_unauthorized',
      classification: 'needs_reauth',
    });
    expect(executeToolDirectMock).toHaveBeenCalledWith(
      AGENT_ID,
      OWNER_USER_ID,
      CONNECTION_REF,
      'gws_drive_search',
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
      classification: 'transient_error',
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
      classification: 'transient_error',
    });
    expect(executeToolDirectMock).toHaveBeenCalledWith(
      AGENT_ID,
      OWNER_USER_ID,
      CONNECTION_REF,
      'gws_drive_search',
      { query: 'test', limit: 1 }
    );
  });

  test('executes without connectionRef when agent settings has the connector (cold start)', async () => {
    fakeConnections.clear();
    getAllHttpServersMock.mockResolvedValueOnce(
      new Map([['notion', { url: 'https://mcp.test.local/notion' }]])
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
        connectorKey: 'notion',
        toolName: 'search',
        args: {},
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
      'notion',
      'notion-search',
      {}
    );
  });

  test('returns classification not_connected ONLY when settings lack the connector', async () => {
    getAllHttpServersMock.mockResolvedValueOnce(new Map());
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
        connectorKey: 'notion',
        toolName: 'search',
        args: {},
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      classification: 'not_connected',
      errorCode: 'lobu_mcp_not_connected',
    });
    expect(executeToolDirectMock).not.toHaveBeenCalled();
  });

  test('settings-truth path rejects agentId owned by someone else as not_connected (IDOR guard)', async () => {
    // Connector IS present in agent settings — the rejection below must come
    // from the ownership binding, not from a missing connector entry.
    getAllHttpServersMock.mockResolvedValueOnce(
      new Map([['notion', { url: 'https://mcp.test.local/notion' }]])
    );
    const app = await importMountedAgentRoutes();

    const res = await app.request('/lobu/api/v1/mcp/tools/call', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer admin-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        // AGENT_ID's recorded owner is OWNER_USER_ID; the caller asserts a
        // different ownerUserId while holding a valid mcp:admin PAT.
        ownerUserId: 'user-intruder-999',
        agentId: AGENT_ID,
        connectorKey: 'notion',
        toolName: 'search',
        args: {},
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      classification: 'not_connected',
      errorCode: 'lobu_mcp_not_connected',
    });
    // Must short-circuit before settings resolution and before execution.
    expect(getAllHttpServersMock).not.toHaveBeenCalled();
    expect(executeToolDirectMock).not.toHaveBeenCalled();
  });

  test('settings-truth path rejects unknown agentId as not_connected (indistinguishable from missing connector)', async () => {
    getAllHttpServersMock.mockResolvedValueOnce(
      new Map([['notion', { url: 'https://mcp.test.local/notion' }]])
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
        agentId: 'no-such-agent',
        connectorKey: 'notion',
        toolName: 'search',
        args: {},
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      classification: 'not_connected',
      errorCode: 'lobu_mcp_not_connected',
    });
    expect(getAllHttpServersMock).not.toHaveBeenCalled();
    expect(executeToolDirectMock).not.toHaveBeenCalled();
  });

  test('catch-block fallback: classifies a thrown upstream 401 error as needs_reauth, never not_connected (executeToolDirect does not throw in production; this covers the classifier fallback path)', async () => {
    getAllHttpServersMock.mockResolvedValueOnce(
      new Map([['notion', { url: 'https://mcp.test.local/notion' }]])
    );
    executeToolDirectMock.mockRejectedValueOnce(new Error('upstream 401 unauthorized'));
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
        connectorKey: 'notion',
        toolName: 'search',
        args: {},
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.classification).toBe('needs_reauth');
    expect(body.classification).not.toBe('not_connected');
  });

  describe('connectUrl on not_connected / needs_reauth tool call failures', () => {
    const PUBLIC_GATEWAY_URL = 'https://gateway.example.test/lobu';

    function withPublicGatewayUrl() {
      coreServicesStash.services = {
        ...coreServicesStash.services,
        getPublicGatewayUrl: () => PUBLIC_GATEWAY_URL,
      };
    }

    test('attaches an https connectUrl referencing mcpId and ownerUserId when an isError result classifies as needs_reauth', async () => {
      withPublicGatewayUrl();
      getAllHttpServersMock.mockResolvedValueOnce(
        new Map([['notion', { url: 'https://mcp.test.local/notion' }]])
      );
      executeToolDirectMock.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'private upstream body must not leak' }],
        isError: true,
        diagnosticCode: 'upstream_unauthorized',
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
          connectorKey: 'notion',
          toolName: 'search',
          args: {},
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.classification).toBe('needs_reauth');
      expect(typeof body.connectUrl).toBe('string');
      expect(body.connectUrl.startsWith('https://')).toBe(true);
      const url = new URL(body.connectUrl);
      // The binding travels inside a signed token, never as free-form params.
      expect(url.searchParams.get('agentId')).toBeNull();
      expect(url.searchParams.get('mcpId')).toBeNull();
      expect(url.searchParams.get('userId')).toBeNull();
      const payload = verifyConnectLinkToken(url.searchParams.get('token') ?? '');
      expect(payload).not.toBeNull();
      expect(payload!.mcpId).toBe('notion');
      expect(payload!.userId).toBe(OWNER_USER_ID);
      expect(payload!.agentId).toBe(AGENT_ID);
      expect(payload!.organizationId).toBe(ORG_ID);
      expect(payload!.exp).toBeGreaterThan(Date.now());
    });

    test('attaches connectUrl when a thrown error classifies as needs_reauth via the classifier fallback', async () => {
      withPublicGatewayUrl();
      getAllHttpServersMock.mockResolvedValueOnce(
        new Map([['notion', { url: 'https://mcp.test.local/notion' }]])
      );
      executeToolDirectMock.mockRejectedValueOnce(new Error('upstream 401 unauthorized'));
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
          connectorKey: 'notion',
          toolName: 'search',
          args: {},
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.classification).toBe('needs_reauth');
      expect(typeof body.connectUrl).toBe('string');
      expect(body.connectUrl.startsWith('https://')).toBe(true);
    });

    test('attaches connectUrl for a genuine settings-miss not_connected using the canonical mcpId', async () => {
      withPublicGatewayUrl();
      getAllHttpServersMock.mockResolvedValueOnce(new Map());
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
          connectorKey: 'notion',
          toolName: 'search',
          args: {},
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.classification).toBe('not_connected');
      expect(typeof body.connectUrl).toBe('string');
      const url = new URL(body.connectUrl);
      expect(url.protocol).toBe('https:');
      const payload = verifyConnectLinkToken(url.searchParams.get('token') ?? '');
      expect(payload).not.toBeNull();
      expect(payload!.mcpId).toBe('notion');
      expect(payload!.userId).toBe(OWNER_USER_ID);
      expect(payload!.agentId).toBe(AGENT_ID);
      expect(payload!.organizationId).toBe(ORG_ID);
    });

    test('never attaches connectUrl for an IDOR ownerUserId mismatch, even with a configured gateway URL', async () => {
      withPublicGatewayUrl();
      getAllHttpServersMock.mockResolvedValueOnce(
        new Map([['notion', { url: 'https://mcp.test.local/notion' }]])
      );
      const app = await importMountedAgentRoutes();

      const res = await app.request('/lobu/api/v1/mcp/tools/call', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer admin-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ownerUserId: 'user-intruder-999',
          agentId: AGENT_ID,
          connectorKey: 'notion',
          toolName: 'search',
          args: {},
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.classification).toBe('not_connected');
      expect(body.connectUrl).toBeUndefined();
      expect(getAllHttpServersMock).not.toHaveBeenCalled();
    });

    test('never attaches connectUrl for an unknown agentId, even with a configured gateway URL', async () => {
      withPublicGatewayUrl();
      getAllHttpServersMock.mockResolvedValueOnce(
        new Map([['notion', { url: 'https://mcp.test.local/notion' }]])
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
          agentId: 'no-such-agent',
          connectorKey: 'notion',
          toolName: 'search',
          args: {},
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.classification).toBe('not_connected');
      expect(body.connectUrl).toBeUndefined();
    });

    test('omits connectUrl and still responds 200 when publicGatewayUrl is not configured', async () => {
      // Deliberately do NOT call withPublicGatewayUrl(): coreServicesStash.services
      // has no getPublicGatewayUrl, mirroring a deployment missing the config.
      getAllHttpServersMock.mockResolvedValueOnce(
        new Map([['notion', { url: 'https://mcp.test.local/notion' }]])
      );
      executeToolDirectMock.mockRejectedValueOnce(new Error('upstream 401 unauthorized'));
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
          connectorKey: 'notion',
          toolName: 'search',
          args: {},
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.classification).toBe('needs_reauth');
      expect(body.connectUrl).toBeUndefined();
    });

    test('never attaches connectUrl for transient_error / config_error classifications', async () => {
      withPublicGatewayUrl();
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
      const body = await res.json();
      expect(body.classification).toBe('transient_error');
      expect(body.connectUrl).toBeUndefined();
    });
  });

  test('keeps legacy connectionRef path working during compat window', async () => {
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
        args: { query: 'legacy path', limit: 1 },
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
      'gws_drive_search',
      { query: 'legacy path', limit: 1 }
    );
    expect(getAllHttpServersMock).not.toHaveBeenCalled();
  });

  test('enforces connectionRef when TOOLS_CALL_REQUIRE_CONNECTION_REF=true', async () => {
    const priorFlag = process.env.TOOLS_CALL_REQUIRE_CONNECTION_REF;
    process.env.TOOLS_CALL_REQUIRE_CONNECTION_REF = 'true';
    try {
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
          connectorKey: 'notion',
          toolName: 'search',
          args: {},
        }),
      });

      expect(res.status).toBe(400);
      expect(executeToolDirectMock).not.toHaveBeenCalled();
    } finally {
      if (priorFlag === undefined) {
        delete process.env.TOOLS_CALL_REQUIRE_CONNECTION_REF;
      } else {
        process.env.TOOLS_CALL_REQUIRE_CONNECTION_REF = priorFlag;
      }
    }
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
      'gws_drive_search',
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
      'gws_docs_read',
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
      'gws_drive_search',
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

  test('POST /mcp/tools/call does not emit observability when auth fails', async () => {
    process.env.SHIFU_AGENT_OBS_ENABLED = 'true';
    process.env.SHIFU_AGENT_OBS_INGEST_URL = 'https://obs.example.test/ingest';
    const fetchMock = mock(async () => new Response('{}', { status: 202 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
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
    expect(fetchMock).not.toHaveBeenCalled();
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
    expect(listToolsDirectMock).toHaveBeenCalledWith(
      AGENT_ID,
      OWNER_USER_ID,
      CONNECTION_REF
    );
  });

  test('GET /mcp/connections/status returns mcp_server_missing when no executable MCP server is configured', async () => {
    fakeConnections.set(MATERIALIZED_CONNECTION_REF, {
      id: MATERIALIZED_CONNECTION_REF,
      organizationId: ORG_ID,
      agentId: AGENT_ID,
      platform: 'google_workspace',
      config: { credentialRef: 'lobu_secret_safe_ref' },
      settings: {},
      metadata: {
        ownerUserId: OWNER_USER_ID,
        connectorKey: 'google_workspace',
        provider: 'google_workspace',
        mcpId: 'google_workspace',
        materializedFromConnectionRef: SOURCE_CONNECTION_REF,
      },
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    getHttpServerMock.mockResolvedValueOnce(undefined);
    const app = await importMountedAgentRoutes();

    const res = await app.request(
      `/lobu/api/v1/mcp/connections/status?agentId=${AGENT_ID}&ownerUserId=${OWNER_USER_ID}&connectorKey=google_workspace&connectionRef=${MATERIALIZED_CONNECTION_REF}`,
      {
        headers: { Authorization: 'Bearer admin-token' },
      }
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      status: 'error',
      toolsDiscovered: [],
      errorCode: 'mcp_server_missing',
    });
    expect(getHttpServerMock).toHaveBeenCalledWith('google_workspace', AGENT_ID);
  });

  test('GET /mcp/connections/status uses the connection ref fallback for executable MCP server lookup', async () => {
    const connection = fakeConnections.get(CONNECTION_REF);
    fakeConnections.delete(CONNECTION_REF);
    fakeConnections.set(SOURCE_CONNECTION_REF, {
      ...connection,
      id: SOURCE_CONNECTION_REF,
      metadata: {
        ownerUserId: OWNER_USER_ID,
        connectorKey: 'google_workspace',
        provider: 'google_workspace',
      },
    });
    const app = await importMountedAgentRoutes();

    const res = await app.request(
      `/lobu/api/v1/mcp/connections/status?agentId=${AGENT_ID}&ownerUserId=${OWNER_USER_ID}&connectorKey=google_workspace&connectionRef=${SOURCE_CONNECTION_REF}`,
      {
        headers: { Authorization: 'Bearer admin-token' },
      }
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      status: 'ready',
      toolsDiscovered: GOOGLE_WORKSPACE_DISCOVERY_TOOLS,
    });
    expect(getHttpServerMock).toHaveBeenCalledWith(SOURCE_CONNECTION_REF, AGENT_ID);
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

  test('GET /mcp/connections/status maps tools/list auth failures to needs_reauth', async () => {
    listToolsDirectMock.mockRejectedValueOnce(
      Object.assign(new Error('MCP tools/list requires authentication'), {
        diagnosticCode: 'upstream_unauthorized',
      })
    );
    const app = await importMountedAgentRoutes();

    const res = await app.request(
      `/lobu/api/v1/mcp/connections/status?agentId=${AGENT_ID}&ownerUserId=${OWNER_USER_ID}&connectorKey=google_workspace&connectionRef=${CONNECTION_REF}`,
      {
        headers: { Authorization: 'Bearer admin-token' },
      }
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      status: 'needs_reauth',
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
    expect(listToolsDirectMock).toHaveBeenCalledWith(
      AGENT_ID,
      OWNER_USER_ID,
      'google_workspace'
    );
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

  test('POST /mcp/connections/materialize returns normal error shape when no executable MCP server is configured', async () => {
    seedSourceConnectionForMaterialize();
    getHttpServerMock.mockResolvedValueOnce(undefined);
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
      errorCode: 'mcp_server_missing',
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
    expect(listToolsDirectMock).toHaveBeenCalledWith(
      AGENT_ID,
      OWNER_USER_ID,
      'shifu-toolbox'
    );
  });

  test('POST /mcp/connections/materialize maps shifu_toolbox tools/list auth failures to needs_reauth', async () => {
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
    listToolsDirectMock.mockRejectedValueOnce(
      Object.assign(new Error('MCP tools/list requires authentication'), {
        diagnosticCode: 'upstream_unauthorized',
      })
    );
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
    await expect(res.json()).resolves.toEqual({
      status: 'needs_reauth',
      lobuConnectionRef: null,
      toolsDiscovered: [],
      errorCode: 'upstream_unauthorized',
    });
    expect(listToolsDirectMock).toHaveBeenCalledWith(
      AGENT_ID,
      OWNER_USER_ID,
      'shifu-toolbox'
    );
  });

  test('POST /mcp/connections/materialize creates a ready shifu_toolbox row when only the agent MCP server exists', async () => {
    const shifuToolboxConnectionRef = `toolbox-mcp:${createHash('sha256')
      .update(JSON.stringify([ORG_ID, OWNER_USER_ID, AGENT_ID, 'shifu_toolbox']))
      .digest('hex')}`;
    fakeConnections.delete(CONNECTION_REF);
    for (const [connectionRef, connection] of fakeConnections) {
      if (connection.agentId === AGENT_ID && connection.platform === 'shifu-toolbox') {
        fakeConnections.delete(connectionRef);
      }
    }
    fakeSettings.set(AGENT_ID, {
      mcpServers: {
        'shifu-toolbox': {
          type: 'http',
          url: 'https://mcp.shifu-ai.org/mcp',
        },
      },
      preApprovedTools: [],
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
    expect(body.status).toBe('ready');
    expect(body.lobuConnectionRef).toEqual(expect.any(String));
    expect(body.toolsDiscovered).toContain('meeting_search');
    expect(body.toolsDiscovered).toContain('submit_course_pm_profile');
    expect(body.lobuConnectionRef).toBe(shifuToolboxConnectionRef);
    expect(listToolsDirectMock).toHaveBeenCalledWith(
      AGENT_ID,
      OWNER_USER_ID,
      'shifu-toolbox'
    );
    expect(fakeConnections.get(shifuToolboxConnectionRef)).toMatchObject({
      id: shifuToolboxConnectionRef,
      agentId: AGENT_ID,
      platform: 'shifu-toolbox',
      status: 'active',
      metadata: {
        connectorKey: 'shifu_toolbox',
        mcpId: 'shifu-toolbox',
        provider: 'shifu-toolbox',
        ownerUserId: OWNER_USER_ID,
        source: 'toolbox-personal-agent-materialized',
      },
    });
  });

  test('POST /mcp/connections/materialize does not create shifu_toolbox row from global-only MCP config', async () => {
    const shifuToolboxConnectionRef = `toolbox-mcp:${createHash('sha256')
      .update(JSON.stringify([ORG_ID, OWNER_USER_ID, AGENT_ID, 'shifu_toolbox']))
      .digest('hex')}`;
    fakeConnections.delete(CONNECTION_REF);
    fakeSettings.delete(AGENT_ID);
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
    expect(['not_connected', 'error']).toContain(body.status);
    if (body.status === 'error') {
      expect(body.errorCode).toBe('mcp_server_missing');
    }
    expect(body.lobuConnectionRef).toBe(null);
    expect(fakeConnections.has(shifuToolboxConnectionRef)).toBe(false);
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

  test('POST /mcp/connections/materialize maps tools/list auth failures to needs_reauth', async () => {
    seedSourceConnectionForMaterialize();
    listToolsDirectMock.mockRejectedValueOnce(
      Object.assign(new Error('MCP tools/list requires authentication'), {
        diagnosticCode: 'upstream_forbidden',
      })
    );
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
      toolsDiscovered: [],
      errorCode: 'upstream_forbidden',
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
