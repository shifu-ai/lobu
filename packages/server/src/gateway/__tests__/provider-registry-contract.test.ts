/**
 * Contract test for the bundled provider registry (config/providers.json).
 *
 * Every config-driven provider (OpenAI, Groq, Gemini, Mistral, DeepSeek, …)
 * flows through the SAME generic ApiKeyProviderModule → secret-proxy path, so
 * a single bad edit to providers.json silently breaks a provider in prod with
 * nothing to catch it. This test is the guard: it loads the REAL bundled
 * config and, for every provider, asserts both
 *   (a) the config invariants the loader/UI rely on, and
 *   (b) that an ApiKeyProviderModule built from that config wires the
 *       secret-proxy base-URL mappings and credential env vars correctly.
 *
 * It runs with no API keys and no network — pure config + module wiring — so it
 * belongs in CI as a fast fail-fast gate, not in the live smoke suite.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ApiKeyProviderModule } from "../auth/api-key-provider-module.js";
import { resolveProviderRegistryFromRaw } from "../services/provider-registry-service.js";

const thisDir = dirname(fileURLToPath(import.meta.url));
// packages/server/src/gateway/__tests__ -> repo root is five levels up.
const repoRoot = resolve(thisDir, "../../../../..");
const providersPath = resolve(repoRoot, "config/providers.json");

const raw = readFileSync(providersPath, "utf-8");
const resolved = resolveProviderRegistryFromRaw(raw);

if (!resolved) {
	throw new Error(
		`config/providers.json failed to parse via resolveProviderRegistryFromRaw (${providersPath})`,
	);
}

/** Flatten the nested registry the same way ProviderRegistryService does. */
const flattened = resolved.resolved.providers.flatMap((entry) =>
	(entry.providers || []).map((provider) => ({ id: entry.id, provider })),
);

// A stub that satisfies the module's auth-profile dependency without a DB;
// none of the wiring assertions below touch credentials.
const stubAuthProfiles = {
	hasProviderProfiles: async () => false,
} as never;

function buildModule(
	id: string,
	provider: (typeof flattened)[number]["provider"],
) {
	return new ApiKeyProviderModule({
		providerId: id,
		providerDisplayName: provider.displayName,
		providerIconUrl: provider.iconUrl,
		envVarName: provider.envVarName,
		apiKeyInstructions: provider.apiKeyInstructions,
		apiKeyPlaceholder: provider.apiKeyPlaceholder,
		slug: id,
		upstreamBaseUrl: provider.upstreamBaseUrl,
		modelsEndpoint: provider.modelsEndpoint,
		sdkCompat: provider.sdkCompat,
		defaultModel: provider.defaultModel,
		registryAlias: provider.registryAlias,
		catalogVisible: provider.catalogVisible,
		authProfilesManager: stubAuthProfiles,
	});
}

describe("provider registry contract (config/providers.json)", () => {
	test("registry parses and has providers", () => {
		expect(flattened.length).toBeGreaterThan(0);
	});

	test("provider ids are unique", () => {
		const ids = flattened.map((f) => f.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	for (const { id, provider } of flattened) {
		describe(`provider: ${id}`, () => {
			test("has the required display/config fields", () => {
				expect(provider.displayName?.trim()).toBeTruthy();
				expect(provider.iconUrl?.trim()).toBeTruthy();
				expect(provider.apiKeyInstructions?.trim()).toBeTruthy();
				expect(provider.apiKeyPlaceholder?.trim()).toBeTruthy();
			});

			test("envVarName follows the *_API_KEY convention", () => {
				// The secret-proxy derives the base-URL env var by replacing
				// `_KEY` with `_BASE_URL`; a name that doesn't end in `_KEY`
				// would produce a broken base-URL env var.
				expect(provider.envVarName).toMatch(/_KEY$/);
				expect(provider.envVarName).toBe(provider.envVarName.toUpperCase());
			});

			test("upstreamBaseUrl is an https URL with no trailing slash", () => {
				expect(provider.upstreamBaseUrl).toMatch(/^https:\/\//);
				expect(provider.upstreamBaseUrl).not.toMatch(/\/$/);
				expect(() => new URL(provider.upstreamBaseUrl)).not.toThrow();
			});

			test("sdkCompat, when set, is 'openai'", () => {
				if (provider.sdkCompat !== undefined) {
					expect(provider.sdkCompat).toBe("openai");
				}
			});

			test("modelsEndpoint, when set, is a root-relative path", () => {
				if (provider.modelsEndpoint !== undefined) {
					expect(provider.modelsEndpoint).toMatch(/^\//);
				}
			});

			test("module exposes the API key as a secret env var", () => {
				const mod = buildModule(id, provider);
				expect(mod.getSecretEnvVarNames()).toContain(provider.envVarName);
				expect(mod.getCredentialEnvVarName()).toBe(provider.envVarName);
			});

			test("proxy base-URL mappings route through the agent-scoped proxy", () => {
				const mod = buildModule(id, provider);
				const proxyUrl = "http://proxy.internal:8118";
				const agentId = "agent-xyz";
				const mappings = mod.getProxyBaseUrlMappings(proxyUrl, agentId);

				// Provider-specific base-URL env var (e.g. GROQ_BASE_URL) is mapped.
				const baseUrlEnvVar = provider.envVarName.replace("_KEY", "_BASE_URL");
				expect(mappings[baseUrlEnvVar]).toBeDefined();
				expect(mappings[baseUrlEnvVar]).toContain(`${proxyUrl}/${id}`);

				// OpenAI-compatible providers also remap OPENAI_BASE_URL so the
				// OpenAI SDK the worker uses resolves through our proxy.
				if (provider.sdkCompat === "openai") {
					expect(mappings.OPENAI_BASE_URL).toBeDefined();
					expect(mappings.OPENAI_BASE_URL).toContain(`${proxyUrl}/${id}`);
				}
			});

			test("provider metadata exposes the worker base-URL env var", () => {
				const mod = buildModule(id, provider);
				const meta = mod.getProviderMetadata();
				// Config-driven providers (sdkCompat/defaultModel/registryAlias set)
				// must hand the worker a base-URL env var to register dynamically.
				if (
					provider.sdkCompat ||
					provider.defaultModel ||
					provider.registryAlias
				) {
					expect(meta).not.toBeNull();
					expect(meta!.baseUrlEnvVar).toBe(
						provider.envVarName.replace("_KEY", "_BASE_URL"),
					);
					if (provider.sdkCompat) {
						expect(meta!.sdkCompat).toBe("openai");
					}
				}
			});
		});
	}
});

/**
 * Composed-URL contract — the deterministic guard for the two URL-composition
 * bugs found while auditing provider integrations.
 *
 * Production composes provider URLs with NO version-segment magic (proven by
 * driving the real OpenAI SDK + the proxy `forward()` with a mocked upstream):
 *   - chat   = `${upstreamBaseUrl}/chat/completions`
 *               (the worker's OpenAI SDK appends `/chat/completions` verbatim to
 *                its baseURL; the proxy forwards `upstreamBaseUrl + thatPath`)
 *   - models = `${upstreamBaseUrl}${modelsEndpoint}`
 *               (ApiKeyProviderModule.fetchModelsGeneric, direct fetch)
 *
 * So `upstreamBaseUrl` and `modelsEndpoint` must be mutually consistent per
 * provider. They previously weren't:
 *   A) 9 providers whose upstream already ended in `/v1` ALSO had
 *      `modelsEndpoint: "/v1/models"`, composing the dead `/v1/v1/models`.
 *   B) groq + openai upstreams lacked the version segment, so the proxied chat
 *      path resolved to `…/chat/completions` with no `/v1` → 404.
 * This block pins the canonical endpoints so neither can silently come back.
 */
describe("composed upstream URLs (proxy + SDK contract)", () => {
	const chatUrl = (p: (typeof flattened)[number]["provider"]) =>
		`${p.upstreamBaseUrl.replace(/\/$/, "")}/chat/completions`;
	const modelsUrl = (p: (typeof flattened)[number]["provider"]) =>
		p.modelsEndpoint
			? `${p.upstreamBaseUrl.replace(/\/$/, "")}${p.modelsEndpoint}`
			: undefined;

	// No provider's composed URLs may contain a doubled version segment
	// (`/v1/v1/`, `/v2/v2/`, …) — that's always a 404 and is exactly bug (A).
	const DOUBLED_VERSION = /\/v\d+\/v\d+\//;
	for (const { id, provider } of flattened) {
		test(`${id}: composed URLs have no doubled version segment`, () => {
			expect(chatUrl(provider)).not.toMatch(DOUBLED_VERSION);
			const m = modelsUrl(provider);
			if (m) expect(m).not.toMatch(DOUBLED_VERSION);
		});
	}

	// Canonical chat endpoints (every chat-capable provider). elevenlabs is a
	// voice/STT provider with no chat surface, so it's intentionally absent.
	const EXPECTED_CHAT: Record<string, string> = {
		groq: "https://api.groq.com/openai/v1/chat/completions",
		gemini:
			"https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
		"together-ai": "https://api.together.xyz/v1/chat/completions",
		nvidia: "https://integrate.api.nvidia.com/v1/chat/completions",
		"z-ai": "https://api.z.ai/api/coding/paas/v4/chat/completions",
		fireworks: "https://api.fireworks.ai/inference/v1/chat/completions",
		mistral: "https://api.mistral.ai/v1/chat/completions",
		deepseek: "https://api.deepseek.com/chat/completions",
		openrouter: "https://openrouter.ai/api/v1/chat/completions",
		cerebras: "https://api.cerebras.ai/v1/chat/completions",
		"opencode-zen": "https://opencode.ai/zen/v1/chat/completions",
		xai: "https://api.x.ai/v1/chat/completions",
		perplexity: "https://api.perplexity.ai/chat/completions",
		cohere: "https://api.cohere.com/compatibility/v1/chat/completions",
		openai: "https://api.openai.com/v1/chat/completions",
	};

	// Canonical model-list endpoints. gemini is omitted: its model list is
	// fetched via the native `…/v1beta/models?key=` path (fetchGeminiModels),
	// so its `modelsEndpoint` is not exercised through fetchModelsGeneric.
	const EXPECTED_MODELS: Record<string, string> = {
		groq: "https://api.groq.com/openai/v1/models",
		"together-ai": "https://api.together.xyz/v1/models",
		nvidia: "https://integrate.api.nvidia.com/v1/models",
		fireworks: "https://api.fireworks.ai/inference/v1/models",
		mistral: "https://api.mistral.ai/v1/models",
		deepseek: "https://api.deepseek.com/v1/models",
		openrouter: "https://openrouter.ai/api/v1/models",
		cerebras: "https://api.cerebras.ai/v1/models",
		"opencode-zen": "https://opencode.ai/zen/v1/models",
		xai: "https://api.x.ai/v1/models",
		perplexity: "https://api.perplexity.ai/v1/models",
		cohere: "https://api.cohere.com/compatibility/v1/models",
		openai: "https://api.openai.com/v1/models",
	};

	for (const { id, provider } of flattened) {
		if (EXPECTED_CHAT[id]) {
			test(`${id}: chat endpoint resolves to the documented URL`, () => {
				expect(chatUrl(provider)).toBe(EXPECTED_CHAT[id]);
			});
		}
		if (EXPECTED_MODELS[id]) {
			test(`${id}: model-list endpoint resolves to the documented URL`, () => {
				expect(modelsUrl(provider)).toBe(EXPECTED_MODELS[id]);
			});
		}
	}

	test("every chat-capable provider is covered by EXPECTED_CHAT", () => {
		// Guard against a new provider slipping in without an endpoint assertion.
		const VOICE_ONLY = new Set(["elevenlabs"]);
		const uncovered = flattened
			.map((f) => f.id)
			.filter((id) => !EXPECTED_CHAT[id] && !VOICE_ONLY.has(id));
		expect(uncovered).toEqual([]);
	});
});
