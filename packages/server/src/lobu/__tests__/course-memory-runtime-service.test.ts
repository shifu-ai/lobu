import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { getDb } from '../../db/client.js';
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
} from '../../gateway/__tests__/helpers/db-setup.js';
import { retrieveCourseMemory } from '../../gateway/orchestration/course-memory-retriever.js';
import { insertEvent } from '../../utils/insert-event.js';
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

  test('rejects a same idempotency key with a different digest', async () => {
    const service = createTestService();
    await service.apply({ organizationId: ORGANIZATION_ID, command: command() });

    await expect(service.apply({
      organizationId: ORGANIZATION_ID,
      command: command({ contentDigest: `sha256:${'8'.repeat(64)}` }),
    })).rejects.toMatchObject({ code: 'memory.idempotency_conflict', status: 409 });
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
});
