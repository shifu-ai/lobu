-- Phase 1: create the public `atlas` org
--
-- Run AFTER `rename-vc-to-market.sql`. Idempotent — re-running is a no-op.
--
-- Atlas is a slow-churn reference catalog (countries, cities, regions,
-- industries, technologies, universities). It sits next to `market` as a
-- public sibling org so other catalogs can reference it via cross-org
-- relationships.
--
-- Entity types (country, city, region, industry, technology, university)
-- are registered separately by the backend the first time the org's
-- entity-type editor runs against the YAML in `examples/atlas/models/`.
-- Data seeding (countries, cities, etc.) is a Phase 2 PR.
--
-- Verification:
--   SELECT id, slug, name, visibility FROM organization WHERE slug = 'atlas';

INSERT INTO "organization" (id, name, slug, visibility, "createdAt")
SELECT
  'org_atlas',
  'Atlas',
  'atlas',
  'public',
  NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM "organization" WHERE slug = 'atlas'
);
