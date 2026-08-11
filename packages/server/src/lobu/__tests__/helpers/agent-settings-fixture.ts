import type { AgentSettings } from '@lobu/core';
import { getDb } from '../../../db/client';

/** Test-only full settings projection. Production configuration writes must use the authority. */
export async function seedAgentSettings(
  organizationId: string,
  agentId: string,
  settings: Partial<AgentSettings>
): Promise<void> {
  const sql = getDb();
  await sql`
    UPDATE agents SET
      model = ${settings.model ?? null},
      model_selection = ${sql.json(settings.modelSelection ?? {})},
      provider_model_preferences = ${sql.json(settings.providerModelPreferences ?? {})},
      network_config = ${sql.json(settings.networkConfig ?? {})},
      egress_config = ${sql.json(settings.egressConfig ?? {})},
      nix_config = ${sql.json(settings.nixConfig ?? {})},
      mcp_servers = ${sql.json(settings.mcpServers ?? {})},
      soul_md = ${settings.soulMd ?? ''},
      user_md = ${settings.userMd ?? ''},
      identity_md = ${settings.identityMd ?? ''},
      skills_config = ${sql.json(settings.skillsConfig ?? { skills: [] })},
      tools_config = ${sql.json(settings.toolsConfig ?? {})},
      plugins_config = ${sql.json(settings.pluginsConfig ?? {})},
      installed_providers = ${sql.json(settings.installedProviders ?? [])},
      verbose_logging = ${settings.verboseLogging ?? false},
      pre_approved_tools = ${sql.json(settings.preApprovedTools ?? [])},
      guardrails = ${sql.json(settings.guardrails ?? [])},
      updated_at = NOW()
    WHERE organization_id = ${organizationId} AND id = ${agentId}
  `;
}
