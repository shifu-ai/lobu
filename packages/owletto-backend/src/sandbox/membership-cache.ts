/**
 * Small LRU cache for membership lookups performed by `client.org()`.
 *
 * Keeps cross-org walks cheap without hiding revocations longer than the TTL
 * (default 30 s). Entries are keyed on a lowercased slug-or-id string plus the
 * caller's user id, so two sessions share nothing.
 */

export interface MembershipRecord {
  orgId: string;
  slug: string;
  role: string | null;
  visibility: "public" | "private";
  /** Unix ms expiry. Populated by the cache on set. */
  expiresAt: number;
}

const DEFAULT_TTL_MS = 30_000;
const MAX_CACHE_ENTRIES = 128;

export class MembershipCache {
  private readonly entries = new Map<string, MembershipRecord>();
  private readonly ttlMs: number;

  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  get(userId: string | null, key: string): MembershipRecord | null {
    const cacheKey = this.key(userId, key);
    const record = this.entries.get(cacheKey);
    if (!record) return null;
    if (record.expiresAt <= Date.now()) {
      this.entries.delete(cacheKey);
      return null;
    }
    // Refresh LRU order.
    this.entries.delete(cacheKey);
    this.entries.set(cacheKey, record);
    return record;
  }

  set(
    userId: string | null,
    keys: string[],
    record: Omit<MembershipRecord, "expiresAt">
  ): void {
    const full: MembershipRecord = {
      ...record,
      expiresAt: Date.now() + this.ttlMs,
    };
    for (const key of keys) {
      const cacheKey = this.key(userId, key);
      this.entries.set(cacheKey, full);
    }
    while (this.entries.size > MAX_CACHE_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  private key(userId: string | null, k: string): string {
    return `${userId ?? "anon"}::${k.toLowerCase()}`;
  }
}
