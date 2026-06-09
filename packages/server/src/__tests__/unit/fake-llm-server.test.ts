/**
 * Unit coverage for the fake-llm-server fixture's provider-integration
 * features: auth capture, optional auth enforcement, and OpenAI-format
 * tool-calling in both streaming and non-streaming modes.
 *
 * This pins the wire contract that two things depend on:
 *   - the openclaw-plugin e2e harness (which drives a real agent loop through
 *     this fake), and
 *   - live-providers/provider-smoke.test.ts (which asserts the SAME tool_call /
 *     message shapes against real providers).
 * If the fake's shape drifts from the OpenAI spec, the live smoke's assertions
 * would be testing a fiction — so we lock it here, in CI, with no network.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
	type FakeServerHandle,
	startFakeLlmServer,
} from "../fixtures/fake-llm-server.js";

let server: FakeServerHandle | undefined;

afterEach(async () => {
	await server?.close();
	server = undefined;
});

describe("fake-llm-server provider-integration features", () => {
	test("captures the Authorization header in request history", async () => {
		server = await startFakeLlmServer();
		server.enqueueReply("ok");

		await fetch(`${server.url}/v1/chat/completions`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: "Bearer injected-by-proxy",
			},
			body: JSON.stringify({ model: "fake-llm-1", messages: [] }),
		});

		const [req] = server.requests();
		expect(req?.authorization).toBe("Bearer injected-by-proxy");
	});

	test("requireAuth rejects requests with no Bearer token (401)", async () => {
		server = await startFakeLlmServer({ requireAuth: true });
		server.enqueueReply("should-not-reach");

		const res = await fetch(`${server.url}/v1/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "fake-llm-1", messages: [] }),
		});
		expect(res.status).toBe(401);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("invalid_api_key");

		// The reply queue must be untouched — auth is rejected before consuming it.
		server.enqueueReply("real-reply"); // queue now has [should-not-reach, real-reply]
		const ok = await fetch(`${server.url}/v1/chat/completions`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: "Bearer k",
			},
			body: JSON.stringify({ model: "fake-llm-1", messages: [] }),
		});
		const okBody = (await ok.json()) as {
			choices: Array<{ message: { content: string } }>;
		};
		expect(okBody.choices[0]?.message.content).toBe("should-not-reach");
	});

	test("emits OpenAI-format tool_calls (non-streaming)", async () => {
		server = await startFakeLlmServer();
		server.enqueueReply({
			content: "",
			tool_calls: [{ name: "get_weather", arguments: { city: "Paris" } }],
		});

		const res = await fetch(`${server.url}/v1/chat/completions`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: "Bearer k",
			},
			body: JSON.stringify({ model: "fake-llm-1", messages: [] }),
		});
		const body = (await res.json()) as {
			choices: Array<{
				message: {
					content: string | null;
					tool_calls?: Array<{
						id: string;
						type: string;
						function: { name: string; arguments: string };
					}>;
				};
				finish_reason: string;
			}>;
		};
		const choice = body.choices[0]!;
		expect(choice.finish_reason).toBe("tool_calls");
		expect(choice.message.tool_calls).toHaveLength(1);
		const call = choice.message.tool_calls![0]!;
		expect(call.type).toBe("function");
		expect(call.function.name).toBe("get_weather");
		// Arguments are serialized JSON, per the OpenAI spec.
		expect(JSON.parse(call.function.arguments)).toEqual({ city: "Paris" });
	});

	test("streams tool_calls as indexed deltas then a tool_calls finish", async () => {
		server = await startFakeLlmServer();
		server.enqueueReply({
			content: "",
			tool_calls: [{ id: "call_a", name: "lookup", arguments: '{"q":"x"}' }],
		});

		const res = await fetch(`${server.url}/v1/chat/completions`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: "Bearer k",
			},
			body: JSON.stringify({
				model: "fake-llm-1",
				messages: [],
				stream: true,
			}),
		});
		const raw = await res.text();
		const dataLines = raw
			.split("\n")
			.filter((l) => l.startsWith("data: "))
			.map((l) => l.slice("data: ".length).trim());
		expect(dataLines.at(-1)).toBe("[DONE]");

		const chunks = dataLines
			.filter((l) => l !== "[DONE]")
			.map(
				(l) =>
					JSON.parse(l) as {
						choices: Array<{
							delta: {
								tool_calls?: Array<{
									index: number;
									function: { name: string };
								}>;
							};
							finish_reason: string | null;
						}>;
					},
			);

		const toolDelta = chunks.find((c) => c.choices[0]?.delta.tool_calls);
		expect(toolDelta?.choices[0]?.delta.tool_calls?.[0]?.index).toBe(0);
		expect(toolDelta?.choices[0]?.delta.tool_calls?.[0]?.function.name).toBe(
			"lookup",
		);

		const finish = chunks.find((c) => c.choices[0]?.finish_reason);
		expect(finish?.choices[0]?.finish_reason).toBe("tool_calls");
	});

	test("plain text replies still default to a stop finish_reason", async () => {
		server = await startFakeLlmServer();
		server.enqueueReply("hello");
		const res = await fetch(`${server.url}/v1/chat/completions`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: "Bearer k",
			},
			body: JSON.stringify({ model: "fake-llm-1", messages: [] }),
		});
		const body = (await res.json()) as {
			choices: Array<{
				message: { content: string; tool_calls?: unknown };
				finish_reason: string;
			}>;
		};
		expect(body.choices[0]?.message.content).toBe("hello");
		expect(body.choices[0]?.message.tool_calls).toBeUndefined();
		expect(body.choices[0]?.finish_reason).toBe("stop");
	});
});
