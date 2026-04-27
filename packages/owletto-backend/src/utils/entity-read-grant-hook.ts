/**
 * Issuance hook: turns a freshly-created trust-primitive relationship into
 * an `entity_read_grant` for the audit-agent service user.
 *
 * Called from `manage_entity.handleLink` AFTER the relationship row is
 * inserted, so:
 *
 *   1. Validation failures (scope/type/duplicate) never leak grants.
 *   2. The relationship and its triggering grant share a single transactional
 *      window from the caller's perspective.
 *
 * Idempotent — see `issueEntityReadGrant`.
 */

import { getDb } from "../db/client";
import {
	AUDIT_AGENT_USER_ID,
	issueEntityReadGrant,
	TRUST_PRIMITIVE_RELATIONSHIP_SLUGS,
} from "./entity-read-grant";
import logger from "./logger";

interface MaybeIssueParams {
	relationshipTypeSlug: string;
	fromEntityId: number;
	toEntityId: number;
	/** Caller's org id — the grantor whose private entity is being shared. */
	callerOrgId: string;
	relationshipId: number;
	/**
	 * Relationship metadata as supplied by the caller. For
	 * `proposes_canonical` the entity to grant access to lives in
	 * `metadata.proposed_entity_id` (a private entity in the caller's org
	 * that is being put forward for promotion); the relationship's `from`
	 * is the caller's `$member`, which the audit agent does not need to
	 * read. For every other trust primitive the source IS the entity to
	 * audit, and metadata is ignored.
	 */
	metadata?: Record<string, unknown> | null;
}

/**
 * Inspect a freshly-created relationship; issue a read grant when:
 *
 *  - The relationship type is one of the trust primitives.
 *  - The TARGET is in a public-catalog org (visibility='public').
 *  - The SOURCE is in the caller's org AND that org is not itself public
 *    (public→public links are catalog-internal merges; no need to grant
 *    audit access to a row that's already publicly readable).
 *
 * Returns the grant id when issued, otherwise null. Failures are logged but
 * never re-thrown — the caller decides how to handle a degraded issuance
 * path; today, `manage_entity.handleLink` swallows the error so the link
 * itself still succeeds.
 */
export async function maybeIssueReadGrantForRelationship(
	params: MaybeIssueParams,
): Promise<{ grantId: string } | null> {
	if (!TRUST_PRIMITIVE_RELATIONSHIP_SLUGS.has(params.relationshipTypeSlug)) {
		return null;
	}

	// For `proposes_canonical` the relationship's `from` is the caller's
	// `$member`; the entity to audit is metadata.proposed_entity_id. Reject
	// the issuance if the metadata is missing — the audit watcher would have
	// nothing to read otherwise. For every other trust primitive the
	// relationship's `from` IS the audit target.
	let auditEntityId = params.fromEntityId;
	if (params.relationshipTypeSlug === "proposes_canonical") {
		const proposed = params.metadata?.proposed_entity_id;
		if (typeof proposed !== "number" || !Number.isInteger(proposed) || proposed <= 0) {
			logger.warn(
				{
					relationshipId: params.relationshipId,
					relationshipTypeSlug: params.relationshipTypeSlug,
				},
				"entity_read_grant: proposes_canonical missing metadata.proposed_entity_id — no grant issued",
			);
			return null;
		}
		auditEntityId = proposed;
	}

	const sql = getDb();
	try {
		const rows = await sql<{
			id: number;
			organization_id: string;
			visibility: string | null;
		}>`
      SELECT e.id, e.organization_id, o.visibility
      FROM entities e
      LEFT JOIN organization o ON o.id = e.organization_id
      WHERE e.id IN (${auditEntityId}, ${params.toEntityId})
    `;

		const auditRow = rows.find((r) => Number(r.id) === auditEntityId);
		const toRow = rows.find((r) => Number(r.id) === params.toEntityId);
		if (!auditRow || !toRow) {
			logger.warn(
				{
					relationshipId: params.relationshipId,
					auditEntityId,
					toEntityId: params.toEntityId,
				},
				"entity_read_grant: skipping issuance — entity rows missing post-insert",
			);
			return null;
		}

		const targetIsPublic = String(toRow.visibility ?? "private") === "public";
		const auditEntityIsCallerOrg =
			String(auditRow.organization_id) === params.callerOrgId;
		const auditOrgIsPublic =
			String(auditRow.visibility ?? "private") === "public";

		if (!targetIsPublic || !auditEntityIsCallerOrg || auditOrgIsPublic) {
			// Either:
			//  - target isn't a public-catalog entity (no audit-agent involvement)
			//  - the audit entity isn't in the caller's org (validateScopeRule
			//    should have rejected this; defense-in-depth)
			//  - the audit entity IS public itself (already readable)
			return null;
		}

		const result = await issueEntityReadGrant({
			grantorOrgId: params.callerOrgId,
			entityId: auditEntityId,
			granteeUserId: AUDIT_AGENT_USER_ID,
			triggeringRelationshipId: params.relationshipId,
		});

		logger.info(
			{
				grantId: result.id,
				relationshipId: params.relationshipId,
				relationshipTypeSlug: params.relationshipTypeSlug,
				grantorOrgId: params.callerOrgId,
				entityId: auditEntityId,
				inserted: result.inserted,
				expiresAt: result.expiresAt.toISOString(),
			},
			"entity_read_grant: issued for trust-primitive relationship",
		);

		return { grantId: result.id };
	} catch (err) {
		logger.error(
			{
				err,
				relationshipId: params.relationshipId,
				relationshipTypeSlug: params.relationshipTypeSlug,
			},
			"entity_read_grant: issuance failed",
		);
		throw err;
	}
}
