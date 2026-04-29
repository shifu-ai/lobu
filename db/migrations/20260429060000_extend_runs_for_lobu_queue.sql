-- migrate:up

-- Phase 5 of Redis -> Postgres migration: route the lobu queue (chat_message,
-- thread_message_*, thread_response, schedule, agent_run) through the runs
-- table instead of BullMQ.
--
-- 1. Extend the run_type CHECK to allow the new lobu-queue lanes alongside
--    the existing connector/auth/embed lanes.
-- 2. Allow organization_id to be NULL for lobu-queue runs (chat_message,
--    schedule, etc.). The original lanes still require it via the partial
--    CHECK below.
-- 3. Add columns required for in-process claim + retry:
--      queue_name      — distinguishes thread_message_* sub-queues that all
--                        share run_type='chat_message'.
--      idempotency_key — singletonKey dedup; partial unique index below.
--      attempts        — current retry count.
--      max_attempts    — cap for retries before DLQ/failed.
--      run_at          — when the row becomes claimable; supports delayMs.
-- 4. Add the claim index used by the in-process polling loop. Filter to the
--    new run types so the connector worker (run_type IN ('sync','action',...))
--    is never woken by lobu-queue inserts and vice versa.

-- Drop the old run_type CHECK and re-add with the new lobu-queue lanes.
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

-- organization_id is required for connector lanes (sync/action/embed/watcher/
-- auth) but optional for lobu-queue lanes. Drop NOT NULL and enforce per-lane.
ALTER TABLE public.runs
    ALTER COLUMN organization_id DROP NOT NULL;

ALTER TABLE public.runs
    ADD CONSTRAINT runs_legacy_org_required CHECK (
        run_type NOT IN (
            'sync', 'action', 'embed_backfill', 'watcher', 'auth'
        )
        OR organization_id IS NOT NULL
    );

-- Lobu queue columns.
ALTER TABLE public.runs
    ADD COLUMN IF NOT EXISTS queue_name text,
    ADD COLUMN IF NOT EXISTS idempotency_key text,
    ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS max_attempts integer NOT NULL DEFAULT 3,
    ADD COLUMN IF NOT EXISTS run_at timestamp with time zone NOT NULL DEFAULT now();

-- Idempotency: partial unique on (idempotency_key) for runs that are still in
-- a non-terminal state. Once a run completes / fails / cancels / times out it
-- no longer participates in dedup, so a future enqueue with the same singleton
-- key (e.g. a Slack retry that lands minutes after the first attempt
-- finished) can insert a fresh row. Connector lanes never set this column.
CREATE UNIQUE INDEX IF NOT EXISTS runs_idempotency_key_uniq
    ON public.runs (idempotency_key)
    WHERE idempotency_key IS NOT NULL
      AND status IN ('pending', 'claimed', 'running');

-- Claim index for the in-process poll loop. Limited to lobu-queue run types
-- so the connector worker's HTTP-poll claim stays on its own indexes.
CREATE INDEX IF NOT EXISTS runs_lobu_claim_idx
    ON public.runs (run_type, queue_name, run_at)
    WHERE status = 'pending'
      AND run_type IN ('chat_message', 'schedule', 'agent_run', 'internal');

-- migrate:down

DROP INDEX IF EXISTS public.runs_lobu_claim_idx;
DROP INDEX IF EXISTS public.runs_idempotency_key_uniq;

ALTER TABLE public.runs
    DROP COLUMN IF EXISTS run_at,
    DROP COLUMN IF EXISTS max_attempts,
    DROP COLUMN IF EXISTS attempts,
    DROP COLUMN IF EXISTS idempotency_key,
    DROP COLUMN IF EXISTS queue_name;

ALTER TABLE public.runs
    DROP CONSTRAINT IF EXISTS runs_legacy_org_required;

-- Restoring NOT NULL would fail if any lobu-queue rows still exist. Operators
-- running `migrate:down` are expected to truncate or migrate those first.
ALTER TABLE public.runs
    ALTER COLUMN organization_id SET NOT NULL;

ALTER TABLE public.runs
    DROP CONSTRAINT IF EXISTS runs_run_type_check;

ALTER TABLE public.runs
    ADD CONSTRAINT runs_run_type_check CHECK (run_type = ANY (ARRAY[
        'sync'::text,
        'action'::text,
        'embed_backfill'::text,
        'watcher'::text,
        'auth'::text
    ]));
