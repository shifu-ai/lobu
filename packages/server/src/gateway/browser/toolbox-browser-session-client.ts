import type { BrowserToolName } from "./local-ego-tunnel";

export type LocalEgoBridgeEnvironment = "staging" | "production";

export interface ToolboxLocalEgoBridgeExchange {
	environment: LocalEgoBridgeEnvironment;
	ownerUserId: string;
	agentId: string;
	bridgeId: string;
	scopes: BrowserToolName[];
	nonce?: string;
}

export interface ToolboxBrowserSessionClientOptions {
	exchangeUrl?: string;
	internalSecret?: string;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}

const MAX_EXCHANGE_RESPONSE_BYTES = 16 * 1024;
const BROWSER_TOOLS = new Set<BrowserToolName>([
	"browser_read_dom",
	"browser_screenshot",
	"browser_navigate",
]);

export async function exchangeToolboxBrowserBridgeToken(
	token: string,
	options: ToolboxBrowserSessionClientOptions = {},
): Promise<ToolboxLocalEgoBridgeExchange> {
	if (!token.trim()) throw new Error("browser_bridge_token_required");
	const exchangeUrl =
		options.exchangeUrl ??
		process.env.TOOLBOX_BROWSER_BRIDGE_TOKEN_EXCHANGE_URL?.trim();
	const internalSecret =
		options.internalSecret ?? process.env.TOOLBOX_INTERNAL_SECRET?.trim();
	if (!exchangeUrl || !internalSecret) {
		throw new Error("toolbox_browser_bridge_exchange_not_configured");
	}

	const controller = new AbortController();
	const timeout = setTimeout(
		() => controller.abort(),
		options.timeoutMs ?? 1_500,
	);
	try {
		const response = await (options.fetchImpl ?? fetch)(exchangeUrl, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-internal-secret": internalSecret,
			},
			body: JSON.stringify({ token }),
			signal: controller.signal,
		});
		if (!response.ok) {
			throw new Error(`toolbox_browser_bridge_exchange_failed:${response.status}`);
		}
		const body = await readBoundedJson(response, MAX_EXCHANGE_RESPONSE_BYTES);
		return parseExchangeResponse(body);
	} finally {
		clearTimeout(timeout);
	}
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
	const declared = response.headers.get("content-length");
	if (
		declared !== null &&
		(!/^\d+$/.test(declared) || Number(declared) > maxBytes)
	) {
		await response.body?.cancel();
		throw new Error("toolbox_browser_bridge_exchange_response_too_large");
	}
	if (!response.body) throw new Error("toolbox_browser_bridge_exchange_empty");

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
				throw new Error("toolbox_browser_bridge_exchange_response_too_large");
			}
			chunks.push(chunk.value);
		}
	} finally {
		reader.releaseLock();
	}

	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
	} catch {
		throw new Error("toolbox_browser_bridge_exchange_invalid_json");
	}
}

function parseExchangeResponse(value: unknown): ToolboxLocalEgoBridgeExchange {
	const outer = record(value);
	if (outer.ok !== true) throw new Error("toolbox_browser_bridge_exchange_rejected");
	const bridge = record(outer.bridge);
	const environment = stringField(bridge.environment);
	if (environment !== "staging" && environment !== "production") {
		throw new Error("toolbox_browser_bridge_exchange_invalid_environment");
	}
	const ownerUserId = stringField(bridge.ownerUserId);
	const agentId = stringField(bridge.agentId);
	const bridgeId = stringField(bridge.bridgeId);
	const scopesValue = bridge.scopes;
	if (!Array.isArray(scopesValue) || scopesValue.length === 0) {
		throw new Error("toolbox_browser_bridge_exchange_invalid_scopes");
	}
	const scopes = scopesValue.map((scope) => {
		const value = stringField(scope);
		if (!BROWSER_TOOLS.has(value as BrowserToolName)) {
			throw new Error("toolbox_browser_bridge_exchange_unknown_scope");
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

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("toolbox_browser_bridge_exchange_invalid_contract");
	}
	return value as Record<string, unknown>;
}

function stringField(value: unknown): string {
	if (typeof value !== "string" || !value.trim() || value.length > 500) {
		throw new Error("toolbox_browser_bridge_exchange_invalid_contract");
	}
	return value;
}
