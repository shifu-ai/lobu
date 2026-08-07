import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { generateWorkerToken } from "@lobu/core";
import { Hono } from "hono";
import { __resetEncryptionKeyCacheForTests } from "../../../../core/src/utils/encryption";
import { createLocalEgoTunnelRegistry } from "./local-ego-tunnel";
import {
	acceptLocalEgoBridgeConnection,
	createLocalEgoWebSocketRoute,
	type LocalEgoBridgeWebSocket,
	resolveLocalEgoTunnelRuntimeConfig,
} from "./local-ego-websocket-route";
import {
	exchangeToolboxBrowserBridgeToken,
	type ToolboxBrowserBridgeExchangeError,
} from "./toolbox-browser-session-client";

const now = () => new Date("2026-08-07T08:00:00.000Z");
const singleProcessRuntimeEnv = {
	LOCAL_EGO_BROWSER_TUNNEL_MODE: "single_process",
	LOCAL_EGO_BROWSER_TUNNEL_INSTANCE_ID: "test-instance-1",
};
const TEST_ENCRYPTION_KEY =
	"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const originalFetch = globalThis.fetch;
const ENV_KEYS = [
	"ENCRYPTION_KEY",
	"TOOLBOX_INTERNAL_SECRET",
	"TOOLBOX_BROWSER_SESSION_API_BASE_URL",
] as const;
let savedEnv: Record<(typeof ENV_KEYS)[number], string | undefined>;

beforeEach(() => {
	savedEnv = {} as Record<(typeof ENV_KEYS)[number], string | undefined>;
	for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
	process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
	process.env.TOOLBOX_INTERNAL_SECRET = "internal-secret";
	process.env.TOOLBOX_BROWSER_SESSION_API_BASE_URL = "https://toolbox.test";
	__resetEncryptionKeyCacheForTests();
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	mock.restore();
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
	__resetEncryptionKeyCacheForTests();
});

class FakeSocket implements LocalEgoBridgeWebSocket {
	readonly sent: string[] = [];
	readonly closes: Array<{ code?: number; reason?: string }> = [];
	private readonly listeners = new Map<
		string,
		Array<(event: unknown) => void>
	>();

	constructor(private readonly options: { throwOnSend?: boolean } = {}) {}

	send(message: string): void {
		if (this.options.throwOnSend) throw new Error("send_failed");
		this.sent.push(message);
	}

	close(code?: number, reason?: string): void {
		this.closes.push({ code, reason });
	}

	addEventListener(type: string, listener: (event: unknown) => void): void {
		const listeners = this.listeners.get(type) ?? [];
		listeners.push(listener);
		this.listeners.set(type, listeners);
	}

	dispatch(type: string, event: unknown = {}): void {
		for (const listener of this.listeners.get(type) ?? []) listener(event);
	}
}

const exchangedBridge = {
	environment: "staging",
	ownerUserId: "user-1",
	agentId: "shifu-u-user-1",
	bridgeId: "ego-local-1",
	scopes: ["browser_read_dom"],
} as const;

function mountAsLobuApi(
	route: ReturnType<typeof createLocalEgoWebSocketRoute>,
) {
	const app = new Hono();
	app.route("/lobu/api/browser/local-ego", route);
	return app;
}

function createEnabledRoute(
	options: Parameters<typeof createLocalEgoWebSocketRoute>[0] = {},
) {
	return createLocalEgoWebSocketRoute({
		runtimeEnv: singleProcessRuntimeEnv,
		...options,
	});
}

function activeReleaseToken(
	capabilityIds: string[] = ["personal_browser.local_ego.v1"],
) {
	return generateWorkerToken("user-1", "conv-1", "worker-a", {
		channelId: "channel-1",
		agentId: "shifu-u-user-1",
		organizationId: "org-1",
		tokenKind: "run",
		runId: 101,
		releaseState: {
			status: "active",
			claim: {
				environment: "staging",
				toolboxUserId: "user-1",
				agentId: "shifu-u-user-1",
				releaseId: "release-browser-1",
				releaseSequence: 1,
				snapshotDigest: `sha256:${"b".repeat(64)}`,
				expiresAt: new Date(Date.now() + 60_000).toISOString(),
				capabilityIds,
			},
		},
	});
}

function registerReadDomBridge(input: {
	registry: ReturnType<typeof createLocalEgoTunnelRegistry>;
	events: string[];
	text?: string;
	errorCode?: string;
}) {
	input.registry.register({
		environment: exchangedBridge.environment,
		ownerUserId: exchangedBridge.ownerUserId,
		agentId: exchangedBridge.agentId,
		bridgeId: exchangedBridge.bridgeId,
		send: async (request) => {
			input.events.push("bridge");
			if (input.errorCode) {
				return {
					jsonrpc: "2.0",
					id: request.id,
					error: {
						code: input.errorCode,
						message: input.errorCode,
					},
				};
			}
			return {
				jsonrpc: "2.0",
				id: request.id,
				result: {
					ok: true,
					url: "https://course.example/dashboard",
					title: "Course dashboard",
					contentType: "dom",
					text: input.text ?? "Course dashboard",
				},
			};
		},
	});
}

function mockToolboxBrowserSessionFetch(input: {
	events: string[];
	auditStatus?: number;
	auditBodies?: unknown[];
}) {
	globalThis.fetch = mock(async (url, init) => {
		const parsed = new URL(String(url));
		const body = JSON.parse(String(init?.body ?? "{}"));
		expect(new Headers(init?.headers).get("x-internal-secret")).toBe(
			"internal-secret",
		);
		if (parsed.pathname.endsWith("/internal/current")) {
			input.events.push("current-session");
			expect(body).toMatchObject({
				ownerUserId: "user-1",
				agentId: "shifu-u-user-1",
				runId: 101,
			});
			return Response.json({
				ok: true,
				session: {
					environment: exchangedBridge.environment,
					ownerUserId: exchangedBridge.ownerUserId,
					agentId: exchangedBridge.agentId,
					sessionId: "browser_session_1",
					bridgeId: exchangedBridge.bridgeId,
				},
			});
		}
		if (parsed.pathname.endsWith("/internal/leases")) {
			input.events.push("lease");
			expect(body).toMatchObject({
				ownerUserId: "user-1",
				agentId: "shifu-u-user-1",
				runId: 101,
				toolName: "browser_read_dom",
				sessionId: "browser_session_1",
				bridgeId: exchangedBridge.bridgeId,
			});
			return Response.json({
				ok: true,
				lease: {
					sessionId: "browser_session_1",
					leaseToken: "lease-token",
					runId: "101",
					expiresAt: "2026-08-07T08:05:00.000Z",
				},
			});
		}
		if (parsed.pathname.endsWith("/internal/tool-calls")) {
			input.events.push("audit");
			input.auditBodies?.push(body);
			return Response.json(
				input.auditStatus && input.auditStatus >= 400
					? { error: "audit down" }
					: { ok: true },
				{ status: input.auditStatus ?? 200 },
			);
		}
		throw new Error(`unexpected toolbox URL: ${parsed.pathname}`);
	}) as unknown as typeof fetch;
}

async function postReadDomTool(input: {
	app: Hono;
	token?: string;
	body?: unknown;
}) {
	return postBrowserTool({ ...input, toolName: "browser_read_dom" });
}

async function postBrowserTool(input: {
	app: Hono;
	toolName: "browser_read_dom" | "browser_screenshot" | "browser_navigate";
	token?: string;
	body?: unknown;
}) {
	return input.app.request(
		`/lobu/api/browser/local-ego/tools/${input.toolName}`,
		{
			method: "POST",
			headers: {
				...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
				"content-type": "application/json",
			},
			body: JSON.stringify(input.body ?? { arguments: {} }),
		},
	);
}

describe("local ego browser WebSocket route", () => {
	test("fails closed before token exchange when single_process mode is not enabled", async () => {
		const exchanges: unknown[] = [];
		let upgrades = 0;
		const registry = createLocalEgoTunnelRegistry({ now });
		const route = mountAsLobuApi(
			createLocalEgoWebSocketRoute({
				exchangeToken: async (token) => {
					exchanges.push(token);
					return exchangedBridge;
				},
				registry,
				runtimeEnv: {},
				upgradeWebSocket: async () => {
					upgrades += 1;
					return new Response(null, { status: 101 });
				},
			}),
		);

		const response = await route.fetch(
			new Request(
				"https://lobu.test/lobu/api/browser/local-ego/tunnel?token=abc",
				{
					headers: { upgrade: "websocket" },
				},
			),
		);

		expect(response.status).toBe(503);
		await expect(response.json()).resolves.toEqual({
			error: "local_ego_tunnel_registry_unavailable",
		});
		expect(exchanges).toEqual([]);
		expect(upgrades).toBe(0);
		await expect(
			registry.callTool({
				environment: exchangedBridge.environment,
				ownerUserId: exchangedBridge.ownerUserId,
				agentId: exchangedBridge.agentId,
				bridgeId: exchangedBridge.bridgeId,
				toolName: "browser_read_dom",
				args: {},
				lease: {
					sessionId: "browser_session_1",
					leaseToken: "lease-token",
					runId: "run-1",
					expiresAt: "2026-08-07T08:05:00.000Z",
				},
				timeoutMs: 1,
			}),
		).rejects.toThrow("bridge_disconnected");
	});

	test("exchanges a Toolbox bridge token before accepting an upgrade", async () => {
		const exchanges: unknown[] = [];
		const route = mountAsLobuApi(
			createEnabledRoute({
				exchangeToken: async (token) => {
					exchanges.push(token);
					return exchangedBridge;
				},
				registry: createLocalEgoTunnelRegistry({ now }),
				upgradeWebSocket: async ({ onOpen }) => {
					onOpen(new FakeSocket());
					return new Response(null, { status: 101 });
				},
			}),
		);

		const response = await route.fetch(
			new Request(
				"https://lobu.test/lobu/api/browser/local-ego/tunnel?token=abc",
				{
					headers: { upgrade: "websocket" },
				},
			),
		);

		expect(exchanges).toEqual(["abc"]);
		expect(response.status).toBe(101);
	});

	test("rejects non-WebSocket requests", async () => {
		const route = mountAsLobuApi(
			createEnabledRoute({
				exchangeToken: async () => exchangedBridge,
				registry: createLocalEgoTunnelRegistry({ now }),
				upgradeWebSocket: async () => new Response(null, { status: 101 }),
			}),
		);

		const response = await route.fetch(
			new Request(
				"https://lobu.test/lobu/api/browser/local-ego/tunnel?token=abc",
			),
		);

		expect(response.status).toBe(426);
	});

	test("requires a token query parameter", async () => {
		const route = mountAsLobuApi(
			createEnabledRoute({
				exchangeToken: async () => exchangedBridge,
				registry: createLocalEgoTunnelRegistry({ now }),
				upgradeWebSocket: async () => new Response(null, { status: 101 }),
			}),
		);

		const response = await route.fetch(
			new Request("https://lobu.test/lobu/api/browser/local-ego/tunnel", {
				headers: { upgrade: "websocket" },
			}),
		);

		expect(response.status).toBe(400);
	});

	test("does not expose a doubled absolute tunnel path when mounted", async () => {
		const route = mountAsLobuApi(
			createEnabledRoute({
				exchangeToken: async () => exchangedBridge,
				registry: createLocalEgoTunnelRegistry({ now }),
				upgradeWebSocket: async () => new Response(null, { status: 101 }),
			}),
		);

		const response = await route.fetch(
			new Request(
				"https://lobu.test/lobu/api/browser/local-ego/lobu/api/browser/local-ego/tunnel?token=abc",
				{
					headers: { upgrade: "websocket" },
				},
			),
		);

		expect(response.status).toBe(404);
	});

	test("does not expose the tunnel under mcp", async () => {
		const route = mountAsLobuApi(
			createEnabledRoute({
				exchangeToken: async () => exchangedBridge,
				registry: createLocalEgoTunnelRegistry({ now }),
				upgradeWebSocket: async () => new Response(null, { status: 101 }),
			}),
		);

		const response = await route.fetch(
			new Request("https://lobu.test/mcp/browser/local-ego/tunnel?token=abc", {
				headers: { upgrade: "websocket" },
			}),
		);

		expect(response.status).toBe(404);
	});

	test("registers a bridge from the exchanged token and relays matching JSON-RPC responses", async () => {
		const registry = createLocalEgoTunnelRegistry({ now });
		const socket = new FakeSocket();
		await acceptLocalEgoBridgeConnection({
			socket,
			registry,
			bridge: exchangedBridge,
		});

		const resultPromise = registry.callTool({
			environment: exchangedBridge.environment,
			ownerUserId: exchangedBridge.ownerUserId,
			agentId: exchangedBridge.agentId,
			bridgeId: exchangedBridge.bridgeId,
			toolName: "browser_read_dom",
			args: { selector: "#main" },
			lease: {
				sessionId: "browser_session_1",
				leaseToken: "lease-token",
				runId: "run-1",
				expiresAt: "2026-08-07T08:05:00.000Z",
			},
			timeoutMs: 500,
		});

		expect(socket.sent).toHaveLength(1);
		const request = JSON.parse(socket.sent[0] ?? "{}") as { id?: string };
		socket.dispatch("message", {
			data: JSON.stringify({
				jsonrpc: "2.0",
				id: request.id,
				result: {
					ok: true,
					url: "https://example.com/course",
					contentType: "dom",
					text: "Course dashboard",
				},
			}),
		});

		await expect(resultPromise).resolves.toEqual({
			ok: true,
			url: "https://example.com/course",
			contentType: "dom",
			text: "Course dashboard",
		});
	});

	test("disconnects the registered bridge when the socket closes", async () => {
		const registry = createLocalEgoTunnelRegistry({ now });
		const socket = new FakeSocket();
		await acceptLocalEgoBridgeConnection({
			socket,
			registry,
			bridge: exchangedBridge,
		});

		socket.dispatch("close");

		await expect(
			registry.callTool({
				environment: exchangedBridge.environment,
				ownerUserId: exchangedBridge.ownerUserId,
				agentId: exchangedBridge.agentId,
				bridgeId: exchangedBridge.bridgeId,
				toolName: "browser_read_dom",
				args: {},
				lease: {
					sessionId: "browser_session_1",
					leaseToken: "lease-token",
					runId: "run-1",
					expiresAt: "2026-08-07T08:05:00.000Z",
				},
				timeoutMs: 1,
			}),
		).rejects.toThrow("bridge_disconnected");
	});

	test("rejects messages that are not responses to pending tool calls", async () => {
		const registry = createLocalEgoTunnelRegistry({ now });
		const socket = new FakeSocket();
		await acceptLocalEgoBridgeConnection({
			socket,
			registry,
			bridge: exchangedBridge,
		});

		socket.dispatch("message", {
			data: JSON.stringify({
				jsonrpc: "2.0",
				id: "unknown",
				result: {
					ok: true,
					url: null,
					contentType: "dom",
				},
			}),
		});

		expect(socket.closes).toEqual([
			{ code: 1008, reason: "unexpected_browser_message" },
		]);
	});

	test("drops timed-out pending ids so late browser responses close the socket", async () => {
		const registry = createLocalEgoTunnelRegistry({ now });
		const socket = new FakeSocket();
		await acceptLocalEgoBridgeConnection({
			socket,
			registry,
			bridge: exchangedBridge,
		});

		const resultPromise = registry.callTool({
			environment: exchangedBridge.environment,
			ownerUserId: exchangedBridge.ownerUserId,
			agentId: exchangedBridge.agentId,
			bridgeId: exchangedBridge.bridgeId,
			toolName: "browser_read_dom",
			args: {},
			lease: {
				sessionId: "browser_session_1",
				leaseToken: "lease-token",
				runId: "run-1",
				expiresAt: "2026-08-07T08:05:00.000Z",
			},
			timeoutMs: 1,
		});

		expect(socket.sent).toHaveLength(1);
		const request = JSON.parse(socket.sent[0] ?? "{}") as { id?: string };
		await expect(resultPromise).rejects.toThrow("timeout");

		socket.dispatch("message", {
			data: JSON.stringify({
				jsonrpc: "2.0",
				id: request.id,
				result: {
					ok: true,
					url: null,
					contentType: "dom",
				},
			}),
		});

		expect(socket.closes).toEqual([
			{ code: 1008, reason: "unexpected_browser_message" },
		]);
	});

	test("cleans pending state when socket send throws", async () => {
		const registry = createLocalEgoTunnelRegistry({ now });
		const socket = new FakeSocket({ throwOnSend: true });
		await acceptLocalEgoBridgeConnection({
			socket,
			registry,
			bridge: exchangedBridge,
		});

		await expect(
			registry.callTool({
				environment: exchangedBridge.environment,
				ownerUserId: exchangedBridge.ownerUserId,
				agentId: exchangedBridge.agentId,
				bridgeId: exchangedBridge.bridgeId,
				toolName: "browser_read_dom",
				args: {},
				lease: {
					sessionId: "browser_session_1",
					leaseToken: "lease-token",
					runId: "run-1",
					expiresAt: "2026-08-07T08:05:00.000Z",
				},
				timeoutMs: 500,
			}),
		).rejects.toThrow("bridge_disconnected");
		expect(socket.sent).toEqual([]);
	});

	test("never accepts owner, agent, or scopes from browser messages", async () => {
		const registry = createLocalEgoTunnelRegistry({ now });
		const socket = new FakeSocket();
		await acceptLocalEgoBridgeConnection({
			socket,
			registry,
			bridge: exchangedBridge,
		});

		const resultPromise = registry.callTool({
			environment: exchangedBridge.environment,
			ownerUserId: exchangedBridge.ownerUserId,
			agentId: exchangedBridge.agentId,
			bridgeId: exchangedBridge.bridgeId,
			toolName: "browser_read_dom",
			args: {},
			lease: {
				sessionId: "browser_session_1",
				leaseToken: "lease-token",
				runId: "run-1",
				expiresAt: "2026-08-07T08:05:00.000Z",
			},
			timeoutMs: 500,
		});

		const request = JSON.parse(socket.sent[0] ?? "{}") as { id?: string };
		socket.dispatch("message", {
			data: JSON.stringify({
				jsonrpc: "2.0",
				id: request.id,
				ownerUserId: "attacker",
				agentId: "shifu-u-attacker",
				scopes: ["browser_screenshot"],
				result: {
					ok: true,
					url: null,
					contentType: "dom",
				},
			}),
		});

		await expect(resultPromise).resolves.toEqual({
			ok: true,
			url: null,
			contentType: "dom",
		});
		await expect(
			registry.callTool({
				environment: exchangedBridge.environment,
				ownerUserId: "attacker",
				agentId: "shifu-u-attacker",
				bridgeId: exchangedBridge.bridgeId,
				toolName: "browser_screenshot",
				args: {},
				lease: {
					sessionId: "browser_session_1",
					leaseToken: "lease-token",
					runId: "run-1",
					expiresAt: "2026-08-07T08:05:00.000Z",
				},
				timeoutMs: 1,
			}),
		).rejects.toThrow("bridge_disconnected");
	});
});

describe("local ego browser tool route", () => {
	test("rejects missing or invalid worker token before Toolbox or bridge calls", async () => {
		const events: string[] = [];
		const registry = createLocalEgoTunnelRegistry({ now });
		registerReadDomBridge({ registry, events });
		const app = mountAsLobuApi(createEnabledRoute({ registry }));
		globalThis.fetch = mock(async () => {
			throw new Error("fetch should not be called");
		}) as unknown as typeof fetch;

		const missing = await postReadDomTool({ app });
		expect(missing.status).toBe(401);
		await expect(missing.json()).resolves.toEqual({
			error: "invalid_worker_token",
		});

		const invalid = await postReadDomTool({ app, token: "not-a-token" });
		expect(invalid.status).toBe(401);
		await expect(invalid.json()).resolves.toEqual({
			error: "invalid_worker_token",
		});
		expect(events).toEqual([]);
	});

	test("denies missing release capability before current session, lease, or bridge", async () => {
		const events: string[] = [];
		const registry = createLocalEgoTunnelRegistry({ now });
		registerReadDomBridge({ registry, events });
		const app = mountAsLobuApi(createEnabledRoute({ registry }));
		globalThis.fetch = mock(async (url) => {
			events.push(`audit:${new URL(String(url)).pathname}`);
			return Response.json({ ok: true });
		}) as unknown as typeof fetch;

		const response = await postReadDomTool({
			app,
			token: activeReleaseToken(["other.capability.v1"]),
		});

		expect(response.status).toBe(403);
		await expect(response.json()).resolves.toEqual({
			error: "missing_release_capability",
		});
		expect(events).toEqual([
			"audit:/agent-workbench/browser-sessions/internal/tool-calls",
		]);
	});

	test("calls current session, lease, bridge, and audit before returning success", async () => {
		const events: string[] = [];
		const registry = createLocalEgoTunnelRegistry({ now });
		registerReadDomBridge({ registry, events });
		mockToolboxBrowserSessionFetch({ events });
		const app = mountAsLobuApi(createEnabledRoute({ registry }));

		const response = await postReadDomTool({
			app,
			token: activeReleaseToken(),
		});

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			ok: true,
			result: {
				ok: true,
				text: "Course dashboard",
			},
		});
		expect(events).toEqual(["current-session", "lease", "bridge", "audit"]);
	});

	test("fails closed when audit write fails after bridge success", async () => {
		const events: string[] = [];
		const registry = createLocalEgoTunnelRegistry({ now });
		registerReadDomBridge({
			registry,
			events,
			text: "Course dashboard secret page content",
		});
		mockToolboxBrowserSessionFetch({ events, auditStatus: 503 });
		const app = mountAsLobuApi(createEnabledRoute({ registry }));

		const response = await postReadDomTool({
			app,
			token: activeReleaseToken(),
		});
		const body = await response.json();

		expect(response.status).toBe(502);
		expect(body).toEqual({ error: "browser_audit_failed" });
		expect(JSON.stringify(body)).not.toContain("Course dashboard secret");
		expect(events).toEqual(["current-session", "lease", "bridge", "audit"]);
	});

	test("sanitizes browser-controlled bridge error codes before response and audit", async () => {
		const events: string[] = [];
		const auditBodies: unknown[] = [];
		const registry = createLocalEgoTunnelRegistry({ now });
		registerReadDomBridge({
			registry,
			events,
			errorCode: "SECRET PAGE TEXT",
		});
		mockToolboxBrowserSessionFetch({ events, auditBodies });
		const app = mountAsLobuApi(createEnabledRoute({ registry }));

		const response = await postReadDomTool({
			app,
			token: activeReleaseToken(),
		});
		const body = await response.json();

		expect(response.status).toBe(503);
		expect(body).toEqual({ error: "tool_failed" });
		expect(JSON.stringify(body)).not.toContain("SECRET PAGE TEXT");
		expect(auditBodies).toHaveLength(1);
		expect(auditBodies[0]).toMatchObject({
			result: "failed",
			errorCode: "tool_failed",
		});
		expect(JSON.stringify(auditBodies[0])).not.toContain("SECRET PAGE TEXT");
		expect(events).toEqual(["current-session", "lease", "bridge", "audit"]);
	});

	test.each([
		{
			toolName: "browser_read_dom" as const,
			body: { arguments: { maxTextBytes: 200_001 } },
		},
		{
			toolName: "browser_read_dom" as const,
			body: { arguments: { maxTextBytes: 1000, extra: true } },
		},
		{
			toolName: "browser_screenshot" as const,
			body: { arguments: { maxImageBase64Bytes: 2_000_001 } },
		},
		{
			toolName: "browser_screenshot" as const,
			body: { arguments: { maxImageBase64Bytes: 1000, extra: true } },
		},
		{
			toolName: "browser_navigate" as const,
			body: { arguments: {} },
		},
		{
			toolName: "browser_navigate" as const,
			body: { arguments: { url: "https://course.example", extra: true } },
		},
	])("rejects invalid %s arguments before Toolbox lease or bridge", async ({
		toolName,
		body,
	}) => {
		const events: string[] = [];
		const registry = createLocalEgoTunnelRegistry({ now });
		registerReadDomBridge({ registry, events });
		const app = mountAsLobuApi(createEnabledRoute({ registry }));
		globalThis.fetch = mock(async () => {
			throw new Error("fetch should not be called");
		}) as unknown as typeof fetch;

		const response = await postBrowserTool({
			app,
			toolName,
			token: activeReleaseToken(),
			body,
		});

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toEqual({
			error: "invalid_browser_tool_arguments",
		});
		expect(events).toEqual([]);
	});
});

describe("local ego tunnel runtime config", () => {
	test("requires explicit single_process mode", () => {
		expect(resolveLocalEgoTunnelRuntimeConfig({})).toEqual({
			available: false,
			mode: undefined,
			instanceId: undefined,
		});
		expect(
			resolveLocalEgoTunnelRuntimeConfig({
				LOCAL_EGO_BROWSER_TUNNEL_MODE: "multi_replica",
			}),
		).toMatchObject({ available: false, mode: "multi_replica" });
		expect(resolveLocalEgoTunnelRuntimeConfig(singleProcessRuntimeEnv)).toEqual(
			{
				available: true,
				mode: "single_process",
				instanceId: "test-instance-1",
			},
		);
	});
});

describe("toolbox browser session client", () => {
	test("sends the internal secret header and token body", async () => {
		let captured: { url: string; init?: RequestInit } | undefined;
		const bridge = await exchangeToolboxBrowserBridgeToken("token-1", {
			exchangeUrl:
				"https://toolbox.test/agent-workbench/browser-sessions/internal/bridge-token/exchange",
			internalSecret: "internal-secret",
			fetchImpl: async (url, init) => {
				captured = { url: String(url), init };
				return Response.json({ ok: true, bridge: exchangedBridge });
			},
		});

		expect(bridge).toEqual(exchangedBridge);
		expect(captured?.url).toBe(
			"https://toolbox.test/agent-workbench/browser-sessions/internal/bridge-token/exchange",
		);
		expect(
			(captured?.init?.headers as Record<string, string>)["x-internal-secret"],
		).toBe("internal-secret");
		expect(JSON.parse(String(captured?.init?.body))).toEqual({
			token: "token-1",
		});
	});

	test("maps non-ok exchange responses to a typed error", async () => {
		await expect(
			exchangeToolboxBrowserBridgeToken("token-1", {
				exchangeUrl: "https://toolbox.test/exchange",
				internalSecret: "internal-secret",
				fetchImpl: async () =>
					Response.json({ error: "denied" }, { status: 401 }),
			}),
		).rejects.toMatchObject({
			code: "toolbox_browser_bridge_exchange_failed",
			upstreamStatus: 401,
		} satisfies Partial<ToolboxBrowserBridgeExchangeError>);
	});

	test("fails closed for invalid json and invalid exchange contract", async () => {
		await expect(
			exchangeToolboxBrowserBridgeToken("token-1", {
				exchangeUrl: "https://toolbox.test/exchange",
				internalSecret: "internal-secret",
				fetchImpl: async () => new Response("{not-json", { status: 200 }),
			}),
		).rejects.toThrow("toolbox_browser_bridge_exchange_invalid_json");

		await expect(
			exchangeToolboxBrowserBridgeToken("token-1", {
				exchangeUrl: "https://toolbox.test/exchange",
				internalSecret: "internal-secret",
				fetchImpl: async () =>
					Response.json({
						ok: true,
						bridge: { ...exchangedBridge, ownerUserId: "" },
					}),
			}),
		).rejects.toThrow("toolbox_browser_bridge_exchange_invalid_contract");
	});

	test("rejects invalid environments and unknown scopes", async () => {
		await expect(
			exchangeToolboxBrowserBridgeToken("token-1", {
				exchangeUrl: "https://toolbox.test/exchange",
				internalSecret: "internal-secret",
				fetchImpl: async () =>
					Response.json({
						ok: true,
						bridge: { ...exchangedBridge, environment: "dev" },
					}),
			}),
		).rejects.toThrow("toolbox_browser_bridge_exchange_invalid_environment");

		await expect(
			exchangeToolboxBrowserBridgeToken("token-1", {
				exchangeUrl: "https://toolbox.test/exchange",
				internalSecret: "internal-secret",
				fetchImpl: async () =>
					Response.json({
						ok: true,
						bridge: { ...exchangedBridge, scopes: ["browser_click"] },
					}),
			}),
		).rejects.toThrow("toolbox_browser_bridge_exchange_unknown_scope");
	});
});
