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

/** Reset orphaned scheduled watcher runs once per process on the first
 *  watcher-automation tick. Mirrors the previous behavior gated on
 *  `orphanedWatcherRunsReset` in the old jobs.ts. */
let orphanedWatcherRunsReset = false;

export function registerMaintenanceTasks(scheduler: TaskScheduler, env: Env): void {
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
