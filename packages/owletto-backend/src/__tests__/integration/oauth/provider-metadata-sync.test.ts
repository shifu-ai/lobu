/**
 * Provider-metadata sync integration tests.
 *
 * Drives `applySyncForUser` (the test seam under the OAuth fetch) against
 * a real Postgres so we exercise relationship upserts, idempotency on
 * re-link, valid_to extension, scope union, and revocation propagation.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	applySyncForUser,
	revokeProviderClaimsForSession,
} from "../../../auth/provider-metadata-sync";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestEntity,
	createTestOrganization,
	createTestUser,
} from "../../setup/test-fixtures";

async function ensureRelationshipType(
	organizationId: string,
	slug: string,
): Promise<number> {
	const sql = getTestDb();
	const existing = await sql<{ id: number }>`
    SELECT id FROM entity_relationship_types
    WHERE organization_id = ${organizationId} AND slug = ${slug} AND deleted_at IS NULL
    LIMIT 1
  `;
	if (existing.length > 0) return Number(existing[0].id);
	const inserted = await sql<{ id: number }>`
    INSERT INTO entity_relationship_types (organization_id, slug, name, created_at, updated_at)
    VALUES (${organizationId}, ${slug}, ${slug}, NOW(), NOW())
    RETURNING id
  `;
	return Number(inserted[0].id);
}

async function ensureMemberType(organizationId: string): Promise<number> {
	const sql = getTestDb();
	const existing = await sql<{ id: number }>`
    SELECT id FROM entity_types
    WHERE organization_id = ${organizationId} AND slug = '$member' AND deleted_at IS NULL
    LIMIT 1
  `;
	if (existing.length > 0) return Number(existing[0].id);
	const inserted = await sql<{ id: number }>`
    INSERT INTO entity_types (organization_id, slug, name, created_at, updated_at)
    VALUES (${organizationId}, '$member', 'Member', NOW(), NOW())
    RETURNING id
  `;
	return Number(inserted[0].id);
}

async function ensureAccountRow(
	id: string,
	userId: string,
	providerId = "google",
): Promise<void> {
	const sql = getTestDb();
	await sql`
    INSERT INTO "account" (id, "accountId", "providerId", "userId", "createdAt", "updatedAt")
    VALUES (${id}, ${id}, ${providerId}, ${userId}, NOW(), NOW())
    ON CONFLICT (id) DO NOTHING
  `;
}

async function createMemberEntity(args: {
	organizationId: string;
	email: string;
	userId: string;
}): Promise<number> {
	const sql = getTestDb();
	const typeId = await ensureMemberType(args.organizationId);
	const inserted = await sql<{ id: number }>`
    INSERT INTO entities (
      organization_id, entity_type_id, slug, name, metadata, created_by, created_at, updated_at
    ) VALUES (
      ${args.organizationId},
      ${typeId},
      ${`member-${args.userId}`},
      ${args.email},
      ${sql.json({ email: args.email })},
      ${args.userId},
      NOW(), NOW()
    )
    RETURNING id
  `;
	return Number(inserted[0].id);
}

describe("provider-metadata sync", () => {
	let marketOrg: Awaited<ReturnType<typeof createTestOrganization>>;
	let privateOrg: Awaited<ReturnType<typeof createTestOrganization>>;
	let user: Awaited<ReturnType<typeof createTestUser>>;
	let memberEntityId: number;
	let founderEntityId: number;
	let companyEntityId: number;
	let claimsIdentityTypeId: number;
	let hasAuthorityTypeId: number;

	beforeAll(async () => {
		await cleanupTestDatabase();

		// 1. Public market org with the trust-primitive relationship types
		//    registered (these live in the public catalog so any private org's
		//    members can use them via the schema-search-path).
		marketOrg = await createTestOrganization({
			name: "Market Public Catalog",
			slug: "market",
			visibility: "public",
		});
		claimsIdentityTypeId = await ensureRelationshipType(
			marketOrg.id,
			"claims_identity",
		);
		hasAuthorityTypeId = await ensureRelationshipType(
			marketOrg.id,
			"has_authority",
		);

		founderEntityId = (
			await createTestEntity({
				name: "Public Founder Alice",
				entity_type: "founder",
				organization_id: marketOrg.id,
			})
		).id;
		companyEntityId = (
			await createTestEntity({
				name: "Acme Corp",
				entity_type: "company",
				organization_id: marketOrg.id,
			})
		).id;

		// 2. Private org with a $member entity for the test user.
		privateOrg = await createTestOrganization({ name: "Private Workspace" });
		user = await createTestUser({ email: "alice@example.com" });
		await addUserToOrganization(user.id, privateOrg.id, "owner");
		memberEntityId = await createMemberEntity({
			organizationId: privateOrg.id,
			email: user.email,
			userId: user.id,
		});
	});

	beforeEach(async () => {
		const sql = getTestDb();
		// Reset relationship state and entity metadata between cases.
		await sql`DELETE FROM entity_relationships`;
		// Reset account rows so each case seeds the ones it needs (mirrors
		// production: a sign-in event creates a fresh account row).
		await sql`DELETE FROM "account"`;
		await sql`UPDATE entities SET metadata = '{}' WHERE id IN (${founderEntityId}, ${companyEntityId})`;
	});

	async function syncWithAccount(args: Parameters<typeof applySyncForUser>[0]) {
		await ensureAccountRow(args.providerSessionId, args.userId, args.provider);
		await applySyncForUser(args);
	}

	it("issues a claims_identity edge when google email matches founder.contact_email", async () => {
		const sql = getTestDb();
		await sql`
      UPDATE entities
      SET metadata = '{"contact_email":"alice@example.com"}'::jsonb
      WHERE id = ${founderEntityId}
    `;

		await syncWithAccount({
			userId: user.id,
			provider: "google",
			metadata: {
				email: "alice@example.com",
				emailVerified: true,
			},
			providerSessionId: "session_aaa",
		});

		const rows = await sql<{ metadata: Record<string, unknown> }>`
      SELECT metadata FROM entity_relationships
      WHERE from_entity_id = ${memberEntityId}
        AND to_entity_id = ${founderEntityId}
        AND relationship_type_id = ${claimsIdentityTypeId}
        AND deleted_at IS NULL
    `;
		expect(rows.length).toBe(1);
		expect(rows[0].metadata.method).toBe("oauth-google");
		expect(rows[0].metadata.evidence_tier).toBe("B");
		expect(rows[0].metadata.provider_session_id).toBe("session_aaa");
		expect(rows[0].metadata.status).toBe("active");
		expect(rows[0].metadata.revoked_at).toBeNull();
	});

	it("skips claims_identity when email is unverified", async () => {
		const sql = getTestDb();
		await sql`
      UPDATE entities
      SET metadata = '{"contact_email":"alice@example.com"}'::jsonb
      WHERE id = ${founderEntityId}
    `;

		await syncWithAccount({
			userId: user.id,
			provider: "google",
			metadata: {
				email: "alice@example.com",
				emailVerified: false,
			},
			providerSessionId: "session_unverified",
		});

		const rows = await sql`
      SELECT id FROM entity_relationships
      WHERE from_entity_id = ${memberEntityId} AND deleted_at IS NULL
    `;
		expect(rows.length).toBe(0);
	});

	it("issues has_authority with default scopes when hosted_domain matches company.primary_domain", async () => {
		const sql = getTestDb();
		await sql`
      UPDATE entities
      SET metadata = '{"primary_domain":"acme.example"}'::jsonb
      WHERE id = ${companyEntityId}
    `;

		await syncWithAccount({
			userId: user.id,
			provider: "google",
			metadata: {
				hostedDomain: "acme.example",
			},
			providerSessionId: "session_workspace",
		});

		const rows = await sql<{ metadata: Record<string, unknown> }>`
      SELECT metadata FROM entity_relationships
      WHERE from_entity_id = ${memberEntityId}
        AND to_entity_id = ${companyEntityId}
        AND relationship_type_id = ${hasAuthorityTypeId}
        AND deleted_at IS NULL
    `;
		expect(rows.length).toBe(1);
		const scopes = rows[0].metadata.scopes as string[];
		expect(scopes).toContain("can_edit_company_profile");
		expect(scopes).toContain("can_publish_job_for_company");
	});

	it("idempotent — re-running with the same session updates valid_to without duplicating", async () => {
		const sql = getTestDb();
		await sql`
      UPDATE entities
      SET metadata = '{"contact_email":"alice@example.com"}'::jsonb
      WHERE id = ${founderEntityId}
    `;
		await syncWithAccount({
			userId: user.id,
			provider: "google",
			metadata: { email: "alice@example.com", emailVerified: true },
			providerSessionId: "session_repeat",
			validToMs: 60_000,
		});
		const first = await sql<{ valid_to: string }>`
      SELECT metadata->>'valid_to' AS valid_to FROM entity_relationships
      WHERE from_entity_id = ${memberEntityId} AND to_entity_id = ${founderEntityId}
    `;

		await syncWithAccount({
			userId: user.id,
			provider: "google",
			metadata: { email: "alice@example.com", emailVerified: true },
			providerSessionId: "session_repeat",
			validToMs: 60 * 60 * 1000,
		});

		const after = await sql<{ valid_to: string; n: number }>`
      SELECT metadata->>'valid_to' AS valid_to,
             COUNT(*) OVER () AS n
      FROM entity_relationships
      WHERE from_entity_id = ${memberEntityId}
        AND to_entity_id = ${founderEntityId}
        AND deleted_at IS NULL
      LIMIT 1
    `;
		expect(Number(after[0].n)).toBe(1);
		expect(new Date(after[0].valid_to).getTime()).toBeGreaterThan(
			new Date(first[0].valid_to).getTime(),
		);
	});

	it("NEVER shrinks valid_to on a slow refresh", async () => {
		const sql = getTestDb();
		await sql`
      UPDATE entities
      SET metadata = '{"contact_email":"alice@example.com"}'::jsonb
      WHERE id = ${founderEntityId}
    `;
		await syncWithAccount({
			userId: user.id,
			provider: "google",
			metadata: { email: "alice@example.com", emailVerified: true },
			providerSessionId: "session_long",
			validToMs: 24 * 60 * 60 * 1000,
		});
		const longRow = await sql<{ valid_to: string }>`
      SELECT metadata->>'valid_to' AS valid_to FROM entity_relationships
      WHERE from_entity_id = ${memberEntityId} AND to_entity_id = ${founderEntityId}
    `;

		await syncWithAccount({
			userId: user.id,
			provider: "google",
			metadata: { email: "alice@example.com", emailVerified: true },
			providerSessionId: "session_long",
			validToMs: 1_000,
		});

		const after = await sql<{ valid_to: string }>`
      SELECT metadata->>'valid_to' AS valid_to FROM entity_relationships
      WHERE from_entity_id = ${memberEntityId} AND to_entity_id = ${founderEntityId}
    `;
		expect(after[0].valid_to).toBe(longRow[0].valid_to);
	});

	it("revokeProviderClaimsForSession marks rows revoked by provider_session_id", async () => {
		const sql = getTestDb();
		await sql`
      UPDATE entities
      SET metadata = '{"contact_email":"alice@example.com"}'::jsonb
      WHERE id = ${founderEntityId}
    `;
		await syncWithAccount({
			userId: user.id,
			provider: "google",
			metadata: { email: "alice@example.com", emailVerified: true },
			providerSessionId: "session_to_revoke",
		});

		await revokeProviderClaimsForSession({
			providerSessionId: "session_to_revoke",
		});

		const rows = await sql<{ status: string; revoked_at: string | null }>`
      SELECT metadata->>'status' AS status, metadata->>'revoked_at' AS revoked_at
      FROM entity_relationships
      WHERE from_entity_id = ${memberEntityId}
    `;
		expect(rows[0].status).toBe("revoked");
		expect(rows[0].revoked_at).toBeTruthy();
	});

	it("re-link with a NEW provider session reactivates the revoked row (clears revoked_at, status=active)", async () => {
		const sql = getTestDb();
		await sql`
      UPDATE entities
      SET metadata = '{"contact_email":"alice@example.com"}'::jsonb
      WHERE id = ${founderEntityId}
    `;
		await syncWithAccount({
			userId: user.id,
			provider: "google",
			metadata: { email: "alice@example.com", emailVerified: true },
			providerSessionId: "session_relink_v1",
		});
		await revokeProviderClaimsForSession({
			providerSessionId: "session_relink_v1",
		});

		// A genuine re-link mints a NEW account.id (the better-auth account
		// row is recreated). Provider sync sees a different
		// provider_session_id and reactivates the row. A re-run of the SAME
		// session would NOT undo the revocation — that case is covered
		// below.
		await syncWithAccount({
			userId: user.id,
			provider: "google",
			metadata: { email: "alice@example.com", emailVerified: true },
			providerSessionId: "session_relink_v2",
		});

		const rows = await sql<{ status: string; revoked_at: string | null }>`
      SELECT metadata->>'status' AS status, metadata->>'revoked_at' AS revoked_at
      FROM entity_relationships
      WHERE from_entity_id = ${memberEntityId}
    `;
		expect(rows[0].status).toBe("active");
		// revoked_at is set to JSON null after the merge — sql JSON treats null
		// as the JSON null value, which surfaces as the string 'null' via ->>.
		expect(rows[0].revoked_at === null || rows[0].revoked_at === "null").toBe(
			true,
		);
	});

	it("re-running sync after revoke does NOT reactivate (account row + status guard)", async () => {
		const sql = getTestDb();
		await sql`
      UPDATE entities
      SET metadata = '{"contact_email":"alice@example.com"}'::jsonb
      WHERE id = ${founderEntityId}
    `;
		await syncWithAccount({
			userId: user.id,
			provider: "google",
			metadata: { email: "alice@example.com", emailVerified: true },
			providerSessionId: "session_revoked_race",
		});
		await revokeProviderClaimsForSession({
			providerSessionId: "session_revoked_race",
		});
		// Production: revocation goes through better-auth which deletes the
		// account row. Mirror that — the upsert must observe the deletion.
		await sql`DELETE FROM "account" WHERE id = 'session_revoked_race'`;

		// In-flight sync that lands AFTER the revocation must NOT clear it.
		await applySyncForUser({
			userId: user.id,
			provider: "google",
			metadata: { email: "alice@example.com", emailVerified: true },
			providerSessionId: "session_revoked_race",
		});

		const rows = await sql<{ status: string; revoked_at: string | null }>`
      SELECT metadata->>'status' AS status, metadata->>'revoked_at' AS revoked_at
      FROM entity_relationships
      WHERE from_entity_id = ${memberEntityId}
    `;
		expect(rows[0].status).toBe("revoked");
		expect(rows[0].revoked_at).toBeTruthy();
	});

	it("skips upsert when the account row is gone (revoke-before-insert race)", async () => {
		const sql = getTestDb();
		await sql`
      UPDATE entities
      SET metadata = '{"contact_email":"alice@example.com"}'::jsonb
      WHERE id = ${founderEntityId}
    `;
		// Do NOT seed an account row — simulates the case where revocation
		// deleted the account between the sync's metadata fetch and its
		// upsert. The sync must skip rather than insert a fresh active edge.
		await applySyncForUser({
			userId: user.id,
			provider: "google",
			metadata: { email: "alice@example.com", emailVerified: true },
			providerSessionId: "session_already_dead",
		});

		const rows = await sql`
      SELECT id FROM entity_relationships WHERE deleted_at IS NULL
    `;
		expect(rows.length).toBe(0);
	});

	it("skips when user has no $member entities in any private org", async () => {
		const orphanUser = await createTestUser({ email: "orphan@example.com" });

		const sql = getTestDb();
		await sql`
      UPDATE entities
      SET metadata = '{"contact_email":"orphan@example.com"}'::jsonb
      WHERE id = ${founderEntityId}
    `;

		await syncWithAccount({
			userId: orphanUser.id,
			provider: "google",
			metadata: { email: "orphan@example.com", emailVerified: true },
			providerSessionId: "session_orphan",
		});

		const rows = await sql`
      SELECT id FROM entity_relationships WHERE deleted_at IS NULL
    `;
		expect(rows.length).toBe(0);
	});
});
