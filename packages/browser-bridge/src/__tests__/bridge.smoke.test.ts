/**
 * Spike-level wire test for @lobu/browser-bridge.
 *
 * Confidence level: medium-low. Asserts that startBridgeServer hands back a
 * URL of the right shape for the underlying relay (path = /cdp, token in
 * query string, NOT in headers), that the /cdp route exists and gates on
 * the token when configured, and that the relay can be cleanly torn down.
 *
 * What this does NOT cover: actual chromium.connectOverCDP roundtrip,
 * extension attach via chrome.debugger, Target.* shim correctness, default
 * context delivery, real tab control. Those need a real Chrome with the
 * playwriter extension loaded — manual operator step documented in the
 * package README until a desktop-bridge e2e harness exists.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startBridgeServer, type BridgeServer } from "../index.js";

const TEST_PORT_NOAUTH = 19989;
const TEST_PORT_AUTH = 19990;
const TEST_TOKEN = "spike-test-token-not-a-real-secret";

describe("browser-bridge smoke (no token)", () => {
  let bridge: BridgeServer;

  beforeAll(async () => {
    bridge = await startBridgeServer({ port: TEST_PORT_NOAUTH, host: "127.0.0.1" });
  });

  afterAll(() => {
    bridge?.close();
  });

  test("url targets the /cdp route, not the server root", () => {
    expect(bridge.url).toBe(`ws://127.0.0.1:${TEST_PORT_NOAUTH}/cdp`);
  });

  test("url omits the token query when no token is configured", () => {
    expect(bridge.url).not.toContain("token=");
  });

  test("/json/version returns a CDP endpoint pointing at /cdp", async () => {
    // Sanity check that the relay's discovery endpoint hands out a URL
    // matching what we expose as bridge.url. If these diverge in a future
    // playwriter release, callers using bridge.url stay safe but the
    // divergence is worth surfacing.
    const res = await fetch(`http://127.0.0.1:${TEST_PORT_NOAUTH}/json/version`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { webSocketDebuggerUrl?: string };
    expect(body.webSocketDebuggerUrl).toMatch(/^ws:\/\/.+\/cdp$/);
  });
});

describe("browser-bridge smoke (with token)", () => {
  let bridge: BridgeServer;

  beforeAll(async () => {
    bridge = await startBridgeServer({
      port: TEST_PORT_AUTH,
      host: "127.0.0.1",
      token: TEST_TOKEN,
    });
  });

  afterAll(() => {
    bridge?.close();
  });

  test("url embeds the token in the query string", () => {
    expect(bridge.url).toBe(
      `ws://127.0.0.1:${TEST_PORT_AUTH}/cdp?token=${encodeURIComponent(TEST_TOKEN)}`
    );
  });

  test("/cdp WS upgrade is rejected without a matching token", async () => {
    // The /cdp route checks ?token=... on WS upgrade. We trigger the route
    // via a plain HTTP GET — playwriter's middleware short-circuits on
    // bad token BEFORE attempting upgrade, so we see a 401. This proves
    // the auth gate is wired; it does NOT prove the WS itself works.
    const res = await fetch(`http://127.0.0.1:${TEST_PORT_AUTH}/cdp`);
    expect(res.status).toBe(401);
  });

  test("/cdp accepts requests with the correct token", async () => {
    const res = await fetch(
      `http://127.0.0.1:${TEST_PORT_AUTH}/cdp?token=${encodeURIComponent(TEST_TOKEN)}`
    );
    // Auth passes; the request is then a normal GET (not a WS upgrade) so
    // Hono / @hono/node-ws responds with something other than 401.
    expect(res.status).not.toBe(401);
  });
});
