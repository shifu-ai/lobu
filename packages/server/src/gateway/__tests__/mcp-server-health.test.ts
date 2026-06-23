import { describe, expect, test } from "bun:test";
import { McpServerHealth } from "../auth/mcp/server-health.js";

describe("McpServerHealth", () => {
  test("pauses after three failures and clears on success", () => {
    const health = new McpServerHealth();
    const key = "agent1:test-mcp";

    expect(health.recordFailure(key, "boom 1", 1000)).toEqual({
      failures: 1,
      lastError: "boom 1",
    });
    expect(health.getPause(key, 1000)).toBeNull();

    expect(health.recordFailure(key, "boom 2", 1000)).toEqual({
      failures: 2,
      lastError: "boom 2",
    });
    expect(health.getPause(key, 1000)).toBeNull();

    expect(health.recordFailure(key, "boom 3", 1000)).toEqual({
      failures: 3,
      lastError: "boom 3",
      pausedUntil: 31_000,
    });
    expect(health.getPause(key, 1000)).toEqual({
      pausedUntil: 31_000,
      lastError: "boom 3",
    });

    health.recordSuccess(key);
    expect(health.getPause(key, 1000)).toBeNull();
  });

  test("does not count OAuth or approval HTTP statuses as broken server failures", () => {
    const health = new McpServerHealth();
    const key = "agent1:auth-mcp";

    health.recordFailure(key, "oauth required", 1000, 401);
    health.recordFailure(key, "approval required", 1000, 403);

    expect(health.getPause(key, 1000)).toBeNull();
    expect(health.recordFailure(key, "boom 1", 1000)).toEqual({
      failures: 1,
      lastError: "boom 1",
    });
  });

  test("doubles pause backoff up to five minutes", () => {
    const health = new McpServerHealth();
    const key = "agent1:flaky-mcp";

    health.recordFailure(key, "boom 1", 1000);
    health.recordFailure(key, "boom 2", 1000);
    expect(health.recordFailure(key, "boom 3", 1000).pausedUntil).toBe(31_000);

    expect(health.recordFailure(key, "boom 4", 40_000).pausedUntil).toBe(
      100_000
    );

    expect(health.recordFailure(key, "boom 5", 200_000).pausedUntil).toBe(
      320_000
    );

    expect(health.recordFailure(key, "boom 6", 600_000).pausedUntil).toBe(
      840_000
    );
    expect(health.recordFailure(key, "boom 7", 1_000_000).pausedUntil).toBe(
      1_300_000
    );
  });
});
