import { describe, expect, mock, test } from "bun:test";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import type { ScheduledJobRow } from "../../../scheduled/scheduled-jobs-service";
import type { ToolContext } from "../../registry";
import {
	ManageSchedulesSchema,
	manageSchedules,
	type ManageSchedulesDeps,
} from "../manage_schedules";

const ORG = "org-staged-tool";
const CREATION_KEY = "toolbox:automation:staged-tool";
const SCHEDULE_ID = "00000000-0000-4000-8000-000000000042";

function trustedCtx(): ToolContext {
	return {
		organizationId: ORG,
		tokenOrganizationId: ORG,
		userId: "toolbox-adapter",
		memberRole: "member",
		agentId: null,
		scopes: ["mcp:admin"],
		isAuthenticated: true,
		tokenType: "pat",
		scopedToOrg: false,
		allowCrossOrg: false,
	};
}

function memberCtx(): ToolContext {
	return {
		...trustedCtx(),
		userId: "member-user",
		memberRole: "member",
		agentId: "shifu-u-member",
		scopes: ["mcp:read", "mcp:write"],
		scopedToOrg: true,
	};
}

function job(overrides: Partial<ScheduledJobRow> = {}): ScheduledJobRow {
	return {
		id: SCHEDULE_ID,
		external_key: CREATION_KEY,
		schedule_revision: 1,
		state: "staged",
		organization_id: ORG,
		action_type: "wake_agent",
		action_args: { agent_id: "shifu-u-member", prompt: "follow up" },
		cron: null,
		until_at: null,
		next_run_at: "2030-07-15T09:00:00.000Z",
		last_fired_at: null,
		last_fired_run_id: null,
		paused: false,
		description: "follow up",
		created_by_user: "toolbox-adapter",
		created_by_agent: null,
		source_run_id: null,
		source_event_id: null,
		source_thread_id: null,
		created_at: "2026-07-14T00:00:00.000Z",
		updated_at: "2026-07-14T00:00:00.000Z",
		...overrides,
	};
}

function deps(overrides: Partial<ManageSchedulesDeps> = {}): ManageSchedulesDeps {
	return {
		createScheduledJob: mock(async () => job({ state: "active" })) as any,
		upsertScheduledJobByExternalKeyWithQuota: mock(async () => ({
			status: "ok",
			job: job({ state: "active" }),
		})) as any,
		stageScheduledJobByExternalKey: mock(async () => ({ status: "ok", job: job() })) as any,
		getScheduledJobByExternalKey: mock(async () => null) as any,
		activateScheduledJobByExternalKey: mock(async () => ({ status: "not_found" })) as any,
		listScheduledJobs: mock(async () => []) as any,
		getScheduledJob: mock(async () => null) as any,
		pauseScheduledJob: mock(async () => true) as any,
		deleteScheduledJob: mock(async () => true) as any,
		countActiveScheduledJobs: mock(async () => 0) as any,
		agentOwnedByUser: mock(async () => true) as any,
		resolveWakeAgentId: mock(async (_org: string, id: string) => id) as any,
		...overrides,
	};
}

function stagedCreate() {
	return {
		action: "create",
		description: "follow up",
		creation_key: CREATION_KEY,
		initial_state: "staged",
		run_at: "2030-07-15T09:00:00.000Z",
		payload: { type: "wake_agent", agent_id: "shifu-u-member", prompt: "follow up" },
	};
}

describe("manage_schedules staged contract", () => {
	test("public schema exposes staged create, lookup, and activate fields", () => {
		const validator = TypeCompiler.Compile(ManageSchedulesSchema as any);
		expect(validator.Check(stagedCreate())).toBe(true);
		expect(validator.Check({ action: "get_by_creation_key", creation_key: CREATION_KEY })).toBe(
			true,
		);
		expect(
			validator.Check({
				action: "activate",
				creation_key: CREATION_KEY,
				expected_schedule_id: SCHEDULE_ID,
			}),
		).toBe(true);
	});

	test("trusted create stages work and surfaces immutable conflicts", async () => {
		const successDeps = deps();
		const created = await manageSchedules(stagedCreate() as any, {} as any, trustedCtx(), successDeps);
		expect(created).toMatchObject({
			status: "staged",
			schedule: { id: SCHEDULE_ID, creation_key: CREATION_KEY, state: "staged" },
		});
		expect(successDeps.stageScheduledJobByExternalKey).toHaveBeenCalledTimes(1);
		expect(successDeps.upsertScheduledJobByExternalKeyWithQuota).not.toHaveBeenCalled();

		const conflict = await manageSchedules(
			stagedCreate() as any,
			{} as any,
			trustedCtx(),
			deps({ stageScheduledJobByExternalKey: mock(async () => ({ status: "conflict" })) as any }),
		);
		expect(conflict).toEqual({
			status: "conflict",
			error: "A different schedule already uses this creation_key.",
		});
	});

	test("staged create requires a creation_key", async () => {
		const input = { ...stagedCreate(), creation_key: undefined };
		const result = await manageSchedules(input as any, {} as any, trustedCtx(), deps());
		expect(result.error).toMatch(/creation_key/i);
	});

	test("trusted lookup is explicit for found and not found", async () => {
		const foundDeps = deps({ getScheduledJobByExternalKey: mock(async () => job()) as any });
		const found = await manageSchedules(
			{ action: "get_by_creation_key", creation_key: ` ${CREATION_KEY} ` } as any,
			{} as any,
			trustedCtx(),
			foundDeps,
		);
		expect(found).toMatchObject({ found: true, status: "staged", schedule: { id: SCHEDULE_ID } });
		expect(foundDeps.getScheduledJobByExternalKey).toHaveBeenCalledWith(ORG, CREATION_KEY);

		const missing = await manageSchedules(
			{ action: "get_by_creation_key", creation_key: CREATION_KEY } as any,
			{} as any,
			trustedCtx(),
			deps(),
		);
		expect(missing).toEqual({ found: false, status: "not_found" });
	});

	test.each(["get_by_creation_key", "activate"])(
		"ordinary members cannot probe %s",
		async (action) => {
			const testDeps = deps();
			const result = await manageSchedules(
				{
					action,
					creation_key: CREATION_KEY,
					expected_schedule_id: SCHEDULE_ID,
				} as any,
				{} as any,
				memberCtx(),
				testDeps,
			);
			expect(result).toEqual({ error: "Staged schedule actions require trusted access." });
			expect(testDeps.getScheduledJobByExternalKey).not.toHaveBeenCalled();
			expect(testDeps.activateScheduledJobByExternalKey).not.toHaveBeenCalled();
		},
	);

	test("trusted activate forwards org, key, id and returns explicit outcomes", async () => {
		const active = job({ state: "active", schedule_revision: 2 });
		const successDeps = deps({
			activateScheduledJobByExternalKey: mock(async () => ({ status: "ok", job: active })) as any,
		});
		const result = await manageSchedules(
			{ action: "activate", creation_key: CREATION_KEY, expected_schedule_id: SCHEDULE_ID } as any,
			{} as any,
			trustedCtx(),
			successDeps,
		);
		expect(result).toMatchObject({ status: "active", schedule: { id: SCHEDULE_ID, state: "active" } });
		expect(successDeps.activateScheduledJobByExternalKey).toHaveBeenCalledWith({
			organizationId: ORG,
			externalKey: CREATION_KEY,
			expectedScheduleId: SCHEDULE_ID,
		});

		for (const status of ["not_found", "expired", "paused"] as const) {
			const outcome = await manageSchedules(
				{ action: "activate", creation_key: CREATION_KEY, expected_schedule_id: SCHEDULE_ID } as any,
				{} as any,
				trustedCtx(),
				deps({ activateScheduledJobByExternalKey: mock(async () => ({ status })) as any }),
			);
			expect(outcome).toEqual({ status });
		}
	});
});
