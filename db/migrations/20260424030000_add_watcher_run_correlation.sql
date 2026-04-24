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

CREATE INDEX IF NOT EXISTS idx_watcher_windows_run_id
    ON public.watcher_windows (run_id)
    WHERE run_id IS NOT NULL;


-- migrate:down

DROP INDEX IF EXISTS public.idx_watcher_windows_run_id;
ALTER TABLE public.watcher_windows DROP COLUMN IF EXISTS run_id;
DROP INDEX IF EXISTS public.idx_runs_dispatched_message_id;
ALTER TABLE public.runs DROP COLUMN IF EXISTS dispatched_message_id;
