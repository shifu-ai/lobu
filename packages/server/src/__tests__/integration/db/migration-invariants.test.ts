/**
 * Migration-invariant guard.
 *
 * The test harness applies the real baseline -> latest migration chain before
 * any test runs (setup/test-db.ts). This suite asserts the load-bearing schema
 * invariants that recent migrations established, so a future migration that
 * silently drops or reshapes one fails CI here rather than in production.
 *
 * Motivated by the 2-week stability audit:
 *  - #1121 reshaped pending-auth uniqueness from org-wide to per-user, scoped to
 *    oauth_account. The functional contract (same user collides, distinct users
 *    run parallel OAuth flows) is the real invariant — pin it, not just the DDL.
 *  - #1069/#1080 added event_embeddings.embedding_model; its absence reopens the
 *    full-corpus recall regression.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { createAuthProfile, PendingAuthConflictError } from '../../../utils/auth-profiles';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestConnectorDefinition,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

describe('migration invariants', () => {
  beforeAll(async () => {
    await cleanupTestDatabase();
  });

  describe('schema (DDL applied by the migration chain)', () => {
    it('has durable course memory head and receipt constraints for multi-replica apply', async () => {
      const sql = getTestDb();
      const tables = await sql`
        SELECT tablename
        FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename IN ('course_memory_heads', 'course_memory_apply_receipts')
        ORDER BY tablename
      `;
      expect(tables.map((row) => row.tablename)).toEqual([
        'course_memory_apply_receipts',
        'course_memory_heads',
      ]);
      const indexes = await sql`
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname IN (
            'course_memory_apply_receipts_org_idempotency_key',
            'course_memory_apply_receipts_org_scope_revision'
          )
        ORDER BY indexname
      `;
      expect(indexes).toHaveLength(2);
      expect(indexes.every((row) => String(row.indexdef).includes('UNIQUE'))).toBe(true);
      expect(String(indexes[0]?.indexdef)).toContain('(organization_id, idempotency_key)');
      expect(String(indexes[1]?.indexdef)).toContain(
        '(organization_id, owner_user_id, agent_id, course_entity_id, requested_revision)'
      );
    });

    it('enforces course memory receipts as append-only at the database layer', async () => {
      const triggers = await getTestDb()`
        SELECT tgname
        FROM pg_trigger
        WHERE tgrelid = 'course_memory_apply_receipts'::regclass
          AND NOT tgisinternal
      `;
      expect(triggers.map((row) => row.tgname)).toContain(
        'trg_course_memory_apply_receipts_append_only'
      );
    });

    it('retains immutable receipts while cascading the mutable head when an agent is deleted', async () => {
      const foreignKeys = await getTestDb()`
        SELECT conname, confdeltype
        FROM pg_constraint
        WHERE conname IN (
          'course_memory_heads_organization_id_agent_id_fkey',
          'course_memory_apply_receipts_organization_id_agent_id_fkey'
        )
        ORDER BY conname
      `;
      expect(foreignKeys).toEqual([
        {
          conname: 'course_memory_heads_organization_id_agent_id_fkey',
          confdeltype: 'c',
        },
      ]);
    });

    it('has the canonical course entity JSONB GIN index',async()=>{const rows=await getTestDb()`SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='events' AND indexname='events_course_entity_ids_gin_idx'`;expect(rows).toHaveLength(1);expect(String(rows[0]?.indexdef)).toContain("metadata -> 'course_entity_ids'");});
    it('the canonical course scope predicate is served by the GIN index',async()=>{const plan=await getTestDb().begin(async(tx)=>{await tx.unsafe('SET LOCAL enable_seqscan = off');return tx.unsafe("EXPLAIN SELECT id FROM events WHERE metadata->'course_entity_ids' ?| ARRAY['course:plan:test']::text[]")});expect(plan.map((row)=>String(row['QUERY PLAN'])).join('\n')).toContain('events_course_entity_ids_gin_idx');});
    it('auth_profiles has the per-user pending oauth_account unique index (#1121)', async () => {
      const sql = getTestDb();
      const rows = await sql<{ indexdef: string }[]>`
        SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'auth_profiles'
          AND indexname = 'auth_profiles_pending_oauth_account_unique'
      `;
      expect(rows).toHaveLength(1);
      const def = rows[0].indexdef;
      expect(def).toContain('UNIQUE');
      // per-user, per-connector, per-provider scope
      for (const col of ['organization_id', 'connector_key', 'provider', 'created_by']) {
        expect(def).toContain(col);
      }
      // partial predicate: only in-flight oauth_account rows
      expect(def).toContain("'pending_auth'");
      expect(def).toContain("'oauth_account'");
    });

    it('the old org-wide auth_profiles_pending_unique index is gone (#1121)', async () => {
      const sql = getTestDb();
      const rows = await sql`
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'auth_profiles'
          AND indexname = 'auth_profiles_pending_unique'
      `;
      expect(rows).toHaveLength(0);
    });

    it('event_embeddings carries the embedding_model stamp column (#1069/#1080)', async () => {
      const sql = getTestDb();
      const rows = await sql`
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'event_embeddings'
          AND column_name = 'embedding_model'
      `;
      expect(rows).toHaveLength(1);
    });
  });

  describe('functional contract: pending oauth_account uniqueness is per-user (#1121)', () => {
    let orgId: string;
    let userA: string;
    let userB: string;
    const connectorKey = 'invariant-oauth-connector';
    const provider = 'google';

    beforeAll(async () => {
      const org = await createTestOrganization({ name: 'Migration Invariant Org' });
      orgId = org.id;
      const a = await createTestUser({ email: 'invariant-user-a@example.com' });
      const b = await createTestUser({ email: 'invariant-user-b@example.com' });
      userA = a.id;
      userB = b.id;
      await addUserToOrganization(userA, orgId, 'member');
      await addUserToOrganization(userB, orgId, 'member');
      await createTestConnectorDefinition({
        key: connectorKey,
        name: 'Invariant OAuth',
        organization_id: orgId,
      });
    });

    async function createPending(createdBy: string) {
      return createAuthProfile({
        organizationId: orgId,
        connectorKey,
        displayName: 'Invariant pending',
        profileKind: 'oauth_account',
        provider,
        status: 'pending_auth',
        createdBy,
      });
    }

    it('a user cannot open two parallel pending flows for the same connector', async () => {
      await createPending(userA);
      await expect(createPending(userA)).rejects.toBeInstanceOf(PendingAuthConflictError);
    });

    it('distinct users CAN run pending flows for the same connector in parallel', async () => {
      const profile = await createPending(userB);
      expect(profile.status).toBe('pending_auth');
      expect(profile.created_by).toBe(userB);
    });
  });
});
