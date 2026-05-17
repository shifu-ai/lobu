-- migrate:up

-- Archive watchers that are flagged `status = 'active'` but have no `agent_id`.
-- The scheduler (packages/server/src/watchers/automation.ts:469) already
-- filters them out with `WHERE w.agent_id IS NOT NULL`, so these rows are
-- zombies — visible in the API, redirect-bounced on the watcher detail
-- route, never actually executing.
--
-- 2026-05-17 prod audit: 28 active orphans across 11 orgs (most originated
-- from older create paths before `agent_id` was wired in). Archiving them
-- aligns the stored status with their actual execution state and lets the
-- `/$owner/watchers/$watcherId` redirect logic stop silently sending users
-- to /agents.
--
-- The write-time guard (this same PR, manage_watchers.ts) rejects new
-- watcher creates/updates that set a schedule without an agent, so the
-- orphan set can't grow again.

UPDATE public.watchers
SET status = 'archived',
    updated_at = now()
WHERE status = 'active'
  AND agent_id IS NULL;

-- migrate:down

-- No-op: this is a one-shot data cleanup. The original rows can be restored
-- manually if needed by assigning an agent_id and flipping status back to
-- 'active'; without an agent, status='active' is meaningless to the
-- scheduler.
