/**
 * InvalidatableCache — read-through cache with PostgreSQL `LISTEN/NOTIFY`-driven
 * invalidation.
 *
 * Use when:
 * - You read the same row(s) frequently on a hot path (e.g. dispatch).
 * - The row's writers are willing to call `pg_notify(<channel>, <key>)`.
 * - There's only a handful of channels (~3-5) — one per cached table is fine.
 *   Per-row channels would explode the postmaster's notification table; this
 *   primitive is NOT designed for that.
 *
 * Semantics:
 * - `get(key)` reads through to `loader(key)` on miss, caches the result, and
 *   returns it. Subsequent calls return the cached value until either (a) the
 *   `ttlMs` expires or (b) a `NOTIFY` arrives whose payload matches the key.
 * - On `NOTIFY` with payload `*` or empty payload, the entire cache is cleared
 *   (operators should treat this as a sledgehammer; prefer per-key payloads).
 * - On underlying connection drop, ALL cached entries are dropped on
 *   reconnect — we cannot guarantee no NOTIFY was missed during the gap.
 * - In-flight loaders are coalesced: concurrent `get(key)` calls that miss
 *   will share the same loader Promise.
 */

import { Client } from "pg";
import { createLogger, type Logger } from "@lobu/core";

interface Entry<V> {
  value: V;
  expiresAt: number;
  /** Generation counter of the listener at the time this entry was loaded.
   *  Bumped on every reconnect so post-reconnect entries naturally invalidate
   *  any pre-reconnect cache. */
  generation: number;
}

export interface InvalidatableCacheOptions<K, V> {
  /** PostgreSQL NOTIFY channel name. Must be a plain SQL identifier
   *  (`/^[a-zA-Z_][a-zA-Z0-9_]*$/`). */
  channel: string;
  /** Hard TTL after which an entry is considered stale and reloaded. */
  ttlMs: number;
  /** Optional LRU cap. Default 1000. */
  maxEntries?: number;
  /** Loader called on cache miss. Should NOT throw for normal "row missing"
   *  cases — return `null` / a sentinel and let the caller decide. */
  loader: (key: K) => Promise<V>;
  /** Map keys to a string for use in the cache map and matching against the
   *  NOTIFY payload. Default: `String(k)`. */
  keyToString?: (key: K) => string;
  /** Connection string. Defaults to `process.env.DATABASE_URL`. */
  connectionString?: string;
  /** Logger. Defaults to `createLogger("invalidatable-cache:<channel>")`. */
  logger?: Logger;
  /** Reconnect backoff in ms. Default 1000. */
  reconnectDelayMs?: number;
  /** Test seam: override the `pg.Client` factory. Production uses the default
   *  (a real `pg.Client` from `process.env.DATABASE_URL`). */
  clientFactory?: (connectionString: string) => MinimalListenClient;
}

/** The slice of `pg.Client` that this primitive depends on. Exposed so tests
 *  can stub the listener without standing up a real Postgres. */
export interface MinimalListenClient {
  on(event: "notification", listener: (msg: { channel: string; payload?: string }) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  connect(): Promise<void>;
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
}

export class InvalidatableCache<K, V> {
  private entries = new Map<string, Entry<V>>();
  /** In-flight loaders, keyed by stringified key. Used to coalesce concurrent
   *  cache misses for the same key. */
  private inflight = new Map<string, Promise<V>>();
  private generation = 0;
  private client: MinimalListenClient | null = null;
  private closed = false;
  private connectPromise: Promise<void> | null = null;
  private readonly logger: Logger;
  private readonly maxEntries: number;
  private readonly keyToString: (key: K) => string;
  private readonly reconnectDelayMs: number;

  constructor(private readonly opts: InvalidatableCacheOptions<K, V>) {
    quoteIdent(opts.channel); // validate channel name early
    this.logger =
      opts.logger ?? createLogger(`invalidatable-cache:${opts.channel}`);
    this.maxEntries = opts.maxEntries ?? 1000;
    this.keyToString = opts.keyToString ?? ((k) => String(k));
    this.reconnectDelayMs = opts.reconnectDelayMs ?? 1000;
  }

  /**
   * Read-through. Returns the cached value if fresh, otherwise calls
   * `loader(key)`, caches the result, and returns it.
   *
   * Concurrent misses for the same key share a single loader Promise.
   */
  async get(key: K): Promise<V> {
    if (this.closed) {
      throw new Error("InvalidatableCache: closed");
    }
    await this.ensureListening();

    const k = this.keyToString(key);
    const now = Date.now();
    const cached = this.entries.get(k);
    if (
      cached &&
      cached.expiresAt > now &&
      cached.generation === this.generation
    ) {
      // Touch for LRU.
      this.entries.delete(k);
      this.entries.set(k, cached);
      return cached.value;
    }

    const inflight = this.inflight.get(k);
    if (inflight) {
      return inflight;
    }

    const startGen = this.generation;
    const promise = (async () => {
      const value = await this.opts.loader(key);
      // Re-check generation: if we reconnected mid-load, drop the result —
      // the writer may have NOTIFY'd between the read and the reconnect.
      if (!this.closed && startGen === this.generation) {
        this.put(k, value, this.generation);
      }
      return value;
    })().finally(() => {
      this.inflight.delete(k);
    });

    this.inflight.set(k, promise);
    return promise;
  }

  /** Drop a single key from the cache. Does NOT call NOTIFY — callers that
   *  want other gateway processes to invalidate must call `pg_notify` directly. */
  invalidate(key: K): void {
    this.entries.delete(this.keyToString(key));
  }

  /** Drop the entire cache. Does NOT call NOTIFY. */
  invalidateAll(): void {
    this.entries.clear();
  }

  /** Returns the current cache size (test/diagnostic only). */
  size(): number {
    return this.entries.size;
  }

  /** Returns the current generation counter (test/diagnostic only).
   *  Bumped on every reconnect. */
  getGeneration(): number {
    return this.generation;
  }

  /** Tear down the listener and clear local state. Idempotent. */
  async close(): Promise<void> {
    this.closed = true;
    this.entries.clear();
    this.inflight.clear();
    const client = this.client;
    this.client = null;
    if (client) {
      try {
        await client.end();
      } catch {
        // best effort
      }
    }
  }

  /** Test-only: drive the listener to fail and reconnect. */
  async _forceReconnectForTest(): Promise<void> {
    const client = this.client;
    if (!client) return;
    this.handleDisconnect(new Error("forced reconnect for test"));
  }

  /** Test-only: synchronously deliver a NOTIFY payload. */
  _notifyForTest(payload: string): void {
    this.handleNotification(payload);
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private put(key: string, value: V, generation: number): void {
    if (this.entries.has(key)) {
      this.entries.delete(key);
    } else if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, {
      value,
      expiresAt: Date.now() + this.opts.ttlMs,
      generation,
    });
  }

  /** Lazily start the LISTEN connection on first `get()`. */
  private async ensureListening(): Promise<void> {
    if (this.client || this.closed) return;
    if (this.connectPromise) {
      await this.connectPromise;
      return;
    }
    this.connectPromise = this.connectAndListen().finally(() => {
      this.connectPromise = null;
    });
    await this.connectPromise;
  }

  private async connectAndListen(): Promise<void> {
    if (this.closed) return;

    const connectionString =
      this.opts.connectionString ?? process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        `InvalidatableCache(${this.opts.channel}): DATABASE_URL is not set`
      );
    }

    const client = this.opts.clientFactory
      ? this.opts.clientFactory(connectionString)
      : defaultClientFactory(connectionString, this.opts.channel);

    client.on("notification", (msg) => {
      if (msg.channel !== this.opts.channel) return;
      this.handleNotification(msg.payload ?? "");
    });

    // `error` MUST have a listener or it propagates as an uncaught exception
    // and crashes the process. Treat any error as a disconnect signal.
    client.on("error", (err: Error) => {
      this.handleDisconnect(err);
    });
    client.on("end", () => {
      this.handleDisconnect(new Error("connection ended"));
    });

    await client.connect();
    await client.query(`LISTEN ${quoteIdent(this.opts.channel)}`);
    if (this.closed) {
      // Closed during connect; tear down what we just built.
      await client.end().catch(() => {});
      return;
    }
    this.client = client;
    this.logger.debug(
      { channel: this.opts.channel },
      "InvalidatableCache: listening"
    );
  }

  private handleNotification(payload: string): void {
    if (payload === "" || payload === "*") {
      this.entries.clear();
      return;
    }
    this.entries.delete(payload);
  }

  /**
   * On disconnect, bump the generation (so any in-flight loader's eventual
   * `put` is rejected) and schedule a reconnect. Cache is cleared because
   * we may have missed NOTIFYs during the gap.
   */
  private handleDisconnect(error: Error): void {
    if (this.closed) return;
    if (!this.client) {
      // Already in the middle of a reconnect.
      return;
    }
    this.logger.warn(
      { channel: this.opts.channel, error: error.message },
      "InvalidatableCache: listener disconnected, will reconnect"
    );
    const oldClient = this.client;
    this.client = null;
    this.generation += 1;
    this.entries.clear();
    // Best-effort cleanup of the dead client.
    try {
      void oldClient.end().catch(() => {});
    } catch {
      // ignore
    }
    if (this.closed) return;

    const timer = setTimeout(() => {
      if (this.closed) return;
      this.connectAndListen().catch((err) => {
        this.logger.warn(
          { channel: this.opts.channel, error: String(err) },
          "InvalidatableCache: reconnect failed, will retry"
        );
        // Pretend we still had a client so handleDisconnect runs its body
        // and schedules another retry.
        this.client = oldClient;
        this.handleDisconnect(
          err instanceof Error ? err : new Error(String(err))
        );
      });
    }, this.reconnectDelayMs);
    timer.unref?.();
  }
}

function defaultClientFactory(
  connectionString: string,
  channel: string
): MinimalListenClient {
  const ssl =
    process.env.PGSSLMODE === "require" ||
    process.env.PGSSLMODE === "prefer"
      ? { rejectUnauthorized: false }
      : undefined;

  return new Client({
    connectionString,
    ssl,
    application_name: `owletto-cache-${channel}`,
  }) as unknown as MinimalListenClient;
}

/**
 * Quote a Postgres identifier for use in `LISTEN`. Refuses anything that
 * isn't a plain SQL identifier so the operator never has to think about
 * quoting, escaping, or injection.
 */
function quoteIdent(name: string): string {
  if (name.length === 0) {
    throw new Error("Channel name cannot be empty");
  }
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(
      `Channel name must match /^[a-zA-Z_][a-zA-Z0-9_]*$/ (got: ${name})`
    );
  }
  return `"${name}"`;
}
