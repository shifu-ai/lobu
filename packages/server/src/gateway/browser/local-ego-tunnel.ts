export type BrowserToolName =
	| "browser_read_dom"
	| "browser_screenshot"
	| "browser_navigate";

export interface LocalEgoBridgeRequest {
	jsonrpc: "2.0";
	id: string;
	method: "tools/call";
	params: {
		name: BrowserToolName;
		arguments: Record<string, unknown>;
		lease: {
			sessionId: string;
			leaseToken: string;
			runId: string;
			expiresAt: string;
		};
	};
}

export interface LocalEgoBridgeResult {
	ok: true;
	url: string | null;
	title?: string;
	contentType: "dom" | "screenshot" | "navigation";
	text?: string;
	imageBase64?: string;
	metadata?: Record<string, unknown>;
}

export interface LocalEgoBridgeResponse {
	jsonrpc: "2.0";
	id: string;
	result?: LocalEgoBridgeResult;
	error?: { code: string; message: string };
}

export interface RegisteredLocalEgoBridge {
	environment: string;
	ownerUserId: string;
	agentId: string;
	bridgeId: string;
	send(
		request: LocalEgoBridgeRequest,
		options: { signal: AbortSignal },
	): Promise<LocalEgoBridgeResponse>;
}

const ALLOWED_BROWSER_ERROR_CODES = new Set([
	"bridge_disconnected",
	"tool_denied",
	"tool_failed",
	"timeout",
	"payload_too_large",
]);

export function sanitizeBrowserBridgeErrorCode(code: unknown): string {
	return typeof code === "string" && ALLOWED_BROWSER_ERROR_CODES.has(code)
		? code
		: "tool_failed";
}

export type LocalEgoTunnelRegistry = ReturnType<
	typeof createLocalEgoTunnelRegistry
>;

export function createLocalEgoTunnelRegistry(input: { now: () => Date }) {
	const inputNow = input.now;
	const bridges = new Map<string, RegisteredLocalEgoBridge>();
	const key = (
		environment: string,
		ownerUserId: string,
		agentId: string,
		bridgeId: string,
	) => `${environment}:${ownerUserId}:${agentId}:${bridgeId}`;

	return {
		register(bridge: RegisteredLocalEgoBridge) {
			bridges.set(
				key(
					bridge.environment,
					bridge.ownerUserId,
					bridge.agentId,
					bridge.bridgeId,
				),
				bridge,
			);
			return bridge;
		},

		disconnect(input: {
			environment: string;
			ownerUserId: string;
			agentId: string;
			bridgeId: string;
		}) {
			bridges.delete(
				key(
					input.environment,
					input.ownerUserId,
					input.agentId,
					input.bridgeId,
				),
			);
		},

		async callTool(input: {
			environment: string;
			ownerUserId: string;
			agentId: string;
			bridgeId: string;
			toolName: BrowserToolName;
			args: Record<string, unknown>;
			lease: LocalEgoBridgeRequest["params"]["lease"];
			timeoutMs: number;
		}): Promise<LocalEgoBridgeResult> {
			const currentNow = inputNow();
			const bridge = bridges.get(
				key(
					input.environment,
					input.ownerUserId,
					input.agentId,
					input.bridgeId,
				),
			);
			if (!bridge) throw new Error("bridge_disconnected");
			if (new Date(input.lease.expiresAt).getTime() <= currentNow.getTime())
				throw new Error("lease_expired");

			const request: LocalEgoBridgeRequest = {
				jsonrpc: "2.0",
				id: crypto.randomUUID(),
				method: "tools/call",
				params: {
					name: input.toolName,
					arguments: input.args,
					lease: input.lease,
				},
			};

			const controller = new AbortController();
			let timeout: ReturnType<typeof setTimeout> | undefined;
			const sendResponse = Promise.resolve(
				bridge.send(request, { signal: controller.signal }),
			).catch((): LocalEgoBridgeResponse => disconnectedResponse(request.id));
			const response = await Promise.race([
				sendResponse,
				new Promise<LocalEgoBridgeResponse>((resolve) => {
					timeout = setTimeout(() => {
						controller.abort();
						resolve({
							jsonrpc: "2.0",
							id: request.id,
							error: { code: "timeout", message: "Browser bridge timed out." },
						});
					}, input.timeoutMs);
				}),
			]).finally(() => {
				if (timeout) clearTimeout(timeout);
			});

			if (response.error)
				throw new Error(sanitizeBrowserBridgeErrorCode(response.error.code));
			if (response.id !== request.id) throw new Error("tool_failed");
			if (!response.result?.ok) throw new Error("tool_failed");
			return response.result;
		},
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

export const localEgoTunnelRegistry = createLocalEgoTunnelRegistry({
	now: () => new Date(),
});
