/**
 * Spike-level wire test for @lobu/browser-bridge-mcp.
 *
 * Boots the MCP bridge server (which spawns `playwright-mcp --extension`),
 * connects an MCP client to it, and verifies the standard browser tool
 * surface is advertised. Does NOT require the Chrome extension to be
 * installed — tool listing works without an attached browser.
 *
 * Confidence level: medium. Proves: child-process plumbing works, MCP HTTP
 * server is reachable, MCP handshake succeeds, expected tool surface is
 * present. Does NOT prove: actual browser_navigate roundtrip with a real
 * Chrome + Playwright Bridge extension attached (manual operator step
 * until the Mac app installs the extension automatically).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  acquireBridgeMcp,
  startMcpBridgeServer,
  type McpBridgeServer,
} from "../index.js";

const TEST_PORT = 19997;

describe("browser-bridge-mcp smoke", () => {
  let bridge: McpBridgeServer;

  beforeAll(async () => {
    bridge = await startMcpBridgeServer({ port: TEST_PORT, host: "localhost" });
  });

  afterAll(async () => {
    await bridge?.close();
  });

  test("url targets the playwright-mcp server", () => {
    expect(bridge.url).toBe(`http://localhost:${TEST_PORT}`);
  });

  test("HTTP root responds (server is up)", async () => {
    const res = await fetch(bridge.url);
    // playwright-mcp may respond 200, 400, or 404 on bare `/` — any HTTP
    // response means the server is listening. We just don't want
    // ECONNREFUSED here.
    expect(typeof res.status).toBe("number");
  });

  test("MCP client can connect and list browser_* tools", async () => {
    const client = new Client({ name: "lobu-bridge-smoke", version: "0.0.0" }, {});
    const transport = new StreamableHTTPClientTransport(new URL(`${bridge.url}/mcp`));
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(0);

      // Microsoft's playwright-mcp ships standard browser_* tools when run
      // with --extension. Concrete signal that we're talking to the right
      // server, not just a random HTTP service.
      const toolNames = tools.map((t) => t.name);
      expect(toolNames).toContain("browser_navigate");
      expect(toolNames).toContain("browser_click");
      expect(toolNames).toContain("browser_snapshot");
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  test("acquireBridgeMcp wraps the SDK client + advertises browser tools", async () => {
    // Exercise the connector-facing entry point end-to-end against the same
    // server — proves the URL composition (`${bridgeUrl}/mcp`) and the
    // handshake work from the wrapper, not just the bare SDK client.
    const acquired = await acquireBridgeMcp({
      bridgeUrl: bridge.url,
      clientName: "lobu-bridge-smoke-acquire",
    });
    try {
      const { tools } = await acquired.client.listTools();
      expect(tools.map((t) => t.name)).toContain("browser_navigate");
    } finally {
      await acquired.close();
    }
  });
});
