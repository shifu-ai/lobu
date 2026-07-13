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
 *   1. Tick claims rows WHERE next_run_at <= now AND NOT paused.
 *   2. For each row, spawn(action_type, action_args, { idempotencyKey, runAt: now }).
 *   3. Advance last_fired_at + next_run_at (or pause if one-shot completed).
 * If the tick crashes between step 2 and 3, the next tick re-reads the
 * same row (next_run_at not advanced) and re-spawns — idempotency dedup
 * stops duplicates. Self-healing.
 */

import { getDb } from "../db/client";
import { nextRunAt as nextCronTickAt } from "../utils/cron";
import { errorMessage } from "../utils/errors";
import logger from "../utils/logger";
import type { TaskScheduler } from "./task-scheduler";

export interface ScheduledJobRow {
	id: string;
	external_key: string | null;
	schedule_revision: number;
	organization_id: string;
	action_type: string;
	action_args: Record<string, unknown>;
	cron: string | null;
	next_run_at: string;
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

export interface CreateScheduledJobParams {
	organizationId: string;
	actionType: string;
	actionArgs: Record<string, unknown>;
	description: string;
	cron?: string | null;
	runAt: Date;
	createdByUser?: string | null;
	createdByAgent?: string | null;
	sourceRunId?: number | null;
	sourceEventId?: number | null;
	sourceThreadId?: string | null;
}

export type UpsertScheduledJobByExternalKeyParams = CreateScheduledJobParams & {
	externalKey: string;
};

export async function upsertScheduledJobByExternalKey(
	params: UpsertScheduledJobByExternalKeyParams,
): Promise<ScheduledJobRow> {
	if (!params.externalKey.trim()) throw new Error("externalKey is required");
	if (!params.createdByUser)
		throw new Error("external-key schedules require created_by_user");
	const sql = getDb();
	return sql.begin(async (tx) => {
		await tx`
      SELECT pg_advisory_xact_lock(
        hashtext(${params.organizationId}),
        hashtext(${`${params.createdByUser}:${params.externalKey}`})
      )
    `;
		const existingRows = (await tx`
      SELECT * FROM scheduled_jobs
      WHERE organization_id = ${params.organizationId}
        AND created_by_user = ${params.createdByUser}
        AND external_key = ${params.externalKey}
      FOR UPDATE
    `) as unknown as ScheduledJobRow[];
		const existing = existingRows[0];
		if (!existing) {
			const rows = (await tx`
        INSERT INTO scheduled_jobs (
          external_key, organization_id, action_type, action_args, cron, next_run_at,
          description, created_by_user, created_by_agent,
          source_run_id, source_event_id, source_thread_id
        ) VALUES (
          ${params.externalKey}, ${params.organizationId}, ${params.actionType},
          ${tx.json(params.actionArgs)}, ${params.cron ?? null}, ${params.runAt},
          ${params.description}, ${params.createdByUser}, ${params.createdByAgent ?? null},
          ${params.sourceRunId ?? null}, ${params.sourceEventId ?? null}, ${params.sourceThreadId ?? null}
        )
        RETURNING *
      `) as unknown as ScheduledJobRow[];
			return rows[0];
		}

		const oldWake = trustedWakeIdentity(existing.action_args);
		const newWake = trustedWakeIdentity(params.actionArgs);
		const changed =
			oldWake.eventVersion !== newWake.eventVersion ||
			oldWake.scheduledFor !== newWake.scheduledFor ||
			oldWake.payloadIdentity !== newWake.payloadIdentity ||
			existing.created_by_user !== params.createdByUser ||
			existing.created_by_agent !== (params.createdByAgent ?? null);
		if (!changed || params.runAt.getTime() <= Date.now()) return existing;

		const rows = (await tx`
      UPDATE scheduled_jobs SET
        action_type = ${params.actionType}, action_args = ${tx.json(params.actionArgs)},
        cron = ${params.cron ?? null}, next_run_at = ${params.runAt},
        description = ${params.description}, created_by_agent = ${params.createdByAgent ?? null},
        source_run_id = ${params.sourceRunId ?? null}, source_event_id = ${params.sourceEventId ?? null},
        source_thread_id = ${params.sourceThreadId ?? null}, paused = false,
        last_fired_at = NULL, last_fired_run_id = NULL,
        schedule_revision = schedule_revision + 1, updated_at = now()
      WHERE id = ${existing.id}
      RETURNING *
    `) as unknown as ScheduledJobRow[];
		return rows[0];
	});
}

export interface CancelTrustedCourseWakeParams {
	engineRef: string;
	externalKey: string;
	organizationId: string;
	ownerUserId: string;
	agentId: string;
}

export async function cancelTrustedCourseWake(
	params: CancelTrustedCourseWakeParams,
): Promise<{ found: boolean; alreadyCancelled: boolean }> {
	const sql = getDb();
	return sql.begin(async (tx) => {
		const rows = (await tx`
      SELECT id, paused FROM scheduled_jobs
      WHERE id = ${params.engineRef}
        AND organization_id = ${params.organizationId}
        AND external_key = ${params.externalKey}
        AND created_by_user = ${params.ownerUserId}
        AND created_by_agent = ${params.agentId}
        AND action_type = 'wake_agent'
        AND action_args->>'reason' = 'trusted-course-calendar-wake'
        AND action_args->'trustedCourseWake'->>'source' = 'calendar_scheduled_wake'
        AND action_args->'trustedCourseWake'->'trustedCourseScope'->>'ownerUserId' = ${params.ownerUserId}
        AND action_args->'trustedCourseWake'->'trustedCourseScope'->>'agentId' = ${params.agentId}
      FOR UPDATE
    `) as unknown as Array<{ id: string; paused: boolean }>;
		const row = rows[0];
		if (!row) return { found: false, alreadyCancelled: false };
		if (row.paused) return { found: true, alreadyCancelled: true };
		await tx`
      UPDATE scheduled_jobs
      SET paused = true, updated_at = now()
      WHERE id = ${row.id}
    `;
		return { found: true, alreadyCancelled: false };
	});
}

function trustedWakeIdentity(actionArgs: Record<string, unknown>): {
	eventVersion: string | null;
	scheduledFor: string | null;
	payloadIdentity: string;
} {
	const wake = asRecord(actionArgs.trustedCourseWake);
	const eventRef = asRecord(wake?.calendarEventRef);
	return {
		eventVersion:
			typeof eventRef?.eventVersion === "string" ? eventRef.eventVersion : null,
		scheduledFor:
			typeof wake?.scheduledFor === "string" ? wake.scheduledFor : null,
		payloadIdentity: canonicalJson(wake),
	};
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

export async function createScheduledJob(
	params: CreateScheduledJobParams,
): Promise<ScheduledJobRow> {
	if (!params.createdByUser && !params.createdByAgent) {
		throw new Error(
			"scheduled_jobs requires created_by_user or created_by_agent",
		);
	}
	const sql = getDb();
	const rows = (await sql`
    INSERT INTO scheduled_jobs (
      organization_id, action_type, action_args, cron, next_run_at,
      description,
      created_by_user, created_by_agent,
      source_run_id, source_event_id, source_thread_id
    ) VALUES (
      ${params.organizationId}, ${params.actionType},
      ${sql.json(params.actionArgs)}, ${params.cron ?? null}, ${params.runAt},
      ${params.description},
      ${params.createdByUser ?? null}, ${params.createdByAgent ?? null},
      ${params.sourceRunId ?? null}, ${params.sourceEventId ?? null},
      ${params.sourceThreadId ?? null}
    )
    RETURNING *
  `) as unknown as ScheduledJobRow[];
	return rows[0];
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

// SHIFU FORK: member self-scoping quota (member-scope-internal-tools plan,
// Task 3). Members can create schedules for their own agent/notifications;
// this caps how many un-paused schedules a single user can accumulate so a
// runaway loop can't flood the ticker. Counts across the whole org for that
// user, not per-agent, since a member may hold more than one agent.
export async function countActiveScheduledJobs(
	organizationId: string,
	userId: string | null,
): Promise<number> {
	const sql = getDb();
	const rows = (await sql`
    SELECT count(*)::int AS count FROM scheduled_jobs
    WHERE organization_id = ${organizationId}
      AND created_by_user = ${userId}
      AND NOT paused
  `) as unknown as Array<{ count: number }>;
	return rows[0]?.count ?? 0;
}

// SHIFU FORK: member-scope-internal-tools plan, Task 3 follow-up. Some
// LINE-side callers of manage_schedules(wake_agent) don't know their own
// bare agent id and fill `agent_id` with the full CONVERSATION id instead
// (`<agentId>_<userId>_<threadId>`). Agent ids never contain an underscore
// (`/^shifu-u-[a-z0-9-]+$/`), so a conversation id is always the longest
// `agents.id` row that is a `<id>_`-prefix of the given string. Used both at
// schedule-create time (manage_schedules.ts, to persist the clean bare id)
// and at wake-fire time (jobs.ts, defense in depth for rows persisted before
// this fix or written by a still-buggy caller).
export type SqlLike = (
	strings: TemplateStringsArray,
	...values: unknown[]
) => Promise<unknown[]>;

export async function resolveWakeAgentId(
	sql: SqlLike,
	organizationId: string,
	rawAgentId: string,
): Promise<string | null> {
	const exactRows = (await sql`
    SELECT id FROM agents WHERE id = ${rawAgentId} AND organization_id = ${organizationId} LIMIT 1
  `) as unknown as Array<{ id: string }>;
	if (exactRows.length > 0) return exactRows[0].id;

	const prefixRows = (await sql`
    SELECT id FROM agents
    WHERE organization_id = ${organizationId}
      AND ${rawAgentId} LIKE id || '\\_%' ESCAPE '\\'
    ORDER BY length(id) DESC
    LIMIT 1
  `) as unknown as Array<{ id: string }>;
	return prefixRows[0]?.id ?? null;
}

export async function getScheduledJob(
	organizationId: string,
	id: string,
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
	paused: boolean,
): Promise<boolean> {
	const sql = getDb();
	const rows = (await sql`
    UPDATE scheduled_jobs
    SET paused = ${paused}, updated_at = now()
    WHERE organization_id = ${organizationId} AND id = ${id}
    RETURNING id
  `) as unknown as Array<{ id: string }>;
	return rows.length > 0;
}

export async function deleteScheduledJob(
	organizationId: string,
	id: string,
): Promise<boolean> {
	const sql = getDb();
	const rows = (await sql`
    DELETE FROM scheduled_jobs
    WHERE organization_id = ${organizationId} AND id = ${id}
    RETURNING id
  `) as unknown as Array<{ id: string }>;
	return rows.length > 0;
}

export interface ScheduledJobCandidate {
	id: string;
	schedule_revision: number;
}

/**
 * Dispatch one scanned candidate while holding its row lock. The revision
 * predicate discards candidates made stale by a reschedule that committed
 * after the scan. Holding the lock through spawn makes reschedule-vs-fire
 * linearizable across replicas: either the reschedule commits first and the
 * stale revision cannot spawn, or the firing commits first and reschedule is
 * explicitly the later operation.
 */
export async function dispatchScheduledJobCandidate(
	candidate: ScheduledJobCandidate,
	scheduler: Pick<TaskScheduler, "spawn">,
): Promise<void> {
	const sql = getDb();
	await sql.begin(async (tx) => {
		const rows = (await tx`
      SELECT * FROM scheduled_jobs
      WHERE id = ${candidate.id}
        AND schedule_revision = ${candidate.schedule_revision}
        AND next_run_at <= now()
        AND NOT paused
      FOR UPDATE SKIP LOCKED
    `) as unknown as ScheduledJobRow[];
		const row = rows[0];
		if (!row) return;

		const tickIso = row.next_run_at;
		const idempotencyKey = `scheduled_job:${row.id}:r${row.schedule_revision}:${tickIso}`;
		try {
			await scheduler.spawn(
				row.action_type,
				{
					...row.action_args,
						__scheduled_job_id: row.id,
						__scheduled_job_external_key: row.external_key,
					__scheduled_job_tick: tickIso,
					__scheduled_job_revision: row.schedule_revision,
					__organization_id: row.organization_id,
					__created_by_user: row.created_by_user,
					__created_by_agent: row.created_by_agent,
				},
				{ idempotencyKey },
			);
		} catch (err) {
			logger.warn(
				{ scheduled_job_id: row.id, err: errorMessage(err) },
				"[scheduled-jobs-tick] spawn failed; leaving next_run_at unchanged for retry",
			);
			return;
		}

		const nextAt = row.cron ? nextCronTickAt(row.cron) : null;
		if (nextAt) {
			await tx`
        UPDATE scheduled_jobs
        SET last_fired_at = now(), next_run_at = ${nextAt}, updated_at = now()
        WHERE id = ${row.id} AND schedule_revision = ${row.schedule_revision}
      `;
		} else {
			await tx`
        UPDATE scheduled_jobs
        SET last_fired_at = now(), paused = true, updated_at = now()
        WHERE id = ${row.id} AND schedule_revision = ${row.schedule_revision}
      `;
		}
	});
}

/** Register the per-minute scheduled-jobs scan. */
export function registerScheduledJobsTicker(scheduler: TaskScheduler): void {
	scheduler.register(
		"scheduled-jobs-tick",
		async () => {
			const sql = getDb();
			const candidates = (await sql`
        SELECT id, schedule_revision
        FROM scheduled_jobs
        WHERE next_run_at <= now() AND NOT paused
        ORDER BY next_run_at ASC
        LIMIT 200
      `) as unknown as ScheduledJobCandidate[];
			for (const candidate of candidates) {
				await dispatchScheduledJobCandidate(candidate, scheduler);
			}
		},
		{ cron: "* * * * *" },
	);
}
