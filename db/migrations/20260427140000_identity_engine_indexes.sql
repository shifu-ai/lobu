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
-- "Find every active fact this connector account currently produces." Used
-- by the engine to diff prior facts vs current set on refresh — drops fall
-- out of the result and get superseded.
CREATE INDEX IF NOT EXISTS idx_events_identity_fact_account
    ON public.events (
        (metadata->>'sourceAccountId'),
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


-- migrate:down

DROP INDEX IF EXISTS public.idx_entity_relationships_derived_from_rule;
DROP INDEX IF EXISTS public.idx_entity_relationships_derived_from_event;
DROP INDEX IF EXISTS public.idx_events_identity_fact_account;
DROP INDEX IF EXISTS public.idx_events_identity_fact_lookup;
DROP INDEX IF EXISTS public.idx_entity_relationship_types_has_auto_create;
ALTER TABLE public.entity_relationship_types DROP COLUMN IF EXISTS metadata;
