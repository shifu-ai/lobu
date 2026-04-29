import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  InvalidatableCache,
  type MinimalListenClient,
} from "../invalidatable-cache.js";

/** A fake `pg.Client` we can drive deterministically from the tests. */
class FakeListenClient implements MinimalListenClient {
  private notificationListeners: Array<
    (msg: { channel: string; payload?: string }) => void
  > = [];
  private errorListeners: Array<(err: Error) => void> = [];
  private endListeners: Array<() => void> = [];
  public connected = false;
  public ended = false;
  public listenedChannel: string | null = null;
  public connectError: Error | null = null;

  on(event: string, listener: any): this {
    if (event === "notification") this.notificationListeners.push(listener);
    else if (event === "error") this.errorListeners.push(listener);
    else if (event === "end") this.endListeners.push(listener);
    return this;
  }

  async connect(): Promise<void> {
    if (this.connectError) throw this.connectError;
    this.connected = true;
  }

  async query(sql: string): Promise<unknown> {
    const m = /^LISTEN\s+"([^"]+)"$/.exec(sql);
    if (m) this.listenedChannel = m[1] ?? null;
    return { rows: [] };
  }

  async end(): Promise<void> {
    this.ended = true;
  }

  // Test helpers
  emitNotification(channel: string, payload: string): void {
    for (const l of this.notificationListeners) l({ channel, payload });
  }

  emitError(err: Error): void {
    for (const l of this.errorListeners) l(err);
  }
}

let clients: FakeListenClient[] = [];
function makeClientFactory() {
  return () => {
    const c = new FakeListenClient();
    clients.push(c);
    return c;
  };
}

beforeEach(() => {
  clients = [];
});

afterEach(async () => {
  // No-op; individual tests own their cache lifecycle.
});

describe("InvalidatableCache", () => {
  test("loader is called once on miss; cached on subsequent hits", async () => {
    let calls = 0;
    const cache = new InvalidatableCache<string, number>({
      channel: "test_channel",
      ttlMs: 60_000,
      connectionString: "postgres://fake",
      clientFactory: makeClientFactory(),
      loader: async (k) => {
        calls += 1;
        return k.length;
      },
    });

    expect(await cache.get("hello")).toBe(5);
    expect(await cache.get("hello")).toBe(5);
    expect(await cache.get("hello")).toBe(5);
    expect(calls).toBe(1);
    expect(clients.length).toBe(1);
    expect(clients[0]?.listenedChannel).toBe("test_channel");
    await cache.close();
  });

  test("concurrent misses for the same key share a single loader call", async () => {
    let calls = 0;
    let resolveLoader: ((v: number) => void) | null = null;
    const loaderPromise = new Promise<number>((res) => {
      resolveLoader = res;
    });

    const cache = new InvalidatableCache<string, number>({
      channel: "concurrent_test",
      ttlMs: 60_000,
      connectionString: "postgres://fake",
      clientFactory: makeClientFactory(),
      loader: async () => {
        calls += 1;
        return loaderPromise;
      },
    });

    const a = cache.get("k");
    const b = cache.get("k");
    const c = cache.get("k");
    resolveLoader?.(42);
    const [va, vb, vc] = await Promise.all([a, b, c]);
    expect(va).toBe(42);
    expect(vb).toBe(42);
    expect(vc).toBe(42);
    expect(calls).toBe(1);
    await cache.close();
  });

  test("TTL expiry forces a reload", async () => {
    let calls = 0;
    const cache = new InvalidatableCache<string, number>({
      channel: "ttl_test",
      ttlMs: 1, // 1ms TTL
      connectionString: "postgres://fake",
      clientFactory: makeClientFactory(),
      loader: async () => {
        calls += 1;
        return calls;
      },
    });

    expect(await cache.get("k")).toBe(1);
    await new Promise((r) => setTimeout(r, 5));
    expect(await cache.get("k")).toBe(2);
    expect(calls).toBe(2);
    await cache.close();
  });

  test("NOTIFY for a specific key invalidates only that key", async () => {
    let calls = 0;
    const cache = new InvalidatableCache<string, number>({
      channel: "notify_key",
      ttlMs: 60_000,
      connectionString: "postgres://fake",
      clientFactory: makeClientFactory(),
      loader: async () => ++calls,
    });

    await cache.get("a");
    await cache.get("b");
    expect(cache.size()).toBe(2);
    expect(calls).toBe(2);

    cache._notifyForTest("a");
    expect(cache.size()).toBe(1);

    await cache.get("a");
    expect(calls).toBe(3); // a was reloaded
    await cache.get("b");
    expect(calls).toBe(3); // b stayed cached
    await cache.close();
  });

  test("NOTIFY with empty payload clears the entire cache", async () => {
    const cache = new InvalidatableCache<string, number>({
      channel: "notify_all",
      ttlMs: 60_000,
      connectionString: "postgres://fake",
      clientFactory: makeClientFactory(),
      loader: async () => 1,
    });

    await cache.get("a");
    await cache.get("b");
    await cache.get("c");
    expect(cache.size()).toBe(3);

    cache._notifyForTest("");
    expect(cache.size()).toBe(0);

    cache._notifyForTest("a"); // no-op on empty cache
    expect(cache.size()).toBe(0);
    await cache.close();
  });

  test("NOTIFY with '*' payload clears the entire cache", async () => {
    const cache = new InvalidatableCache<string, number>({
      channel: "notify_star",
      ttlMs: 60_000,
      connectionString: "postgres://fake",
      clientFactory: makeClientFactory(),
      loader: async () => 1,
    });

    await cache.get("a");
    await cache.get("b");
    expect(cache.size()).toBe(2);
    cache._notifyForTest("*");
    expect(cache.size()).toBe(0);
    await cache.close();
  });

  test("invalidate(key) drops a single entry", async () => {
    let calls = 0;
    const cache = new InvalidatableCache<string, number>({
      channel: "invalidate_one",
      ttlMs: 60_000,
      connectionString: "postgres://fake",
      clientFactory: makeClientFactory(),
      loader: async () => ++calls,
    });

    await cache.get("a");
    cache.invalidate("a");
    await cache.get("a");
    expect(calls).toBe(2);
    await cache.close();
  });

  test("invalidateAll() drops the whole cache", async () => {
    const cache = new InvalidatableCache<string, number>({
      channel: "invalidate_all",
      ttlMs: 60_000,
      connectionString: "postgres://fake",
      clientFactory: makeClientFactory(),
      loader: async () => 1,
    });

    await cache.get("a");
    await cache.get("b");
    expect(cache.size()).toBe(2);
    cache.invalidateAll();
    expect(cache.size()).toBe(0);
    await cache.close();
  });

  test("LRU evicts the oldest entry past maxEntries", async () => {
    let counter = 0;
    const cache = new InvalidatableCache<string, number>({
      channel: "lru_test",
      ttlMs: 60_000,
      maxEntries: 2,
      connectionString: "postgres://fake",
      clientFactory: makeClientFactory(),
      loader: async () => ++counter,
    });

    await cache.get("a"); // 1
    await cache.get("b"); // 2
    await cache.get("c"); // 3 → evicts a
    expect(cache.size()).toBe(2);

    // a should now be reloaded; b should be evicted (older than c)
    await cache.get("a"); // reloads → 4, evicts b
    expect(counter).toBe(4);

    await cache.get("c"); // still cached → no new call
    expect(counter).toBe(4);

    // b was evicted in the previous step → reloads
    await cache.get("b"); // 5
    expect(counter).toBe(5);
    await cache.close();
  });

  test("reconnect bumps generation and clears the cache", async () => {
    const cache = new InvalidatableCache<string, number>({
      channel: "reconnect_test",
      ttlMs: 60_000,
      reconnectDelayMs: 5,
      connectionString: "postgres://fake",
      clientFactory: makeClientFactory(),
      loader: async (k) => k.length,
    });

    await cache.get("hi");
    expect(cache.size()).toBe(1);
    expect(cache.getGeneration()).toBe(0);

    const firstClient = clients[0];
    expect(firstClient).toBeDefined();
    firstClient?.emitError(new Error("boom"));

    // Sync state immediately after the error: cache cleared, gen bumped.
    expect(cache.size()).toBe(0);
    expect(cache.getGeneration()).toBe(1);

    // Allow the reconnect timer to fire.
    await new Promise((r) => setTimeout(r, 30));
    expect(clients.length).toBeGreaterThanOrEqual(2);
    expect(clients[clients.length - 1]?.listenedChannel).toBe("reconnect_test");

    // After reconnect, get() should reload.
    await cache.get("hi");
    expect(cache.size()).toBe(1);
    await cache.close();
  });

  test("close() prevents further get() calls", async () => {
    const cache = new InvalidatableCache<string, number>({
      channel: "close_test",
      ttlMs: 60_000,
      connectionString: "postgres://fake",
      clientFactory: makeClientFactory(),
      loader: async () => 1,
    });

    await cache.get("a");
    await cache.close();
    await expect(cache.get("a")).rejects.toThrow(/closed/);
  });

  test("rejects channel names with invalid characters", () => {
    expect(
      () =>
        new InvalidatableCache({
          channel: "has-dashes",
          ttlMs: 1,
          loader: async () => 1,
        })
    ).toThrow(/match/);

    expect(
      () =>
        new InvalidatableCache({
          channel: 'has"quote',
          ttlMs: 1,
          loader: async () => 1,
        })
    ).toThrow(/match/);

    expect(
      () =>
        new InvalidatableCache({
          channel: "",
          ttlMs: 1,
          loader: async () => 1,
        })
    ).toThrow(/empty/);
  });

  test("notifications on other channels are ignored", async () => {
    let calls = 0;
    const cache = new InvalidatableCache<string, number>({
      channel: "right_channel",
      ttlMs: 60_000,
      connectionString: "postgres://fake",
      clientFactory: makeClientFactory(),
      loader: async () => ++calls,
    });

    await cache.get("a");
    expect(cache.size()).toBe(1);

    // Pretend pg sent us a notification for an unrelated channel.
    clients[0]?.emitNotification("other_channel", "a");
    expect(cache.size()).toBe(1); // untouched

    clients[0]?.emitNotification("right_channel", "a");
    expect(cache.size()).toBe(0);
    await cache.close();
  });

  test("loader rejection does not poison the cache", async () => {
    let calls = 0;
    const cache = new InvalidatableCache<string, number>({
      channel: "loader_reject",
      ttlMs: 60_000,
      connectionString: "postgres://fake",
      clientFactory: makeClientFactory(),
      loader: async () => {
        calls += 1;
        if (calls === 1) throw new Error("boom");
        return 7;
      },
    });

    await expect(cache.get("k")).rejects.toThrow("boom");
    // Subsequent call should retry the loader.
    expect(await cache.get("k")).toBe(7);
    expect(calls).toBe(2);
    await cache.close();
  });

  test("keyToString controls the cache key", async () => {
    let calls = 0;
    const cache = new InvalidatableCache<{ id: string }, number>({
      channel: "key_to_string",
      ttlMs: 60_000,
      connectionString: "postgres://fake",
      clientFactory: makeClientFactory(),
      keyToString: (k) => k.id,
      loader: async () => ++calls,
    });

    await cache.get({ id: "abc" });
    await cache.get({ id: "abc" }); // same id, different object
    expect(calls).toBe(1);

    cache._notifyForTest("abc");
    await cache.get({ id: "abc" });
    expect(calls).toBe(2);
    await cache.close();
  });
});
