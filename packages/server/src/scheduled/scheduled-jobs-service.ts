/**
 * scheduled_jobs CRUD + ticker.
 *
 * Model: a `scheduled_jobs` row is the *definition* of a recurring (or
 * one-shot) job. The ticker — registered as a TaskScheduler cron at
 * `* * * * *` — scans due rows and `scheduler.spawn`s a task per firing.
 * The actual handler execution rides on the existing runs-queue, with
 * claim/retry/idempotency/observability inherited.
 *
 * Firing flow:
 *   1. Tick reads cheap due candidates WHERE next_run_at <= now AND NOT paused AND not completed.
 *   2. For each candidate, lock the current row, enqueue the task, then advance/pause
 *      before releasing the row lock.
 * If enqueue fails, the transaction rolls back and the next tick re-reads the
 * same row. If a process crashes after enqueue before advance, task idempotency
 * dedups a retried enqueue. Self-healing.
 */

import { getDb } from '../db/client';
import type { DbClient } from '../db/client';
import { runtimeConnectionIdToSlug } from '../lobu/stores/connections-projection';
import { nextRunAt as nextCronTickAt } from '../utils/cron';
import logger from '../utils/logger';
import type { TaskScheduler } from './task-scheduler';
import { errorMessage } from '../utils/errors';

export interface ScheduledDeliveryContext {
  platform: string;
  conversationId: string;
  channelId: string;
  teamId?: string | null;
  connectionId: string;
  userId?: string | null;
}

/**
 * Chat platforms a scheduled wake can post its reply back into. Single source
 * of truth shared by the create-time gate (`manage_schedules`) and the
 * fire-time dispatch (`scheduled/jobs.ts`) so the two can never drift — a
 * platform accepted at creation but unhandled at execution would store a dead
 * `delivery_context` and silently fall back to the api path.
 */
export const DELIVERABLE_CHAT_PLATFORMS = ['slack', 'telegram'] as const;

export function isDeliverableChatPlatform(platform: string): boolean {
  return (DELIVERABLE_CHAT_PLATFORMS as readonly string[]).includes(platform);
}

export type DeliveryAuthzDenyReason =
  | 'connection-missing'
  | 'platform-changed'
  | 'connection-inactive'
  | 'agent-mismatch'
  | 'channel-unbound';

export type DeliveryAuthzResult =
  | { authorized: true }
  | { authorized: false; reason: DeliveryAuthzDenyReason };

/**
 * Is `agentId` authorized to deliver into the connection/channel named by a
 * delivery context? Single source of truth shared by the create-time gate
 * (`manage_schedules`, which maps the deny reason to a user-facing error) and
 * the fire-time re-check (`scheduled/jobs.ts`, which only needs the boolean).
 * Both must agree, and a cron can fire long after creation, so the same
 * validation runs at both points against the live connection + binding rows.
 */
export async function validateDeliveryAuthorization(params: {
  organizationId: string;
  agentId: string;
  delivery: ScheduledDeliveryContext;
}): Promise<DeliveryAuthzResult> {
  const sql = getDb();
  const { organizationId, agentId, delivery } = params;
  const connectionRows = (await sql`
    SELECT connector_key, agent_id, status
    FROM connections
    WHERE organization_id = ${organizationId}
      AND slug = ${runtimeConnectionIdToSlug(delivery.connectionId)}
      AND credential_mode IS NOT NULL
      AND deleted_at IS NULL
    LIMIT 1
  `) as unknown as Array<{
    connector_key: string;
    agent_id: string | null;
    status: string;
  }>;
  const connection = connectionRows[0];
  if (!connection) return { authorized: false, reason: 'connection-missing' };
  if (connection.connector_key !== delivery.platform) {
    return { authorized: false, reason: 'platform-changed' };
  }
  if (connection.status !== 'active') {
    return { authorized: false, reason: 'connection-inactive' };
  }
  if (connection.agent_id) {
    return connection.agent_id === agentId
      ? { authorized: true }
      : { authorized: false, reason: 'agent-mismatch' };
  }

  const bindingRows = delivery.teamId
    ? await sql`
        SELECT agent_id
        FROM agent_channel_bindings
        WHERE organization_id = ${organizationId}
          AND platform = ${delivery.platform}
          AND channel_id = ${delivery.channelId}
          AND team_id = ${delivery.teamId}
        LIMIT 1
      `
    : await sql`
        SELECT agent_id
        FROM agent_channel_bindings
        WHERE organization_id = ${organizationId}
          AND platform = ${delivery.platform}
          AND channel_id = ${delivery.channelId}
          AND team_id IS NULL
        LIMIT 1
      `;
  const binding = (bindingRows as unknown as Array<{ agent_id: string }>)[0];
  return binding?.agent_id === agentId
    ? { authorized: true }
    : { authorized: false, reason: 'channel-unbound' };
}

export interface ScheduledJobRow {
  id: string;
  organization_id: string;
  action_type: string;
  action_args: Record<string, unknown>;
  delivery_context: ScheduledDeliveryContext | null;
  cron: string | null;
  next_run_at: string;
  schedule_metadata: Record<string, unknown> | null;
  timezone: string | null;
  until_at: string | null;
  completed_at: string | null;
  idempotency_key: string | null;
  last_fired_at: string | null;
  last_fired_run_id: number | null;
  paused: boolean;
  description: string;
  created_by_user: string | null;
  created_by_agent: string | null;
  source_run_id: number | null;
  source_event_id: number | null;
  source_thread_id: string | null;
  created_at: string;
  updated_at: string;
}

interface CreateScheduledJobParams {
  organizationId: string;
  actionType: string;
  actionArgs: Record<string, unknown>;
  deliveryContext?: ScheduledDeliveryContext | null;
  description: string;
  cron?: string | null;
  runAt: Date;
  scheduleMetadata?: Record<string, unknown> | null;
  timezone?: string | null;
  untilAt?: Date | null;
  completedAt?: Date | null;
  idempotencyKey?: string | null;
  createdByUser?: string | null;
  createdByAgent?: string | null;
  sourceRunId?: number | null;
  sourceEventId?: number | null;
  sourceThreadId?: string | null;
}

export type SqlLike = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<unknown[]>;

export async function createScheduledJob(
  params: CreateScheduledJobParams
): Promise<ScheduledJobRow> {
  if (!params.createdByUser && !params.createdByAgent) {
    throw new Error('scheduled_jobs requires created_by_user or created_by_agent');
  }
  const sql = getDb();
  return createScheduledJobInDb(sql, params);
}

export async function createScheduledJobInDb(
  sql: Pick<DbClient, 'json'> & ((
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => Promise<unknown[]>),
  params: CreateScheduledJobParams
): Promise<ScheduledJobRow> {
  const rows = (await sql`
    INSERT INTO scheduled_jobs (
      organization_id, action_type, action_args, delivery_context, cron, next_run_at,
      description, schedule_metadata, timezone, until_at, completed_at, idempotency_key,
      created_by_user, created_by_agent,
      source_run_id, source_event_id, source_thread_id, paused
    ) VALUES (
      ${params.organizationId}, ${params.actionType},
      ${sql.json(params.actionArgs)}, ${params.deliveryContext ? sql.json(params.deliveryContext) : null}, ${params.cron ?? null}, ${params.runAt},
      ${params.description},
      ${params.scheduleMetadata == null ? null : sql.json(params.scheduleMetadata)},
      ${params.timezone ?? null}, ${params.untilAt ?? null}, ${params.completedAt ?? null},
      ${params.idempotencyKey ?? null},
      ${params.createdByUser ?? null}, ${params.createdByAgent ?? null},
      ${params.sourceRunId ?? null}, ${params.sourceEventId ?? null},
      ${params.sourceThreadId ?? null}, ${params.completedAt != null}
    )
    ON CONFLICT (organization_id, idempotency_key) WHERE idempotency_key IS NOT NULL
    DO UPDATE SET idempotency_key = scheduled_jobs.idempotency_key
    RETURNING *
  `) as unknown as ScheduledJobRow[];
  return rows[0];
}

export async function getScheduledJobByIdempotencyKey(
  organizationId: string,
  idempotencyKey: string
): Promise<ScheduledJobRow | null> {
  const sql = getDb();
  const rows = (await sql`
    SELECT * FROM scheduled_jobs
    WHERE organization_id = ${organizationId} AND idempotency_key = ${idempotencyKey}
    LIMIT 1
  `) as unknown as ScheduledJobRow[];
  return rows[0] ?? null;
}

export async function listScheduledJobs(opts: {
  organizationId: string;
  createdByAgent?: string | null;
  createdByUser?: string | null;
  actionType?: string | null;
  includePaused?: boolean;
}): Promise<ScheduledJobRow[]> {
  const sql = getDb();
  const includePaused = opts.includePaused ?? true;
  return (await sql`
    SELECT * FROM scheduled_jobs
    WHERE organization_id = ${opts.organizationId}
      AND (${opts.createdByAgent ?? null}::text IS NULL OR created_by_agent = ${opts.createdByAgent ?? null})
      AND (${opts.createdByUser ?? null}::text IS NULL OR created_by_user = ${opts.createdByUser ?? null})
      AND (${opts.actionType ?? null}::text IS NULL OR action_type = ${opts.actionType ?? null})
      AND (${includePaused} OR NOT paused)
    ORDER BY next_run_at ASC
  `) as unknown as ScheduledJobRow[];
}

export async function getScheduledJob(
  organizationId: string,
  id: string
): Promise<ScheduledJobRow | null> {
  const sql = getDb();
  const rows = (await sql`
    SELECT * FROM scheduled_jobs
    WHERE organization_id = ${organizationId} AND id = ${id}
    LIMIT 1
  `) as unknown as ScheduledJobRow[];
  return rows[0] ?? null;
}

export async function pauseScheduledJob(
  organizationId: string,
  id: string,
  paused: boolean
): Promise<boolean> {
  const sql = getDb();
  return pauseScheduledJobInDb(sql, organizationId, id, paused);
}

export async function pauseScheduledJobInDb(
  sql: SqlLike,
  organizationId: string,
  id: string,
  paused: boolean
): Promise<boolean> {
  const rows = (await sql`
    UPDATE scheduled_jobs
    SET paused = ${paused}, updated_at = now()
    WHERE organization_id = ${organizationId}
      AND id = ${id}
      AND (${paused} OR completed_at IS NULL)
    RETURNING id
  `) as unknown as Array<{ id: string }>;
  return rows.length > 0;
}

interface UpdateScheduledJobParams {
  organizationId: string;
  id: string;
  description?: string;
  /** `null` clears the cron (recurring → one-shot); a string sets a new cadence. */
  cron?: string | null;
  /** Reschedule the next firing. */
  runAt?: Date;
  /** Replace the durable action payload (e.g. a new wake_agent prompt). */
  actionArgs?: Record<string, unknown>;
}

/**
 * Patch the mutable fields of a schedule (description / cron / next firing /
 * payload). Attribution, action_type and delivery_context are immutable — a
 * different target or handler is a new schedule, not an edit. Every param is
 * optional; omitted fields keep their current value via COALESCE, except
 * `cron` which is deliberately settable to NULL (recurring → one-shot).
 */
export async function updateScheduledJob(
  params: UpdateScheduledJobParams
): Promise<ScheduledJobRow | null> {
  const sql = getDb();
  const setCron = params.cron !== undefined;
  const rows = (await sql`
    UPDATE scheduled_jobs
    SET
      description = COALESCE(${params.description ?? null}, description),
      cron = CASE WHEN ${setCron} THEN ${params.cron ?? null} ELSE cron END,
      next_run_at = COALESCE(${params.runAt ?? null}, next_run_at),
      action_args = COALESCE(${params.actionArgs ? sql.json(params.actionArgs) : null}, action_args),
      updated_at = now()
    WHERE organization_id = ${params.organizationId} AND id = ${params.id}
    RETURNING *
  `) as unknown as ScheduledJobRow[];
  return rows[0] ?? null;
}

export async function deleteScheduledJob(
  organizationId: string,
  id: string
): Promise<boolean> {
  const sql = getDb();
  const rows = (await sql`
    DELETE FROM scheduled_jobs
    WHERE organization_id = ${organizationId} AND id = ${id}
    RETURNING id
  `) as unknown as Array<{ id: string }>;
  return rows.length > 0;
}

type ScheduledJobsTickSql = Pick<DbClient, 'begin'> & SqlLike;
type ScheduledJobsTickScheduler = Pick<TaskScheduler, 'spawn'>;

async function completeExpiredScheduledJob(
  sql: ScheduledJobsTickSql,
  id: string
): Promise<boolean> {
  const rows = (await sql`
    UPDATE scheduled_jobs
    SET paused = true,
        completed_at = COALESCE(completed_at, now()),
        updated_at = now()
    WHERE id = ${id}
      AND next_run_at <= now()
      AND NOT paused
      AND completed_at IS NULL
      AND until_at IS NOT NULL
      AND next_run_at > until_at
    RETURNING id
  `) as unknown as Array<{ id: string }>;
  return rows.length > 0;
}

async function completeScheduledJobAfterFire(
  sql: ScheduledJobsTickSql,
  id: string
): Promise<void> {
  await sql`
    UPDATE scheduled_jobs
    SET last_fired_at = now(),
        paused = true,
        completed_at = COALESCE(completed_at, now()),
        updated_at = now()
    WHERE id = ${id}
      AND next_run_at <= now()
      AND NOT paused
      AND completed_at IS NULL
  `;
}

function exceedsUntilAt(nextAt: string, untilAt: string | null): boolean {
  if (!untilAt) return false;
  return new Date(nextAt).getTime() > new Date(untilAt).getTime();
}

async function claimEnqueueAndAdvanceScheduledJob(
  sql: ScheduledJobsTickSql,
  scheduler: ScheduledJobsTickScheduler,
  id: string
): Promise<void> {
  await sql.begin(async (tx) => {
    const rows = (await tx`
      SELECT *
      FROM scheduled_jobs
      WHERE id = ${id}
        AND next_run_at <= now()
        AND NOT paused
        AND completed_at IS NULL
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `) as unknown as ScheduledJobRow[];
    const row = rows[0];
    if (!row) return;

    if (exceedsUntilAt(row.next_run_at, row.until_at)) {
      await completeExpiredScheduledJob(tx, row.id);
      return;
    }

    const tickIso = row.next_run_at;
    const idempotencyKey = `scheduled_job:${row.id}:${tickIso}`;
    await scheduler.spawn(row.action_type, {
      ...row.action_args,
      __scheduled_job_id: row.id,
      __delivery_context: row.delivery_context,
      __scheduled_job_tick: tickIso,
      __organization_id: row.organization_id,
      __created_by_user: row.created_by_user,
      __created_by_agent: row.created_by_agent,
    }, { idempotencyKey });

    const nextAt = row.cron ? nextCronTickAt(row.cron) : null;
    if (nextAt && !exceedsUntilAt(nextAt, row.until_at)) {
      await tx`
        UPDATE scheduled_jobs
        SET last_fired_at = now(), next_run_at = ${nextAt}, updated_at = now()
        WHERE id = ${row.id}
          AND next_run_at <= now()
          AND NOT paused
          AND completed_at IS NULL
      `;
    } else {
      await completeScheduledJobAfterFire(tx, row.id);
    }
  });
}

export async function runScheduledJobsTick(
  sql: ScheduledJobsTickSql,
  scheduler: ScheduledJobsTickScheduler
): Promise<void> {
  const candidates = (await sql`
    SELECT id
    FROM scheduled_jobs
    WHERE next_run_at <= now()
      AND NOT paused
      AND completed_at IS NULL
    ORDER BY next_run_at ASC
    LIMIT 200
  `) as unknown as Array<{ id: string }>;
  if (candidates.length === 0) return;

  for (const row of candidates) {
    try {
      await claimEnqueueAndAdvanceScheduledJob(sql, scheduler, row.id);
    } catch (err) {
      logger.warn(
        { scheduled_job_id: row.id, err: errorMessage(err) },
        '[scheduled-jobs-tick] spawn failed; leaving next_run_at unchanged for retry'
      );
    }
  }
}

/**
 * Register the per-minute tick. Call once during bootTaskScheduler.
 *
 * The handler reads due candidates, then claims each row transactionally
 * (FOR UPDATE SKIP LOCKED so concurrent pods coordinate without an advisory
 * lock), spawns one task per row, and advances next_run_at before releasing
 * the row lock. A handler crash before advance leaves rows due — next minute's
 * tick retries them. Per-row idempotency key `scheduled_job:<id>:<tick-iso>`
 * deduplicates if a crash happens after enqueue but before advance.
 */
export function registerScheduledJobsTicker(scheduler: TaskScheduler): void {
  scheduler.register(
    'scheduled-jobs-tick',
    async () => {
      const sql = getDb();
      await runScheduledJobsTick(sql, scheduler);
    },
    { cron: '* * * * *' }
  );
}
