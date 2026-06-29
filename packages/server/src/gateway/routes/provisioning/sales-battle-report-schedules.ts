import { type Context, Hono } from "hono";
import { getDb } from "../../../db/client.js";
import {
	type CreateScheduledJobParams,
	type ScheduledJobRow,
} from "../../../scheduled/scheduled-jobs-service.js";
import { nextRunAt as nextCronTickAt } from "../../../utils/cron.js";
import type { Env } from "../../../index.js";

const SALES_BATTLE_REPORT_REASON = "sales-battle-report-schedule";

export interface SalesBattleReportScheduleProvisioningBody {
	organizationId: string;
	createdByUser: string;
	agentId: string;
	toolboxScheduleId: string;
	trialSessionAgentId: string;
	displayName: string;
	salesTalkWeekdays: number[];
}

export type SalesBattleReportScheduledJobParams = CreateScheduledJobParams & {
	actionType: "wake_agent";
	actionArgs: {
		agent_id: string;
		prompt: string;
		reason: string;
		toolboxScheduleId: string;
		trialSessionAgentId: string;
		salesTalkWeekday: number;
	};
	cron: string;
};

function requireAdminPat(c: Context<{ Bindings: Env }>): Response | null {
	const session = c.get("session") as { id?: string } | null;
	const authSource = c.get("authSource") as "pat" | "session" | "oauth" | null;
	const authInfo = c.get("mcpAuthInfo") as { scopes?: string[] } | null;
	const scopes = Array.isArray(authInfo?.scopes) ? authInfo.scopes : [];

	if (
		authSource === "pat" &&
		session?.id?.startsWith("pat:") &&
		scopes.includes("mcp:admin")
	) {
		return null;
	}

	return c.json(
		{
			error: "forbidden",
			error_description:
				"Provisioning requires an organization-scoped PAT with mcp:admin scope.",
		},
		403,
	);
}

function nonEmptyString(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function normalizeWeekdays(value: unknown): number[] {
	if (!Array.isArray(value)) {
		throw new Error("salesTalkWeekdays must be an array of weekday numbers");
	}
	const weekdays = new Set<number>();
	for (const weekday of value) {
		if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
			throw new Error(
				"salesTalkWeekdays must contain integers from 0 (Sunday) to 6 (Saturday)",
			);
		}
		weekdays.add(weekday);
	}
	if (weekdays.size === 0) {
		throw new Error("salesTalkWeekdays must contain at least one weekday");
	}
	return [...weekdays].sort((a, b) => a - b);
}

function parseBody(value: unknown): SalesBattleReportScheduleProvisioningBody {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("request body must be an object");
	}
	const record = value as Record<string, unknown>;
	const body = {
		organizationId: nonEmptyString(record.organizationId),
		createdByUser: nonEmptyString(record.createdByUser),
		agentId: nonEmptyString(record.agentId),
		toolboxScheduleId: nonEmptyString(record.toolboxScheduleId),
		trialSessionAgentId: nonEmptyString(record.trialSessionAgentId),
		displayName: nonEmptyString(record.displayName),
		salesTalkWeekdays: normalizeWeekdays(record.salesTalkWeekdays),
	};

	for (const [key, parsed] of Object.entries(body)) {
		if (key === "salesTalkWeekdays") continue;
		if (!parsed) throw new Error(`${key} is required`);
	}
	return body;
}

function cronForTaipeiMidnightAfterSalesTalk(weekday: number): string {
	// Toolbox stores sales-talk weekdays in Taipei local time with Sunday = 0.
	// The report runs at Asia/Taipei 00:00 on the following local day, which is
	// 16:00 UTC on the sales-talk day. Lobu cron is UTC and cron-parser also
	// uses Sunday = 0, so the day-of-week stays the sales-talk weekday.
	return `0 16 * * ${weekday}`;
}

function buildWakePrompt(params: {
	displayName: string;
	toolboxScheduleId: string;
	trialSessionAgentId: string;
}): string {
	return [
		`Run the Toolbox sales battle report schedule for ${params.displayName}.`,
		"Call the Toolbox MCP tool sales_battle_report_run_now with these exact MCP arguments:",
		`scheduleId: ${params.toolboxScheduleId}`,
		`trialSessionAgentId: ${params.trialSessionAgentId}`,
		"salesTalkDate: compute as the Asia/Taipei calendar date one day before the current scheduled run time / current date at execution.",
		"Important: do not send LINE directly; Toolbox/Gateway handles report generation, sending, and logging.",
	].join("\n");
}

export function buildSalesBattleReportScheduledJobs(
	body: SalesBattleReportScheduleProvisioningBody,
): SalesBattleReportScheduledJobParams[] {
	return normalizeWeekdays(body.salesTalkWeekdays).map((weekday) => {
		const cron = cronForTaipeiMidnightAfterSalesTalk(weekday);
		return {
			organizationId: body.organizationId,
			actionType: "wake_agent",
			actionArgs: {
				agent_id: body.agentId,
				prompt: buildWakePrompt({
					displayName: body.displayName,
					toolboxScheduleId: body.toolboxScheduleId,
					trialSessionAgentId: body.trialSessionAgentId,
				}),
				reason: SALES_BATTLE_REPORT_REASON,
				toolboxScheduleId: body.toolboxScheduleId,
				trialSessionAgentId: body.trialSessionAgentId,
				salesTalkWeekday: weekday,
			},
			description: `Sales battle report: ${body.displayName} (weekday ${weekday})`,
			cron,
			runAt: new Date(nextCronTickAt(cron)),
			createdByUser: body.createdByUser,
			createdByAgent: null,
		};
	});
}

async function findExistingJob(
	sql: ReturnType<typeof getDb>,
	organizationId: string,
	toolboxScheduleId: string,
	weekday: number,
): Promise<ScheduledJobRow | null> {
	const rows = await sql<ScheduledJobRow[]>`
		SELECT *
		FROM scheduled_jobs
		WHERE organization_id = ${organizationId}
		  AND action_type = 'wake_agent'
		  AND action_args->>'toolboxScheduleId' = ${toolboxScheduleId}
		  AND action_args->>'salesTalkWeekday' = ${String(weekday)}
		ORDER BY created_at ASC
		LIMIT 1
	`;
	return rows[0] ?? null;
}

export async function ensureSalesBattleReportScheduledJobs(
	body: SalesBattleReportScheduleProvisioningBody,
): Promise<{ refs: string[]; createdCount: number }> {
	const sql = getDb();
	return sql.begin(async (tx) => {
		const db = tx as ReturnType<typeof getDb>;
		await db`
			SELECT pg_advisory_xact_lock(
				hashtext(${body.organizationId}),
				hashtext(${body.toolboxScheduleId})
			)
		`;

		const refs: string[] = [];
		let createdCount = 0;
		for (const job of buildSalesBattleReportScheduledJobs(body)) {
			const existing = await findExistingJob(
				db,
				job.organizationId,
				job.actionArgs.toolboxScheduleId,
				job.actionArgs.salesTalkWeekday,
			);
			if (existing) {
				refs.push(existing.id);
				continue;
			}
			const rows = await db<ScheduledJobRow[]>`
				INSERT INTO scheduled_jobs (
					organization_id, action_type, action_args, cron, next_run_at,
					description,
					created_by_user, created_by_agent,
					source_run_id, source_event_id, source_thread_id
				) VALUES (
					${job.organizationId}, ${job.actionType},
					${db.json(job.actionArgs)}, ${job.cron}, ${job.runAt},
					${job.description},
					${job.createdByUser ?? null}, ${job.createdByAgent ?? null},
					${job.sourceRunId ?? null}, ${job.sourceEventId ?? null}, ${job.sourceThreadId ?? null}
				)
				RETURNING *
			`;
			createdCount += 1;
			refs.push(rows[0].id);
		}

		return { refs, createdCount };
	});
}

export function createSalesBattleReportScheduleProvisioningRoutes(): Hono<{
	Bindings: Env;
}> {
	const app = new Hono<{ Bindings: Env }>();

	app.post("/sales-battle-report-schedules", async (c) => {
		const denied = requireAdminPat(c);
		if (denied) return denied;

		const organizationId = c.get("organizationId") as string | null;
		if (!organizationId) {
			return c.json({ error: "Authentication required" }, 401);
		}

		let body: SalesBattleReportScheduleProvisioningBody;
		try {
			body = parseBody(await c.req.json());
		} catch (error) {
			return c.json(
				{ error: error instanceof Error ? error.message : "Invalid request body" },
				400,
			);
		}

		if (body.organizationId !== organizationId) {
			return c.json({ error: "organizationId does not match authenticated org" }, 403);
		}

		const { refs, createdCount } = await ensureSalesBattleReportScheduledJobs(body);
		return c.json(
			{ ok: true, scheduleRefs: refs },
			createdCount > 0 ? 201 : 200,
		);
	});

	return app;
}
