-- migrate:up

-- Repair relationship-type tombstones left by the old delete path. The
-- (organization_id, slug) uniqueness index is partial on `WHERE status =
-- 'active'`, but the old delete only set `deleted_at` and left `status =
-- 'active'`, so a tombstoned row kept occupying the index — re-creating the
-- same slug (e.g. `lobu apply` prune then re-add) hit a unique violation.
-- The delete path now also sets `status = 'archived'` (see rtHandleDelete);
-- this backfills the rows deleted before that fix so re-create can't collide.
-- 'archived' is the only other status the check constraint permits.
UPDATE public.entity_relationship_types
SET status = 'archived'
WHERE deleted_at IS NOT NULL AND status = 'active';

-- migrate:down

-- No-op: archiving an already-deleted (deleted_at IS NOT NULL) row is not
-- meaningfully reversible — the rows are tombstones either way, and reverting
-- status to 'active' would re-introduce the unique-index collision this fixes.
SELECT 1;
