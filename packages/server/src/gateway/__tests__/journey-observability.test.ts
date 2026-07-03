import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { emitJourneyEvent } from "../services/journey-observability";

const OBS_ENV_KEYS = [
	"TOOLBOX_AGENT_OBSERVABILITY_URL",
	"TOOLBOX_INTERNAL_SECRET",
] as const;

const originalEnv = new Map<string, string | undefined>();
let originalFetch: typeof globalThis.fetch;

function restoreObsEnv() {
	for (const key of OBS_ENV_KEYS) {
		const value = originalEnv.get(key);
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
}

describe("journey observability emitter", () => {
	beforeEach(() => {
		for (const key of OBS_ENV_KEYS) {
			originalEnv.set(key, process.env[key]);
			delete process.env[key];
		}
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		restoreObsEnv();
		globalThis.fetch = originalFetch;
	});

	test("posts journey.trace.v1 payloads to Toolbox with the internal secret", async () => {
		process.env.TOOLBOX_AGENT_OBSERVABILITY_URL =
			"https://toolbox.example.test/agent-observability/ingest";
		process.env.TOOLBOX_INTERNAL_SECRET = "internal-secret";
		const fetchMock = mock(async () => new Response("{}", { status: 202 }));
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		await emitJourneyEvent({
			trace_id: "tr_test_lobu_emit",
			journey_id: "line_text_agent_turn",
			event: "lobu.session.created",
			service: "lobu",
			module: "gateway",
			status: "ok",
			agent: { id: "shifu-u-a4175b7e71f4" },
			session: { id: "sess-123" },
			conversation: { id: "conv-123" },
			toolbox: { user_id: "toolbox-user-secret" },
			error: { message: "Authorization: Bearer token" },
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		expect(url).toBe("https://toolbox.example.test/agent-observability/ingest");
		expect(init.method).toBe("POST");
		expect(init.headers).toEqual({
			"content-type": "application/json",
			"x-internal-secret": "internal-secret",
		});
		expect(init.signal).toBeInstanceOf(AbortSignal);

		const body = JSON.parse(String(init.body));
		expect(body).toMatchObject({
			schemaVersion: "journey.trace.v1",
			payload: {
				schema_version: "journey.trace.v1",
				trace_id: "tr_test_lobu_emit",
				journey_id: "line_text_agent_turn",
				event: "lobu.session.created",
				service: "lobu",
				module: "gateway",
				status: "ok",
				session: { id: "sess-123" },
				conversation: { id: "conv-123" },
			},
		});
		expect(typeof body.payload.timestamp).toBe("string");
		const serialized = JSON.stringify(body);
		expect(serialized).not.toContain("internal-secret");
		expect(serialized).not.toContain("shifu-u-a4175b7e71f4");
		expect(serialized).not.toContain("toolbox-user-secret");
		expect(serialized).not.toContain("Bearer token");
	});

	test("does not fetch when endpoint or secret is missing", async () => {
		const fetchMock = mock(async () => new Response("{}", { status: 202 }));
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		await emitJourneyEvent({
			trace_id: "tr_missing_config",
			journey_id: "line_text_agent_turn",
			event: "lobu.session.created",
			service: "lobu",
			module: "gateway",
			status: "ok",
		});

		process.env.TOOLBOX_AGENT_OBSERVABILITY_URL =
			"https://toolbox.example.test/agent-observability/ingest";
		await emitJourneyEvent({
			trace_id: "tr_missing_secret",
			journey_id: "line_text_agent_turn",
			event: "lobu.session.created",
			service: "lobu",
			module: "gateway",
			status: "ok",
		});

		expect(fetchMock).not.toHaveBeenCalled();
	});

	test("fails open on non-ok responses, thrown fetches, and hung fetches", async () => {
		process.env.TOOLBOX_AGENT_OBSERVABILITY_URL =
			"https://toolbox.example.test/agent-observability/ingest";
		process.env.TOOLBOX_INTERNAL_SECRET = "internal-secret";
		globalThis.fetch = mock(async () => new Response("nope", { status: 500 })) as
			unknown as typeof fetch;

		await expect(
			emitJourneyEvent({
				trace_id: "tr_500",
				journey_id: "line_text_agent_turn",
				event: "mcp.tools_list.completed",
				service: "lobu",
				module: "mcp-proxy",
				status: "failed",
			})
		).resolves.toBeUndefined();

		globalThis.fetch = mock(async () => {
			throw new Error("network down");
		}) as unknown as typeof fetch;

		await expect(
			emitJourneyEvent({
				trace_id: "tr_throw",
				journey_id: "line_text_agent_turn",
				event: "mcp.tools_list.completed",
				service: "lobu",
				module: "mcp-proxy",
				status: "failed",
			})
		).resolves.toBeUndefined();

		let sawAbort = false;
		globalThis.fetch = mock((_url: string | URL | Request, init?: RequestInit) => {
			return new Promise<Response>((_resolve, reject) => {
				const signal = init?.signal;
				if (signal instanceof AbortSignal) {
					signal.addEventListener(
						"abort",
						() => {
							sawAbort = true;
							reject(signal.reason);
						},
						{ once: true }
					);
				}
			});
		}) as unknown as typeof fetch;

		await expect(
			Promise.race([
				emitJourneyEvent({
					trace_id: "tr_timeout",
					journey_id: "line_text_agent_turn",
					event: "provider.call.started",
					service: "lobu",
					module: "agent-worker",
					status: "started",
				}).then(() => "resolved"),
				Bun.sleep(1000).then(() => "timed-out"),
			])
		).resolves.toBe("resolved");
		expect(sawAbort).toBe(true);
	});
});
