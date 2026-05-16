-- migrate:up

-- has_embedding mirrors "does event_embeddings have a row for this event_id".
-- The embed-backfill scheduler today does a 1.27s seq scan + hash anti-join
-- on the 1.15M-row events table every 5 min (pg_stat_statements rank #1 by
-- total_exec_time, see lobu#767 postmortem). With this column + a partial
-- index (added in a follow-up migration after backfill), the scheduler
-- becomes a tiny index lookup over the actually-missing-embedding rows.
--
-- This migration only adds the column and the maintenance triggers. The
-- column is intentionally:
--   * nullable: ADD COLUMN <bool> NULL is O(1) metadata-only in PG 11+; a
--     DEFAULT would rewrite all 1.15M rows under ACCESS EXCLUSIVE (the same
--     trap that timed out 20260516200000_events_search_tsv).
--   * not backfilled here: existing rows are populated by a batched script
--     (scripts/backfill-events-has-embedding.sql) that runs outside the
--     Helm hook so it can pace itself with statement_timeout headroom.
--
-- Until backfill finishes, has_embedding IS NULL means "unknown" for old
-- rows; new rows get has_embedding flipped by the triggers below. The
-- partial index (next migration) treats NULL the same as FALSE so the
-- scheduler keeps working.

ALTER TABLE public.events ADD COLUMN has_embedding boolean;

CREATE OR REPLACE FUNCTION public.event_embeddings_after_insert() RETURNS trigger AS $$
BEGIN
  UPDATE public.events SET has_embedding = true WHERE id = NEW.event_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION public.event_embeddings_after_delete() RETURNS trigger AS $$
BEGIN
  UPDATE public.events SET has_embedding = false WHERE id = OLD.event_id;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_event_embeddings_after_insert ON public.event_embeddings;
CREATE TRIGGER trg_event_embeddings_after_insert
  AFTER INSERT ON public.event_embeddings
  FOR EACH ROW EXECUTE FUNCTION public.event_embeddings_after_insert();

DROP TRIGGER IF EXISTS trg_event_embeddings_after_delete ON public.event_embeddings;
CREATE TRIGGER trg_event_embeddings_after_delete
  AFTER DELETE ON public.event_embeddings
  FOR EACH ROW EXECUTE FUNCTION public.event_embeddings_after_delete();

-- migrate:down

DROP TRIGGER IF EXISTS trg_event_embeddings_after_insert ON public.event_embeddings;
DROP TRIGGER IF EXISTS trg_event_embeddings_after_delete ON public.event_embeddings;
DROP FUNCTION IF EXISTS public.event_embeddings_after_insert();
DROP FUNCTION IF EXISTS public.event_embeddings_after_delete();
ALTER TABLE public.events DROP COLUMN IF EXISTS has_embedding;
