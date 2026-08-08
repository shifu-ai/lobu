import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import type { LocalEgoTunnelRegistry } from "./local-ego-tunnel";
import { localEgoTunnelRegistry } from "./local-ego-tunnel";
import type {
	LocalEgoBridgeExchangeToken,
	LocalEgoBridgeWebSocket,
} from "./local-ego-websocket-route";
import {
	acceptLocalEgoBridgeConnection,
	authorizeLocalEgoTunnelConnection,
} from "./local-ego-websocket-route";

/**
 * Node counterpart of the Bun in-handler upgrade in
 * local-ego-websocket-route.ts. On Node, a genuine WebSocket upgrade is
 * consumed by the http server's 'upgrade' event and never reaches the Hono
 * request listener, so the tunnel needs this server-level handler; the Hono
 * route keeps serving proxy-normalized (non-upgradable) requests and the Bun
 * runtime.
 */

export const LOCAL_EGO_TUNNEL_UPGRADE_PATH =
	"/lobu/api/browser/local-ego/tunnel";

// Matches MAX_BROWSER_MESSAGE_BYTES (2 MiB) in the route module, doubled so
// the application-level 1008 close in acceptLocalEgoBridgeConnection stays
// the boundary clients observe; ws only guards against pathological frames.
const NODE_WS_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;

export interface UpgradableWebSocketServer {
	handleUpgrade(
		request: IncomingMessage,
		socket: Duplex,
		head: Buffer,
		callback: (socket: LocalEgoBridgeWebSocket) => void,
	): void;
}

export interface LocalEgoNodeUpgradeOptions {
	registry?: LocalEgoTunnelRegistry;
	exchangeToken?: LocalEgoBridgeExchangeToken;
	runtimeEnv?: Record<string, string | undefined>;
	webSocketServer?: UpgradableWebSocketServer;
	/**
	 * Called for upgrade requests on any other pathname. Defaults to
	 * destroying the socket — Node's own behavior when no 'upgrade' listener
	 * exists. server-lifecycle overrides this so coexisting listeners (Vite
	 * HMR in dev) still receive the upgrades they own.
	 */
	onUnhandledUpgrade?: (socket: Duplex) => void;
}

export type LocalEgoNodeUpgradeHandler = (
	request: IncomingMessage,
	socket: Duplex,
	head: Buffer,
) => void;

export function createLocalEgoNodeUpgradeHandler(
	options: LocalEgoNodeUpgradeOptions = {},
): LocalEgoNodeUpgradeHandler {
	const registry = options.registry ?? localEgoTunnelRegistry;
	const webSocketServer =
		options.webSocketServer ?? createNodeWebSocketServer();
	const onUnhandledUpgrade =
		options.onUnhandledUpgrade ?? ((socket: Duplex) => socket.destroy());

	const handle = async (
		request: IncomingMessage,
		socket: Duplex,
		head: Buffer,
	): Promise<void> => {
		let url: URL;
		try {
			url = new URL(request.url ?? "", "http://tunnel.internal");
		} catch {
			onUnhandledUpgrade(socket);
			return;
		}
		if (url.pathname !== LOCAL_EGO_TUNNEL_UPGRADE_PATH) {
			onUnhandledUpgrade(socket);
			return;
		}

		const authorization = await authorizeLocalEgoTunnelConnection({
			token: url.searchParams.get("token") ?? undefined,
			runtimeEnv: options.runtimeEnv,
			exchangeToken: options.exchangeToken,
		});
		if (!authorization.ok) {
			writeRawHttpJsonResponse(
				socket,
				authorization.status,
				authorization.error,
			);
			return;
		}
		const { bridge } = authorization;

		webSocketServer.handleUpgrade(request, socket, head, (bridgeSocket) => {
			acceptLocalEgoBridgeConnection({
				socket: bridgeSocket,
				registry,
				bridge,
			});
		});
	};

	return (request, socket, head) => {
		void handle(request, socket, head).catch(() => {
			try {
				socket.destroy();
			} catch {
				// socket already gone
			}
		});
	};
}

function createNodeWebSocketServer(): UpgradableWebSocketServer {
	const server = new WebSocketServer({
		noServer: true,
		maxPayload: NODE_WS_MAX_PAYLOAD_BYTES,
	});
	return {
		handleUpgrade(request, socket, head, callback) {
			server.handleUpgrade(request, socket, head, (webSocket) => {
				// ws exposes the browser-style addEventListener/send/close surface
				// (message events carry `.data`, string for text frames), which is
				// exactly the LocalEgoBridgeWebSocket contract.
				callback(webSocket as unknown as LocalEgoBridgeWebSocket);
			});
		},
	};
}

const STATUS_TEXTS: Record<number, string> = {
	400: "Bad Request",
	401: "Unauthorized",
	502: "Bad Gateway",
	503: "Service Unavailable",
};

/**
 * The 'upgrade' event hands over a raw socket — no ServerResponse exists, so
 * refusals must be written as literal HTTP/1.1 bytes. Status codes and error
 * bodies mirror what the Hono route returns for the same failures.
 */
function writeRawHttpJsonResponse(
	socket: Duplex,
	status: number,
	error: string,
): void {
	const body = JSON.stringify({ error });
	const statusText = STATUS_TEXTS[status] ?? "Error";
	try {
		socket.end(
			`HTTP/1.1 ${status} ${statusText}\r\n` +
				"content-type: application/json\r\n" +
				`content-length: ${Buffer.byteLength(body)}\r\n` +
				"connection: close\r\n" +
				"\r\n" +
				body,
		);
	} catch {
		socket.destroy();
	}
}
