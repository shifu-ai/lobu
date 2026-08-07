import type { BrowserToolName } from "./local-ego-tunnel";

export type LocalEgoBridgeEnvironment = "staging" | "production";

export interface ToolboxLocalEgoBridgeExchange {
	environment: LocalEgoBridgeEnvironment;
	ownerUserId: string;
	agentId: string;
	bridgeId: string;
	scopes: readonly BrowserToolName[];
	nonce?: string;
}

export interface ToolboxBrowserSessionClientOptions {
	exchangeUrl?: string;
	currentSessionUrl?: string;
	leaseUrl?: string;
	auditUrl?: string;
	apiBaseUrl?: string;
	internalSecret?: string;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}

export class ToolboxBrowserBridgeExchangeError extends Error {
	constructor(
		readonly code: string,
		readonly upstreamStatus?: number,
	) {
		super(code);
	}
}

const MAX_EXCHANGE_RESPONSE_BYTES = 16 * 1024;
const BROWSER_TOOLS = new Set<BrowserToolName>([
	"browser_read_dom",
	"browser_screenshot",
	"browser_navigate",
]);

export interface ToolboxBrowserCurrentSession {
	environment: LocalEgoBridgeEnvironment;
	ownerUserId: string;
	agentId: string;
	sessionId: string;
	bridgeId: string;
}

export interface ToolboxBrowserToolLease {
	sessionId: string;
	leaseToken: string;
	runId: string;
	expiresAt: string;
}

export async function exchangeToolboxBrowserBridgeToken(
	token: string,
	options: ToolboxBrowserSessionClientOptions = {},
): Promise<ToolboxLocalEgoBridgeExchange> {
	if (!token.trim()) {
		throw new ToolboxBrowserBridgeExchangeError("browser_bridge_token_required");
	}
	const exchangeUrl =
		options.exchangeUrl ??
		process.env.TOOLBOX_BROWSER_BRIDGE_TOKEN_EXCHANGE_URL?.trim();
	const internalSecret =
		options.internalSecret ?? process.env.TOOLBOX_INTERNAL_SECRET?.trim();
	if (!exchangeUrl || !internalSecret) {
		throw new ToolboxBrowserBridgeExchangeError(
			"toolbox_browser_bridge_exchange_not_configured",
		);
	}

	const controller = new AbortController();
	const timeout = setTimeout(
		() => controller.abort(),
		options.timeoutMs ?? 1_500,
	);
	try {
		let response: Response;
		try {
			response = await (options.fetchImpl ?? fetch)(exchangeUrl, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-internal-secret": internalSecret,
				},
				body: JSON.stringify({ token }),
				signal: controller.signal,
			});
		} catch {
			throw new ToolboxBrowserBridgeExchangeError(
				"toolbox_browser_bridge_exchange_fetch_failed",
			);
		}
		if (!response.ok) {
			throw new ToolboxBrowserBridgeExchangeError(
				"toolbox_browser_bridge_exchange_failed",
				response.status,
			);
		}
		const body = await readBoundedJson(response, MAX_EXCHANGE_RESPONSE_BYTES);
		return parseExchangeResponse(body);
	} finally {
		clearTimeout(timeout);
	}
}

export async function getToolboxBrowserCurrentSession(input: {
	ownerUserId: string;
	agentId: string;
	runId: number;
	capabilityIds: string[];
}, options: ToolboxBrowserSessionClientOptions = {}): Promise<ToolboxBrowserCurrentSession> {
	const body = await postToolboxBrowserSessionRoute(
		resolveToolboxBrowserSessionUrl(
			options.currentSessionUrl,
			options.apiBaseUrl,
			process.env.TOOLBOX_BROWSER_CURRENT_SESSION_URL,
			"/agent-workbench/browser-sessions/internal/current",
		),
		{
			ownerUserId: input.ownerUserId,
			agentId: input.agentId,
			runId: input.runId,
			capabilityIds: input.capabilityIds,
		},
		options,
		"toolbox_browser_current_session",
	);
	return parseCurrentSessionResponse(body);
}

export async function createToolboxBrowserToolLease(input: {
	ownerUserId: string;
	agentId: string;
	runId: number;
	toolName: BrowserToolName;
	sessionId: string;
	bridgeId: string;
}, options: ToolboxBrowserSessionClientOptions = {}): Promise<ToolboxBrowserToolLease> {
	const body = await postToolboxBrowserSessionRoute(
		resolveToolboxBrowserSessionUrl(
			options.leaseUrl,
			options.apiBaseUrl,
			process.env.TOOLBOX_BROWSER_TOOL_LEASE_URL,
			"/agent-workbench/browser-sessions/internal/leases",
		),
		input,
		options,
		"toolbox_browser_tool_lease",
	);
	return parseLeaseResponse(body);
}

export async function recordToolboxBrowserToolCall(input: {
	ownerUserId: string;
	agentId: string;
	runId: number;
	toolName: BrowserToolName;
	sessionId?: string;
	bridgeId?: string;
	result: "success" | "denied" | "failed";
	errorCode?: string;
	metadata?: Record<string, unknown>;
}, options: ToolboxBrowserSessionClientOptions = {}): Promise<void> {
	await postToolboxBrowserSessionRoute(
		resolveToolboxBrowserSessionUrl(
			options.auditUrl,
			options.apiBaseUrl,
			process.env.TOOLBOX_BROWSER_TOOL_CALL_AUDIT_URL,
			"/agent-workbench/browser-sessions/internal/tool-calls",
		),
		input,
		options,
		"toolbox_browser_tool_call_audit",
	);
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
	const declared = response.headers.get("content-length");
	if (
		declared !== null &&
		(!/^\d+$/.test(declared) || Number(declared) > maxBytes)
	) {
		await response.body?.cancel();
		throw new ToolboxBrowserBridgeExchangeError(
			"toolbox_browser_bridge_exchange_response_too_large",
		);
	}
	if (!response.body) {
		throw new ToolboxBrowserBridgeExchangeError(
			"toolbox_browser_bridge_exchange_empty",
		);
	}

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			bytes += chunk.value.byteLength;
			if (bytes > maxBytes) {
				await reader.cancel();
				throw new ToolboxBrowserBridgeExchangeError(
					"toolbox_browser_bridge_exchange_response_too_large",
				);
			}
			chunks.push(chunk.value);
		}
	} finally {
		reader.releaseLock();
	}

	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
	} catch {
		throw new ToolboxBrowserBridgeExchangeError(
			"toolbox_browser_bridge_exchange_invalid_json",
		);
	}
}

async function postToolboxBrowserSessionRoute(
	url: string,
	body: Record<string, unknown>,
	options: ToolboxBrowserSessionClientOptions,
	errorPrefix: string,
): Promise<unknown> {
	const internalSecret =
		options.internalSecret ?? process.env.TOOLBOX_INTERNAL_SECRET?.trim();
	if (!url || !internalSecret) {
		throw new ToolboxBrowserBridgeExchangeError(`${errorPrefix}_not_configured`);
	}
	const controller = new AbortController();
	const timeout = setTimeout(
		() => controller.abort(),
		options.timeoutMs ?? 1_500,
	);
	try {
		let response: Response;
		try {
			response = await (options.fetchImpl ?? fetch)(url, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-internal-secret": internalSecret,
				},
				body: JSON.stringify(body),
				signal: controller.signal,
			});
		} catch {
			throw new ToolboxBrowserBridgeExchangeError(`${errorPrefix}_fetch_failed`);
		}
		if (!response.ok) {
			throw new ToolboxBrowserBridgeExchangeError(
				`${errorPrefix}_failed`,
				response.status,
			);
		}
		return readBoundedJson(response, MAX_EXCHANGE_RESPONSE_BYTES);
	} finally {
		clearTimeout(timeout);
	}
}

function resolveToolboxBrowserSessionUrl(
	explicitUrl: string | undefined,
	explicitBaseUrl: string | undefined,
	envUrl: string | undefined,
	pathname: string,
): string {
	const direct = explicitUrl?.trim() || envUrl?.trim();
	if (direct) return direct;
	const base =
		explicitBaseUrl?.trim() ||
		process.env.TOOLBOX_BROWSER_SESSION_API_BASE_URL?.trim() ||
		process.env.TOOLBOX_API_BASE_URL?.trim();
	return base ? `${base.replace(/\/+$/, "")}${pathname}` : "";
}

function parseExchangeResponse(value: unknown): ToolboxLocalEgoBridgeExchange {
	const outer = record(value);
	if (outer.ok !== true) {
		throw new ToolboxBrowserBridgeExchangeError(
			"toolbox_browser_bridge_exchange_rejected",
		);
	}
	const bridge = record(outer.bridge);
	const environment = stringField(bridge.environment);
	if (environment !== "staging" && environment !== "production") {
		throw new ToolboxBrowserBridgeExchangeError(
			"toolbox_browser_bridge_exchange_invalid_environment",
		);
	}
	const ownerUserId = stringField(bridge.ownerUserId);
	const agentId = stringField(bridge.agentId);
	const bridgeId = stringField(bridge.bridgeId);
	const scopesValue = bridge.scopes;
	if (!Array.isArray(scopesValue) || scopesValue.length === 0) {
		throw new ToolboxBrowserBridgeExchangeError(
			"toolbox_browser_bridge_exchange_invalid_scopes",
		);
	}
	const scopes = scopesValue.map((scope) => {
		const value = stringField(scope);
		if (!BROWSER_TOOLS.has(value as BrowserToolName)) {
			throw new ToolboxBrowserBridgeExchangeError(
				"toolbox_browser_bridge_exchange_unknown_scope",
			);
		}
		return value as BrowserToolName;
	});

	return {
		environment,
		ownerUserId,
		agentId,
		bridgeId,
		scopes,
		nonce:
			typeof bridge.nonce === "string" && bridge.nonce.trim()
				? bridge.nonce
				: undefined,
	};
}

function parseCurrentSessionResponse(value: unknown): ToolboxBrowserCurrentSession {
	const outer = record(value);
	const session = record(outer.session ?? outer.browserSession ?? outer);
	const environment = stringField(session.environment);
	if (environment !== "staging" && environment !== "production") {
		throw new ToolboxBrowserBridgeExchangeError(
			"toolbox_browser_current_session_invalid_environment",
		);
	}
	return {
		environment,
		ownerUserId: stringField(session.ownerUserId),
		agentId: stringField(session.agentId),
		sessionId: stringField(session.sessionId),
		bridgeId: stringField(session.bridgeId),
	};
}

function parseLeaseResponse(value: unknown): ToolboxBrowserToolLease {
	const outer = record(value);
	const lease = record(outer.lease ?? outer);
	return {
		sessionId: stringField(lease.sessionId),
		leaseToken: stringField(lease.leaseToken),
		runId: stringField(lease.runId),
		expiresAt: stringField(lease.expiresAt),
	};
}

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new ToolboxBrowserBridgeExchangeError(
			"toolbox_browser_bridge_exchange_invalid_contract",
		);
	}
	return value as Record<string, unknown>;
}

function stringField(value: unknown): string {
	if (typeof value !== "string" || !value.trim() || value.length > 500) {
		throw new ToolboxBrowserBridgeExchangeError(
			"toolbox_browser_bridge_exchange_invalid_contract",
		);
	}
	return value;
}
