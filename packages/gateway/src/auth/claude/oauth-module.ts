import { createLogger } from "@lobu/core";
import type { ModelOption } from "../../modules/module-system";
import { BaseProviderModule } from "../base-provider-module";
import { resolveEnv } from "../mcp/string-substitution";
import type { OAuthCredentials } from "../oauth/credentials";
import {
  type AuthProfilesManager,
  createAuthProfileLabel,
} from "../settings/auth-profiles-manager";
import type { ModelPreferenceStore } from "../settings/model-preference-store";

const logger = createLogger("claude-oauth-module");

// pi-ai detects Anthropic OAuth by `sk-ant-oat` in the value, so OAuth
// placeholders must keep that marker while the proxy swaps in the real token.
const OAUTH_TOKEN_MARKER = "sk-ant-oat";
const OAUTH_PROXY_PLACEHOLDER = "sk-ant-oat01-lobu-proxy";

function isAnthropicOAuthCredential(credential?: string | null): boolean {
  return credential?.includes(OAUTH_TOKEN_MARKER) ?? false;
}

/**
 * Claude OAuth Module - Handles credential injection and model preferences for Claude.
 * OAuth login/logout is handled by the generic settings web page routes.
 */
export class ClaudeOAuthModule extends BaseProviderModule {
  private modelPreferenceStore: ModelPreferenceStore;

  constructor(
    authProfilesManager: AuthProfilesManager,
    modelPreferenceStore: ModelPreferenceStore
  ) {
    super(
      {
        providerId: "claude",
        providerDisplayName: "Claude",
        providerIconUrl:
          "https://www.google.com/s2/favicons?domain=anthropic.com&sz=128",
        // pi-ai's native Anthropic path reads ANTHROPIC_API_KEY; the Claude
        // Code env var is only for the acpx CLI backend.
        credentialEnvVarName: "ANTHROPIC_API_KEY",
        secretEnvVarNames: [
          "ANTHROPIC_API_KEY",
          "ANTHROPIC_AUTH_TOKEN",
          "ANTHROPIC_OAUTH_TOKEN",
          "CLAUDE_CODE_OAUTH_TOKEN",
        ],
        slug: "anthropic",
        upstreamBaseUrl: "https://api.anthropic.com",
        baseUrlEnvVarName: "ANTHROPIC_BASE_URL",
        authType: "oauth",
        supportedAuthTypes: ["oauth", "api-key"],
        apiKeyInstructions:
          'Enter your <a href="https://console.anthropic.com/settings/keys" target="_blank" class="text-blue-600 underline">Anthropic API key</a>:',
        apiKeyPlaceholder: "sk-ant-...",
        catalogDescription: "Anthropic's Claude AI with OAuth authentication",
      },
      authProfilesManager
    );
    // Preserve existing module name
    this.name = "claude-oauth";
    this.modelPreferenceStore = modelPreferenceStore;
  }

  // ---- Overrides for multi-env-var logic ----

  private resolveSystemCredential(): string | undefined {
    return (
      resolveEnv("ANTHROPIC_OAUTH_TOKEN") ||
      resolveEnv("CLAUDE_CODE_OAUTH_TOKEN") ||
      resolveEnv("ANTHROPIC_AUTH_TOKEN") ||
      resolveEnv("ANTHROPIC_API_KEY")
    );
  }

  override hasSystemKey(): boolean {
    return !!this.resolveSystemCredential();
  }

  override injectSystemKeyFallback(
    envVars: Record<string, string>
  ): Record<string, string> {
    if (envVars.ANTHROPIC_API_KEY) return envVars;
    // Prefer explicit OAuth tokens and still expose them through pi-ai's key slot.
    const systemKey = this.resolveSystemCredential();
    if (systemKey) {
      envVars.ANTHROPIC_API_KEY = systemKey;
    }
    return envVars;
  }

  override async buildEnvVars(
    agentId: string,
    envVars: Record<string, string>,
    context?: import("../../embedded").ProviderCredentialContext
  ): Promise<Record<string, string>> {
    const profile = await this.authProfilesManager.getBestProfile(
      agentId,
      this.providerId,
      undefined,
      context
    );

    if (profile?.credential) {
      logger.info(`Injecting ${profile.authType} profile for space ${agentId}`);
      // pi-ai distinguishes OAuth vs API keys by token value, not env var name.
      envVars.ANTHROPIC_API_KEY = profile.credential;
    }

    // AGENT_DEFAULT_MODEL is now delivered dynamically via session context.
    // No longer baked into static container env vars.

    return envVars;
  }

  override async buildCredentialPlaceholder(
    agentId: string,
    context?: import("../../embedded").ProviderCredentialContext
  ): Promise<string> {
    const profile = await this.authProfilesManager.getBestProfile(
      agentId,
      this.providerId,
      undefined,
      context
    );
    // lobu.toml providers are seeded as api-key profiles, so mirror pi-ai's
    // value-based OAuth detection when choosing the proxy placeholder.
    const credential = profile?.credential || this.resolveSystemCredential();
    if (isAnthropicOAuthCredential(credential)) return OAUTH_PROXY_PLACEHOLDER;
    return "lobu-proxy";
  }

  getCliBackendConfig() {
    return {
      name: "claude-code",
      command: "npx",
      args: ["-y", "acpx@latest", "claude", "--print"],
      modelArg: "--model",
      sessionArg: "--session",
    };
  }

  async getModelOptions(
    agentId: string,
    userId: string
  ): Promise<ModelOption[]> {
    const availableModels = await this.fetchClaudeModels(agentId);
    if (availableModels.length === 0) return [];

    const preferredModel =
      await this.modelPreferenceStore.getModelPreference(userId);
    logger.debug("Building Claude model options", {
      agentId,
      userId,
      preferredModel,
    });
    const defaultModel =
      preferredModel ||
      process.env.AGENT_DEFAULT_MODEL ||
      "claude-sonnet-4-20250514";
    const options: ModelOption[] = [];
    const seen = new Set<string>();

    const addOption = (value: string, label: string) => {
      if (seen.has(value)) return;
      seen.add(value);
      options.push({ value, label });
    };

    const defaultEntry = availableModels.find((m) => m.id === defaultModel);
    if (defaultEntry) {
      addOption(defaultModel, defaultEntry.display_name || defaultModel);
    }

    for (const model of availableModels) {
      addOption(model.id, model.display_name || model.id);
    }

    return options;
  }

  async setCredentials(
    agentId: string,
    userId: string,
    credentials: unknown
  ): Promise<void> {
    await this.saveOAuthCredentials(
      agentId,
      userId,
      credentials as OAuthCredentials
    );
  }

  async deleteCredentials(agentId: string, userId: string): Promise<void> {
    await this.authProfilesManager.deleteProviderProfiles(
      agentId,
      this.providerId,
      { userId }
    );
  }

  private async saveOAuthCredentials(
    agentId: string,
    userId: string,
    credentials: OAuthCredentials
  ): Promise<void> {
    await this.authProfilesManager.upsertProfile({
      agentId,
      userId,
      provider: this.providerId,
      credential: credentials.accessToken,
      authType: "oauth",
      label: createAuthProfileLabel(
        this.providerDisplayName,
        credentials.accessToken
      ),
      metadata: {
        refreshToken: credentials.refreshToken,
        expiresAt: credentials.expiresAt,
      },
      makePrimary: true,
    });
  }

  private static readonly FALLBACK_MODELS: Array<{
    id: string;
    display_name: string;
    type: string;
  }> = [
    {
      id: "claude-sonnet-4-20250514",
      display_name: "Claude Sonnet 4",
      type: "model",
    },
    {
      id: "claude-opus-4-20250514",
      display_name: "Claude Opus 4",
      type: "model",
    },
    {
      id: "claude-haiku-3-5-20241022",
      display_name: "Claude Haiku 3.5",
      type: "model",
    },
  ];

  private async fetchClaudeModels(
    agentId: string
  ): Promise<Array<{ id: string; display_name: string; type: string }>> {
    const profile = await this.authProfilesManager.getBestProfile(
      agentId,
      this.providerId
    );

    const profileCredential = profile?.credential;
    const systemCredential = this.resolveSystemCredential();
    const credential = profileCredential || systemCredential;
    const shouldUseOAuth = profileCredential
      ? profile.authType === "oauth" ||
        isAnthropicOAuthCredential(profileCredential)
      : isAnthropicOAuthCredential(systemCredential);
    const oauthToken = credential && shouldUseOAuth ? credential : undefined;
    const apiKey = credential && !shouldUseOAuth ? credential : undefined;

    const headers: Record<string, string> = {
      Accept: "application/json",
      "anthropic-version": "2023-06-01",
    };
    if (oauthToken) {
      headers.Authorization = `Bearer ${oauthToken}`;
    } else if (apiKey) {
      headers["x-api-key"] = apiKey;
    } else {
      return ClaudeOAuthModule.FALLBACK_MODELS;
    }

    const response = await fetch("https://api.anthropic.com/v1/models", {
      headers,
    }).catch((err) => {
      logger.warn(
        { error: err?.message, agentId },
        "fetchClaudeModels: fetch failed"
      );
      return null;
    });

    if (!response?.ok) {
      logger.warn(
        {
          agentId,
          status: response?.status,
          hasOauth: !!oauthToken,
          hasApiKey: !!apiKey,
        },
        "fetchClaudeModels: non-ok response, using fallback models"
      );
      return ClaudeOAuthModule.FALLBACK_MODELS;
    }

    const payload = (await response.json().catch(() => ({}))) as {
      data?: Array<{ id?: string; display_name?: string; type?: string }>;
    };

    const models = (payload.data || [])
      .map((item) => {
        const id = item.id?.trim();
        if (!id) return null;
        return {
          id,
          display_name: item.display_name || id,
          type: item.type || "model",
        };
      })
      .filter(
        (item): item is { id: string; display_name: string; type: string } =>
          Boolean(item)
      );

    return models.length > 0 ? models : ClaudeOAuthModule.FALLBACK_MODELS;
  }
}
