import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { getDb } from "../../db/client.js";
import {
	ensureDbForGatewayTests,
	resetTestDatabase,
	seedAgentRow,
} from "../../gateway/__tests__/helpers/db-setup.js";
import {
	cancelTrustedCourseWake,
	dispatchScheduledJobCandidate,
	scheduleHasExpired,
	upsertScheduledJobByExternalKey,
	upsertScheduledJobByExternalKeyWithQuota,
} from "../scheduled-jobs-service.js";
import type { ScheduledJobRow } from "../scheduled-jobs-service.js";

const ORGANIZATION_ID = "org-revision";
const OWNER_USER_ID = "pm-revision";
const AGENT_ID = "shifu-u-pm-revision";

function actionArgs(version: string, scheduledFor: string) {
	return {
		agent_id: AGENT_ID,
		prompt: "course wake",
		trustedCourseWake: {
			calendarEventRef: { eventVersion: version },
			scheduledFor,
		},
	};
}

describe("scheduled job revision guard", () => {
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

	test("a candidate claimed before a concurrent reschedule cannot spawn stale action args", async () => {
		const externalKey = "google_calendar:acct:event:opp_coach_event_prompt";
		const dueAt = "2026-07-12T00:00:00.000Z";
		await upsertScheduledJobByExternalKey({
			externalKey,
			organizationId: ORGANIZATION_ID,
			actionType: "wake_agent",
			actionArgs: actionArgs("v1", dueAt),
			description: "old",
			runAt: new Date(dueAt),
			createdByUser: OWNER_USER_ID,
			createdByAgent: AGENT_ID,
		});
		const [staleCandidate] = await getDb()<{
			id: string;
			schedule_revision: number;
		}>`
			SELECT id, schedule_revision FROM scheduled_jobs
			WHERE organization_id = ${ORGANIZATION_ID}
			  AND created_by_user = ${OWNER_USER_ID}
			  AND external_key = ${externalKey}
		`;

		const futureAt = "2026-07-14T09:00:00.000Z";
		await upsertScheduledJobByExternalKey({
			externalKey,
			organizationId: ORGANIZATION_ID,
			actionType: "wake_agent",
			actionArgs: actionArgs("v2", futureAt),
			description: "new",
			runAt: new Date(futureAt),
			createdByUser: OWNER_USER_ID,
			createdByAgent: AGENT_ID,
		});

		const spawn = mock(async () => "run-1");
		expect(staleCandidate).toBeDefined();
		if (!staleCandidate) throw new Error("expected stale candidate fixture");
		await dispatchScheduledJobCandidate(staleCandidate, { spawn } as never);
		expect(spawn).not.toHaveBeenCalled();
	});

	test("the current revision spawns once and atomically completes a one-shot", async () => {
		const externalKey =
			"google_calendar:acct:event-current:opp_coach_event_prompt";
		const dueAt = "2026-07-12T00:00:00.000Z";
		await upsertScheduledJobByExternalKey({
			externalKey,
			organizationId: ORGANIZATION_ID,
			actionType: "wake_agent",
			actionArgs: actionArgs("v1", dueAt),
			description: "current",
			runAt: new Date(dueAt),
			createdByUser: OWNER_USER_ID,
			createdByAgent: AGENT_ID,
		});
		const [candidate] = await getDb()<{
			id: string;
			schedule_revision: number;
		}>`
			SELECT id, schedule_revision FROM scheduled_jobs
			WHERE organization_id = ${ORGANIZATION_ID}
			  AND created_by_user = ${OWNER_USER_ID}
			  AND external_key = ${externalKey}
		`;
		expect(candidate).toBeDefined();
		if (!candidate) throw new Error("expected current candidate fixture");
		const spawn = mock(async () => "run-1");

		await dispatchScheduledJobCandidate(candidate, { spawn } as never);

		expect(spawn).toHaveBeenCalledTimes(1);
		expect(spawn.mock.calls[0]?.[1]).toMatchObject({
			agent_id: AGENT_ID,
			__scheduled_job_revision: 1,
		});
		const [completed] = await getDb()<{
			paused: boolean;
			last_fired_at: Date | null;
		}>`SELECT paused, last_fired_at FROM scheduled_jobs WHERE id = ${candidate.id}`;
		expect(completed?.paused).toBe(true);
		expect(completed?.last_fired_at).not.toBeNull();
	});

	test("a recurring schedule persists its stop time and cannot fire after expiry", async () => {
		const externalKey = "toolbox:schedule:bounded";
		const untilAt = new Date(Date.now() - 60_000);
		const job = await upsertScheduledJobByExternalKey({
			externalKey,
			organizationId: ORGANIZATION_ID,
			actionType: "wake_agent",
			actionArgs: { agent_id: AGENT_ID, prompt: "bounded wake" },
			description: "bounded recurring wake",
			cron: "* * * * *",
			runAt: new Date(Date.now() - 120_000),
			untilAt,
			createdByUser: OWNER_USER_ID,
			createdByAgent: AGENT_ID,
			changeDetection: "full",
		});
		const [persisted] = await getDb()<Array<{ until_at: Date | null }>>`
			SELECT until_at FROM scheduled_jobs WHERE id = ${job.id}
		`;
		const spawn = mock(async () => "run-expired");

		expect(persisted?.until_at?.toISOString()).toBe(untilAt.toISOString());
		await dispatchScheduledJobCandidate(job, { spawn } as never);
		await dispatchScheduledJobCandidate(job, { spawn } as never);

		expect(spawn).not.toHaveBeenCalled();
		const [expired] = await getDb()<Array<{ paused: boolean }>>`
			SELECT paused FROM scheduled_jobs WHERE id = ${job.id}
		`;
		expect(expired?.paused).toBe(true);
	});

	test("the final due run is inclusive when database now equals until_at", () => {
		const finalRunAt = "2030-06-30T09:00:00.000Z";

		expect(scheduleHasExpired(finalRunAt, finalRunAt, finalRunAt)).toBe(false);
		expect(
			scheduleHasExpired(finalRunAt, finalRunAt, "2030-06-30T09:00:05.000Z"),
		).toBe(false);
		expect(
			scheduleHasExpired(finalRunAt, finalRunAt, "2030-06-30T09:01:00.001Z"),
		).toBe(true);
	});

	test("dispatches a final recurring run after a small scheduler delay and then pauses", async () => {
		const finalRunAt = new Date(Date.now() - 5_000);
		const job = await upsertScheduledJobByExternalKey({
			externalKey: "toolbox:schedule:slightly-late-final",
			organizationId: ORGANIZATION_ID,
			actionType: "wake_agent",
			actionArgs: { agent_id: AGENT_ID, prompt: "final delayed wake" },
			description: "slightly late final wake",
			cron: "* * * * *",
			runAt: finalRunAt,
			untilAt: finalRunAt,
			createdByUser: OWNER_USER_ID,
			createdByAgent: AGENT_ID,
			changeDetection: "full",
		});
		const spawn = mock(async () => "run-final-delayed");

		await dispatchScheduledJobCandidate(job, { spawn } as never);

		expect(spawn).toHaveBeenCalledTimes(1);
		const [completed] = await getDb()<Array<{ paused: boolean; last_fired_at: Date | null }>>`
			SELECT paused, last_fired_at FROM scheduled_jobs WHERE id = ${job.id}
		`;
		expect(completed?.paused).toBe(true);
		expect(completed?.last_fired_at).not.toBeNull();
	});

	test("does not catch up a final recurring run that is clearly stale", async () => {
		const finalRunAt = new Date(Date.now() - 120_000);
		const job = await upsertScheduledJobByExternalKey({
			externalKey: "toolbox:schedule:stale-final",
			organizationId: ORGANIZATION_ID,
			actionType: "wake_agent",
			actionArgs: { agent_id: AGENT_ID, prompt: "stale final wake" },
			description: "stale final wake",
			cron: "* * * * *",
			runAt: finalRunAt,
			untilAt: finalRunAt,
			createdByUser: OWNER_USER_ID,
			createdByAgent: AGENT_ID,
			changeDetection: "full",
		});
		const spawn = mock(async () => "run-stale-final");

		await dispatchScheduledJobCandidate(job, { spawn } as never);

		expect(spawn).not.toHaveBeenCalled();
		const [expired] = await getDb()<Array<{ paused: boolean }>>`
			SELECT paused FROM scheduled_jobs WHERE id = ${job.id}
		`;
		expect(expired?.paused).toBe(true);
	});

	test("narrow cancellation pauses only the exact trusted owner wake and is idempotent", async () => {
		const externalKey = "google_calendar:acct:cancel:opp_coach_event_prompt";
		const scheduledFor = "2026-07-14T09:00:00.000Z";
		const job = await upsertScheduledJobByExternalKey({
			externalKey,
			organizationId: ORGANIZATION_ID,
			actionType: "wake_agent",
			actionArgs: {
				agent_id: AGENT_ID,
				reason: "trusted-course-calendar-wake",
				trustedCourseWake: {
					source: "calendar_scheduled_wake",
					trustedCourseScope: { ownerUserId: OWNER_USER_ID, agentId: AGENT_ID },
					calendarEventRef: { eventVersion: "v1" },
					scheduledFor,
				},
			},
			description: "trusted",
			runAt: new Date(scheduledFor),
			createdByUser: OWNER_USER_ID,
			createdByAgent: AGENT_ID,
		});

		expect(
			await cancelTrustedCourseWake({
				engineRef: job.id,
				externalKey,
				organizationId: ORGANIZATION_ID,
				ownerUserId: "someone-else",
				agentId: AGENT_ID,
			}),
		).toEqual({ found: false, alreadyCancelled: false });
		expect(
			await cancelTrustedCourseWake({
				engineRef: job.id,
				externalKey,
				organizationId: ORGANIZATION_ID,
				ownerUserId: OWNER_USER_ID,
				agentId: AGENT_ID,
			}),
		).toEqual({ found: true, alreadyCancelled: false });
		expect(
			await cancelTrustedCourseWake({
				engineRef: job.id,
				externalKey,
				organizationId: ORGANIZATION_ID,
				ownerUserId: OWNER_USER_ID,
				agentId: AGENT_ID,
			}),
		).toEqual({ found: true, alreadyCancelled: true });
	});

	test("full change detection returns the same row and revision for an identical user/key payload", async () => {
		const externalKey = "toolbox:schedule:same";
		const runAt = new Date("2030-01-01T09:00:00.000Z");
		const params = {
			externalKey,
			organizationId: ORGANIZATION_ID,
			actionType: "wake_agent",
			actionArgs: { agent_id: AGENT_ID, prompt: "ordinary wake" },
			description: "ordinary",
			runAt,
			createdByUser: OWNER_USER_ID,
			createdByAgent: AGENT_ID,
			changeDetection: "full" as const,
		};

		const first = await upsertScheduledJobByExternalKey(params);
		const second = await upsertScheduledJobByExternalKey(params);
		const [{ count }] = await getDb()<[{ count: number }]>`
			SELECT count(*)::int AS count FROM scheduled_jobs
			WHERE organization_id = ${ORGANIZATION_ID}
			  AND created_by_user = ${OWNER_USER_ID}
			  AND external_key = ${externalKey}
		`;

		expect(second.id).toBe(first.id);
		expect(second.schedule_revision).toBe(first.schedule_revision);
		expect(count).toBe(1);
	});

	test("full change detection updates one row and increments revision for changed payload and schedule", async () => {
		const externalKey = "toolbox:schedule:changed";
		const first = await upsertScheduledJobByExternalKey({
			externalKey,
			organizationId: ORGANIZATION_ID,
			actionType: "wake_agent",
			actionArgs: { agent_id: AGENT_ID, prompt: "first" },
			description: "first description",
			runAt: new Date("2030-01-01T09:00:00.000Z"),
			createdByUser: OWNER_USER_ID,
			createdByAgent: AGENT_ID,
			changeDetection: "full",
		});
		const second = await upsertScheduledJobByExternalKey({
			externalKey,
			organizationId: ORGANIZATION_ID,
			actionType: "wake_agent",
			actionArgs: { agent_id: AGENT_ID, prompt: "second" },
			description: "second description",
			cron: "0 9 * * *",
			runAt: new Date("2030-01-02T09:00:00.000Z"),
			createdByUser: OWNER_USER_ID,
			createdByAgent: AGENT_ID,
			changeDetection: "full",
		});
		const [{ count }] = await getDb()<[{ count: number }]>`
			SELECT count(*)::int AS count FROM scheduled_jobs
			WHERE organization_id = ${ORGANIZATION_ID}
			  AND created_by_user = ${OWNER_USER_ID}
			  AND external_key = ${externalKey}
		`;

		expect(second.id).toBe(first.id);
		expect(second.schedule_revision).toBe(first.schedule_revision + 1);
		expect(second.action_args).toEqual({ agent_id: AGENT_ID, prompt: "second" });
		expect(second.cron).toBe("0 9 * * *");
		expect(second.description).toBe("second description");
		expect(count).toBe(1);
	});

	test("the same organization and external key return the original schedule across users", async () => {
		const externalKey = "toolbox:schedule:shared-key";
		const otherUserId = "pm-revision-other";
		const first = await upsertScheduledJobByExternalKey({
			externalKey,
			organizationId: ORGANIZATION_ID,
			actionType: "wake_agent",
			actionArgs: { agent_id: AGENT_ID, prompt: "original wake" },
			description: "original",
			runAt: new Date("2030-01-01T09:00:00.000Z"),
			createdByUser: OWNER_USER_ID,
			createdByAgent: AGENT_ID,
			changeDetection: "full",
		});
		const second = await upsertScheduledJobByExternalKey({
			externalKey,
			organizationId: ORGANIZATION_ID,
			actionType: "wake_agent",
			actionArgs: { agent_id: AGENT_ID, prompt: "replacement wake" },
			description: "replacement",
			runAt: new Date("2030-01-02T09:00:00.000Z"),
			createdByUser: otherUserId,
			createdByAgent: AGENT_ID,
			changeDetection: "full",
		});
		const [{ count }] = await getDb()<[{ count: number }]>`
			SELECT count(*)::int AS count FROM scheduled_jobs
			WHERE organization_id = ${ORGANIZATION_ID} AND external_key = ${externalKey}
		`;

		expect(second).toMatchObject({
			id: first.id,
			created_by_user: OWNER_USER_ID,
			action_args: { agent_id: AGENT_ID, prompt: "original wake" },
			description: "original",
			schedule_revision: first.schedule_revision,
		});
		expect(count).toBe(1);
	});

	test("full change detection rearms a paused key and increments its revision", async () => {
		const externalKey = "toolbox:schedule:rearm-paused";
		const params = {
			externalKey,
			organizationId: ORGANIZATION_ID,
			actionType: "wake_agent",
			actionArgs: { agent_id: AGENT_ID, prompt: "ordinary wake" },
			description: "ordinary",
			runAt: new Date("2030-01-01T09:00:00.000Z"),
			createdByUser: OWNER_USER_ID,
			createdByAgent: AGENT_ID,
			changeDetection: "full" as const,
		};
		const first = await upsertScheduledJobByExternalKey(params);
		await getDb()`UPDATE scheduled_jobs SET paused = true WHERE id = ${first.id}`;

		const rearmed = await upsertScheduledJobByExternalKey(params);

		expect(rearmed.id).toBe(first.id);
		expect(rearmed.paused).toBe(false);
		expect(rearmed.schedule_revision).toBe(first.schedule_revision + 1);
	});

	test("full change detection never rearms an expired completed one-shot on identical retry", async () => {
		const externalKey = "toolbox:schedule:expired-identical";
		const pastRunAt = new Date("2020-01-01T09:00:00.000Z");
		const params = {
			externalKey,
			organizationId: ORGANIZATION_ID,
			actionType: "wake_agent",
			actionArgs: { agent_id: AGENT_ID, prompt: "already fired" },
			description: "expired",
			runAt: pastRunAt,
			createdByUser: OWNER_USER_ID,
			createdByAgent: AGENT_ID,
			changeDetection: "full" as const,
		};
		const first = await upsertScheduledJobByExternalKey(params);
		await getDb()`
			UPDATE scheduled_jobs
			SET paused = true, last_fired_at = now(), last_fired_run_id = 42
			WHERE id = ${first.id}
		`;
		const [completed] = await getDb()<ScheduledJobRow[]>`
			SELECT * FROM scheduled_jobs WHERE id = ${first.id}
		`;

		const retried = await upsertScheduledJobByExternalKey(params);

		expect(retried).toMatchObject({
			id: completed!.id,
			paused: true,
			schedule_revision: completed!.schedule_revision,
			last_fired_run_id: 42,
		});
	});

	test("full change detection never rearms an expired paused recurring schedule on identical retry", async () => {
		const externalKey = "toolbox:schedule:expired-recurring";
		const untilAt = new Date("2020-01-01T09:05:00.000Z");
		const params = {
			externalKey,
			organizationId: ORGANIZATION_ID,
			actionType: "wake_agent",
			actionArgs: { agent_id: AGENT_ID, prompt: "already completed" },
			description: "expired recurring",
			cron: "* * * * *",
			runAt: new Date("2020-01-01T09:00:00.000Z"),
			untilAt,
			createdByUser: OWNER_USER_ID,
			createdByAgent: AGENT_ID,
			changeDetection: "full" as const,
		};
		const first = await upsertScheduledJobByExternalKey(params);
		await getDb()`
			UPDATE scheduled_jobs
			SET paused = true, next_run_at = ${untilAt}, last_fired_at = ${untilAt}, last_fired_run_id = 43
			WHERE id = ${first.id}
		`;
		const [completed] = await getDb()<ScheduledJobRow[]>`
			SELECT * FROM scheduled_jobs WHERE id = ${first.id}
		`;

		const retried = await upsertScheduledJobByExternalKey(params);

		expect(retried).toMatchObject({
			id: completed!.id,
			paused: true,
			schedule_revision: completed!.schedule_revision,
			last_fired_run_id: 43,
		});
		expect(new Date(retried.next_run_at).toISOString()).toBe(
			new Date(completed!.next_run_at).toISOString(),
		);
	});

	test("full change detection never rearms an expired completed one-shot with changed payload", async () => {
		const externalKey = "toolbox:schedule:expired-changed";
		const common = {
			externalKey,
			organizationId: ORGANIZATION_ID,
			actionType: "wake_agent",
			description: "expired",
			runAt: new Date("2020-01-01T09:00:00.000Z"),
			createdByUser: OWNER_USER_ID,
			createdByAgent: AGENT_ID,
			changeDetection: "full" as const,
		};
		const first = await upsertScheduledJobByExternalKey({
			...common,
			actionArgs: { agent_id: AGENT_ID, prompt: "already fired" },
		});
		await getDb()`
			UPDATE scheduled_jobs
			SET paused = true, last_fired_at = now(), last_fired_run_id = 43
			WHERE id = ${first.id}
		`;
		const [completed] = await getDb()<ScheduledJobRow[]>`
			SELECT * FROM scheduled_jobs WHERE id = ${first.id}
		`;

		const retried = await upsertScheduledJobByExternalKey({
			...common,
			cron: "*/5 * * * *",
			actionArgs: { agent_id: AGENT_ID, prompt: "changed after firing" },
		});

		expect(retried).toMatchObject({
			id: completed!.id,
			paused: true,
			schedule_revision: completed!.schedule_revision,
			last_fired_run_id: 43,
			cron: null,
			action_args: { agent_id: AGENT_ID, prompt: "already fired" },
		});
	});

	test("full change detection treats separately constructed nested JSON key order as identical", async () => {
		const externalKey = "toolbox:schedule:nested-order";
		const common = {
			externalKey,
			organizationId: ORGANIZATION_ID,
			actionType: "wake_agent",
			description: "nested",
			runAt: new Date("2030-01-01T09:00:00.000Z"),
			createdByUser: OWNER_USER_ID,
			createdByAgent: AGENT_ID,
			changeDetection: "full" as const,
		};
		const first = await upsertScheduledJobByExternalKey({
			...common,
			actionArgs: {
				agent_id: AGENT_ID,
				metadata: { outer: { alpha: 1, beta: 2 }, values: [{ left: true, right: false }] },
			},
		});
		const second = await upsertScheduledJobByExternalKey({
			...common,
			actionArgs: {
				metadata: { values: [{ right: false, left: true }], outer: { beta: 2, alpha: 1 } },
				agent_id: AGENT_ID,
			},
		});

		expect(second.id).toBe(first.id);
		expect(second.schedule_revision).toBe(first.schedule_revision);
	});

	test("concurrent same-key creates serialize to one row and one id", async () => {
		const externalKey = "toolbox:schedule:concurrent";
		const params = {
			externalKey,
			organizationId: ORGANIZATION_ID,
			actionType: "wake_agent",
			actionArgs: { agent_id: AGENT_ID, prompt: "concurrent" },
			description: "concurrent",
			runAt: new Date("2030-01-01T09:00:00.000Z"),
			createdByUser: OWNER_USER_ID,
			createdByAgent: AGENT_ID,
			changeDetection: "full" as const,
		};

		const [first, second] = await Promise.all([
			upsertScheduledJobByExternalKey(params),
			upsertScheduledJobByExternalKey(params),
		]);
		const [{ count }] = await getDb()<[{ count: number }]>`
			SELECT count(*)::int AS count FROM scheduled_jobs
			WHERE organization_id = ${ORGANIZATION_ID}
			  AND created_by_user = ${OWNER_USER_ID}
			  AND external_key = ${externalKey}
		`;

		expect(second.id).toBe(first.id);
		expect(count).toBe(1);
	});

	test("concurrent same-key creates across users return one organization schedule", async () => {
		const externalKey = "toolbox:schedule:concurrent-cross-user";
		const common = {
			externalKey,
			organizationId: ORGANIZATION_ID,
			actionType: "wake_agent",
			actionArgs: { agent_id: AGENT_ID, prompt: "concurrent cross-user" },
			description: "concurrent cross-user",
			runAt: new Date("2030-01-01T09:00:00.000Z"),
			createdByAgent: AGENT_ID,
			changeDetection: "full" as const,
		};

		const [first, second] = await Promise.all([
			upsertScheduledJobByExternalKey({
				...common,
				createdByUser: OWNER_USER_ID,
			}),
			upsertScheduledJobByExternalKey({
				...common,
				createdByUser: "pm-revision-other",
			}),
		]);
		const [{ count }] = await getDb()<[{ count: number }]>`
			SELECT count(*)::int AS count FROM scheduled_jobs
			WHERE organization_id = ${ORGANIZATION_ID} AND external_key = ${externalKey}
		`;

		expect(second.id).toBe(first.id);
		expect(count).toBe(1);
	});

	test("atomic keyed quota allows active retry but rejects new and paused-to-active capacity", async () => {
		const activeKey = "toolbox:schedule:quota-active";
		const pausedKey = "toolbox:schedule:quota-paused";
		const common = {
			organizationId: ORGANIZATION_ID,
			actionType: "wake_agent",
			actionArgs: { agent_id: AGENT_ID, prompt: "quota" },
			description: "quota",
			runAt: new Date("2030-01-01T09:00:00.000Z"),
			createdByUser: OWNER_USER_ID,
			createdByAgent: AGENT_ID,
			changeDetection: "full" as const,
		};
		const active = await upsertScheduledJobByExternalKey({ ...common, externalKey: activeKey });
		const paused = await upsertScheduledJobByExternalKey({ ...common, externalKey: pausedKey });
		await getDb()`UPDATE scheduled_jobs SET paused = true WHERE id = ${paused.id}`;

		expect(
			await upsertScheduledJobByExternalKeyWithQuota({
				...common,
				externalKey: activeKey,
				activeQuota: 1,
			}),
		).toMatchObject({ status: "ok", job: { id: active.id } });
		expect(
			await upsertScheduledJobByExternalKeyWithQuota({
				...common,
				externalKey: "toolbox:schedule:quota-new",
				activeQuota: 1,
			}),
		).toEqual({ status: "quota_exceeded", activeCount: 1 });
		expect(
			await upsertScheduledJobByExternalKeyWithQuota({
				...common,
				externalKey: pausedKey,
				activeQuota: 1,
			}),
		).toEqual({ status: "quota_exceeded", activeCount: 1 });
	});

	test("concurrent distinct keys cannot both claim the final active quota slot", async () => {
		const common = {
			organizationId: ORGANIZATION_ID,
			actionType: "wake_agent",
			actionArgs: { agent_id: AGENT_ID, prompt: "quota race" },
			description: "quota race",
			runAt: new Date("2030-01-01T09:00:00.000Z"),
			createdByUser: OWNER_USER_ID,
			createdByAgent: AGENT_ID,
			changeDetection: "full" as const,
			activeQuota: 1,
		};

		const outcomes = await Promise.all([
			upsertScheduledJobByExternalKeyWithQuota({
				...common,
				externalKey: "toolbox:schedule:quota-race-a",
			}),
			upsertScheduledJobByExternalKeyWithQuota({
				...common,
				externalKey: "toolbox:schedule:quota-race-b",
			}),
		]);
		const [{ count }] = await getDb()<[{ count: number }]>`
			SELECT count(*)::int AS count FROM scheduled_jobs
			WHERE organization_id = ${ORGANIZATION_ID}
			  AND created_by_user = ${OWNER_USER_ID}
			  AND NOT paused
		`;

		expect(outcomes.map((outcome) => outcome.status).sort()).toEqual([
			"ok",
			"quota_exceeded",
		]);
		expect(count).toBe(1);
	});
});
