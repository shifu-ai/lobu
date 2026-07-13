import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { getDb } from "../../db/client.js";
import {
	ensureDbForGatewayTests,
	resetTestDatabase,
	seedAgentRow,
} from "../../gateway/__tests__/helpers/db-setup.js";
import {
	dispatchScheduledJobCandidate,
	upsertScheduledJobByExternalKey,
} from "../scheduled-jobs-service.js";

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
});
