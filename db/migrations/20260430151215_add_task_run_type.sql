-- migrate:up transaction:false

-- Add 'task' to the runs_run_type_check + extend runs_lobu_claim_idx.
--
-- Background: the lobu-queue lanes (chat_message, schedule, agent_run,
-- internal) are claimed in-process by the gateway's RunsQueue. The 'task'
-- lane extends that pattern for platform-side periodic + lazy work
-- (token refresh, classification reconciliation, embed backfill, watcher
-- maintenance, etc.) that previously ran from a single setInterval-driven
-- maintenance scheduler.
--
-- Lock-safety: this migration runs `transaction:false` so that
-- CREATE INDEX CONCURRENTLY and VALIDATE CONSTRAINT release locks between
-- statements. Without it, dbmate's per-migration transaction would force
-- ACCESS EXCLUSIVE on the runs table for the duration of a constraint
-- validation or index build — visible downtime for a hot queue table.
SET lock_timeout = '5s';

-- 1. Widen the run_type CHECK constraint without scanning the table.
--    NOT VALID adds the catalog row under a brief ACCESS EXCLUSIVE.
--    VALIDATE takes only SHARE UPDATE EXCLUSIVE so concurrent reads/writes
--    are unaffected. Idempotent: re-runs safely if a prior run died midway.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conrelid = 'public.runs'::regclass
           AND conname = 'runs_run_type_check_v2'
    ) THEN
        ALTER TABLE public.runs
            ADD CONSTRAINT runs_run_type_check_v2 CHECK (run_type = ANY (ARRAY[
                'sync'::text,
                'action'::text,
                'embed_backfill'::text,
                'watcher'::text,
                'auth'::text,
                'chat_message'::text,
                'schedule'::text,
                'agent_run'::text,
                'internal'::text,
                'task'::text
            ])) NOT VALID;
    END IF;
END$$;

ALTER TABLE public.runs VALIDATE CONSTRAINT runs_run_type_check_v2;

ALTER TABLE public.runs DROP CONSTRAINT IF EXISTS runs_run_type_check;
ALTER TABLE public.runs RENAME CONSTRAINT runs_run_type_check_v2 TO runs_run_type_check;

-- 2. Replace the lobu claim index. Originally written with CONCURRENTLY,
--    but dbmate's transaction wrapper still presents these to PG as
--    in-transaction even with `transaction:false`, which breaks
--    CREATE/DROP INDEX CONCURRENTLY (see comments in
--    20260426130001_db_integrity_cleanup_concurrent.sql for the same
--    workaround). The partial index only covers `status = 'pending'`
--    rows in the lobu lanes — typically a small set since pending rows
--    are claimed within milliseconds — so the ACCESS EXCLUSIVE held
--    during the non-concurrent build is sub-second in practice.
DROP INDEX IF EXISTS public.runs_lobu_claim_idx;

CREATE INDEX runs_lobu_claim_idx
    ON public.runs (run_type, queue_name, priority DESC, run_at ASC, id ASC)
    WHERE status = 'pending'
      AND run_type IN ('chat_message', 'schedule', 'agent_run', 'internal', 'task');

-- migrate:down

-- This migration is forward-only.
--
-- Reverting would require either deleting all rows with run_type='task'
-- (data loss — both pending tasks and historical run records) or leaving
-- the constraint widened (the failure mode the up migration was avoiding).
-- Neither is safe to do automatically. If you genuinely need to revert,
-- write a follow-up migration that explicitly handles the data first.
SELECT 1;
