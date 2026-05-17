/**
 * Spike-level wire test for @lobu/browser-bridge.
 *
 * Proves the relay boots, listens on a loopback port, and accepts the CDP
 * discovery handshake that `chromium.connectOverCDP` performs as its first
 * step (a GET to `/json/version`). Does NOT exercise an actual extension
 * attach — that requires Chrome + the playwriter extension loaded, which
 * is out of scope for an automated smoke test.
 *
 * Confidence level: medium. "Server starts, exposes the well-known CDP
 * discovery endpoint, can be cleanly torn down." Enough to prove the
 * package wires up, not enough to prove the full end-to-end shim works.
 * End-to-end validation needs manual Chrome + extension testing per the
 * spike PR notes.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startBridgeServer, type BridgeServer } from "../index.js";

const TEST_PORT = 19989; // off the playwriter default to avoid collisions

describe("browser-bridge smoke", () => {
  let bridge: BridgeServer;

  beforeAll(async () => {
    bridge = await startBridgeServer({ port: TEST_PORT, host: "127.0.0.1" });
  });

  afterAll(() => {
    bridge?.close();
  });

  test("exposes a ws:// loopback url", () => {
    expect(bridge.url).toBe(`ws://127.0.0.1:${TEST_PORT}`);
  });

  test("answers the CDP discovery probe with a Browser endpoint", async () => {
    // `chromium.connectOverCDP("ws://host:port")` first hits
    // `http://host:port/json/version` to learn the browser-level WebSocket
    // URL. If this 404s, connectOverCDP fails before the shim ever runs.
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/json/version`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { webSocketDebuggerUrl?: string };
    expect(typeof body.webSocketDebuggerUrl).toBe("string");
    expect(body.webSocketDebuggerUrl).toMatch(/^ws:\/\//);
  });

  test("rejects /json/version on a wrong path (no silent allow-all)", async () => {
    const res = await fetch(
      `http://127.0.0.1:${TEST_PORT}/definitely-not-a-cdp-route`
    );
    // Anything other than a 200 with a Browser endpoint is acceptable —
    // we just don't want the server happily echoing anything back.
    expect(res.status).not.toBe(200);
  });
});
