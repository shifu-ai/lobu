#!/usr/bin/env bun

import {
  BaseInstructionProvider,
  buildUnconfiguredAgentNotice,
  createLogger,
  type InstructionContext,
  type InstructionProvider,
} from "@lobu/core";
import type { McpConfigService } from "../auth/mcp/config-service.js";
import type { AgentSettingsStore } from "../auth/settings/agent-settings-store.js";

const logger = createLogger("instruction-service");

// Re-export so existing `import { BaseInstructionProvider } from
// "../services/instruction-service"` paths keep working.
export { BaseInstructionProvider };

interface McpStatus {
  id: string;
  name: string;
  requiresAuth: boolean;
  requiresInput: boolean;
}

interface SessionContextData {
  agentInstructions: string;
  platformInstructions: string;
  networkInstructions: string;
  skillsInstructions: string;
  mcpStatus: McpStatus[];
}

interface ToolboxActiveContextResponse {
  contextPack?: {
    title?: unknown;
    summary?: unknown;
    confidence?: unknown;
    importantArtifacts?: unknown;
  } | null;
  run?: unknown;
}

interface ToolboxActiveContextArtifact {
  title: string;
  preview: string;
  source: string;
  url?: string;
}

/**
 * Provides instructions from enabled skills for the agent.
 * Fetches skill content from AgentSettings and injects as instructions.
 * Falls back to generic skill discovery instructions if no skills configured.
 */
class SkillsInstructionProvider extends BaseInstructionProvider {
  readonly name = "skills";
  readonly priority = 15;

  constructor(private agentSettingsStore?: AgentSettingsStore) {
    super();
  }

  protected async buildInstructions(
    context: InstructionContext
  ): Promise<string> {
    // If no settings store or agentId, return generic skill discovery instructions
    if (!this.agentSettingsStore || !context.agentId) {
      return this.getGenericSkillsInstructions();
    }

    // Settings lookup uses a local try/catch because the domain-specific
    // fallback here is "return the generic skills blurb", not "empty string".
    // The base class's catch-all still guards against any bug outside this
    // block.
    let enabledSkills: Array<{
      name: string;
      description?: string;
      repo: string;
      content?: string;
      modelPreference?: string;
      thinkingLevel?: string;
      instructions?: string;
    }> = [];
    try {
      const settings = await this.agentSettingsStore.getSettings(
        context.agentId
      );
      const skills = settings?.skillsConfig?.skills || [];
      enabledSkills = skills.filter((s) => s.enabled && s.content);
    } catch (error) {
      logger.error("Failed to load skill settings", { error });
      return this.getGenericSkillsInstructions();
    }

    if (enabledSkills.length === 0) {
      return this.getGenericSkillsInstructions();
    }

    // Progressive disclosure: inject only metadata (name + description + model/thinking tags)
    // to reduce prompt size. Agent reads full SKILL.md on demand.
    const skillSummaries = enabledSkills
      .map((skill) => {
        const desc = skill.description ? ` - ${skill.description}` : "";
        const tags: string[] = [];
        if (skill.modelPreference) {
          tags.push(`[model: ${skill.modelPreference}]`);
        }
        if (skill.thinkingLevel) {
          tags.push(`[thinking: ${skill.thinkingLevel}]`);
        }
        const tagStr = tags.length > 0 ? ` ${tags.join(" ")}` : "";
        const line = `- **${skill.name}**${desc} (\`${skill.repo}\`)${tagStr}`;
        if (skill.instructions?.trim()) {
          return `${line}\n  → ${skill.instructions.trim()}`;
        }
        return line;
      })
      .join("\n");

    return `# Enabled Skills

The following skills are installed and available. When a task matches a skill, read the full skill instructions before using it. Skills tagged with [model: ...] prefer a specific model — delegate to the corresponding coding agent when available.

${skillSummaries}

**To read full skill instructions:** \`cat .skills/*/SKILL.md\` to read the relevant SKILL.md file.

---

${this.getGenericSkillsInstructions()}`;
  }

  private getGenericSkillsInstructions(): string {
    return `## Skills

Your available skills are listed above. To read full instructions for a skill, use: \`cat .skills/{skillName}/SKILL.md\``;
  }
}

/**
 * Provides information about network access rules and allowed domains
 */
class NetworkInstructionProvider extends BaseInstructionProvider {
  readonly name = "network";
  readonly priority = 20;

  protected buildInstructions(_context: InstructionContext): string {
    const allowedDomains = process.env.WORKER_ALLOWED_DOMAINS?.trim() || "";
    const disallowedDomains =
      process.env.WORKER_DISALLOWED_DOMAINS?.trim() || "";

    // Unrestricted mode
    if (allowedDomains === "*") {
      if (disallowedDomains) {
        const blockedList = disallowedDomains
          .split(",")
          .map((d) => `  - ${d.trim()}`)
          .filter((d) => d.length > 4)
          .join("\n");
        return `## Network Access

**Internet Access:** Unrestricted (all domains allowed)

**Blocked domains:**
${blockedList}

You can access any external service except the blocked domains listed above.`;
      }
      return `## Network Access

**Internet Access:** Unrestricted (all domains allowed)

You can access any external service without restrictions.`;
    }

    // Complete isolation
    if (!allowedDomains) {
      return `## Network Access

**Internet Access:** Complete isolation (no external access)

You do NOT have access to the internet. All external requests (curl, wget, npm, pip, etc.) will fail. Network access is configured via lobu.config.ts or the gateway configuration APIs. Only local operations and MCP tools are available.`;
    }

    // Allowlist mode
    const allowedList = allowedDomains
      .split(",")
      .map((d) => `  - ${d.trim()}`)
      .filter((d) => d.length > 4)
      .join("\n");

    let instructions = `## Network Access

**Internet Access:** Filtered (allowlist mode)

**Allowed domains:**
${allowedList}`;

    if (disallowedDomains) {
      const blockedList = disallowedDomains
        .split(",")
        .map((d) => `  - ${d.trim()}`)
        .filter((d) => d.length > 4)
        .join("\n");
      instructions += `

**Blocked domains:**
${blockedList}`;
    }

    instructions += `

You can only access the allowed domains listed above. All other external requests will be blocked by the proxy. Network access is configured via lobu.config.ts or the gateway configuration APIs. Plan your work accordingly and use available MCP tools when possible.`;

    return instructions;
  }
}

class ToolboxActiveContextInstructionProvider extends BaseInstructionProvider {
  readonly name = "toolbox-active-context";
  readonly priority = 25;

  protected async buildInstructions(
    context: InstructionContext
  ): Promise<string> {
    const baseUrl = process.env.TOOLBOX_ACTIVE_CONTEXT_URL?.trim();
    const secret = process.env.TOOLBOX_INTERNAL_SECRET?.trim();
    if (!baseUrl || !secret || !context.userId || !context.agentId) {
      return "";
    }

    try {
      const url = new URL(baseUrl);
      url.searchParams.set("ownerUserId", context.userId);
      url.searchParams.set("agentId", context.agentId);

      const response = await fetch(url.toString(), {
        method: "GET",
        headers: { "X-Internal-Secret": secret },
      });
      if (!response.ok) {
        return "";
      }

      const body = (await response.json()) as ToolboxActiveContextResponse;
      const contextPack = body?.contextPack;
      if (!contextPack || typeof contextPack !== "object") {
        return "";
      }

      const title = this.toInstructionValue(contextPack.title);
      const summary = this.toInstructionValue(contextPack.summary);
      const confidence = this.toInstructionValue(contextPack.confidence);
      if (!title && !summary) {
        return "";
      }

      const artifacts = this.parseArtifacts(contextPack.importantArtifacts);
      const lines = [
        "## Active Project Context",
        "",
        `Project: ${title || "Untitled project"}`,
        `Confidence: ${confidence || "unknown"}`,
        `Summary: ${summary || "No summary provided."}`,
      ];

      if (artifacts.length > 0) {
        lines.push("", "Important artifacts:");
        for (const artifact of artifacts) {
          const urlSuffix = artifact.url ? ` (${artifact.url})` : "";
          lines.push(
            `- ${artifact.title} [${artifact.source}]: ${artifact.preview}${urlSuffix}`
          );
        }
      }

      lines.push(
        "",
        "Use this context as the current user's active project background. If confidence is low, say so when relying on it."
      );

      return lines.join("\n");
    } catch {
      return "";
    }
  }

  private parseArtifacts(value: unknown): ToolboxActiveContextArtifact[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value.slice(0, 5).flatMap((artifact) => {
      if (!artifact || typeof artifact !== "object") {
        return [];
      }
      const record = artifact as Record<string, unknown>;
      const title = this.toInstructionValue(record.title);
      const preview = this.toInstructionValue(record.preview);
      const source = this.toInstructionValue(record.source);
      const url = this.toInstructionValue(record.url);
      if (!title && !preview && !source && !url) {
        return [];
      }
      return [
        {
          title: title || "Untitled artifact",
          preview: preview || "No preview provided.",
          source: source || "unknown",
          url,
        },
      ];
    });
  }

  private toInstructionValue(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
  }
}

/**
 * Aggregates session context data for workers
 * Returns raw data (not built instructions) so workers can format as needed
 */
export class InstructionService {
  private platformProviders = new Map<string, InstructionProvider>();
  private mcpConfigService?: McpConfigService;
  private agentSettingsStore?: AgentSettingsStore;
  private skillsProvider: SkillsInstructionProvider;

  constructor(
    mcpConfigService?: McpConfigService,
    agentSettingsStore?: AgentSettingsStore
  ) {
    this.mcpConfigService = mcpConfigService;
    this.agentSettingsStore = agentSettingsStore;
    this.skillsProvider = new SkillsInstructionProvider(agentSettingsStore);
  }

  /**
   * Register a platform-specific instruction provider
   * Called by platform adapters during initialization
   */
  registerPlatformProvider(
    platform: string,
    provider: InstructionProvider
  ): void {
    this.platformProviders.set(platform, provider);
    logger.info(
      `Registered instruction provider for platform: ${platform} (${provider.name})`
    );
  }

  /**
   * Get session context data for a worker
   */
  async getSessionContext(
    platform: string,
    context: InstructionContext,
    options?: { settingsUrl?: string }
  ): Promise<SessionContextData> {
    // Get platform-specific instructions
    let platformInstructions = "";
    const platformProvider = this.platformProviders.get(platform);
    if (platformProvider) {
      try {
        platformInstructions = await platformProvider.getInstructions(context);
        logger.info(
          `Got ${platform} platform instructions (${platformInstructions.length} chars)`
        );
      } catch (error) {
        logger.error(
          `Failed to get instructions from ${platform} provider:`,
          error
        );
      }
    }

    // Get network access instructions
    let networkInstructions = "";
    const networkProvider = new NetworkInstructionProvider();
    try {
      networkInstructions = await networkProvider.getInstructions(context);
      logger.info(
        `Got network instructions (${networkInstructions.length} chars)`
      );
    } catch (error) {
      logger.error("Failed to get network instructions:", error);
    }

    const toolboxActiveContextProvider =
      new ToolboxActiveContextInstructionProvider();
    let toolboxActiveContextInstructions = "";
    try {
      toolboxActiveContextInstructions =
        await toolboxActiveContextProvider.getInstructions(context);
      if (toolboxActiveContextInstructions) {
        logger.info(
          `Got Toolbox active context instructions (${toolboxActiveContextInstructions.length} chars)`
        );
      }
    } catch (error) {
      logger.error("Failed to get Toolbox active context instructions:", error);
    }

    platformInstructions = [
      platformInstructions,
      toolboxActiveContextInstructions,
    ]
      .filter(Boolean)
      .join("\n\n");

    // Build agent instructions from identity/soul/user settings
    let agentInstructions = "";
    if (this.agentSettingsStore && context.agentId) {
      try {
        const settings = await this.agentSettingsStore.getSettings(
          context.agentId
        );
        if (settings) {
          const sections: string[] = [];
          if (settings.identityMd?.trim()) {
            sections.push(`## Agent Identity\n\n${settings.identityMd.trim()}`);
          }
          if (settings.soulMd?.trim()) {
            sections.push(`## Agent Instructions\n\n${settings.soulMd.trim()}`);
          }
          if (settings.userMd?.trim()) {
            sections.push(`## User Context\n\n${settings.userMd.trim()}`);
          }
          agentInstructions = sections.join("\n\n");
        }

        // When soul is unconfigured, tell the agent to defer to admin config.
        if (!agentInstructions.trim()) {
          agentInstructions = buildUnconfiguredAgentNotice(
            options?.settingsUrl
          );
        }

        logger.info(
          `Built agent instructions (${agentInstructions.length} chars)`
        );
      } catch (error) {
        logger.error("Failed to build agent instructions:", error);
      }
    }

    // Get skills instructions (includes enabled skills from agent settings)
    let skillsInstructions = "";
    try {
      skillsInstructions = await this.skillsProvider.getInstructions(context);
      logger.info(
        `Got skills instructions (${skillsInstructions.length} chars)`
      );
    } catch (error) {
      logger.error("Failed to get skills instructions:", error);
    }

    // Get MCP status data
    let mcpStatus: McpStatus[] = [];
    if (this.mcpConfigService) {
      try {
        mcpStatus =
          (await this.mcpConfigService.getMcpStatus(context.agentId)) || [];
        logger.info(`Got MCP status for ${mcpStatus.length} MCPs`);
      } catch (error) {
        logger.error("Failed to get MCP status:", error);
      }
    }

    return {
      agentInstructions,
      platformInstructions,
      networkInstructions,
      skillsInstructions,
      mcpStatus,
    };
  }
}
