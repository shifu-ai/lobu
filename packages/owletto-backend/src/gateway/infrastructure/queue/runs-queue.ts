/**
 * Postgres `runs`-table-backed message queue.
 *
 * Phase 5 of the Redis -> Postgres migration: replaces BullMQ with a SKIP-
 * LOCKED claim loop on `public.runs`. The connector worker (run_type IN
 * 'sync', 'action', 'embed_backfill', 'watcher', 'auth') keeps its existing
 * HTTP-poll claim path; this queue strictly handles the lobu-queue lanes
 * ('chat_message', 'schedule', 'agent_run', 'internal').
 *
 * Wakeup is `pg_notify('runs_lobu_pending', '<run_type>')` on every send;
 * subscribers LISTEN on a dedicated long-lived `pg.Client` so the poll cadence
 * can stay slow (200ms) without sacrificing latency.
 *
 * The IMessageQueue interface still exposes `getRedisClient()` because many
 * non-queue consumers (secret-store, grant-store, scheduled-wakeup, cli-auth,
 * Slack OAuth state) read/write Redis directly. Phase 11 removes ioredis
 * entirely; until then this class still owns a Redis client for them.
 */

import { createLogger } from "@lobu/core";
import { Redis } from "ioredis";
import { Client, Pool, type PoolConfig } from "pg";
import type {
  IMessageQueue,
  JobHandler,
  QueueJob,
  QueueOptions,
  QueueStats,
} from "./types.js";

const logger = createLogger("runs-queue");

const NOTIFY_CHANNEL = "runs_lobu_pending";
const POLL_INTERVAL_MS = 200;
const RECONNECT_DELAY_MS = 1000;
/** Backoff cap (seconds) when retrying a failed run. */
const MAX_BACKOFF_SECONDS = 300;

/** Lobu-queue run types. Inserts/claims are restricted to these so connector
 *  lanes (sync, action, embed_backfill, watcher, auth) are never disturbed. */
const LOBU_RUN_TYPES = [
  "chat_message",
  "schedule",
  "agent_run",
  "internal",
] as const;

type LobuRunType = (typeof LOBU_RUN_TYPES)[number];

export interface RunsQueueConfig {
  /** Postgres connection string. Defaults to `process.env.DATABASE_URL`. */
  connectionString?: string;
  /** Optional Redis URL for backward-compat consumers (secret-store etc.).
   *  When omitted, falls back to `process.env.REDIS_URL`. */
  redisUrl?: string;
  /** Pool size for queue operations. */
  poolMax?: number;
  /** Per-queue concurrency. Default 1 — matches BullMQ's per-worker default. */
  defaultConcurrency?: number;
}

interface QueueWorker {
  queueName: string;
  runType: LobuRunType;
  handler: JobHandler<unknown>;
  concurrency: number;
  /** When true the poll loop sleeps without claiming. */
  paused: boolean;
  /** When true the loop exits on next tick. */
  stopped: boolean;
  /** Number of in-flight handler invocations. */
  active: number;
  /** Wake-up signal: a NOTIFY for this run_type sets this. The loop checks it
   *  to skip the poll-interval sleep. */
  wakeup: () => void;
  pendingWakeup: boolean;
}

/**
 * Map a queue name to a lobu-queue `run_type`. Every queue the gateway uses
 * (`messages`, `thread_message_<deploymentName>`, `thread_response`,
 * `messages:dlq`, `schedule:*`, …) collapses to one of the four lanes.
 *
 * The full queue name is preserved in `runs.queue_name` so the SKIP LOCKED
 * claim can scope to exactly the producer's queue.
 */
export function classifyQueue(queueName: string): LobuRunType {
  if (queueName.startsWith("schedule")) return "schedule";
  if (queueName === "agent_run" || queueName.startsWith("agent_run:"))
    return "agent_run";
  if (queueName.startsWith("internal")) return "internal";
  // `messages`, `thread_response`, `thread_message_*`, anything DLQ — all
  // chat-driven dispatch.
  return "chat_message";
}

/**
 * Compute the next-attempt delay for a failed run. Exponential, base 2 seconds,
 * capped at MAX_BACKOFF_SECONDS.
 */
export function backoffSeconds(attempt: number): number {
  const seconds = 2 ** Math.max(0, attempt);
  return Math.min(seconds, MAX_BACKOFF_SECONDS);
}

export class RunsQueue implements IMessageQueue {
  private pool: Pool | null = null;
  private listener: Client | null = null;
  /** Set when a reconnect timer is armed; lets us short-circuit overlapping
   *  reconnects. */
  private listenerReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private listenerStopped = false;
  private redisClient: Redis | null = null;
  private isConnected = false;

  /** Workers keyed by queue name. */
  private workers = new Map<string, QueueWorker>();
  /** Per-run_type subscribers: each LISTEN payload `<run_type>` wakes every
   *  worker registered against that type. */
  private subscribersByType = new Map<LobuRunType, Set<QueueWorker>>();

  private readonly poolMax: number;
  private readonly defaultConcurrency: number;
  private readonly connectionString: string;
  private readonly redisUrl: string | undefined;

  constructor(config: RunsQueueConfig = {}) {
    const cs = config.connectionString ?? process.env.DATABASE_URL;
    if (!cs) {
      throw new Error("RunsQueue: DATABASE_URL is required");
    }
    this.connectionString = cs;
    this.redisUrl = config.redisUrl ?? process.env.REDIS_URL;
    this.poolMax = config.poolMax ?? 5;
    this.defaultConcurrency = config.defaultConcurrency ?? 1;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.isConnected) return;

    const ssl = pgSslOpt();
    const cfg: PoolConfig = {
      connectionString: this.connectionString,
      ssl,
      application_name: "owletto-runs-queue",
      max: this.poolMax,
      idleTimeoutMillis: 30_000,
    };
    this.pool = new Pool(cfg);
    this.pool.on("error", (err) => {
      logger.warn(`Pool idle client error: ${err.message}`);
    });

    // Backwards-compat Redis client for consumers that still call
    // `getRedisClient()`. Phase 11 removes this.
    if (this.redisUrl) {
      this.redisClient = new Redis(this.redisUrl, {
        maxRetriesPerRequest: null,
      });
      // Prevent unhandled errors from crashing the process.
      this.redisClient.on("error", (err) => {
        logger.warn(`Redis client error: ${err.message}`);
      });
    } else {
      logger.warn(
        "REDIS_URL not configured; RunsQueue.getRedisClient() will throw"
      );
    }

    this.isConnected = true;
    this.listenerStopped = false;
    await this.connectListener();
    logger.debug("Runs queue started");
  }

  async stop(): Promise<void> {
    this.isConnected = false;
    this.listenerStopped = true;

    // Stop all workers; let in-flight handlers finish.
    for (const w of this.workers.values()) {
      w.stopped = true;
      w.wakeup();
    }
    this.workers.clear();
    this.subscribersByType.clear();

    if (this.listenerReconnectTimer) {
      clearTimeout(this.listenerReconnectTimer);
      this.listenerReconnectTimer = null;
    }
    if (this.listener) {
      try {
        await this.listener.end();
      } catch {
        // ignore
      }
      this.listener = null;
    }
    if (this.redisClient) {
      try {
        await this.redisClient.quit();
      } catch {
        // ignore
      }
      this.redisClient = null;
    }
    if (this.pool) {
      try {
        await this.pool.end();
      } catch {
        // ignore
      }
      this.pool = null;
    }
    logger.debug("Runs queue stopped");
  }

  isHealthy(): boolean {
    return this.isConnected && this.pool !== null;
  }

  /**
   * Returns a Redis client for backward-compat consumers (secret-store,
   * grant-store, scheduled-wakeup, cli-auth, Slack OAuth state). This is NOT
   * used by the queue itself — pure ioredis for non-queue code paths until
   * Phase 11.
   */
  getRedisClient(): unknown {
    if (!this.redisClient) {
      throw new Error(
        "Redis client not configured. Set REDIS_URL on the RunsQueue config."
      );
    }
    return this.redisClient;
  }

  // ── Producer ────────────────────────────────────────────────────────────

  async createQueue(queueName: string): Promise<void> {
    // No-op — queues are virtual under the runs-table substrate; the row's
    // `queue_name` column is the only thing that distinguishes them. Kept for
    // IMessageQueue compat; tests and the code paths that pre-create queues
    // don't need to do anything here.
    if (!queueName) {
      throw new Error("queueName is required");
    }
  }

  async send<T>(
    queueName: string,
    data: T,
    options?: QueueOptions,
  ): Promise<string> {
    if (!this.pool) throw new Error("RunsQueue not started");
    const runType = classifyQueue(queueName);
    const idempotencyKey = options?.singletonKey ?? null;
    const maxAttempts = options?.retryLimit ?? 3;
    const delayMs = options?.delayMs ?? 0;
    const runAtSql = delayMs > 0
      ? `now() + ${Number(delayMs) / 1000}::float * interval '1 second'`
      : "now()";

    // Use a single round-trip: INSERT ... RETURNING id, and do the NOTIFY
    // *after* COMMIT (otherwise listeners may wake before the row is
    // visible).
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const sql = `
        INSERT INTO public.runs (
          run_type,
          queue_name,
          action_input,
          idempotency_key,
          max_attempts,
          attempts,
          status,
          run_at
        ) VALUES (
          $1, $2, $3::jsonb, $4, $5, 0, 'pending', ${runAtSql}
        )
        ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL
        DO NOTHING
        RETURNING id
      `;
      const result = await client.query(sql, [
        runType,
        queueName,
        JSON.stringify(data ?? {}),
        idempotencyKey,
        maxAttempts,
      ]);
      await client.query("COMMIT");

      // ON CONFLICT DO NOTHING: row already exists. Look up the existing id
      // so callers always get something sensible back.
      let id: string;
      if (result.rows.length === 0 && idempotencyKey) {
        const existing = await client.query(
          "SELECT id FROM public.runs WHERE idempotency_key = $1",
          [idempotencyKey],
        );
        id = String(existing.rows[0]?.id ?? "");
      } else {
        id = String(result.rows[0].id);
      }

      // Wake listeners. Failure here is non-fatal — pollers will catch it on
      // the next tick.
      try {
        await client.query("SELECT pg_notify($1, $2)", [
          NOTIFY_CHANNEL,
          runType,
        ]);
      } catch (err) {
        logger.warn(
          `pg_notify failed for ${runType}: ${(err as Error).message}`,
        );
      }

      return id;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // ignore
      }
      throw err;
    } finally {
      client.release();
    }
  }

  // ── Consumer ────────────────────────────────────────────────────────────

  async work<T>(
    queueName: string,
    handler: JobHandler<T>,
    options?: { startPaused?: boolean },
  ): Promise<void> {
    if (!this.pool) throw new Error("RunsQueue not started");

    // Replace any existing worker for this queue (matches RedisQueue behavior).
    const existing = this.workers.get(queueName);
    if (existing) {
      existing.stopped = true;
      this.removeFromTypeIndex(existing);
      existing.wakeup();
      this.workers.delete(queueName);
    }

    const runType = classifyQueue(queueName);
    let resolveWake: (() => void) | null = null;
    const worker: QueueWorker = {
      queueName,
      runType,
      handler: handler as JobHandler<unknown>,
      concurrency: this.defaultConcurrency,
      paused: options?.startPaused ?? false,
      stopped: false,
      active: 0,
      pendingWakeup: false,
      wakeup: () => {
        worker.pendingWakeup = true;
        if (resolveWake) {
          const r = resolveWake;
          resolveWake = null;
          r();
        }
      },
    };
    this.workers.set(queueName, worker);
    let typeSet = this.subscribersByType.get(runType);
    if (!typeSet) {
      typeSet = new Set();
      this.subscribersByType.set(runType, typeSet);
    }
    typeSet.add(worker);

    // Self-driving poll loop. Sleeps POLL_INTERVAL_MS between empty claims;
    // a NOTIFY for `runType` cuts the sleep short.
    const loop = async () => {
      while (!worker.stopped) {
        if (worker.paused) {
          await this.sleep(POLL_INTERVAL_MS, worker, () => {
            resolveWake = null;
          }, (resolve) => {
            resolveWake = resolve;
          });
          continue;
        }
        if (worker.active >= worker.concurrency) {
          await this.sleep(50, worker, () => {
            resolveWake = null;
          }, (resolve) => {
            resolveWake = resolve;
          });
          continue;
        }
        try {
          const claimed = await this.claimOne(worker);
          if (!claimed) {
            await this.sleep(POLL_INTERVAL_MS, worker, () => {
              resolveWake = null;
            }, (resolve) => {
              resolveWake = resolve;
            });
            continue;
          }
          worker.active += 1;
          // Run the handler without blocking the poll loop so concurrency > 1
          // can claim more rows.
          this.runHandler(worker, claimed).finally(() => {
            worker.active -= 1;
          });
        } catch (err) {
          logger.error(`Poll loop error for ${queueName}:`, err);
          await this.sleep(POLL_INTERVAL_MS, worker, () => {
            resolveWake = null;
          }, (resolve) => {
            resolveWake = resolve;
          });
        }
      }
    };
    void loop();
  }

  async pauseWorker(queueName: string): Promise<void> {
    const w = this.workers.get(queueName);
    if (!w) return;
    w.paused = true;
  }

  async resumeWorker(queueName: string): Promise<void> {
    const w = this.workers.get(queueName);
    if (!w) return;
    w.paused = false;
    w.wakeup();
  }

  async getQueueStats(queueName: string): Promise<QueueStats> {
    if (!this.pool) {
      return { waiting: 0, active: 0, completed: 0, failed: 0 };
    }
    const result = await this.pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0)::int AS waiting,
         COALESCE(SUM(CASE WHEN status IN ('claimed','running') THEN 1 ELSE 0 END), 0)::int AS active,
         COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0)::int AS completed,
         COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0)::int AS failed
       FROM public.runs
       WHERE queue_name = $1`,
      [queueName],
    );
    const row = result.rows[0] ?? {};
    return {
      waiting: Number(row.waiting ?? 0),
      active: Number(row.active ?? 0),
      completed: Number(row.completed ?? 0),
      failed: Number(row.failed ?? 0),
    };
  }

  // ── Internals ───────────────────────────────────────────────────────────

  /** Claim one row scoped to the worker's `queue_name` (or the run_type when
   *  the worker subscribes to all rows of a type — currently every worker is
   *  queue-scoped). Returns `null` if nothing was available.  */
  private async claimOne(worker: QueueWorker): Promise<{
    runId: number;
    payload: unknown;
    attempts: number;
    maxAttempts: number;
  } | null> {
    if (!this.pool) return null;
    const claimedBy = `gateway-${process.pid}`;
    const result = await this.pool.query(
      `WITH next_run AS (
         SELECT id FROM public.runs
         WHERE status = 'pending'
           AND run_type = $1
           AND queue_name = $2
           AND run_at <= now()
         ORDER BY run_at ASC, id ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE public.runs r
       SET status = 'claimed',
           claimed_at = now(),
           claimed_by = $3
       FROM next_run nr
       WHERE r.id = nr.id
       RETURNING r.id, r.action_input, r.attempts, r.max_attempts`,
      [worker.runType, worker.queueName, claimedBy],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      runId: Number(row.id),
      payload: row.action_input,
      attempts: Number(row.attempts ?? 0),
      maxAttempts: Number(row.max_attempts ?? 3),
    };
  }

  private async runHandler(
    worker: QueueWorker,
    claimed: {
      runId: number;
      payload: unknown;
      attempts: number;
      maxAttempts: number;
    },
  ): Promise<void> {
    const job: QueueJob<unknown> = {
      id: String(claimed.runId),
      data: claimed.payload,
      name: worker.queueName,
    };
    try {
      await worker.handler(job);
      await this.markCompleted(claimed.runId);
    } catch (err) {
      const nextAttempt = claimed.attempts + 1;
      if (nextAttempt >= claimed.maxAttempts) {
        await this.markFailed(claimed.runId, err);
      } else {
        await this.scheduleRetry(claimed.runId, nextAttempt);
      }
    }
  }

  private async markCompleted(runId: number): Promise<void> {
    if (!this.pool) return;
    await this.pool.query(
      `UPDATE public.runs
       SET status = 'completed',
           completed_at = now()
       WHERE id = $1
         AND status = 'claimed'`,
      [runId],
    );
  }

  private async markFailed(runId: number, err: unknown): Promise<void> {
    if (!this.pool) return;
    const message = err instanceof Error ? err.message : String(err);
    await this.pool.query(
      `UPDATE public.runs
       SET status = 'failed',
           completed_at = now(),
           error_message = $2,
           attempts = attempts + 1
       WHERE id = $1
         AND status = 'claimed'`,
      [runId, message],
    );
    logger.warn(
      `Run ${runId} failed after retries: ${message}`,
    );
  }

  private async scheduleRetry(runId: number, attempt: number): Promise<void> {
    if (!this.pool) return;
    const delay = backoffSeconds(attempt);
    await this.pool.query(
      `UPDATE public.runs
       SET status = 'pending',
           attempts = $2,
           run_at = now() + ($3::int * interval '1 second'),
           claimed_at = NULL,
           claimed_by = NULL
       WHERE id = $1
         AND status = 'claimed'`,
      [runId, attempt, delay],
    );
  }

  private removeFromTypeIndex(worker: QueueWorker): void {
    const set = this.subscribersByType.get(worker.runType);
    if (!set) return;
    set.delete(worker);
    if (set.size === 0) this.subscribersByType.delete(worker.runType);
  }

  /**
   * Sleep for `ms` or until the worker's wakeup() is called or it stops.
   * The two callbacks let the caller capture the resolve fn so wakeup() can
   * cut the sleep short.
   */
  private async sleep(
    ms: number,
    worker: QueueWorker,
    onClear: () => void,
    onCapture: (resolve: () => void) => void,
  ): Promise<void> {
    if (worker.pendingWakeup) {
      worker.pendingWakeup = false;
      return;
    }
    return new Promise<void>((resolve) => {
      let resolved = false;
      const finish = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        worker.pendingWakeup = false;
        onClear();
        resolve();
      };
      const timer = setTimeout(finish, ms);
      timer.unref?.();
      onCapture(finish);
      if (worker.stopped) finish();
    });
  }

  // ── Listener ────────────────────────────────────────────────────────────

  private async connectListener(): Promise<void> {
    if (this.listenerStopped) return;
    if (this.listener) return;

    const ssl = pgSslOpt();
    const client = new Client({
      connectionString: this.connectionString,
      ssl,
      application_name: "owletto-runs-queue-listener",
    });

    let connectFailed = false;
    client.on("notification", (msg) => {
      if (msg.channel !== NOTIFY_CHANNEL) return;
      const runType = (msg.payload ?? "").trim();
      if (!runType) {
        // Empty payload: wake every worker.
        for (const w of this.workers.values()) w.wakeup();
        return;
      }
      const set = this.subscribersByType.get(runType as LobuRunType);
      if (!set) return;
      for (const w of set) w.wakeup();
    });
    client.on("error", (err: Error) => {
      if (this.listener !== client) {
        connectFailed = true;
        return;
      }
      this.handleListenerDisconnect(err);
    });
    client.on("end", () => {
      if (this.listener !== client) {
        connectFailed = true;
        return;
      }
      this.handleListenerDisconnect(new Error("listener ended"));
    });

    try {
      await client.connect();
      if (connectFailed) {
        throw new Error("listener failed before LISTEN");
      }
      await client.query(`LISTEN ${quoteIdent(NOTIFY_CHANNEL)}`);
      if (this.listenerStopped) {
        await client.end().catch(() => {});
        return;
      }
      this.listener = client;
      logger.debug("RunsQueue listener connected");
    } catch (err) {
      try {
        await client.end();
      } catch {
        // ignore
      }
      this.handleListenerDisconnect(
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }

  private handleListenerDisconnect(error: Error): void {
    if (this.listenerStopped) return;
    if (!this.listener && !this.listenerReconnectTimer) {
      // First disconnect — schedule reconnect.
    }
    this.listener = null;
    if (this.listenerReconnectTimer) return;
    logger.warn(`RunsQueue listener disconnected: ${error.message}`);
    this.listenerReconnectTimer = setTimeout(() => {
      this.listenerReconnectTimer = null;
      if (this.listenerStopped) return;
      this.connectListener().catch((err) => {
        logger.warn(
          `RunsQueue listener reconnect failed: ${(err as Error).message}`,
        );
        this.handleListenerDisconnect(
          err instanceof Error ? err : new Error(String(err)),
        );
      });
    }, RECONNECT_DELAY_MS);
    this.listenerReconnectTimer.unref?.();
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function pgSslOpt() {
  return process.env.PGSSLMODE === "require" ||
    process.env.PGSSLMODE === "prefer"
    ? { rejectUnauthorized: false }
    : undefined;
}

function quoteIdent(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Channel name must be a plain identifier: ${name}`);
  }
  return `"${name}"`;
}
