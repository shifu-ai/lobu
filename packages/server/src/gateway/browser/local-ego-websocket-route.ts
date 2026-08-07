import type { ReleaseCapabilityState } from "@lobu/core";
import type { Context } from "hono";
import { Hono } from "hono";
import { upgradeWebSocket as honoBunUpgradeWebSocket } from "hono/bun";
import { PERSONAL_BROWSER_LOCAL_EGO_CAPABILITY } from "../../../../core/src/constants";
import { verifyWorkerToken } from "../../../../core/src/worker/auth";
import type {
	BrowserToolName,
	LocalEgoBridgeRequest,
	LocalEgoBridgeResponse,
	LocalEgoTunnelRegistry,
} from "./local-ego-tunnel";
import { localEgoTunnelRegistry } from "./local-ego-tunnel";
import {
	createToolboxBrowserToolLease,
	exchangeToolboxBrowserBridgeToken,
	getToolboxBrowserCurrentSession,
	recordToolboxBrowserToolCall,
	ToolboxBrowserBridgeExchangeError,
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
	runtimeEnv?: Record<string, string | undefined>;
}

type PendingResponse = {
	resolve: (response: LocalEgoBridgeResponse) => void;
	cleanup: () => void;
};

const MAX_BROWSER_MESSAGE_BYTES = 2 * 1024 * 1024;
const REQUIRED_TUNNEL_MODE = "single_process";
const TOOL_CALL_TIMEOUT_MS = 60_000;
const BROWSER_TOOLS = new Set<BrowserToolName>([
	"browser_read_dom",
	"browser_screenshot",
	"browser_navigate",
]);

export interface LocalEgoTunnelRuntimeConfig {
	available: boolean;
	mode?: string;
	instanceId?: string;
}

export function resolveLocalEgoTunnelRuntimeConfig(
	env: Record<string, string | undefined> = process.env,
): LocalEgoTunnelRuntimeConfig {
	const mode = env.LOCAL_EGO_BROWSER_TUNNEL_MODE?.trim();
	return {
		available: mode === REQUIRED_TUNNEL_MODE,
		mode,
		instanceId: env.LOCAL_EGO_BROWSER_TUNNEL_INSTANCE_ID?.trim() || undefined,
	};
}

export function createLocalEgoWebSocketRoute(
	options: LocalEgoWebSocketRouteOptions = {},
): Hono {
	const app = new Hono();
	const registry = options.registry ?? localEgoTunnelRegistry;
	const exchangeToken =
		options.exchangeToken ?? exchangeToolboxBrowserBridgeToken;

	const handler = async (c: Context) => {
		if ((c.req.header("upgrade") ?? "").toLowerCase() !== "websocket") {
			return c.json({ error: "websocket_upgrade_required" }, 426, {
				Upgrade: "websocket",
			});
		}

		const runtimeConfig = resolveLocalEgoTunnelRuntimeConfig(
			options.runtimeEnv ?? process.env,
		);
		/*
		 * This MVP registry is an in-process Map. It is valid only when Lobu is
		 * intentionally running a single app instance or an equivalent sticky-routing
		 * carrier where browser registration and tool calls hit the same process.
		 * Keep failing closed here until a shared registry/fan-out exists.
		 */
		if (!runtimeConfig.available) {
			return c.json({ error: "local_ego_tunnel_registry_unavailable" }, 503);
		}

		const token = c.req.query("token")?.trim();
		if (!token) return c.json({ error: "browser_bridge_token_required" }, 400);

		let bridge: ToolboxLocalEgoBridgeExchange;
		try {
			bridge = await exchangeToken(token);
		} catch (error) {
			return c.json(
				{ error: "browser_bridge_token_exchange_failed" },
				exchangeFailureStatus(error),
			);
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
	app.post("/tools/:toolName", async (c) => {
		const runtimeConfig = resolveLocalEgoTunnelRuntimeConfig(
			options.runtimeEnv ?? process.env,
		);
		if (!runtimeConfig.available) {
			return c.json({ error: "local_ego_tunnel_registry_unavailable" }, 503);
		}

		const toolName = parseBrowserToolName(c.req.param("toolName"));
		if (!toolName) return c.json({ error: "unknown_browser_tool" }, 404);

		const authHeader = c.req.header("authorization");
		if (!authHeader?.startsWith("Bearer ")) {
			return c.json({ error: "invalid_worker_token" }, 401);
		}
		const tokenData = verifyWorkerToken(authHeader.substring(7));
		if (!tokenData) return c.json({ error: "invalid_worker_token" }, 401);

		const ownerUserId = tokenData.userId;
		const agentId = tokenData.agentId;
		const runId = tokenData.runId;
		if (!ownerUserId || !agentId || !runId) {
			return c.json({ error: "missing_run_identity" }, 403);
		}
		const capabilityIds = activeBrowserCapabilityIds({
			releaseState: tokenData.releaseState,
			ownerUserId,
			agentId,
		});
		if (!capabilityIds.includes(PERSONAL_BROWSER_LOCAL_EGO_CAPABILITY)) {
			await auditBrowserToolCallSafe({
				ownerUserId,
				agentId,
				runId,
				toolName,
				result: "denied",
				errorCode: "missing_release_capability",
			});
			return c.json({ error: "missing_release_capability" }, 403);
		}

		const parsedBody = await parseToolCallBody(c.req.raw);
		if (!parsedBody.ok) {
			return c.json({ error: parsedBody.error }, 400);
		}
		const validatedArgs = validateBrowserToolArguments(
			toolName,
			parsedBody.arguments,
		);
		if (!validatedArgs.ok) {
			return c.json({ error: "invalid_browser_tool_arguments" }, 400);
		}

		let session:
			| Awaited<ReturnType<typeof getToolboxBrowserCurrentSession>>
			| undefined;
		try {
			session = await getToolboxBrowserCurrentSession({
				ownerUserId,
				agentId,
				runId,
				capabilityIds,
			});
			if (session.ownerUserId !== ownerUserId || session.agentId !== agentId) {
				await auditBrowserToolCallSafe({
					ownerUserId,
					agentId,
					runId,
					toolName,
					sessionId: session.sessionId,
					bridgeId: session.bridgeId,
					result: "denied",
					errorCode: "owner_mismatch",
				});
				return c.json({ error: "owner_mismatch" }, 403);
			}
			const lease = await createToolboxBrowserToolLease({
				ownerUserId,
				agentId,
				runId,
				toolName,
				sessionId: session.sessionId,
				bridgeId: session.bridgeId,
			});
			const result = await registry.callTool({
				environment: session.environment,
				ownerUserId,
				agentId,
				bridgeId: session.bridgeId,
				toolName,
				args: validatedArgs.arguments,
				lease: {
					sessionId: lease.sessionId,
					leaseToken: lease.leaseToken,
					runId: lease.runId,
					expiresAt: lease.expiresAt,
				},
				timeoutMs: TOOL_CALL_TIMEOUT_MS,
			});
			try {
				await recordToolboxBrowserToolCall({
					ownerUserId,
					agentId,
					runId,
					toolName,
					sessionId: session.sessionId,
					bridgeId: session.bridgeId,
					result: "success",
					metadata: {
						contentType: result.contentType,
						url: result.url,
						title: result.title,
						...(result.metadata ?? {}),
					},
				});
			} catch {
				return c.json({ error: "browser_audit_failed" }, 502);
			}
			return c.json({ ok: true, result });
		} catch (error) {
			const code = browserToolErrorCode(error);
			await auditBrowserToolCallSafe({
				ownerUserId,
				agentId,
				runId,
				toolName,
				sessionId: session?.sessionId,
				bridgeId: session?.bridgeId,
				result: "failed",
				errorCode: code,
			});
			return c.json({ error: code }, browserToolErrorStatus(code));
		}
	});

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
		send: async (request, { signal }) => {
			if (!connected) return disconnectedResponse(request.id);
			if (signal.aborted) return timeoutResponse(request.id);
			if (!allowedScopes.has(request.params.name)) {
				return {
					jsonrpc: "2.0",
					id: request.id,
					error: { code: "tool_denied", message: "Browser tool scope denied." },
				};
			}
			return new Promise<LocalEgoBridgeResponse>((resolve) => {
				const cleanup = () => {
					signal.removeEventListener("abort", onAbort);
				};
				const resolveOnce = (response: LocalEgoBridgeResponse) => {
					cleanup();
					resolve(response);
				};
				const onAbort = () => {
					if (!pending.delete(request.id)) return;
					resolveOnce(timeoutResponse(request.id));
				};
				signal.addEventListener("abort", onAbort, { once: true });
				pending.set(request.id, { resolve: resolveOnce, cleanup });
				try {
					socket.send(JSON.stringify(request));
				} catch {
					pending.delete(request.id);
					resolveOnce(disconnectedResponse(request.id));
				}
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
		pendingResponse.cleanup();
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
			pendingResponse.cleanup();
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
		return handler(c as never, async () => undefined) as
			| Response
			| Promise<Response>;
	};
}

function parseBrowserToolName(
	value: string | undefined,
): BrowserToolName | null {
	if (!value || !BROWSER_TOOLS.has(value as BrowserToolName)) return null;
	return value as BrowserToolName;
}

const MAX_BROWSER_DOM_TEXT_BYTES = 200_000;
const MAX_BROWSER_SCREENSHOT_BASE64_BYTES = 2_000_000;

function validateBrowserToolArguments(
	toolName: BrowserToolName,
	args: Record<string, unknown>,
): { ok: true; arguments: Record<string, unknown> } | { ok: false } {
	switch (toolName) {
		case "browser_read_dom": {
			if (!hasOnlyKeys(args, ["maxTextBytes"])) return { ok: false };
			if (
				args.maxTextBytes !== undefined &&
				!isBoundedPositiveInteger(args.maxTextBytes, MAX_BROWSER_DOM_TEXT_BYTES)
			) {
				return { ok: false };
			}
			return { ok: true, arguments: args };
		}
		case "browser_screenshot": {
			if (!hasOnlyKeys(args, ["maxImageBase64Bytes"])) return { ok: false };
			if (
				args.maxImageBase64Bytes !== undefined &&
				!isBoundedPositiveInteger(
					args.maxImageBase64Bytes,
					MAX_BROWSER_SCREENSHOT_BASE64_BYTES,
				)
			) {
				return { ok: false };
			}
			return { ok: true, arguments: args };
		}
		case "browser_navigate": {
			if (!hasOnlyKeys(args, ["url"])) return { ok: false };
			if (
				typeof args.url !== "string" ||
				!isAllowedBrowserNavigateUrl(args.url)
			) {
				return { ok: false };
			}
			return { ok: true, arguments: { url: args.url } };
		}
	}
}

function hasOnlyKeys(
	args: Record<string, unknown>,
	allowedKeys: readonly string[],
): boolean {
	const allowed = new Set(allowedKeys);
	return Object.keys(args).every((key) => allowed.has(key));
}

function isBoundedPositiveInteger(value: unknown, max: number): boolean {
	return (
		typeof value === "number" &&
		Number.isInteger(value) &&
		value > 0 &&
		value <= max
	);
}

function isAllowedBrowserNavigateUrl(value: string): boolean {
	try {
		const parsed = new URL(value);
		return parsed.protocol === "https:" || parsed.protocol === "http:";
	} catch {
		return false;
	}
}

function activeBrowserCapabilityIds(input: {
	releaseState: ReleaseCapabilityState | undefined;
	ownerUserId: string;
	agentId: string;
	now?: Date;
}): string[] {
	if (input.releaseState?.status !== "active") return [];
	const { claim } = input.releaseState;
	if (claim.toolboxUserId !== input.ownerUserId) return [];
	if (claim.agentId !== input.agentId) return [];
	const expiresAt = Date.parse(claim.expiresAt);
	if (
		!Number.isFinite(expiresAt) ||
		expiresAt <= (input.now ?? new Date()).getTime()
	) {
		return [];
	}
	return claim.capabilityIds;
}

async function parseToolCallBody(
	request: Request,
): Promise<
	| { ok: true; arguments: Record<string, unknown> }
	| { ok: false; error: string }
> {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return { ok: false, error: "invalid_json" };
	}
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return { ok: false, error: "invalid_request" };
	}
	const args = (body as Record<string, unknown>).arguments;
	if (args === undefined) return { ok: true, arguments: {} };
	if (!args || typeof args !== "object" || Array.isArray(args)) {
		return { ok: false, error: "invalid_arguments" };
	}
	return { ok: true, arguments: args as Record<string, unknown> };
}

async function auditBrowserToolCallSafe(
	input: Parameters<typeof recordToolboxBrowserToolCall>[0],
): Promise<void> {
	try {
		await recordToolboxBrowserToolCall(input);
	} catch {
		// Audit should be configured in deployed carriers, but a transient audit
		// failure should not make a completed browser bridge call look like a
		// browser execution failure to the agent.
	}
}

function browserToolErrorCode(error: unknown): string {
	if (error instanceof Error && error.message) return error.message;
	return "browser_tool_failed";
}

function browserToolErrorStatus(
	code: string,
): 400 | 403 | 409 | 413 | 503 | 504 {
	switch (code) {
		case "tool_denied":
		case "owner_mismatch":
		case "missing_release_capability":
			return 403;
		case "lease_expired":
			return 409;
		case "payload_too_large":
			return 413;
		case "timeout":
			return 504;
		default:
			return 503;
	}
}

class HonoWebSocketAdapter implements LocalEgoBridgeWebSocket {
	private readonly listeners = new Map<
		string,
		Array<(event: unknown) => void>
	>();

	constructor(
		private readonly ws: {
			send(data: string): void;
			close(code?: number, reason?: string): void;
		},
	) {}

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
		if (!error || typeof error !== "object" || Array.isArray(error))
			return null;
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
	if (!result || typeof result !== "object" || Array.isArray(result))
		return null;
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
			text:
				typeof resultRecord.text === "string" ? resultRecord.text : undefined,
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

function exchangeFailureStatus(error: unknown): 401 | 502 | 503 {
	if (error instanceof ToolboxBrowserBridgeExchangeError) {
		if (error.code === "toolbox_browser_bridge_exchange_not_configured") {
			return 503;
		}
		if (
			error.code === "browser_bridge_token_required" ||
			error.upstreamStatus === 400 ||
			error.upstreamStatus === 401 ||
			error.code === "toolbox_browser_bridge_exchange_rejected"
		) {
			return 401;
		}
	}
	return 502;
}

function timeoutResponse(
	id: LocalEgoBridgeRequest["id"],
): LocalEgoBridgeResponse {
	return {
		jsonrpc: "2.0",
		id,
		error: { code: "timeout", message: "Browser bridge timed out." },
	};
}

function disconnectedResponse(
	id: LocalEgoBridgeRequest["id"],
): LocalEgoBridgeResponse {
	return {
		jsonrpc: "2.0",
		id,
		error: {
			code: "bridge_disconnected",
			message: "Browser bridge disconnected.",
		},
	};
}
