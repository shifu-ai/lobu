/**
 * TaskScheduler boot + periodic platform-internal jobs.
 *
 * Each job is a standalone task with its own cron schedule, durable as a row
 * in `public.runs` (run_type='task'). Cross-pod coordination is the
 * runs-queue claim path — no per-job advisory locks.
 */

import type { Env } from "@lobu/connector-sdk";
import type {
	MessagePayload,
	ResolvedCourseExecutionContext,
	ScheduledCourseContext,
} from "@lobu/core";
import { getDb, pgTextArray } from "../db/client";
import type { QueueProducer } from "../gateway/infrastructure/queue/queue-producer.js";
import { attachCourseContextForReviewedScope } from "../gateway/orchestration/course-context-gate.js";
import {
	createThreadForAgent,
	enqueueAgentMessage,
} from "../gateway/services/agent-threads";
import type { CoreServices } from "../gateway/services/core-services";
import type { ISessionManager } from "../gateway/session.js";
import { cleanupExpiredMcpSessions } from "../mcp-handler";
import { createNotificationForUsers } from "../notifications/service";
import logger from "../utils/logger";
import { runWatcherAutomationTick } from "../watchers/automation";
import { checkStalledExecutions } from "./check-stalled-executions";
import { runClassificationReconciliation } from "./classification-reconciliation";
import {
	resolveTrustedCourseFireContext,
	type TrustedCourseFireEligibility,
	type TrustedCourseWakeV1,
	validateTrustedCourseFireEligibility,
} from "./course-aware-wake.js";
import {
	registerScheduledJobsTicker,
	resolveWakeAgentId,
} from "./scheduled-jobs-service";
import {
	resolveScheduledPersonalReminder,
	type ScheduledPersonalReminderV1,
} from "./personal-reminder.js";
import { TaskScheduler } from "./task-scheduler";
import { triggerEmbedBackfill } from "./trigger-embed-backfill";
import {
	buildScheduledWakeMessage,
	resolveWakeThreadId,
} from "./wake-target.js";

/**
 * Construct the TaskScheduler, register every periodic task, start dispatch,
 * and wire the lazy at-use-time refresh hooks into AuthProfilesManager.
 * Single call site for both `server.ts` (prod) and `embedded-runtime.ts` (embedded Postgres).
 */
export async function bootTaskScheduler(
	coreServices: CoreServices,
	env: Env,
): Promise<TaskScheduler> {
	const scheduler = new TaskScheduler(coreServices.getQueue());
	registerMaintenanceTasks(scheduler, env, coreServices);
	await scheduler.start();

	// AuthProfilesManager.ensureFreshCredential is a no-op until these hooks
	// are wired; during the brief startup window before scheduler.start()
	// returns, the periodic safety-net is the only refresh path.
	const authProfilesManager = coreServices.getAuthProfilesManager();
	if (authProfilesManager) {
		authProfilesManager.setLazyRefreshHooks({
			triggerAsync: async (userId, agentId) => {
				await scheduler.spawn(
					"refresh-token-for-user-agent",
					{ userId, agentId },
					{ idempotencyKey: `refresh-token:${userId}:${agentId}` },
				);
			},
			refreshNow: (userId, agentId) =>
				coreServices.getTokenRefreshJob().refreshForUserAgent(userId, agentId),
		});
	}

	return scheduler;
}

function registerMaintenanceTasks(
	scheduler: TaskScheduler,
	env: Env,
	coreServices: CoreServices,
): void {
	// OAuth token refresh — periodic safety-net at 30min intervals. The hot path
	// is at-use-time lazy refresh in AuthProfilesManager.ensureFreshCredential,
	// which spawns `refresh-token-for-user-agent` per-user when a soon-expiring
	// token is read. This periodic scan only catches users who haven't accessed
	// the system in a while.
	scheduler.register(
		"token-refresh",
		() => coreServices.getTokenRefreshJob().runOnce(),
		{ cron: "*/30 * * * *" },
	);

	// Lazy refresh handler — spawned by AuthProfilesManager when a soon-expiring
	// OAuth token is read. Idempotency-keyed by (userId, agentId) so concurrent
	// reads collapse to one refresh.
	scheduler.register("refresh-token-for-user-agent", async (ctx) => {
		const { userId, agentId } = ctx.payload as {
			userId: string;
			agentId: string;
		};
		if (!userId || !agentId) {
			logger.warn(
				{ payload: ctx.payload },
				"[task] refresh-token-for-user-agent missing userId/agentId",
			);
			return;
		}
		await coreServices
			.getTokenRefreshJob()
			.refreshForUserAgent(userId, agentId);
	});

	// MCP session cleanup — drops expired session rows from the DB. Lives here
	// (cross-pod-coordinated) instead of as an mcp-handler module-level
	// setInterval. The IN-MEMORY part stays per-pod (see mcp-handler.ts).
	scheduler.register("mcp-session-cleanup", () => cleanupExpiredMcpSessions(), {
		cron: "*/10 * * * *",
	});

	// Hygiene sweep — drops expired rows from oauth_states, rate_limits,
	// grants, and archives completed runs.
	scheduler.register(
		"sweep-ephemeral-tables",
		() => coreServices.sweepEphemeralTables(),
		{ cron: "*/5 * * * *" },
	);

	scheduler.register(
		"check-stalled-executions",
		async () => {
			await checkStalledExecutions(env);
			logger.info("[task] check-stalled-executions completed");
		},
		{ cron: "*/5 * * * *" },
	);

	scheduler.register(
		"trigger-embed-backfill",
		async () => {
			const result = await triggerEmbedBackfill(env);
			if (result.runsCreated > 0) {
				logger.info(
					{ ...result },
					"[task] trigger-embed-backfill enqueued runs",
				);
			}
		},
		{ cron: "*/5 * * * *" },
	);

	scheduler.register(
		"classification-reconciliation",
		async () => {
			const result = await runClassificationReconciliation(env);
			logger.info(
				{ ...result },
				"[task] classification-reconciliation completed",
			);
		},
		{ cron: "*/5 * * * *" },
	);

	// Watcher automation: reconcile in-flight runs, materialize newly-due runs,
	// dispatch pending runs. The orphaned-runs reset is bounded and idempotent
	// so it runs every tick — no per-pod first-tick latch needed.
	//
	// Each phase is isolated: a throw in one (e.g. the `malformed array literal`
	// bug that wedged reconcile, lobu#1046) must NOT abort the later phases —
	// otherwise a single fault stops materialize+dispatch and no watcher fires.
	scheduler.register(
		"watcher-automation",
		async () => {
			const { errors, ...summary } = await runWatcherAutomationTick(env);
			logger.info(
				{ ...summary, ...(errors.length > 0 ? { errors } : {}) },
				"[task] watcher-automation completed",
			);
		},
		{ cron: "* * * * *" },
	);

	// scheduled_jobs ticker: scans the table every minute, spawns due rows
	// as task runs via this same scheduler. The actual firing handlers are
	// registered below so spawn() can find them.
	registerScheduledJobsTicker(scheduler);

	// Observer only: Toolbox's Cloudflare cron remains the sole report sender.
	scheduler.register("sales_battle_report_observer", async (ctx) => {
		logger.info(
			{ payload: ctx.payload },
			"[task] sales battle report observer fired",
		);
	});

	// Handler: send_notification. Payload mirrors the notify-tool shape;
	// resolves recipients to user_ids and inserts events + notification_targets.
	scheduler.register("send_notification", async (ctx) => {
		const sql = getDb();
		const p = ctx.payload as {
			__organization_id?: string;
			organization_id?: string;
			recipients?: string[] | "admins" | "all";
			type?: string;
			title?: string;
			body?: string | null;
			resource_url?: string | null;
		};
		const orgId = p.__organization_id ?? p.organization_id;
		const title = p.title;
		if (!orgId || !title) {
			logger.warn(
				{ payload: ctx.payload },
				"[task] send_notification missing org or title",
			);
			return;
		}
		const recipients = p.recipients ?? "admins";
		let userIds: string[];
		if (Array.isArray(recipients)) {
			const rows = await sql<{ userId: string }>`
        SELECT "userId" FROM "member"
        WHERE "organizationId" = ${orgId}
          AND "userId" = ANY(${pgTextArray(recipients)}::text[])
      `;
			userIds = rows.map((r) => r.userId);
		} else if (recipients === "all") {
			const rows = await sql<{ userId: string }>`
        SELECT "userId" FROM "member"
        WHERE "organizationId" = ${orgId}
      `;
			userIds = rows.map((r) => r.userId);
		} else {
			const rows = await sql<{ userId: string }>`
        SELECT "userId" FROM "member"
        WHERE "organizationId" = ${orgId} AND role IN ('admin', 'owner')
      `;
			userIds = rows.map((r) => r.userId);
		}
		if (userIds.length === 0) return;
		await createNotificationForUsers(userIds, {
			organizationId: orgId,
			type: (p.type as "agent_message") ?? "agent_message",
			title,
			body: p.body ?? null,
			resourceUrl: p.resource_url ?? null,
		});
	});

	// Handler: wake_agent. Creates a thread for the agent (or reuses one
	// supplied by the caller) and enqueues the prompt as a user message.
	// Lets an agent schedule its own follow-up wake-ups via manage_schedules.
	//
	// Body lives in `handleWakeAgentTask` (below) so it can be exercised
	// directly in tests via dependency injection instead of `mock.module`'ing
	// getDb/agent-threads (mirrors manage_schedules.ts's ManageSchedulesDeps
	// pattern).
	scheduler.register("wake_agent", async (ctx) => {
		await handleWakeAgentTask(
			{
				sql: getDb(),
				sessionManager: coreServices.getSessionManager(),
				queueProducer: coreServices.getQueueProducer(),
			},
			{
				...(ctx.payload as WakeAgentTaskPayload),
				__scheduled_task_run_id: ctx.taskRunId,
			},
		);
	});
}

export interface WakeAgentTaskPayload {
	__organization_id?: string;
	__created_by_user?: string | null;
	__created_by_agent?: string | null;
	__scheduled_job_id?: string;
	__scheduled_job_external_key?: string | null;
	__scheduled_job_tick?: string;
	__scheduled_task_run_id?: number;
	organization_id?: string;
	agent_id?: string;
	prompt?: string;
	thread_id?: string | null;
	reason?: string | null;
	trustedCourseWake?: unknown;
	personalReminder?: unknown;
}

export interface WakeAgentTaskDeps {
	sql: ReturnType<typeof getDb>;
	sessionManager: ISessionManager;
	queueProducer: QueueProducer;
	resolveScheduledCourseContext?: (input: {
		payload: MessagePayload;
		trustedWake: TrustedCourseWakeV1;
	}) => Promise<ResolvedCourseExecutionContext | null>;
}

async function resolveScheduledCourseContextAtFire(input: {
	payload: MessagePayload;
	trustedWake: TrustedCourseWakeV1;
}): Promise<ResolvedCourseExecutionContext | null> {
	const result = await attachCourseContextForReviewedScope(input.payload, {
		baseUrl: process.env.TOOLBOX_COURSE_CONTEXT_URL?.trim() ?? "",
		secret: process.env.TOOLBOX_INTERNAL_SECRET?.trim() ?? "",
		propagateInfrastructureErrors: true,
	});
	return result.status === "ready" ? result.context : null;
}

/**
 * Handler body for the `wake_agent` scheduled task, extracted from the
 * `scheduler.register('wake_agent', ...)` closure above for testability
 * (see the comment there). Exported for `jobs-wake-agent.test.ts`.
 */
export async function handleWakeAgentTask(
	deps: WakeAgentTaskDeps,
	payload: WakeAgentTaskPayload,
): Promise<void> {
	const { sql, sessionManager, queueProducer } = deps;
	const p = payload;
	const orgId = p.__organization_id ?? p.organization_id;
	if (!orgId || !p.agent_id || !p.prompt) {
		logger.warn({ payload }, "[task] wake_agent missing org/agent/prompt");
		return;
	}
	// Target-agent existence check. The cascade FK on scheduled_jobs only
	// covers `created_by_agent` (the *scheduler*'s identity), not the
	// *target* of a wake_agent action. If a user scheduled a wake for
	// agent X and X was deleted, we'd silently enqueue a message for a
	// ghost — so verify the target exists and auto-pause the schedule
	// when it doesn't.
	//
	// SHIFU FORK: member-scope-internal-tools plan, Task 3 follow-up. Some
	// callers persist `agent_id` as a full CONVERSATION id
	// (`<agentId>_<userId>_<threadId>`) instead of the bare agent id —
	// manage_schedules.ts now normalizes this at create time, but this
	// resolves it defensively for rows written before that fix (or by a
	// still-buggy caller) instead of silently auto-pausing a schedule that
	// would otherwise fire correctly.
	const resolvedAgentId = await resolveWakeAgentId(sql, orgId, p.agent_id);
	if (!resolvedAgentId) {
		logger.warn(
			{ scheduled_job_id: p.__scheduled_job_id, agent_id: p.agent_id },
			"[task] wake_agent target agent no longer exists; pausing schedule",
		);
		if (p.__scheduled_job_id) {
			await sql`UPDATE scheduled_jobs SET paused = true, updated_at = now() WHERE id = ${p.__scheduled_job_id}`;
		}
		return;
	}
	p.agent_id = resolvedAgentId;
	const hasTrustedWake = p.trustedCourseWake !== undefined;
	const hasPersonalReminderMarker = p.personalReminder !== undefined;
	const scheduledMessageId =
		p.__scheduled_job_id && p.__scheduled_task_run_id
			? `scheduled-${p.__scheduled_job_id}-run-${p.__scheduled_task_run_id}`.replace(
					/[^a-zA-Z0-9_-]/g,
					"-",
				)
			: undefined;
	const scheduledUserId = p.__created_by_user ?? "";
	const scheduledAgentId = p.agent_id;
	const scheduledPrompt = p.prompt;
	let scheduledCourseContext: ScheduledCourseContext | undefined;
	let resolvedCourseContext: ResolvedCourseExecutionContext | undefined;
	let trustedEligibility: TrustedCourseFireEligibility | null = null;
	let scheduledPersonalReminder: ScheduledPersonalReminderV1 | null = null;
	if (hasPersonalReminderMarker) {
		scheduledPersonalReminder = resolveScheduledPersonalReminder({
			raw: p.personalReminder,
			createdByUser: p.__created_by_user,
			createdByAgent: p.__created_by_agent,
			resolvedAgentId: p.agent_id,
			jobId: p.__scheduled_job_id,
			runId: p.__scheduled_task_run_id,
		});
		if (!scheduledPersonalReminder) {
			logger.warn(
				{
					category: "personal_reminder_fire_gate",
					scheduledJobId: p.__scheduled_job_id,
					scheduledTaskRunId: p.__scheduled_task_run_id,
				},
				"[task] personal reminder wake rejected deterministically",
			);
			return;
		}
	}
	if (hasTrustedWake) {
		trustedEligibility = await validateTrustedCourseFireEligibility(
			{
				rawWake: p.trustedCourseWake,
				reason: p.reason,
				organizationId: orgId,
				createdByUser: p.__created_by_user,
				createdByAgent: p.__created_by_agent,
				resolvedAgentId: p.agent_id,
				scheduledJobId: p.__scheduled_job_id,
				scheduledTaskRunId: p.__scheduled_task_run_id,
				externalKey: p.__scheduled_job_external_key,
				scheduledTick: p.__scheduled_job_tick,
			},
			{
				verifyOwner: async ({ organizationId, ownerUserId, agentId }) => {
					const rows =
						await sql`SELECT id FROM agents WHERE organization_id=${organizationId} AND id=${agentId} AND owner_platform='toolbox' AND owner_user_id=${ownerUserId} LIMIT 1`;
					return rows.length > 0;
				},
			},
		);
		if (!trustedEligibility) {
			logger.warn(
				{
					category: "trusted_course_fire_gate",
					scheduledJobId: p.__scheduled_job_id,
					scheduledTaskRunId: p.__scheduled_task_run_id,
				},
				"[task] trusted course wake rejected deterministically",
			);
			return;
		}
		scheduledCourseContext = trustedEligibility.scheduledCourseContext;
	}
	const reuseConversation = process.env.SHIFU_WAKE_REUSE_CONVERSATION !== "0";
	let threadId = scheduledPersonalReminder?.conversationId ?? p.thread_id ?? null;
	if (!threadId && reuseConversation) {
		threadId = await resolveWakeThreadId(
			{ sql, sessionManager },
			{
				organizationId: orgId,
				agentId: p.agent_id,
				userId: p.__created_by_user ?? null,
			},
		);
		if (threadId) {
			logger.info(
				{ scheduled_job_id: p.__scheduled_job_id, threadId },
				"[task] wake_agent reusing existing conversation",
			);
		}
	}
	if (!threadId) {
		const result = await createThreadForAgent(
			{ sessionManager },
			{
				agentId: p.agent_id,
				organizationId: orgId,
				// The ticker injects the scheduling user under the `__` prefix
				// so handler payloads can mix scheduler-controlled metadata with
				// user-supplied action_args without collision. Reading from
				// p.__created_by_user keeps the wake-up's thread / message
				// attribution pointing at whoever scheduled it (not the agent
				// itself, which would obscure the audit trail).
				createdByUserId: p.__created_by_user ?? undefined,
				reason: p.reason ?? "scheduled-wake",
			},
		);
		threadId = result.threadId;
	}
	if (trustedEligibility) {
		const firedCourseContext = await resolveTrustedCourseFireContext(
			trustedEligibility,
			{
				resolveContext: async ({ trustedWake, scheduledCourseContext }) => {
					const firePayload = {
						userId: scheduledUserId,
						agentId: scheduledAgentId,
						organizationId: orgId,
						conversationId: threadId,
						channelId: "scheduled",
						messageId: scheduledMessageId ?? "",
						botId: "lobu-api",
						platform: "api",
						messageText: scheduledPrompt,
						platformMetadata: { source: "scheduled-job" },
						agentOptions: {},
						scheduledCourseContext,
					} as MessagePayload;
					return (
						deps.resolveScheduledCourseContext ??
						resolveScheduledCourseContextAtFire
					)({ payload: firePayload, trustedWake });
				},
			},
		);
		if (!firedCourseContext) {
			logger.warn(
				{
					category: "trusted_course_context_gate",
					scheduledJobId: p.__scheduled_job_id,
					scheduledTaskRunId: p.__scheduled_task_run_id,
				},
				"[task] trusted course wake context rejected deterministically",
			);
			return;
		}
		resolvedCourseContext = firedCourseContext;
	}
	await enqueueAgentMessage(
		{ sessionManager, queueProducer },
		{
			threadId,
			messageText: reuseConversation
				? buildScheduledWakeMessage(
						renderScheduledWakePrompt(p.prompt, p.__scheduled_job_tick),
						{
							mechanicalDelivery: hasTrustedWake || Boolean(scheduledPersonalReminder),
						},
					)
				: renderScheduledWakePrompt(p.prompt, p.__scheduled_job_tick),
			source: "scheduled-job",
			messageId: scheduledMessageId,
			queueSingletonKey: scheduledMessageId,
			durableQueueSingleton: Boolean(
				(hasTrustedWake || scheduledPersonalReminder) && scheduledMessageId,
			),
			scheduledCourseContext,
			resolvedCourseContext,
			scheduledPersonalReminder: scheduledPersonalReminder ?? undefined,
		},
	);
}

function renderScheduledWakePrompt(
	prompt: string,
	scheduledJobTick?: string,
): string {
	if (!prompt.includes("{{salesTalkDate}}")) return prompt;
	if (!scheduledJobTick)
		return prompt.replaceAll("{{salesTalkDate}}", "UNKNOWN_SCHEDULED_TICK");
	const salesTalkDate = salesTalkDateFromScheduledTick(scheduledJobTick);
	return prompt.replaceAll("{{salesTalkDate}}", salesTalkDate);
}

function salesTalkDateFromScheduledTick(scheduledJobTick: string): string {
	const tick = new Date(scheduledJobTick);
	if (Number.isNaN(tick.getTime())) return "INVALID_SCHEDULED_TICK";
	const taipeiParts = new Intl.DateTimeFormat("en-CA", {
		timeZone: "Asia/Taipei",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(tick);
	const part = (type: "year" | "month" | "day") =>
		taipeiParts.find((item) => item.type === type)?.value ?? "";
	const taipeiDate = new Date(
		`${part("year")}-${part("month")}-${part("day")}T00:00:00.000Z`,
	);
	taipeiDate.setUTCDate(taipeiDate.getUTCDate() - 1);
	return taipeiDate.toISOString().slice(0, 10);
}
