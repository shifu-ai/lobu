import type { DbClient } from '../db/client';
import { getConfiguredEmbeddingModel, isValidEmbedding } from '../utils/embeddings';

export interface CourseMemoryEmbeddingInput {
  eventId: number;
  embedding: number[];
  embeddingModel: string;
}

export type CourseMemoryEmbeddingRunResult =
  | { kind: 'already_finalized' }
  | { kind: 'completed'; success: boolean; updated: number; error?: string };

export interface CompleteCourseMemoryEmbeddingRunInput {
  sql: DbClient;
  runId: number;
  workerId: string;
  requireClaimedWorker: boolean;
  embeddings: CourseMemoryEmbeddingInput[];
  errorMessage?: string;
}

interface LockedRunRow {
  organization_id: string;
  status: string;
  claimed_by: string | null;
  action_input: Record<string, unknown> | string | null;
}

function parseEventIds(actionInput: LockedRunRow['action_input']): number[] {
  const parsed = typeof actionInput === 'string'
    ? JSON.parse(actionInput) as Record<string, unknown>
    : actionInput;
  if (!Array.isArray(parsed?.event_ids)) return [];
  return Array.from(new Set(parsed.event_ids
    .filter((value): value is number => Number.isSafeInteger(value) && value > 0)))
    .sort((left, right) => left - right);
}

/**
 * Trusted embed_backfill completion boundary.
 *
 * One run-row lock serializes duplicate workers and the stale-run reaper. The
 * vector write, current-model proof read, append-only observations, and guarded
 * terminal transition commit together, so no replica can expose a split state.
 * Query count is fixed for a batch: lock, bulk upsert, proof read, observation
 * append, terminal CAS.
 */
export async function completeCourseMemoryEmbeddingRun(
  input: CompleteCourseMemoryEmbeddingRunInput
): Promise<CourseMemoryEmbeddingRunResult> {
  return input.sql.begin(async (tx) => {
    const runRows = await tx<LockedRunRow>`
      SELECT organization_id, status, claimed_by, action_input
      FROM runs
      WHERE id = ${input.runId} AND run_type = 'embed_backfill'
      FOR UPDATE
    `;
    const run = runRows[0];
    if (!run || run.status !== 'running'
      || (input.requireClaimedWorker && run.claimed_by !== input.workerId)) {
      return { kind: 'already_finalized' };
    }

    const eventIds = parseEventIds(run.action_input);
    const eventIdSet = new Set(eventIds);
    const currentModel = getConfiguredEmbeddingModel();
    const submittedByEventId = new Map<number, CourseMemoryEmbeddingInput>();
    for (const item of input.embeddings) {
      if (eventIdSet.has(item.eventId) && isValidEmbedding(item.embedding)) {
        submittedByEventId.set(item.eventId, item);
      }
    }
    const validEmbeddings = [...submittedByEventId.values()]
      .sort((left, right) => left.eventId - right.eventId)
      .map((item) => ({
        event_id: item.eventId,
        embedding: `[${item.embedding.join(',')}]`,
        embedding_model: item.embeddingModel,
      }));

    let updated = 0;
    if (validEmbeddings.length > 0) {
      const result = await tx`
        WITH input AS (
           SELECT event_id, embedding, embedding_model
           FROM jsonb_to_recordset(${tx.json(validEmbeddings)}::jsonb)
             AS item(event_id bigint, embedding text, embedding_model text)
        )
        INSERT INTO event_embeddings (event_id, embedding, embedding_model)
        SELECT event_id, embedding::vector, embedding_model
        FROM input
        ON CONFLICT (event_id) DO UPDATE
          SET embedding = EXCLUDED.embedding,
              embedding_model = EXCLUDED.embedding_model,
              created_at = now()
          WHERE event_embeddings.embedding_model IS DISTINCT FROM EXCLUDED.embedding_model
      `;
      updated = result.count;
    }

    const currentRows = eventIds.length === 0
      ? []
      : await tx<{ event_id: number | string }>`
        SELECT event_id
        FROM event_embeddings
        WHERE embedding_model = ${currentModel}
          AND event_id IN (
            SELECT value::bigint
            FROM jsonb_array_elements_text(${tx.json(eventIds)}::jsonb)
          )
      `;
    const currentEventIds = new Set(currentRows.map((row) => Number(row.event_id)));
    const observations = eventIds.map((eventId) => ({
      event_id: eventId,
      index_status: currentEventIds.has(eventId) ? 'ready' : 'failed',
    }));

    if (observations.length > 0) {
      await tx`
        WITH input AS (
           SELECT event_id, index_status
           FROM jsonb_to_recordset(${tx.json(observations)}::jsonb)
             AS item(event_id bigint, index_status text)
        )
        INSERT INTO course_memory_index_observations (
          organization_id, receipt_id, owner_user_id, agent_id, course_entity_id,
          requested_revision, content_digest, idempotency_key, memory_event_id,
          index_status, producer_run_id
        )
        SELECT receipt.organization_id, receipt.id, receipt.owner_user_id,
               receipt.agent_id, receipt.course_entity_id, receipt.requested_revision,
               receipt.content_digest, receipt.idempotency_key, receipt.memory_event_id,
               input.index_status, ${input.runId}
        FROM input
        JOIN course_memory_apply_receipts receipt
          ON receipt.organization_id = ${run.organization_id}
         AND receipt.memory_event_id = input.event_id
         AND receipt.outcome = 'completed'
        WHERE input.index_status = 'ready'
           OR NOT EXISTS (
             SELECT 1
             FROM course_memory_index_observations existing
             WHERE existing.receipt_id = receipt.id
               AND existing.producer_run_id = ${input.runId}
               AND existing.memory_event_id = input.event_id
               AND existing.index_status = 'ready'
           )
        ON CONFLICT (organization_id, producer_run_id, memory_event_id, index_status)
        DO NOTHING
      `;
    }

    const missingEmbedding = observations.some(({ index_status }) => index_status === 'failed');
    const success = !input.errorMessage && !missingEmbedding;
    const error = input.errorMessage
      ?? (missingEmbedding ? 'One or more embeddings failed durable persistence' : undefined);
    const updatedRuns = await tx`
      UPDATE runs
      SET status = ${success ? 'completed' : 'failed'},
          completed_at = current_timestamp,
          items_collected = ${updated},
          error_message = ${error ?? null}
      WHERE id = ${input.runId}
        AND status = 'running'
        AND (${!input.requireClaimedWorker} OR claimed_by = ${input.workerId})
      RETURNING id
    `;
    if (updatedRuns.length === 0) {
      throw new Error('Embedding run lost terminal compare-and-set while row locked');
    }
    return { kind: 'completed', success, updated, ...(error ? { error } : {}) };
  });
}
