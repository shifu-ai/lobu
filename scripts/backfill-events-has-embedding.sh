#!/bin/bash
# Batched backfill for events.has_embedding (added in migration
# 20260517000000_events_has_embedding.sql).
#
# Why batched and not in the migration: a single UPDATE over 1.15M rows
# would hold an exclusive row-level lock for ~minute on a hot table while
# WAL-amplifying every row. Doing it in batches of 10k means each transaction
# is bounded (~1s) so VACUUM can keep up, autovacuum doesn't fall behind, and
# the API stays responsive.
#
# Idempotent: only touches rows where has_embedding IS NULL, so re-running
# after a partial run picks up where it left off.
#
# Run from the repo root:
#   DATABASE_URL="postgres://..." ./scripts/backfill-events-has-embedding.sh
#
# Operational note: takes ~5-10 min for 1.15M rows on a small Postgres. Safe
# to ctrl-C and resume; safe to run alongside live traffic.

set -euo pipefail

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL not set" >&2
  exit 1
fi

BATCH_SIZE="${BATCH_SIZE:-10000}"
SLEEP_BETWEEN_BATCHES="${SLEEP_BETWEEN_BATCHES:-0.1}"

echo "[backfill] BATCH_SIZE=$BATCH_SIZE SLEEP_BETWEEN_BATCHES=${SLEEP_BETWEEN_BATCHES}s"

remaining_count() {
  psql "$DATABASE_URL" -tAc "SELECT count(*) FROM public.events WHERE has_embedding IS NULL"
}

total_remaining=$(remaining_count)
echo "[backfill] $total_remaining rows have has_embedding IS NULL"

if [ "$total_remaining" = "0" ]; then
  echo "[backfill] nothing to do"
  exit 0
fi

batches=0
while true; do
  # Each batch is one transaction. Update up to $BATCH_SIZE rows where the
  # column is still unknown. UPDATE FROM joins to event_embeddings to set
  # the right value; rows with no matching embedding row get FALSE.
  rows_updated=$(psql "$DATABASE_URL" -tAc "
    WITH batch AS (
      SELECT id FROM public.events
       WHERE has_embedding IS NULL
       LIMIT $BATCH_SIZE
       FOR UPDATE SKIP LOCKED
    )
    UPDATE public.events e
       SET has_embedding = (emb.event_id IS NOT NULL)
      FROM batch b
      LEFT JOIN public.event_embeddings emb ON emb.event_id = b.id
     WHERE e.id = b.id
    RETURNING 1
  " | wc -l | tr -d ' ')

  batches=$((batches + 1))

  if [ "$rows_updated" = "0" ]; then
    echo "[backfill] no rows updated in batch $batches — done"
    break
  fi

  if [ $((batches % 10)) -eq 0 ]; then
    current_remaining=$(remaining_count)
    echo "[backfill] batch $batches: ~${rows_updated} rows updated this batch, ${current_remaining} remaining"
  fi

  sleep "$SLEEP_BETWEEN_BATCHES"
done

final_remaining=$(remaining_count)
echo "[backfill] complete: $final_remaining rows still have has_embedding IS NULL (expect 0)"
