-- migrate:up

-- Delete every watcher with `agent_id IS NULL` and enforce the column at
-- the schema level. These rows are leftovers from before the watcher
-- scheduler required `agent_id` (see watchers/automation.ts:469) — they
-- couldn't fire and the prior migration 20260517040000 had already
-- archived the active subset. Their dependent rows (windows, reactions,
-- versions, classifiers, field feedback) describe runtime state for
-- watchers that will never execute; ON DELETE CASCADE clears them.
-- `runs.watcher_id` is ON DELETE SET NULL, so the 21k historical run
-- records remain — they just lose the watcher linkage.
--
-- Application-level guards in manage_watchers.ts (handleCreate +
-- handleCreateFromVersion) reject new inserts without `agent_id`; the
-- NOT NULL constraint below is the matching DB-level enforcement so
-- bypass paths can't reintroduce the zombie state.

DELETE FROM public.watchers WHERE agent_id IS NULL;

ALTER TABLE public.watchers
  ALTER COLUMN agent_id SET NOT NULL;

-- The existing index is partial (`WHERE agent_id IS NOT NULL`), which is
-- a tautology once the column is NOT NULL. Replace it with an unconditional
-- index so explain plans don't show the dead predicate.
DROP INDEX IF EXISTS public.idx_watchers_agent_id;
CREATE INDEX idx_watchers_agent_id ON public.watchers USING btree (agent_id);

-- migrate:down

ALTER TABLE public.watchers
  ALTER COLUMN agent_id DROP NOT NULL;

-- No restoring deleted rows — this is forward-only data cleanup.
