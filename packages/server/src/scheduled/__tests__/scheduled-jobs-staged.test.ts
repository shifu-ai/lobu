import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { getDb } from "../../db/client.js";
import {
	ensureDbForGatewayTests,
	resetTestDatabase,
	seedAgentRow,
} from "../../gateway/__tests__/helpers/db-setup.js";
import {
	activateScheduledJobByExternalKey,
	createScheduledJob,
	deleteScheduledJob,
	dispatchScheduledJobCandidate,
	getScheduledJobByExternalKey,
	listScheduledJobs,
	pauseScheduledJob,
	stageScheduledJobByExternalKey,
	upsertScheduledJobByExternalKeyWithQuota,
} from "../scheduled-jobs-service.js";

const ORGANIZATION_ID = "org-staged";
const OTHER_ORGANIZATION_ID = "org-staged-other";
const OWNER_USER_ID = "pm-staged";
const AGENT_ID = "shifu-u-pm-staged";

function stagedParams(overrides: Record<string, unknown> = {}) {
	return {
		externalKey: "toolbox:automation:staged-1",
		organizationId: ORGANIZATION_ID,
		actionType: "wake_agent",
		actionArgs: { agent_id: AGENT_ID, prompt: "follow up" },
		description: "follow up",
		runAt: new Date("2030-07-15T09:00:00.000Z"),
		createdByUser: OWNER_USER_ID,
		createdByAgent: AGENT_ID,
		...overrides,
	};
}

function creationKey(job: { external_key: string | null }): string {
	if (!job.external_key) throw new Error("expected staged schedule creation key");
	return job.external_key;
}

describe("staged scheduled jobs", () => {
	beforeAll(async () => {
		await ensureDbForGatewayTests();
	}, 60_000);

	beforeEach(async () => {
		await resetTestDatabase();
		await seedAgentRow(AGENT_ID, {
			organizationId: ORGANIZATION_ID,
			ownerPlatform: "toolbox",
			ownerUserId: OWNER_USER_ID,
		});
	}, 30_000);

	test("persists staged work and returns the same row after a response-loss retry", async () => {
		const first = await stageScheduledJobByExternalKey(stagedParams());
		const retry = await stageScheduledJobByExternalKey(
			stagedParams({ createdByUser: "rotated-toolbox-pat" }),
		);

		expect(first.status).toBe("ok");
		expect(retry.status).toBe("ok");
		if (first.status !== "ok" || retry.status !== "ok") return;
		expect(retry.job.id).toBe(first.job.id);
		expect(retry.job.state).toBe("staged");
		expect(retry.job.schedule_revision).toBe(first.job.schedule_revision);
		expect(retry.job.created_by_user).toBe(OWNER_USER_ID);
	});

	test("existing create paths default to active without losing schedule data", async () => {
		const job = await createScheduledJob({
			organizationId: ORGANIZATION_ID,
			actionType: "wake_agent",
			actionArgs: { agent_id: AGENT_ID, prompt: "existing path" },
			description: "existing path",
			runAt: new Date("2030-07-15T10:00:00.000Z"),
			createdByUser: OWNER_USER_ID,
			createdByAgent: AGENT_ID,
		});

		expect(job.state).toBe("active");
		expect(job.action_args).toEqual({
			agent_id: AGENT_ID,
			prompt: "existing path",
		});
	});

	test("rejects a retry whose immutable schedule payload changed", async () => {
		const first = await stageScheduledJobByExternalKey(stagedParams());
		const conflict = await stageScheduledJobByExternalKey(
			stagedParams({ description: "different work" }),
		);

		expect(first.status).toBe("ok");
		expect(conflict).toEqual({ status: "conflict" });
		const rows = await getDb()<Array<{ count: number }>>`
			SELECT count(*)::int AS count FROM scheduled_jobs
			WHERE organization_id = ${ORGANIZATION_ID}
			  AND external_key = ${"toolbox:automation:staged-1"}
		`;
		expect(rows[0]?.count).toBe(1);
	});

	test("legacy keyed create cannot rewrite an existing staged payload", async () => {
		const staged = await stageScheduledJobByExternalKey(stagedParams());
		expect(staged.status).toBe("ok");

		const outcome = await upsertScheduledJobByExternalKeyWithQuota(
			stagedParams({ description: "must not replace staged work" }),
		);

		expect(outcome).toEqual({ status: "conflict" });
		const persisted = await getScheduledJobByExternalKey(
			ORGANIZATION_ID,
			"toolbox:automation:staged-1",
		);
		expect(persisted?.description).toBe("follow up");
		expect(persisted?.state).toBe("staged");
	});

	test("strong lookup is organization-scoped and reports not found explicitly", async () => {
		const staged = await stageScheduledJobByExternalKey(stagedParams());
		expect(staged.status).toBe("ok");

		const found = await getScheduledJobByExternalKey(
			ORGANIZATION_ID,
			"toolbox:automation:staged-1",
		);
		const wrongOrg = await getScheduledJobByExternalKey(
			OTHER_ORGANIZATION_ID,
			"toolbox:automation:staged-1",
		);

		expect(found?.state).toBe("staged");
		expect(wrongOrg).toBeNull();
	});

	test("ordinary schedule lists do not publish staged work", async () => {
		await stageScheduledJobByExternalKey(stagedParams());

		const listed = await listScheduledJobs({ organizationId: ORGANIZATION_ID });

		expect(listed).toEqual([]);
	});

	test("staged work cannot be dispatched before activation commits", async () => {
		const result = await stageScheduledJobByExternalKey(
			stagedParams({ runAt: new Date("2026-01-01T00:00:00.000Z") }),
		);
		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		const spawn = mock(async () => "run-1");

		await dispatchScheduledJobCandidate(
			{ id: result.job.id, schedule_revision: result.job.schedule_revision },
			{ spawn } as never,
		);

		expect(spawn).not.toHaveBeenCalled();
	});

	test("activate atomically transitions staged work and is idempotent", async () => {
		const staged = await stageScheduledJobByExternalKey(stagedParams());
		expect(staged.status).toBe("ok");
		if (staged.status !== "ok") return;

		const [first, second] = await Promise.all([
			activateScheduledJobByExternalKey({
				organizationId: ORGANIZATION_ID,
				externalKey: creationKey(staged.job),
				expectedScheduleId: staged.job.id,
			}),
			activateScheduledJobByExternalKey({
				organizationId: ORGANIZATION_ID,
				externalKey: creationKey(staged.job),
				expectedScheduleId: staged.job.id,
			}),
		]);

		expect(first.status).toBe("ok");
		expect(second.status).toBe("ok");
		if (first.status !== "ok" || second.status !== "ok") return;
		expect(first.job.id).toBe(staged.job.id);
		expect(second.job.id).toBe(staged.job.id);
		expect(first.job.state).toBe("active");
		expect(second.job.state).toBe("active");
		expect(first.job.schedule_revision).toBe(staged.job.schedule_revision + 1);
		expect(second.job.schedule_revision).toBe(first.job.schedule_revision);
	});

	test("active work becomes dispatchable only after activation", async () => {
		const staged = await stageScheduledJobByExternalKey(
			stagedParams({ runAt: new Date("2026-01-01T00:00:00.000Z") }),
		);
		expect(staged.status).toBe("ok");
		if (staged.status !== "ok") return;
		const activated = await activateScheduledJobByExternalKey({
			organizationId: ORGANIZATION_ID,
			externalKey: creationKey(staged.job),
			expectedScheduleId: staged.job.id,
			now: new Date("2025-12-31T23:59:00.000Z"),
		});
		expect(activated.status).toBe("ok");
		if (activated.status !== "ok") return;
		const spawn = mock(async () => "run-1");

		await dispatchScheduledJobCandidate(
			{
				id: activated.job.id,
				schedule_revision: activated.job.schedule_revision,
			},
			{ spawn } as never,
		);

		expect(spawn).toHaveBeenCalledTimes(1);
	});

	test.each([
		["wrong key", { externalKey: "toolbox:automation:wrong" }],
		[
			"wrong id",
			{ expectedScheduleId: "00000000-0000-4000-8000-000000000099" },
		],
		["wrong organization", { organizationId: OTHER_ORGANIZATION_ID }],
	])("rejects activation with %s", async (_label, override) => {
		const staged = await stageScheduledJobByExternalKey(stagedParams());
		expect(staged.status).toBe("ok");
		if (staged.status !== "ok") return;

		const result = await activateScheduledJobByExternalKey({
			organizationId: ORGANIZATION_ID,
			externalKey: creationKey(staged.job),
			expectedScheduleId: staged.job.id,
			...override,
		});

		expect(result.status).toBe("not_found");
		expect(
			(
				await getScheduledJobByExternalKey(
					ORGANIZATION_ID,
					creationKey(staged.job),
				)
			)?.state,
		).toBe("staged");
	});

	test("rejects activation after until_at", async () => {
		const staged = await stageScheduledJobByExternalKey(
			stagedParams({
				runAt: new Date("2026-07-15T09:00:00.000Z"),
				untilAt: new Date("2026-07-15T09:00:00.000Z"),
			}),
		);
		expect(staged.status).toBe("ok");
		if (staged.status !== "ok") return;

		const result = await activateScheduledJobByExternalKey({
			organizationId: ORGANIZATION_ID,
			externalKey: creationKey(staged.job),
			expectedScheduleId: staged.job.id,
			now: new Date("2026-07-15T09:00:00.001Z"),
		});

		expect(result.status).toBe("expired");
		expect(
			(
				await getScheduledJobByExternalKey(
					ORGANIZATION_ID,
					creationKey(staged.job),
				)
			)?.state,
		).toBe("staged");
	});

	test("rejects activation once the first run time has arrived", async () => {
		const staged = await stageScheduledJobByExternalKey(
			stagedParams({ runAt: new Date("2026-07-15T09:00:00.000Z") }),
		);
		expect(staged.status).toBe("ok");
		if (staged.status !== "ok") return;

		const result = await activateScheduledJobByExternalKey({
			organizationId: ORGANIZATION_ID,
			externalKey: creationKey(staged.job),
			expectedScheduleId: staged.job.id,
			now: new Date("2026-07-15T09:00:00.000Z"),
		});

		expect(result.status).toBe("expired");
	});

	test("paused or canceled staged work cannot be activated", async () => {
		const paused = await stageScheduledJobByExternalKey(stagedParams());
		expect(paused.status).toBe("ok");
		if (paused.status !== "ok") return;
		await pauseScheduledJob(ORGANIZATION_ID, paused.job.id, true);
		expect(
			(
				await activateScheduledJobByExternalKey({
					organizationId: ORGANIZATION_ID,
					externalKey: creationKey(paused.job),
					expectedScheduleId: paused.job.id,
				})
			).status,
		).toBe("paused");

		await deleteScheduledJob(ORGANIZATION_ID, paused.job.id);
		expect(
			(
				await activateScheduledJobByExternalKey({
					organizationId: ORGANIZATION_ID,
					externalKey: creationKey(paused.job),
					expectedScheduleId: paused.job.id,
				})
			).status,
		).toBe("not_found");
	});
});
