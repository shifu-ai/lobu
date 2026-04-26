-- Repair-agent plumbing for connector reliability.
--
-- When a feed accumulates persistent failures, the worker-completion path
-- can open a Lobu agent thread for triage. These columns track the
-- per-feed override, the open thread (if any), the lifetime budget of
-- repair attempts, the start of the current failure streak, and the
-- last-posted content hash for append throttling.
ALTER TABLE public.feeds
  ADD COLUMN repair_agent_id text NULL,
  ADD COLUMN repair_thread_id text NULL,
  ADD COLUMN repair_attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN last_repair_at timestamp with time zone NULL,
  ADD COLUMN first_failure_at timestamp with time zone NULL,
  ADD COLUMN last_repair_post_hash text NULL;

-- The unique partial index documents intent: a feed has at most one open
-- repair thread at a time. (`feeds.id` is already PK so the constraint is
-- redundant for uniqueness; the actual race guard is the conditional
-- UPDATE on repair_thread_id IS NULL in the worker-completion path.)
CREATE UNIQUE INDEX feeds_open_repair_thread_uniq
  ON public.feeds (id) WHERE repair_thread_id IS NOT NULL;

-- Per-connector default repair agent. When a feed has no explicit
-- repair_agent_id, the trigger logic falls back to this value.
ALTER TABLE public.connector_definitions
  ADD COLUMN default_repair_agent_id text NULL;

-- Per-org kill switch. When FALSE, no repair threads are opened for any
-- feed in the org regardless of per-feed configuration.
ALTER TABLE public.organization
  ADD COLUMN repair_agents_enabled boolean NOT NULL DEFAULT TRUE;
