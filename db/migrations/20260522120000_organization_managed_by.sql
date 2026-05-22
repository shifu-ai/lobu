-- migrate:up

-- Org provenance. 'code' means the org's definitions (entity types,
-- relationship types, watchers, connector definitions) are owned by a
-- `lobu.config.ts` and `lobu apply` PRUNES definitions removed from it; 'ui'
-- (the default) means apply never deletes — the dashboard/API are free to add
-- definitions without a config rewriting them away.
--
-- SAFETY: the NOT NULL DEFAULT 'ui' backfills every existing org to 'ui', so no
-- org starts out prunable. An org only becomes code-managed via the explicit
-- one-time `lobu apply --manage` opt-in. See computeDiff({ codeManaged }) in
-- packages/cli/src/commands/_lib/apply/diff.ts.

ALTER TABLE public.organization
  ADD COLUMN IF NOT EXISTS managed_by text NOT NULL DEFAULT 'ui';

ALTER TABLE public.organization
  DROP CONSTRAINT IF EXISTS organization_managed_by_check;
ALTER TABLE public.organization
  ADD CONSTRAINT organization_managed_by_check
  CHECK (managed_by IN ('ui', 'code'));

-- migrate:down

ALTER TABLE public.organization
  DROP CONSTRAINT IF EXISTS organization_managed_by_check;
ALTER TABLE public.organization
  DROP COLUMN IF EXISTS managed_by;
