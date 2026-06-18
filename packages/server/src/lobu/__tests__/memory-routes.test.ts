import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';

const ORG_ID = 'org-memory';
const OWNER_USER_ID = 'user-owner';
const AGENT_ID = 'shifu-u-a4175b7e71f4';
const fakeAgents = new Map<string, any>();
let auth = {
  user: {
    id: 'toolbox-server',
    name: 'Toolbox Server',
    email: 'toolbox@test.local',
    emailVerified: true,
  } as { id: string; name: string; email: string; emailVerified: boolean } | null,
  organizationId: ORG_ID,
  authSource: 'pat' as 'session' | 'pat' | 'oauth' | null,
  mcpAuthInfo: { scopes: ['mcp:admin'] },
  memberRole: null as string | null,
};

const saveContentMock = mock(async (args: any) => ({
  id: 123,
  entity_ids: [],
  title: args.title,
  semantic_type: args.semantic_type,
  created_at: '2026-06-18T00:00:00.000Z',
  view_url: 'https://app.example.test/events/123',
}));

function fakeSql() {
  const sql = (async () => []) as any;
  sql.unsafe = async () => [];
  sql.array = (value: unknown) => value;
  sql.json = (value: unknown) => value;
  sql.begin = async (fn: any) => fn(sql);
  return sql;
}

mock.module('../../auth/middleware', () => ({
  mcpAuth: async (c: any, next: any) => {
    c.set('user', auth.user);
    c.set('organizationId', auth.organizationId);
    c.set('authSource', auth.authSource);
    c.set('mcpAuthInfo', auth.mcpAuthInfo);
    c.set('memberRole', auth.memberRole);
    return next();
  },
}));

mock.module('../../db/client', () => ({
  getDb: fakeSql,
  createDbClientFromEnv: fakeSql,
  getAuthDialect: () => ({}),
  getDbListener: () => ({ listen: async () => {}, close: async () => {} }),
  pgTextArray: (values: (string | null)[]) => `{${values.join(',')}}`,
  pgBigintArray: (values: number[]) => `{${values.join(',')}}`,
  parsePgTextArray: (value: unknown) => (Array.isArray(value) ? value : []),
  parsePgNumberArray: (value: unknown) => (Array.isArray(value) ? value.map(Number) : []),
  PROD_PG_VALUE_OPTIONS: {},
}));

mock.module('../../tools/save_content', () => ({
  SaveContentSchema: {},
  saveContent: saveContentMock,
}));

mock.module('../../utils/organization-access', () => ({
  getWorkspaceRole: async (_sql: unknown, _orgId: string, userId: string) =>
    userId === OWNER_USER_ID ? 'member' : null,
  requireReadAccess: async () => {},
  requireWriteAccess: async () => {},
  requireOrgReadAccess: async () => {},
  requireOrgWriteAccess: async () => {},
}));

mock.module('../stores/postgres-stores', () => ({
  AGENT_ID_PATTERN: /^[a-z][a-z0-9-]{2,59}$/,
  createPostgresAgentConfigStore: () => ({
    getMetadata: async (agentId: string) => fakeAgents.get(agentId) ?? null,
  }),
}));

async function importMountedMemoryRoutes() {
  const { memoryRoutes } = await import('../memory-routes.js');
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', auth.user);
    c.set('organizationId', auth.organizationId);
    c.set('authSource', auth.authSource);
    c.set('mcpAuthInfo', auth.mcpAuthInfo);
    c.set('memberRole', auth.memberRole);
    return next();
  });
  app.route('/lobu/api/v1/memory', memoryRoutes);
  return app;
}

function contextPackBody(overrides: Record<string, unknown> = {}) {
  return {
    ownerUserId: OWNER_USER_ID,
    agentId: AGENT_ID,
    title: '超級AI個體 onboarding context pack',
    summary: 'Project summary',
    content: '# 超級AI個體\n\nProject context.',
    semanticType: 'project_profile',
    metadata: {
      source: 'toolbox_onboarding',
      contextPackId: 'ctx-001',
      projectSeedId: null,
      discoveryRunId: null,
      projectTitle: '超級AI個體',
      confidence: 'high',
      generatedAt: '2026-06-18T00:00:00.000Z',
      evidenceRefs: [],
    },
    ...overrides,
  };
}

describe('Toolbox context pack memory route', () => {
  beforeEach(() => {
    fakeAgents.clear();
    fakeAgents.set(AGENT_ID, {
      agentId: AGENT_ID,
      name: 'Personal Agent',
      owner: { platform: 'toolbox', userId: OWNER_USER_ID },
      organizationId: ORG_ID,
      createdAt: Date.now(),
    });
    saveContentMock.mockClear();
    auth = {
      user: {
        id: 'toolbox-server',
        name: 'Toolbox Server',
        email: 'toolbox@test.local',
        emailVerified: true,
      },
      organizationId: ORG_ID,
      authSource: 'pat',
      mcpAuthInfo: { scopes: ['mcp:admin'] },
      memberRole: null,
    };
  });

  test('writes a durable context pack memory ref', async () => {
    const app = await importMountedMemoryRoutes();

    const res = await app.request('/lobu/api/v1/memory/context-packs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(contextPackBody()),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      refs: ['lobu:event:123'],
      memory: {
        eventId: 123,
        viewUrl: 'https://app.example.test/events/123',
        semanticType: 'project_profile',
        agentId: AGENT_ID,
      },
    });
    expect(saveContentMock).toHaveBeenCalledTimes(1);
    const [args, _env, ctx] = saveContentMock.mock.calls[0]!;
    expect(args.semantic_type).toBe('project_profile');
    expect(args.metadata).toMatchObject({
      source: 'toolbox_onboarding',
      summary: 'Project summary',
      projectSeedId: null,
      discoveryRunId: null,
      owner_user_id: OWNER_USER_ID,
      agent_id: AGENT_ID,
      memory_source: 'toolbox_onboarding',
    });
    expect(ctx).toMatchObject({
      organizationId: ORG_ID,
      userId: OWNER_USER_ID,
      memberRole: 'member',
      agentId: AGENT_ID,
      tokenType: 'pat',
      scopedToOrg: true,
      allowCrossOrg: false,
    });
  });

  test('rejects read-only PAT scopes for memory writes', async () => {
    auth.mcpAuthInfo = { scopes: ['mcp:read'] };
    const app = await importMountedMemoryRoutes();

    const res = await app.request('/lobu/api/v1/memory/context-packs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(contextPackBody()),
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      errorCode: 'lobu_memory_write_forbidden',
      errorMessage: expect.any(String),
    });
    expect(saveContentMock).not.toHaveBeenCalled();
  });

  test('rejects non-admin PATs for a different owner', async () => {
    auth.mcpAuthInfo = { scopes: ['mcp:write'] };
    const app = await importMountedMemoryRoutes();

    const res = await app.request('/lobu/api/v1/memory/context-packs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(contextPackBody()),
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      errorCode: 'lobu_memory_write_forbidden',
    });
    expect(saveContentMock).not.toHaveBeenCalled();
  });

  test('accepts an owner-scoped write PAT', async () => {
    auth.user = {
      id: OWNER_USER_ID,
      name: 'Owner',
      email: 'owner@test.local',
      emailVerified: true,
    };
    auth.mcpAuthInfo = { scopes: ['mcp:write'] };
    const app = await importMountedMemoryRoutes();

    const res = await app.request('/lobu/api/v1/memory/context-packs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(contextPackBody()),
    });

    expect(res.status).toBe(200);
    expect(saveContentMock).toHaveBeenCalledTimes(1);
  });

  test('rejects agents not owned by ownerUserId', async () => {
    fakeAgents.set(AGENT_ID, {
      agentId: AGENT_ID,
      name: 'Other Agent',
      owner: { platform: 'toolbox', userId: 'user-other' },
      organizationId: ORG_ID,
      createdAt: Date.now(),
    });
    const app = await importMountedMemoryRoutes();

    const res = await app.request('/lobu/api/v1/memory/context-packs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(contextPackBody()),
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      errorCode: 'lobu_memory_write_forbidden',
    });
    expect(saveContentMock).not.toHaveBeenCalled();
  });

  test('rejects owners who are not organization members; provisioning must repair this', async () => {
    // This protects the security boundary that caused the staging smoke failure:
    // provisioning must create the member row, memory writes must not bypass it.
    const nonMemberUserId = 'user-not-member';
    fakeAgents.set(AGENT_ID, {
      agentId: AGENT_ID,
      name: 'Personal Agent',
      owner: { platform: 'toolbox', userId: nonMemberUserId },
      organizationId: ORG_ID,
      createdAt: Date.now(),
    });
    const app = await importMountedMemoryRoutes();

    const res = await app.request('/lobu/api/v1/memory/context-packs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(contextPackBody({ ownerUserId: nonMemberUserId })),
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      errorCode: 'lobu_memory_write_forbidden',
      errorMessage: 'ownerUserId is not a member of this organization',
    });
    expect(saveContentMock).not.toHaveBeenCalled();
  });

  test('does not return 2xx when saveContent returns no durable id', async () => {
    saveContentMock.mockImplementationOnce(async () => ({
      id: 0,
      entity_ids: [],
      title: null,
      semantic_type: 'project_profile',
      created_at: '2026-06-18T00:00:00.000Z',
    }));
    const app = await importMountedMemoryRoutes();

    const res = await app.request('/lobu/api/v1/memory/context-packs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(contextPackBody()),
    });

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      errorCode: 'lobu_memory_write_failed',
    });
  });
});
