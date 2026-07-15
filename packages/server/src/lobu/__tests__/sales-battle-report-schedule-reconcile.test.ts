import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { getDb } from "../../db/client.js";
import {
	ensureDbForGatewayTests,
	resetTestDatabase,
	seedAgentRow,
} from "../../gateway/__tests__/helpers/db-setup.js";
import { createProvisioningRoutes } from "../provisioning-routes.js";
import { orgContext } from "../stores/org-context.js";

const ORGANIZATION_ID = "org-reconcile";

function buildApp() {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { id: "toolbox-user-1" });
		c.set("session", { id: "pat:test-sales-battle-report-reconcile" });
		c.set("organizationId", ORGANIZATION_ID);
		c.set("authSource", "pat");
		c.set("mcpAuthInfo", { scopes: ["mcp:admin"] });
		return orgContext.run({ organizationId: ORGANIZATION_ID }, next);
	});
	app.route("/api/provisioning", createProvisioningRoutes());
	return app;
}

describe("sales battle report schedule reconciliation", () => {
	beforeAll(async () => {
		await ensureDbForGatewayTests();
	}, 60_000);

	beforeEach(async () => {
		await resetTestDatabase();
		await seedAgentRow("shifu-u-reconcile", {
			organizationId: ORGANIZATION_ID,
			ownerPlatform: "toolbox",
			ownerUserId: "toolbox-user-1",
		});
	}, 30_000);

	test("creates one observer-only job for desired revision 1", async () => {
		const response = await buildApp().request(
			"/api/provisioning/sales-battle-report-schedules/sales_battle_report_schedule_001",
			{
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					organizationId: ORGANIZATION_ID,
					createdByUser: "toolbox-user-1",
					agentId: "shifu-u-reconcile",
					toolboxScheduleId: "ignored-body-id",
					scheduleRevision: 1,
					courseName: "技術分析全攻略",
					salesTalkWeekdays: [0],
					desiredState: "active",
				}),
			},
		);

		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			ok: boolean;
			acceptedRevision: number;
			reconciled: {
				created: string[];
				updated: string[];
				paused: string[];
				deletedDuplicates: string[];
			};
			observerRefs: string[];
		};
		expect(body).toMatchObject({
			ok: true,
			acceptedRevision: 1,
			reconciled: {
				created: expect.any(Array),
				updated: [],
				paused: [],
				deletedDuplicates: [],
			},
		});
		expect(body.observerRefs).toHaveLength(1);

		const rows = await getDb()<
			Array<{
				id: string;
				external_key: string;
				action_type: string;
				action_args: Record<string, unknown>;
				cron: string;
				paused: boolean;
			}>
		>`
			SELECT id, external_key, action_type, action_args, cron, paused
			FROM scheduled_jobs
			WHERE organization_id = ${ORGANIZATION_ID}
			  AND action_args->>'toolboxScheduleId' = 'sales_battle_report_schedule_001'
		`;
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			external_key:
				"toolbox:sales-battle-report:sales_battle_report_schedule_001:weekday:0:observer",
			action_type: "sales_battle_report_observer",
			cron: "0 16 * * *",
			paused: false,
			action_args: {
				toolboxScheduleId: "sales_battle_report_schedule_001",
				scheduleRevision: 1,
				salesTalkWeekday: 0,
				courseName: "技術分析全攻略",
				agentId: "shifu-u-reconcile",
			},
		});
		expect(body.observerRefs).toEqual([rows[0].id]);
	});

	test("returns validation error for a JSON null body", async () => {
		const response = await buildApp().request(
			"/api/provisioning/sales-battle-report-schedules/sales_battle_report_schedule_001",
			{
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: "null",
			},
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: "invalid_sales_battle_report_schedule",
		});
	});
});
