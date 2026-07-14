import { createHash } from "node:crypto";
import type { McpToolDef } from "@lobu/core";

const SNAPSHOT_SCHEMA_VERSION = 1;
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
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

function isDeeplyImmutableJsonLike(
	value: unknown,
	visited = new WeakSet<object>(),
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

export function cloneAndFreezeJsonLike<T>(value: T, seen = new WeakMap()): T {
	if (value === null || typeof value !== "object") return value;
	const source = value as object;
	const existing = seen.get(source);
	if (existing) return existing as T;

	const clone: unknown[] | Record<string, unknown> = Array.isArray(value)
		? []
		: {};
	seen.set(source, clone);
	for (const [key, nestedValue] of Object.entries(source)) {
		(clone as Record<string, unknown>)[key] = cloneAndFreezeJsonLike(
			nestedValue,
			seen,
		);
	}
	return Object.freeze(clone) as T;
}

function freezeInventory(
	toolsByMcp: Record<string, McpToolDef[]>,
): Record<string, McpToolDef[]> {
	return Object.freeze(
		Object.fromEntries(
			Object.entries(toolsByMcp).map(([mcpId, tools]) => [
				mcpId,
				Object.freeze(tools.map((tool) => cloneAndFreezeJsonLike(tool))),
			]),
		),
	) as Record<string, McpToolDef[]>;
}

function serializeInventory(
	toolsByMcp: Record<string, McpToolDef[]>,
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
): Record<string, McpToolDef[]> {
	if (isDeeplyImmutableJsonLike(toolsByMcp)) {
		immutableInventoryReuses++;
		return toolsByMcp;
	}
	const serialized = serializeInventory(toolsByMcp);
	if (serialized === null) {
		snapshotCacheMisses++;
		return freezeInventory(toolsByMcp);
	}
	const cacheKey = snapshotCacheKey(serialized);
	const cached = snapshotCache.get(cacheKey);
	if (cached?.serialized === serialized) {
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

	if (cached) {
		snapshotCache.delete(cacheKey);
		snapshotCacheBytes -= cached.estimatedBytes;
	}
	while (
		snapshotCache.size > 0 &&
		snapshotCacheBytes + estimatedBytes > MAX_CACHE_BYTES
	) {
		const oldestKey = snapshotCache.keys().next().value;
		if (oldestKey === undefined) break;
		const oldest = snapshotCache.get(oldestKey);
		snapshotCache.delete(oldestKey);
		snapshotCacheBytes -= oldest?.estimatedBytes ?? 0;
		snapshotCacheEvictions++;
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
	snapshotCache.clear();
	snapshotCacheBytes = 0;
	snapshotCacheHits = 0;
	snapshotCacheMisses = 0;
	snapshotCacheEvictions = 0;
	immutableInventoryReuses = 0;
}
