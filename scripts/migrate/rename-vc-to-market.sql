-- Phase 1: rename venture-capital → market
--
-- Run this after the schema/code rename PR merges, before atlas creation
-- (`create-atlas-org.sql`). Idempotent — re-running is a no-op once the
-- slug has flipped.
--
-- Foreign keys to `organization` are by id, so entity / member / event /
-- relationship rows are untouched. Only the org's slug + name change.
--
-- Collision: `organization.slug` is UNIQUE. If both `venture-capital`
-- AND `market` exist (e.g. someone hand-created `market` in between
-- merges) the UPDATE would otherwise raise a unique-violation. The DO
-- block fails loud and helpful instead, so the operator knows to
-- reconcile before retrying.
--
-- Verification:
--   SELECT id, slug, name FROM organization WHERE slug IN ('venture-capital', 'market');
--   SELECT COUNT(*) FROM entities
--     WHERE organization_id = (SELECT id FROM organization WHERE slug='market');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM organization WHERE slug = 'market')
     AND EXISTS (SELECT 1 FROM organization WHERE slug = 'venture-capital') THEN
    RAISE EXCEPTION
      'Both venture-capital and market exist; manual reconciliation required '
      '(decide which org is canonical, migrate data off the other, drop it, '
      'then re-run this script).';
  END IF;

  UPDATE organization
  SET slug = 'market',
      name = 'Market'
  WHERE slug = 'venture-capital';
END $$;
