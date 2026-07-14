import type { AgentSettings } from "@lobu/core";
import type { DbClient } from "../db/client.js";
import { getDb } from "../db/client.js";

export const AGENT_SETTINGS_MANAGED_BY_RELEASE =
	"agent_settings_managed_by_release";

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

function hasOwn(value: object, key: PropertyKey): boolean {
	return Object.hasOwn(value, key);
}

async function lockAgentAndAssertReleaseFence(
	tx: DbClient,
	organizationId: string,
	agentId: string,
	writesManagedSettings: boolean,
): Promise<boolean> {
	const agents = await tx`
    SELECT 1
    FROM agents
    WHERE organization_id = ${organizationId} AND id = ${agentId}
    FOR UPDATE
  `;
	if (agents.length === 0) return false;
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

/** Full legacy provisioning replacement, including the five release-owned fields. */
export async function saveLegacyProvisionedAgentSettings(
	organizationId: string,
	agentId: string,
	settings: Omit<AgentSettings, "updatedAt">,
): Promise<void> {
	const sql = getDb();
	await sql.begin(async (tx) => {
		if (
			!(await lockAgentAndAssertReleaseFence(tx, organizationId, agentId, true))
		)
			return;
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
	});
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
