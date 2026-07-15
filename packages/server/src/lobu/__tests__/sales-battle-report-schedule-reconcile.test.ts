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

function reconcileRequest(
	scheduleRevision: number,
	overrides: Record<string, unknown> = {},
) {
	return buildApp().request(
		"/api/provisioning/sales-battle-report-schedules/sales_battle_report_schedule_001",
		{
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				organizationId: ORGANIZATION_ID,
				createdByUser: "toolbox-user-1",
				agentId: "shifu-u-reconcile",
				scheduleRevision,
				courseName: "技術分析全攻略",
				salesTalkWeekdays: [0],
				desiredState: "active",
				...overrides,
			}),
		},
	);
}

async function observerRows() {
	return getDb()<
		Array<{
			id: string;
			external_key: string | null;
			schedule_revision: number;
			action_args: Record<string, unknown>;
			paused: boolean;
		}>
	>`
		SELECT id, external_key, schedule_revision, action_args, paused
		FROM scheduled_jobs
		WHERE organization_id = ${ORGANIZATION_ID}
		  AND action_type = 'sales_battle_report_observer'
		  AND action_args->>'toolboxScheduleId' = 'sales_battle_report_schedule_001'
		ORDER BY action_args->>'salesTalkWeekday', created_at, id
	`;
}

async function insertLegacyObserver(input: {
	weekday: number;
	revision: number;
	paused?: boolean;
	externalKey?: string | null;
}) {
	const rows = await getDb()<Array<{ id: string }>>`
		INSERT INTO scheduled_jobs (
			external_key, schedule_revision, organization_id, action_type,
			action_args, cron, next_run_at, paused, description, created_by_user
		) VALUES (
			${input.externalKey ?? null}, ${input.revision}, ${ORGANIZATION_ID},
			'sales_battle_report_observer',
			${getDb().json({
				toolboxScheduleId: "sales_battle_report_schedule_001",
				scheduleRevision: input.revision,
				salesTalkWeekday: input.weekday,
				courseName: "舊課程",
				agentId: "shifu-u-reconcile",
			})},
			'5 5 * * *', now(), ${input.paused ?? false}, 'legacy observer',
			'toolbox-user-1'
		)
		RETURNING id
	`;
	return rows[0].id;
}

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

	test("rejects a stale revision without changing observer jobs", async () => {
		const accepted = await reconcileRequest(5);
		expect(accepted.status).toBe(200);

		const stale = await reconcileRequest(4, { courseName: "不應套用" });

		expect(stale.status).toBe(409);
		expect(await stale.json()).toEqual({
			error: "stale_revision",
			acceptedRevision: 5,
		});
		const rows = await getDb()<
			Array<{ action_args: Record<string, unknown>; paused: boolean }>
		>`
			SELECT action_args, paused
			FROM scheduled_jobs
			WHERE organization_id = ${ORGANIZATION_ID}
			  AND action_args->>'toolboxScheduleId' = 'sales_battle_report_schedule_001'
		`;
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			paused: false,
			action_args: { scheduleRevision: 5, courseName: "技術分析全攻略" },
		});
	});

	test("returns an equal revision idempotently without mutating observers", async () => {
		const first = await reconcileRequest(5);
		const firstBody = (await first.json()) as { observerRefs: string[] };
		const before = await getDb()<Array<{ id: string; updated_at: string }>>`
			SELECT id, updated_at FROM scheduled_jobs
			WHERE organization_id = ${ORGANIZATION_ID}
			  AND action_args->>'toolboxScheduleId' = 'sales_battle_report_schedule_001'
		`;

		const equal = await reconcileRequest(5, { courseName: "不得覆寫" });

		expect(equal.status).toBe(200);
		expect(await equal.json()).toEqual({
			ok: true,
			acceptedRevision: 5,
			reconciled: {
				created: [],
				updated: [],
				paused: [],
				deletedDuplicates: [],
			},
			observerRefs: firstBody.observerRefs,
		});
		const after = await getDb()<
			Array<{
				id: string;
				updated_at: string;
				action_args: Record<string, unknown>;
			}>
		>`
			SELECT id, updated_at, action_args FROM scheduled_jobs
			WHERE organization_id = ${ORGANIZATION_ID}
			  AND action_args->>'toolboxScheduleId' = 'sales_battle_report_schedule_001'
		`;
		expect(after).toHaveLength(1);
		expect(after[0]).toMatchObject({
			id: before[0].id,
			updated_at: before[0].updated_at,
			action_args: { courseName: "技術分析全攻略" },
		});
	});

	test("repairs missing, extra, and duplicate weekdays deterministically", async () => {
		await reconcileRequest(1, { salesTalkWeekdays: [0, 3] });
		const initial = await observerRows();
		const weekday3 = initial.find(
			(row) => row.action_args.salesTalkWeekday === 3,
		);
		expect(weekday3).toBeDefined();
		await getDb()`UPDATE scheduled_jobs SET paused = true WHERE id = ${weekday3?.id}`;
		const preferredSurvivor = await insertLegacyObserver({
			weekday: 3,
			revision: 9,
		});

		const response = await reconcileRequest(2, { salesTalkWeekdays: [3, 4] });
		const body = (await response.json()) as {
			reconciled: {
				created: string[];
				paused: string[];
				deletedDuplicates: string[];
			};
			observerRefs: string[];
		};

		expect(response.status).toBe(200);
		expect(body.reconciled.created).toHaveLength(1);
		expect(body.reconciled.paused).toHaveLength(1);
		expect(body.reconciled.deletedDuplicates).toEqual([weekday3?.id]);
		expect(body.observerRefs).toContain(preferredSurvivor);
		const rows = await observerRows();
		expect(rows).toHaveLength(3);
		expect(
			rows.map((row) => [row.action_args.salesTalkWeekday, row.paused]),
		).toEqual([
			[0, true],
			[3, false],
			[4, false],
		]);
		const repaired = rows.find((row) => row.id === preferredSurvivor);
		expect(repaired).toMatchObject({
			external_key:
				"toolbox:sales-battle-report:sales_battle_report_schedule_001:weekday:3:observer",
			schedule_revision: 2,
			action_args: { scheduleRevision: 2, courseName: "技術分析全攻略" },
		});
	});

	test("pauses every matching observer for a paused desired state", async () => {
		await reconcileRequest(1, { salesTalkWeekdays: [0, 3] });
		await insertLegacyObserver({ weekday: 3, revision: 1 });

		const response = await reconcileRequest(2, { desiredState: "paused" });

		expect(response.status).toBe(200);
		expect((await observerRows()).every((row) => row.paused)).toBe(true);
	});

	test("disables weekday zero when desired weekdays change from zero and three to three", async () => {
		await reconcileRequest(1, { salesTalkWeekdays: [0, 3] });

		const response = await reconcileRequest(2, { salesTalkWeekdays: [3] });

		expect(response.status).toBe(200);
		const rows = await observerRows();
		expect(
			rows.map((row) => [row.action_args.salesTalkWeekday, row.paused]),
		).toEqual([
			[0, true],
			[3, false],
		]);
	});

	test("keeps a deleted schedule tombstoned against stale active revisions", async () => {
		await reconcileRequest(6, { salesTalkWeekdays: [0, 3] });
		const deleted = await reconcileRequest(7, { desiredState: "deleted" });
		expect(deleted.status).toBe(200);
		expect((await observerRows()).every((row) => row.paused)).toBe(true);

		const stale = await reconcileRequest(6, {
			desiredState: "active",
			salesTalkWeekdays: [0, 3],
		});

		expect(stale.status).toBe(409);
		expect(await stale.json()).toEqual({
			error: "stale_revision",
			acceptedRevision: 7,
		});
		expect((await observerRows()).every((row) => row.paused)).toBe(true);
		const sync = await getDb()<
			Array<{ last_accepted_revision: number; desired_state: string }>
		>`
			SELECT last_accepted_revision, desired_state
			FROM toolbox_sales_battle_report_schedule_sync
			WHERE organization_id = ${ORGANIZATION_ID}
			  AND toolbox_schedule_id = 'sales_battle_report_schedule_001'
		`;
		expect(sync).toEqual([
			{ last_accepted_revision: 7, desired_state: "deleted" },
		]);
	});

	test("serializes concurrent reconciliation to one observer per weekday", async () => {
		const responses = await Promise.all(
			Array.from({ length: 6 }, () =>
				reconcileRequest(10, { salesTalkWeekdays: [0, 3] }),
			),
		);

		expect(responses.every((response) => response.status === 200)).toBe(true);
		const rows = await observerRows();
		expect(rows.filter((row) => !row.paused)).toHaveLength(2);
		expect(rows.map((row) => row.action_args.salesTalkWeekday).sort()).toEqual([
			0, 3,
		]);
	});
});
