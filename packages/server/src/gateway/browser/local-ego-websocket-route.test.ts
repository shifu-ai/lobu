import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createLocalEgoTunnelRegistry } from "./local-ego-tunnel";
import {
	acceptLocalEgoBridgeConnection,
	createLocalEgoWebSocketRoute,
	type LocalEgoBridgeWebSocket,
} from "./local-ego-websocket-route";

const now = () => new Date("2026-08-07T08:00:00.000Z");

class FakeSocket implements LocalEgoBridgeWebSocket {
	readonly sent: string[] = [];
	readonly closes: Array<{ code?: number; reason?: string }> = [];
	private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

	send(message: string): void {
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

function mountAsLobuApi(route: ReturnType<typeof createLocalEgoWebSocketRoute>) {
	const app = new Hono();
	app.route("/lobu/api/browser/local-ego", route);
	return app;
}

describe("local ego browser WebSocket route", () => {
	test("exchanges a Toolbox bridge token before accepting an upgrade", async () => {
		const exchanges: unknown[] = [];
		const route = mountAsLobuApi(createLocalEgoWebSocketRoute({
			exchangeToken: async (token) => {
				exchanges.push(token);
				return exchangedBridge;
			},
			registry: createLocalEgoTunnelRegistry({ now }),
			upgradeWebSocket: async ({ onOpen }) => {
				onOpen(new FakeSocket());
				return new Response(null, { status: 101 });
			},
		}));

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
		const route = mountAsLobuApi(createLocalEgoWebSocketRoute({
			exchangeToken: async () => exchangedBridge,
			registry: createLocalEgoTunnelRegistry({ now }),
			upgradeWebSocket: async () => new Response(null, { status: 101 }),
		}));

		const response = await route.fetch(
			new Request("https://lobu.test/lobu/api/browser/local-ego/tunnel?token=abc"),
		);

		expect(response.status).toBe(426);
	});

	test("requires a token query parameter", async () => {
		const route = mountAsLobuApi(createLocalEgoWebSocketRoute({
			exchangeToken: async () => exchangedBridge,
			registry: createLocalEgoTunnelRegistry({ now }),
			upgradeWebSocket: async () => new Response(null, { status: 101 }),
		}));

		const response = await route.fetch(
			new Request("https://lobu.test/lobu/api/browser/local-ego/tunnel", {
				headers: { upgrade: "websocket" },
			}),
		);

		expect(response.status).toBe(400);
	});

	test("does not expose a doubled absolute tunnel path when mounted", async () => {
		const route = mountAsLobuApi(createLocalEgoWebSocketRoute({
			exchangeToken: async () => exchangedBridge,
			registry: createLocalEgoTunnelRegistry({ now }),
			upgradeWebSocket: async () => new Response(null, { status: 101 }),
		}));

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
		const route = mountAsLobuApi(createLocalEgoWebSocketRoute({
			exchangeToken: async () => exchangedBridge,
			registry: createLocalEgoTunnelRegistry({ now }),
			upgradeWebSocket: async () => new Response(null, { status: 101 }),
		}));

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
