import http from "node:http";
import { afterEach, describe, expect, test } from "vitest";
import {
  drainHttpServer,
  isShuttingDown,
  parseDurationMs,
  setShuttingDown,
} from "../lifecycle-state.js";

describe("lifecycle-state shutdown flag", () => {
  afterEach(() => setShuttingDown(false));

  test("toggles the draining flag", () => {
    expect(isShuttingDown()).toBe(false);
    setShuttingDown(true);
    expect(isShuttingDown()).toBe(true);
    setShuttingDown(false);
    expect(isShuttingDown()).toBe(false);
  });
});

describe("parseDurationMs", () => {
  test("falls back on absent or invalid values, accepts valid", () => {
    delete process.env.__TEST_DUR__;
    expect(parseDurationMs("__TEST_DUR__", 5000)).toBe(5000);
    process.env.__TEST_DUR__ = "not-a-number";
    expect(parseDurationMs("__TEST_DUR__", 5000)).toBe(5000);
    process.env.__TEST_DUR__ = "-1";
    expect(parseDurationMs("__TEST_DUR__", 5000)).toBe(5000);
    process.env.__TEST_DUR__ = "0";
    expect(parseDurationMs("__TEST_DUR__", 5000)).toBe(0);
    process.env.__TEST_DUR__ = "250";
    expect(parseDurationMs("__TEST_DUR__", 5000)).toBe(250);
    delete process.env.__TEST_DUR__;
  });
});

describe("drainHttpServer", () => {
  let server: http.Server;

  afterEach(async () => {
    if (server?.listening) {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  function listen(s: http.Server): Promise<number> {
    return new Promise((resolve) => {
      s.listen(0, "127.0.0.1", () => {
        resolve((s.address() as { port: number }).port);
      });
    });
  }

  test("closes an idle server promptly and stops accepting connections", async () => {
    server = http.createServer((_req, res) => res.end("ok"));
    const port = await listen(server);

    await drainHttpServer(server, 5000);
    expect(server.listening).toBe(false);

    // New connections are refused after drain.
    await expect(
      new Promise((_resolve, reject) => {
        const req = http.get({ host: "127.0.0.1", port, timeout: 1000 });
        req.on("error", reject);
        req.on("timeout", () => reject(new Error("timeout")));
      })
    ).rejects.toBeDefined();
  });

  test("force-closes lingering connections after the deadline", async () => {
    let forced = 0;
    // Handler never responds → the request is held open past the deadline.
    server = http.createServer(() => {
      /* intentionally no response */
    });
    const port = await listen(server);

    // Open a request and leave it hanging.
    const hanging = http.get({ host: "127.0.0.1", port });
    hanging.on("error", () => {
      /* expected: socket force-closed */
    });
    // Give the connection a tick to establish.
    await new Promise((r) => setTimeout(r, 50));

    const start = Date.now();
    await drainHttpServer(server, 200, () => {
      forced += 1;
    });
    const elapsed = Date.now() - start;

    expect(forced).toBe(1);
    expect(server.listening).toBe(false);
    // Resolved around the deadline, not hung on the open socket.
    expect(elapsed).toBeLessThan(2000);
  });
});
