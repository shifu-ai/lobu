import type { DbClient } from '../db/client';
import { getDb, pgTextArray } from '../db/client';
import type { WatcherKind } from '../utils/queue-helpers';
import { ACTIVE_RUN_STATUSES, runStatusLiteral } from '../utils/run-statuses';

export type WatcherTerminalResult = { ok: true } | { ok: false; error: string };

/**
 * Whether a watcher run that finished without producing a `watcher_windows`
 * row (via `manage_watchers(action="complete_window")`) should be treated as
 * a SUCCESS rather than a failure.
 *
 * `knowledge` watchers MUST call complete_window — it's the only signal real
 * extraction happened; a normally-finished reply that skipped it silently
 * masked the Reddit watcher being broken for a week, so absence stays a
 * failure for them.
 *
 * `digest` watchers (Task 4) never call complete_window at all — they call
 * get_pm_daily_context / send_daily_digest via the toolbox MCP instead — so
 * a normally-finished agent turn with no window is the EXPECTED outcome, not
 * a failure.
 *
 * Canonical location: this decision must be shared by BOTH completion paths
 * that can mark a watcher run terminal without a window —
 * `resolveWatcherRunsByMessageIds` below (driven by the gateway API's
 * `ThreadResponsePayload` completion/error events AND the periodic
 * `reconcileWatcherRuns` sweep in automation.ts) and the in-process
 * `WatcherRunTracker.onResolve` callback (`registerWatcherRunHandle` in
 * automation.ts). Defining it once here and re-exporting from automation.ts
 * keeps both call sites from drifting apart.
 *
 * Pure decision function (no DB/IO) so the branch is independently
 * unit-testable without standing up a WatcherRunTracker + Postgres.
 */
export function watcherRunSucceedsWithoutWindow(kind: WatcherKind): boolean {
  return kind === 'digest';
}

/**
 * Coerce a raw `approved_input->>'kind'` value to a concrete WatcherKind.
 * Older runs (queued before the `kind` column existed) have no `kind` in
 * approved_input — default to 'knowledge' so pre-existing behavior for those
 * runs is unchanged. An unrecognized value is also coerced to 'knowledge'
 * rather than propagated, since only 'knowledge' | 'digest' are valid.
 * Mirrors the identical coercion in automation.ts's parseWatcherRunPayload.
 */
function coerceWatcherKind(rawKind: unknown): WatcherKind {
  return rawKind === 'digest' ? 'digest' : 'knowledge';
}

export async function findWindowIdForRun(sql: DbClient, runId: number): Promise<number | null> {
  const rows = await sql`
    SELECT id
    FROM watcher_windows
    WHERE run_id = ${runId}
    ORDER BY id DESC
    LIMIT 1
  `;

  return rows.length > 0 ? Number((rows[0] as { id: unknown }).id) : null;
}

export async function markWatcherRunCompleted(
  sql: DbClient,
  runId: number,
  windowId: number | null
): Promise<void> {
  await sql`
    UPDATE runs
    SET status = 'completed',
        window_id = ${windowId},
        completed_at = current_timestamp,
        error_message = NULL
    WHERE id = ${runId}
      AND status = ANY(${runStatusLiteral(ACTIVE_RUN_STATUSES)}::text[])
  `;
}

async function markWatcherRunFailed(
  sql: DbClient,
  runId: number,
  message: string
): Promise<void> {
  await sql`
    UPDATE runs
    SET status = 'failed',
        completed_at = current_timestamp,
        error_message = ${message}
    WHERE id = ${runId}
      AND status = ANY(${runStatusLiteral(ACTIVE_RUN_STATUSES)}::text[])
  `;
}

export async function resolveWatcherRunsByMessageIds(
  messageIds: Iterable<string>,
  result: WatcherTerminalResult,
  db?: DbClient
): Promise<{ resolved: number }> {
  const ids = Array.from(new Set(Array.from(messageIds).filter(Boolean)));
  if (ids.length === 0) return { resolved: 0 };

  const sql = db ?? getDb();
  const rows = await sql`
    SELECT id, approved_input->>'kind' AS kind
    FROM runs
    WHERE run_type = 'watcher'
      AND dispatched_message_id = ANY(${pgTextArray(ids)}::text[])
      AND status = ANY(${runStatusLiteral(ACTIVE_RUN_STATUSES)}::text[])
  `;

  let resolved = 0;
  for (const row of rows) {
    const runId = Number((row as { id: unknown }).id);
    if (!Number.isFinite(runId)) continue;
    const kind = coerceWatcherKind((row as { kind: unknown }).kind);

    if (!result.ok) {
      await markWatcherRunFailed(sql, runId, result.error);
      resolved++;
      continue;
    }

    const windowId = await findWindowIdForRun(sql, runId);
    if (windowId === null) {
      if (watcherRunSucceedsWithoutWindow(kind)) {
        await markWatcherRunCompleted(sql, runId, null);
        resolved++;
        continue;
      }
      await markWatcherRunFailed(
        sql,
        runId,
        'Agent reply finished without calling manage_watchers(action="complete_window"). ' +
          'Check that the assigned agent has the lobu-memory MCP attached and that read_knowledge / ' +
          'manage_watchers tools are approved for it.'
      );
      resolved++;
      continue;
    }

    await markWatcherRunCompleted(sql, runId, windowId);
    resolved++;
  }

  return { resolved };
}
