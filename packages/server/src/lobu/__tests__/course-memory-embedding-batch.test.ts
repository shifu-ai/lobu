import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { getDb, type DbClient } from '../../db/client.js';
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
} from '../../gateway/__tests__/helpers/db-setup.js';
import { getConfiguredEmbeddingModel } from '../../utils/embeddings.js';
import { insertEvent } from '../../utils/insert-event.js';
import { initWorkspaceProvider } from '../../workspace/index.js';
import { createCourseMemoryRuntimeService } from '../course-memory-runtime-service.js';
import { completeCourseMemoryEmbeddingRun } from '../course-memory-index-producer.js';

const ORGANIZATION_ID = 'org-course-memory-batch';
const OWNER_USER_ID = 'owner-course-memory-batch';
const AGENT_ID = 'shifu-u-course-memory-batch';
const COURSE_ENTITY_ID = 'course:owner-course-memory-batch:primary';

function countQueries(base: DbClient): { sql: DbClient; count: () => number } {
  let queries = 0;
  const wrap = (target: DbClient): DbClient => new Proxy(target, {
    apply(callable, thisArg, args) {
      queries++;
      return Reflect.apply(callable, thisArg, args);
    },
    get(callable, property) {
      if (property === 'unsafe') {
        return (...args: unknown[]) => {
          queries++;
          return Reflect.apply(callable.unsafe, callable, args);
        };
      }
      if (property === 'begin') {
        return (callback: (tx: DbClient) => unknown) => callable.begin(
          (tx) => callback(wrap(tx as DbClient))
        );
      }
      const value = Reflect.get(callable, property, callable);
      return typeof value === 'function' ? value.bind(callable) : value;
    },
  }) as DbClient;
  return { sql: wrap(base), count: () => queries };
}

function embedding(axis: number): number[] {
  const value = new Array(768).fill(0);
  value[axis % 768] = 1;
  return value;
}

async function seedIdentity() {
  const sql = getDb();
  await sql`INSERT INTO organization (id, name, slug) VALUES (${ORGANIZATION_ID}, 'Batch', ${ORGANIZATION_ID})`;
  await sql`
    INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
    VALUES (${OWNER_USER_ID}, 'Batch owner', 'batch-owner@test.local', true, NOW(), NOW())
  `;
  await sql`
    INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt")
    VALUES ('member-course-memory-batch', ${ORGANIZATION_ID}, ${OWNER_USER_ID}, 'member', NOW())
  `;
  await sql`
    INSERT INTO agents (organization_id, id, name, owner_platform, owner_user_id)
    VALUES (${ORGANIZATION_ID}, ${AGENT_ID}, 'Batch agent', 'toolbox', ${OWNER_USER_ID})
  `;
}

describe('course memory embedding batch producer', () => {
  beforeAll(async () => {
    await ensureDbForGatewayTests();
    await initWorkspaceProvider();
  });

  beforeEach(async () => {
    await resetTestDatabase();
    await seedIdentity();
  });

  test('completes 100 events with a fixed small query budget and observes only course receipts', async () => {
    const service = createCourseMemoryRuntimeService({ enqueueEmbeddingBackfill: async () => true });
    const course = await service.apply({
      organizationId: ORGANIZATION_ID,
      command: {
        contract: { name: 'course_context_projection', schemaVersion: 2 },
        ownerUserId: OWNER_USER_ID,
        agentId: AGENT_ID,
        courseEntityId: COURSE_ENTITY_ID,
        courseRevision: 1,
        contextPackId: 'batch-pack',
        contentDigest: `sha256:${'a'.repeat(64)}`,
        idempotencyKey: 'batch-memory',
        traceId: 'batch-trace',
        payload: {
          title: 'Course batch memory',
          summary: 'Course receipt event',
          content: 'Course receipt event content',
          semanticType: 'course_pm_profile',
          metadata: {},
        },
      },
    });
    const eventIds = [course.memoryEventId!];
    for (let index = 1; index < 100; index++) {
      const event = await insertEvent({
        entityIds: [],
        organizationId: ORGANIZATION_ID,
        originId: `generic-batch-${index}`,
        title: `Generic ${index}`,
        content: `Generic event ${index}`,
        semanticType: 'content',
        originType: 'test',
      });
      eventIds.push(Number(event.id));
    }
    const runRows = await getDb()`
      INSERT INTO runs (
        organization_id, run_type, status, claimed_by, approval_status, action_input, created_at
      ) VALUES (
        ${ORGANIZATION_ID}, 'embed_backfill', 'running', 'batch-worker', 'auto',
        ${getDb().json({ event_ids: eventIds })}, current_timestamp
      )
      RETURNING id
    `;
    const runId = Number(runRows[0]!.id);
    const counted = countQueries(getDb());

    const result = await completeCourseMemoryEmbeddingRun({
      sql: counted.sql,
      runId,
      workerId: 'batch-worker',
      requireClaimedWorker: true,
      embeddings: [
        ...eventIds.map((eventId, index) => ({
          eventId,
          embedding: embedding(index),
          embeddingModel: getConfiguredEmbeddingModel(),
        })),
        {
          eventId: eventIds[0]!,
          embedding: embedding(0),
          embeddingModel: getConfiguredEmbeddingModel(),
        },
      ],
    });

    expect(result).toEqual({ kind: 'completed', success: true, updated: 100 });
    expect(counted.count()).toBe(5);
    expect(await getDb()`
      SELECT 1
      FROM event_embeddings
      WHERE event_id IN (
        SELECT value::bigint
        FROM jsonb_array_elements_text(${getDb().json(eventIds)}::jsonb)
      )
    `).toHaveLength(100);
    expect(await getDb()`SELECT memory_event_id FROM course_memory_index_observations`).toEqual([
      { memory_event_id: course.memoryEventId },
    ]);
  });
});
