import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
} from '../../gateway/__tests__/helpers/db-setup.js';
import { getDb } from '../../db/client.js';
import { initWorkspaceProvider } from '../../workspace/index.js';
import { orgContext } from '../stores/org-context.js';

const ORG_ID = 'org-memory';
const OWNER_USER_ID = 'user-owner';
const NON_MEMBER_USER_ID = 'user-non-member';
const AGENT_ID = 'shifu-u-a4175b7e71f4';

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

beforeAll(async () => {
  await ensureDbForGatewayTests();
  await initWorkspaceProvider();
});

async function importMountedMemoryRoutes() {
  const { memoryRoutes } = await import('../memory-routes.js?memory-routes-db-test');
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', auth.user);
    c.set('organizationId', auth.organizationId);
    c.set('authSource', auth.authSource);
    c.set('mcpAuthInfo', auth.mcpAuthInfo);
    c.set('memberRole', auth.memberRole);
    return orgContext.run({ organizationId: auth.organizationId }, next);
  });
  app.route('/lobu/api/v1/memory', memoryRoutes);
  return app;
}

async function seedOrgMemberAndAgent(options: { includeOwnerMembership?: boolean } = {}) {
  const includeOwnerMembership = options.includeOwnerMembership ?? true;
  const sql = getDb();
  await sql`
    INSERT INTO organization (id, name, slug)
    VALUES (${ORG_ID}, ${ORG_ID}, ${ORG_ID})
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
    VALUES
      (${OWNER_USER_ID}, ${OWNER_USER_ID}, 'owner@test.local', true, NOW(), NOW()),
      (${NON_MEMBER_USER_ID}, ${NON_MEMBER_USER_ID}, 'non-member@test.local', true, NOW(), NOW())
    ON CONFLICT (id) DO NOTHING
  `;
  if (includeOwnerMembership) {
    await sql`
      INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt")
      VALUES ('member_memory_owner', ${ORG_ID}, ${OWNER_USER_ID}, 'member', NOW())
      ON CONFLICT ("organizationId", "userId") DO NOTHING
    `;
  }

  const { createPostgresAgentConfigStore } = await import('../stores/postgres-stores.js');
  const store = createPostgresAgentConfigStore();
  await orgContext.run({ organizationId: ORG_ID }, async () => {
    await store.saveMetadata(AGENT_ID, {
      agentId: AGENT_ID,
      name: 'Personal Agent',
      owner: { platform: 'toolbox', userId: OWNER_USER_ID },
      organizationId: ORG_ID,
      createdAt: Date.now(),
    });
  });
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
  beforeEach(async () => {
    await resetTestDatabase();
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
    await seedOrgMemberAndAgent();
  });

  test('writes a durable context pack through the HTTP route', async () => {
    const app = await importMountedMemoryRoutes();

    const res = await app.request('/lobu/api/v1/memory/context-packs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(contextPackBody()),
    });

    if (res.status !== 200) {
      throw new Error(await res.text());
    }
    const body = await res.json();
    const eventId = body.memory?.eventId;
    expect(Number.isInteger(eventId)).toBe(true);
    expect(body).toMatchObject({
      ok: true,
      refs: [expect.stringMatching(/^lobu:event:\d+$/)],
      memory: {
        eventId,
        viewUrl: expect.any(String),
        semanticType: 'project_profile',
        agentId: AGENT_ID,
      },
    });

    const sql = getDb();
    const events = await sql`
      SELECT id, organization_id, semantic_type, created_by, metadata
      FROM events
      WHERE id = ${eventId}
    `;
    expect(events).toEqual([
      expect.objectContaining({
        id: eventId,
        organization_id: ORG_ID,
        semantic_type: 'project_profile',
        created_by: OWNER_USER_ID,
        metadata: expect.objectContaining({
          source: 'toolbox_onboarding',
          owner_user_id: OWNER_USER_ID,
          agent_id: AGENT_ID,
          memory_source: 'toolbox_onboarding',
        }),
      }),
    ]);
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
  });

  test('rejects agents not owned by ownerUserId', async () => {
    const app = await importMountedMemoryRoutes();

    const res = await app.request('/lobu/api/v1/memory/context-packs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(contextPackBody({ ownerUserId: NON_MEMBER_USER_ID })),
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      errorCode: 'lobu_memory_write_forbidden',
      errorMessage: 'Agent is not owned by ownerUserId',
    });
  });

  test('rejects owners who are not organization members; provisioning must repair this', async () => {
    await resetTestDatabase();
    await seedOrgMemberAndAgent({ includeOwnerMembership: false });
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
      errorMessage: 'ownerUserId is not a member of this organization',
    });
  });
});

describe('writeContextPackMemory', () => {
  test('writes durable context pack memory through injected saveContentImpl', async () => {
    const { writeContextPackMemory } = await import('../context-pack-memory-service.js');
    const calls: unknown[][] = [];
    const saveContentImpl = async (...args: unknown[]) => {
      calls.push(args);
      return {
        id: 123,
        semantic_type: 'project_profile',
        view_url: 'https://app.example.test/events/123',
      };
    };

    const result = await writeContextPackMemory(
      {
        organizationId: ORG_ID,
        ownerMemberRole: 'member',
        authSource: 'pat',
        scopes: ['mcp:admin'],
        body: contextPackBody(),
      },
      { saveContentImpl: saveContentImpl as never }
    );

    expect(result).toMatchObject({
      refs: ['lobu:event:123'],
      eventId: 123,
      semanticType: 'project_profile',
      agentId: AGENT_ID,
      viewUrl: 'https://app.example.test/events/123',
    });
    expect(calls).toHaveLength(1);
    const [args, _env, ctx] = calls[0]!;
    expect(args).toMatchObject({
      semantic_type: 'project_profile',
      title: '超級AI個體 onboarding context pack',
      metadata: {
        source: 'toolbox_onboarding',
        summary: 'Project summary',
        owner_user_id: OWNER_USER_ID,
        agent_id: AGENT_ID,
        memory_source: 'toolbox_onboarding',
      },
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

  test('passes generated embeddings into saveContent when embeddings service is configured', async () => {
    const { writeContextPackMemory } = await import('../context-pack-memory-service.js');
    const generatedEmbedding = Array.from({ length: 768 }, (_, index) => index / 768);
    const calls: unknown[][] = [];
    const saveContentImpl = async (...args: unknown[]) => {
      calls.push(args);
      return {
        id: 124,
        semantic_type: 'project_profile',
      };
    };
    const generateEmbeddingsImpl = async (texts: string[]) => {
      expect(texts).toEqual(['# 超級AI個體\n\nProject context.']);
      return [generatedEmbedding];
    };

    await writeContextPackMemory(
      {
        organizationId: ORG_ID,
        ownerMemberRole: 'member',
        authSource: 'pat',
        scopes: ['mcp:admin'],
        env: { EMBEDDINGS_SERVICE_URL: 'http://embeddings.test' } as never,
        body: contextPackBody(),
      },
      {
        saveContentImpl: saveContentImpl as never,
        generateEmbeddingsImpl: generateEmbeddingsImpl as never,
      }
    );

    const [args] = calls[0]!;
    expect(args).toMatchObject({
      embedding: generatedEmbedding,
      embedding_model: 'Xenova/bge-base-en-v1.5',
    });
  });

  test('enqueues embedding backfill after writing a context pack without inline embeddings', async () => {
    const { writeContextPackMemory } = await import('../context-pack-memory-service.js');
    const backfillCalls: string[] = [];
    const saveContentImpl = async () => ({
      id: 125,
      semantic_type: 'project_profile',
    });
    const enqueueEmbeddingBackfillImpl = async (organizationId: string) => {
      backfillCalls.push(organizationId);
      return true;
    };

    await writeContextPackMemory(
      {
        organizationId: ORG_ID,
        ownerMemberRole: 'member',
        authSource: 'pat',
        scopes: ['mcp:admin'],
        body: contextPackBody(),
      },
      {
        saveContentImpl: saveContentImpl as never,
        enqueueEmbeddingBackfillImpl,
      }
    );

    expect(backfillCalls).toEqual([ORG_ID]);
  });

  test('rejects durable memory writes that return no event id', async () => {
    const { ContextPackMemoryError, writeContextPackMemory } = await import(
      '../context-pack-memory-service.js'
    );
    const saveContentImpl = async () => ({
      id: 0,
      semantic_type: 'project_profile',
    });

    try {
      await writeContextPackMemory(
        {
          organizationId: ORG_ID,
          ownerMemberRole: 'member',
          authSource: 'pat',
          scopes: ['mcp:admin'],
          body: contextPackBody(),
        },
        { saveContentImpl: saveContentImpl as never }
      );
      throw new Error('Expected writeContextPackMemory to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(ContextPackMemoryError);
      expect(error).toMatchObject({
        errorCode: 'lobu_memory_write_failed',
      });
    }
  });
});
