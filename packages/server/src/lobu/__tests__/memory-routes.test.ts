import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
} from '../../gateway/__tests__/helpers/db-setup.js';
import { getDb } from '../../db/client.js';
import { initWorkspaceProvider } from '../../workspace/index.js';
import {
  fakeRouteAgents,
  fakeRouteConnections,
  fakeRouteSettings,
} from './helpers/route-test-mocks.js';
import { orgContext } from '../stores/org-context.js';
import { getWorkspaceRole } from '../../utils/organization-access.js';
import logger from '../../utils/logger.js';

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
    fakeRouteAgents.clear();
    fakeRouteSettings.clear();
    fakeRouteConnections.clear();
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
      body: JSON.stringify(
        contextPackBody({
          entityIds: [' course:user-001:super-ai ', 'course:user-001:super-ai'],
        })
      ),
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
          course_entity_ids: ['course:user-001:super-ai'],
          course_entity_id: 'course:user-001:super-ai',
        }),
      }),
    ]);
  });

  test.each([
    ['non-array entityIds', { entityIds: 'course:user-001:super-ai' }],
    ['unsafe entityIds', { entityIds: ['course:user-001:super ai'] }],
    [
      'too many entityIds',
      { entityIds: Array.from({ length: 21 }, (_, index) => `course:${index}`) },
    ],
    ['zero supersedesEventId', { supersedesEventId: 0 }],
    ['negative supersedesEventId', { supersedesEventId: -1 }],
    ['non-integer supersedesEventId', { supersedesEventId: 1.5 }],
  ])('rejects invalid context pack contract fields: %s', async (_name, overrides) => {
    const app = await importMountedMemoryRoutes();

    const res = await app.request('/lobu/api/v1/memory/context-packs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(contextPackBody(overrides)),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      errorCode: 'lobu_memory_invalid_request',
      errorMessage: expect.any(String),
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
    const sql = getDb();
    await sql`
      DELETE FROM "member"
      WHERE "organizationId" = ${ORG_ID} AND "userId" = ${OWNER_USER_ID}
    `;
    await expect(getWorkspaceRole(sql, ORG_ID, OWNER_USER_ID)).resolves.toBeNull();
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

  test('rejects invalid metadata source before writing memory', async () => {
    const app = await importMountedMemoryRoutes();

    const res = await app.request('/lobu/api/v1/memory/context-packs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        contextPackBody({
          metadata: {
            source: 'manual_upload',
          },
        })
      ),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      errorCode: 'lobu_memory_invalid_request',
      errorMessage: 'source must be toolbox_onboarding',
    });
  });

  test('omits unsafe metadata ids from route log context', async () => {
    const app = await importMountedMemoryRoutes();
    const capturedLogs: unknown[] = [];
    const mutableLogger = logger as unknown as {
      info: (payload: unknown, message?: string) => unknown;
    };
    const originalInfo = mutableLogger.info;
    mutableLogger.info = (payload: unknown, message?: string) => {
      if (message === '[MemoryRoutes] context pack memory write started') {
        capturedLogs.push(payload);
      }
    };

    try {
      const res = await app.request('/lobu/api/v1/memory/context-packs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          contextPackBody({
            metadata: {
              source: 'toolbox_onboarding',
              contextPackId: 'ctx-001\nAuthorization: Bearer secret-token',
              discoveryRunId: '{"raw":"Project context"}',
            },
          })
        ),
      });
      if (res.status !== 200) {
        throw new Error(await res.text());
      }
    } finally {
      mutableLogger.info = originalInfo;
    }

    const firstLog = capturedLogs[0] as Record<string, unknown> | undefined;
    expect(firstLog).toBeDefined();
    expect(firstLog).not.toHaveProperty('contextPackId');
    expect(firstLog).not.toHaveProperty('discoveryRunId');
    expect(JSON.stringify(firstLog)).not.toContain('secret-token');
    expect(JSON.stringify(firstLog)).not.toContain('Project context');
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
        body: contextPackBody({
		  metadata: {
			source: 'toolbox_onboarding',
			custom: 'kept',
			evidence_kind: 'meeting',
			source_kind: 'meeting_notes',
			source_type: 'transcript',
		  },
          entityIds: [
            ' course:user-001:super-ai ',
            'course:user-001:super-ai',
            'course:user-001:advanced-ai',
          ],
          supersedesEventId: 456,
        }),
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
    const firstCall = calls[0];
    if (!firstCall) throw new Error('Expected saveContentImpl to be called');
    const [args, _env, ctx] = firstCall;
    expect(args).toMatchObject({
      semantic_type: 'project_profile',
      title: '超級AI個體 onboarding context pack',
      metadata: {
        source: 'toolbox_onboarding',
		custom: 'kept',
        summary: 'Project summary',
        owner_user_id: OWNER_USER_ID,
        agent_id: AGENT_ID,
        memory_source: 'toolbox_onboarding',
        course_entity_ids: ['course:user-001:super-ai', 'course:user-001:advanced-ai'],
        course_entity_id: 'course:user-001:super-ai',
      },
      supersedes_event_id: 456,
    });
	expect((args as {metadata:Record<string,unknown>}).metadata).not.toHaveProperty('evidence_kind');
	expect((args as {metadata:Record<string,unknown>}).metadata).not.toHaveProperty('source_kind');
	expect((args as {metadata:Record<string,unknown>}).metadata).not.toHaveProperty('source_type');
    expect(args).not.toHaveProperty('entity_ids');
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

  test('preserves explicit metadata course_entity_id over top-level entityIds', async () => {
    const { writeContextPackMemory } = await import('../context-pack-memory-service.js');
    const calls: unknown[][] = [];
    const saveContentImpl = async (...args: unknown[]) => {
      calls.push(args);
      return {
        id: 129,
        semantic_type: 'project_profile',
      };
    };

    await writeContextPackMemory(
      {
        organizationId: ORG_ID,
        ownerMemberRole: 'member',
        authSource: 'pat',
        scopes: ['mcp:admin'],
        body: contextPackBody({
          entityIds: ['course:user-001:first-from-top-level'],
          metadata: {
            source: 'toolbox_onboarding',
            course_entity_id: 'course:user-001:explicit-metadata',
          },
        }),
      },
      { saveContentImpl: saveContentImpl as never }
    );

    const firstCall = calls[0];
    if (!firstCall) throw new Error('Expected saveContentImpl to be called');
    const [args] = firstCall;
    expect(args).toMatchObject({
      metadata: {
        course_entity_ids: ['course:user-001:first-from-top-level'],
        course_entity_id: 'course:user-001:explicit-metadata',
      },
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

    const firstCall = calls[0];
    if (!firstCall) throw new Error('Expected saveContentImpl to be called');
    const [args] = firstCall;
    expect(args).toMatchObject({
      embedding: generatedEmbedding,
      embedding_model: 'Xenova/bge-base-en-v1.5',
    });
  });

  test('returns durable refs when inline embedding generation fails after saveContent can succeed', async () => {
    const { writeContextPackMemory } = await import('../context-pack-memory-service.js');
    const calls: unknown[][] = [];
    const saveContentImpl = async (...args: unknown[]) => {
      calls.push(args);
      return {
        id: 126,
        semantic_type: 'project_profile',
      };
    };
    const generateEmbeddingsImpl = async () => {
      throw new Error('embedding service unavailable');
    };

    const result = await writeContextPackMemory(
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

    expect(result).toMatchObject({
      refs: ['lobu:event:126'],
      eventId: 126,
      semanticType: 'project_profile',
      agentId: AGENT_ID,
    });
    expect(calls).toHaveLength(1);
    const firstCall = calls[0];
    if (!firstCall) throw new Error('Expected saveContentImpl to be called');
    const [args] = firstCall;
    expect(args).not.toHaveProperty('embedding');
    expect(args).not.toHaveProperty('embedding_model');
  });

  test('sanitizes warning error metadata without arbitrary error messages', async () => {
    const { sanitizeContextPackMemoryWarningError } = await import(
      '../context-pack-memory-service.js'
    );
    const error = new Error(
      'downstream body: # 超級AI個體 Project context Authorization: Bearer secret-token'
    ) as Error & { status?: number; code?: string };
    error.name = 'EmbeddingServiceError';
    error.status = 502;
    error.code = 'EMBEDDING_UPSTREAM_FAILED';

    const sanitized = sanitizeContextPackMemoryWarningError(error);

    expect(sanitized).toEqual({
      name: 'EmbeddingServiceError',
      reason: 'error_thrown',
      status: 502,
      code: 'EMBEDDING_UPSTREAM_FAILED',
    });
    expect(JSON.stringify(sanitized)).not.toContain('超級AI個體');
    expect(JSON.stringify(sanitized)).not.toContain('secret-token');
    expect(JSON.stringify(sanitized)).not.toContain('downstream body');
  });

  test('omits unsafe metadata ids from service warning log context', async () => {
    const { writeContextPackMemory } = await import('../context-pack-memory-service.js');
    const capturedLogs: unknown[] = [];
    const mutableLogger = logger as unknown as {
      warn: (payload: unknown, message?: string) => unknown;
    };
    const originalWarn = mutableLogger.warn;
    mutableLogger.warn = (payload: unknown, message?: string) => {
      if (
        message ===
        '[ContextPackMemory] Inline embedding generation failed; continuing without embedding'
      ) {
        capturedLogs.push(payload);
      }
    };
    const saveContentImpl = async () => ({
      id: 128,
      semantic_type: 'project_profile',
    });
    const generateEmbeddingsImpl = async () => {
      throw new Error('embedding failed');
    };

    try {
      await writeContextPackMemory(
        {
          organizationId: ORG_ID,
          ownerMemberRole: 'member',
          authSource: 'pat',
          scopes: ['mcp:admin'],
          env: { EMBEDDINGS_SERVICE_URL: 'http://embeddings.test' } as never,
          body: contextPackBody({
            metadata: {
              source: 'toolbox_onboarding',
              contextPackId: 'ctx-001\nAuthorization: Bearer secret-token',
              discoveryRunId: '{"raw":"Project context"}',
            },
          }),
        },
        {
          saveContentImpl: saveContentImpl as never,
          generateEmbeddingsImpl: generateEmbeddingsImpl as never,
        }
      );
    } finally {
      mutableLogger.warn = originalWarn;
    }

    const firstLog = capturedLogs[0] as Record<string, unknown> | undefined;
    expect(firstLog).toBeDefined();
    expect(firstLog).not.toHaveProperty('contextPackId');
    expect(firstLog).not.toHaveProperty('discoveryRunId');
    expect(JSON.stringify(firstLog)).not.toContain('secret-token');
    expect(JSON.stringify(firstLog)).not.toContain('Project context');
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

  test('returns durable refs when embedding backfill enqueue fails after saveContent succeeds', async () => {
    const { writeContextPackMemory } = await import('../context-pack-memory-service.js');
    const saveContentImpl = async () => ({
      id: 127,
      semantic_type: 'project_profile',
    });
    const enqueueEmbeddingBackfillImpl = async () => {
      throw new Error('backfill queue unavailable');
    };

    const result = await writeContextPackMemory(
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

    expect(result).toMatchObject({
      refs: ['lobu:event:127'],
      eventId: 127,
      semanticType: 'project_profile',
      agentId: AGENT_ID,
    });
  });

  test('keeps saveContent failures fatal when embeddings and backfill are non-fatal', async () => {
    const { ContextPackMemoryError, writeContextPackMemory } = await import(
      '../context-pack-memory-service.js'
    );
    const saveContentImpl = async () => {
      throw new Error('database unavailable');
    };
    const generateEmbeddingsImpl = async () => {
      throw new Error('embedding response body with sensitive content');
    };
    const enqueueEmbeddingBackfillImpl = async () => {
      throw new Error('backfill queue unavailable');
    };

    try {
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
          enqueueEmbeddingBackfillImpl,
        }
      );
      throw new Error('Expected writeContextPackMemory to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(ContextPackMemoryError);
      expect(error).toMatchObject({
        errorCode: 'lobu_memory_write_failed',
        httpStatus: 500,
      });
    }
  });

  test('passes supersedesEventId through to saveContent as supersedes_event_id', async () => {
    const { writeContextPackMemory } = await import('../context-pack-memory-service.js');
    const calls: unknown[][] = [];
    const saveContentImpl = async (...args: unknown[]) => {
      calls.push(args);
      return {
        id: 129,
        semantic_type: 'project_profile',
      };
    };

    await writeContextPackMemory(
      {
        organizationId: ORG_ID,
        ownerMemberRole: 'member',
        authSource: 'pat',
        scopes: ['mcp:admin'],
        body: contextPackBody({ supersedesEventId: 123 }),
      },
      { saveContentImpl: saveContentImpl as never }
    );

    expect(calls).toHaveLength(1);
    const firstCall = calls[0];
    if (!firstCall) throw new Error('Expected saveContentImpl to be called');
    const [args] = firstCall;
    expect(args).toMatchObject({ supersedes_event_id: 123 });
  });

  test('does not set supersedes_event_id on saveContent when supersedesEventId is omitted', async () => {
    const { writeContextPackMemory } = await import('../context-pack-memory-service.js');
    const calls: unknown[][] = [];
    const saveContentImpl = async (...args: unknown[]) => {
      calls.push(args);
      return {
        id: 130,
        semantic_type: 'project_profile',
      };
    };

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

    const firstCall = calls[0];
    if (!firstCall) throw new Error('Expected saveContentImpl to be called');
    const [args] = firstCall;
    expect(args).not.toHaveProperty('supersedes_event_id');
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

// Pure unit-level coverage for supersedesEventId parsing. Deliberately does not
// depend on the file-level ensureDbForGatewayTests()/resetTestDatabase() setup
// above — parseContextPackMemoryRequest is a pure function with no DB access.
describe('parseContextPackMemoryRequest supersedesEventId validation', () => {
  test('accepts a positive integer supersedesEventId', async () => {
    const { parseContextPackMemoryRequest } = await import('../context-pack-memory-service.js');
    const parsed = parseContextPackMemoryRequest(contextPackBody({ supersedesEventId: 123 }));
    expect(parsed.supersedesEventId).toBe(123);
  });

  test('omits supersedesEventId when absent from the request body', async () => {
    const { parseContextPackMemoryRequest } = await import('../context-pack-memory-service.js');
    const parsed = parseContextPackMemoryRequest(contextPackBody());
    expect(parsed.supersedesEventId).toBeUndefined();
  });

  test('rejects a non-numeric supersedesEventId with lobu_memory_invalid_request', async () => {
    const { ContextPackMemoryError, parseContextPackMemoryRequest } = await import(
      '../context-pack-memory-service.js'
    );
    try {
      parseContextPackMemoryRequest(contextPackBody({ supersedesEventId: 'abc' }));
      throw new Error('Expected parseContextPackMemoryRequest to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ContextPackMemoryError);
      expect(error).toMatchObject({ errorCode: 'lobu_memory_invalid_request', httpStatus: 400 });
    }
  });

  test('rejects a negative supersedesEventId with lobu_memory_invalid_request', async () => {
    const { ContextPackMemoryError, parseContextPackMemoryRequest } = await import(
      '../context-pack-memory-service.js'
    );
    try {
      parseContextPackMemoryRequest(contextPackBody({ supersedesEventId: -1 }));
      throw new Error('Expected parseContextPackMemoryRequest to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ContextPackMemoryError);
      expect(error).toMatchObject({ errorCode: 'lobu_memory_invalid_request', httpStatus: 400 });
    }
  });
});
