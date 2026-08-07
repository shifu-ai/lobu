import { upgradeWebSocket as honoBunUpgradeWebSocket } from "hono/bun";
import { Hono } from "hono";
import type {
	LocalEgoBridgeRequest,
	LocalEgoBridgeResponse,
	LocalEgoTunnelRegistry,
} from "./local-ego-tunnel";
import { localEgoTunnelRegistry } from "./local-ego-tunnel";
import {
	exchangeToolboxBrowserBridgeToken,
	type ToolboxLocalEgoBridgeExchange,
} from "./toolbox-browser-session-client";

export interface LocalEgoBridgeWebSocket {
	send(message: string): void;
	close(code?: number, reason?: string): void;
	addEventListener(type: string, listener: (event: unknown) => void): void;
}

export type LocalEgoBridgeExchangeToken = (
	token: string,
) => Promise<ToolboxLocalEgoBridgeExchange>;

export type LocalEgoRouteUpgrade = (input: {
	request: Request;
	bridge: ToolboxLocalEgoBridgeExchange;
	onOpen: (socket: LocalEgoBridgeWebSocket) => void;
}) => Promise<Response> | Response;

export interface LocalEgoWebSocketRouteOptions {
	exchangeToken?: LocalEgoBridgeExchangeToken;
	registry?: LocalEgoTunnelRegistry;
	upgradeWebSocket?: LocalEgoRouteUpgrade;
}

type PendingResponse = {
	resolve: (response: LocalEgoBridgeResponse) => void;
};

const MAX_BROWSER_MESSAGE_BYTES = 2 * 1024 * 1024;

export function createLocalEgoWebSocketRoute(
	options: LocalEgoWebSocketRouteOptions = {},
): Hono {
	const app = new Hono();
	const registry = options.registry ?? localEgoTunnelRegistry;
	const exchangeToken = options.exchangeToken ?? exchangeToolboxBrowserBridgeToken;

	const handler = async (c: Parameters<Parameters<typeof app.get>[1]>[0]) => {
		if ((c.req.header("upgrade") ?? "").toLowerCase() !== "websocket") {
			return c.json({ error: "websocket_upgrade_required" }, 426, {
				Upgrade: "websocket",
			});
		}

		const token = c.req.query("token")?.trim();
		if (!token) return c.json({ error: "browser_bridge_token_required" }, 400);

		let bridge: ToolboxLocalEgoBridgeExchange;
		try {
			bridge = await exchangeToken(token);
		} catch {
			return c.json({ error: "browser_bridge_token_exchange_failed" }, 401);
		}

		const upgrade = options.upgradeWebSocket ?? createHonoBunUpgrade(c);
		return upgrade({
			request: c.req.raw,
			bridge,
			onOpen: (socket) => {
				acceptLocalEgoBridgeConnection({ socket, registry, bridge });
			},
		});
	};

	app.get("/tunnel", handler);
	app.get("/lobu/api/browser/local-ego/tunnel", handler);

	return app;
}

export function acceptLocalEgoBridgeConnection(input: {
	socket: LocalEgoBridgeWebSocket;
	registry: LocalEgoTunnelRegistry;
	bridge: ToolboxLocalEgoBridgeExchange;
}): void {
	const { socket, registry, bridge } = input;
	const allowedScopes = new Set(bridge.scopes);
	const pending = new Map<string, PendingResponse>();
	let connected = true;

	registry.register({
		environment: bridge.environment,
		ownerUserId: bridge.ownerUserId,
		agentId: bridge.agentId,
		bridgeId: bridge.bridgeId,
		send: async (request) => {
			if (!connected) return disconnectedResponse(request.id);
			if (!allowedScopes.has(request.params.name)) {
				return {
					jsonrpc: "2.0",
					id: request.id,
					error: { code: "tool_denied", message: "Browser tool scope denied." },
				};
			}
			return new Promise<LocalEgoBridgeResponse>((resolve) => {
				pending.set(request.id, { resolve });
				socket.send(JSON.stringify(request));
			});
		},
	});

	socket.addEventListener("message", (event) => {
		const data = readMessageData(event);
		if (typeof data !== "string" || data.length > MAX_BROWSER_MESSAGE_BYTES) {
			closeUnexpected(socket);
			return;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(data) as unknown;
		} catch {
			closeUnexpected(socket);
			return;
		}

		const response = parseBridgeResponse(parsed);
		if (!response) {
			closeUnexpected(socket);
			return;
		}
		const pendingResponse = pending.get(response.id);
		if (!pendingResponse) {
			closeUnexpected(socket);
			return;
		}
		pending.delete(response.id);
		pendingResponse.resolve(response);
	});

	socket.addEventListener("close", () => {
		if (!connected) return;
		connected = false;
		registry.disconnect({
			environment: bridge.environment,
			ownerUserId: bridge.ownerUserId,
			agentId: bridge.agentId,
			bridgeId: bridge.bridgeId,
		});
		for (const [id, pendingResponse] of pending) {
			pendingResponse.resolve(disconnectedResponse(id));
		}
		pending.clear();
	});
}

function createHonoBunUpgrade(c: {
	req: { raw: Request };
}): LocalEgoRouteUpgrade {
	return ({ onOpen }) => {
		let adapter: HonoWebSocketAdapter | undefined;
		const handler = honoBunUpgradeWebSocket(() => ({
			onOpen: (_event, ws) => {
				adapter = new HonoWebSocketAdapter(ws);
				onOpen(adapter);
			},
			onMessage: (event) => adapter?.dispatch("message", event),
			onClose: (event) => adapter?.dispatch("close", event),
			onError: (event) => adapter?.dispatch("close", event),
		}));
		return handler(c as never, async () => undefined) as Response | Promise<Response>;
	};
}

class HonoWebSocketAdapter implements LocalEgoBridgeWebSocket {
	private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

	constructor(private readonly ws: { send(data: string): void; close(code?: number, reason?: string): void }) {}

	send(message: string): void {
		this.ws.send(message);
	}

	close(code?: number, reason?: string): void {
		this.ws.close(code, reason);
	}

	addEventListener(type: string, listener: (event: unknown) => void): void {
		const listeners = this.listeners.get(type) ?? [];
		listeners.push(listener);
		this.listeners.set(type, listeners);
	}

	dispatch(type: string, event: unknown): void {
		for (const listener of this.listeners.get(type) ?? []) listener(event);
	}
}

function readMessageData(event: unknown): unknown {
	if (!event || typeof event !== "object") return undefined;
	return (event as { data?: unknown }).data;
}

function parseBridgeResponse(value: unknown): LocalEgoBridgeResponse | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (record.jsonrpc !== "2.0" || typeof record.id !== "string" || !record.id) {
		return null;
	}
	const hasResult = Object.hasOwn(record, "result");
	const hasError = Object.hasOwn(record, "error");
	if (hasResult === hasError) return null;
	if (hasError) {
		const error = record.error;
		if (!error || typeof error !== "object" || Array.isArray(error)) return null;
		const errorRecord = error as Record<string, unknown>;
		if (
			typeof errorRecord.code !== "string" ||
			typeof errorRecord.message !== "string"
		) {
			return null;
		}
		return {
			jsonrpc: "2.0",
			id: record.id,
			error: { code: errorRecord.code, message: errorRecord.message },
		};
	}

	const result = record.result;
	if (!result || typeof result !== "object" || Array.isArray(result)) return null;
	const resultRecord = result as Record<string, unknown>;
	if (
		resultRecord.ok !== true ||
		(resultRecord.url !== null && typeof resultRecord.url !== "string") ||
		(resultRecord.contentType !== "dom" &&
			resultRecord.contentType !== "screenshot" &&
			resultRecord.contentType !== "navigation")
	) {
		return null;
	}
	return {
		jsonrpc: "2.0",
		id: record.id,
		result: {
			ok: true,
			url: resultRecord.url,
			title:
				typeof resultRecord.title === "string" ? resultRecord.title : undefined,
			contentType: resultRecord.contentType,
			text: typeof resultRecord.text === "string" ? resultRecord.text : undefined,
			imageBase64:
				typeof resultRecord.imageBase64 === "string"
					? resultRecord.imageBase64
					: undefined,
			metadata:
				resultRecord.metadata &&
				typeof resultRecord.metadata === "object" &&
				!Array.isArray(resultRecord.metadata)
					? (resultRecord.metadata as Record<string, unknown>)
					: undefined,
		},
	};
}

function closeUnexpected(socket: LocalEgoBridgeWebSocket): void {
	socket.close(1008, "unexpected_browser_message");
}

function disconnectedResponse(id: LocalEgoBridgeRequest["id"]): LocalEgoBridgeResponse {
	return {
		jsonrpc: "2.0",
		id,
		error: { code: "bridge_disconnected", message: "Browser bridge disconnected." },
	};
}
