-- migrate:up

-- Identity-engine schema additions.
--
-- The follow-up identity engine writes connector-emitted facts as rows in
-- `events` with `semantic_type='identity_fact'` and stores derivation
-- provenance as metadata on `entity_relationships`. Auto-create rules live
-- as JSONB on `entity_relationship_types.metadata` (compiled from YAML by
-- the seeder). All three shapes need selective indexes so the hot paths
-- don't full-scan.
--
-- Pattern matches the existing per-namespace event metadata indexes added
-- in 20260419120000_add_event_identity_indexes.sql.

-- ── Rule storage on relationship types ─────────────────────────────────
-- The engine reads each relationship type's `metadata.autoCreateWhen[]` to
-- decide which rules to fire on each incoming fact. Adding the column up
-- front (NULL allowed) keeps the seeder change non-destructive.
ALTER TABLE public.entity_relationship_types
    ADD COLUMN IF NOT EXISTS metadata jsonb;

CREATE INDEX IF NOT EXISTS idx_entity_relationship_types_has_auto_create
    ON public.entity_relationship_types ((metadata->'autoCreateWhen'))
    WHERE metadata ? 'autoCreateWhen' AND deleted_at IS NULL;

-- ── Identity lookup ─────────────────────────────────────────────────────
-- "Find the entity in catalog X whose normalized identity value matches
-- this fact's normalizedValue." Composite expression index keyed on the
-- (org, namespace, normalizedValue) tuple. Partial: only fact-typed events
-- get indexed, so total size scales with fact volume (small) not event
-- volume (huge).
CREATE INDEX IF NOT EXISTS idx_events_identity_fact_lookup
    ON public.events (
        organization_id,
        (metadata->>'namespace'),
        (metadata->>'normalizedValue')
    )
    WHERE semantic_type = 'identity_fact';

-- ── Per-account fact diff ───────────────────────────────────────────────
-- "Find every active fact for this provider account." Used by the engine
-- to diff prior facts vs current set on refresh — drops fall out of the
-- result and get superseded. Keyed on `providerStableId` (not
-- `sourceAccountId`): BetterAuth may issue a fresh account row on
-- reconnect; we want facts to chain across that boundary.
CREATE INDEX IF NOT EXISTS idx_events_identity_fact_account
    ON public.events (
        connector_key,
        (metadata->>'providerStableId'),
        (metadata->>'namespace')
    )
    WHERE semantic_type = 'identity_fact';

-- ── Provenance reverse-lookup ───────────────────────────────────────────
-- "Find every relationship derived from this fact event." Used at
-- revocation: when a fact is superseded, find auto-created relationships
-- that referenced its event_id and revoke them.
CREATE INDEX IF NOT EXISTS idx_entity_relationships_derived_from_event
    ON public.entity_relationships (
        ((metadata->'derivedFrom'->>'sourceEventId'))
    )
    WHERE metadata ? 'derivedFrom';

-- ── Rule-version drift detection ────────────────────────────────────────
-- "Find every relationship derived from this rule type at this version."
-- Used by reconcile when a rule changes — find derivations stamped with
-- an older version, revoke or refresh them.
CREATE INDEX IF NOT EXISTS idx_entity_relationships_derived_from_rule
    ON public.entity_relationships (
        ((metadata->'derivedFrom'->>'relationshipTypeId')),
        ((metadata->'derivedFrom'->>'ruleVersion'))
    )
    WHERE metadata ? 'derivedFrom';

-- ── Idempotent derivation insert ────────────────────────────────────────
-- Pi P0.3 — even with the engine's advisory lock, this partial unique
-- constraint catches accidental double-inserts (e.g. when a different code
-- path tries to write the same auto-derived edge). ON CONFLICT DO NOTHING
-- in the engine relies on this index to fire.
--
-- Existing installs may already have duplicate live triples. Collapse those
-- first so adding the invariant is safe and deterministic.
WITH duplicate_live_triples AS (
    SELECT id,
           ROW_NUMBER() OVER (
               PARTITION BY from_entity_id, to_entity_id, relationship_type_id
               ORDER BY created_at ASC NULLS LAST, id ASC
           ) AS rn
    FROM public.entity_relationships
    WHERE deleted_at IS NULL
)
UPDATE public.entity_relationships r
SET deleted_at = NOW(), updated_at = NOW()
FROM duplicate_live_triples d
WHERE r.id = d.id
  AND d.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_relationships_live_triple
    ON public.entity_relationships (from_entity_id, to_entity_id, relationship_type_id)
    WHERE deleted_at IS NULL;

-- ── Per-namespace entity metadata indexes ───────────────────────────────
-- Pi P1.10 — the engine's findEntitiesByMetadataField does
-- `WHERE metadata->>$field = $value`. Without per-field expression indexes
-- this is a sequential scan on the entities table for every fact it
-- processes. Add the common identity namespaces here; future namespaces
-- get an entry in this same list when their first rule lands.
--
-- `idx_entities_metadata_domain` already exists in the baseline schema.

CREATE INDEX IF NOT EXISTS idx_entities_metadata_email
    ON public.entities ((metadata->>'email'), organization_id)
    WHERE (metadata->>'email') IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_entities_metadata_linkedin_url
    ON public.entities ((metadata->>'linkedin_url'), organization_id)
    WHERE (metadata->>'linkedin_url') IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_entities_metadata_github_handle
    ON public.entities ((metadata->>'github_handle'), organization_id)
    WHERE (metadata->>'github_handle') IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_entities_metadata_twitter_handle
    ON public.entities ((metadata->>'twitter_handle'), organization_id)
    WHERE (metadata->>'twitter_handle') IS NOT NULL AND deleted_at IS NULL;


-- migrate:down

DROP INDEX IF EXISTS public.idx_entities_metadata_twitter_handle;
DROP INDEX IF EXISTS public.idx_entities_metadata_github_handle;
DROP INDEX IF EXISTS public.idx_entities_metadata_linkedin_url;
DROP INDEX IF EXISTS public.idx_entities_metadata_email;
DROP INDEX IF EXISTS public.idx_entity_relationships_live_triple;
DROP INDEX IF EXISTS public.idx_entity_relationships_derived_from_rule;
DROP INDEX IF EXISTS public.idx_entity_relationships_derived_from_event;
DROP INDEX IF EXISTS public.idx_events_identity_fact_account;
DROP INDEX IF EXISTS public.idx_events_identity_fact_lookup;
DROP INDEX IF EXISTS public.idx_entity_relationship_types_has_auto_create;
ALTER TABLE public.entity_relationship_types DROP COLUMN IF EXISTS metadata;
