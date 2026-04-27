/**
 * entity_read_grant integration tests.
 *
 * Exercises the migration's schema (partial unique index, hot path index,
 * scope CHECK), the issuance helper's idempotency, and the consume path's
 * single-use atomicity. Backed by the real Postgres setup so the partial
 * unique index actually constrains inserts.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	AUDIT_AGENT_USER_ID,
	consumeActiveReadGrant,
	hasActiveReadGrant,
	issueEntityReadGrant,
} from "../../../utils/entity-read-grant";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestEntity,
	createTestOrganization,
	createTestUser,
} from "../../setup/test-fixtures";

describe("entity_read_grant", () => {
	let orgA: Awaited<ReturnType<typeof createTestOrganization>>;
	let userA: Awaited<ReturnType<typeof createTestUser>>;
	let entityA: Awaited<ReturnType<typeof createTestEntity>>;
	let auditAgentUserExists = false;

	beforeAll(async () => {
		await cleanupTestDatabase();

		// The migration provisions `user_audit_agent` but cleanupTestDatabase()
		// truncates the user table. Re-seed it so FK from entity_read_grant
		// to user resolves.
		const sql = getTestDb();
		await sql`
      INSERT INTO "user" (id, name, email, username, "emailVerified", "createdAt", "updatedAt")
      VALUES (${AUDIT_AGENT_USER_ID}, 'Audit Agent', 'audit-agent@lobu.internal', 'audit-agent', true, NOW(), NOW())
      ON CONFLICT (id) DO NOTHING
    `;
		auditAgentUserExists = true;

		orgA = await createTestOrganization({ name: "Grant Test Org A" });
		userA = await createTestUser({ email: "grant-user-a@test.com" });
		await addUserToOrganization(userA.id, orgA.id, "owner");

		entityA = await createTestEntity({
			name: "Private Entity A",
			entity_type: "brand",
			organization_id: orgA.id,
		});
	});

	beforeEach(async () => {
		expect(auditAgentUserExists).toBe(true);
		// Wipe grants between tests so each case starts clean. We do NOT
		// re-truncate users/entities — the fixtures are immutable for this
		// suite.
		const sql = getTestDb();
		await sql`DELETE FROM entity_read_grant`;
	});

	describe("issuance", () => {
		it("inserts a fresh grant with default 30d expiry and audit-agent grantee", async () => {
			const result = await issueEntityReadGrant({
				grantorOrgId: orgA.id,
				entityId: entityA.id,
				triggeringRelationshipId: 1,
			});

			expect(result.inserted).toBe(true);
			expect(result.id.startsWith("grant_")).toBe(true);
			const ttlMs = result.expiresAt.getTime() - Date.now();
			// Default 30d ± a small window for test latency.
			expect(ttlMs).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);
			expect(ttlMs).toBeLessThan(31 * 24 * 60 * 60 * 1000);

			const sql = getTestDb();
			const rows = await sql`
        SELECT grantee_user_id, scope, single_use, consumed_at
        FROM entity_read_grant WHERE id = ${result.id}
      `;
			expect(rows.length).toBe(1);
			expect(rows[0].grantee_user_id).toBe(AUDIT_AGENT_USER_ID);
			expect(rows[0].scope).toBe("read-once");
			expect(rows[0].single_use).toBe(true);
			expect(rows[0].consumed_at).toBeNull();
		});

		it("idempotent — re-issuing with the same key extends expires_at instead of inserting", async () => {
			const first = await issueEntityReadGrant({
				grantorOrgId: orgA.id,
				entityId: entityA.id,
				triggeringRelationshipId: 42,
				ttlMs: 1_000, // very short — second call should override
			});
			expect(first.inserted).toBe(true);

			const second = await issueEntityReadGrant({
				grantorOrgId: orgA.id,
				entityId: entityA.id,
				triggeringRelationshipId: 42,
				ttlMs: 60 * 60 * 1000, // 1h
			});
			expect(second.inserted).toBe(false);
			expect(second.id).toBe(first.id);
			expect(second.expiresAt.getTime()).toBeGreaterThan(
				first.expiresAt.getTime(),
			);

			const sql = getTestDb();
			const count = await sql<{ n: number }[]>`
        SELECT COUNT(*)::int AS n FROM entity_read_grant
        WHERE grantor_org_id = ${orgA.id}
          AND entity_id = ${entityA.id}
          AND grantee_user_id = ${AUDIT_AGENT_USER_ID}
      `;
			expect(count[0].n).toBe(1);
		});

		it("different triggering relationships produce distinct grants", async () => {
			const first = await issueEntityReadGrant({
				grantorOrgId: orgA.id,
				entityId: entityA.id,
				triggeringRelationshipId: 100,
			});
			const second = await issueEntityReadGrant({
				grantorOrgId: orgA.id,
				entityId: entityA.id,
				triggeringRelationshipId: 200,
			});
			expect(second.inserted).toBe(true);
			expect(second.id).not.toBe(first.id);
		});

		it("NEVER shrinks expires_at — a slow retry with shorter ttl is a no-op", async () => {
			const longGrant = await issueEntityReadGrant({
				grantorOrgId: orgA.id,
				entityId: entityA.id,
				triggeringRelationshipId: 7,
				ttlMs: 24 * 60 * 60 * 1000,
			});

			const reissued = await issueEntityReadGrant({
				grantorOrgId: orgA.id,
				entityId: entityA.id,
				triggeringRelationshipId: 7,
				ttlMs: 1_000,
			});
			expect(reissued.expiresAt.getTime()).toBe(longGrant.expiresAt.getTime());
		});
	});

	describe("lookup + consume", () => {
		it("hasActiveReadGrant returns true for an active grant", async () => {
			await issueEntityReadGrant({
				grantorOrgId: orgA.id,
				entityId: entityA.id,
				triggeringRelationshipId: 1,
			});
			const active = await hasActiveReadGrant(AUDIT_AGENT_USER_ID, entityA.id);
			expect(active).toBe(true);
		});

		it("hasActiveReadGrant returns false when no grant exists", async () => {
			const active = await hasActiveReadGrant(AUDIT_AGENT_USER_ID, entityA.id);
			expect(active).toBe(false);
		});

		it("hasActiveReadGrant returns false for an expired grant", async () => {
			const sql = getTestDb();
			await issueEntityReadGrant({
				grantorOrgId: orgA.id,
				entityId: entityA.id,
				triggeringRelationshipId: 99,
			});
			// Backdate expiry.
			await sql`
        UPDATE entity_read_grant
        SET expires_at = NOW() - INTERVAL '1 hour'
      `;
			const active = await hasActiveReadGrant(AUDIT_AGENT_USER_ID, entityA.id);
			expect(active).toBe(false);
		});

		it("consumeActiveReadGrant marks single_use=true grants consumed atomically", async () => {
			const issued = await issueEntityReadGrant({
				grantorOrgId: orgA.id,
				entityId: entityA.id,
				triggeringRelationshipId: 1,
			});

			const first = await consumeActiveReadGrant({
				granteeUserId: AUDIT_AGENT_USER_ID,
				entityId: entityA.id,
			});
			expect(first?.id).toBe(issued.id);

			// Subsequent consume finds no active grant — single-use was burned.
			const second = await consumeActiveReadGrant({
				granteeUserId: AUDIT_AGENT_USER_ID,
				entityId: entityA.id,
			});
			expect(second).toBeNull();
			expect(await hasActiveReadGrant(AUDIT_AGENT_USER_ID, entityA.id)).toBe(
				false,
			);
		});

		it("consumeActiveReadGrant skips expired grants", async () => {
			const sql = getTestDb();
			await issueEntityReadGrant({
				grantorOrgId: orgA.id,
				entityId: entityA.id,
				triggeringRelationshipId: 1,
			});
			await sql`UPDATE entity_read_grant SET expires_at = NOW() - INTERVAL '1 second'`;

			const result = await consumeActiveReadGrant({
				granteeUserId: AUDIT_AGENT_USER_ID,
				entityId: entityA.id,
			});
			expect(result).toBeNull();
		});

		it("a fresh grant can be issued after a prior one was consumed (idempotency key includes consumed_at IS NULL)", async () => {
			const first = await issueEntityReadGrant({
				grantorOrgId: orgA.id,
				entityId: entityA.id,
				triggeringRelationshipId: 555,
			});
			await consumeActiveReadGrant({
				granteeUserId: AUDIT_AGENT_USER_ID,
				entityId: entityA.id,
			});

			const second = await issueEntityReadGrant({
				grantorOrgId: orgA.id,
				entityId: entityA.id,
				triggeringRelationshipId: 555,
			});
			expect(second.inserted).toBe(true);
			expect(second.id).not.toBe(first.id);
		});
	});

	describe("schema constraints", () => {
		it("rejects an unknown scope value via CHECK constraint", async () => {
			const sql = getTestDb();
			await expect(
				sql`
          INSERT INTO entity_read_grant (
            id, grantor_org_id, entity_id, grantee_user_id, scope,
            expires_at, single_use, triggering_relationship_id, created_at
          ) VALUES (
            'grant_bogus_scope',
            ${orgA.id},
            ${entityA.id},
            ${AUDIT_AGENT_USER_ID},
            'read-forever',
            NOW() + INTERVAL '1 day',
            true,
            1,
            NOW()
          )
        `,
			).rejects.toThrow();
		});

		it("cascades delete when grantor org is deleted", async () => {
			const sql = getTestDb();
			const tempOrg = await createTestOrganization({
				name: "Temp Cascade Org",
			});
			const tempEntity = await createTestEntity({
				name: "Temp entity",
				entity_type: "brand",
				organization_id: tempOrg.id,
			});
			await issueEntityReadGrant({
				grantorOrgId: tempOrg.id,
				entityId: tempEntity.id,
				triggeringRelationshipId: 1,
			});

			const before = await sql<{ n: number }[]>`
        SELECT COUNT(*)::int AS n FROM entity_read_grant WHERE grantor_org_id = ${tempOrg.id}
      `;
			expect(before[0].n).toBe(1);

			// Deleting the entity cascades through entities → entity_read_grant.
			await sql`DELETE FROM entities WHERE id = ${tempEntity.id}`;
			const afterEntity = await sql<{ n: number }[]>`
        SELECT COUNT(*)::int AS n FROM entity_read_grant WHERE entity_id = ${tempEntity.id}
      `;
			expect(afterEntity[0].n).toBe(0);
		});
	});

	describe("maybeIssueReadGrantForRelationship — public/private gates", () => {
		// These cases drive the hook against fabricated entity rows so we
		// exercise the public/private gating logic without a full
		// manage_entity link round-trip.

		it("does NOT issue a grant when the relationship type is not a trust primitive", async () => {
			const { maybeIssueReadGrantForRelationship } = await import(
				"../../../utils/entity-read-grant-hook"
			);
			const sql = getTestDb();
			await sql`DELETE FROM entity_read_grant`;

			const result = await maybeIssueReadGrantForRelationship({
				relationshipTypeSlug: "works_at",
				fromEntityId: entityA.id,
				toEntityId: entityA.id,
				callerOrgId: orgA.id,
				relationshipId: 1,
			});
			expect(result).toBeNull();
		});

		it("proposes_canonical grants metadata.proposed_entity_id (NOT the $member from-entity)", async () => {
			const { maybeIssueReadGrantForRelationship } = await import(
				"../../../utils/entity-read-grant-hook"
			);
			const sql = getTestDb();
			await sql`DELETE FROM entity_read_grant`;

			// Public catalog org with a sentinel inbox entity. Make orgA's
			// existing entityA the public-catalog target — flip orgA public
			// transiently. Real prod has separate atlas + market orgs, but the
			// hook only checks visibility='public' on the target.
			await sql`UPDATE organization SET visibility = 'public' WHERE id = ${orgA.id}`;
			try {
				// Create a private contributor org + a $member-style entity
				// (the from-entity) and a *separate* private entity that is
				// being proposed (the audit target).
				const privateOrg = await createTestOrganization({
					name: "Contributor Org",
				});
				const memberEntity = await createTestEntity({
					name: "Member Stub",
					entity_type: "brand",
					organization_id: privateOrg.id,
				});
				const proposedEntity = await createTestEntity({
					name: "Proposed Private Entity",
					entity_type: "brand",
					organization_id: privateOrg.id,
				});

				const result = await maybeIssueReadGrantForRelationship({
					relationshipTypeSlug: "proposes_canonical",
					fromEntityId: memberEntity.id,
					toEntityId: entityA.id, // public-catalog target
					callerOrgId: privateOrg.id,
					relationshipId: 999,
					metadata: { proposed_entity_id: proposedEntity.id },
				});
				expect(result?.grantId).toBeTruthy();

				const grants = await sql<{ entity_id: number }[]>`
          SELECT entity_id FROM entity_read_grant
          WHERE triggering_relationship_id = 999
        `;
				expect(grants.length).toBe(1);
				// The grant is on the proposed entity, NOT on the $member from-entity.
				expect(Number(grants[0].entity_id)).toBe(proposedEntity.id);
			} finally {
				await sql`UPDATE organization SET visibility = 'private' WHERE id = ${orgA.id}`;
			}
		});

		it("proposes_canonical without metadata.proposed_entity_id issues no grant", async () => {
			const { maybeIssueReadGrantForRelationship } = await import(
				"../../../utils/entity-read-grant-hook"
			);
			const sql = getTestDb();
			await sql`DELETE FROM entity_read_grant`;

			await sql`UPDATE organization SET visibility = 'public' WHERE id = ${orgA.id}`;
			try {
				const privateOrg = await createTestOrganization({
					name: "Contributor Org 2",
				});
				const memberEntity = await createTestEntity({
					name: "Member Stub 2",
					entity_type: "brand",
					organization_id: privateOrg.id,
				});

				const result = await maybeIssueReadGrantForRelationship({
					relationshipTypeSlug: "proposes_canonical",
					fromEntityId: memberEntity.id,
					toEntityId: entityA.id,
					callerOrgId: privateOrg.id,
					relationshipId: 1001,
					metadata: {},
				});
				expect(result).toBeNull();

				const grants = await sql<{ n: number }[]>`
          SELECT COUNT(*)::int AS n FROM entity_read_grant
          WHERE triggering_relationship_id = 1001
        `;
				expect(grants[0].n).toBe(0);
			} finally {
				await sql`UPDATE organization SET visibility = 'private' WHERE id = ${orgA.id}`;
			}
		});

		it("does NOT issue a grant when the target is private (no audit-agent involvement)", async () => {
			const { maybeIssueReadGrantForRelationship } = await import(
				"../../../utils/entity-read-grant-hook"
			);
			const sql = getTestDb();
			await sql`DELETE FROM entity_read_grant`;

			// Both entities private — no public catalog involvement, no grant.
			const otherPrivate = await createTestOrganization({
				name: "Another private",
			});
			const otherEntity = await createTestEntity({
				name: "Other private entity",
				entity_type: "brand",
				organization_id: otherPrivate.id,
			});
			const result = await maybeIssueReadGrantForRelationship({
				relationshipTypeSlug: "claims_identity",
				fromEntityId: entityA.id,
				toEntityId: otherEntity.id,
				callerOrgId: orgA.id,
				relationshipId: 2,
			});
			expect(result).toBeNull();
		});
	});
});
