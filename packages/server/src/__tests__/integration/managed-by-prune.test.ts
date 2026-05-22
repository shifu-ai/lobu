/**
 * Code-managed prune — server-side gate.
 *
 * `lobu apply --manage` flips an org to code-managed; subsequent applies delete
 * definitions removed from `lobu.config.ts` (see packages/cli/.../apply/diff.ts
 * computeDiff({ codeManaged })). This suite verifies the destructive half that
 * the CLI depends on, against a real Postgres:
 *   - the migration adds organization.managed_by defaulting to 'ui' (no org
 *     starts prunable — the 2026-05-20 safety lesson), constrained to ui|code;
 *   - /oauth/userinfo surfaces managed_by (the CLI's listOrgs read path);
 *   - definition deletes work (entity/relationship type, watcher);
 *   - an entity-type delete REFUSES while instances exist, so prune can never
 *     cascade into data (data is exempt).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { OAuthProvider } from '../../auth/oauth/provider';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestAgent,
  createTestEntity,
  createTestOAuthClient,
  createTestOrganization,
  createTestUser,
} from '../setup/test-fixtures';
import { TestApiClient } from '../setup/test-mcp-client';

describe('code-managed prune (server gate)', () => {
  let owner: TestApiClient;
  let orgId: string;
  let userId: string;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Prune Test Org' });
    orgId = org.id;
    const user = await createTestUser({ email: 'prune-owner@test.com' });
    userId = user.id;
    await addUserToOrganization(userId, orgId, 'owner');
    owner = await TestApiClient.for({
      organizationId: orgId,
      userId,
      memberRole: 'owner',
    });
  });

  describe('migration: organization.managed_by', () => {
    it('defaults a fresh org to ui (no org starts prunable)', async () => {
      const sql = getTestDb();
      const [row] = await sql<{ managed_by: string }[]>`
        SELECT managed_by FROM "organization" WHERE id = ${orgId}
      `;
      expect(row?.managed_by).toBe('ui');
    });

    it('accepts code and rejects any other value via the CHECK constraint', async () => {
      const sql = getTestDb();
      await sql`UPDATE "organization" SET managed_by = 'code' WHERE id = ${orgId}`;
      const [row] = await sql<{ managed_by: string }[]>`
        SELECT managed_by FROM "organization" WHERE id = ${orgId}
      `;
      expect(row?.managed_by).toBe('code');
      await expect(
        sql`UPDATE "organization" SET managed_by = 'bogus' WHERE id = ${orgId}`
      ).rejects.toThrow();
      // Restore for the userinfo assertion below.
      await sql`UPDATE "organization" SET managed_by = 'code' WHERE id = ${orgId}`;
    });
  });

  describe('userinfo exposes managed_by (CLI listOrgs read path)', () => {
    it('returns the org provenance the CLI reads to decide codeManaged', async () => {
      const client = await createTestOAuthClient({ client_name: 'Prune CLI' });
      const { token } = await createTestAccessToken(
        userId,
        orgId,
        client.client_id,
        { scope: 'profile:read' }
      );
      const provider = new OAuthProvider(getTestDb(), 'http://localhost:8787');
      const info = await provider.getUserInfo(token);
      const org = info?.organizations.find((o) => o.id === orgId);
      expect(org?.managed_by).toBe('code');
    });
  });

  describe('definition deletes (prune targets)', () => {
    it('deletes an entity type with no instances', async () => {
      await owner.entity_schema.createType({ slug: 'prune-empty', name: 'Empty' });
      await owner.entity_schema.deleteType('prune-empty');
      const got = (await owner.entity_schema.getType('prune-empty')) as {
        entity_type: unknown;
      };
      expect(got.entity_type).toBeNull();
    });

    it('refuses to delete an entity type while instances exist (data is exempt)', async () => {
      await owner.entity_schema.createType({ slug: 'prune-busy', name: 'Busy' });
      await createTestEntity({
        name: 'A live instance',
        entity_type: 'prune-busy',
        organization_id: orgId,
      });
      await expect(
        owner.entity_schema.deleteType('prune-busy')
      ).rejects.toThrow(/entities of this type exist|cannot delete/i);
    });

    it('deletes a relationship type with no instances', async () => {
      await owner.entity_schema.createRelType({ slug: 'prune-rel', name: 'Rel' });
      await owner.entity_schema.deleteRelType('prune-rel');
      const list = (await owner.entity_schema.listTypes()) as {
        relationship_types?: Array<{ slug: string }>;
      };
      expect(
        (list.relationship_types ?? []).some((r) => r.slug === 'prune-rel')
      ).toBe(false);
    });

    it('refuses to delete a relationship type while instances exist (data is exempt)', async () => {
      const sql = getTestDb();
      await owner.entity_schema.createRelType({
        slug: 'prune-rel-busy',
        name: 'Busy Rel',
      });
      const [rt] = await sql<{ id: number }[]>`
        SELECT id FROM entity_relationship_types
        WHERE slug = ${'prune-rel-busy'} AND organization_id = ${orgId}
          AND deleted_at IS NULL
        LIMIT 1
      `;
      const a = await createTestEntity({
        name: 'Rel Source',
        entity_type: 'prune-rel-from',
        organization_id: orgId,
      });
      const b = await createTestEntity({
        name: 'Rel Target',
        entity_type: 'prune-rel-to',
        organization_id: orgId,
      });
      await sql`
        INSERT INTO entity_relationships
          (organization_id, from_entity_id, to_entity_id, relationship_type_id, created_by)
        VALUES (${orgId}, ${a.id}, ${b.id}, ${rt?.id}, ${userId})
      `;
      await expect(
        owner.entity_schema.deleteRelType('prune-rel-busy')
      ).rejects.toThrow(/relationships of this type exist|cannot delete/i);
    });

    it('a foreign public rel-type with the same slug does not block the org owning/managing its own', async () => {
      const sql = getTestDb();
      // A different org, public, with a relationship type sharing the slug.
      const other = await createTestOrganization({
        name: 'Public Other',
        visibility: 'public',
      });
      await sql`
        INSERT INTO entity_relationship_types (organization_id, slug, name, status, created_at, updated_at)
        VALUES (${other.id}, ${'shared-rel'}, 'Foreign Shared', 'active', NOW(), NOW())
      `;
      // This org can still CREATE its own same-slug type (org-scoped dup check).
      await owner.entity_schema.createRelType({
        slug: 'shared-rel',
        name: 'My Shared',
      });
      // ...and DELETE resolves THIS org's own row (tenant-first), not the
      // foreign public one (which would otherwise raise access-denied).
      await owner.entity_schema.deleteRelType('shared-rel');
      // The foreign public row is untouched.
      const [foreign] = await sql<{ deleted_at: string | null }[]>`
        SELECT deleted_at FROM entity_relationship_types
        WHERE organization_id = ${other.id} AND slug = ${'shared-rel'}
      `;
      expect(foreign?.deleted_at).toBeNull();
    });

    it('deletes a watcher', async () => {
      const agent = await createTestAgent({ organizationId: orgId });
      const created = (await owner.watchers.create({
        slug: 'prune-watcher',
        agent_id: agent.agentId,
        prompt: 'Watch for things.',
        extraction_schema: {
          type: 'object',
          properties: { thing: { type: 'string' } },
        },
      })) as { watcher_id?: string };
      expect(created.watcher_id).toBeTruthy();

      await owner.watchers.delete(created.watcher_id as string);
      const list = (await owner.watchers.list({})) as {
        watchers?: Array<{ slug: string }>;
      };
      expect((list.watchers ?? []).some((w) => w.slug === 'prune-watcher')).toBe(
        false
      );
    });
  });
});
