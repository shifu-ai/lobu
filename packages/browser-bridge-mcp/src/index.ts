/**
 * @lobu/browser-bridge-mcp — SPIKE (replaces #819 @lobu/browser-bridge)
 *
 * Bridges Lobu connectors to the user's already-signed-in Chrome via
 * Microsoft's `@playwright/mcp --extension` + the Playwright MCP Bridge
 * Chrome extension (`mmlmfjhmonkocbjadbfplnigmagldckm`, on the Chrome
 * Web Store, MS-published).
 *
 * Architecture:
 *
 *     Lobu worker host (Node)        local MCP HTTP server        Chrome extension     user's Chrome
 *     ----------------------         --------------------         ----------------     -------------
 *     MCP client                  ── playwright-mcp           ── WebSocket          chrome.debugger
 *     (browser_navigate,             --extension --port            client                on user's tabs
 *      browser_click, ...)           Lobu spawns as a child
 *
 * Why this instead of the playwriter wrapper in #819:
 *   - MS-maintained (Playwright team). Strongest possible bus factor.
 *   - Clean dep tree: just `playwright` + `playwright-core`. No fork.
 *   - Extension lives on the Chrome Web Store — we don't ship one.
 *   - playwriter@0.1.0's CDP shim hangs Playwright's connectOverCDP after
 *     extension attach (verified against playwriter directly without our
 *     wrapper). MCP path sidesteps the shim entirely.
 *
 * Trade-off: connectors that use this bridge speak the MCP tool surface
 * (`browser_navigate`, `browser_click`, `browser_evaluate`, ...), not the
 * Playwright `Browser` / `Page` API. Connector authoring for the
 * bridge-only case is a new model — see `acquireBridgeMcp` in
 * `@lobu/connector-sdk` for the Lobu-side wrapping. Connectors that don't
 * need the user's real Chrome stay on Playwright + managed Chromium.
 *
 * Spike status: this package only stands up the local MCP server and
 * verifies the wire shape. Extension install in the user's Chrome, the
 * Mac menu-bar toggle, the actual connector authoring model — all
 * follow-ups. See README.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * Tool names this wrapper expects to be advertised by `@playwright/mcp` when
 * run with `--extension`. Centralised so the smoke test, runtime
 * preflighting, and any future typed helpers can share one source of truth.
 *
 * `@playwright/mcp` is `0.0.x` and pulls alpha Playwright; treat these as a
 * pinned-contract assertion. If an upgrade drops or renames any of these,
 * the smoke test (and `acquireBridgeMcp` preflight, when added) fail loud
 * with a clear "unsupported tool surface" message.
 */
export const EXPECTED_BROWSER_TOOLS = [
  "browser_navigate",
  "browser_click",
  "browser_snapshot",
] as const;

export interface McpBridgeServerOptions {
  /** TCP port for the MCP HTTP server. Defaults to 19998 (different from playwriter's 19988). */
  port?: number;
  /** Bind host. Loopback by default. */
  host?: "localhost" | "127.0.0.1" | "::1";
  /** Extra args to forward to `playwright-mcp`. Use with caution; the spike pins `--extension`. */
  extraArgs?: readonly string[];
  /**
   * If true, the child's stderr is forwarded to this process's stderr.
   * Default false — stderr is captured into a bounded ring buffer that's
   * surfaced on startup failure so silent crashes are diagnosable.
   */
  logStderr?: boolean;
}

export interface McpBridgeServer {
  /** MCP HTTP endpoint — pass directly to an MCP client (`mcpUrl + "/mcp"`). */
  readonly url: string;
  /** Stop the MCP server child process. */
  close(): Promise<void>;
}

const NOOP = () => undefined;

function resolveMcpBin(): string {
  // playwright-mcp ships as a bin (`playwright-mcp` → `cli.js`). Resolve
  // the package.json to find the script path; avoids hard-coding
  // node_modules/.bin which may not exist under bunx-style usage.
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve("@playwright/mcp/package.json");
  const pkg = require(pkgPath) as { bin?: string | Record<string, string> };
  const binEntry =
    typeof pkg.bin === "string"
      ? pkg.bin
      : (pkg.bin?.["playwright-mcp"] ?? "cli.js");
  const pkgDir = pkgPath.replace(/[/\\]package\.json$/, "");
  return `${pkgDir}/${binEntry}`;
}

async function waitForListening(
  url: string,
  timeoutMs: number,
  childExited: { reason: string | null }
): Promise<void> {
  const start = Date.now();
  let lastError: unknown;
  while (Date.now() - start < timeoutMs) {
    if (childExited.reason) {
      throw new Error(
        `MCP bridge server child exited before ready: ${childExited.reason}`
      );
    }
    try {
      // playwright-mcp answers GET / with the MCP discovery; we just want
      // to know "something is listening." Any HTTP response counts.
      const res = await fetch(url, { method: "GET" });
      if (res.status > 0) return;
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `MCP bridge server did not start within ${timeoutMs}ms (last error: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    })`
  );
}

function formatHostForUrl(host: string): string {
  // IPv6 literals must be bracketed in URLs (e.g. http://[::1]:port).
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

const STDERR_BUFFER_BYTES = 32 * 1024;

/**
 * Start `playwright-mcp --extension --port <port>` as a child process.
 *
 * Caller usage:
 *
 *     const bridge = await startMcpBridgeServer({ port: 19998 });
 *     // Connect an MCP client to `${bridge.url}/mcp` (see @modelcontextprotocol/sdk client).
 *     // Tools: browser_navigate, browser_click, browser_evaluate, ...
 *     await bridge.close();
 *
 * NOTE: This spike does NOT install the Microsoft Playwright Bridge
 * Chrome extension. The operator must install it from the Web Store
 * manually before the bridge can drive any real tab. Until installed,
 * tool calls will return "no browser connected" errors from the MCP
 * server. Follow-up: bundle the extension install into the Mac
 * menu-bar app's "Allow Lobu to use this browser" toggle.
 */
export async function startMcpBridgeServer(
  opts: McpBridgeServerOptions = {}
): Promise<McpBridgeServer> {
  const port = opts.port ?? 19998;
  // Default to `localhost` (not `127.0.0.1`) because playwright-mcp's
  // Host-header allow-list defaults to the host it's bound to, and MCP
  // client URLs typically use `localhost` — Host headers must match.
  const host = opts.host ?? "localhost";

  const bin = resolveMcpBin();
  const args = [
    "--extension",
    "--port",
    String(port),
    "--host",
    host,
    // Allow both forms so a connector that mints URLs with either name or
    // IP works. Loopback binding is the actual security boundary.
    "--allowed-hosts",
    `localhost:${port},127.0.0.1:${port},[::1]:${port}`,
    ...(opts.extraArgs ?? []),
  ];

  const child: ChildProcess = spawn(process.execPath, [bin, ...args], {
    stdio: ["ignore", "ignore", "pipe"],
  });

  // Track early exit so the readiness loop can fail fast instead of
  // polling a port nothing's listening on for the full timeout.
  const exited: { reason: string | null } = { reason: null };
  child.once("exit", (code, signal) => {
    exited.reason = signal ? `signal ${signal}` : `code ${code ?? "?"}`;
  });
  child.once("error", (err) => {
    exited.reason = `spawn error: ${err.message}`;
  });

  // Bounded stderr ring buffer — surfaced on startup failure for
  // diagnosability. If `logStderr` is true, also tee to this process.
  let stderrBuf = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    if (opts.logStderr) process.stderr.write(chunk);
    stderrBuf += chunk.toString("utf8");
    if (stderrBuf.length > STDERR_BUFFER_BYTES) {
      stderrBuf = stderrBuf.slice(-STDERR_BUFFER_BYTES);
    }
  });
  child.stderr?.on("error", NOOP);

  const readyUrl = `http://${formatHostForUrl(host)}:${port}/`;
  try {
    await waitForListening(readyUrl, 10_000, exited);
  } catch (err) {
    if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
    const tail = stderrBuf.trim().slice(-2_000);
    const detail = tail ? `\n--- child stderr (tail) ---\n${tail}` : "";
    throw new Error(`${err instanceof Error ? err.message : String(err)}${detail}`);
  }

  // Parent-exit cleanup so a crashed/killed parent doesn't orphan the
  // playwright-mcp child. SIGINT/SIGTERM forward; `exit` is best-effort
  // (synchronous kill, no wait).
  const cleanupOnExit = () => {
    if (child.exitCode === null && !child.killed) {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
  };
  const forwardAndDie = (sig: NodeJS.Signals) => () => {
    cleanupOnExit();
    process.exit(sig === "SIGINT" ? 130 : 143);
  };
  const onSigint = forwardAndDie("SIGINT");
  const onSigterm = forwardAndDie("SIGTERM");
  process.once("exit", cleanupOnExit);
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  let closed = false;
  return {
    url: `http://${formatHostForUrl(host)}:${port}`,
    async close() {
      if (closed) return;
      closed = true;
      process.removeListener("exit", cleanupOnExit);
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
      if (child.exitCode !== null || child.killed) return;
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // ignore
          }
          resolve();
        }, 2_000);
        child.once("exit", () => {
          clearTimeout(t);
          resolve();
        });
      });
    },
  };
}

// ----------------------------------------------------------------------------
// Connector-facing API: thin MCP client wrapper
// ----------------------------------------------------------------------------

export interface AcquireBridgeMcpOptions {
  /** Bridge endpoint (from `BridgeServer.url`). The `/mcp` path is appended automatically. */
  bridgeUrl: string;
  /** Client identity sent in the MCP `initialize` handshake. */
  clientName?: string;
  clientVersion?: string;
}

export interface AcquiredBridgeMcp {
  /** Connected MCP client. Call `callTool({ name, arguments })` to drive the browser. */
  readonly client: Client;
  /** Close the MCP transport. Does NOT stop the underlying bridge server. */
  close(): Promise<void>;
}

/**
 * Connector-side handle for the MCP bridge.
 *
 * The returned `client` is a connected `@modelcontextprotocol/sdk` Client.
 * Use `client.callTool({ name: "browser_navigate", arguments: { url } })`
 * etc. — list the available tools with `client.listTools()`.
 *
 * Connectors that need the user's real signed-in Chrome use this; everything
 * else stays on the Playwright `acquireBrowser` path in connector-sdk.
 */
export async function acquireBridgeMcp(
  opts: AcquireBridgeMcpOptions
): Promise<AcquiredBridgeMcp> {
  const client = new Client(
    {
      name: opts.clientName ?? "lobu-connector",
      version: opts.clientVersion ?? "0.0.0",
    },
    {}
  );
  const transport = new StreamableHTTPClientTransport(
    new URL(`${opts.bridgeUrl}/mcp`)
  );
  await client.connect(transport);
  return {
    client,
    async close() {
      await client.close().catch(() => undefined);
    },
  };
}
