-- Phase 4: provision the `_proposal_inbox` sentinel entity for atlas + market.
--
-- Run AFTER `create-atlas-org.sql`. Idempotent — re-running is a no-op.
--
-- The proposal inbox is a single well-known entity per public org that
-- contributors target with `proposes_canonical` to suggest a new canonical
-- entity. The audit agent reads incoming proposals from here.
--
-- Two preconditions:
--
--   1. Both atlas + market orgs exist (rename + create scripts ran).
--   2. The `_proposal_inbox` entity type is registered in each org. The
--      backend creates it the first time the entity-type editor runs against
--      `examples/{atlas,market}/models/_proposal_inbox.yaml`. Until that
--      registration step runs, this script will exit cleanly without
--      creating sentinels — re-run after registration to finish provisioning.
--
-- Verification:
--   SELECT o.slug, e.slug, e.name
--   FROM entities e
--   JOIN entity_types et ON et.id = e.entity_type_id
--   JOIN organization o ON o.id = e.organization_id
--   WHERE et.slug = '_proposal_inbox' AND e.deleted_at IS NULL;

DO $$
DECLARE
  org_slug text;
  org_id text;
  type_id integer;
  owner_user_id text;
BEGIN
  FOR org_slug IN SELECT unnest(ARRAY['atlas', 'market']) LOOP
    SELECT id INTO org_id FROM "organization" WHERE slug = org_slug;
    IF org_id IS NULL THEN
      RAISE NOTICE 'Skipping proposal-inbox seed for "%": org not found.', org_slug;
      CONTINUE;
    END IF;

    SELECT id INTO type_id
    FROM entity_types
    WHERE slug = '_proposal_inbox'
      AND organization_id = org_id
      AND deleted_at IS NULL
    LIMIT 1;
    IF type_id IS NULL THEN
      RAISE NOTICE
        'Skipping proposal-inbox seed for "%": entity type not registered yet. '
        'Run the entity-type editor against examples/%/models/_proposal_inbox.yaml then re-run this script.',
        org_slug, org_slug;
      CONTINUE;
    END IF;

    -- Skip if a sentinel already exists for this org+type.
    IF EXISTS (
      SELECT 1 FROM entities
      WHERE entity_type_id = type_id
        AND organization_id = org_id
        AND slug = '_proposal_inbox'
        AND deleted_at IS NULL
    ) THEN
      RAISE NOTICE 'Proposal inbox already exists for "%".', org_slug;
      CONTINUE;
    END IF;

    -- entities.created_by is NOT NULL — borrow the org's owner.
    SELECT m."userId" INTO owner_user_id
    FROM "member" m
    WHERE m."organizationId" = org_id AND m.role = 'owner'
    ORDER BY m."createdAt" ASC
    LIMIT 1;
    IF owner_user_id IS NULL THEN
      RAISE EXCEPTION
        'Cannot seed proposal inbox for "%": no owner member found. '
        'Bootstrap the org first.', org_slug;
    END IF;

    INSERT INTO entities (
      organization_id, entity_type_id, slug, name, metadata, created_by
    ) VALUES (
      org_id,
      type_id,
      '_proposal_inbox',
      'Proposal Inbox',
      '{"system": true}'::jsonb,
      owner_user_id
    );
    RAISE NOTICE 'Seeded proposal inbox for "%".', org_slug;
  END LOOP;
END $$;
