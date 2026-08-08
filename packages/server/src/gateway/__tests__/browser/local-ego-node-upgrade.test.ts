import { describe, expect, test } from "bun:test";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import {
	createLocalEgoNodeUpgradeHandler,
	LOCAL_EGO_TUNNEL_UPGRADE_PATH,
	type UpgradableWebSocketServer,
} from "../../browser/local-ego-node-upgrade";
import { createLocalEgoTunnelRegistry } from "../../browser/local-ego-tunnel";
import type { LocalEgoBridgeWebSocket } from "../../browser/local-ego-websocket-route";

const now = () => new Date("2026-08-08T08:00:00.000Z");
const singleProcessRuntimeEnv = {
	LOCAL_EGO_BROWSER_TUNNEL_MODE: "single_process",
};

const exchangedBridge = {
	environment: "staging",
	ownerUserId: "user-1",
	agentId: "shifu-u-user-1",
	bridgeId: "ego-local-1",
	scopes: ["browser_read_dom"],
} as const;

class FakeDuplex {
	readonly written: string[] = [];
	destroyed = false;
	ended = false;

	write(chunk: string): boolean {
		this.written.push(chunk);
		return true;
	}

	end(chunk?: string): this {
		if (chunk !== undefined) this.written.push(chunk);
		this.ended = true;
		return this;
	}

	destroy(): this {
		this.destroyed = true;
		return this;
	}

	asDuplex(): Duplex {
		return this as unknown as Duplex;
	}
}

class FakeBridgeSocket implements LocalEgoBridgeWebSocket {
	readonly sent: string[] = [];
	readonly closes: Array<{ code?: number; reason?: string }> = [];
	private readonly listeners = new Map<
		string,
		Array<(event: unknown) => void>
	>();

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

function fakeRequest(url: string): IncomingMessage {
	return { url } as IncomingMessage;
}

function fakeWebSocketServer(input: {
	upgrades: Array<{ url: string | undefined }>;
	bridgeSocket: FakeBridgeSocket;
}): UpgradableWebSocketServer {
	return {
		handleUpgrade(request, _socket, _head, callback) {
			input.upgrades.push({ url: request.url });
			callback(input.bridgeSocket);
		},
	};
}

function flushMicrotasks(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("local ego node upgrade handler", () => {
	test("destroys sockets for non-tunnel paths by default without exchanging", async () => {
		const exchanges: string[] = [];
		const socket = new FakeDuplex();
		const handler = createLocalEgoNodeUpgradeHandler({
			runtimeEnv: singleProcessRuntimeEnv,
			exchangeToken: async (token) => {
				exchanges.push(token);
				return exchangedBridge;
			},
		});

		handler(
			fakeRequest("/lobu/api/some/other/socket?token=abc"),
			socket.asDuplex(),
			Buffer.alloc(0),
		);
		await flushMicrotasks();

		expect(socket.destroyed).toBe(true);
		expect(socket.written).toEqual([]);
		expect(exchanges).toEqual([]);
	});

	test("delegates non-tunnel paths to onUnhandledUpgrade so other listeners keep them", async () => {
		const unhandled: Duplex[] = [];
		const socket = new FakeDuplex();
		const handler = createLocalEgoNodeUpgradeHandler({
			runtimeEnv: singleProcessRuntimeEnv,
			onUnhandledUpgrade: (candidate) => {
				unhandled.push(candidate);
			},
		});

		handler(fakeRequest("/vite-hmr"), socket.asDuplex(), Buffer.alloc(0));
		await flushMicrotasks();

		expect(unhandled).toHaveLength(1);
		expect(socket.destroyed).toBe(false);
	});

	test("fails closed with a raw 503 before token exchange when single_process mode is off", async () => {
		const exchanges: string[] = [];
		const socket = new FakeDuplex();
		const handler = createLocalEgoNodeUpgradeHandler({
			runtimeEnv: {},
			exchangeToken: async (token) => {
				exchanges.push(token);
				return exchangedBridge;
			},
		});

		handler(
			fakeRequest(`${LOCAL_EGO_TUNNEL_UPGRADE_PATH}?token=abc`),
			socket.asDuplex(),
			Buffer.alloc(0),
		);
		await flushMicrotasks();

		const response = socket.written.join("");
		expect(response).toStartWith("HTTP/1.1 503 Service Unavailable\r\n");
		expect(response).toContain(
			'{"error":"local_ego_tunnel_registry_unavailable"}',
		);
		expect(socket.ended).toBe(true);
		expect(exchanges).toEqual([]);
	});

	test("rejects a missing token with a raw 400", async () => {
		const socket = new FakeDuplex();
		const handler = createLocalEgoNodeUpgradeHandler({
			runtimeEnv: singleProcessRuntimeEnv,
			exchangeToken: async () => exchangedBridge,
		});

		handler(
			fakeRequest(LOCAL_EGO_TUNNEL_UPGRADE_PATH),
			socket.asDuplex(),
			Buffer.alloc(0),
		);
		await flushMicrotasks();

		const response = socket.written.join("");
		expect(response).toStartWith("HTTP/1.1 400 Bad Request\r\n");
		expect(response).toContain('{"error":"browser_bridge_token_required"}');
	});

	test("rejects a failed exchange with a raw 502 and never upgrades", async () => {
		const upgrades: Array<{ url: string | undefined }> = [];
		const socket = new FakeDuplex();
		const handler = createLocalEgoNodeUpgradeHandler({
			runtimeEnv: singleProcessRuntimeEnv,
			exchangeToken: async () => {
				throw new Error("exchange_down");
			},
			webSocketServer: fakeWebSocketServer({
				upgrades,
				bridgeSocket: new FakeBridgeSocket(),
			}),
		});

		handler(
			fakeRequest(`${LOCAL_EGO_TUNNEL_UPGRADE_PATH}?token=abc`),
			socket.asDuplex(),
			Buffer.alloc(0),
		);
		await flushMicrotasks();

		const response = socket.written.join("");
		expect(response).toStartWith("HTTP/1.1 502 Bad Gateway\r\n");
		expect(response).toContain(
			'{"error":"browser_bridge_token_exchange_failed"}',
		);
		expect(upgrades).toEqual([]);
	});

	test("upgrades an authorized tunnel request and registers the bridge", async () => {
		const upgrades: Array<{ url: string | undefined }> = [];
		const bridgeSocket = new FakeBridgeSocket();
		const registry = createLocalEgoTunnelRegistry({ now });
		const socket = new FakeDuplex();
		const handler = createLocalEgoNodeUpgradeHandler({
			registry,
			runtimeEnv: singleProcessRuntimeEnv,
			exchangeToken: async (token) => {
				expect(token).toBe("bridge-token-1");
				return exchangedBridge;
			},
			webSocketServer: fakeWebSocketServer({ upgrades, bridgeSocket }),
		});

		handler(
			fakeRequest(`${LOCAL_EGO_TUNNEL_UPGRADE_PATH}?token=bridge-token-1`),
			socket.asDuplex(),
			Buffer.alloc(0),
		);
		await flushMicrotasks();

		expect(upgrades).toHaveLength(1);
		expect(socket.destroyed).toBe(false);
		expect(socket.written).toEqual([]);

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
				expiresAt: "2026-08-08T08:05:00.000Z",
			},
			timeoutMs: 500,
		});

		expect(bridgeSocket.sent).toHaveLength(1);
		const request = JSON.parse(bridgeSocket.sent[0] ?? "{}") as {
			id?: string;
		};
		bridgeSocket.dispatch("message", {
			data: JSON.stringify({
				jsonrpc: "2.0",
				id: request.id,
				result: {
					ok: true,
					url: "https://example.com",
					contentType: "dom",
					text: "Example Domain",
				},
			}),
		});

		await expect(resultPromise).resolves.toEqual({
			ok: true,
			url: "https://example.com",
			contentType: "dom",
			text: "Example Domain",
		});
	});

	test("destroys the socket when the request url is unparsable", async () => {
		const socket = new FakeDuplex();
		const handler = createLocalEgoNodeUpgradeHandler({
			runtimeEnv: singleProcessRuntimeEnv,
		});

		handler(fakeRequest("http://"), socket.asDuplex(), Buffer.alloc(0));
		await flushMicrotasks();

		expect(socket.destroyed).toBe(true);
	});
});
