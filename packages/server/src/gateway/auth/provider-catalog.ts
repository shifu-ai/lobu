import { randomUUID } from "node:crypto";
import { createLogger, type InstalledProvider } from "@lobu/core";
import {
  getModelProviderModules,
  type ModelProviderModule,
} from "../modules/module-system.js";
import type { DeclaredAgentRegistry } from "../services/declared-agent-registry.js";
import {
  AgentConfigurationMutationConflictError,
  type AgentConfigurationMutationPort,
  AgentConfigurationMutationRejectedError,
  AgentConfigurationMutationTargetNotFoundError,
  type ProviderMutationSubject,
  type UndigestedNativePatchInput,
} from "./agent-configuration-mutation-port.js";
import type { AgentSettingsStore } from "./settings/agent-settings-store.js";
import type { AuthProfilesManager } from "./settings/auth-profiles-manager.js";
import { reconcileModelSelectionForInstalledProviders } from "./settings/model-selection.js";

const logger = createLogger("provider-catalog");

/**
 * Resolve an agent's installed providers.
 */
async function resolveInstalledProviders(
  agentSettingsStore: AgentSettingsStore,
  agentId: string
): Promise<InstalledProvider[]> {
  const settings = await agentSettingsStore.getSettings(agentId);
  return settings?.installedProviders || [];
}

/**
 * ProviderCatalogService wraps the module registry to provide
 * per-agent provider install/uninstall/reorder operations.
 *
 * Providers are registered globally in the module registry,
 * but each agent chooses which providers to install from the catalog.
 */
const DECLARED_AGENT_MUTATION_ERROR =
  "provider list is declared in lobu.config.ts; edit the file and restart";

export class ProviderCatalogService {
  constructor(
    private agentSettingsStore: AgentSettingsStore,
    private authProfilesManager: AuthProfilesManager,
    private declaredAgents: DeclaredAgentRegistry,
    private configurationMutations: AgentConfigurationMutationPort,
    private createCommandId: () => string = randomUUID,
    private now: () => number = Date.now
  ) {}

  private guardDeclared(agentId: string): void {
    if (this.declaredAgents.has(agentId)) {
      throw new Error(DECLARED_AGENT_MUTATION_ERROR);
    }
  }

  /**
   * List all catalog-visible providers from the module registry.
   */
  listCatalogProviders(): ModelProviderModule[] {
    return getModelProviderModules().filter((m) => m.catalogVisible !== false);
  }

  /**
   * Resolve an agent's installedProviders to their module instances.
   * Returns modules in the agent's install order.
   */
  async getInstalledModules(agentId: string): Promise<ModelProviderModule[]> {
    const installed = await resolveInstalledProviders(
      this.agentSettingsStore,
      agentId
    );
    if (installed.length === 0) return [];

    const allModules = getModelProviderModules();
    const moduleMap = new Map(allModules.map((m) => [m.providerId, m]));

    return installed
      .map((ip) => moduleMap.get(ip.providerId))
      .filter((m): m is ModelProviderModule => m !== undefined);
  }

  /**
   * Get raw installed provider entries for an agent.
   */
  async getInstalledProviders(agentId: string): Promise<InstalledProvider[]> {
    return resolveInstalledProviders(this.agentSettingsStore, agentId);
  }

  /**
   * Install a provider for an agent. Appends to the end of the list.
   */
  async installProvider(
    subject: ProviderMutationSubject,
    providerId: string,
    config?: InstalledProvider["config"]
  ): Promise<void> {
    const { agentId } = subject;
    this.guardDeclared(agentId);
    const allModules = getModelProviderModules();
    const module = allModules.find((m) => m.providerId === providerId);
    if (!module) {
      throw new Error(`Unknown provider: ${providerId}`);
    }

    const { settings, configurationRevision } =
      await this.readMutationInputs(subject);
    const installed = settings?.installedProviders || [];

    if (installed.some((ip) => ip.providerId === providerId)) {
      logger.info(
        `Provider ${providerId} already installed for agent ${agentId}`
      );
      return;
    }

    const entry: InstalledProvider = {
      providerId,
      installedAt: this.now(),
      ...(config ? { config } : {}),
    };
    const nextInstalledProviders = [...installed, entry];
    const reconciled = reconcileModelSelectionForInstalledProviders({
      model: settings?.model,
      modelSelection: settings?.modelSelection,
      providerModelPreferences: settings?.providerModelPreferences,
      installedProviders: nextInstalledProviders,
    });

    await this.applyProviderPatch(subject, configurationRevision, {
      installedProviders: nextInstalledProviders,
      model: reconciled.model ?? null,
      modelSelection: reconciled.modelSelection,
      providerModelPreferences: reconciled.providerModelPreferences ?? null,
    });

    logger.info(`Installed provider ${providerId} for agent ${agentId}`);
  }

  /**
   * Uninstall a provider from an agent. Also cleans up auth profiles.
   */
  async uninstallProvider(
    subject: ProviderMutationSubject,
    providerId: string
  ): Promise<void> {
    const { agentId } = subject;
    this.guardDeclared(agentId);
    const { settings, configurationRevision } =
      await this.readMutationInputs(subject);
    const installed = settings?.installedProviders || [];

    const filtered = installed.filter((ip) => ip.providerId !== providerId);
    if (filtered.length === installed.length) {
      logger.info(
        `Provider ${providerId} not installed for agent ${agentId}, nothing to uninstall`
      );
      return;
    }

    // Clean up ephemeral auth profiles. User-scoped profiles in
    // UserAuthProfileStore stay put — uninstalling a provider on a
    // runtime agent shouldn't cascade-delete every user's tokens; users
    // remove their own credentials from the per-user UI.
    const reconciled = reconcileModelSelectionForInstalledProviders({
      model: settings?.model,
      modelSelection: settings?.modelSelection,
      providerModelPreferences: settings?.providerModelPreferences,
      installedProviders: filtered,
    });

    await this.applyProviderPatch(subject, configurationRevision, {
      installedProviders: filtered,
      model: reconciled.model ?? null,
      modelSelection: reconciled.modelSelection,
      providerModelPreferences: reconciled.providerModelPreferences ?? null,
    });
    await this.authProfilesManager.deleteProviderProfiles(agentId, providerId);

    logger.info(`Uninstalled provider ${providerId} for agent ${agentId}`);
  }

  /**
   * Find the provider module whose model options include the given model string.
   */
  async findProviderForModel(
    model: string,
    providers?: ModelProviderModule[]
  ): Promise<ModelProviderModule | undefined> {
    const candidates = providers || getModelProviderModules();
    for (const provider of candidates) {
      if (!provider.getModelOptions) continue;
      const options = await provider.getModelOptions("", "");
      if (options.some((opt) => opt.value === model)) {
        return provider;
      }
    }
    // Fallback: a "<providerId>/<model>" ref names its provider directly, so
    // match by the leading segment even when the provider's option list did not
    // contain an exact value. This is essential for providers whose models are
    // fetched live and may be empty in this resolution context.
    const slashIndex = model.indexOf("/");
    if (slashIndex > 0) {
      const prefix = model.slice(0, slashIndex);
      const byProviderId = candidates.find((p) => p.providerId === prefix);
      if (byProviderId) {
        return byProviderId;
      }
    }
    return undefined;
  }

  /**
   * Reorder installed providers. The orderedIds must contain
   * exactly the same provider IDs as currently installed.
   */
  async reorderProviders(
    subject: ProviderMutationSubject,
    orderedIds: string[]
  ): Promise<void> {
    const { agentId } = subject;
    this.guardDeclared(agentId);
    const { settings, configurationRevision } =
      await this.readMutationInputs(subject);
    const installed = settings?.installedProviders || [];

    const installedMap = new Map(installed.map((ip) => [ip.providerId, ip]));

    // Validate all ordered IDs exist in installed
    for (const id of orderedIds) {
      if (!installedMap.has(id)) {
        throw new Error(`Provider ${id} is not installed`);
      }
    }

    const reordered = orderedIds
      .map((id) => installedMap.get(id))
      .filter((ip): ip is InstalledProvider => ip !== undefined);

    // Append any installed providers not in orderedIds (shouldn't happen but safety)
    for (const ip of installed) {
      if (!orderedIds.includes(ip.providerId)) {
        reordered.push(ip);
      }
    }
    const reconciled = reconcileModelSelectionForInstalledProviders({
      model: settings?.model,
      modelSelection: settings?.modelSelection,
      providerModelPreferences: settings?.providerModelPreferences,
      installedProviders: reordered,
    });

    await this.applyProviderPatch(subject, configurationRevision, {
      installedProviders: reordered,
      model: reconciled.model ?? null,
      modelSelection: reconciled.modelSelection,
      providerModelPreferences: reconciled.providerModelPreferences ?? null,
    });

    logger.info(
      `Reordered providers for agent ${agentId}: ${orderedIds.join(", ")}`
    );
  }

  private async applyProviderPatch(
    subject: ProviderMutationSubject,
    expectedConfigurationRevision: string,
    patch: UndigestedNativePatchInput["patch"]
  ): Promise<void> {
    const result = await this.configurationMutations.updateNativeConfiguration({
      ...subject,
      commandId: this.createCommandId(),
      expectedConfigurationRevision,
      actor: { kind: "provider_catalog" },
      patch,
    });
    if ("state" in result) {
      return;
    }
    if (result.status === "rejected") {
      throw new AgentConfigurationMutationRejectedError(result.reason);
    }
    if (result.status === "conflict") {
      throw new AgentConfigurationMutationConflictError(
        result.conflict,
        result.currentRevision
      );
    }
  }

  private async readMutationInputs(subject: ProviderMutationSubject) {
    const appliedState =
      await this.configurationMutations.readAppliedState(subject);
    if (!appliedState) {
      throw new AgentConfigurationMutationTargetNotFoundError();
    }
    const settings = await this.agentSettingsStore.getSettings(subject.agentId);
    if (!settings) {
      throw new AgentConfigurationMutationTargetNotFoundError();
    }
    return {
      configurationRevision: appliedState.configurationRevision,
      settings,
    };
  }
}
