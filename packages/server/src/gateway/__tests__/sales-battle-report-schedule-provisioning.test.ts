import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { getDb } from "../../db/client.js";
import { orgContext } from "../../lobu/stores/org-context.js";
import {
	buildSalesBattleReportScheduledJobs,
	createProvisioningRoutes,
} from "../routes/provisioning/index.js";
import {
	ensureDbForGatewayTests,
	resetTestDatabase,
	seedAgentRow,
} from "./helpers/db-setup.js";

const ORG_ID = "org-sales-battle-report";
const CREATED_BY_USER = "toolbox-user-1";
const AGENT_ID = "shifu-u-sales-battle";

function buildApp(scopes: string[] = ["mcp:admin"]) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { id: CREATED_BY_USER });
		c.set("session", { id: "pat:test-sales-battle-report" });
		c.set("organizationId", ORG_ID);
		c.set("authSource", "pat");
		c.set("mcpAuthInfo", { scopes });
		return orgContext.run({ organizationId: ORG_ID }, next);
	});
	app.route("/api/provisioning", createProvisioningRoutes());
	return app;
}

function requestBody() {
	return {
		organizationId: ORG_ID,
		createdByUser: CREATED_BY_USER,
		agentId: AGENT_ID,
		toolboxScheduleId: "sales_battle_report_schedule_abc123",
		trialSessionAgentId: "trial-session-agent-1",
		displayName: "技術分析全攻略",
		salesTalkWeekdays: [0, 2],
	};
}

describe("sales battle report schedule provisioning", () => {
	beforeAll(async () => {
		await ensureDbForGatewayTests();
	}, 60_000);

	beforeEach(async () => {
		await resetTestDatabase();
		await seedAgentRow(AGENT_ID, {
			organizationId: ORG_ID,
			ownerPlatform: "toolbox",
			ownerUserId: CREATED_BY_USER,
		});
	}, 30_000);

	test("builds wake_agent rows for Taipei midnight after each sales-talk weekday", () => {
		const jobs = buildSalesBattleReportScheduledJobs(requestBody());

		expect(jobs.map((job) => job.cron)).toEqual(["0 16 * * 0", "0 16 * * 2"]);
		expect(jobs).toHaveLength(2);
		expect(jobs[0]).toMatchObject({
			organizationId: ORG_ID,
			actionType: "wake_agent",
			createdByUser: CREATED_BY_USER,
		});
		expect(jobs[0].description).toContain("技術分析全攻略");
		expect(jobs[0].actionArgs).toMatchObject({
			agent_id: AGENT_ID,
			reason: "sales-battle-report-schedule",
			toolboxScheduleId: "sales_battle_report_schedule_abc123",
			trialSessionAgentId: "trial-session-agent-1",
			salesTalkWeekday: 0,
		});
		const prompt = String(jobs[0].actionArgs.prompt);
		expect(prompt).toContain("sales_battle_report_run_now");
		expect(prompt).toContain("scheduleId: sales_battle_report_schedule_abc123");
		expect(prompt).toContain("salesTalkDate");
		expect(prompt).toContain(
			"Asia/Taipei calendar date one day before the current scheduled run time / current date at execution",
		);
		expect(prompt).toContain("trialSessionAgentId: trial-session-agent-1");
		expect(prompt).toContain("do not send LINE directly");
		expect(prompt).not.toContain("toolboxScheduleId:");
		expect(prompt).not.toContain("salesTalkWeekday:");
	});

	test("requires an organization PAT with mcp:admin scope", async () => {
		const app = buildApp(["mcp:write"]);

		const res = await app.request("/api/provisioning/sales-battle-report-schedules", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(requestBody()),
		});

		expect(res.status).toBe(403);
	});

	test("creates one wake_agent scheduled_jobs row per weekday and returns refs", async () => {
		const app = buildApp();

		const res = await app.request("/api/provisioning/sales-battle-report-schedules", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(requestBody()),
		});

		expect(res.status).toBe(201);
		const body = (await res.json()) as { ok: boolean; scheduleRefs: string[] };
		expect(body.ok).toBe(true);
		expect(body.scheduleRefs).toHaveLength(2);

		const sql = getDb();
		const rows = await sql<{
			id: string;
			action_type: string;
			action_args: Record<string, unknown>;
			cron: string;
			created_by_user: string;
		}>`
			SELECT id, action_type, action_args, cron, created_by_user
			FROM scheduled_jobs
			WHERE organization_id = ${ORG_ID}
			ORDER BY cron ASC
		`;

		expect(rows).toHaveLength(2);
		expect(rows.map((row) => row.id)).toEqual(body.scheduleRefs);
		expect(rows.map((row) => row.cron)).toEqual(["0 16 * * 0", "0 16 * * 2"]);
		expect(rows[0]).toMatchObject({
			action_type: "wake_agent",
			created_by_user: CREATED_BY_USER,
		});
		expect(rows[0].action_args).toMatchObject({
			agent_id: AGENT_ID,
			toolboxScheduleId: "sales_battle_report_schedule_abc123",
			trialSessionAgentId: "trial-session-agent-1",
			salesTalkWeekday: 0,
		});
	});

	test("reuses existing weekday jobs for the same Toolbox schedule", async () => {
		const app = buildApp();
		const init = {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(requestBody()),
		};

		const first = await app.request(
			"/api/provisioning/sales-battle-report-schedules",
			init,
		);
		const second = await app.request(
			"/api/provisioning/sales-battle-report-schedules",
			init,
		);

		expect(first.status).toBe(201);
		expect(second.status).toBe(200);
		const firstBody = (await first.json()) as { scheduleRefs: string[] };
		const secondBody = (await second.json()) as { scheduleRefs: string[] };
		expect(secondBody.scheduleRefs).toEqual(firstBody.scheduleRefs);

		const sql = getDb();
		const [{ count }] = await sql<{ count: string }>`
			SELECT count(*)::text AS count
			FROM scheduled_jobs
			WHERE organization_id = ${ORG_ID}
		`;
		expect(count).toBe("2");
	});
});
