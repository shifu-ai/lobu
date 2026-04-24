import { describe, expect, test } from "bun:test";
import { MockRedisClient } from "@lobu/core/testing";
import { SystemMessageLimiter } from "../infrastructure/redis/system-message-limiter.js";

describe("SystemMessageLimiter", () => {
  test("sends once and suppresses subsequent sends within TTL", async () => {
    const redis = new MockRedisClient() as any;
    const limiter = new SystemMessageLimiter(redis, "test");

    let sentCount = 0;
    const sendFn = async () => {
      sentCount += 1;
    };

    const first = await limiter.sendOnce("k", sendFn, {
      sentTtlSeconds: 60,
      lockTtlSeconds: 30,
    });
    const second = await limiter.sendOnce("k", sendFn, {
      sentTtlSeconds: 60,
      lockTtlSeconds: 30,
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(sentCount).toBe(1);
  });

  test("suppresses concurrent sends using lock even before sent marker is written", async () => {
    const redis = new MockRedisClient() as any;
    const limiter = new SystemMessageLimiter(redis, "test");

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    let started = 0;
    const sendFn = async () => {
      started += 1;
      await gate;
    };

    const p1 = limiter.sendOnce("k2", sendFn, {
      sentTtlSeconds: 60,
      lockTtlSeconds: 30,
    });
    const p2 = limiter.sendOnce("k2", sendFn, {
      sentTtlSeconds: 60,
      lockTtlSeconds: 30,
    });

    // Ensure both have attempted to run; only one should have entered sendFn.
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toBe(1);

    release();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect([r1, r2].filter(Boolean).length).toBe(1);
  });

  test("does not set sent marker on failure (allows retry)", async () => {
    const redis = new MockRedisClient() as any;
    const limiter = new SystemMessageLimiter(redis, "test");

    let attempts = 0;
    const sendFn = async () => {
      attempts += 1;
      throw new Error("fail");
    };

    await expect(
      limiter.sendOnce("k3", sendFn, {
        sentTtlSeconds: 60,
        lockTtlSeconds: 30,
      })
    ).rejects.toThrow("fail");

    // Next call should try again (not suppressed).
    await expect(
      limiter.sendOnce("k3", sendFn, {
        sentTtlSeconds: 60,
        lockTtlSeconds: 30,
      })
    ).rejects.toThrow("fail");

    expect(attempts).toBe(2);
  });
});
