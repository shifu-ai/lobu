import { describe, expect, test } from "bun:test";
import { AsyncLock } from "../utils/lock";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("AsyncLock", () => {
  test("returns the value from the wrapped function", async () => {
    const lock = new AsyncLock("test");
    const result = await lock.acquire(async () => 42);
    expect(result).toBe(42);
  });

  test("serializes concurrent operations (FIFO ordering)", async () => {
    const lock = new AsyncLock("serial");
    const events: string[] = [];

    const op = (label: string, ms: number) =>
      lock.acquire(async () => {
        events.push(`start:${label}`);
        await wait(ms);
        events.push(`end:${label}`);
        return label;
      });

    const [a, b, c] = await Promise.all([op("a", 30), op("b", 10), op("c", 5)]);

    expect([a, b, c]).toEqual(["a", "b", "c"]);
    // Each operation must end before the next one starts
    expect(events).toEqual([
      "start:a",
      "end:a",
      "start:b",
      "end:b",
      "start:c",
      "end:c",
    ]);
  });

  test("releases lock even when wrapped function throws", async () => {
    const lock = new AsyncLock("error-path");

    await expect(
      lock.acquire(async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    // Subsequent acquire should succeed (lock was released)
    const result = await lock.acquire(async () => "after-error");
    expect(result).toBe("after-error");
  });

  test("times out when previous holder runs longer than timeoutMs", async () => {
    const lock = new AsyncLock("timeout-ctx");

    // First operation holds the lock for 200ms
    const slow = lock.acquire(async () => {
      await wait(200);
      return "slow";
    });

    // Second operation should time out after 20ms waiting
    await expect(lock.acquire(async () => "fast", 20)).rejects.toThrow(
      /Lock acquisition timeout after 20ms.*timeout-ctx/
    );

    // Wait for the slow op to finish so the test cleans up
    await slow;
  });

  test("default context appears in timeout message", async () => {
    const lock = new AsyncLock();

    const slow = lock.acquire(async () => {
      await wait(100);
    });

    await expect(lock.acquire(async () => "x", 10)).rejects.toThrow(
      /possible deadlock in unknown/
    );

    await slow;
  });

  test("timeout error from previous slow holder doesn't poison subsequent acquires", async () => {
    const lock = new AsyncLock("recovery");

    const slow = lock.acquire(async () => {
      await wait(80);
      return "slow-done";
    });

    await expect(lock.acquire(async () => "skipped", 5)).rejects.toThrow();

    // After slow finishes, lock should be usable again
    expect(await slow).toBe("slow-done");
    expect(await lock.acquire(async () => "ok")).toBe("ok");
  });

  test("propagates non-Error throws", async () => {
    const lock = new AsyncLock();
    await expect(
      lock.acquire(async () => {
        throw "string-error";
      })
    ).rejects.toBe("string-error");

    // Lock still works after non-Error throw
    expect(await lock.acquire(async () => "recovered")).toBe("recovered");
  });
});
