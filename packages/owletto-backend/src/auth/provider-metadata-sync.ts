/**
 * Provider-metadata sync hook.
 *
 * On every authenticated sign-in (and OAuth token refresh), reconcile the
 * provider's verified metadata against `market` entity metadata and
 * auto-issue / extend / revoke `claims_identity` and `has_authority`
 * relationships from the user's `$member` entities to matching market
 * entities.
 *
 * Wired in `auth/index.tsx` `databaseHooks.account.{create,update}.after`,
 * the same place that `provisionConnectorFromSocialLogin` runs. This hook
 * fires AFTER the social-provisioning hook so the latter's `auth_profile`
 * row is in place; no transactional dependency, just ordering.
 * `databaseHooks.account.delete.before` calls `revokeProviderClaimsForSession`
 * to keep authority temporal — a token revocation propagates to the row
 * immediately.
 *
 * Failure mode: best-effort. Sign-in must NOT block on sync; on error we
 * log and continue. Concurrency: a session refresh that fires while a
 * prior sync is mid-flight is safe — every relationship operation is
 * idempotent (upsert by relationship type + endpoints), `valid_to` is
 * monotonic-extending, and `upsertRelationship` runs inside a transaction
 * with a SELECT...FOR UPDATE row lock so two concurrent refreshes cannot
 * race-insert duplicates or undo a revocation.
 *
 * Why no `entity_read_grant` here: provider-driven claims set
 * `evidence_tier='B'` (provider-verified). The audit agent in Phase 5
 * grades these as auto-accept on first sight; reading the contributor's
 * own `$member` (which is the relationship's `from`) adds nothing beyond
 * what's already on the relationship metadata. Manual `claims_identity`
 * created via `manage_entity` DOES grant audit-agent read access on the
 * private member row — see `entity-read-grant-hook.ts`.
 */

import { fetchUserInfoWithRaw } from "../connect/oauth-providers";
import { getDb } from "../db/client";
import logger from "../utils/logger";

/** Relationship types we may auto-create / extend / revoke. */
const CLAIMS_IDENTITY = "claims_identity";
const HAS_AUTHORITY = "has_authority";

const DEFAULT_AUTHORITY_SCOPES = [
	"can_edit_company_profile",
	"can_publish_job_for_company",
] as const;

const DEFAULT_VALID_TO_MS = 7 * 24 * 60 * 60 * 1000;

interface ProviderAccount {
	id: string;
	userId: string;
	providerId: string;
	accessToken?: string | null;
	scope?: string | null;
}

interface ProviderMetadata {
	email?: string | null;
	emailVerified?: boolean | null;
	githubHandle?: string | null;
	linkedinUrl?: string | null;
	hostedDomain?: string | null;
	microsoftTenantId?: string | null;
	githubOrgs?: string[];
}

interface SyncContext {
	/** Refresh-token / session id the provider hands us. Sets valid_to floor and
	 *  becomes the revocation key. */
	providerSessionId: string;
	/** When the OAuth session itself expires (drives valid_to). */
	validTo: Date;
	/** The signed-in user — used as `created_by` / `updated_by` on the
	 *  relationship rows. Provider-sync acts on behalf of this user. */
	actorUserId: string;
}

/**
 * Public entry point — call from auth hooks.
 *
 * Errors are logged and swallowed: never throws. We must not block sign-in.
 */
export async function syncProviderMetadataClaims(params: {
	account: ProviderAccount;
	request?: Request | null;
}): Promise<void> {
	try {
		await syncProviderMetadataClaimsImpl(params);
	} catch (err) {
		logger.error(
			{
				err,
				userId: params.account.userId,
				provider: params.account.providerId,
			},
			"provider-metadata-sync: top-level failure",
		);
	}
}

async function syncProviderMetadataClaimsImpl(params: {
	account: ProviderAccount;
	request?: Request | null;
}): Promise<void> {
	const provider = params.account.providerId?.trim().toLowerCase();
	if (!provider || !params.account.userId) return;

	// Pull provider-verified metadata. Without an access token we cannot
	// assert any claim — bail out cleanly.
	if (!params.account.accessToken) return;

	const metadata = await readProviderMetadata({
		provider,
		accessToken: params.account.accessToken,
	});
	if (!metadata) return;

	await applySyncForUser({
		userId: params.account.userId,
		provider,
		metadata,
		providerSessionId: params.account.id,
		actorUserId: params.account.userId,
	});
}

/**
 * Test seam: the metadata-bearing half of the sync, separated from the HTTP
 * fetch. Production code reaches this via `syncProviderMetadataClaims` →
 * `readProviderMetadata` → `applySyncForUser`. Tests pass synthetic
 * metadata directly to bypass the OAuth fetch.
 */
export async function applySyncForUser(params: {
	userId: string;
	provider: string;
	metadata: ProviderMetadata;
	providerSessionId: string;
	validToMs?: number;
	/** Defaults to userId (the signing-in user). Tests can override. */
	actorUserId?: string;
}): Promise<void> {
	const ctx: SyncContext = {
		providerSessionId: params.providerSessionId,
		validTo: new Date(Date.now() + (params.validToMs ?? DEFAULT_VALID_TO_MS)),
		actorUserId: params.actorUserId ?? params.userId,
	};

	const members = await listPrivateOrgMemberEntities(params.userId);
	if (members.length === 0) {
		logger.debug(
			{ userId: params.userId, provider: params.provider },
			"provider-metadata-sync: no $member entities to sync",
		);
		return;
	}

	const sql = getDb();
	const marketRows = await sql<{ id: string }>`
    SELECT id FROM organization WHERE slug = 'market' AND visibility = 'public' LIMIT 1
  `;
	if (marketRows.length === 0) {
		return;
	}
	const marketOrgId = marketRows[0].id;

	for (const member of members) {
		await syncOneMember({
			provider: params.provider,
			member,
			metadata: params.metadata,
			ctx,
			marketOrgId,
		});
	}
}

interface MemberEntity {
	id: number;
	organizationId: string;
}

async function listPrivateOrgMemberEntities(
	userId: string,
): Promise<MemberEntity[]> {
	const sql = getDb();
	// The $member entity for a user in an org is keyed by the user's email in
	// metadata->>email. We look it up via user.email + member-org join. The
	// member type lives per-org, so we scope by entity type slug = '$member'.
	const rows = await sql<{ id: number; organization_id: string }>`
    SELECT e.id, e.organization_id
    FROM entities e
    JOIN entity_types et ON et.id = e.entity_type_id
    JOIN "member" m ON m."organizationId" = e.organization_id
    JOIN "user" u ON u.id = m."userId"
    JOIN organization o ON o.id = e.organization_id
    WHERE m."userId" = ${userId}
      AND et.slug = '$member'
      AND e.deleted_at IS NULL
      AND o.visibility = 'private'
      AND e.metadata->>'email' = u.email
  `;
	return rows.map((r) => ({
		id: Number(r.id),
		organizationId: String(r.organization_id),
	}));
}

async function readProviderMetadata(params: {
	provider: string;
	accessToken: string;
}): Promise<ProviderMetadata | null> {
	const { raw } = await fetchUserInfoWithRaw({
		provider: params.provider,
		accessToken: params.accessToken,
	});
	if (!raw) return null;

	switch (params.provider) {
		case "google":
			return {
				email: typeof raw.email === "string" ? raw.email.toLowerCase() : null,
				emailVerified:
					raw.email_verified === true || raw.verified_email === true,
				// hosted_domain is set on Google Workspace accounts only; treat
				// gmail.com / personal accounts as no-domain.
				hostedDomain:
					typeof raw.hd === "string" && raw.hd !== "gmail.com"
						? raw.hd.toLowerCase()
						: null,
			};
		case "github":
			return {
				email: typeof raw.email === "string" ? raw.email.toLowerCase() : null,
				emailVerified: true, // GitHub only exposes verified primary emails on userinfo
				githubHandle:
					typeof raw.login === "string" ? raw.login.toLowerCase() : null,
			};
		case "microsoft":
			return {
				email:
					typeof raw.mail === "string"
						? raw.mail.toLowerCase()
						: typeof raw.userPrincipalName === "string"
							? raw.userPrincipalName.toLowerCase()
							: null,
				microsoftTenantId: typeof raw.tid === "string" ? raw.tid : null,
			};
		case "linkedin":
			return {
				email: typeof raw.email === "string" ? raw.email.toLowerCase() : null,
				linkedinUrl: typeof raw.profile === "string" ? raw.profile : null,
			};
		default:
			return null;
	}
}

interface SyncOneArgs {
	provider: string;
	member: MemberEntity;
	metadata: ProviderMetadata;
	ctx: SyncContext;
	marketOrgId: string;
}

async function syncOneMember(args: SyncOneArgs): Promise<void> {
	const sql = getDb();

	// Find candidate market entities that match the provider metadata.
	// Each branch produces { entityId, entityType, scopes? } records and we
	// upsert a relationship of the appropriate type.
	type Match = {
		entityId: number;
		entityType: "founder" | "company";
		relationshipType: typeof CLAIMS_IDENTITY | typeof HAS_AUTHORITY;
		scopes?: readonly string[];
	};
	const matches: Match[] = [];

	// founder.contact_email
	if (args.metadata.email && args.metadata.emailVerified) {
		const rows = await sql<{ id: number }>`
      SELECT e.id
      FROM entities e
      JOIN entity_types et ON et.id = e.entity_type_id
      WHERE et.slug = 'founder'
        AND e.organization_id = ${args.marketOrgId}
        AND e.deleted_at IS NULL
        AND lower(e.metadata->>'contact_email') = ${args.metadata.email}
    `;
		for (const row of rows) {
			matches.push({
				entityId: Number(row.id),
				entityType: "founder",
				relationshipType: CLAIMS_IDENTITY,
			});
		}
	}

	// founder.github_handle
	if (args.metadata.githubHandle) {
		const rows = await sql<{ id: number }>`
      SELECT e.id
      FROM entities e
      JOIN entity_types et ON et.id = e.entity_type_id
      WHERE et.slug = 'founder'
        AND e.organization_id = ${args.marketOrgId}
        AND e.deleted_at IS NULL
        AND lower(e.metadata->>'github_handle') = ${args.metadata.githubHandle}
    `;
		for (const row of rows) {
			matches.push({
				entityId: Number(row.id),
				entityType: "founder",
				relationshipType: CLAIMS_IDENTITY,
			});
		}
	}

	// founder.linkedin_url
	if (args.metadata.linkedinUrl) {
		const rows = await sql<{ id: number }>`
      SELECT e.id
      FROM entities e
      JOIN entity_types et ON et.id = e.entity_type_id
      WHERE et.slug = 'founder'
        AND e.organization_id = ${args.marketOrgId}
        AND e.deleted_at IS NULL
        AND e.metadata->>'linkedin_url' = ${args.metadata.linkedinUrl}
    `;
		for (const row of rows) {
			matches.push({
				entityId: Number(row.id),
				entityType: "founder",
				relationshipType: CLAIMS_IDENTITY,
			});
		}
	}

	// company.primary_domain ← Google Workspace hosted_domain
	if (args.metadata.hostedDomain) {
		const rows = await sql<{ id: number }>`
      SELECT e.id
      FROM entities e
      JOIN entity_types et ON et.id = e.entity_type_id
      WHERE et.slug = 'company'
        AND e.organization_id = ${args.marketOrgId}
        AND e.deleted_at IS NULL
        AND lower(e.metadata->>'primary_domain') = ${args.metadata.hostedDomain}
    `;
		for (const row of rows) {
			matches.push({
				entityId: Number(row.id),
				entityType: "company",
				relationshipType: HAS_AUTHORITY,
				scopes: DEFAULT_AUTHORITY_SCOPES,
			});
		}
	}

	// company.microsoft_tenant_id
	if (args.metadata.microsoftTenantId) {
		const rows = await sql<{ id: number }>`
      SELECT e.id
      FROM entities e
      JOIN entity_types et ON et.id = e.entity_type_id
      WHERE et.slug = 'company'
        AND e.organization_id = ${args.marketOrgId}
        AND e.deleted_at IS NULL
        AND e.metadata->>'microsoft_tenant_id' = ${args.metadata.microsoftTenantId}
    `;
		for (const row of rows) {
			matches.push({
				entityId: Number(row.id),
				entityType: "company",
				relationshipType: HAS_AUTHORITY,
				scopes: DEFAULT_AUTHORITY_SCOPES,
			});
		}
	}

	for (const match of matches) {
		await upsertRelationship({
			callerOrgId: args.member.organizationId,
			relationshipTypeSlug: match.relationshipType,
			fromEntityId: args.member.id,
			toEntityId: match.entityId,
			provider: args.provider,
			ctx: args.ctx,
			scopes: match.scopes,
			actorUserId: args.ctx.actorUserId,
		});
	}
}

async function upsertRelationship(args: {
	callerOrgId: string;
	relationshipTypeSlug: string;
	fromEntityId: number;
	toEntityId: number;
	provider: string;
	ctx: SyncContext;
	scopes?: readonly string[];
	actorUserId: string;
}): Promise<void> {
	const sql = getDb();

	// Look up the relationship type via the same search path used by
	// manage_entity.handleLink: tenant first, then any public catalog. Both
	// claims_identity / has_authority live on the public Market org, so the
	// public branch is the one that matches in production.
	const typeRows = await sql<{ id: number }>`
    SELECT rt.id
    FROM entity_relationship_types rt
    LEFT JOIN organization o ON o.id = rt.organization_id
    WHERE rt.slug = ${args.relationshipTypeSlug}
      AND rt.deleted_at IS NULL
      AND (
        rt.organization_id = ${args.callerOrgId}
        OR o.visibility = 'public'
      )
    ORDER BY (rt.organization_id = ${args.callerOrgId}) DESC, rt.id ASC
    LIMIT 1
  `;
	if (typeRows.length === 0) {
		logger.warn(
			{
				relationshipTypeSlug: args.relationshipTypeSlug,
				callerOrgId: args.callerOrgId,
			},
			"provider-metadata-sync: relationship type not found, skipping match",
		);
		return;
	}
	const typeId = Number(typeRows[0].id);

	const baseMetadata: Record<string, unknown> = {
		method: `oauth-${args.provider}`,
		provider: args.provider,
		provider_session_id: args.ctx.providerSessionId,
		evidence_tier: "B",
		valid_to: args.ctx.validTo.toISOString(),
		status: "active",
	};
	if (args.scopes && args.scopes.length > 0) {
		baseMetadata.scopes = [...args.scopes];
		baseMetadata.source = `oauth-${args.provider}`;
	}

	// Lock the candidate (org, from, to, type) tuple via a pg advisory lock so
	// the "no existing row → INSERT" path is exclusive. Two concurrent OAuth
	// refreshes hashing to the same key will serialize on this lock, so
	// neither can race-insert a duplicate. The lock is released at
	// transaction end. SELECT...FOR UPDATE alone is not enough here because
	// the row may not yet exist.
	//
	// Revocation race: an in-flight sync that lands AFTER
	// `revokeProviderClaimsForSession` must NOT reactivate the just-revoked
	// authority. We check the better-auth `account` row's existence BEFORE
	// inserting/updating: if the account has been deleted between fetch and
	// upsert, the OAuth session is gone and we skip. We also honor the prior
	// row's `revoked_at` — once revoked, only a re-link with a NEW
	// `provider_session_id` reactivates it.
	const advisoryKey = await sql<{ key: string }>`
    SELECT abs(hashtextextended(${`relsync:${args.callerOrgId}:${args.fromEntityId}:${args.toEntityId}:${typeId}`}, 0)) AS key
  `;
	const advisoryLockKey = String(advisoryKey[0].key);

	await sql.begin(async (tx) => {
		await tx`SELECT pg_advisory_xact_lock(${advisoryLockKey}::bigint)`;

		// Account-existence check: better-auth deletes the `account` row when
		// a social-login is unlinked / token revoked. If the row is gone the
		// session is dead and we must not write; this closes the
		// revoke-before-insert race codex flagged.
		const accountStillLive = await tx<{ id: string }>`
      SELECT id FROM "account" WHERE id = ${args.ctx.providerSessionId} LIMIT 1
    `;
		if (accountStillLive.length === 0) {
			logger.debug(
				{
					providerSessionId: args.ctx.providerSessionId,
					relationshipTypeSlug: args.relationshipTypeSlug,
				},
				"provider-metadata-sync: account row missing — session revoked, skipping upsert",
			);
			return;
		}

		const existing = await tx<{
			id: number;
			metadata: Record<string, unknown> | null;
		}>`
      SELECT id, metadata
      FROM entity_relationships
      WHERE organization_id = ${args.callerOrgId}
        AND from_entity_id = ${args.fromEntityId}
        AND to_entity_id = ${args.toEntityId}
        AND relationship_type_id = ${typeId}
        AND deleted_at IS NULL
      LIMIT 1
      FOR UPDATE
    `;

		if (existing.length === 0) {
			await tx`
        INSERT INTO entity_relationships (
          organization_id, from_entity_id, to_entity_id, relationship_type_id,
          metadata, confidence, source, created_by, updated_by,
          created_at, updated_at
        ) VALUES (
          ${args.callerOrgId},
          ${args.fromEntityId},
          ${args.toEntityId},
          ${typeId},
          ${tx.json({ ...baseMetadata, revoked_at: null })},
          1.0,
          'api',
          ${args.actorUserId},
          ${args.actorUserId},
          current_timestamp,
          current_timestamp
        )
      `;
			return;
		}

		const prior = existing[0].metadata ?? {};
		const priorSessionId =
			typeof prior.provider_session_id === "string"
				? prior.provider_session_id
				: null;
		const priorRevokedAt =
			typeof prior.revoked_at === "string" ? prior.revoked_at : null;
		const priorStatus =
			typeof prior.status === "string" ? prior.status : "active";

		// Same session id and the row is revoked → leave it revoked. This is
		// the codex-flagged race: a sync running concurrently with revocation
		// must not undo the revocation.
		if (
			priorSessionId === args.ctx.providerSessionId &&
			(priorRevokedAt !== null || priorStatus === "revoked")
		) {
			return;
		}

		const merged: Record<string, unknown> = {
			...prior,
			...baseMetadata,
		};
		// Re-link path: a NEW provider_session_id replacing a previously-
		// revoked claim. Clear revoked_at and reactivate.
		if (priorSessionId !== args.ctx.providerSessionId) {
			merged.revoked_at = null;
		} else {
			// Same session, not revoked — preserve any prior revoked_at as a
			// safety net (no-op when null).
			merged.revoked_at = priorRevokedAt ?? null;
		}

		// Never shrink valid_to: a slow refresh with a shorter session must
		// not narrow a longer-lived authority.
		const priorValidTo =
			typeof prior.valid_to === "string" ? new Date(prior.valid_to) : null;
		if (priorValidTo && priorValidTo.getTime() > args.ctx.validTo.getTime()) {
			merged.valid_to = priorValidTo.toISOString();
		}
		// Union scopes if already present.
		if (
			args.scopes &&
			Array.isArray(prior.scopes) &&
			prior.scopes.every((s) => typeof s === "string")
		) {
			const set = new Set<string>([
				...(prior.scopes as string[]),
				...args.scopes,
			]);
			merged.scopes = Array.from(set).sort();
		}
		await tx`
      UPDATE entity_relationships
      SET metadata = ${tx.json(merged)},
          updated_at = current_timestamp
      WHERE id = ${existing[0].id}
    `;
	});
}

/**
 * Mark provider-driven relationships revoked when an OAuth session ends.
 *
 * Wired from the auth sign-out / token-revocation path. Idempotent.
 *
 * Authority temporality: we revoke EVERY relationship whose metadata
 * `provider_session_id` matches the session that just ended. Setting
 * `revoked_at = NOW()` and `status='revoked'` flags the row so any read
 * path that filters on active claims (`status='active' AND revoked_at IS
 * NULL`) sees it as revoked immediately — no replication or cache
 * invalidation. The audit agent must therefore evaluate authority freshly
 * at every check, never cache an authoritative answer past the session
 * boundary.
 */
export async function revokeProviderClaimsForSession(params: {
	providerSessionId: string;
}): Promise<void> {
	if (!params.providerSessionId) return;
	const sql = getDb();
	try {
		await sql`
      UPDATE entity_relationships
      SET metadata = COALESCE(metadata, '{}'::jsonb)
                     || jsonb_build_object(
                          'revoked_at', NOW()::text,
                          'status', 'revoked'
                        ),
          updated_at = current_timestamp
      WHERE deleted_at IS NULL
        AND metadata->>'provider_session_id' = ${params.providerSessionId}
        AND (metadata->>'status' IS DISTINCT FROM 'revoked')
    `;
	} catch (err) {
		logger.error(
			{ err, providerSessionId: params.providerSessionId },
			"provider-metadata-sync: revocation failed",
		);
	}
}
