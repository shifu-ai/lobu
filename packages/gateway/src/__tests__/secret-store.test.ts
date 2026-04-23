import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { MockRedisClient } from "@lobu/core/testing";
import type { SecretRef } from "@lobu/core";
import {
  deleteSecretsByPrefix,
  RedisSecretStore,
  SecretStoreRegistry,
  type SecretListEntry,
  type SecretPutOptions,
  type SecretStore,
  type WritableSecretStore,
} from "../secrets/index.js";

const TEST_ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("RedisSecretStore", () => {
  let originalEncryptionKey: string | undefined;
  let redis: MockRedisClient;
  let store: RedisSecretStore;

  beforeAll(() => {
    originalEncryptionKey = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
  });

  afterAll(() => {
    if (originalEncryptionKey !== undefined) {
      process.env.ENCRYPTION_KEY = originalEncryptionKey;
    } else {
      delete process.env.ENCRYPTION_KEY;
    }
  });

  beforeEach(() => {
    redis = new MockRedisClient();
    store = new RedisSecretStore(redis as any, "lobu:test:secrets:");
  });

  test("round-trips encrypted values", async () => {
    const ref = await store.put("agents/a/openai", "sk-test-secret");
    expect(ref).toBe("secret://agents%2Fa%2Fopenai");
    expect(await store.get(ref)).toBe("sk-test-secret");
  });

  test("stores ciphertext under the configured prefix", async () => {
    await store.put("agents/a/openai", "sk-test-secret");
    const [, keys] = await redis.scan("0", "MATCH", "lobu:test:secrets:*");
    expect(keys).toHaveLength(1);
    expect(keys[0]!.startsWith("lobu:test:secrets:")).toBe(true);

    const raw = await redis.get(keys[0]!);
    expect(raw).not.toBeNull();
    expect(raw).not.toContain("sk-test-secret");
  });

  test("lists refs by logical prefix", async () => {
    await store.put("system-env/OPENAI_API_KEY", "value-1");
    await store.put("agents/a/openai", "value-2");

    const entries = await store.list("system-env/");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe("system-env/OPENAI_API_KEY");
    expect(entries[0]?.backend).toBe("redis");
  });

  test("requires ENCRYPTION_KEY", async () => {
    delete process.env.ENCRYPTION_KEY;
    try {
      await expect(
        store.put("agents/a/openai", "sk-test-secret")
      ).rejects.toThrow("ENCRYPTION_KEY");
    } finally {
      process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    }
  });
});

describe("deleteSecretsByPrefix", () => {
  let originalEncryptionKey: string | undefined;
  let redis: MockRedisClient;
  let store: RedisSecretStore;

  beforeAll(() => {
    originalEncryptionKey = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
  });

  afterAll(() => {
    if (originalEncryptionKey !== undefined) {
      process.env.ENCRYPTION_KEY = originalEncryptionKey;
    } else {
      delete process.env.ENCRYPTION_KEY;
    }
  });

  beforeEach(() => {
    redis = new MockRedisClient();
    store = new RedisSecretStore(redis as any, "lobu:test:secrets:");
  });

  test("deletes every secret whose name matches the prefix", async () => {
    await store.put("agents/a/auth-profiles/p1/credential", "c1");
    await store.put("agents/a/auth-profiles/p1/refresh-token", "r1");
    await store.put("agents/b/auth-profiles/p2/credential", "c2");

    const removed = await deleteSecretsByPrefix(store, "agents/a/");

    expect(removed).toBe(2);
    expect(await store.list("agents/a/")).toHaveLength(0);
    expect(await store.list("agents/b/")).toHaveLength(1);
  });
});

describe("SecretStoreRegistry caching", () => {
  let originalEncryptionKey: string | undefined;
  let redis: MockRedisClient;
  let backing: RedisSecretStore;
  let registry: SecretStoreRegistry;

  beforeAll(() => {
    originalEncryptionKey = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
  });

  afterAll(() => {
    if (originalEncryptionKey !== undefined) {
      process.env.ENCRYPTION_KEY = originalEncryptionKey;
    } else {
      delete process.env.ENCRYPTION_KEY;
    }
  });

  beforeEach(() => {
    redis = new MockRedisClient();
    backing = new RedisSecretStore(redis as any, "lobu:test:secrets:");
    registry = new SecretStoreRegistry(backing, { secret: backing });
  });

  test("serves repeated reads from cache without hitting the backing store", async () => {
    const ref = await registry.put("agents/a/key", "hello");

    // First read populates the cache.
    expect(await registry.get(ref)).toBe("hello");

    // Drop the row directly in Redis to prove the next read comes from cache.
    const [, keys] = await redis.scan("0", "MATCH", "lobu:test:secrets:*");
    for (const key of keys) {
      await redis.del(key);
    }
    expect(await registry.get(ref)).toBe("hello");
  });

  test("put invalidates the cached entry for the same ref", async () => {
    const ref = await registry.put("agents/a/key", "hello");
    expect(await registry.get(ref)).toBe("hello");

    await registry.put("agents/a/key", "world");
    expect(await registry.get(ref)).toBe("world");
  });

  test("delete invalidates the cached entry", async () => {
    const ref = await registry.put("agents/a/key", "hello");
    expect(await registry.get(ref)).toBe("hello");

    await registry.delete(ref);
    expect(await registry.get(ref)).toBeNull();
  });

  test("delete(name) invalidates cache entries keyed by ref", async () => {
    // A caller that cached under the ref form should see the value
    // disappear even when the deletion is issued with the plain name.
    const name = "agents/a/key";
    const ref = await registry.put(name, "hello");

    // Warm the cache via the ref form.
    expect(await registry.get(ref)).toBe("hello");
    expect(await registry.get(ref)).toBe("hello");

    // Delete by name — the cached ref entry must be dropped, not served
    // stale until TTL.
    await registry.delete(name);
    expect(await registry.get(ref)).toBeNull();
  });
});

/**
 * In-memory writable store for multi-backend routing tests. Issues refs
 * under an arbitrary custom scheme so the registry has to route by
 * scheme rather than defaulting everything to the Redis backend.
 */
class InMemoryWritableStore implements WritableSecretStore {
  private readonly entries = new Map<
    string,
    { value: string; updatedAt: number }
  >();

  constructor(
    private readonly scheme: string,
    private readonly backendLabel: string
  ) {}

  async get(ref: SecretRef): Promise<string | null> {
    if (!ref.startsWith(`${this.scheme}://`)) return null;
    const name = decodeURIComponent(ref.slice(`${this.scheme}://`.length));
    return this.entries.get(name)?.value ?? null;
  }

  async put(
    name: string,
    value: string,
    _options?: SecretPutOptions
  ): Promise<SecretRef> {
    this.entries.set(name, { value, updatedAt: Date.now() });
    return `${this.scheme}://${encodeURIComponent(name)}` as SecretRef;
  }

  async delete(nameOrRef: string): Promise<void> {
    let name = nameOrRef;
    if (nameOrRef.startsWith(`${this.scheme}://`)) {
      name = decodeURIComponent(nameOrRef.slice(`${this.scheme}://`.length));
    }
    this.entries.delete(name);
  }

  async list(prefix?: string): Promise<SecretListEntry[]> {
    const results: SecretListEntry[] = [];
    for (const [name, entry] of this.entries) {
      if (prefix && !name.startsWith(prefix)) continue;
      results.push({
        ref: `${this.scheme}://${encodeURIComponent(name)}` as SecretRef,
        backend: this.backendLabel,
        name,
        updatedAt: entry.updatedAt,
      });
    }
    return results;
  }

  size(): number {
    return this.entries.size;
  }
}

class ReadOnlyAwsStub implements SecretStore {
  async get(_ref: SecretRef): Promise<string | null> {
    return null;
  }
}

describe("SecretStoreRegistry multi-backend routing", () => {
  let originalEncryptionKey: string | undefined;
  let redis: MockRedisClient;

  beforeAll(() => {
    originalEncryptionKey = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
  });

  afterAll(() => {
    if (originalEncryptionKey !== undefined) {
      process.env.ENCRYPTION_KEY = originalEncryptionKey;
    } else {
      delete process.env.ENCRYPTION_KEY;
    }
  });

  beforeEach(() => {
    redis = new MockRedisClient();
  });

  test("deleteSecretsByPrefix cascades across every writable backend", async () => {
    const defaultStore = new RedisSecretStore(
      redis as any,
      "lobu:test:secrets:"
    );
    const customStore = new InMemoryWritableStore("custom", "in-memory");

    const registry = new SecretStoreRegistry(defaultStore, {
      secret: defaultStore,
      custom: customStore,
    });

    // Seed entries in both backends under a shared logical prefix.
    await registry.put("agents/a/openai", "sk-default");
    await customStore.put("agents/a/alt", "sk-custom");

    const listed = await registry.list("agents/a/");
    // Both backends should contribute to the merged list.
    expect(listed.map((e) => e.backend).sort()).toEqual(["in-memory", "redis"]);

    // Cascade delete — should hit both backends via per-scheme routing.
    const removed = await deleteSecretsByPrefix(registry, "agents/a/");
    expect(removed).toBe(2);
    expect(await registry.list("agents/a/")).toHaveLength(0);
    expect(customStore.size()).toBe(0);
  });

  test("delete() is a no-op (warns) for read-only backends", async () => {
    const defaultStore = new RedisSecretStore(
      redis as any,
      "lobu:test:secrets:"
    );
    const registry = new SecretStoreRegistry(
      defaultStore,
      { secret: defaultStore },
      { readOnlyStores: { "aws-sm": new ReadOnlyAwsStub() } }
    );

    // Must not throw even though aws-sm has no `delete`.
    await registry.delete("aws-sm://foo");
    // And the writable backend must still be usable afterwards.
    const ref = await registry.put("agents/a/key", "hello");
    expect(await registry.get(ref)).toBe("hello");
  });
});
