/**
 * Scheduled Job: Trigger Embedding Backfill
 *
 * Runs periodically to check for events missing embeddings.
 * Creates a single 'embed_backfill' run per organization batch.
 * The worker claims the run, generates embeddings, and updates the events.
 */

import { getDb } from '../db/client';
import { configuredEmbeddingModelSqlLiteral } from '../utils/embeddings';
import type { Env } from '../index';
import logger from '../utils/logger';
import { isUniqueViolation } from '../utils/pg-errors';
import { ACTIVE_RUN_STATUSES, runStatusLiteral } from '../utils/run-statuses';
import { materializeDueItems } from './due-materializer';

const BATCH_LIMIT = 100;

interface BackfillResult {
  organizations: number;
  runsCreated: number;
  totalEvents: number;
}

interface OrgBatch {
  organization_id: string;
  event_count: number;
}

// A row needs (re)embedding when it has no embedding at all, OR its stamp is
// not the configured model — including a NULL stamp (legacy row whose true
// model is unknown, written before stamping). Search excludes those NULL/stale
// rows from vector comparison, so the backfill must restamp them to make them
// searchable again. `IS DISTINCT FROM` makes NULL count as different from the
// (non-NULL) configured model. The model is server config, inlined as a
// validated literal.
function needsEmbeddingPredicate(): string {
  const model = configuredEmbeddingModelSqlLiteral();
  return `(emb.event_id IS NULL OR emb.embedding_model IS DISTINCT FROM ${model})`;
}

export async function triggerEmbedBackfill(_env: Env): Promise<BackfillResult> {
  const sql = getDb();
  const needsEmbedding = needsEmbeddingPredicate();

  try {
    let totalEvents = 0;

    const counts = await materializeDueItems<OrgBatch>({
      label: 'EmbedBackfill',
      // Find organizations with events missing/stale embeddings, grouped for batch runs
      fetchDue: () => sql<OrgBatch>`
        SELECT ev.organization_id, COUNT(*)::int AS event_count
        FROM current_event_records ev
        LEFT JOIN event_embeddings emb ON emb.event_id = ev.id
        WHERE ${sql.unsafe(needsEmbedding)}
          AND ev.payload_text IS NOT NULL
          AND ev.payload_text != ''
          AND ev.organization_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM runs r
            WHERE r.organization_id = ev.organization_id
              AND r.run_type = 'embed_backfill'
              AND r.status = ANY(${runStatusLiteral(ACTIVE_RUN_STATUSES)}::text[])
          )
        GROUP BY ev.organization_id
        ORDER BY event_count DESC
        LIMIT 10
      `,
      createRun: async (batch) => {
        const created = await createBackfillRun(batch.organization_id);
        if (!created) return 'skipped';
        totalEvents += batch.event_count;
        logger.info(
          { organization_id: batch.organization_id, event_count: batch.event_count },
          '[EmbedBackfill] Created run'
        );
        return 'created';
      },
      onError: (batch, error) => {
        logger.error(
          { error, organization_id: batch.organization_id },
          '[EmbedBackfill] Failed to create run'
        );
      },
      onDone: ({ runsCreated }) => {
        if (runsCreated > 0) {
          logger.info({ runsCreated, totalEvents }, '[EmbedBackfill] Batch complete');
        }
      },
    });

    return { organizations: counts.due, runsCreated: counts.runsCreated, totalEvents };
  } catch (error) {
    logger.error({ error }, '[EmbedBackfill] Error checking for missing embeddings');
    throw error;
  }
}

/**
 * Create a pending embed_backfill run for an organization.
 * Skips if one is already pending/running.
 */
async function createBackfillRun(organizationId: string): Promise<boolean> {
  const sql = getDb();

  const needsEmbedding = needsEmbeddingPredicate();

  try {
    return await sql.begin(async (tx) => {
      // Collect event IDs that need (re)embedding (up to batch limit)
      const events = await tx`
        SELECT ev.id
        FROM current_event_records ev
        LEFT JOIN event_embeddings emb ON emb.event_id = ev.id
        WHERE ${tx.unsafe(needsEmbedding)}
          AND ev.payload_text IS NOT NULL
          AND ev.payload_text != ''
          AND ev.organization_id = ${organizationId}
        ORDER BY ev.created_at ASC
        LIMIT ${BATCH_LIMIT}
      `;

      if (events.length === 0) {
        return false;
      }

      const eventIds = events.map((e) => Number(e.id));

      await tx`
        INSERT INTO runs (
          organization_id, run_type, status,
          approval_status, action_input, created_at
        ) VALUES (
          ${organizationId}, 'embed_backfill', 'pending',
          'auto', ${sql.json({ event_ids: eventIds })},
          current_timestamp
        )
      `;

      return true;
    });
  } catch (error) {
    if (isUniqueViolation(error, 'idx_runs_active_embed_backfill_per_org')) {
      return false;
    }
    throw error;
  }
}
