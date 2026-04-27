/**
 * Delegated read grant primitive.
 *
 * When a contributor in a private org creates a trust-primitive relationship
 * (`claims_identity`, `has_authority`) pointing at a public-catalog entity, the source
 * private entity needs to become readable by the audit agent for one or more
 * reads. We model this as an `entity_read_grant` row (see migration
 * `db/migrations/20260427120000_entity_read_grant.sql`).
 *
 * The audit agent is a single platform-level service user
 * (`AUDIT_AGENT_USER_ID`); the read path checks for an active grant before
 * falling back to org-membership.
 *
 * Issuance is idempotent — re-running with the same
 * (grantor_org_id, entity_id, grantee_user_id, triggering_relationship_id)
 * tuple **extends** `expires_at` rather than inserting a duplicate, by way of
 * the partial unique index `idx_entity_read_grant_idempotency`.
 */

import { randomBytes } from "node:crypto";
import { getDb } from "../db/client";
import logger from "./logger";

/**
 * Single platform-level service user that the audit agent runs as.
 * Provisioned by `db/migrations/20260427120000_entity_read_grant.sql`.
 *
 * v1 keeps a single shared identity rather than per-public-org service
 * accounts to keep the read path simple. Cross-tenant attack surface is
 * bounded by `entity_read_grant`: the agent can only read entities it has an
 * active grant for. If we later need per-public-org isolation, the existing
 * (grantor_org_id, grantee_user_id) shape lets us add per-org grantees
 * without schema changes.
 */
export const AUDIT_AGENT_USER_ID = "user_audit_agent";

/**
 * Relationship-type slugs that auto-issue a read grant on creation.
 * Centralized here so both the issuance hook and any future inspection
 * tooling can agree on the list.
 */
export const TRUST_PRIMITIVE_RELATIONSHIP_SLUGS: ReadonlySet<string> = new Set([
	"claims_identity",
	"has_authority",
]);

/**
 * Default grant lifetime. The audit agent's evidence-grading workflow runs
 * within minutes of issuance, but we leave 30d so a rejected/pending grant
 * survives manual review without manual re-issuance.
 */
const DEFAULT_GRANT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type EntityReadGrantScope = "read-once" | "read-n" | "read-window";

interface IssueGrantParams {
	grantorOrgId: string;
	entityId: number;
	granteeUserId?: string;
	triggeringRelationshipId: number;
	scope?: EntityReadGrantScope;
	ttlMs?: number;
}

interface IssueGrantResult {
	id: string;
	expiresAt: Date;
	inserted: boolean;
}

/**
 * Issue (or extend) a read grant.
 *
 * Idempotent: re-running with the same key tuple updates `expires_at` to the
 * later of (existing, new). `consumed_at` IS NULL is part of the partial
 * unique key, so a fresh grant can be issued after a prior one was consumed.
 *
 * Race-safety: the `ON CONFLICT DO UPDATE` against the partial unique index
 * is atomic. Two concurrent issuers either both insert (different
 * triggering relationships) or one inserts and the other extends.
 */
export async function issueEntityReadGrant(
	params: IssueGrantParams,
): Promise<IssueGrantResult> {
	const sql = getDb();
	const granteeUserId = params.granteeUserId ?? AUDIT_AGENT_USER_ID;
	const ttlMs = params.ttlMs ?? DEFAULT_GRANT_TTL_MS;
	const expiresAt = new Date(Date.now() + ttlMs);
	const scope = params.scope ?? "read-once";

	// Use a generated id so logs/audit can reference the grant without joining
	// through the relationship.
	const id = `grant_${randomBytes(8).toString("hex")}`;

	// Re-running with the same tuple should EXTEND the grant — never shorten
	// it — so a slow retry never accidentally narrows access. We pick the later
	// expiry deterministically with GREATEST.
	const rows = await sql<{
		id: string;
		expires_at: Date;
		created_at: Date;
	}>`
    INSERT INTO entity_read_grant (
      id, grantor_org_id, entity_id, grantee_user_id, scope,
      expires_at, single_use, triggering_relationship_id, created_at
    ) VALUES (
      ${id},
      ${params.grantorOrgId},
      ${params.entityId},
      ${granteeUserId},
      ${scope},
      ${expiresAt.toISOString()},
      ${scope === "read-once"},
      ${params.triggeringRelationshipId},
      NOW()
    )
    ON CONFLICT (grantor_org_id, entity_id, grantee_user_id, triggering_relationship_id)
    WHERE consumed_at IS NULL
    DO UPDATE SET expires_at = GREATEST(entity_read_grant.expires_at, EXCLUDED.expires_at)
    RETURNING id, expires_at, created_at
  `;

	// `RETURNING` always produces exactly one row — the conflict path
	// updates a row, the non-conflict path inserts one. Defensive guard so
	// downstream code can rely on row-shape invariants without a non-null
	// assertion.
	const row = rows[0];
	if (!row) {
		throw new Error("entity_read_grant: insert returned no row");
	}
	// The id we generated only sticks if the row was a fresh insert. After a
	// conflict, RETURNING surfaces the existing row's id — use that to
	// distinguish insert vs extend.
	const inserted = row.id === id;
	if (!inserted) {
		logger.debug(
			{
				grantId: row.id,
				grantorOrgId: params.grantorOrgId,
				entityId: params.entityId,
				triggeringRelationshipId: params.triggeringRelationshipId,
			},
			"entity_read_grant: extended existing grant",
		);
	}

	return {
		id: row.id,
		expiresAt: new Date(row.expires_at),
		inserted,
	};
}

interface ConsumeGrantParams {
	granteeUserId: string;
	entityId: number;
	/**
	 * Defense-in-depth: when known, the org that owns `entityId`. Restricts the
	 * search to grants whose `grantor_org_id` matches the owning org so a
	 * malformed grant pointing at the wrong (entity, org) tuple cannot be
	 * consumed for cross-tenant reads. Optional because some legacy callers
	 * have only the entity id; the entity_read_grant_hook always sets it.
	 */
	grantorOrgId?: string;
}

/**
 * Look up — and atomically consume, when single_use — an active read grant.
 *
 * Returns the grant id when access is allowed, or null when no active grant
 * exists (caller must fall back to the normal read path).
 *
 * Concurrency: the `UPDATE ... RETURNING` on a single row is atomic per
 * Postgres MVCC. Two concurrent reads against the same single-use grant
 * cannot both succeed — the second one's WHERE clause finds consumed_at
 * already set and returns no row.
 */
export async function consumeActiveReadGrant(
	params: ConsumeGrantParams,
): Promise<{ id: string } | null> {
	const sql = getDb();
	const grantorOrgId = params.grantorOrgId ?? null;

	// For single_use=true grants: mark consumed_at the first time we touch them.
	// For multi-use ('read-n', 'read-window') the row stays unconsumed and the
	// grant survives until expires_at. The audit-agent v1 only issues
	// 'read-once', so this branching is forward-compatible.
	const rows = await sql<{ id: string }>`
    WITH candidate AS (
      SELECT id, single_use
      FROM entity_read_grant
      WHERE grantee_user_id = ${params.granteeUserId}
        AND entity_id = ${params.entityId}
        AND (${grantorOrgId}::text IS NULL OR grantor_org_id = ${grantorOrgId})
        AND consumed_at IS NULL
        AND expires_at > NOW()
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    ),
    consumed AS (
      UPDATE entity_read_grant g
      SET consumed_at = NOW()
      FROM candidate c
      WHERE g.id = c.id AND c.single_use = true
      RETURNING g.id
    )
    SELECT id FROM consumed
    UNION ALL
    SELECT c.id FROM candidate c WHERE c.single_use = false
    LIMIT 1
  `;

	return rows.length > 0 ? { id: rows[0].id } : null;
}

/**
 * Best-effort lookup: does the user have any active grant for this entity?
 * Does NOT consume the grant; used by callers that just need to gate a read
 * path branch.
 */
export async function hasActiveReadGrant(
	granteeUserId: string,
	entityId: number,
): Promise<boolean> {
	const sql = getDb();
	const rows = await sql`
    SELECT 1
    FROM entity_read_grant
    WHERE grantee_user_id = ${granteeUserId}
      AND entity_id = ${entityId}
      AND consumed_at IS NULL
      AND expires_at > NOW()
    LIMIT 1
  `;
	return rows.length > 0;
}
