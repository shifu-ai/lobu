import { type AgentSettings, type AuthProfile, createLogger } from "@lobu/core";
import { getDb } from "../../../db/client.js";
import {
  agentSettingsWithDefinedValues,
  deleteAgentSettingsFromPg,
  loadAgentSettingsFromPg,
  saveAgentSettingsToPg,
  type AgentSettingsContext,
} from "../../../lobu/stores/agent-settings-persistence.js";
import { tryGetOrgId } from "../../../lobu/stores/org-context.js";
import type { DeclaredAgentRegistry } from "../../services/declared-agent-registry.js";

// Re-export so existing imports from this module keep working.
export type { AgentSettings, AgentSettingsContext };

const logger = createLogger("agent-settings-store");

/**
 * Shared in-memory ephemeral auth profile registry. Lives on
 * AgentSettingsStore because it's the single shared instance every
 * `AuthProfilesManager` (including the ones each provider module constructs)
 * is built against. Storing the map here keeps all managers in sync — a
 * must-have for SDK-embedded use where `provider.key` seeds a credential on
 * the central manager and a provider module later asks "does this agent have
 * credentials?".
 */
export class EphemeralAuthProfileRegistry {
  private readonly profiles = new Map<string, AuthProfile[]>();

  get(agentId: string): AuthProfile[] | undefined {
    return this.profiles.get(agentId);
  }

  set(agentId: string, profiles: AuthProfile[]): void {
    this.profiles.set(agentId, profiles);
  }

  delete(agentId: string): void {
    this.profiles.delete(agentId);
  }
}

/**
 * Per-agent settings reader/writer over `public.agents`.
 *
 * Holds runtime-mutable settings for agents created via the UI or sandbox
 * paths. Declared agents (lobu.toml / SDK config) live in
 * `DeclaredAgentRegistry` and never touch Postgres for settings reads. Auth
 * profiles are owned by `UserAuthProfileStore` keyed by `(userId, agentId)`.
 */
export class AgentSettingsStore {
  private readonly ephemeralAuthProfiles = new EphemeralAuthProfileRegistry();
  private declaredAgents?: DeclaredAgentRegistry;

  getEphemeralAuthProfiles(): EphemeralAuthProfileRegistry {
    return this.ephemeralAuthProfiles;
  }

  /**
   * Wire the declared-agent registry so `getEffectiveSettings`
   * returns declared settings for declared agents (which have no
   * persisted Postgres copy by design). Called once from CoreServices
   * after the registry is built.
   */
  setDeclaredAgents(registry: DeclaredAgentRegistry): void {
    this.declaredAgents = registry;
  }

  /**
   * Get raw settings for an agent. Sensitive values are returned as refs;
   * callers that need plaintext must resolve them through the secret store
   * (e.g., via AuthProfilesManager.listProfiles).
   */
  async getSettings(agentId: string): Promise<AgentSettings | null> {
    return loadAgentSettingsFromPg(getDb(), agentId, tryGetOrgId(), {
      omitEmptyDefaults: true,
    });
  }

  /**
   * Get effective settings for an agent, with template agent fallback.
   * For sandbox agents, inherits from the template agent when own settings
   * are missing or have no providers configured.
   */
  async getEffectiveSettings(agentId: string): Promise<AgentSettings | null> {
    const context = await this.getSettingsContext(agentId);
    return context.effectiveSettings;
  }

  async getSettingsContext(agentId: string): Promise<AgentSettingsContext> {
    const declared = this.declaredAgents?.get(agentId);
    if (declared) {
      // Declared agents are immutable from runtime: no PG local copy,
      // no template fallback. Return registry settings as effective.
      return {
        localSettings: null,
        effectiveSettings: declared.settings as AgentSettings,
      };
    }

    const localSettings = await this.getSettings(agentId);

    const templateAgentId = await this.resolveTemplateAgentId(
      agentId,
      localSettings
    );
    if (!templateAgentId) {
      return { localSettings, effectiveSettings: localSettings };
    }

    const templateSettings = await this.getSettings(templateAgentId);
    if (!templateSettings) {
      return {
        localSettings,
        effectiveSettings: localSettings,
        templateAgentId,
      };
    }

    if (!localSettings) {
      return {
        localSettings,
        effectiveSettings: { ...templateSettings, templateAgentId },
        templateAgentId,
      };
    }

    return {
      localSettings,
      effectiveSettings: {
        ...templateSettings,
        ...agentSettingsWithDefinedValues(localSettings),
        templateAgentId,
      } as AgentSettings,
      templateAgentId,
    };
  }

  /**
   * Resolve the template agent ID for a sandbox agent.
   * Chain: settings.templateAgentId → agents.parent_connection_id → connection.agent_id
   */
  private async resolveTemplateAgentId(
    agentId: string,
    settings: AgentSettings | null
  ): Promise<string | undefined> {
    if (settings?.templateAgentId) return settings.templateAgentId;

    const sql = getDb();
    try {
      const orgId = tryGetOrgId();
      const rows = orgId
        ? await sql`
            SELECT parent_connection_id
            FROM agents
            WHERE id = ${agentId} AND organization_id = ${orgId}
          `
        : await sql`
            SELECT parent_connection_id
            FROM agents
            WHERE id = ${agentId}
          `;
      const parentConnectionId = rows[0]?.parent_connection_id as
        | string
        | undefined;
      if (!parentConnectionId) return undefined;

      const conn = await sql`
        SELECT agent_id FROM agent_connections WHERE id = ${parentConnectionId}
      `;
      return (conn[0]?.agent_id as string | undefined) ?? undefined;
    } catch (error) {
      logger.warn("Failed to resolve template agent id", {
        agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  async saveSettings(
    agentId: string,
    settings: Omit<AgentSettings, "updatedAt">
  ): Promise<void> {
    await saveAgentSettingsToPg(getDb(), agentId, settings, tryGetOrgId());

    logger.info(`Saved settings for agent ${agentId}`);
  }

  async updateSettings(
    agentId: string,
    updates: Partial<Omit<AgentSettings, "updatedAt">>
  ): Promise<void> {
    const existing = await this.getSettings(agentId);
    if (!existing) {
      // No row yet — fall through to saveSettings, which create-or-overwrites.
      await this.saveSettings(agentId, updates as Omit<AgentSettings, "updatedAt">);
      return;
    }
    await this.saveSettings(agentId, { ...existing, ...updates });
  }

  async deleteSettings(agentId: string): Promise<void> {
    this.ephemeralAuthProfiles.delete(agentId);
    await deleteAgentSettingsFromPg(getDb(), agentId, tryGetOrgId());

    logger.info(`Deleted settings for agent ${agentId}`);
  }

  /**
   * Find all sandbox agent IDs that reference a given template agent.
   */
  async findSandboxAgentIds(templateAgentId: string): Promise<string[]> {
    const sql = getDb();
    const orgId = tryGetOrgId();
    const rows = orgId
      ? await sql`
          SELECT id FROM agents
          WHERE organization_id = ${orgId} AND template_agent_id = ${templateAgentId}
        `
      : await sql`
          SELECT id FROM agents WHERE template_agent_id = ${templateAgentId}
        `;
    return rows.map((row) => row.id as string);
  }

  async hasSettings(agentId: string): Promise<boolean> {
    const settings = await this.getSettings(agentId);
    return settings !== null;
  }

}
