import { afterEach, describe, expect, mock, test } from "bun:test";
import { executeMcpToolForTurn } from "../../../../agent-worker/src/openclaw/mcp-execution-contract";
import { deriveTurnExecutionIntent } from "../../../../agent-worker/src/openclaw/turn-execution-intent";
import { resolveScheduledPersonalReminder } from "../../scheduled/personal-reminder";
import {
	deliverPersonalReminderCompletion,
	readPersonalReminderDeliveryMetadata,
} from "../../scheduled/personal-reminder-delivery";
import type { ScheduledJobRow } from "../../scheduled/scheduled-jobs-service";
import {
	type ManageSchedulesDeps,
	manageSchedules,
} from "../../tools/admin/manage_schedules";
import type { ToolContext } from "../../tools/registry";

/**
 * Composed action-contract harness. It composes the real worker
 * canonicalizer, manage_schedules handler, fire metadata resolver, and callback
 * serializer, but deliberately injects the transport call and persistence
 * dependencies. Worker-header forwarding, authenticated MCP-session
 * propagation, durable fire behavior, and callback retry routing remain
 * mandatory neighboring suites and are not claimed as in-process E2E here.
 */

const userId = "toolbox-user-1";
const agentId = "shifu-u-contract";
const conversationId = `${agentId}_${userId}_line-contract`;

function context(overrides: Partial<ToolContext> = {}): ToolContext {
	return {
		organizationId: "org-1",
		userId,
		memberRole: "member",
		agentId,
		conversationId,
		personalReminderDeliveryIntent: true,
		clientId: "lobu-worker",
		scopes: ["mcp:read", "mcp:write"],
		isAuthenticated: true,
		tokenType: "pat",
		scopedToOrg: true,
		allowCrossOrg: false,
		...overrides,
	};
}

function row(input: {
	actionType: string;
	actionArgs: Record<string, unknown>;
	createdByUser: string | null;
	createdByAgent: string | null;
	sourceThreadId: string | null;
}): ScheduledJobRow {
	return {
		id: "job-contract-1",
		external_key: null,
		schedule_revision: 1,
		organization_id: "org-1",
		action_type: input.actionType,
		action_args: input.actionArgs,
		cron: null,
		until_at: null,
		next_run_at: "2099-01-01T00:00:00.000Z",
		last_fired_at: null,
		last_fired_run_id: null,
		paused: false,
		description: "contract reminder",
		created_by_user: input.createdByUser,
		created_by_agent: input.createdByAgent,
		source_run_id: null,
		source_event_id: null,
		source_thread_id: input.sourceThreadId,
		created_at: "2026-07-14T00:00:00.000Z",
		updated_at: "2026-07-14T00:00:00.000Z",
	};
}

function deps(captured: ScheduledJobRow[]): ManageSchedulesDeps {
	const persist = async (
				input: Parameters<ManageSchedulesDeps["createScheduledJob"]>[0],
			) => {
				const saved = row(input);
				captured.push(saved);
				return saved;
	};
	return {
		createScheduledJob: mock(persist) as never,
		createScheduledJobWithGuards: mock(async (input) => ({
			status: "ok",
			job: await persist(input),
		})) as never,
		upsertScheduledJobByExternalKeyWithQuota: mock(async () => {
			throw new Error("unexpected upsert");
		}) as never,
		stageScheduledJobByExternalKey: mock(async () => {
			throw new Error("unexpected stage");
		}) as never,
		activateScheduledJobByExternalKey: mock(async () => {
			throw new Error("unexpected activate");
		}) as never,
		getScheduledJobByExternalKey: mock(async () => null) as never,
		listScheduledJobs: mock(async () => []) as never,
		getScheduledJob: mock(async () => null) as never,
		pauseScheduledJob: mock(async () => true) as never,
		deleteScheduledJob: mock(async () => true) as never,
		countActiveScheduledJobs: mock(async () => 0) as never,
		agentOwnedByUser: mock(async () => true) as never,
		resolveWakeAgentId: mock(async (_org: string, raw: string) => raw) as never,
	};
}

afterEach(() => {
	delete process.env.TOOLBOX_TURN_COMPLETED_URL;
	delete process.env.TOOLBOX_INTERNAL_SECRET;
});

describe("composed personal reminder action-contract harness", () => {
	test("canonicalizes explicit reminder, persists trusted correlation, and emits v1 terminal callback", async () => {
		const saved: ScheduledJobRow[] = [];
		const traces: unknown[] = [];
		await executeMcpToolForTurn({
			intent: deriveTurnExecutionIntent("五分鐘後提醒我回覆客戶"),
			gateway: { agentId, conversationId },
			mcpId: "lobu-memory",
			toolName: "manage_schedules",
			args: {
				action: "create",
				description: "提醒回覆客戶",
				run_at: "2099-01-01T00:00:00.000Z",
				action_type: "send_notification",
				title: "回覆客戶",
			},
			onTrace: (trace) => traces.push(trace),
			callTool: async (_mcp, _tool, args, transport) => {
				expect(transport).toEqual({ personalReminderDelivery: true });
				await manageSchedules(
					args as never,
					{} as never,
					context({
						personalReminderDeliveryIntent: transport?.personalReminderDelivery,
					}),
					deps(saved),
				);
				return { content: [{ type: "text", text: "created" }] };
			},
		});

		expect(traces).toEqual([
			{
				requestedActionType: "send_notification",
				effectiveActionType: "wake_agent",
				canonicalized: true,
			},
		]);
		expect(saved).toHaveLength(1);
		const schedule = saved[0];
		if (!schedule) throw new Error("expected persisted schedule");
		expect(schedule).toMatchObject({
			action_type: "wake_agent",
			created_by_user: userId,
			created_by_agent: agentId,
			source_thread_id: conversationId,
		});
		expect(schedule.action_args).toMatchObject({
			agent_id: agentId,
			thread_id: conversationId,
			personalReminder: {
				schemaVersion: 1,
				contractVersion: "personal_reminder_delivery.v1",
				source: "personal_scheduled_reminder",
				toolboxUserId: userId,
				lobuAgentId: agentId,
				conversationId,
				reminderContent: "回覆客戶",
			},
		});

		const fired = resolveScheduledPersonalReminder({
			raw: schedule.action_args.personalReminder,
			createdByUser: schedule.created_by_user,
			createdByAgent: schedule.created_by_agent,
			resolvedAgentId: agentId,
			jobId: schedule.id,
			runId: 42,
		});
		expect(fired).not.toBeNull();
		if (!fired) throw new Error("expected trusted fired reminder metadata");
		expect(
			readPersonalReminderDeliveryMetadata({
				scheduledPersonalReminder: fired,
			}),
		).toEqual(fired);

		process.env.TOOLBOX_TURN_COMPLETED_URL =
			"https://toolbox.test/agent-workbench/internal/turn-completed";
		process.env.TOOLBOX_INTERNAL_SECRET = "server-only-secret";
		const fetchFn = mock(async () =>
			Response.json({ status: "delivered" }, { status: 202 }),
		);
		await deliverPersonalReminderCompletion(
			{
				metadata: fired,
				completion: { kind: "succeeded", finalOutput: "記得回覆客戶" },
				turnId: "turn-contract-1",
				occurredAt: "2026-07-14T13:00:00.000Z",
			},
			{ fetchFn },
		);
		const callback = JSON.parse(
			String((fetchFn.mock.calls[0]?.[1] as RequestInit).body),
		);
		expect(callback).toMatchObject({
			contractVersion: "personal_reminder_delivery.v1",
			source: "personal_scheduled_reminder",
			toolboxUserId: userId,
			lobuAgentId: agentId,
			conversationId,
			jobId: "job-contract-1",
			runId: 42,
			turnId: "turn-contract-1",
			completionStatus: "succeeded",
		});
		expect(JSON.stringify(callback)).not.toContain("lineUserId");
	});

	test.each([
		["ordinary wake", "五分鐘後喚醒 agent", "wake_agent"],
		[
			"organization notification",
			"五分鐘後通知團隊交週報",
			"send_notification",
		],
		["calendar wake", "明天下午三點跟老師開會", "wake_agent"],
	] as const)("does not tag %s as a trusted personal reminder", async (_label, message, actionType) => {
		const calls: Array<{ args: Record<string, unknown>; transport: unknown }> =
			[];
		await executeMcpToolForTurn({
			intent: deriveTurnExecutionIntent(message),
			gateway: { agentId, conversationId },
			mcpId: "lobu-memory",
			toolName: "manage_schedules",
			args: {
				action: "create",
				description: "contrast",
				run_at: "2099-01-01T00:00:00.000Z",
				action_type: actionType,
				agent_id: agentId,
				prompt: "contrast",
			},
			callTool: async (_mcp, _tool, args, transport) => {
				calls.push({ args, transport });
				return { content: [{ type: "text", text: "ok" }] };
			},
		});
		expect(calls[0]?.transport).toBeUndefined();
		expect(calls[0]?.args.delivery_intent).toBeUndefined();
	});
});
