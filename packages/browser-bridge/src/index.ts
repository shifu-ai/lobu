/**
 * @lobu/browser-bridge — SPIKE
 *
 * CDP relay that lets Lobu Playwright connectors drive the user's
 * already-signed-in Chrome via a Chrome extension that uses
 * `chrome.debugger.attach` and forwards CDP frames over WebSocket.
 *
 * Architecture:
 *
 *     Lobu worker host (Node)          local relay         Chrome extension
 *     ----------------------          ------------         ----------------
 *     chromium.connectOverCDP(url) ── WS server on :19988 ─ WS client
 *                                     + browser-level                      ↓
 *                                     CDP shim (Target.*)         chrome.debugger
 *                                                                 .attach on tabs
 *
 * Spike status: this package is a thin wrapper around `playwriter`
 * (https://github.com/remorses/playwriter, MIT) which implements the actual
 * CDP shim and extension. We do NOT ship the extension here yet — for the
 * spike, the user loads playwriter's unpacked extension manually. The
 * follow-up PR folds the extension into apps/chrome/ in the owletto-web
 * submodule.
 *
 * Why a wrapper rather than calling playwriter directly: gives connector-sdk
 * a stable Lobu-shaped API, lets us swap the underlying implementation
 * later (vendored fork, in-house rewrite) without churning every caller.
 */

import { startPlayWriterCDPRelayServer } from "playwriter";

export interface BridgeServerOptions {
  /**
   * TCP port for the loopback CDP relay. Defaults to playwriter's 19988.
   * Pick a random port + advertise it via the Lobu device-worker poll
   * payload when running in a multi-tenant environment.
   */
  port?: number;
  /**
   * Bind host. MUST be loopback in production (`127.0.0.1` or `::1`).
   * Defaults to `127.0.0.1`. The CDP endpoint is unauthenticated below the
   * `token` layer, so binding to a non-loopback interface effectively
   * exposes browser control to the network.
   */
  host?: string;
  /**
   * Bearer token required on connections. When set, callers must include
   * `Authorization: Bearer <token>` on the CDP WebSocket. Strongly
   * recommended; the spike accepts undefined for local dev only.
   */
  token?: string;
  /**
   * Optional logger sink. Defaults to no-op so the relay doesn't spam stdout
   * from inside a connector run.
   */
  logger?: { log(...args: unknown[]): void; error(...args: unknown[]): void };
}

export interface BridgeServer {
  /** CDP endpoint URL — pass directly to `chromium.connectOverCDP(url, ...)`. */
  readonly url: string;
  /** Stop the relay and disconnect any attached extensions. */
  close(): void;
}

const NOOP_LOGGER = {
  log: () => undefined,
  error: () => undefined,
};

/**
 * Start the loopback CDP relay. Returns once the server is listening.
 *
 * Connector usage:
 *
 *     const bridge = await startBridgeServer({ token: randomToken() });
 *     const browser = await chromium.connectOverCDP(bridge.url, {
 *       headers: { authorization: `Bearer ${token}` },
 *     });
 *     // ... run connector ...
 *     await browser.close();
 *     bridge.close();
 */
export async function startBridgeServer(
  opts: BridgeServerOptions = {}
): Promise<BridgeServer> {
  const port = opts.port ?? 19988;
  const host = opts.host ?? "127.0.0.1";
  const logger = opts.logger ?? NOOP_LOGGER;

  const server = await startPlayWriterCDPRelayServer({
    port,
    host,
    token: opts.token,
    logger,
  });

  return {
    url: `ws://${host}:${port}`,
    close: () => server.close(),
  };
}
