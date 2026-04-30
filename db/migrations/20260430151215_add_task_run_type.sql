-- migrate:up

-- Add 'task' to the runs_run_type_check.
--
-- Background: the lobu-queue lanes (chat_message, schedule, agent_run,
-- internal) are claimed in-process by the gateway's RunsQueue. The 'task'
-- lane extends that pattern for platform-side periodic + lazy work
-- (token refresh, classification reconciliation, embed backfill, watcher
-- maintenance, etc.) that previously ran from a single setInterval-driven
-- maintenance scheduler.
--
-- Rows in this lane have:
--   action_key = task name (registry key, e.g. 'classification-reconciliation')
--   action_input = task payload (handler-defined JSON)
--   queue_name = 'task'
--   idempotency_key = 'cron:<name>' for periodic seeds, or caller-defined
--     for spawn() invocations that need dedup
-- They never spawn worker subprocesses; the gateway looks up
-- action_key in the in-process TaskScheduler registry and runs the handler
-- directly.

ALTER TABLE public.runs
    DROP CONSTRAINT IF EXISTS runs_run_type_check;

ALTER TABLE public.runs
    ADD CONSTRAINT runs_run_type_check CHECK (run_type = ANY (ARRAY[
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
    ]));

-- Extend the lobu claim index to include the new 'task' lane so the
-- in-process poll loop walks the same index path for it.
DROP INDEX IF EXISTS public.runs_lobu_claim_idx;

CREATE INDEX IF NOT EXISTS runs_lobu_claim_idx
    ON public.runs (run_type, queue_name, priority DESC, run_at ASC, id ASC)
    WHERE status = 'pending'
      AND run_type IN ('chat_message', 'schedule', 'agent_run', 'internal', 'task');

-- migrate:down

DROP INDEX IF EXISTS public.runs_lobu_claim_idx;

CREATE INDEX IF NOT EXISTS runs_lobu_claim_idx
    ON public.runs (run_type, queue_name, priority DESC, run_at ASC, id ASC)
    WHERE status = 'pending'
      AND run_type IN ('chat_message', 'schedule', 'agent_run', 'internal');

-- Cancel any task-lane rows so the constraint can be tightened back.
UPDATE public.runs SET status = 'cancelled'
    WHERE run_type = 'task' AND status IN ('pending', 'claimed', 'running');

ALTER TABLE public.runs
    DROP CONSTRAINT IF EXISTS runs_run_type_check;

ALTER TABLE public.runs
    ADD CONSTRAINT runs_run_type_check CHECK (run_type = ANY (ARRAY[
        'sync'::text,
        'action'::text,
        'embed_backfill'::text,
        'watcher'::text,
        'auth'::text,
        'chat_message'::text,
        'schedule'::text,
        'agent_run'::text,
        'internal'::text
    ]));
