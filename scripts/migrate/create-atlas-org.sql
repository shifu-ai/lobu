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
-- ID strategy: org and member IDs are non-deterministic (`org_<8-hex>`,
-- `member_<8-hex>`) to match the pattern used by
-- `ensurePersonalOrganization` in `packages/owletto-backend/src/auth/
-- personal-org-provisioning.ts:151-163`. We look up by slug (`atlas`)
-- after insert rather than relying on a fixed primary key, so a partial
-- prior run that left a row with a clashing id can't silently shadow
-- this seed.
--
-- A bootstrap `owner` member is provisioned for atlas, sourcing the
-- userId from the (just-renamed) `market` org's owner so the same human
-- controls both public catalogs. Without a member row atlas would be
-- unmanageable — the entity-type editor + curator agent both require an
-- authenticated owner.
--
-- Verification:
--   SELECT id, slug, name, visibility FROM organization WHERE slug = 'atlas';
--   SELECT m.id, m."userId", m.role
--     FROM "member" m
--     JOIN "organization" o ON m."organizationId" = o.id
--     WHERE o.slug = 'atlas';

DO $$
DECLARE
  atlas_org_id text;
  market_owner_user_id text;
BEGIN
  -- 1. Insert atlas org if missing. Look up by slug — id is non-deterministic.
  SELECT id INTO atlas_org_id FROM "organization" WHERE slug = 'atlas';

  IF atlas_org_id IS NULL THEN
    atlas_org_id := 'org_' || substr(md5(random()::text || clock_timestamp()::text), 1, 8);
    INSERT INTO "organization" (id, name, slug, visibility, "createdAt")
    VALUES (atlas_org_id, 'Atlas', 'atlas', 'public', NOW());
  END IF;

  -- 2. Provision a bootstrap owner member if atlas has none, sourcing the
  --    user from the market org's owner.
  IF NOT EXISTS (
    SELECT 1 FROM "member" WHERE "organizationId" = atlas_org_id
  ) THEN
    SELECT m."userId" INTO market_owner_user_id
    FROM "member" m
    JOIN "organization" o ON m."organizationId" = o.id
    WHERE o.slug = 'market' AND m.role = 'owner'
    ORDER BY m."createdAt" ASC
    LIMIT 1;

    IF market_owner_user_id IS NULL THEN
      RAISE EXCEPTION
        'Cannot bootstrap atlas owner: no owner found on market org. '
        'Run rename-vc-to-market.sql first and ensure the market org has an owner member.';
    END IF;

    INSERT INTO "member" (id, "userId", "organizationId", role, "createdAt")
    VALUES (
      'member_' || substr(md5(random()::text || clock_timestamp()::text), 1, 8),
      market_owner_user_id,
      atlas_org_id,
      'owner',
      NOW()
    );
  END IF;
END $$;
