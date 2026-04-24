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

  it("fails with RuntimeUnavailable or NotImplemented", async () => {
    // PR-1 ships the scaffolding only; the runner either reports the optional
    // native module missing, or a clear NotImplemented stub. PR-2 replaces the
    // stub with the real isolated-vm bridge.
    const stubSdk = { log: () => undefined } as unknown as ClientSDK;
    const result = await runScript({
      source: "export default async () => 1;",
      sdk: stubSdk,
    });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(["RuntimeUnavailable", "NotImplemented"]).toContain(
      result.error?.name ?? ""
    );
  });
});
