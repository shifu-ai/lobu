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

function buildApp(scopes: string[] = ["mcp:admin"]) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("session", { id: "pat:course-aware-wake-test" });
		c.set("organizationId", ORGANIZATION_ID);
		c.set("authSource", "pat");
		c.set("mcpAuthInfo", { scopes });
		return orgContext.run({ organizationId: ORGANIZATION_ID }, next);
	});
	app.route("/api/internal/course-aware-wakes", createCourseAwareWakeRoutes());
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
});
