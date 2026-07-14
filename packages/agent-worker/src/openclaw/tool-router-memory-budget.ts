const MAX_RETAINED_BYTES = 32 * 1024 * 1024;
const MAX_ENTRY_BYTES = 16 * 1024 * 1024;

interface RetainedEntry {
	bytes: number;
	onEvict: () => void;
}

const retainedEntries = new Map<string, RetainedEntry>();
let retainedBytes = 0;
let evictionCount = 0;

function retainedKey(namespace: string, key: string): string {
	return `${namespace}\u0000${key}`;
}

export function retainToolRouterCacheEntry(params: {
	namespace: string;
	key: string;
	estimatedBytes: number;
	onEvict: () => void;
}): { retained: boolean; evictionCount: number; evictedNamespaces: string[] } {
	if (
		params.estimatedBytes < 0 ||
		params.estimatedBytes > MAX_ENTRY_BYTES ||
		!Number.isFinite(params.estimatedBytes)
	) {
		return { retained: false, evictionCount: 0, evictedNamespaces: [] };
	}
	let currentEvictionCount = 0;
	const evictedNamespaces: string[] = [];
	const key = retainedKey(params.namespace, params.key);
	const existing = retainedEntries.get(key);
	if (existing) {
		retainedEntries.delete(key);
		retainedBytes -= existing.bytes;
	}
	while (
		retainedEntries.size > 0 &&
		retainedBytes + params.estimatedBytes > MAX_RETAINED_BYTES
	) {
		const oldestKey = retainedEntries.keys().next().value;
		if (oldestKey === undefined) break;
		const oldest = retainedEntries.get(oldestKey);
		retainedEntries.delete(oldestKey);
		retainedBytes -= oldest?.bytes ?? 0;
		evictionCount++;
		currentEvictionCount++;
		evictedNamespaces.push(oldestKey.slice(0, oldestKey.indexOf("\u0000")));
		oldest?.onEvict();
	}
	retainedEntries.set(key, {
		bytes: params.estimatedBytes,
		onEvict: params.onEvict,
	});
	retainedBytes += params.estimatedBytes;
	return {
		retained: true,
		evictionCount: currentEvictionCount,
		evictedNamespaces,
	};
}

export function touchToolRouterCacheEntry(
	namespace: string,
	key: string,
): void {
	const retained = retainedEntries.get(retainedKey(namespace, key));
	if (!retained) return;
	retainedEntries.delete(retainedKey(namespace, key));
	retainedEntries.set(retainedKey(namespace, key), retained);
}

export function releaseToolRouterCacheEntry(
	namespace: string,
	key: string,
): void {
	const compoundKey = retainedKey(namespace, key);
	const retained = retainedEntries.get(compoundKey);
	if (!retained) return;
	retainedEntries.delete(compoundKey);
	retainedBytes -= retained.bytes;
}

export function clearToolRouterCacheNamespace(namespace: string): void {
	const prefix = `${namespace}\u0000`;
	for (const [key, retained] of retainedEntries) {
		if (!key.startsWith(prefix)) continue;
		retainedEntries.delete(key);
		retainedBytes -= retained.bytes;
	}
}

export function toolRouterRetainedMemoryStats(): {
	entries: number;
	estimatedBytes: number;
	maxEntryBytes: number;
	evictions: number;
} {
	return {
		entries: retainedEntries.size,
		estimatedBytes: retainedBytes,
		maxEntryBytes: MAX_ENTRY_BYTES,
		evictions: evictionCount,
	};
}

export function clearToolRouterRetainedMemoryForTests(): void {
	const callbacks = [...retainedEntries.values()].map(({ onEvict }) => onEvict);
	retainedEntries.clear();
	retainedBytes = 0;
	evictionCount = 0;
	for (const onEvict of callbacks) onEvict();
}
