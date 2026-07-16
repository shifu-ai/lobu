import {
	inferGrantKind,
	normalizeDomainPattern,
	type AgentSettings,
} from "@lobu/core";
import type { DbClient } from "../db/client.js";
import { getDb } from "../db/client.js";
import { recordLifecycleEvent } from "../utils/insert-event.js";

export const AGENT_SETTINGS_MANAGED_BY_RELEASE =
	"agent_settings_managed_by_release";
export const AGENT_SETTINGS_MANAGED_BY_FENCED_PROVISIONING =
	"agent_settings_managed_by_fenced_provisioning";

const RELEASE_OWNED_SETTINGS = [
	"identityMd",
	"soulMd",
	"userMd",
	"modelSelection",
	"toolsConfig",
] as const;

export class AgentSettingsManagedByReleaseError extends Error {
	readonly code = AGENT_SETTINGS_MANAGED_BY_RELEASE;

	constructor() {
		super(
			"Agent release-owned settings must be changed through managed release apply",
		);
		this.name = "AgentSettingsManagedByReleaseError";
	}
}

export class AgentSettingsManagedByFencedProvisioningError extends Error {
	readonly code = AGENT_SETTINGS_MANAGED_BY_FENCED_PROVISIONING;

	constructor() {
		super("Agent settings must be changed through fenced provisioning");
		this.name = "AgentSettingsManagedByFencedProvisioningError";
	}
}

export type ProvisioningFence = {
	targetId: string;
	claimGeneration: number;
	claimToken: string;
	baselineVersionId: string;
	effectiveSettingsDigest: string;
};

export class ProvisioningFenceError extends Error {
	constructor(
		readonly code: "provisioning_fence_stale" | "provisioning_fence_conflict",
	) {
		super(code);
		this.name = "ProvisioningFenceError";
	}
}

function hasOwn(value: object, key: PropertyKey): boolean {
	return Object.hasOwn(value, key);
}

async function lockAgentAndAssertReleaseFence(
	tx: DbClient,
	organizationId: string,
	agentId: string,
	writesManagedSettings: boolean,
	rejectFencedProvisioning = false,
): Promise<boolean> {
	const agents = await tx`
    SELECT 1
    FROM agents
    WHERE organization_id = ${organizationId} AND id = ${agentId}
    FOR UPDATE
  `;
	if (agents.length === 0) return false;
	if (rejectFencedProvisioning) {
		const provisioningFences = await tx`
			SELECT 1
			FROM agent_provisioning_fences
			WHERE organization_id = ${organizationId}
			  AND agent_id = ${agentId}
			LIMIT 1
		`;
		if (provisioningFences.length > 0) {
			throw new AgentSettingsManagedByFencedProvisioningError();
		}
	}
	if (!writesManagedSettings) return true;

	const receipts = await tx`
    SELECT 1
    FROM agent_release_applies
    WHERE organization_id = ${organizationId}
      AND agent_id = ${agentId}
      AND status = 'applied'
      AND applied_at IS NOT NULL
    LIMIT 1
  `;
	if (receipts.length > 0) throw new AgentSettingsManagedByReleaseError();
	return true;
}

async function replaceAgentSettings(
	tx: DbClient,
	organizationId: string,
	agentId: string,
	settings: Omit<AgentSettings, "updatedAt">,
): Promise<void> {
	await tx`
      UPDATE agents SET
        model = ${settings.model ?? null},
        model_selection = ${tx.json(settings.modelSelection ?? {})},
        provider_model_preferences = ${tx.json(settings.providerModelPreferences ?? {})},
        network_config = ${tx.json(settings.networkConfig ?? {})},
        egress_config = ${tx.json(settings.egressConfig ?? {})},
        nix_config = ${tx.json(settings.nixConfig ?? {})},
        mcp_servers = ${tx.json(settings.mcpServers ?? {})},
        soul_md = ${settings.soulMd ?? ""},
        user_md = ${settings.userMd ?? ""},
        identity_md = ${settings.identityMd ?? ""},
        skills_config = ${tx.json(settings.skillsConfig ?? { skills: [] })},
        tools_config = ${tx.json(settings.toolsConfig ?? {})},
        plugins_config = ${tx.json(settings.pluginsConfig ?? {})},
        installed_providers = ${tx.json(settings.installedProviders ?? [])},
        verbose_logging = ${settings.verboseLogging ?? false},
        pre_approved_tools = ${tx.json(settings.preApprovedTools ?? [])},
        guardrails = ${tx.json(settings.guardrails ?? [])},
        updated_at = NOW()
      WHERE organization_id = ${organizationId} AND id = ${agentId}
    `;
}

async function syncProvisioningGrantsInTransaction(
	tx: DbClient,
	organizationId: string,
	agentId: string,
	settings: Omit<AgentSettings, "updatedAt">,
): Promise<void> {
	const desired = new Map<string, { kind: string; pattern: string }>();
	for (const rawPattern of [
		...(settings.networkConfig?.allowedDomains ?? []),
		...(settings.preApprovedTools ?? []),
	]) {
		const pattern = normalizeDomainPattern(rawPattern);
		const kind = inferGrantKind(pattern);
		desired.set(`${kind}\u0000${pattern}`, { kind, pattern });
	}

	const owned = await tx<{ kind: string; pattern: string }>`
		SELECT owned.kind, owned.pattern
		FROM agent_fenced_provisioning_grants owned
		JOIN grants grant_row
		  ON grant_row.organization_id = owned.organization_id
		 AND grant_row.agent_id = owned.agent_id
		 AND grant_row.kind = owned.kind
		 AND grant_row.pattern = owned.pattern
		WHERE owned.organization_id = ${organizationId}
		  AND owned.agent_id = ${agentId}
		FOR UPDATE OF owned, grant_row
	`;
	const ownedKeys = new Set(
		owned.map((row) => `${row.kind}\u0000${row.pattern}`),
	);

	for (const row of owned) {
		if (desired.has(`${row.kind}\u0000${row.pattern}`)) continue;
		// The ownership row proves this grant came from fenced provisioning.
		// The FK cascades its provenance row when the grant is removed.
		await tx`
			DELETE FROM grants
			WHERE organization_id = ${organizationId}
			  AND agent_id = ${agentId}
			  AND kind = ${row.kind}
			  AND pattern = ${row.pattern}
			  AND EXISTS (
				SELECT 1 FROM agent_fenced_provisioning_grants owned
				WHERE owned.organization_id = ${organizationId}
				  AND owned.agent_id = ${agentId}
				  AND owned.kind = ${row.kind}
				  AND owned.pattern = ${row.pattern}
			  )
		`;
	}

	for (const [key, grant] of desired) {
		if (ownedKeys.has(key)) {
			const reactivated = await tx`
				UPDATE grants SET expires_at = NULL, granted_at = NOW(), denied = false
				WHERE organization_id = ${organizationId}
				  AND agent_id = ${agentId}
				  AND kind = ${grant.kind}
				  AND pattern = ${grant.pattern}
				RETURNING 1
			`;
			if (reactivated.length === 0) {
				throw new Error("Required unowned grant changed during fenced apply");
			}
			continue;
		}

		const inserted = await tx`
			INSERT INTO grants (
				organization_id, agent_id, kind, pattern, expires_at, granted_at, denied
			) VALUES (
				${organizationId}, ${agentId}, ${grant.kind}, ${grant.pattern},
				NULL, NOW(), false
			)
			ON CONFLICT (organization_id, agent_id, kind, pattern) DO NOTHING
			RETURNING 1
		`;
		if (inserted.length === 0) {
			// A manual/legacy grant already owns this row. Make the required
			// capability usable for this winning settings generation, but do not
			// claim fenced ownership; a later baseline removal must preserve it.
			await tx`
				UPDATE grants SET expires_at = NULL, granted_at = NOW(), denied = false
				WHERE organization_id = ${organizationId}
				  AND agent_id = ${agentId}
				  AND kind = ${grant.kind}
				  AND pattern = ${grant.pattern}
			`;
			continue;
		}
		await tx`
			INSERT INTO agent_fenced_provisioning_grants (
				organization_id, agent_id, kind, pattern
			) VALUES (
				${organizationId}, ${agentId}, ${grant.kind}, ${grant.pattern}
			)
		`;
	}
}

type ProvisioningFenceRow = {
	target_id: string;
	claim_generation: number;
	claim_token: string;
	baseline_version_id: string;
	effective_settings_digest: string;
	request_digest: string;
};

export async function provisionFencedAgent(input: {
	organizationId: string;
	agentId: string;
	name: string;
	description?: string;
	ownerUserId: string;
	patUserId: string;
	membershipId: string;
	ownerEmail: string;
	settings: Omit<AgentSettings, "updatedAt">;
	fence: ProvisioningFence;
	requestDigest: string;
}): Promise<{
	created: boolean;
	replayed: boolean;
	membership: { ensured: true; role: string };
}> {
	const sql = getDb();
	const result = await sql.begin(async (tx) => {
		const inserted = await tx`
			INSERT INTO agents (
				id, organization_id, name, description, owner_platform, owner_user_id,
				is_workspace_agent, workspace_id, created_at
			) VALUES (
				${input.agentId}, ${input.organizationId}, ${input.name},
				${input.description ?? null}, 'toolbox', ${input.ownerUserId},
				false, NULL, NOW()
			)
			ON CONFLICT (organization_id, id) DO NOTHING
			RETURNING 1
		`;
		const created = inserted.length > 0;
		if (
			!(await lockAgentAndAssertReleaseFence(
				tx,
				input.organizationId,
				input.agentId,
				true,
			))
		) {
			throw new Error(
				"Provisioned agent disappeared before fenced settings write",
			);
		}
		// The agent row is the durable mutex shared by every app replica. Fence
		// comparison and every downstream mutation stay inside this transaction.
		const fenceRows = await tx<ProvisioningFenceRow>`
			SELECT target_id, claim_generation, claim_token, baseline_version_id,
			       effective_settings_digest, request_digest
			FROM agent_provisioning_fences
			WHERE organization_id = ${input.organizationId}
			  AND agent_id = ${input.agentId}
		`;
		const current = fenceRows[0];
		if (current) {
			if (input.fence.claimGeneration < current.claim_generation) {
				throw new ProvisioningFenceError("provisioning_fence_stale");
			}
			if (input.fence.claimGeneration === current.claim_generation) {
				const exactReplay =
					input.fence.targetId === current.target_id &&
					input.fence.claimToken === current.claim_token &&
					input.fence.baselineVersionId === current.baseline_version_id &&
					input.fence.effectiveSettingsDigest ===
						current.effective_settings_digest &&
					input.requestDigest === current.request_digest;
				if (!exactReplay) {
					throw new ProvisioningFenceError("provisioning_fence_conflict");
				}
				const memberships = await tx<{ role: string }>`
					SELECT role FROM "member"
					WHERE "organizationId" = ${input.organizationId}
					  AND "userId" = ${input.ownerUserId}
					LIMIT 1
				`;
				return {
					created: false,
					replayed: true,
					membership: {
						ensured: true as const,
						role: String(memberships[0]?.role ?? "member"),
					},
				};
			}
		}

		await tx`
			INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
			VALUES (
				${input.ownerUserId}, ${input.ownerUserId}, ${input.ownerEmail},
				true, NOW(), NOW()
			)
			ON CONFLICT (id) DO NOTHING
		`;
		await tx`
			INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt")
			VALUES (
				${input.membershipId}, ${input.organizationId}, ${input.ownerUserId},
				'member', NOW()
			)
			ON CONFLICT ("organizationId", "userId") DO NOTHING
		`;
		const membershipRows = await tx<{ role: string }>`
			SELECT role FROM "member"
			WHERE "organizationId" = ${input.organizationId}
			  AND "userId" = ${input.ownerUserId}
			LIMIT 1
		`;

		await tx`
			UPDATE agents SET
				name = ${input.name},
				description = ${input.description ?? null},
				owner_platform = 'toolbox',
				owner_user_id = ${input.ownerUserId},
				is_workspace_agent = false,
				workspace_id = NULL,
				updated_at = NOW()
			WHERE organization_id = ${input.organizationId} AND id = ${input.agentId}
		`;
		await replaceAgentSettings(
			tx,
			input.organizationId,
			input.agentId,
			input.settings,
		);
		await tx`
			DELETE FROM agent_users
			WHERE organization_id = ${input.organizationId}
			  AND agent_id = ${input.agentId}
			  AND platform = 'toolbox'
			  AND user_id <> ${input.ownerUserId}
		`;
		await tx`
			INSERT INTO agent_users (organization_id, agent_id, platform, user_id, created_at)
			VALUES
				(${input.organizationId}, ${input.agentId}, 'toolbox', ${input.ownerUserId}, NOW()),
				(${input.organizationId}, ${input.agentId}, 'external', ${input.patUserId}, NOW())
			ON CONFLICT (organization_id, agent_id, platform, user_id) DO NOTHING
		`;
		await syncProvisioningGrantsInTransaction(
			tx,
			input.organizationId,
			input.agentId,
			input.settings,
		);
		await tx`
			INSERT INTO agent_provisioning_fences (
				organization_id, agent_id, target_id, claim_generation, claim_token,
				baseline_version_id, effective_settings_digest, request_digest,
				created_at, updated_at
			) VALUES (
				${input.organizationId}, ${input.agentId}, ${input.fence.targetId},
				${input.fence.claimGeneration}, ${input.fence.claimToken},
				${input.fence.baselineVersionId}, ${input.fence.effectiveSettingsDigest},
				${input.requestDigest}, NOW(), NOW()
			)
			ON CONFLICT (organization_id, agent_id) DO UPDATE SET
				target_id = EXCLUDED.target_id,
				claim_generation = EXCLUDED.claim_generation,
				claim_token = EXCLUDED.claim_token,
				baseline_version_id = EXCLUDED.baseline_version_id,
				effective_settings_digest = EXCLUDED.effective_settings_digest,
				request_digest = EXCLUDED.request_digest,
				updated_at = NOW()
		`;

		return {
			created,
			replayed: false,
			membership: {
				ensured: true as const,
				role: String(membershipRows[0]?.role ?? "member"),
			},
		};
	});

	if (!result.replayed) {
		recordLifecycleEvent({
			organizationId: input.organizationId,
			entityType: "agent",
			op: result.created ? "created" : "updated",
			entityId: input.agentId,
			summary: result.created
				? `Agent "${input.name}" created`
				: `Agent "${input.name}" updated`,
		});
	}
	return result;
}

export async function provisionLegacyAgent(input: {
	organizationId: string;
	agentId: string;
	name: string;
	description?: string;
	ownerUserId: string;
	patUserId: string;
	membershipId: string;
	ownerEmail: string;
	settings: Omit<AgentSettings, "updatedAt">;
	/** Test barrier invoked while the transaction owns the agent row lock. */
	transactionHooks?: {
		afterAgentLock?: () => Promise<void>;
	};
}): Promise<{ created: boolean; membership: { ensured: true; role: string } }> {
	const sql = getDb();
	const result = await sql.begin(async (tx) => {
		// INSERT-first serializes concurrent bootstrap attempts. On conflict it
		// does not mutate the existing row; the following FOR UPDATE then shares
		// the exact lock and ordering used by managed release apply.
		const inserted = await tx`
			INSERT INTO agents (
				id, organization_id, name, description, owner_platform, owner_user_id,
				is_workspace_agent, workspace_id, created_at
			) VALUES (
				${input.agentId}, ${input.organizationId}, ${input.name},
				${input.description ?? null}, 'toolbox', ${input.ownerUserId},
				false, NULL, NOW()
			)
			ON CONFLICT (organization_id, id) DO NOTHING
			RETURNING 1
		`;
		const created = inserted.length > 0;
		if (
			!(await lockAgentAndAssertReleaseFence(
				tx,
				input.organizationId,
				input.agentId,
				true,
				true,
			))
		) {
			throw new Error("Provisioned agent disappeared before settings write");
		}
		await input.transactionHooks?.afterAgentLock?.();

		await tx`
			INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
			VALUES (
				${input.ownerUserId}, ${input.ownerUserId}, ${input.ownerEmail},
				true, NOW(), NOW()
			)
			ON CONFLICT (id) DO NOTHING
		`;
		await tx`
			INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt")
			VALUES (
				${input.membershipId}, ${input.organizationId}, ${input.ownerUserId},
				'member', NOW()
			)
			ON CONFLICT ("organizationId", "userId") DO NOTHING
		`;
		const membershipRows = await tx<{ role: string }>`
			SELECT role
			FROM "member"
			WHERE "organizationId" = ${input.organizationId}
			  AND "userId" = ${input.ownerUserId}
			LIMIT 1
		`;

		await tx`
			UPDATE agents SET
				name = ${input.name},
				description = ${input.description ?? null},
				owner_platform = 'toolbox',
				owner_user_id = ${input.ownerUserId},
				is_workspace_agent = false,
				workspace_id = NULL,
				updated_at = NOW()
			WHERE organization_id = ${input.organizationId} AND id = ${input.agentId}
		`;
		await replaceAgentSettings(
			tx,
			input.organizationId,
			input.agentId,
			input.settings,
		);
		await tx`
			DELETE FROM agent_users
			WHERE organization_id = ${input.organizationId}
			  AND agent_id = ${input.agentId}
			  AND platform = 'toolbox'
			  AND user_id <> ${input.ownerUserId}
		`;
		await tx`
			INSERT INTO agent_users (organization_id, agent_id, platform, user_id, created_at)
			VALUES
				(${input.organizationId}, ${input.agentId}, 'toolbox', ${input.ownerUserId}, NOW()),
				(${input.organizationId}, ${input.agentId}, 'external', ${input.patUserId}, NOW())
			ON CONFLICT (organization_id, agent_id, platform, user_id) DO NOTHING
		`;

		return {
			created,
			membership: {
				ensured: true as const,
				role: String(membershipRows[0]?.role ?? "member"),
			},
		};
	});

	recordLifecycleEvent({
		organizationId: input.organizationId,
		entityType: "agent",
		op: result.created ? "created" : "updated",
		entityId: input.agentId,
		summary: result.created
			? `Agent "${input.name}" created`
			: `Agent "${input.name}" updated`,
	});
	return result;
}

/** Atomic legacy config patch that never rewrites fields absent from the request. */
export async function patchLegacyAgentSettings(
	organizationId: string,
	agentId: string,
	updates: Record<string, unknown>,
): Promise<void> {
	const writesManagedSettings = RELEASE_OWNED_SETTINGS.some((key) =>
		hasOwn(updates, key),
	);
	const sql = getDb();
	await sql.begin(async (tx) => {
		if (
			!(await lockAgentAndAssertReleaseFence(
				tx,
				organizationId,
				agentId,
				writesManagedSettings,
			))
		) {
			return;
		}
		await tx`
      UPDATE agents SET
        model = CASE WHEN ${hasOwn(updates, "model")} THEN ${updates.model ?? null} ELSE model END,
        model_selection = CASE WHEN ${hasOwn(updates, "modelSelection")}
          THEN ${tx.json(updates.modelSelection ?? {})} ELSE model_selection END,
        provider_model_preferences = CASE WHEN ${hasOwn(updates, "providerModelPreferences")}
          THEN ${tx.json(updates.providerModelPreferences ?? {})} ELSE provider_model_preferences END,
        network_config = CASE WHEN ${hasOwn(updates, "networkConfig")}
          THEN ${tx.json(updates.networkConfig ?? {})} ELSE network_config END,
        egress_config = CASE WHEN ${hasOwn(updates, "egressConfig")}
          THEN ${tx.json(updates.egressConfig ?? {})} ELSE egress_config END,
        nix_config = CASE WHEN ${hasOwn(updates, "nixConfig")}
          THEN ${tx.json(updates.nixConfig ?? {})} ELSE nix_config END,
        mcp_servers = CASE WHEN ${hasOwn(updates, "mcpServers")}
          THEN ${tx.json(updates.mcpServers ?? {})} ELSE mcp_servers END,
        soul_md = CASE WHEN ${hasOwn(updates, "soulMd")} THEN ${updates.soulMd ?? ""} ELSE soul_md END,
        user_md = CASE WHEN ${hasOwn(updates, "userMd")} THEN ${updates.userMd ?? ""} ELSE user_md END,
        identity_md = CASE WHEN ${hasOwn(updates, "identityMd")}
          THEN ${updates.identityMd ?? ""} ELSE identity_md END,
        skills_config = CASE WHEN ${hasOwn(updates, "skillsConfig")}
          THEN ${tx.json(updates.skillsConfig ?? { skills: [] })} ELSE skills_config END,
        tools_config = CASE WHEN ${hasOwn(updates, "toolsConfig")}
          THEN ${tx.json(updates.toolsConfig ?? {})} ELSE tools_config END,
        plugins_config = CASE WHEN ${hasOwn(updates, "pluginsConfig")}
          THEN ${tx.json(updates.pluginsConfig ?? {})} ELSE plugins_config END,
        installed_providers = CASE WHEN ${hasOwn(updates, "installedProviders")}
          THEN ${tx.json(updates.installedProviders ?? [])} ELSE installed_providers END,
        verbose_logging = CASE WHEN ${hasOwn(updates, "verboseLogging")}
          THEN ${updates.verboseLogging ?? false} ELSE verbose_logging END,
        pre_approved_tools = CASE WHEN ${hasOwn(updates, "preApprovedTools")}
          THEN ${tx.json(updates.preApprovedTools ?? [])} ELSE pre_approved_tools END,
        guardrails = CASE WHEN ${hasOwn(updates, "guardrails")}
          THEN ${tx.json(updates.guardrails ?? [])} ELSE guardrails END,
        updated_at = NOW()
      WHERE organization_id = ${organizationId} AND id = ${agentId}
    `;
	});
}
