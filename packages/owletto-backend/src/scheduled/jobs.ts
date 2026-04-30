/**
 * Periodic platform-internal jobs, registered with the TaskScheduler.
 *
 * The TaskScheduler (see `./task-scheduler.ts`) replaces the previous
 * setInterval-driven maintenance loop. Each job is now a standalone task
 * with its own cron schedule, durable as a row in `public.runs` (run_type
 * 'task'). Coordination across pods is handled by the runs-queue claim path
 * — no per-job advisory locks needed.
 */

import type { Env } from '@lobu/owletto-sdk';
import logger from '../utils/logger';
import { TaskScheduler } from './task-scheduler';

/** Cross-cutting handle to platform services owned by CoreServices that the
 *  task registry needs to invoke. Boot wires this from getLobuCoreServices(). */
export interface MaintenanceDeps {
  /** Periodic token refresh — `runOnce()` does one full scan. Now a 30min
   *  safety net since lazy at-use-time refresh handles active users. */
  runTokenRefresh: () => Promise<void>;
  /** Refresh OAuth tokens for a specific (userId, agentId). Used by the
   *  `refresh-token-for-user-agent` task that AuthProfilesManager spawns
   *  lazily when it sees a soon-expiring token at use time. */
  refreshTokenForUserAgent: (userId: string, agentId: string) => Promise<void>;
  /** MCP-session DB cleanup — drops rows whose expiry has passed. */
  runMcpSessionCleanup: () => Promise<void>;
  /** Sweep oauth_states / cli_sessions / rate_limits / grants + archive
   *  completed runs. Was a per-pod setInterval inside CoreServices. */
  runSweepEphemeralTables: () => Promise<void>;
}

/** Reset orphaned scheduled watcher runs once per process on the first
 *  watcher-automation tick. Mirrors the previous behavior gated on
 *  `orphanedWatcherRunsReset` in the old jobs.ts. */
let orphanedWatcherRunsReset = false;

export function registerMaintenanceTasks(
  scheduler: TaskScheduler,
  env: Env,
  deps: MaintenanceDeps,
): void {
  // OAuth token refresh — periodic safety-net at 30min intervals. The hot path
  // is at-use-time lazy refresh in AuthProfilesManager.ensureFreshCredential,
  // which spawns `refresh-token-for-user-agent` per-user when a soon-expiring
  // token is read. This periodic scan only catches tokens for users who
  // haven't accessed the system in a while.
  scheduler.register(
    'token-refresh',
    async () => {
      await deps.runTokenRefresh();
    },
    { cron: '*/30 * * * *' },
  );

  // Lazy refresh handler — spawned by AuthProfilesManager when a soon-expiring
  // OAuth token is read. Not periodic (no cron). Idempotency-keyed by
  // (userId, agentId) so concurrent reads for the same user collapse to one
  // refresh.
  scheduler.register(
    'refresh-token-for-user-agent',
    async (ctx) => {
      const { userId, agentId } = ctx.payload as {
        userId: string;
        agentId: string;
      };
      if (!userId || !agentId) {
        logger.warn({ payload: ctx.payload }, '[task] refresh-token-for-user-agent missing userId/agentId');
        return;
      }
      await deps.refreshTokenForUserAgent(userId, agentId);
    },
  );

  // MCP session cleanup — drops expired session rows from the DB. Lives in the
  // scheduler instead of an mcp-handler module-level setInterval so it runs
  // once per cluster per tick instead of once per pod. The IN-MEMORY part of
  // session cleanup stays as a setInterval in mcp-handler.ts because it must
  // run per-pod (see comment there).
  scheduler.register(
    'mcp-session-cleanup',
    async () => {
      await deps.runMcpSessionCleanup();
    },
    { cron: '*/10 * * * *' },
  );

  // Hygiene sweep — drops expired rows from oauth_states, cli_sessions,
  // rate_limits, grants, and archives completed runs. Was previously a
  // 5-min setInterval inside CoreServices; running it here means one
  // sweep per cluster per tick instead of one per pod.
  scheduler.register(
    'sweep-ephemeral-tables',
    async () => {
      await deps.runSweepEphemeralTables();
    },
    { cron: '*/5 * * * *' },
  );

  scheduler.register(
    'check-stalled-executions',
    async () => {
      const { checkStalledExecutions } = await import('./check-stalled-executions');
      await checkStalledExecutions(env);
      logger.info('[task] check-stalled-executions completed');
    },
    { cron: '*/5 * * * *' },
  );

  scheduler.register(
    'trigger-embed-backfill',
    async () => {
      const { triggerEmbedBackfill } = await import('./trigger-embed-backfill');
      const result = await triggerEmbedBackfill(env);
      if (result.runsCreated > 0) {
        logger.info({ ...result }, '[task] trigger-embed-backfill enqueued runs');
      }
    },
    { cron: '*/5 * * * *' },
  );

  scheduler.register(
    'classification-reconciliation',
    async () => {
      const { runClassificationReconciliation } = await import(
        './classification-reconciliation'
      );
      const result = await runClassificationReconciliation(env);
      logger.info({ ...result }, '[task] classification-reconciliation completed');
    },
    { cron: '*/5 * * * *' },
  );

  // Watcher automation runs every minute (was previously bundled into the 5min
  // maintenance loop, which was too lazy for user-defined watchers expecting
  // sub-5min granularity). Composite of: reconcile in-flight runs, materialize
  // newly-due runs, dispatch pending runs.
  scheduler.register(
    'watcher-automation',
    async () => {
      const {
        dispatchPendingWatcherRuns,
        materializeDueWatcherRuns,
        reconcileWatcherRuns,
        resetOrphanedWatcherRuns,
      } = await import('../watchers/automation');

      if (!orphanedWatcherRunsReset) {
        const { reset } = await resetOrphanedWatcherRuns();
        orphanedWatcherRunsReset = true;
        if (reset > 0) {
          logger.info({ reset }, '[task] watcher-automation: reset orphaned runs on first tick');
        }
      }

      const reconciliation = await reconcileWatcherRuns();
      const materialize = await materializeDueWatcherRuns(env);
      const dispatch = await dispatchPendingWatcherRuns(env);

      logger.info(
        {
          reconciled: reconciliation.reconciled,
          dueWatchers: materialize.dueWatchers,
          runsCreated: materialize.runsCreated,
          skipped: materialize.skipped,
          claimed: dispatch.claimed,
          dispatched: dispatch.dispatched,
          dispatchReconciled: dispatch.reconciled,
          failed: dispatch.failed,
        },
        '[task] watcher-automation completed',
      );
    },
    { cron: '* * * * *' },
  );
}
