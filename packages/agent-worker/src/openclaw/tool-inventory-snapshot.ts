import { createHash } from "node:crypto";
import type { McpToolDef } from "@lobu/core";
import {
  clearToolRouterCacheNamespace,
  releaseToolRouterCacheEntry,
  retainToolRouterCacheEntry,
  touchToolRouterCacheEntry,
  serializeToolRouterCacheContext,
  type ToolRouterCacheContext,
} from "./tool-router-memory-budget";
import { assertWellFormedUnicode } from "./well-formed-unicode";

const SNAPSHOT_SCHEMA_VERSION = 1;
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const CACHE_NAMESPACE = "inventory-snapshot";
const SERIALIZED_MEMORY_MULTIPLIER = 4;

interface CachedToolInventorySnapshot {
  serialized: string;
  snapshot: Record<string, McpToolDef[]>;
  estimatedBytes: number;
}

const snapshotCache = new Map<string, CachedToolInventorySnapshot>();
let snapshotCacheBytes = 0;
let snapshotCacheHits = 0;
let snapshotCacheMisses = 0;
let snapshotCacheEvictions = 0;
let immutableInventoryReuses = 0;
const deeplyImmutableJsonValues = new WeakSet<object>();

function assertJsonLike(
  value: unknown,
  active = new WeakSet<object>(),
  validated = new WeakSet<object>(),
  budget = { nodes: 0 }
): void {
  budget.nodes++;
  if (budget.nodes > 100_000) {
    throw new TypeError("tool inventory exceeds 100000 JSON nodes");
  }
  if (value === null) return;
  if (value === undefined) {
    throw new TypeError("non-JSON tool inventory value: undefined");
  }
  if (typeof value === "string") {
    assertWellFormedUnicode(value);
    return;
  }
  if (typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new TypeError("non-JSON tool inventory value: non-finite number");
  }
  if (typeof value !== "object") {
    throw new TypeError(`non-JSON tool inventory value: ${typeof value}`);
  }
  if (validated.has(value)) return;
  if (active.has(value)) {
    throw new TypeError("cyclic tool inventory value");
  }
  const prototype = Object.getPrototypeOf(value);
  if (
    !Array.isArray(value) &&
    prototype !== Object.prototype &&
    prototype !== null
  ) {
    throw new TypeError("non-JSON tool inventory value: custom prototype");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError("non-JSON tool inventory value: symbol key");
  }
  active.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Object.keys(descriptors)) assertWellFormedUnicode(key);
  if (Array.isArray(value)) {
    if (value.length > 100_000) {
      throw new TypeError(
        "non-JSON tool inventory array exceeds 100000 entries"
      );
    }
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) {
        throw new TypeError("non-JSON tool inventory value: sparse array");
      }
    }
    const namedKeys = Object.keys(descriptors).filter((key) => {
      if (key === "length") return false;
      const index = Number(key);
      return (
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index >= value.length ||
        String(index) !== key
      );
    });
    if (namedKeys.length > 0) {
      throw new TypeError(
        "non-JSON tool inventory value: named array property"
      );
    }
  }
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (Array.isArray(value) && key === "length") continue;
    if (descriptor.get || descriptor.set) {
      throw new TypeError("non-JSON tool inventory value: accessor property");
    }
    if (!descriptor.enumerable) {
      throw new TypeError(
        "non-JSON tool inventory value: non-enumerable property"
      );
    }
    assertJsonLike(descriptor.value, active, validated, budget);
  }
  active.delete(value);
  validated.add(value);
}

function isDeeplyImmutableJsonLike(
  value: unknown,
  visited = new WeakSet<object>()
): boolean {
  if (value === null || typeof value !== "object") return true;
  if (deeplyImmutableJsonValues.has(value)) return true;
  if (visited.has(value)) return true;
  if (!Object.isFrozen(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (
    !Array.isArray(value) &&
    prototype !== Object.prototype &&
    prototype !== null
  ) {
    return false;
  }
  visited.add(value);
  for (const nested of Object.values(value)) {
    if (!isDeeplyImmutableJsonLike(nested, visited)) return false;
  }
  deeplyImmutableJsonValues.add(value);
  return true;
}

function cloneAndFreezeJsonLikeInternal<T>(
  value: T,
  seen: WeakMap<object, unknown>
): T {
  if (value === null || typeof value !== "object") return value;
  const source = value as object;
  const existing = seen.get(source);
  if (existing) return existing as T;

  const clone: unknown[] | Record<string, unknown> = Array.isArray(value)
    ? []
    : {};
  seen.set(source, clone);
  for (const [key, nestedValue] of Object.entries(source)) {
    Object.defineProperty(clone, key, {
      value: cloneAndFreezeJsonLikeInternal(nestedValue, seen),
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return Object.freeze(clone) as T;
}

export function cloneAndFreezeJsonLike<T>(value: T): T {
  assertJsonLike(value);
  return cloneAndFreezeJsonLikeInternal(value, new WeakMap());
}

function freezeInventory(
  toolsByMcp: Record<string, McpToolDef[]>
): Record<string, McpToolDef[]> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(toolsByMcp).map(([mcpId, tools]) => [
        mcpId,
        Object.freeze(tools.map((tool) => cloneAndFreezeJsonLike(tool))),
      ])
    )
  ) as Record<string, McpToolDef[]>;
}

function serializeInventory(
  toolsByMcp: Record<string, McpToolDef[]>
): string | null {
  try {
    return JSON.stringify({
      version: SNAPSHOT_SCHEMA_VERSION,
      inventory: toolsByMcp,
    });
  } catch {
    return null;
  }
}

function snapshotCacheKey(serialized: string): string {
  return createHash("sha256").update(serialized).digest("hex");
}

export function snapshotToolsByMcp(
  toolsByMcp: Record<string, McpToolDef[]>,
  options: { cacheContext?: ToolRouterCacheContext } = {}
): Record<string, McpToolDef[]> {
  assertJsonLike(toolsByMcp);
  if (!options.cacheContext && isDeeplyImmutableJsonLike(toolsByMcp)) {
    immutableInventoryReuses++;
    return toolsByMcp;
  }
  const serialized = serializeInventory(toolsByMcp);
  if (serialized === null) {
    throw new TypeError("non-JSON tool inventory value: serialization failed");
  }
  const context = options.cacheContext;
  const contextSerialized = context
    ? serializeToolRouterCacheContext(context)
    : "";
  const cacheKey = snapshotCacheKey(`${serialized}\u0000${contextSerialized}`);
  const cached = snapshotCache.get(cacheKey);
  if (
    cached?.serialized === serialized &&
    touchToolRouterCacheEntry(CACHE_NAMESPACE, cacheKey)
  ) {
    snapshotCache.delete(cacheKey);
    snapshotCache.set(cacheKey, cached);
    snapshotCacheHits++;
    return cached.snapshot;
  }

  snapshotCacheMisses++;
  const snapshot = freezeInventory(toolsByMcp);
  const estimatedBytes =
    Buffer.byteLength(serialized, "utf8") * SERIALIZED_MEMORY_MULTIPLIER;
  if (estimatedBytes > MAX_SNAPSHOT_BYTES) return snapshot;

  if (cached && snapshotCache.get(cacheKey) === cached) {
    snapshotCache.delete(cacheKey);
    snapshotCacheBytes -= cached.estimatedBytes;
    releaseToolRouterCacheEntry(CACHE_NAMESPACE, cacheKey);
  }
  const retained = retainToolRouterCacheEntry({
    namespace: CACHE_NAMESPACE,
    key: cacheKey,
    estimatedBytes,
    ...(context ? { expiresAtMs: Date.parse(context.snapshotExpiresAt) } : {}),
    onEvict: () => {
      const evicted = snapshotCache.get(cacheKey);
      if (!evicted) return;
      snapshotCache.delete(cacheKey);
      snapshotCacheBytes -= evicted.estimatedBytes;
      snapshotCacheEvictions++;
    },
  });
  if (!retained.retained) {
    return snapshot;
  }
  snapshotCache.set(cacheKey, { serialized, snapshot, estimatedBytes });
  snapshotCacheBytes += estimatedBytes;
  return snapshot;
}

export function toolInventorySnapshotCacheStats(): {
  entries: number;
  estimatedBytes: number;
  hits: number;
  misses: number;
  evictions: number;
  immutableReuses: number;
} {
  return {
    entries: snapshotCache.size,
    estimatedBytes: snapshotCacheBytes,
    hits: snapshotCacheHits,
    misses: snapshotCacheMisses,
    evictions: snapshotCacheEvictions,
    immutableReuses: immutableInventoryReuses,
  };
}

export function clearToolInventorySnapshotCacheForTests(): void {
  for (const key of snapshotCache.keys()) {
    releaseToolRouterCacheEntry(CACHE_NAMESPACE, key);
  }
  clearToolRouterCacheNamespace(CACHE_NAMESPACE);
  snapshotCache.clear();
  snapshotCacheBytes = 0;
  snapshotCacheHits = 0;
  snapshotCacheMisses = 0;
  snapshotCacheEvictions = 0;
  immutableInventoryReuses = 0;
}
