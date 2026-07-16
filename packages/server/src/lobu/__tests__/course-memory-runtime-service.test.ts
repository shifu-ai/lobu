import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { Context } from 'hono';
import { getDb } from '../../db/client.js';
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
} from '../../gateway/__tests__/helpers/db-setup.js';
import { retrieveCourseMemory } from '../../gateway/orchestration/course-memory-retriever.js';
import { insertEvent } from '../../utils/insert-event.js';
import { getConfiguredEmbeddingModel } from '../../utils/embeddings.js';
import { completeEmbeddings } from '../../worker-api/run-lifecycle.js';
import type { Env } from '../../index.js';
import { initWorkspaceProvider } from '../../workspace/index.js';
import {
  CourseMemoryRuntimeError,
  createCourseMemoryRuntimeService,
  type CourseMemoryApplyCommand,
} from '../course-memory-runtime-service.js';

const ORGANIZATION_ID = 'org-course-memory-v2';
const OWNER_USER_ID = 'owner-course-memory-v2';
const AGENT_ID = 'shifu-u-course-memory-v2';
const COURSE_ENTITY_ID = 'course:owner-course-memory-v2:ai-course';

function command(overrides: Partial<CourseMemoryApplyCommand> = {}): CourseMemoryApplyCommand {
  return {
    contract: { name: 'course_context_projection', schemaVersion: 2 },
    ownerUserId: OWNER_USER_ID,
    agentId: AGENT_ID,
    courseEntityId: COURSE_ENTITY_ID,
    courseRevision: 7,
    contextPackId: 'context-pack-7',
    contentDigest: `sha256:${'7'.repeat(64)}`,
    idempotencyKey: 'journey-7:memory',
    traceId: 'trace-course-memory-7',
    payload: {
      title: 'AI Course context',
      summary: 'A bounded summary',
      content: '# AI Course\n\nDurable context.',
      semanticType: 'course_pm_profile',
      metadata: { confidence: 'high', candidateCount: 30 },
    },
    ...overrides,
  };
}

function createTestService() {
  return createCourseMemoryRuntimeService({
    enqueueEmbeddingBackfill: async () => true,
  });
}

function mockEmbeddingsContext(
  body: unknown,
  workerVar: Record<string, unknown> = { workerAuthMode: 'trusted' }
): {
  ctx: Context<{ Bindings: Env }>;
  result: () => { body: unknown; status: number };
} {
  let captured: { body: unknown; status: number } = { body: undefined, status: 200 };
  const ctx = {
    req: { json: async () => body },
    json: (responseBody: unknown, status?: number) => {
      captured = { body: responseBody, status: status ?? 200 };
      return captured as unknown as Response;
    },
    var: workerVar,
  } as unknown as Context<{ Bindings: Env }>;
  return { ctx, result: () => captured };
}

async function createEmbeddingRun(
  eventId: number,
  claimedBy = 'trusted-embedding-worker'
): Promise<number> {
  await getDb()`
    UPDATE runs
    SET status = 'completed', completed_at = current_timestamp
    WHERE organization_id = ${ORGANIZATION_ID}
      AND run_type = 'embed_backfill'
      AND status IN ('pending', 'running')
  `;
  const rows = await getDb()`
    INSERT INTO runs (
      organization_id, run_type, status, claimed_by, approval_status, action_input, created_at
    )
    VALUES (
      ${ORGANIZATION_ID}, 'embed_backfill', 'running', ${claimedBy}, 'auto',
      ${getDb().json({ event_ids: [eventId] })}, current_timestamp
    )
    RETURNING id
  `;
  return Number(rows[0]!.id);
}

function embedding(): number[] {
  const value = new Array(768).fill(0);
  value[0] = 1;
  return value;
}

async function seedOwnerAndAgent() {
  const sql = getDb();
  await sql`
    INSERT INTO organization (id, name, slug)
    VALUES (${ORGANIZATION_ID}, ${ORGANIZATION_ID}, ${ORGANIZATION_ID})
  `;
  await sql`
    INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
    VALUES (${OWNER_USER_ID}, ${OWNER_USER_ID}, 'course-memory-owner@test.local', true, NOW(), NOW())
  `;
  await sql`
    INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt")
    VALUES ('member-course-memory-v2', ${ORGANIZATION_ID}, ${OWNER_USER_ID}, 'member', NOW())
  `;
  await sql`
    INSERT INTO agents (organization_id, id, name, owner_platform, owner_user_id)
    VALUES (${ORGANIZATION_ID}, ${AGENT_ID}, 'Course PM Personal Agent', 'toolbox', ${OWNER_USER_ID})
  `;
}

async function deleteAndRecreateAgent(ownerUserId = OWNER_USER_ID) {
  const sql = getDb();
  await sql`
    DELETE FROM agents
    WHERE organization_id = ${ORGANIZATION_ID} AND id = ${AGENT_ID}
  `;
  await sql`
    INSERT INTO agents (organization_id, id, name, owner_platform, owner_user_id)
    VALUES (${ORGANIZATION_ID}, ${AGENT_ID}, 'Recreated Course PM Agent', 'toolbox', ${ownerUserId})
  `;
}

describe('course memory runtime service', () => {
  beforeAll(async () => {
    await ensureDbForGatewayTests();
    await initWorkspaceProvider();
  });

  beforeEach(async () => {
    await resetTestDatabase();
    await seedOwnerAndAgent();
  });

  test('returns the same durable receipt and event for a same-key replay', async () => {
    const enqueueCalls: string[] = [];
    const committedRowsSeenByEnqueue: number[] = [];
    const service = createCourseMemoryRuntimeService({
      enqueueEmbeddingBackfill: async (organizationId) => {
        enqueueCalls.push(organizationId);
        const rows = await getDb()`
          SELECT r.id
          FROM course_memory_apply_receipts r
          JOIN course_memory_heads h ON h.receipt_id = r.id
          WHERE r.organization_id = ${organizationId}
        `;
        committedRowsSeenByEnqueue.push(rows.length);
        return true;
      },
    });

    const first = await service.apply({ organizationId: ORGANIZATION_ID, command: command() });
    const replay = await service.apply({ organizationId: ORGANIZATION_ID, command: command() });

    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      outcome: 'completed',
      ownerUserId: OWNER_USER_ID,
      agentId: AGENT_ID,
      courseEntityId: COURSE_ENTITY_ID,
      requestedCourseRevision: 7,
      acceptedCourseRevision: 7,
      appliedCourseRevision: 7,
      contentDigest: `sha256:${'7'.repeat(64)}`,
      memoryEventId: expect.any(Number),
      indexStatus: 'pending',
      receiptRef: expect.stringMatching(/^course-memory-receipt:/),
      observedAt: expect.any(String),
    });
    expect(enqueueCalls).toEqual([ORGANIZATION_ID]);
    expect(committedRowsSeenByEnqueue).toEqual([1]);
  });

  test('derives index status from idempotent append-only producer observations', async () => {
    const service = createTestService();
    const applied = await service.apply({ organizationId: ORGANIZATION_ID, command: command() });
    const identity = {
      organizationId: ORGANIZATION_ID,
      ownerUserId: OWNER_USER_ID,
      agentId: AGENT_ID,
      courseEntityId: COURSE_ENTITY_ID,
      requestedCourseRevision: 7,
      contentDigest: command().contentDigest,
      idempotencyKey: command().idempotencyKey,
      memoryEventId: applied.memoryEventId!,
    };

    const failedRunId = await createEmbeddingRun(applied.memoryEventId!);
    await Promise.all([
      service.recordIndexObservation({ ...identity, producerRunId: failedRunId, indexStatus: 'failed' }),
      service.recordIndexObservation({ ...identity, producerRunId: failedRunId, indexStatus: 'failed' }),
    ]);
    expect((await service.inspect({ ...identity }))?.indexStatus).toBe('failed');

    const readyRunId = await createEmbeddingRun(applied.memoryEventId!);
    await service.recordIndexObservation({ ...identity, producerRunId: readyRunId, indexStatus: 'ready' });
    await service.recordIndexObservation({ ...identity, producerRunId: failedRunId, indexStatus: 'failed' });
    expect((await service.inspect({ ...identity }))?.indexStatus).toBe('ready');

    const rows = await getDb()`
      SELECT producer_run_id, index_status
      FROM course_memory_index_observations
      ORDER BY observation_sequence
    `;
    expect(rows).toEqual([
      { producer_run_id: failedRunId, index_status: 'failed' },
      { producer_run_id: readyRunId, index_status: 'ready' },
    ]);
    expect(await getDb()`SELECT index_status FROM course_memory_apply_receipts`).toEqual([
      { index_status: 'pending' },
    ]);
  });

  test('makes ready terminal within one producer run under concurrent contradictory delivery', async () => {
    const service = createTestService();
    const applied = await service.apply({ organizationId: ORGANIZATION_ID, command: command() });
    const identity = {
      organizationId: ORGANIZATION_ID,
      ownerUserId: OWNER_USER_ID,
      agentId: AGENT_ID,
      courseEntityId: COURSE_ENTITY_ID,
      requestedCourseRevision: 7,
      contentDigest: command().contentDigest,
      idempotencyKey: command().idempotencyKey,
      memoryEventId: applied.memoryEventId!,
      producerRunId: await createEmbeddingRun(applied.memoryEventId!),
    };

    await service.recordIndexObservation({ ...identity, indexStatus: 'ready' });
    await Promise.all([
      service.recordIndexObservation({ ...identity, indexStatus: 'failed' }),
      service.recordIndexObservation({ ...identity, indexStatus: 'ready' }),
    ]);

    expect(await getDb()`
      SELECT index_status
      FROM course_memory_index_observations
      WHERE producer_run_id = ${identity.producerRunId}
      ORDER BY observation_sequence
    `).toEqual([{ index_status: 'ready' }]);
  });

  test('moves pending to ready only after the real embedding producer durably writes the event', async () => {
    const service = createTestService();
    const applied = await service.apply({ organizationId: ORGANIZATION_ID, command: command() });
    expect(applied.indexStatus).toBe('pending');
    const runId = await createEmbeddingRun(applied.memoryEventId!);

    const completion = mockEmbeddingsContext({
      run_id: runId,
      worker_id: 'trusted-embedding-worker',
      embeddings: [{
        event_id: applied.memoryEventId,
        embedding: embedding(),
        embedding_model: getConfiguredEmbeddingModel(),
      }],
    });
    await completeEmbeddings(completion.ctx);

    expect(completion.result()).toMatchObject({ body: { success: true, updated: 1 } });
    const inspected = await service.inspect({
      organizationId: ORGANIZATION_ID,
      ownerUserId: OWNER_USER_ID,
      agentId: AGENT_ID,
      courseEntityId: COURSE_ENTITY_ID,
      idempotencyKey: command().idempotencyKey,
    });
    expect(inspected).toMatchObject({
      receiptRef: applied.receiptRef,
      memoryEventId: applied.memoryEventId,
      contentDigest: applied.contentDigest,
      indexStatus: 'ready',
    });

    const transportFailureRunId = await createEmbeddingRun(applied.memoryEventId!);
    const transportFailure = mockEmbeddingsContext({
      run_id: transportFailureRunId,
      worker_id: 'trusted-embedding-worker',
      embeddings: [],
      error_message: 'response lost after durable embedding write',
    });
    await completeEmbeddings(transportFailure.ctx);
    expect((await service.inspect({
      organizationId: ORGANIZATION_ID,
      ownerUserId: OWNER_USER_ID,
      agentId: AGENT_ID,
      courseEntityId: COURSE_ENTITY_ID,
      idempotencyKey: command().idempotencyKey,
    }))?.indexStatus).toBe('ready');
  });

  test('treats an empty batch without a current embedding as failed, never ready', async () => {
    const service = createTestService();
    const applied = await service.apply({ organizationId: ORGANIZATION_ID, command: command() });
    const runId = await createEmbeddingRun(applied.memoryEventId!);
    const completion = mockEmbeddingsContext({
      run_id: runId,
      worker_id: 'trusted-embedding-worker',
      embeddings: [],
    });

    await completeEmbeddings(completion.ctx);

    expect(completion.result().status).toBe(400);
    expect((await service.inspect({
      organizationId: ORGANIZATION_ID,
      ownerUserId: OWNER_USER_ID,
      agentId: AGENT_ID,
      courseEntityId: COURSE_ENTITY_ID,
      idempotencyKey: command().idempotencyKey,
    }))?.indexStatus).toBe('failed');
  });

  test('does not accept an index observation from a worker outside the run scope', async () => {
    const service = createTestService();
    const applied = await service.apply({ organizationId: ORGANIZATION_ID, command: command() });
    const runId = await createEmbeddingRun(applied.memoryEventId!);
    const completion = mockEmbeddingsContext({
      run_id: runId,
      worker_id: 'unclaimed-worker',
      embeddings: [{
        event_id: applied.memoryEventId,
        embedding: embedding(),
        embedding_model: getConfiguredEmbeddingModel(),
      }],
    }, {
      workerAuthMode: 'user',
      workerUserId: 'other-user',
      workerOrgIds: [],
    });

    await completeEmbeddings(completion.ctx);

    expect(completion.result().status).toBe(403);
    expect((await service.inspect({
      organizationId: ORGANIZATION_ID,
      ownerUserId: OWNER_USER_ID,
      agentId: AGENT_ID,
      courseEntityId: COURSE_ENTITY_ID,
      idempotencyKey: command().idempotencyKey,
    }))?.indexStatus).toBe('pending');
  });

  test('does not let a trusted worker complete a run claimed by another worker', async () => {
    const service = createTestService();
    const applied = await service.apply({ organizationId: ORGANIZATION_ID, command: command() });
    const runId = await createEmbeddingRun(applied.memoryEventId!, 'worker-b');
    const completion = mockEmbeddingsContext({
      run_id: runId,
      worker_id: 'worker-a',
      embeddings: [{
        event_id: applied.memoryEventId,
        embedding: embedding(),
        embedding_model: getConfiguredEmbeddingModel(),
      }],
    });

    await completeEmbeddings(completion.ctx);

    expect(completion.result().body).toEqual({ success: false, reason: 'already_finalized' });
    expect(await getDb()`SELECT status, claimed_by FROM runs WHERE id = ${runId}`).toEqual([
      { status: 'running', claimed_by: 'worker-b' },
    ]);
    expect(await getDb()`SELECT 1 FROM event_embeddings WHERE event_id = ${applied.memoryEventId}`).toHaveLength(0);
    expect(await getDb()`SELECT 1 FROM course_memory_index_observations`).toHaveLength(0);
  });

  test('does not resurrect a finalized embedding run or append observations', async () => {
    const service = createTestService();
    const applied = await service.apply({ organizationId: ORGANIZATION_ID, command: command() });
    const runId = await createEmbeddingRun(applied.memoryEventId!, 'worker-a');
    await getDb()`
      UPDATE runs
      SET status = 'timeout', completed_at = current_timestamp, error_message = 'reaped'
      WHERE id = ${runId}
    `;
    const completion = mockEmbeddingsContext({
      run_id: runId,
      worker_id: 'late-worker',
      embeddings: [{
        event_id: applied.memoryEventId,
        embedding: embedding(),
        embedding_model: getConfiguredEmbeddingModel(),
      }],
    });

    await completeEmbeddings(completion.ctx);

    expect(completion.result().body).toEqual({ success: false, reason: 'already_finalized' });
    expect(await getDb()`SELECT 1 FROM event_embeddings WHERE event_id = ${applied.memoryEventId}`).toHaveLength(0);
    expect(await getDb()`SELECT 1 FROM course_memory_index_observations`).toHaveLength(0);
    expect(await getDb()`SELECT status, error_message FROM runs WHERE id = ${runId}`).toEqual([
      { status: 'timeout', error_message: 'reaped' },
    ]);
  });

  test('serializes concurrent conflicting embedding completions into one terminal verdict', async () => {
    const service = createTestService();
    const applied = await service.apply({ organizationId: ORGANIZATION_ID, command: command() });
    const runId = await createEmbeddingRun(applied.memoryEventId!, 'worker-a');
    const success = mockEmbeddingsContext({
      run_id: runId,
      worker_id: 'worker-a',
      embeddings: [{
        event_id: applied.memoryEventId,
        embedding: embedding(),
        embedding_model: getConfiguredEmbeddingModel(),
      }],
    });
    const failure = mockEmbeddingsContext({
      run_id: runId,
      worker_id: 'worker-a',
      embeddings: [],
      error_message: 'concurrent failure',
    });

    await Promise.all([completeEmbeddings(success.ctx), completeEmbeddings(failure.ctx)]);

    const results = [success.result().body, failure.result().body];
    expect(results).toContainEqual({ success: false, reason: 'already_finalized' });
    const run = await getDb()`SELECT status FROM runs WHERE id = ${runId}`;
    const observations = await getDb()`
      SELECT index_status
      FROM course_memory_index_observations
      WHERE producer_run_id = ${runId}
    `;
    expect(observations).toHaveLength(1);
    expect(observations[0]?.index_status).toBe(run[0]?.status === 'completed' ? 'ready' : 'failed');
  });

  test('does not replace a current embedding with a worker response from the wrong model', async () => {
    const service = createTestService();
    const applied = await service.apply({ organizationId: ORGANIZATION_ID, command: command() });
    const firstRunId = await createEmbeddingRun(applied.memoryEventId!);
    const first = mockEmbeddingsContext({
      run_id: firstRunId,
      worker_id: 'trusted-embedding-worker',
      embeddings: [{
        event_id: applied.memoryEventId,
        embedding: embedding(),
        embedding_model: getConfiguredEmbeddingModel(),
      }],
    });
    await completeEmbeddings(first.ctx);

    const wrongModelRunId = await createEmbeddingRun(applied.memoryEventId!);
    const wrongModel = mockEmbeddingsContext({
      run_id: wrongModelRunId,
      worker_id: 'trusted-embedding-worker',
      embeddings: [{
        event_id: applied.memoryEventId,
        embedding: embedding(),
        embedding_model: 'wrong-model',
      }],
    });
    await completeEmbeddings(wrongModel.ctx);

    expect(wrongModel.result().body).toEqual({ success: true, updated: 0 });
    expect(await getDb()`
      SELECT embedding_model
      FROM event_embeddings
      WHERE event_id = ${applied.memoryEventId}
    `).toEqual([{ embedding_model: getConfiguredEmbeddingModel() }]);
  });

  test('records producer failure and lets only a newer durable run supersede it with ready', async () => {
    const service = createTestService();
    const applied = await service.apply({ organizationId: ORGANIZATION_ID, command: command() });
    const failedRunId = await createEmbeddingRun(applied.memoryEventId!);
    const failure = mockEmbeddingsContext({
      run_id: failedRunId,
      worker_id: 'trusted-embedding-worker',
      embeddings: [],
      error_message: 'embedding service unavailable',
    });
    await completeEmbeddings(failure.ctx);
    expect((await service.inspect({
      organizationId: ORGANIZATION_ID,
      ownerUserId: OWNER_USER_ID,
      agentId: AGENT_ID,
      courseEntityId: COURSE_ENTITY_ID,
      idempotencyKey: command().idempotencyKey,
    }))?.indexStatus).toBe('failed');

    const readyRunId = await createEmbeddingRun(applied.memoryEventId!);
    const success = mockEmbeddingsContext({
      run_id: readyRunId,
      worker_id: 'trusted-embedding-worker',
      embeddings: [{
        event_id: applied.memoryEventId,
        embedding: embedding(),
        embedding_model: getConfiguredEmbeddingModel(),
      }],
    });
    await completeEmbeddings(success.ctx);
    await completeEmbeddings(failure.ctx);
    expect((await service.inspect({
      organizationId: ORGANIZATION_ID,
      ownerUserId: OWNER_USER_ID,
      agentId: AGENT_ID,
      courseEntityId: COURSE_ENTITY_ID,
      idempotencyKey: command().idempotencyKey,
    }))?.indexStatus).toBe('ready');
  });

  test('records a failed observation when an individual embedding write is rejected', async () => {
    const service = createTestService();
    const applied = await service.apply({ organizationId: ORGANIZATION_ID, command: command() });
    const runId = await createEmbeddingRun(applied.memoryEventId!);
    const completion = mockEmbeddingsContext({
      run_id: runId,
      worker_id: 'trusted-embedding-worker',
      embeddings: [{
        event_id: applied.memoryEventId,
        embedding: [1, 2],
        embedding_model: getConfiguredEmbeddingModel(),
      }],
    });

    await completeEmbeddings(completion.ctx);

    expect((await service.inspect({
      organizationId: ORGANIZATION_ID,
      ownerUserId: OWNER_USER_ID,
      agentId: AGENT_ID,
      courseEntityId: COURSE_ENTITY_ID,
      idempotencyKey: command().idempotencyKey,
    }))?.indexStatus).toBe('failed');
  });

  test('keeps ready when a newer run write fails but the current embedding remains durable', async () => {
    const service = createTestService();
    const applied = await service.apply({ organizationId: ORGANIZATION_ID, command: command() });
    const readyRunId = await createEmbeddingRun(applied.memoryEventId!);
    await completeEmbeddings(mockEmbeddingsContext({
      run_id: readyRunId,
      worker_id: 'trusted-embedding-worker',
      embeddings: [{
        event_id: applied.memoryEventId,
        embedding: embedding(),
        embedding_model: getConfiguredEmbeddingModel(),
      }],
    }).ctx);

    const failedRunId = await createEmbeddingRun(applied.memoryEventId!);
    const failedWrite = mockEmbeddingsContext({
      run_id: failedRunId,
      worker_id: 'trusted-embedding-worker',
      embeddings: [{
        event_id: applied.memoryEventId,
        embedding: [1, 2],
        embedding_model: getConfiguredEmbeddingModel(),
      }],
    });
    await completeEmbeddings(failedWrite.ctx);

    expect((await service.inspect({
      organizationId: ORGANIZATION_ID,
      ownerUserId: OWNER_USER_ID,
      agentId: AGENT_ID,
      courseEntityId: COURSE_ENTITY_ID,
      idempotencyKey: command().idempotencyKey,
    }))?.indexStatus).toBe('ready');
  });

  test('rejects an index observation whose immutable receipt identity does not match', async () => {
    const service = createTestService();
    const applied = await service.apply({ organizationId: ORGANIZATION_ID, command: command() });
    const exact = {
      organizationId: ORGANIZATION_ID,
      ownerUserId: OWNER_USER_ID,
      agentId: AGENT_ID,
      courseEntityId: COURSE_ENTITY_ID,
      requestedCourseRevision: 7,
      contentDigest: command().contentDigest,
      idempotencyKey: command().idempotencyKey,
      memoryEventId: applied.memoryEventId!,
      producerRunId: await createEmbeddingRun(applied.memoryEventId!),
      indexStatus: 'ready' as const,
    };

    for (const mismatch of [
      { ownerUserId: 'other-owner' },
      { agentId: 'shifu-u-other-agent' },
      { courseEntityId: 'course:other' },
      { contentDigest: `sha256:${'8'.repeat(64)}` as `sha256:${string}` },
    ]) {
      await expect(service.recordIndexObservation({ ...exact, ...mismatch }))
        .rejects.toMatchObject({ code: 'memory.index_observation_mismatch', status: 409 });
    }
    expect(await getDb()`SELECT 1 FROM course_memory_index_observations`).toHaveLength(0);
  });

  test('rejects observations from a nonexistent or non-authoritative producer run', async () => {
    const service = createTestService();
    const applied = await service.apply({ organizationId: ORGANIZATION_ID, command: command() });
    const exact = {
      organizationId: ORGANIZATION_ID,
      ownerUserId: OWNER_USER_ID,
      agentId: AGENT_ID,
      courseEntityId: COURSE_ENTITY_ID,
      requestedCourseRevision: 7,
      contentDigest: command().contentDigest,
      idempotencyKey: command().idempotencyKey,
      memoryEventId: applied.memoryEventId!,
      indexStatus: 'ready' as const,
    };
    const wrongEventRun = await createEmbeddingRun(applied.memoryEventId! + 999);
    const wrongTypeRows = await getDb()`
      INSERT INTO runs (organization_id, run_type, status, approval_status, action_input, created_at)
      VALUES (
        ${ORGANIZATION_ID}, 'action', 'running', 'auto',
        ${getDb().json({ event_ids: [applied.memoryEventId] })}, current_timestamp
      )
      RETURNING id
    `;
    await getDb()`
      INSERT INTO organization (id, name, slug)
      VALUES ('org-course-memory-other', 'Other org', 'org-course-memory-other')
    `;
    const crossOrgRows = await getDb()`
      INSERT INTO runs (organization_id, run_type, status, approval_status, action_input, created_at)
      VALUES (
        'org-course-memory-other', 'embed_backfill', 'running', 'auto',
        ${getDb().json({ event_ids: [applied.memoryEventId] })}, current_timestamp
      )
      RETURNING id
    `;

    for (const producerRunId of [
      Number.MAX_SAFE_INTEGER,
      wrongEventRun,
      Number(wrongTypeRows[0]!.id),
      Number(crossOrgRows[0]!.id),
    ]) {
      await expect(service.recordIndexObservation({ ...exact, producerRunId }))
        .rejects.toMatchObject({ code: 'memory.index_observation_mismatch', status: 409 });
    }
    expect(await getDb()`SELECT 1 FROM course_memory_index_observations`).toHaveLength(0);
  });

  test('rejects a same idempotency key with a different digest', async () => {
    const service = createTestService();
    await service.apply({ organizationId: ORGANIZATION_ID, command: command() });

    await expect(service.apply({
      organizationId: ORGANIZATION_ID,
      command: command({ contentDigest: `sha256:${'8'.repeat(64)}` }),
    })).rejects.toMatchObject({ code: 'memory.idempotency_conflict', status: 409 });
  });

  test.each([
    ['context pack', { contextPackId: 'context-pack-altered' }],
    ['title', { payload: { ...command().payload, title: 'Altered title' } }],
    ['summary', { payload: { ...command().payload, summary: 'Altered summary' } }],
    ['content', { payload: { ...command().payload, content: 'Altered content' } }],
    ['semantic type', { payload: { ...command().payload, semanticType: 'altered_type' } }],
    ['custom metadata', {
      payload: { ...command().payload, metadata: { confidence: 'low', candidateCount: 30 } },
    }],
  ])('rejects a same-key replay with altered %s despite the same caller digest', async (_field, overrides) => {
    const service = createTestService();
    await service.apply({ organizationId: ORGANIZATION_ID, command: command() });

    await expect(service.apply({
      organizationId: ORGANIZATION_ID,
      command: command(overrides as Partial<CourseMemoryApplyCommand>),
    })).rejects.toMatchObject({ code: 'memory.idempotency_conflict', status: 409 });
  });

  test('treats reordered custom metadata keys as the same canonical projection', async () => {
    const service = createTestService();
    const first = await service.apply({
      organizationId: ORGANIZATION_ID,
      command: command({
        payload: { ...command().payload, metadata: { alpha: 1, omega: 2 } },
      }),
    });
    const replay = await service.apply({
      organizationId: ORGANIZATION_ID,
      command: command({
        payload: { ...command().payload, metadata: { omega: 2, alpha: 1 } },
      }),
    });

    expect(replay).toEqual(first);
  });

  test('rejects stale revision and same revision with a different digest', async () => {
    const service = createTestService();
    await service.apply({ organizationId: ORGANIZATION_ID, command: command() });

    await expect(service.apply({
      organizationId: ORGANIZATION_ID,
      command: command({
        courseRevision: 6,
        idempotencyKey: 'journey-6:memory',
        contentDigest: `sha256:${'6'.repeat(64)}`,
      }),
    })).rejects.toMatchObject({ code: 'memory.stale_revision', status: 409 });
    await expect(service.inspect({
      organizationId: ORGANIZATION_ID,
      ownerUserId: OWNER_USER_ID,
      agentId: AGENT_ID,
      courseEntityId: COURSE_ENTITY_ID,
      idempotencyKey: 'journey-6:memory',
    })).resolves.toMatchObject({
      outcome: 'rejected',
      requestedCourseRevision: 6,
      acceptedCourseRevision: 7,
      appliedCourseRevision: 7,
      memoryEventId: null,
    });

    await expect(service.apply({
      organizationId: ORGANIZATION_ID,
      command: command({
        idempotencyKey: 'journey-7:other-memory',
        contentDigest: `sha256:${'9'.repeat(64)}`,
      }),
    })).rejects.toMatchObject({ code: 'memory.revision_conflict', status: 409 });
  });

  test('recovers historical revision and supersession after deterministic agent recreation', async () => {
    const service = createTestService();
    const revision7 = await service.apply({ organizationId: ORGANIZATION_ID, command: command() });
    await deleteAndRecreateAgent();

    await expect(service.inspectByIdempotencyKey({
      organizationId: ORGANIZATION_ID,
      courseEntityId: COURSE_ENTITY_ID,
      idempotencyKey: command().idempotencyKey,
    })).resolves.toBeNull();
    await expect(service.apply({
      organizationId: ORGANIZATION_ID,
      command: command({
        courseRevision: 6,
        contextPackId: 'context-pack-6-after-recreate',
        contentDigest: `sha256:${'6'.repeat(64)}`,
        idempotencyKey: 'journey-6-after-recreate:memory',
      }),
    })).rejects.toMatchObject({ code: 'memory.stale_revision', status: 409 });

    const revision8 = await service.apply({
      organizationId: ORGANIZATION_ID,
      command: command({
        courseRevision: 8,
        contextPackId: 'context-pack-8-after-recreate',
        contentDigest: `sha256:${'8'.repeat(64)}`,
        idempotencyKey: 'journey-8-after-recreate:memory',
      }),
    });
    const current = await getDb()`
      SELECT id, supersedes_event_id
      FROM current_event_records
      WHERE organization_id = ${ORGANIZATION_ID}
        AND metadata->>'owner_user_id' = ${OWNER_USER_ID}
        AND metadata->>'agent_id' = ${AGENT_ID}
        AND metadata->>'course_entity_id' = ${COURSE_ENTITY_ID}
    `;

    expect(current).toEqual([{
      id: revision8.memoryEventId,
      supersedes_event_id: revision7.memoryEventId,
    }]);
    await expect(service.inspectByIdempotencyKey({
      organizationId: ORGANIZATION_ID,
      courseEntityId: COURSE_ENTITY_ID,
      idempotencyKey: command().idempotencyKey,
    })).resolves.toEqual(revision7);
    await expect(service.inspectByIdempotencyKey({
      organizationId: ORGANIZATION_ID,
      courseEntityId: COURSE_ENTITY_ID,
      idempotencyKey: 'journey-8-after-recreate:memory',
    })).resolves.toEqual(revision8);
  });

  test('restores the live head on exact same-key retry after deterministic agent recreation', async () => {
    const enqueueCalls: string[] = [];
    const service = createCourseMemoryRuntimeService({
      enqueueEmbeddingBackfill: async (organizationId) => {
        enqueueCalls.push(organizationId);
        return true;
      },
    });
    const revision7 = await service.apply({ organizationId: ORGANIZATION_ID, command: command() });
    await deleteAndRecreateAgent();

    const replay = await service.apply({ organizationId: ORGANIZATION_ID, command: command() });
    const sql = getDb();
    const heads = await sql`
      SELECT applied_revision, memory_event_id, receipt_id
      FROM course_memory_heads
      WHERE organization_id = ${ORGANIZATION_ID}
        AND owner_user_id = ${OWNER_USER_ID}
        AND agent_id = ${AGENT_ID}
        AND course_entity_id = ${COURSE_ENTITY_ID}
    `;
    const receipts = await sql`SELECT id FROM course_memory_apply_receipts`;
    const current = await sql`
      SELECT id
      FROM current_event_records
      WHERE organization_id = ${ORGANIZATION_ID}
        AND metadata->>'course_entity_id' = ${COURSE_ENTITY_ID}
    `;

    expect(replay).toEqual(revision7);
    expect(heads).toEqual([{
      applied_revision: 7,
      memory_event_id: revision7.memoryEventId,
      receipt_id: revision7.receiptRef.replace('course-memory-receipt:', ''),
    }]);
    expect(receipts).toHaveLength(1);
    expect(current).toEqual([{ id: revision7.memoryEventId }]);
    expect(enqueueCalls).toEqual([ORGANIZATION_ID]);
  });

  test('converges concurrent same-key retries on one restored head without side effects', async () => {
    const enqueueCalls: string[] = [];
    const dependencies = {
      enqueueEmbeddingBackfill: async (organizationId: string) => {
        enqueueCalls.push(organizationId);
        return true;
      },
    };
    const first = createCourseMemoryRuntimeService(dependencies);
    const revision7 = await first.apply({ organizationId: ORGANIZATION_ID, command: command() });
    await deleteAndRecreateAgent();
    const replicas = [
      createCourseMemoryRuntimeService(dependencies),
      createCourseMemoryRuntimeService(dependencies),
      createCourseMemoryRuntimeService(dependencies),
    ];

    const replays = await Promise.all(replicas.map((service) =>
      service.apply({ organizationId: ORGANIZATION_ID, command: command() })
    ));
    const sql = getDb();

    expect(replays).toEqual([revision7, revision7, revision7]);
    expect(await sql`SELECT receipt_id FROM course_memory_heads`).toHaveLength(1);
    expect(await sql`SELECT id FROM course_memory_apply_receipts`).toHaveLength(1);
    expect(await sql`
      SELECT id FROM current_event_records
      WHERE organization_id = ${ORGANIZATION_ID}
        AND metadata->>'course_entity_id' = ${COURSE_ENTITY_ID}
    `).toEqual([{ id: revision7.memoryEventId }]);
    expect(enqueueCalls).toEqual([ORGANIZATION_ID]);
  });

  test('never restores historical state into a recreated agent owned by someone else', async () => {
    const service = createTestService();
    await service.apply({ organizationId: ORGANIZATION_ID, command: command() });
    await deleteAndRecreateAgent('different-owner');

    await expect(service.apply({ organizationId: ORGANIZATION_ID, command: command() }))
      .rejects.toMatchObject({ code: 'memory.owner_agent_mismatch', status: 403 });
    expect(await getDb()`SELECT receipt_id FROM course_memory_heads`).toHaveLength(0);
    expect(await getDb()`SELECT id FROM course_memory_apply_receipts`).toHaveLength(1);
  });

  test('serializes stale and newer applies across replicas after deterministic agent recreation', async () => {
    const service = createTestService();
    const revision7 = await service.apply({ organizationId: ORGANIZATION_ID, command: command() });
    await deleteAndRecreateAgent();
    const replicas = [createTestService(), createTestService(), createTestService()] as const;
    const newer = command({
      courseRevision: 8,
      contextPackId: 'context-pack-8-concurrent-recreate',
      contentDigest: `sha256:${'8'.repeat(64)}`,
      idempotencyKey: 'journey-8-concurrent-recreate:memory',
    });
    const stale = command({
      courseRevision: 6,
      contextPackId: 'context-pack-6-concurrent-recreate',
      contentDigest: `sha256:${'6'.repeat(64)}`,
      idempotencyKey: 'journey-6-concurrent-recreate:memory',
    });

    const results = await Promise.allSettled([
      replicas[0].apply({ organizationId: ORGANIZATION_ID, command: stale }),
      ...replicas.map((replica) => replica.apply({ organizationId: ORGANIZATION_ID, command: newer })),
    ]);
    const completed = results.filter((result) => result.status === 'fulfilled')
      .map((result) => result.value);
    const rejected = results.filter((result) => result.status === 'rejected')
      .map((result) => result.reason);

    expect(completed).toHaveLength(3);
    expect(new Set(completed.map((receipt) => receipt.memoryEventId)).size).toBe(1);
    expect(rejected).toEqual([expect.objectContaining({ code: 'memory.stale_revision' })]);
    const events = await getDb()`
      SELECT id, supersedes_event_id
      FROM current_event_records
      WHERE organization_id = ${ORGANIZATION_ID}
        AND metadata->>'course_entity_id' = ${COURSE_ENTITY_ID}
    `;
    expect(events).toEqual([{
      id: completed[0]?.memoryEventId,
      supersedes_event_id: revision7.memoryEventId,
    }]);
  });

  test('readback recovers a completed apply after its HTTP response is lost', async () => {
    const service = createTestService();
    const applied = await service.apply({ organizationId: ORGANIZATION_ID, command: command() });

    const inspected = await service.inspect({
      organizationId: ORGANIZATION_ID,
      ownerUserId: OWNER_USER_ID,
      agentId: AGENT_ID,
      courseEntityId: COURSE_ENTITY_ID,
      idempotencyKey: command().idempotencyKey,
    });

    expect(inspected).toEqual(applied);
  });

  test.each([
    ['owner', { ownerUserId: 'wrong-owner' }],
    ['agent', { agentId: 'shifu-u-wrong-agent' }],
    ['course', { courseEntityId: 'course:wrong' }],
  ])('fails closed on %s mismatch during inspect', async (_field, overrides) => {
    const service = createTestService();
    await service.apply({ organizationId: ORGANIZATION_ID, command: command() });

    await expect(service.inspect({
      organizationId: ORGANIZATION_ID,
      ownerUserId: OWNER_USER_ID,
      agentId: AGENT_ID,
      courseEntityId: COURSE_ENTITY_ID,
      idempotencyKey: command().idempotencyKey,
      ...overrides,
    })).resolves.toBeNull();
  });

  test('serializes three replica instances into one event and one receipt', async () => {
    const replicas = [
      createTestService(),
      createTestService(),
      createTestService(),
    ];
    const receipts = await Promise.all(replicas.map((service) =>
      service.apply({ organizationId: ORGANIZATION_ID, command: command() })
    ));

    expect(new Set(receipts.map((receipt) => receipt.receiptRef)).size).toBe(1);
    expect(new Set(receipts.map((receipt) => receipt.memoryEventId)).size).toBe(1);
    const sql = getDb();
    const receiptRows = await sql`SELECT id FROM course_memory_apply_receipts`;
    const eventRows = await sql`
      SELECT id, entity_ids, supersedes_event_id
      FROM events
      WHERE metadata->>'course_entity_id' = ${COURSE_ENTITY_ID}
    `;
    expect(receiptRows).toHaveLength(1);
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0]?.entity_ids).toBeNull();
  });

  test('derives supersession from the locked head and never uses a string course id as bigint entity ids', async () => {
    const service = createTestService();
    const first = await service.apply({ organizationId: ORGANIZATION_ID, command: command() });
    const second = await service.apply({
      organizationId: ORGANIZATION_ID,
      command: command({
        courseRevision: 8,
        contextPackId: 'context-pack-8',
        contentDigest: `sha256:${'8'.repeat(64)}`,
        idempotencyKey: 'journey-8:memory',
      }),
    });
    await expect(service.apply({ organizationId: ORGANIZATION_ID, command: command() }))
      .resolves.toEqual(first);

    const sql = getDb();
    const rows = await sql`
      SELECT id, entity_ids, supersedes_event_id, metadata
      FROM events
      WHERE id IN (${first.memoryEventId}, ${second.memoryEventId})
      ORDER BY id
    `;
    expect(rows).toHaveLength(2);
    expect(rows[0]?.entity_ids).toBeNull();
    expect(rows[1]?.entity_ids).toBeNull();
    expect(rows[1]?.supersedes_event_id).toBe(first.memoryEventId);
    expect(rows[1]?.metadata).toMatchObject({
      owner_user_id: OWNER_USER_ID,
      agent_id: AGENT_ID,
      course_entity_id: COURSE_ENTITY_ID,
      course_entity_ids: [COURSE_ENTITY_ID],
      course_revision: 8,
      supersedes_event_id: first.memoryEventId,
    });
  });

  test('makes a freshly applied v2 event retrievable only for its exact course', async () => {
    const service = createTestService();
    const applied = await service.apply({ organizationId: ORGANIZATION_ID, command: command() });
    const search = async (input: { entityIds: string[] }) => {
      const [courseEntityId] = input.entityIds;
      return getDb()`
        SELECT id, payload_text, title, source_url, organization_id, metadata,
               connection_id, connector_key, origin_id, origin_type, semantic_type
        FROM current_event_records
        WHERE id = ${applied.memoryEventId}
          AND jsonb_typeof(metadata->'course_entity_ids') = 'array'
          AND jsonb_array_length(metadata->'course_entity_ids') = 1
          AND metadata->'course_entity_ids'->>0 = ${courseEntityId}
      `;
    };

    const exact = await retrieveCourseMemory({
      organizationId: ORGANIZATION_ID,
      ownerUserId: OWNER_USER_ID,
      agentId: AGENT_ID,
      courseEntityId: COURSE_ENTITY_ID,
      task: 'AI Course',
    }, { search });
    const other = await retrieveCourseMemory({
      organizationId: ORGANIZATION_ID,
      ownerUserId: OWNER_USER_ID,
      agentId: AGENT_ID,
      courseEntityId: 'course:owner-course-memory-v2:other',
      task: 'AI Course',
    }, { search });

    expect(exact).toMatchObject({ status: 'loaded', eventIds: [applied.memoryEventId] });
    expect(other).toMatchObject({ status: 'empty', eventIds: [] });
  });

  test('rejects an agent that is not owned by the requested owner', async () => {
    const service = createTestService();
    await expect(service.apply({
      organizationId: ORGANIZATION_ID,
      command: command({ ownerUserId: 'wrong-owner' }),
    })).rejects.toBeInstanceOf(CourseMemoryRuntimeError);
    await expect(service.apply({
      organizationId: ORGANIZATION_ID,
      command: command({ ownerUserId: 'wrong-owner', idempotencyKey: 'second-attempt' }),
    })).rejects.toMatchObject({ code: 'memory.owner_agent_mismatch', status: 403 });
  });

  test.each([
    ['courseEntityId', 'course:caller-override'],
    ['course_entity_id', 'course:caller-override'],
    ['courseEntityIds', ['course:caller-override']],
    ['course_entity_ids', ['course:caller-override']],
    ['requestFingerprint', `sha256:${'a'.repeat(64)}`],
    ['request_fingerprint', `sha256:${'a'.repeat(64)}`],
  ])('rejects reserved metadata key %s even when the service is called without HTTP', async (key, value) => {
    const service = createTestService();
    await expect(service.apply({
      organizationId: ORGANIZATION_ID,
      command: command({
        payload: {
          ...command().payload,
          metadata: { [key]: value },
        },
      }),
    })).rejects.toMatchObject({ code: 'memory.reserved_metadata_override', status: 400 });
  });

  test('fails completed receipt readback when exact course metadata was not durably stored', async () => {
    const service = createCourseMemoryRuntimeService({
      enqueueEmbeddingBackfill: async () => true,
      insertEventImpl: async (input, options) => {
        const metadata = { ...input.metadata };
        delete metadata.course_entity_ids;
        return insertEvent({ ...input, metadata }, options);
      },
    });

    await expect(service.apply({ organizationId: ORGANIZATION_ID, command: command() }))
      .rejects.toThrow('Course memory completed receipt failed exact durable readback');
  });

  test.each([
    ['content', (input: Parameters<typeof insertEvent>[0]) => ({
      ...input,
      content: `${input.content}\nTAMPERED`,
    })],
    ['custom metadata', (input: Parameters<typeof insertEvent>[0]) => ({
      ...input,
      metadata: { ...input.metadata, confidence: 'tampered' },
    })],
  ])('fails completed receipt readback when persisted %s differs from the accepted projection', async (_field, alter) => {
    const service = createCourseMemoryRuntimeService({
      enqueueEmbeddingBackfill: async () => true,
      insertEventImpl: async (input, options) => insertEvent(alter(input), options),
    });

    await expect(service.apply({ organizationId: ORGANIZATION_ID, command: command() }))
      .rejects.toThrow('Course memory completed receipt failed exact durable readback');
  });
});
