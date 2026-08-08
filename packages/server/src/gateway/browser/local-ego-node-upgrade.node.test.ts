import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { createLocalEgoNodeUpgradeHandler } from "./local-ego-node-upgrade";
import { createLocalEgoWebSocketRoute } from "./local-ego-websocket-route";
import { createLocalEgoTunnelRegistry } from "./local-ego-tunnel";

/**
 * The unit tests in `__tests__/browser/` inject a fake WebSocketServer, so they
 * prove the admission logic but not the assumption underneath it: that a real
 * `ws` socket satisfies LocalEgoBridgeWebSocket (addEventListener with string
 * `.data`, send, close) and that a genuine handshake reaches the http server's
 * 'upgrade' event at all. That assumption is the entire reason this module
 * exists — the Bun-only route returned 501 in production for exactly this
 * reason — so it deserves a real socket rather than a comment.
 *
 * This file deliberately lives outside `__tests__/` so it runs under **vitest
 * on Node**, not `bun test`: Bun substitutes its own WebSocket for the `ws`
 * module, which never completes this handshake and does not implement
 * 'unexpected-response'. Production runs Node (`tsx src/server.ts`), so Node is
 * the runtime this behavior has to be proven on.
 */

const now = () => new Date("2026-08-08T08:00:00.000Z");
const TUNNEL_PATH = "/lobu/api/browser/local-ego/tunnel";

const exchangedBridge = {
	environment: "staging",
	ownerUserId: "user-1",
	agentId: "shifu-u-user-1",
	bridgeId: "ego-local-1",
	scopes: ["browser_read_dom"],
} as const;

const lease = {
	sessionId: "browser_session_1",
	leaseToken: "lease-token",
	runId: "run-1",
	expiresAt: "2026-08-08T08:05:00.000Z",
};

const servers: Server[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
	for (const socket of sockets.splice(0)) socket.close();
	for (const server of servers.splice(0)) {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

function startServer(input: {
	registry?: ReturnType<typeof createLocalEgoTunnelRegistry>;
	runtimeEnv?: Record<string, string | undefined>;
	exchangeToken?: (token: string) => Promise<typeof exchangedBridge>;
}): Promise<{ url: string }> {
	const server = createServer((_req, res) => {
		res.writeHead(404).end();
	});
	server.on(
		"upgrade",
		createLocalEgoNodeUpgradeHandler({
			registry: input.registry,
			runtimeEnv: input.runtimeEnv ?? {
				LOCAL_EGO_BROWSER_TUNNEL_MODE: "single_process",
			},
			exchangeToken: input.exchangeToken ?? (async () => exchangedBridge),
		}),
	);
	servers.push(server);
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo;
			resolve({ url: `ws://127.0.0.1:${port}` });
		});
	});
}

function connect(url: string): WebSocket {
	const socket = new WebSocket(url);
	sockets.push(socket);
	return socket;
}

describe("local ego node upgrade over a real ws handshake", () => {
	test("round-trips a tool call through a real WebSocket connection", async () => {
		const registry = createLocalEgoTunnelRegistry({ now });
		const { url } = await startServer({ registry });

		const client = connect(`${url}${TUNNEL_PATH}?token=bridge-token-1`);
		await new Promise<void>((resolve, reject) => {
			client.on("open", () => resolve());
			client.on("error", reject);
		});

		// The bridge client answers whatever Lobu asks, echoing the request id.
		client.on("message", (raw) => {
			const request = JSON.parse(String(raw)) as { id: string };
			client.send(
				JSON.stringify({
					jsonrpc: "2.0",
					id: request.id,
					result: {
						ok: true,
						url: "https://example.com",
						contentType: "dom",
						text: "Example Domain",
					},
				}),
			);
		});

		const result = await registry.callTool({
			environment: exchangedBridge.environment,
			ownerUserId: exchangedBridge.ownerUserId,
			agentId: exchangedBridge.agentId,
			bridgeId: exchangedBridge.bridgeId,
			toolName: "browser_read_dom",
			args: {},
			lease,
			timeoutMs: 5_000,
		});

		expect(result).toEqual({
			ok: true,
			url: "https://example.com",
			contentType: "dom",
			text: "Example Domain",
		});
	});

	test("a closed bridge socket deregisters, so later calls fail honestly", async () => {
		const registry = createLocalEgoTunnelRegistry({ now });
		const { url } = await startServer({ registry });

		const client = connect(`${url}${TUNNEL_PATH}?token=bridge-token-1`);
		await new Promise<void>((resolve, reject) => {
			client.on("open", () => resolve());
			client.on("error", reject);
		});
		await new Promise<void>((resolve) => {
			client.on("close", () => resolve());
			client.close();
		});

		await expect(
			registry.callTool({
				environment: exchangedBridge.environment,
				ownerUserId: exchangedBridge.ownerUserId,
				agentId: exchangedBridge.agentId,
				bridgeId: exchangedBridge.bridgeId,
				toolName: "browser_read_dom",
				args: {},
				lease,
				timeoutMs: 5_000,
			}),
		).rejects.toThrow("bridge_disconnected");
	});

	test("refuses the handshake with a raw 503 when the registry is disabled", async () => {
		const { url } = await startServer({ runtimeEnv: {} });

		const client = connect(`${url}${TUNNEL_PATH}?token=bridge-token-1`);
		const status = await new Promise<number>((resolve, reject) => {
			client.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
			client.on("open", () => reject(new Error("handshake should have failed")));
			client.on("error", reject);
		});

		expect(status).toBe(503);
	});

	test("the Hono route on Node says the upgrade was never negotiated", async () => {
		// A request carrying an Upgrade header that still lands in the request
		// listener was normalized to plain HTTP upstream (an edge proxy dropping
		// the Connection header does this — it is how production produced the old
		// 501). The body is what tells this apart from the plain
		// `websocket_upgrade_required` 426 and from an edge's own 426.
		const route = createLocalEgoWebSocketRoute({
			registry: createLocalEgoTunnelRegistry({ now }),
			runtimeEnv: { LOCAL_EGO_BROWSER_TUNNEL_MODE: "single_process" },
			exchangeToken: async () => exchangedBridge,
		});

		const response = await route.fetch(
			new Request("https://lobu.test/tunnel?token=bridge-token-1", {
				headers: { upgrade: "websocket" },
			}),
		);

		expect(response.status).toBe(426);
		expect(await response.json()).toEqual({
			error: "websocket_upgrade_not_negotiated",
		});
	});
});
