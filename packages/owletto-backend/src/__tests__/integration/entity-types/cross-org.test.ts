/**
 * Cross-Org Schema Behavior Tests
 *
 * Covers the read-side widenings landed in #386, the read-mode
 * `requireRelationshipType` follow-up in #399, and the cross-org
 * schema-validation fix (`utils/schema-validation.ts`).
 *
 * Invariants exercised:
 * - `manage_entity_schema list/get` returns rows from caller's org and
 *   any `visibility=public` org, with `organization_slug` populated and
 *   tenant-first ordering.
 * - `$member` is per-tenant: cross-org public `$member` rows never
 *   appear in entity_type `get`, even though other types do.
 * - `list_rules` resolves rules on a cross-org public relationship type
 *   (read mode); mutating actions (`add_rule`) still 403.
 * - When a tenant entity carries a cross-org public type, metadata
 *   validation uses the catalog's schema, not the caller's empty schema.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestOAuthClient,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';
import { mcpToolsCall } from '../../setup/test-helpers';

describe('Cross-org schema reads', () => {
  let tenant: Awaited<ReturnType<typeof createTestOrganization>>;
  let publicCatalog: Awaited<ReturnType<typeof createTestOrganization>>;
  let user: Awaited<ReturnType<typeof createTestUser>>;
  let token: string;

  beforeAll(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    tenant = await createTestOrganization({ name: 'Tenant', visibility: 'private' });
    publicCatalog = await createTestOrganization({
      name: 'Public Catalog',
      slug: `public-catalog-${Date.now()}`,
      visibility: 'public',
    });

    user = await createTestUser({ email: 'crossorg-user@test.com' });
    await addUserToOrganization(user.id, tenant.id, 'owner');

    const client = await createTestOAuthClient();
    const result = await createTestAccessToken(user.id, tenant.id, client.client_id);
    token = result.token;

    // Seed a tenant-local type and a public-catalog type with a real
    // metadata_schema so the validation test has something to enforce.
    const sql = getTestDb();
    await sql`
      INSERT INTO entity_types (organization_id, slug, name, created_at, updated_at)
      VALUES (${tenant.id}, 'tenant-thing', 'Tenant Thing', current_timestamp, current_timestamp)
    `;
    await sql`
      INSERT INTO entity_types (organization_id, slug, name, metadata_schema, created_at, updated_at)
      VALUES (
        ${publicCatalog.id},
        'catalog-canonical',
        'Catalog Canonical',
        ${sql.json({
          type: 'object',
          properties: {
            ticker: { type: 'string', minLength: 1 },
          },
          required: ['ticker'],
          additionalProperties: false,
        })},
        current_timestamp,
        current_timestamp
      )
    `;
  });

  describe('manage_entity_schema action="list"', () => {
    it('returns local types first, then cross-org public-catalog types, each with organization_slug', async () => {
      const result = await mcpToolsCall(
        'manage_entity_schema',
        { schema_type: 'entity_type', action: 'list' },
        { token }
      );

      expect(result.action).toBe('list');
      const local = result.entity_types.find((t: any) => t.slug === 'tenant-thing');
      const crossOrg = result.entity_types.find((t: any) => t.slug === 'catalog-canonical');

      expect(local).toBeDefined();
      expect(local.organization_slug).toBe(tenant.slug);

      expect(crossOrg).toBeDefined();
      expect(crossOrg.organization_slug).toBe(publicCatalog.slug);
      expect(crossOrg.organization_id).toBe(publicCatalog.id);

      // Tenant rows must come before cross-org rows in the response.
      const localIdx = result.entity_types.findIndex((t: any) => t.slug === 'tenant-thing');
      const crossIdx = result.entity_types.findIndex((t: any) => t.slug === 'catalog-canonical');
      expect(localIdx).toBeLessThan(crossIdx);
    });
  });

  describe('manage_entity_schema action="get"', () => {
    it('resolves a cross-org public-catalog entity type and surfaces organization_slug', async () => {
      const result = await mcpToolsCall(
        'manage_entity_schema',
        { schema_type: 'entity_type', action: 'get', slug: 'catalog-canonical' },
        { token }
      );
      expect(result.entity_type).not.toBeNull();
      expect(result.entity_type.slug).toBe('catalog-canonical');
      expect(result.entity_type.organization_slug).toBe(publicCatalog.slug);
      expect(result.entity_type.organization_id).toBe(publicCatalog.id);
    });

    it('does not return a public-catalog $member; auto-provisions one in the caller tenant org', async () => {
      // Seed a public-catalog $member type (these exist in real catalogs
      // because users join public orgs).
      const sql = getTestDb();
      await sql`
        INSERT INTO entity_types (organization_id, slug, name, created_at, updated_at)
        VALUES (${publicCatalog.id}, '$member', 'Member', current_timestamp, current_timestamp)
        ON CONFLICT DO NOTHING
      `;

      const result = await mcpToolsCall(
        'manage_entity_schema',
        { schema_type: 'entity_type', action: 'get', slug: '$member' },
        { token }
      );
      expect(result.entity_type).not.toBeNull();
      // Tenant's own $member, never the catalog's, even though the
      // catalog row exists and is visibility=public.
      expect(result.entity_type.organization_id).toBe(tenant.id);
    });

    it('orders tenant-first when a slug exists in both the caller org and a public catalog', async () => {
      const sql = getTestDb();
      // Insert a colliding slug in both: tenant's row should win.
      await sql`
        INSERT INTO entity_types (organization_id, slug, name, created_at, updated_at)
        VALUES (${tenant.id}, 'collision-slug', 'Tenant Version', current_timestamp, current_timestamp)
      `;
      await sql`
        INSERT INTO entity_types (organization_id, slug, name, created_at, updated_at)
        VALUES (${publicCatalog.id}, 'collision-slug', 'Catalog Version', current_timestamp, current_timestamp)
      `;

      const result = await mcpToolsCall(
        'manage_entity_schema',
        { schema_type: 'entity_type', action: 'get', slug: 'collision-slug' },
        { token }
      );
      expect(result.entity_type.organization_id).toBe(tenant.id);
      expect(result.entity_type.name).toBe('Tenant Version');
    });
  });

  describe('relationship_type list_rules cross-org (read mode, #399)', () => {
    it('lists rules of a public-catalog relationship type without 403', async () => {
      const sql = getTestDb();
      // Seed a relationship type + rule inside the public catalog.
      const [rt] = await sql<{ id: number }[]>`
        INSERT INTO entity_relationship_types (organization_id, slug, name, is_symmetric, status, created_at, updated_at)
        VALUES (
          ${publicCatalog.id},
          'cross-org-rel-type',
          'Catalog Rel Type',
          false,
          'active',
          current_timestamp,
          current_timestamp
        )
        RETURNING id
      `;
      await sql`
        INSERT INTO entity_relationship_type_rules (
          relationship_type_id,
          source_entity_type_slug,
          target_entity_type_slug,
          created_at
        )
        VALUES (
          ${rt.id},
          'catalog-canonical',
          'catalog-canonical',
          current_timestamp
        )
      `;

      const result = await mcpToolsCall(
        'manage_entity_schema',
        {
          schema_type: 'relationship_type',
          action: 'list_rules',
          slug: 'cross-org-rel-type',
        },
        { token }
      );
      expect(result.action).toBe('list_rules');
      expect(Array.isArray(result.rules)).toBe(true);
      expect(result.rules.length).toBeGreaterThan(0);
      expect(result.rules[0].source_entity_type_slug).toBe('catalog-canonical');
    });

    it('still rejects mutations (add_rule) on a public-catalog relationship type', async () => {
      await expect(
        mcpToolsCall(
          'manage_entity_schema',
          {
            schema_type: 'relationship_type',
            action: 'add_rule',
            slug: 'cross-org-rel-type',
            source_entity_type_slug: 'tenant-thing',
            target_entity_type_slug: 'catalog-canonical',
          },
          { token }
        )
      ).rejects.toThrow(/another organization/i);
    });
  });

  describe('manage_entity create with cross-org type validates against catalog schema', () => {
    it('rejects metadata that violates the catalog type\'s schema', async () => {
      // The catalog's `catalog-canonical` type requires `ticker`. A tenant
      // creating an entity of that type without `ticker` should fail
      // validation against the *catalog's* schema, not the empty default.
      await expect(
        mcpToolsCall(
          'manage_entity',
          {
            action: 'create',
            entity_type: 'catalog-canonical',
            name: 'Acme Bank',
            metadata: { not_ticker: 'x' },
          },
          { token }
        )
      ).rejects.toThrow(/ticker|required|metadata/i);
    });

    it('accepts metadata that satisfies the catalog type schema', async () => {
      const result = await mcpToolsCall(
        'manage_entity',
        {
          action: 'create',
          entity_type: 'catalog-canonical',
          name: 'Acme Bank Valid',
          metadata: { ticker: 'ACME' },
        },
        { token }
      );
      expect(result.action).toBe('create');
      // Entity is in the caller's tenant org but uses the catalog's type id.
      expect(result.entity.entity_type).toBe('catalog-canonical');
    });
  });
});
