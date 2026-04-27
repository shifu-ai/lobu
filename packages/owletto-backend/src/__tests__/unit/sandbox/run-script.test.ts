import { describe, expect, it } from "bun:test";
import type { ClientSDK } from "../../../sandbox/client-sdk";
import { getDefaultLimits, runScript } from "../../../sandbox/run-script";

function skipIfRuntimeUnavailable(
  result: Awaited<ReturnType<typeof runScript>>,
): boolean {
  if (result.error?.name !== "RuntimeUnavailable") return false;
  expect(result.success).toBe(false);
  return true;
}

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
    if (skipIfRuntimeUnavailable(result)) return;
    expect(result.success).toBe(true);
    expect(result.returnValue).toBe(3);
    expect(result.sdkCalls).toBe(0);
  });

  it("supports direct client.org(slug).namespace.method() chaining", async () => {
    const orgSdk = {
      entities: {
        get: async () => ({ org: "atlas", id: 123 }),
      },
      org: async () => {
        throw new Error("nested org not expected");
      },
      query: async () => [],
      log: () => undefined,
    } as unknown as ClientSDK;
    const stubSdk = {
      org: async (slug: string) => {
        expect(slug).toBe("atlas");
        return orgSdk;
      },
      query: async () => [],
      log: () => undefined,
    } as unknown as ClientSDK;

    const result = await runScript({
      source:
        'export default async (_ctx, client) => client.org("atlas").entities.get({ id: 123 });',
      sdk: stubSdk,
    });

    if (skipIfRuntimeUnavailable(result)) return;
    expect(result.success).toBe(true);
    expect(result.returnValue).toEqual({ org: "atlas", id: 123 });
    expect(result.sdkCalls).toBe(1);
  });

  it("enforces wall-clock timeout while awaiting SDK calls", async () => {
    const stubSdk = {
      entities: {
        list: async () =>
          new Promise((resolve) => setTimeout(() => resolve([]), 200)),
      },
      log: () => undefined,
    } as unknown as ClientSDK;

    const result = await runScript({
      source:
        "export default async (_ctx, client) => client.entities.list({ limit: 1 });",
      sdk: stubSdk,
      limits: { timeoutMs: 25 },
    });

    if (skipIfRuntimeUnavailable(result)) return;
    expect(result.success).toBe(false);
    expect(result.error?.name).toBe("TimeoutError");
    expect(result.sdkCalls).toBe(1);
  });
});
