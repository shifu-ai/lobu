import { getDb } from "../db/client.js";
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
	const args = row.action_args;
	return (
		row.external_key ===
			observerExternalKey({
				toolboxScheduleId: input.toolboxScheduleId,
				weekday,
			}) &&
		row.action_type === OBSERVER_ACTION_TYPE &&
		row.cron === OBSERVER_CRON &&
		row.created_by_user === input.createdByUser &&
		args.toolboxScheduleId === input.toolboxScheduleId &&
		args.scheduleRevision === input.scheduleRevision &&
		args.salesTalkWeekday === weekday &&
		args.courseName === input.courseName &&
		args.agentId === input.agentId
	);
}

export async function reconcileSalesBattleReportSchedule(
	input: ReconcileSalesBattleReportScheduleInput,
): Promise<ReconcileSalesBattleReportScheduleResult> {
	const sql = getDb();
	return sql.begin(async (tx) => {
		await tx`
			SELECT pg_advisory_xact_lock(
				hashtext(${input.organizationId}),
				hashtext(${input.toolboxScheduleId})
			)
		`;

		const existing = (await tx`
			SELECT *
			FROM scheduled_jobs
			WHERE organization_id = ${input.organizationId}
			  AND action_type = ${OBSERVER_ACTION_TYPE}
			  AND action_args->>'toolboxScheduleId' = ${input.toolboxScheduleId}
			ORDER BY created_at ASC
			FOR UPDATE
		`) as unknown as ScheduledJobRow[];

		const created: string[] = [];
		const updated: string[] = [];
		const paused: string[] = [];
		const deletedDuplicates: string[] = [];
		const observerRefs: string[] = [];
		const desiredWeekdays = new Set(input.salesTalkWeekdays);

		if (input.desiredState === "active") {
			for (const weekday of input.salesTalkWeekdays) {
				const externalKey = observerExternalKey({
					toolboxScheduleId: input.toolboxScheduleId,
					weekday,
				});
				const candidates = existing.filter(
					(row) => Number(row.action_args.salesTalkWeekday) === weekday,
				);
				const canonical =
					candidates.find((row) => row.external_key === externalKey) ??
					candidates[0];

				if (!canonical) {
					const rows = (await tx`
						INSERT INTO scheduled_jobs (
							external_key, organization_id, action_type, action_args, cron,
							next_run_at, description, created_by_user, created_by_agent
						) VALUES (
							${externalKey}, ${input.organizationId}, ${OBSERVER_ACTION_TYPE},
							${tx.json(observerArgs(input, weekday))}, ${OBSERVER_CRON},
							${nextRunAt(OBSERVER_CRON)},
							${`Sales battle report observer: ${input.courseName} (weekday ${weekday})`},
							${input.createdByUser}, NULL
						)
						RETURNING *
					`) as unknown as ScheduledJobRow[];
					created.push(rows[0].id);
					observerRefs.push(rows[0].id);
					continue;
				}

				let active = canonical;
				if (canonical.paused || !sameObserver(canonical, input, weekday)) {
					const rows = (await tx`
						UPDATE scheduled_jobs
						SET external_key = ${externalKey},
							action_type = ${OBSERVER_ACTION_TYPE},
							action_args = ${tx.json(observerArgs(input, weekday))},
							cron = ${OBSERVER_CRON},
							next_run_at = ${nextRunAt(OBSERVER_CRON)},
							description = ${`Sales battle report observer: ${input.courseName} (weekday ${weekday})`},
							created_by_user = ${input.createdByUser}, created_by_agent = NULL,
							paused = false, state = 'active', updated_at = now()
						WHERE id = ${canonical.id}
						RETURNING *
					`) as unknown as ScheduledJobRow[];
					active = rows[0];
					updated.push(active.id);
				}
				observerRefs.push(active.id);

				for (const duplicate of candidates.filter(
					(row) => row.id !== active.id,
				)) {
					await tx`DELETE FROM scheduled_jobs WHERE id = ${duplicate.id}`;
					deletedDuplicates.push(duplicate.id);
				}
			}
		}

		for (const row of existing) {
			const weekday = Number(row.action_args.salesTalkWeekday);
			const shouldPause =
				input.desiredState !== "active" || !desiredWeekdays.has(weekday);
			if (shouldPause && !row.paused && !deletedDuplicates.includes(row.id)) {
				await tx`
					UPDATE scheduled_jobs
					SET paused = true, updated_at = now()
					WHERE id = ${row.id}
				`;
				paused.push(row.id);
			}
		}

		return {
			ok: true,
			acceptedRevision: input.scheduleRevision,
			reconciled: { created, updated, paused, deletedDuplicates },
			observerRefs,
		};
	});
}
