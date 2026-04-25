import { describe, expect, it } from "bun:test";
import type { ClientSDK } from "../../../sandbox/client-sdk";
import { getDefaultLimits, runScript } from "../../../sandbox/run-script";

describe("runScript", () => {
  it("exposes default resource limits", () => {
    const limits = getDefaultLimits();
    expect(limits.memoryMb).toBe(64);
    expect(limits.timeoutMs).toBe(60_000);
    expect(limits.sdkCallQuota).toBe(200);
    expect(limits.outputBytes).toBe(262_144);
  });

  it("returns structured result shape", async () => {
    const stubSdk = { log: () => undefined } as unknown as ClientSDK;
    const result = await runScript({
      source: "export default async () => 42;",
      sdk: stubSdk,
    });
    expect(result).toHaveProperty("success");
    expect(result).toHaveProperty("logs");
    expect(result).toHaveProperty("durationMs");
    expect(result).toHaveProperty("sdkCalls");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("runs a default-export script and returns its value", async () => {
    const stubSdk = { log: () => undefined } as unknown as ClientSDK;
    const result = await runScript({
      source: "export default async () => 1 + 2;",
      sdk: stubSdk,
    });
    // Skip on environments where the optional native module is unavailable
    // (the runner reports RuntimeUnavailable). Otherwise the bridge must
    // succeed and forward the return value.
    if (result.error?.name === "RuntimeUnavailable") {
      expect(result.success).toBe(false);
      return;
    }
    expect(result.success).toBe(true);
    expect(result.returnValue).toBe(3);
    expect(result.sdkCalls).toBe(0);
  });
});
