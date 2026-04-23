import { afterEach, describe, expect, test } from "bun:test";
import { ClaudeOAuthModule } from "../auth/claude/oauth-module";

const originalFetch = globalThis.fetch;
const envKeys = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "AGENT_DEFAULT_MODEL",
] as const;
const originalEnv = Object.fromEntries(
  envKeys.map((key) => [key, process.env[key]])
) as Record<(typeof envKeys)[number], string | undefined>;

function createModule(profile: unknown = null): ClaudeOAuthModule {
  return new ClaudeOAuthModule(
    {
      getBestProfile: async () => profile,
    } as any,
    {
      getModelPreference: async () => undefined,
    } as any
  );
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of envKeys) {
    const value = originalEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("ClaudeOAuthModule", () => {
  test("keeps the OAuth marker in proxy placeholders for system OAuth tokens", async () => {
    process.env.ANTHROPIC_OAUTH_TOKEN = "sk-ant-oat01-system";
    const module = createModule();

    await expect(
      module.buildCredentialPlaceholder("agent-1")
    ).resolves.toBe("sk-ant-oat01-lobu-proxy");
  });

  test("uses bearer auth for OAuth-shaped credentials declared as api-key profiles", async () => {
    const module = createModule({
      id: "declared",
      provider: "claude",
      credential: "sk-ant-oat01-declared",
      authType: "api-key",
      label: "claude (declared)",
      model: "*",
      createdAt: Date.now(),
    });
    let capturedUrl: string | URL | Request | undefined;
    let capturedHeaders: Record<string, string> | undefined;

    globalThis.fetch = async (input, init) => {
      capturedUrl = input;
      capturedHeaders = init?.headers as Record<string, string>;
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "claude-test-model",
              display_name: "Claude Test",
              type: "model",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const options = await module.getModelOptions("agent-1", "user-1");

    expect(capturedUrl).toBe("https://api.anthropic.com/v1/models");
    expect(capturedHeaders?.Authorization).toBe(
      "Bearer sk-ant-oat01-declared"
    );
    expect(capturedHeaders?.["x-api-key"]).toBeUndefined();
    expect(options).toEqual([
      {
        value: "claude-test-model",
        label: "Claude Test",
      },
    ]);
  });
});
