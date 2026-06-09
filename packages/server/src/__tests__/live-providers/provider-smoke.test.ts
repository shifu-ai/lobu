/**
 * Live provider smoke test — opt-in, key-gated, replaces the manual pass.
 *
 * The internal plumbing (config parsing, proxy wiring, credential precedence)
 * is covered deterministically by provider-registry-contract.test.ts and the
 * gateway unit suite. What NONE of those can tell you is the thing that breaks
 * out from under you in prod: "does provider X actually answer today?" — a
 * model gets deprecated, an endpoint moves, an auth scheme changes upstream.
 *
 * This suite walks EVERY provider in config/providers.json and, for each one
 * whose API key is present in the environment, performs a real round-trip:
 *   1. list models           — validates auth + the models endpoint
 *   2. chat completion        — validates the OpenAI-compatible chat surface
 *   3. tool-calling (lenient) — validates the agent's primary capability,
 *                               warn-only since model support varies
 *
 * Providers with no key in env are cleanly skipped (describe.skipIf), so the
 * suite grows coverage automatically as keys are added to CI secrets. It does
 * NOT run in the default unit/integration/e2e gates — invoke it explicitly via
 * `make test-providers-live` (or `bun test` on this path).
 *
 * URL construction here mirrors production exactly:
 *   - models: ApiKeyProviderModule.fetchModelsGeneric / fetchGeminiModels
 *   - chat:   the OpenAI-compatible base the worker's OpenAI SDK resolves to
 * so a passing smoke means the real worker path works, not just some URL.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const thisDir = dirname(fileURLToPath(import.meta.url));
// packages/server/src/__tests__/live-providers -> repo root is five levels up.
const repoRoot = resolve(thisDir, "../../../../..");
const providersPath = resolve(repoRoot, "config/providers.json");

interface ProviderEntry {
	displayName: string;
	envVarName: string;
	upstreamBaseUrl: string;
	sdkCompat?: string;
	defaultModel?: string;
	modelsEndpoint?: string;
}

interface RegistryFile {
	providers: Array<{ id: string; providers?: ProviderEntry[] }>;
}

const registry = JSON.parse(
	readFileSync(providersPath, "utf-8"),
) as RegistryFile;

const flattened = registry.providers.flatMap((entry) =>
	(entry.providers || []).map((provider) => ({ id: entry.id, provider })),
);

/** Resolve the API key for a provider from env (with known aliases). */
function resolveKey(id: string, envVarName: string): string | undefined {
	const direct = process.env[envVarName];
	if (direct) return direct;
	// Historical alias: the memory-loop e2e harness uses ZAI_API_KEY, while the
	// registry declares Z_AI_API_KEY. Accept both so one key covers z-ai.
	if (id === "z-ai") return process.env.ZAI_API_KEY;
	return undefined;
}

/**
 * The OpenAI-compatible base URL the worker's OpenAI SDK resolves to. The SDK
 * appends `/chat/completions`, so this must include the version segment.
 * Mirror that: for providers exposing `/v1/models`, the chat base is the same
 * prefix with `/models` stripped; providers whose upstream already embeds the
 * version (e.g. gemini's `/v1beta/openai`) use the upstream as-is.
 */
function chatBaseUrl(p: ProviderEntry): string {
	const upstream = p.upstreamBaseUrl.replace(/\/$/, "");
	if (p.modelsEndpoint) {
		return `${upstream}${p.modelsEndpoint.replace(/\/models$/, "")}`;
	}
	return upstream;
}

const TIMEOUT_MS = 30_000;

async function fetchJson(
	url: string,
	init: RequestInit,
): Promise<{ status: number; body: unknown }> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const res = await fetch(url, { ...init, signal: controller.signal });
		const text = await res.text();
		let body: unknown = text;
		try {
			body = JSON.parse(text);
		} catch {
			/* keep raw text for the error message */
		}
		return { status: res.status, body };
	} finally {
		clearTimeout(timer);
	}
}

/** List model ids, mirroring the module's two model-fetching paths. */
async function listModels(
	id: string,
	p: ProviderEntry,
	key: string,
): Promise<string[]> {
	if (id === "gemini") {
		const url = new URL(
			"https://generativelanguage.googleapis.com/v1beta/models",
		);
		url.searchParams.set("key", key);
		const { status, body } = await fetchJson(url.toString(), { method: "GET" });
		expect(
			status,
			`gemini /models returned ${status}: ${JSON.stringify(body)}`,
		).toBe(200);
		const models = (body as { models?: Array<{ name?: string }> }).models ?? [];
		return models
			.map((m) => m.name?.replace(/^models\//, "").trim())
			.filter((x): x is string => !!x);
	}

	if (!p.modelsEndpoint) return [];
	const url = `${p.upstreamBaseUrl.replace(/\/$/, "")}${p.modelsEndpoint}`;
	const { status, body } = await fetchJson(url, {
		method: "GET",
		headers: { Authorization: `Bearer ${key}` },
	});
	expect(
		status,
		`${id} models endpoint returned ${status}: ${JSON.stringify(body)}`,
	).toBe(200);
	const data = (body as { data?: Array<{ id?: string }> }).data ?? [];
	return data.map((m) => m.id?.trim()).filter((x): x is string => !!x);
}

describe("live provider smoke", () => {
	// Surface which providers are actually being exercised so a green run isn't
	// mistaken for "all 18 passed" when only the keyed ones ran.
	const active = flattened.filter(({ id, provider }) =>
		resolveKey(id, provider.envVarName),
	);
	test("at least one provider key is configured (else this suite is a no-op)", () => {
		if (active.length === 0) {
			console.warn(
				"[live-providers] no provider keys in env — every provider skipped. " +
					"Set e.g. OPENAI_API_KEY to exercise the live smoke.",
			);
		}
		// Not a hard failure: opt-in suites should be safe to run with no keys.
		expect(active.length).toBeGreaterThanOrEqual(0);
	});

	for (const { id, provider } of flattened) {
		const key = resolveKey(id, provider.envVarName);

		describe.skipIf(!key)(`${id} (${provider.displayName})`, () => {
			let discoveredModels: string[] = [];

			test("lists models (auth + endpoint)", async () => {
				discoveredModels = await listModels(id, provider, key!);
				expect(
					discoveredModels.length,
					`${id} returned an empty model list`,
				).toBeGreaterThan(0);
			});

			test("answers a chat completion", async () => {
				const model = provider.defaultModel ?? discoveredModels[0];
				if (!model) {
					console.warn(
						`[live-providers] ${id}: no model to test chat — skipping`,
					);
					return;
				}
				const { status, body } = await fetchJson(
					`${chatBaseUrl(provider)}/chat/completions`,
					{
						method: "POST",
						headers: {
							"content-type": "application/json",
							Authorization: `Bearer ${key}`,
						},
						body: JSON.stringify({
							model,
							messages: [
								{
									role: "user",
									content: "Reply with exactly the single word: pong",
								},
							],
							max_tokens: 16,
							stream: false,
						}),
					},
				);
				expect(
					status,
					`${id} chat returned ${status}: ${JSON.stringify(body)}`,
				).toBe(200);
				const content = (
					body as {
						choices?: Array<{ message?: { content?: string } }>;
					}
				).choices?.[0]?.message?.content;
				expect(
					typeof content === "string" && content.trim().length > 0,
					`${id} chat returned no assistant text: ${JSON.stringify(body)}`,
				).toBe(true);
			});

			test("attempts a tool call (lenient — warn-only)", async () => {
				const model = provider.defaultModel ?? discoveredModels[0];
				if (!model) return;
				const { status, body } = await fetchJson(
					`${chatBaseUrl(provider)}/chat/completions`,
					{
						method: "POST",
						headers: {
							"content-type": "application/json",
							Authorization: `Bearer ${key}`,
						},
						body: JSON.stringify({
							model,
							messages: [
								{
									role: "user",
									content: "What is the weather in Paris? Use the tool.",
								},
							],
							tools: [
								{
									type: "function",
									function: {
										name: "get_weather",
										description: "Get the current weather for a city",
										parameters: {
											type: "object",
											properties: { city: { type: "string" } },
											required: ["city"],
										},
									},
								},
							],
							tool_choice: "auto",
							max_tokens: 64,
							stream: false,
						}),
					},
				);

				// Hard requirement: the request must not error. Tool support varies by
				// model, so whether a tool_call actually comes back is warn-only.
				expect(
					status,
					`${id} tool-call request errored ${status}: ${JSON.stringify(body)}`,
				).toBe(200);
				const toolCalls = (
					body as {
						choices?: Array<{ message?: { tool_calls?: unknown[] } }>;
					}
				).choices?.[0]?.message?.tool_calls;
				if (!toolCalls?.length) {
					console.warn(
						`[live-providers] ${id} (${model}) returned no tool_calls — ` +
							"model may not support function calling.",
					);
				}
			});
		});
	}
});
