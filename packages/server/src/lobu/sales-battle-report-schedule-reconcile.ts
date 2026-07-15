import { getDb, pgTextArray } from "../db/client.js";
import type { ScheduledJobRow } from "../scheduled/scheduled-jobs-service.js";
import { nextRunAt } from "../utils/cron.js";

export type SalesBattleReportDesiredState = "active" | "paused" | "deleted";

export interface ReconcileSalesBattleReportScheduleInput {
	organizationId: string;
	createdByUser: string;
	agentId: string;
	toolboxScheduleId: string;
	scheduleRevision: number;
	courseName: string;
	salesTalkWeekdays: number[];
	desiredState: SalesBattleReportDesiredState;
}

export interface ReconcileSalesBattleReportScheduleResult {
	ok: true;
	acceptedRevision: number;
	reconciled: {
		created: string[];
		updated: string[];
		paused: string[];
		deletedDuplicates: string[];
	};
	observerRefs: string[];
}

export interface StaleSalesBattleReportScheduleResult {
	ok: false;
	error: "stale_revision";
	acceptedRevision: number;
}

export interface ConflictingSalesBattleReportObserverKeyResult {
	ok: false;
	error: "observer_external_key_conflict";
	conflictingJobIds: string[];
}

const OBSERVER_ACTION_TYPE = "sales_battle_report_observer";
const OBSERVER_CRON = "0 16 * * *";

export function observerExternalKey(input: {
	toolboxScheduleId: string;
	weekday: number;
}): string {
	return `toolbox:sales-battle-report:${input.toolboxScheduleId}:weekday:${input.weekday}:observer`;
}

function observerArgs(
	input: ReconcileSalesBattleReportScheduleInput,
	weekday: number,
): Record<string, unknown> {
	return {
		toolboxScheduleId: input.toolboxScheduleId,
		scheduleRevision: input.scheduleRevision,
		salesTalkWeekday: weekday,
		courseName: input.courseName,
		agentId: input.agentId,
	};
}

function sameObserver(
	row: ScheduledJobRow,
	input: ReconcileSalesBattleReportScheduleInput,
	weekday: number,
): boolean {
	const args = actionArgsObject(row);
	if (!args) return false;
	return (
		row.external_key ===
			observerExternalKey({
				toolboxScheduleId: input.toolboxScheduleId,
				weekday,
			}) &&
		row.action_type === OBSERVER_ACTION_TYPE &&
		Number(row.schedule_revision) === input.scheduleRevision &&
		row.cron === OBSERVER_CRON &&
		row.created_by_user === input.createdByUser &&
		args.toolboxScheduleId === input.toolboxScheduleId &&
		args.scheduleRevision === input.scheduleRevision &&
		args.salesTalkWeekday === weekday &&
		args.courseName === input.courseName &&
		args.agentId === input.agentId
	);
}

function observerWeekday(row: ScheduledJobRow): number {
	const args = actionArgsObject(row);
	return args ? Number(args.salesTalkWeekday) : Number.NaN;
}

function actionArgsObject(
	row: ScheduledJobRow,
): Record<string, unknown> | null {
	const value: unknown = row.action_args;
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function isOwnedObserver(
	row: ScheduledJobRow,
	toolboxScheduleId: string,
): boolean {
	const args = actionArgsObject(row);
	return (
		row.action_type === OBSERVER_ACTION_TYPE &&
		args?.toolboxScheduleId === toolboxScheduleId
	);
}

function preferredObserver(
	left: ScheduledJobRow,
	right: ScheduledJobRow,
): number {
	if (left.paused !== right.paused) return left.paused ? 1 : -1;
	const revisionDelta = observerRevision(right) - observerRevision(left);
	if (revisionDelta !== 0) return revisionDelta;
	const leftCreatedAt = new Date(left.created_at).getTime();
	const rightCreatedAt = new Date(right.created_at).getTime();
	const createdDelta =
		(Number.isFinite(rightCreatedAt) ? rightCreatedAt : 0) -
		(Number.isFinite(leftCreatedAt) ? leftCreatedAt : 0);
	if (createdDelta !== 0) return createdDelta;
	return right.id.localeCompare(left.id);
}

function observerRevision(row: ScheduledJobRow): number {
	const actionRevision = actionArgsObject(row)?.scheduleRevision;
	if (
		typeof actionRevision === "number" &&
		Number.isSafeInteger(actionRevision) &&
		actionRevision > 0
	) {
		return actionRevision;
	}
	const storedRevision: unknown = row.schedule_revision;
	if (
		typeof storedRevision === "number" &&
		Number.isSafeInteger(storedRevision) &&
		storedRevision > 0
	) {
		return storedRevision;
	}
	return 0;
}

export async function reconcileSalesBattleReportSchedule(
	input: ReconcileSalesBattleReportScheduleInput,
): Promise<
	| ReconcileSalesBattleReportScheduleResult
	| StaleSalesBattleReportScheduleResult
	| ConflictingSalesBattleReportObserverKeyResult
> {
	const sql = getDb();
	return sql.begin(async (tx) => {
		await tx`
			SELECT pg_advisory_xact_lock(
				hashtext(${input.organizationId}),
				hashtext(${input.toolboxScheduleId})
			)
		`;

		const syncRows = await tx<
			Array<{ last_accepted_revision: number; desired_state: string }>
		>`
			SELECT last_accepted_revision, desired_state
			FROM toolbox_sales_battle_report_schedule_sync
			WHERE organization_id = ${input.organizationId}
			  AND toolbox_schedule_id = ${input.toolboxScheduleId}
			FOR UPDATE
		`;
		const acceptedRevision = syncRows[0]?.last_accepted_revision;
		if (
			acceptedRevision !== undefined &&
			input.scheduleRevision < acceptedRevision
		) {
			return {
				ok: false,
				error: "stale_revision",
				acceptedRevision,
			};
		}

		const canonicalExternalKeys = Array.from({ length: 7 }, (_, weekday) =>
			observerExternalKey({
				toolboxScheduleId: input.toolboxScheduleId,
				weekday,
			}),
		);
		const lockedRows = (await tx`
			SELECT *
			FROM scheduled_jobs
			WHERE organization_id = ${input.organizationId}
			  AND (
				(action_type = ${OBSERVER_ACTION_TYPE}
				 AND action_args->>'toolboxScheduleId' = ${input.toolboxScheduleId})
				OR external_key = ANY(${pgTextArray(canonicalExternalKeys)}::text[])
			  )
			ORDER BY created_at ASC
			FOR UPDATE
		`) as unknown as ScheduledJobRow[];
		const existing = lockedRows.filter((row) =>
			isOwnedObserver(row, input.toolboxScheduleId),
		);

		const created: string[] = [];
		const updated: string[] = [];
		const paused: string[] = [];
		const deletedDuplicates: string[] = [];
		const observerRefs: string[] = [];
		const normalizedWeekdays = [...new Set(input.salesTalkWeekdays)].sort(
			(left, right) => left - right,
		);
		const desiredWeekdays = new Set(normalizedWeekdays);

		if (acceptedRevision === input.scheduleRevision) {
			return {
				ok: true,
				acceptedRevision,
				reconciled: { created, updated, paused, deletedDuplicates },
				observerRefs: existing
					.filter((row) => !row.paused)
					.sort((left, right) => {
						const weekdayDelta = observerWeekday(left) - observerWeekday(right);
						return weekdayDelta || left.id.localeCompare(right.id);
					})
					.map((row) => row.id),
			};
		}
		const matchingIds = new Set(existing.map((row) => row.id));
		const conflictingJobIds = lockedRows
			.filter((row) => !matchingIds.has(row.id))
			.map((row) => row.id)
			.sort();
		if (conflictingJobIds.length > 0) {
			return {
				ok: false,
				error: "observer_external_key_conflict",
				conflictingJobIds,
			};
		}

		const originalExternalKeys = new Map(
			existing.map((row) => [row.id, row.external_key]),
		);
		for (const row of existing) {
			if (row.external_key === null) continue;
			await tx`
				UPDATE scheduled_jobs
				SET external_key = NULL, updated_at = now()
				WHERE id = ${row.id}
			`;
			row.external_key = null;
		}

		const candidatesByWeekday = new Map<number, ScheduledJobRow[]>();
		for (const row of existing) {
			const weekday = observerWeekday(row);
			const candidates = candidatesByWeekday.get(weekday) ?? [];
			candidates.push(row);
			candidatesByWeekday.set(weekday, candidates);
		}

		const survivors = new Map<number, ScheduledJobRow>();
		for (const [weekday, candidates] of candidatesByWeekday) {
			const [survivor, ...duplicates] = candidates.sort(preferredObserver);
			survivors.set(weekday, survivor);
			for (const duplicate of duplicates) {
				await tx`DELETE FROM scheduled_jobs WHERE id = ${duplicate.id}`;
				deletedDuplicates.push(duplicate.id);
			}
		}

		const repairedExternalKeys = new Set<string>();
		for (const [weekday, survivor] of survivors) {
			if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) continue;
			const externalKey = observerExternalKey({
				toolboxScheduleId: input.toolboxScheduleId,
				weekday,
			});
			await tx`
				UPDATE scheduled_jobs
				SET external_key = ${externalKey}, updated_at = now()
				WHERE id = ${survivor.id}
			`;
			survivor.external_key = externalKey;
			if (originalExternalKeys.get(survivor.id) !== externalKey) {
				repairedExternalKeys.add(survivor.id);
			}
		}

		if (input.desiredState === "active") {
			for (const weekday of normalizedWeekdays) {
				const externalKey = observerExternalKey({
					toolboxScheduleId: input.toolboxScheduleId,
					weekday,
				});
				const survivor = survivors.get(weekday);
				if (!survivor) {
					const rows = (await tx`
						INSERT INTO scheduled_jobs (
							external_key, schedule_revision, organization_id, action_type,
							action_args, cron, next_run_at, description,
							created_by_user, created_by_agent
						) VALUES (
							${externalKey}, ${input.scheduleRevision}, ${input.organizationId},
							${OBSERVER_ACTION_TYPE}, ${tx.json(observerArgs(input, weekday))},
							${OBSERVER_CRON}, ${nextRunAt(OBSERVER_CRON)},
							${`Sales battle report observer: ${input.courseName} (weekday ${weekday})`},
							${input.createdByUser}, NULL
						)
						RETURNING *
					`) as unknown as ScheduledJobRow[];
					created.push(rows[0].id);
					observerRefs.push(rows[0].id);
					continue;
				}

				let active = survivor;
				if (survivor.paused || !sameObserver(survivor, input, weekday)) {
					const rows = (await tx`
						UPDATE scheduled_jobs
						SET external_key = ${externalKey},
							schedule_revision = ${input.scheduleRevision},
							action_type = ${OBSERVER_ACTION_TYPE},
							action_args = ${tx.json(observerArgs(input, weekday))},
							cron = ${OBSERVER_CRON},
							next_run_at = ${nextRunAt(OBSERVER_CRON)},
							description = ${`Sales battle report observer: ${input.courseName} (weekday ${weekday})`},
							created_by_user = ${input.createdByUser}, created_by_agent = NULL,
							paused = false, updated_at = now()
						WHERE id = ${survivor.id}
						RETURNING *
					`) as unknown as ScheduledJobRow[];
					active = rows[0];
					updated.push(active.id);
				}
				observerRefs.push(active.id);
			}
		}

		for (const [weekday, survivor] of survivors) {
			const shouldPause =
				input.desiredState !== "active" || !desiredWeekdays.has(weekday);
			if (shouldPause && !survivor.paused) {
				await tx`
					UPDATE scheduled_jobs
					SET paused = true, updated_at = now()
					WHERE id = ${survivor.id}
				`;
				paused.push(survivor.id);
			}
		}
		for (const id of repairedExternalKeys) {
			if (!updated.includes(id)) updated.push(id);
		}

		await tx`
			INSERT INTO toolbox_sales_battle_report_schedule_sync (
				organization_id, toolbox_schedule_id, last_accepted_revision, desired_state
			) VALUES (
				${input.organizationId}, ${input.toolboxScheduleId},
				${input.scheduleRevision}, ${input.desiredState}
			)
			ON CONFLICT (organization_id, toolbox_schedule_id) DO UPDATE
			SET last_accepted_revision = EXCLUDED.last_accepted_revision,
				desired_state = EXCLUDED.desired_state,
				updated_at = now()
		`;

		return {
			ok: true,
			acceptedRevision: input.scheduleRevision,
			reconciled: { created, updated, paused, deletedDuplicates },
			observerRefs,
		};
	});
}
