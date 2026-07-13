import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { getDb } from "../../db/client.js";
import {
	ensureDbForGatewayTests,
	resetTestDatabase,
	seedAgentRow,
} from "../../gateway/__tests__/helpers/db-setup.js";
import { createCourseAwareWakeRoutes } from "../course-aware-wake-routes.js";
import { orgContext } from "../stores/org-context.js";

const ORGANIZATION_ID = "org-1";
const OWNER_USER_ID = "pm-1";
const AGENT_ID = "shifu-u-pm-1";

function buildApp(
	scopes: string[] = ["mcp:admin"],
	routes = createCourseAwareWakeRoutes(),
) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("session", { id: "pat:course-aware-wake-test" });
		c.set("organizationId", ORGANIZATION_ID);
		c.set("authSource", "pat");
		c.set("mcpAuthInfo", { scopes });
		return orgContext.run({ organizationId: ORGANIZATION_ID }, next);
	});
	app.route("/api/internal/course-aware-wakes", routes);
	return app;
}

function requestBody(runAt = "2026-07-14T06:00:00.000Z") {
	return {
		externalKey: "google_calendar:acct-1:event-1:opp_coach_event_prompt",
		organizationId: ORGANIZATION_ID,
		ownerUserId: OWNER_USER_ID,
		agentId: AGENT_ID,
		runAt,
		payload: {
			schemaVersion: 1,
			source: "calendar_scheduled_wake",
			automationId: "auto-1",
			triggerSource: "google_calendar",
			calendarEventRef: {
				accountRef: "acct-1",
				eventId: "event-1",
				eventVersion: "v1",
				eventTitle: "雷蒙銷講",
				eventStartAt: "2026-07-15T14:00:00+08:00",
			},
			trustedCourseScope: {
				ownerUserId: OWNER_USER_ID,
				agentId: AGENT_ID,
				courseEntityId: "course:pm-1:course-a",
				courseKey: "course-a",
				courseDisplayName: "課程 A",
				resolutionSource: "toolbox_calendar_course_resolver",
				resolutionMatchedBy: ["instructor_alias"],
				scopeVersion: 1,
			},
			taskKind: "opp_coach_event_prompt",
			delivery: "line",
			scheduledFor: runAt,
		},
	};
}

describe("course-aware wake routes", () => {
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

	test("upserts one trusted calendar wake by external key", async () => {
		const app = buildApp();
		const first = await app.request("/api/internal/course-aware-wakes", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(requestBody()),
		});
		expect(first.status).toBe(200);

		const second = await app.request("/api/internal/course-aware-wakes", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(requestBody("2026-07-14T07:00:00.000Z")),
		});
		expect(second.status).toBe(200);

		const rows = await getDb()<{
			external_key: string;
			next_run_at: Date;
			paused: boolean;
			action_args: Record<string, unknown>;
		}>`
      SELECT external_key, next_run_at, paused, action_args
      FROM scheduled_jobs
      WHERE external_key = ${requestBody().externalKey}
    `;
		expect(rows).toHaveLength(1);
		expect(rows[0]?.next_run_at.toISOString()).toBe("2026-07-14T07:00:00.000Z");
		expect(rows[0]?.paused).toBe(false);
		expect(rows[0]?.action_args).toMatchObject({
			agent_id: AGENT_ID,
			trustedCourseWake: requestBody("2026-07-14T07:00:00.000Z").payload,
		});
	});

	test("isolates the same provider event external key for two owners in one organization", async () => {
		const secondOwner = "pm-2";
		const secondAgent = "shifu-u-pm-2";
		await seedAgentRow(secondAgent, {
			organizationId: ORGANIZATION_ID,
			ownerPlatform: "toolbox",
			ownerUserId: secondOwner,
		});
		const app = buildApp();
		const firstBody = requestBody();
		const secondBody = requestBody();
		secondBody.ownerUserId = secondOwner;
		secondBody.agentId = secondAgent;
		secondBody.payload.trustedCourseScope.ownerUserId = secondOwner;
		secondBody.payload.trustedCourseScope.agentId = secondAgent;

		for (const body of [firstBody, secondBody]) {
			const response = await app.request("/api/internal/course-aware-wakes", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			expect(response.status).toBe(200);
		}

		const rows = await getDb()<{
			created_by_user: string;
			external_key: string;
		}>`
			SELECT created_by_user, external_key FROM scheduled_jobs
			WHERE organization_id = ${ORGANIZATION_ID}
			  AND external_key = ${firstBody.externalKey}
			ORDER BY created_by_user
		`;
		expect(rows).toEqual([
			{ created_by_user: OWNER_USER_ID, external_key: firstBody.externalKey },
			{ created_by_user: secondOwner, external_key: firstBody.externalKey },
		]);
	});

	test("does not re-arm an identical fired wake but re-arms a changed future provider revision", async () => {
		const app = buildApp();
		const original = requestBody();
		await app.request("/api/internal/course-aware-wakes", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(original),
		});
		await getDb()`
			UPDATE scheduled_jobs
			SET paused = true, last_fired_at = now()
			WHERE organization_id = ${ORGANIZATION_ID}
			  AND created_by_user = ${OWNER_USER_ID}
			  AND external_key = ${original.externalKey}
		`;

		const replay = await app.request("/api/internal/course-aware-wakes", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(original),
		});
		expect(replay.status).toBe(200);
		let [row] = await getDb()<{
			paused: boolean;
			last_fired_at: Date | null;
			schedule_revision: number;
		}>`
			SELECT paused, last_fired_at, schedule_revision FROM scheduled_jobs
			WHERE organization_id = ${ORGANIZATION_ID}
			  AND created_by_user = ${OWNER_USER_ID}
			  AND external_key = ${original.externalKey}
		`;
		expect(row).toMatchObject({ paused: true, schedule_revision: 1 });
		expect(row?.last_fired_at).not.toBeNull();

		const changed = requestBody("2026-07-14T08:00:00.000Z");
		changed.payload.calendarEventRef.eventVersion = "v2";
		const changedResponse = await app.request(
			"/api/internal/course-aware-wakes",
			{
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(changed),
			},
		);
		expect(changedResponse.status).toBe(200);
		[row] = await getDb()`
			SELECT paused, last_fired_at, schedule_revision FROM scheduled_jobs
			WHERE organization_id = ${ORGANIZATION_ID}
			  AND created_by_user = ${OWNER_USER_ID}
			  AND external_key = ${original.externalKey}
		`;
		expect(row).toEqual({
			paused: false,
			last_fired_at: null,
			schedule_revision: 2,
		});
	});

	test("requires an admin PAT and rejects invalid trust claims", async () => {
		const denied = await buildApp(["mcp:write"]).request(
			"/api/internal/course-aware-wakes",
			{
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(requestBody()),
			},
		);
		expect(denied.status).toBe(403);

		const mismatched = requestBody();
		mismatched.payload.trustedCourseScope.ownerUserId = "someone-else";
		const invalid = await buildApp().request(
			"/api/internal/course-aware-wakes",
			{
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(mismatched),
			},
		);
		expect(invalid.status).toBe(400);
	});

	test("rejects unsupported trigger source and incomplete calendar provenance", async () => {
		const cases = [
			() => {
				const body = requestBody();
				(body.payload as Record<string, unknown>).triggerSource = "manual";
				return body;
			},
			() => {
				const body = requestBody();
				delete (body.payload as Record<string, unknown>).calendarEventRef;
				return body;
			},
			() => {
				const body = requestBody();
				body.payload.calendarEventRef.eventId = "";
				return body;
			},
			() => {
				const body = requestBody();
				(body.payload as Record<string, unknown>).scheduledFor = "not-a-date";
				return body;
			},
			() => {
				const body = requestBody();
				delete (body.payload as Record<string, unknown>).scheduledFor;
				return body;
			},
		];

		for (const invalidBody of cases) {
			const response = await buildApp().request(
				"/api/internal/course-aware-wakes",
				{
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(invalidBody()),
				},
			);
			expect(response.status).toBe(400);
		}
	});

	test("rejects impossible timestamps and runAt/scheduledFor mismatch", async () => {
		const impossible = requestBody();
		impossible.runAt = "2026-02-30T06:00:00.000Z";
		impossible.payload.scheduledFor = impossible.runAt;
		const mismatch = requestBody();
		mismatch.payload.scheduledFor = "2026-07-14T06:01:00.000Z";

		for (const body of [impossible, mismatch]) {
			const response = await buildApp().request(
				"/api/internal/course-aware-wakes",
				{
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				},
			);
			expect(response.status).toBe(400);
		}
	});

	test("returns a sanitized 500 for operational failures", async () => {
		const routes = createCourseAwareWakeRoutes({
			upsertScheduledJobByExternalKey: async () => {
				throw new Error("database password leaked in driver error");
			},
		});
		const response = await buildApp(["mcp:admin"], routes).request(
			"/api/internal/course-aware-wakes",
			{
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(requestBody()),
			},
		);
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({
			error: "course_wake_upsert_failed",
		});
	});
});
