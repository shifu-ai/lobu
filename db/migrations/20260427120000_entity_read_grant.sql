-- migrate:up

-- entity_read_grant — delegated read primitive for the audit agent.
--
-- When a contributor in a private org creates a trust-primitive relationship
-- (claims_identity / has_authority / proposes_canonical / proposes_merge_with)
-- pointing at a public-catalog entity, the issuer's gateway auto-issues a row
-- here. The audit agent (a single platform-level service user) checks this
-- table before falling back to org-membership when reading the contributor's
-- private entity.
--
-- See packages/owletto-backend/src/utils/relationship-validation.ts and the
-- sibling issuance helper in entity-read-grant.ts for the runtime path.
--
-- Schema notes:
--  - `id` is generated as `grant_<short>` so it can be referenced from logs
--    without needing a join.
--  - `single_use=true` + `consumed_at` track one-shot grants; the audit-agent
--    read path SELECT…UPDATE-RETURNING marks the grant consumed atomically.
--  - `expires_at` defaults to +30d on issuance (set by the application layer);
--    enforced via the partial index that excludes consumed rows.
--  - `triggering_relationship_id` ties the grant to the relationship that
--    issued it. NOT a hard FK because relationship rows can be soft-deleted
--    (deleted_at) and we want grant audit history to survive that.
--  - The unique index on (grantor_org_id, entity_id, grantee_user_id,
--    triggering_relationship_id) makes idempotent issuance safe: re-running
--    the issuance hook with the same tuple updates expires_at instead of
--    inserting a duplicate.
--  - `consumed_at` lives outside the unique key so a fresh grant can be
--    issued after a prior one was consumed, by re-running the trigger flow.

CREATE TABLE IF NOT EXISTS public.entity_read_grant (
    id text PRIMARY KEY,
    grantor_org_id text NOT NULL REFERENCES public.organization(id) ON DELETE CASCADE,
    entity_id bigint NOT NULL REFERENCES public.entities(id) ON DELETE CASCADE,
    grantee_user_id text NOT NULL REFERENCES public."user"(id) ON DELETE CASCADE,
    scope text NOT NULL DEFAULT 'read-once',
    expires_at timestamp with time zone NOT NULL,
    single_use boolean NOT NULL DEFAULT true,
    consumed_at timestamp with time zone,
    triggering_relationship_id bigint,
    created_at timestamp with time zone NOT NULL DEFAULT NOW(),
    CONSTRAINT entity_read_grant_scope_check
        CHECK (scope IN ('read-once', 'read-n', 'read-window'))
);

-- Hot path: "is there an active grant for THIS user reading THIS entity?".
-- A single platform-level audit user means almost every active grant shares
-- the same grantee_user_id, so leading the index with grantee+entity makes
-- the EXISTS check in getEntity an index lookup rather than a scan over
-- every grant the audit agent holds.
CREATE INDEX IF NOT EXISTS idx_entity_read_grant_grantee_entity_active
    ON public.entity_read_grant (grantee_user_id, entity_id, expires_at)
    WHERE consumed_at IS NULL;

-- Idempotency: the issuance hook upserts on this tuple.
CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_read_grant_idempotency
    ON public.entity_read_grant (grantor_org_id, entity_id, grantee_user_id, triggering_relationship_id)
    WHERE consumed_at IS NULL;

-- Reverse-lookup: "given a private entity, who has read access right now?"
CREATE INDEX IF NOT EXISTS idx_entity_read_grant_entity_active
    ON public.entity_read_grant (entity_id, expires_at)
    WHERE consumed_at IS NULL;

-- Provision the platform-level audit-agent service user. v1 uses a single
-- shared identity rather than per-public-org service accounts to keep the
-- read path simple. Cross-tenant attack surface is bounded by
-- entity_read_grant: the agent can only read entities it has an active
-- grant for. If we later need per-public-org isolation, the existing
-- (grantor_org_id, grantee_user_id) shape lets us add per-org grantees
-- without schema changes — only the issuance helper needs to widen.
INSERT INTO public."user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
VALUES (
    'user_audit_agent',
    'Audit Agent',
    'audit-agent@lobu.internal',
    true,
    NOW(),
    NOW()
)
ON CONFLICT (id) DO NOTHING;


-- migrate:down

DROP INDEX IF EXISTS public.idx_entity_read_grant_entity_active;
DROP INDEX IF EXISTS public.idx_entity_read_grant_idempotency;
DROP INDEX IF EXISTS public.idx_entity_read_grant_grantee_entity_active;
DROP TABLE IF EXISTS public.entity_read_grant;
DELETE FROM public."user" WHERE id = 'user_audit_agent';
