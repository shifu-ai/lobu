/**
 * Scheduled job: distill long raw events into atomic `extracted_fact` events
 * that back focused reads (`read_knowledge({ focused: true })`).
 *
 * Extraction runs INLINE in the tick (not via a worker run like embed-backfill):
 * the tick is runs-queue-claimed, so one replica runs it, and the NOT EXISTS
 * guard keyed on (derived_from_event_id, fact_extractor_version) keeps it
 * idempotent.
 */

import { getDb, parsePgNumberArray } from '../db/client';
import type { Env } from '../index';
import { extractFacts, factExtractorVersion } from '../utils/fact-extractor';
import { insertEvent } from '../utils/insert-event';
import logger from '../utils/logger';

/** Events scanned per tick — bounded so a tick stays cheap and predictable. */
const EVENT_BATCH_LIMIT = 50;
/** Min payload length to bother extracting — shorter events are already focused. */
const MIN_PAYLOAD_LENGTH = 200;
/** How many events to extract concurrently (LLM calls are the bottleneck). */
const EXTRACTION_CONCURRENCY = 4;

interface FactExtractionResult {
  events: number;
  factsCreated: number;
}

interface ExtractionCandidate {
  id: number;
  organization_id: string;
  // Under the prod PG value options (`fetch_types: false`) a `bigint[]` column
  // comes back as a Postgres array literal STRING (e.g. `{12,34}`), not a JS
  // array — so this is `unknown` and parsed via `parsePgNumberArray`.
  entity_ids: unknown;
  occurred_at: string | null;
  payload_text: string;
}

export async function triggerFactExtraction(env: Env): Promise<FactExtractionResult> {
  const sql = getDb();
  const version = factExtractorVersion(env);

  // Find events needing extraction at the current extractor version. The
  // NOT EXISTS guard keys on (derived_from_event_id, fact_extractor_version)
  // so a model/prompt bump re-extracts, and an already-extracted event is
  // skipped (idempotent across overlapping ticks). We never extract facts
  // from facts. The version is bound as a parameter.
  const candidates = (await sql`
    SELECT
      ev.id,
      ev.organization_id,
      ev.entity_ids,
      ev.occurred_at,
      ev.payload_text
    FROM current_event_records ev
    WHERE ev.semantic_type <> 'extracted_fact'
      AND ev.payload_text IS NOT NULL
      AND ev.payload_text != ''
      AND ev.organization_id IS NOT NULL
      AND length(ev.payload_text) > ${MIN_PAYLOAD_LENGTH}
      AND NOT EXISTS (
        SELECT 1
        FROM events d
        WHERE d.semantic_type = 'extracted_fact'
          AND d.metadata->>'derived_from_event_id' = ev.id::text
          AND d.metadata->>'fact_extractor_version' = ${version}
      )
    ORDER BY ev.created_at DESC
    LIMIT ${EVENT_BATCH_LIMIT}
  `) as unknown as ExtractionCandidate[];

  if (candidates.length === 0) {
    return { events: 0, factsCreated: 0 };
  }

  let factsCreated = 0;
  let processed = 0;

  // Bounded concurrency: process EXTRACTION_CONCURRENCY events at a time so a
  // batch of 50 doesn't fire 50 simultaneous LLM calls nor block serially for
  // minutes. Each chunk awaits before the next starts.
  for (let i = 0; i < candidates.length; i += EXTRACTION_CONCURRENCY) {
    const chunk = candidates.slice(i, i + EXTRACTION_CONCURRENCY);
    const created = await Promise.all(
      chunk.map((candidate) => extractAndInsert(candidate, version, env))
    );
    for (const n of created) {
      factsCreated += n;
      processed += 1;
    }
  }

  if (factsCreated > 0) {
    logger.info(
      { events: processed, factsCreated, version },
      '[FactExtraction] Extracted facts for events'
    );
  }

  return { events: processed, factsCreated };
}

/**
 * Extract facts for one parent event and insert each as a derived
 * `extracted_fact` event. Returns the number of facts inserted (0 when the
 * extractor is unconfigured or yields nothing). Inherits the parent's org,
 * entity links, and occurred_at so focused reads can join + window correctly.
 * Embeddings are left to the existing embed_backfill job — the fact events
 * carry `payload_text`, so they get embedded on the next backfill tick.
 */
async function extractAndInsert(
  candidate: ExtractionCandidate,
  version: string,
  env: Env
): Promise<number> {
  let facts: string[];
  try {
    facts = await extractFacts(candidate.payload_text, env);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), parentId: candidate.id },
      '[FactExtraction] extractFacts threw; skipping event'
    );
    return 0;
  }

  if (facts.length === 0) return 0;

  // `entity_ids` is a Postgres array literal string under `fetch_types: false`
  // (prod value options) — parse it the same way the rest of the read path does.
  const entityIds = parsePgNumberArray(candidate.entity_ids);

  let inserted = 0;
  for (let idx = 0; idx < facts.length; idx += 1) {
    const fact = facts[idx];
    try {
      await insertEvent({
        entityIds,
        organizationId: candidate.organization_id,
        // Stable, unique origin id per (parent, fact, version) so re-running
        // a tick can't collide and a version bump produces fresh rows.
        originId: `extracted_fact:${candidate.id}:${version}:${idx}`,
        content: fact,
        semanticType: 'extracted_fact',
        occurredAt: candidate.occurred_at ?? null,
        metadata: {
          derived_from_event_id: candidate.id,
          fact_extractor_version: version,
        },
      });
      inserted += 1;
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), parentId: candidate.id, idx },
        '[FactExtraction] failed to insert derived fact'
      );
    }
  }

  return inserted;
}
