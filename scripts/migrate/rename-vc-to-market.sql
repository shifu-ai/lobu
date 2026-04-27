-- Phase 1: rename venture-capital → market
--
-- Run this after the schema/code rename PR merges, before atlas creation
-- (`create-atlas-org.sql`). Idempotent — re-running is a no-op once the
-- slug has flipped.
--
-- Foreign keys to `organization` are by id, so entity / member / event /
-- relationship rows are untouched. Only the org's slug + name change.
--
-- Verification:
--   SELECT id, slug, name FROM organization WHERE slug IN ('venture-capital', 'market');
--   SELECT COUNT(*) FROM entities WHERE organization_id = (SELECT id FROM organization WHERE slug='market');

UPDATE organization
SET slug = 'market',
    name = 'Market'
WHERE slug = 'venture-capital';
