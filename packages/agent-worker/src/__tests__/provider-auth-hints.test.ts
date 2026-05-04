import { describe, expect, test } from "bun:test";
import {
  getApiKeyEnvVarForProvider,
  getProviderAuthHintFromError,
} from "../shared/provider-auth-hints";

describe("getApiKeyEnvVarForProvider", () => {
  test("returns the explicit mapping for known providers", () => {
    expect(getApiKeyEnvVarForProvider("openai")).toBe("OPENAI_API_KEY");
    expect(getApiKeyEnvVarForProvider("openai-codex")).toBe("OPENAI_API_KEY");
    expect(getApiKeyEnvVarForProvider("google")).toBe("GOOGLE_API_KEY");
    expect(getApiKeyEnvVarForProvider("mistral")).toBe("MISTRAL_API_KEY");
    expect(getApiKeyEnvVarForProvider("anthropic")).toBe("ANTHROPIC_API_KEY");
    expect(getApiKeyEnvVarForProvider("z-ai")).toBe("Z_AI_API_KEY");
  });

  test("normalizes case and surrounding whitespace before mapping", () => {
    expect(getApiKeyEnvVarForProvider("  Anthropic  ")).toBe(
      "ANTHROPIC_API_KEY"
    );
    expect(getApiKeyEnvVarForProvider("OpenAI")).toBe("OPENAI_API_KEY");
  });

  test("derives an env var by sanitizing arbitrary provider names", () => {
    expect(getApiKeyEnvVarForProvider("Cohere")).toBe("COHERE_API_KEY");
    expect(getApiKeyEnvVarForProvider("My Custom Provider")).toBe(
      "MY_CUSTOM_PROVIDER_API_KEY"
    );
    expect(getApiKeyEnvVarForProvider("foo.bar/baz")).toBe(
      "FOO_BAR_BAZ_API_KEY"
    );
  });

  test("trims leading/trailing underscores produced by sanitization", () => {
    expect(getApiKeyEnvVarForProvider("__weird__")).toBe("WEIRD_API_KEY");
    expect(getApiKeyEnvVarForProvider("--dashy--")).toBe("DASHY_API_KEY");
  });

  test("returns generic API_KEY for empty or fully-stripped names", () => {
    expect(getApiKeyEnvVarForProvider("")).toBe("API_KEY");
    expect(getApiKeyEnvVarForProvider("   ")).toBe("API_KEY");
    expect(getApiKeyEnvVarForProvider("!!!")).toBe("API_KEY");
  });

  test("returns generic API_KEY when sanitized result is literally 'provider'", () => {
    expect(getApiKeyEnvVarForProvider("provider")).toBe("API_KEY");
    expect(getApiKeyEnvVarForProvider("Provider")).toBe("API_KEY");
    expect(getApiKeyEnvVarForProvider("  PROVIDER  ")).toBe("API_KEY");
  });
});

describe("getProviderAuthHintFromError", () => {
  test("returns null when the error does not look like an auth failure", () => {
    expect(getProviderAuthHintFromError("rate limit hit")).toBeNull();
    expect(getProviderAuthHintFromError("network timeout")).toBeNull();
  });

  test("matches each documented auth-failure substring", () => {
    expect(
      getProviderAuthHintFromError("No API key found for openai")
    ).not.toBeNull();
    expect(
      getProviderAuthHintFromError("Authentication failed for anthropic")
    ).not.toBeNull();
    expect(
      getProviderAuthHintFromError("invalid x-api-key supplied")
    ).not.toBeNull();
    expect(
      getProviderAuthHintFromError("invalid api-key on request")
    ).not.toBeNull();
    expect(
      getProviderAuthHintFromError("invalid api key, sorry")
    ).not.toBeNull();
    expect(
      getProviderAuthHintFromError("authentication_error: bad token")
    ).not.toBeNull();
    expect(
      getProviderAuthHintFromError("Incorrect API key provided")
    ).not.toBeNull();
  });

  test("prefers the supplied default provider over names extracted from the message", () => {
    const hint = getProviderAuthHintFromError(
      'Authentication failed for "zai"',
      "z-ai"
    );
    expect(hint).toEqual({
      providerName: "z-ai",
      envVar: "Z_AI_API_KEY",
    });
  });

  test("ignores a default provider that is the literal string 'undefined'", () => {
    const hint = getProviderAuthHintFromError(
      'No API key found for "openai"',
      "undefined"
    );
    expect(hint?.providerName).toBe("openai");
    expect(hint?.envVar).toBe("OPENAI_API_KEY");
  });

  test("falls back to extracting the provider from 'No API key found for X'", () => {
    const hint = getProviderAuthHintFromError('No API key found for "openai"');
    expect(hint).toEqual({
      providerName: "openai",
      envVar: "OPENAI_API_KEY",
    });
  });

  test("extracts the provider from 'Authentication failed for X'", () => {
    const hint = getProviderAuthHintFromError(
      'Authentication failed for "anthropic"'
    );
    expect(hint).toEqual({
      providerName: "anthropic",
      envVar: "ANTHROPIC_API_KEY",
    });
  });

  test("falls back to a JSON 'provider' field when no explicit phrase matches", () => {
    const hint = getProviderAuthHintFromError(
      'invalid api key {"provider":"mistral","code":401}'
    );
    expect(hint).toEqual({
      providerName: "mistral",
      envVar: "MISTRAL_API_KEY",
    });
  });

  test("returns generic 'provider' / 'API_KEY' when nothing identifies the provider", () => {
    const hint = getProviderAuthHintFromError("authentication_error");
    expect(hint).toEqual({
      providerName: "provider",
      envVar: "API_KEY",
    });
  });

  test("treats whitespace-only default provider as missing", () => {
    const hint = getProviderAuthHintFromError(
      'No API key found for "google"',
      "   "
    );
    expect(hint?.providerName).toBe("google");
    expect(hint?.envVar).toBe("GOOGLE_API_KEY");
  });

  test("lowercases provider names extracted from the message", () => {
    const hint = getProviderAuthHintFromError('No API key found for "OpenAI"');
    expect(hint?.providerName).toBe("openai");
  });
});
