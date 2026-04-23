import { describe, expect, test } from "bun:test";
import { MockRedisClient } from "../../../../core/src/__tests__/fixtures/mock-redis.js";
import {
  getClientIp,
  RedisFixedWindowRateLimiter,
} from "../../utils/rate-limiter.js";

describe("RedisFixedWindowRateLimiter", () => {
  test("allows requests within the window and blocks after the limit", async () => {
    const redis = new MockRedisClient();
    const limiter = new RedisFixedWindowRateLimiter(redis);

    const first = await limiter.consume({
      key: "rate:test:1",
      limit: 2,
      windowSeconds: 60,
    });
    const second = await limiter.consume({
      key: "rate:test:1",
      limit: 2,
      windowSeconds: 60,
    });
    const third = await limiter.consume({
      key: "rate:test:1",
      limit: 2,
      windowSeconds: 60,
    });

    expect(first.allowed).toBe(true);
    expect(first.remaining).toBe(1);
    expect(second.allowed).toBe(true);
    expect(second.remaining).toBe(0);
    expect(third.allowed).toBe(false);
    expect(third.retryAfterSeconds).toBeGreaterThan(0);
  });

  test("resets after the time window", async () => {
    const redis = new MockRedisClient();
    const limiter = new RedisFixedWindowRateLimiter(redis);

    await limiter.consume({
      key: "rate:test:2",
      limit: 1,
      windowSeconds: 60,
    });
    const blocked = await limiter.consume({
      key: "rate:test:2",
      limit: 1,
      windowSeconds: 60,
    });
    expect(blocked.allowed).toBe(false);

    redis.advanceTime(61_000);

    const reset = await limiter.consume({
      key: "rate:test:2",
      limit: 1,
      windowSeconds: 60,
    });
    expect(reset.allowed).toBe(true);
    expect(reset.count).toBe(1);
  });

  test("reset clears the tracked key", async () => {
    const redis = new MockRedisClient();
    const limiter = new RedisFixedWindowRateLimiter(redis);

    await limiter.consume({
      key: "rate:test:3",
      limit: 1,
      windowSeconds: 60,
    });
    await limiter.reset("rate:test:3");

    const next = await limiter.consume({
      key: "rate:test:3",
      limit: 1,
      windowSeconds: 60,
    });
    expect(next.allowed).toBe(true);
    expect(next.count).toBe(1);
  });
});

describe("getClientIp", () => {
  test("prefers x-forwarded-for, then x-real-ip, then unknown", () => {
    expect(
      getClientIp({
        forwardedFor: "203.0.113.1, 10.0.0.1",
        realIp: "198.51.100.1",
      })
    ).toBe("203.0.113.1");

    expect(
      getClientIp({
        realIp: "198.51.100.1",
      })
    ).toBe("198.51.100.1");

    expect(getClientIp({})).toBe("unknown");
  });
});
