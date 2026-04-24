-- migrate:up

-- Durable correlation between a dispatched watcher run and the agent message
-- that executes it, and between a completed watcher window and the run that
-- produced it. Replaces payload-based matching in reconcileWatcherRuns.

ALTER TABLE public.runs
    ADD COLUMN IF NOT EXISTS dispatched_message_id text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_dispatched_message_id
    ON public.runs (dispatched_message_id)
    WHERE dispatched_message_id IS NOT NULL;

ALTER TABLE public.watcher_windows
    ADD COLUMN IF NOT EXISTS run_id bigint
    REFERENCES public.runs(id) ON DELETE SET NULL;

-- Rollout backfill: older windows already stored watcher_run_id in run_metadata,
-- but pre-migration rows have NULL run_id. Populate the durable FK before the
-- new reconciler/reset path runs so successful pre-deploy executions are not
-- re-dispatched on first tick.
WITH correlated_windows AS (
    SELECT ww.id,
           (btrim(ww.run_metadata->>'watcher_run_id'))::bigint AS correlated_run_id
    FROM public.watcher_windows ww
    WHERE ww.run_id IS NULL
      AND ww.run_metadata ? 'watcher_run_id'
      AND jsonb_typeof(ww.run_metadata->'watcher_run_id') IN ('number', 'string')
      AND btrim(ww.run_metadata->>'watcher_run_id') ~ '^[0-9]+$'
)
UPDATE public.watcher_windows ww
SET run_id = cw.correlated_run_id
FROM correlated_windows cw
WHERE ww.id = cw.id
  AND EXISTS (
      SELECT 1
      FROM public.runs r
      WHERE r.id = cw.correlated_run_id
        AND r.run_type = 'watcher'
  );

CREATE INDEX IF NOT EXISTS idx_watcher_windows_run_id
    ON public.watcher_windows (run_id)
    WHERE run_id IS NOT NULL;


-- migrate:down

DROP INDEX IF EXISTS public.idx_watcher_windows_run_id;
ALTER TABLE public.watcher_windows DROP COLUMN IF EXISTS run_id;
DROP INDEX IF EXISTS public.idx_runs_dispatched_message_id;
ALTER TABLE public.runs DROP COLUMN IF EXISTS dispatched_message_id;
