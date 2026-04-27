-- migrate:up

-- Reverts the trust-primitive scaffolding shipped earlier in the same PR
-- chain (`20260427120000_entity_read_grant.sql`). The audit-agent design
-- that those primitives existed for was killed before the PR landed; the
-- replacement is a connector-facts engine that ships in a focused
-- follow-up. This migration drops the orphaned writers cleanly.
--
-- Idempotent: safe to run on any environment regardless of whether the
-- prior migration ran (dev DBs created after the original reverted file
-- still get the create-then-drop sequence; prod just gets the drop).

DROP INDEX IF EXISTS public.idx_entity_read_grant_entity_active;
DROP INDEX IF EXISTS public.idx_entity_read_grant_idempotency;
DROP INDEX IF EXISTS public.idx_entity_read_grant_grantee_entity_active;
DROP TABLE IF EXISTS public.entity_read_grant;

-- Soft-delete the two relationship types from the schema-types table so
-- existing rows in any environment stop showing them as live vocabulary.
-- The YAML files in `examples/market/models/{claims_identity,has_authority}.yaml`
-- are removed in the same commit, so seeders won't recreate them.
UPDATE public.entity_relationship_types
SET deleted_at = NOW()
WHERE slug IN ('claims_identity', 'has_authority')
  AND deleted_at IS NULL;

-- Drop the platform-level audit-agent service user provisioned by the
-- prior migration. ON DELETE CASCADE on the entity_read_grant FKs handled
-- the dependent rows when the table dropped above.
DELETE FROM public."user" WHERE id = 'user_audit_agent';


-- migrate:down

-- This revert intentionally does not recreate the trust-primitive
-- scaffolding. The replacement design (connector-facts engine + identity
-- index + compiled rules + derivations) lives in a forward migration that
-- supersedes both this revert and the original create. Rolling back
-- further than the create is a manual operation.
SELECT 1;
