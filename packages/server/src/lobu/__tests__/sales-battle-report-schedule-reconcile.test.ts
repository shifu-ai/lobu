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
	createdByUser?: string;
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
			${input.createdByUser ?? "toolbox-user-1"}
		)
		RETURNING id
	`;
	return rows[0].id;
}

async function insertCanonicalKeyConflict(input: {
	actionType: string;
	toolboxScheduleId: string;
	weekday: number;
}) {
	const externalKey =
		"toolbox:sales-battle-report:sales_battle_report_schedule_001:weekday:0:observer";
	const rows = await getDb()<Array<{ id: string }>>`
		INSERT INTO scheduled_jobs (
			external_key, organization_id, action_type, action_args, cron,
			next_run_at, description, created_by_user
		) VALUES (
			${externalKey}, ${ORGANIZATION_ID}, ${input.actionType},
			${getDb().json({
				toolboxScheduleId: input.toolboxScheduleId,
				salesTalkWeekday: input.weekday,
			})},
			NULL, now(), 'unrelated canonical key holder', 'toolbox-user-2'
		)
		RETURNING id
	`;
	return { id: rows[0].id, externalKey };
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

	test("accepts the largest PostgreSQL integer schedule revision", async () => {
		const response = await reconcileRequest(2_147_483_647);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			ok: true,
			acceptedRevision: 2_147_483_647,
		});
	});

	test("rejects schedule revisions above the PostgreSQL integer maximum", async () => {
		const response = await reconcileRequest(2_147_483_648);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: "invalid_sales_battle_report_schedule",
		});
		expect(await observerRows()).toEqual([]);
	});

	test("rejects unsafe integer schedule revisions before database access", async () => {
		const response = await reconcileRequest(Number.MAX_SAFE_INTEGER + 1);

		expect(response.status).toBe(400);
		expect(await observerRows()).toEqual([]);
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

	test("rejects equal revisions whose canonical payload differs", async () => {
		const first = await reconcileRequest(5);
		expect(first.status).toBe(200);
		const before = await getDb()<
			Array<{ id: string; updated_at: string; action_args: unknown }>
		>`
			SELECT id, updated_at, action_args FROM scheduled_jobs
			WHERE organization_id = ${ORGANIZATION_ID}
			  AND action_args->>'toolboxScheduleId' = 'sales_battle_report_schedule_001'
		`;
		const mismatches = [
			{ createdByUser: "toolbox-user-2" },
			{ agentId: "shifu-u-other" },
			{ courseName: "不得覆寫" },
			{ salesTalkWeekdays: [0, 3] },
			{ desiredState: "paused" },
		];

		for (const mismatch of mismatches) {
			const equal = await reconcileRequest(5, mismatch);
			expect(equal.status).toBe(409);
			expect(await equal.json()).toEqual({
				error: "revision_payload_conflict",
				acceptedRevision: 5,
			});
		}
		const after = await getDb()<typeof before>`
			SELECT id, updated_at, action_args FROM scheduled_jobs
			WHERE organization_id = ${ORGANIZATION_ID}
			  AND action_args->>'toolboxScheduleId' = 'sales_battle_report_schedule_001'
		`;
		expect(after).toEqual(before);
	});

	test("returns an exact healthy equal revision as a no-op", async () => {
		const first = await reconcileRequest(5);
		const firstBody = (await first.json()) as { observerRefs: string[] };
		const before = await observerRows();
		const syncBefore = await getDb()<
			Array<{
				last_accepted_revision: number;
				accepted_request_fingerprint: string;
				updated_at: string;
			}>
		>`
			SELECT last_accepted_revision, accepted_request_fingerprint, updated_at
			FROM toolbox_sales_battle_report_schedule_sync
			WHERE organization_id = ${ORGANIZATION_ID}
			  AND toolbox_schedule_id = 'sales_battle_report_schedule_001'
		`;

		const equal = await reconcileRequest(5);

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
		expect(await observerRows()).toEqual(before);
		const syncAfter = await getDb()<typeof syncBefore>`
			SELECT last_accepted_revision, accepted_request_fingerprint, updated_at
			FROM toolbox_sales_battle_report_schedule_sync
			WHERE organization_id = ${ORGANIZATION_ID}
			  AND toolbox_schedule_id = 'sales_battle_report_schedule_001'
		`;
		expect(syncAfter).toEqual(syncBefore);
	});

	test("repairs a missing observer on an exact equal revision", async () => {
		await reconcileRequest(5, { salesTalkWeekdays: [0, 3] });
		const before = await observerRows();
		const missing = before.find(
			(row) => row.action_args.salesTalkWeekday === 3,
		);
		expect(missing).toBeDefined();
		await getDb()`DELETE FROM scheduled_jobs WHERE id = ${missing?.id}`;

		const equal = await reconcileRequest(5, { salesTalkWeekdays: [3, 0, 3] });
		const body = (await equal.json()) as {
			reconciled: { created: string[] };
		};

		expect(equal.status).toBe(200);
		expect(body.reconciled.created).toHaveLength(1);
		const repaired = await observerRows();
		expect(
			repaired.map((row) => row.action_args.salesTalkWeekday).sort(),
		).toEqual([0, 3]);
	});

	test("repairs duplicate extra paused and key drift on an exact equal revision", async () => {
		await reconcileRequest(5, { salesTalkWeekdays: [0, 3] });
		const initial = await observerRows();
		const weekday0 = initial.find(
			(row) => row.action_args.salesTalkWeekday === 0,
		);
		const weekday3 = initial.find(
			(row) => row.action_args.salesTalkWeekday === 3,
		);
		expect(weekday0).toBeDefined();
		expect(weekday3).toBeDefined();
		await getDb()`
			UPDATE scheduled_jobs SET paused = true, external_key = NULL
			WHERE id = ${weekday0?.id}
		`;
		const preferredWeekday3 = await insertLegacyObserver({
			weekday: 3,
			revision: 9,
		});
		const extra = await insertLegacyObserver({
			weekday: 5,
			revision: 5,
			externalKey:
				"toolbox:sales-battle-report:sales_battle_report_schedule_001:weekday:5:observer",
		});

		const equal = await reconcileRequest(5, { salesTalkWeekdays: [0, 3] });
		const body = (await equal.json()) as {
			reconciled: {
				updated: string[];
				paused: string[];
				deletedDuplicates: string[];
			};
		};

		expect(equal.status).toBe(200);
		expect(body.reconciled.deletedDuplicates).toEqual([weekday3?.id]);
		expect(body.reconciled.paused).toContain(extra);
		expect(body.reconciled.updated).toEqual(
			expect.arrayContaining([weekday0?.id, preferredWeekday3]),
		);
		const repaired = await observerRows();
		expect(
			repaired.map((row) => [row.action_args.salesTalkWeekday, row.paused]),
		).toEqual([
			[0, false],
			[3, false],
			[5, true],
		]);
	});

	test("serializes concurrent exact equal repairs to one observer per weekday", async () => {
		await reconcileRequest(5, { salesTalkWeekdays: [0, 3] });
		const missing = (await observerRows()).find(
			(row) => row.action_args.salesTalkWeekday === 3,
		);
		await getDb()`DELETE FROM scheduled_jobs WHERE id = ${missing?.id}`;

		const responses = await Promise.all(
			Array.from({ length: 6 }, () =>
				reconcileRequest(5, { salesTalkWeekdays: [0, 3] }),
			),
		);

		expect(responses.every((response) => response.status === 200)).toBe(true);
		const rows = await observerRows();
		expect(rows).toHaveLength(2);
		expect(rows.map((row) => row.action_args.salesTalkWeekday).sort()).toEqual([
			0, 3,
		]);
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

	test("repairs cross-owner duplicate observer keys to one requested-owner survivor", async () => {
		await reconcileRequest(1, { salesTalkWeekdays: [0] });
		const canonicalKey =
			"toolbox:sales-battle-report:sales_battle_report_schedule_001:weekday:0:observer";
		await insertLegacyObserver({
			weekday: 0,
			revision: 0,
			externalKey: canonicalKey,
			createdByUser: "toolbox-user-2",
		});

		const response = await reconcileRequest(3, {
			createdByUser: "toolbox-user-2",
			salesTalkWeekdays: [0],
		});

		expect(response.status).toBe(200);
		const rows = await observerRows();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			external_key: canonicalKey,
			paused: false,
		});
		const owners = await getDb()<Array<{ created_by_user: string }>>`
			SELECT created_by_user FROM scheduled_jobs WHERE id = ${rows[0].id}
		`;
		expect(owners).toEqual([{ created_by_user: "toolbox-user-2" }]);
	});

	test("repairs swapped weekday external keys without a unique violation", async () => {
		await reconcileRequest(1, { salesTalkWeekdays: [0, 3] });
		const rows = await observerRows();
		const weekday0 = rows.find((row) => row.action_args.salesTalkWeekday === 0);
		const weekday3 = rows.find((row) => row.action_args.salesTalkWeekday === 3);
		expect(weekday0).toBeDefined();
		expect(weekday3).toBeDefined();
		await getDb()`
			UPDATE scheduled_jobs SET external_key = NULL
			WHERE id IN (${weekday0?.id}, ${weekday3?.id})
		`;
		await getDb()`
			UPDATE scheduled_jobs
			SET external_key = CASE
				WHEN id = ${weekday0?.id} THEN ${weekday3?.external_key}
				ELSE ${weekday0?.external_key}
			END
			WHERE id IN (${weekday0?.id}, ${weekday3?.id})
		`;

		const response = await reconcileRequest(2, { salesTalkWeekdays: [0, 3] });

		expect(response.status).toBe(200);
		const repaired = await observerRows();
		expect(repaired).toHaveLength(2);
		for (const row of repaired) {
			expect(row.external_key).toBe(
				`toolbox:sales-battle-report:sales_battle_report_schedule_001:weekday:${row.action_args.salesTalkWeekday}:observer`,
			);
			expect(row.action_args.scheduleRevision).toBe(2);
		}
	});

	test("serializes concurrent requests from differing owners", async () => {
		const responses = await Promise.all([
			reconcileRequest(10, {
				createdByUser: "toolbox-user-1",
				salesTalkWeekdays: [0, 3],
			}),
			reconcileRequest(10, {
				createdByUser: "toolbox-user-2",
				salesTalkWeekdays: [0, 3],
			}),
		]);

		expect(responses.map((response) => response.status).sort()).toEqual([
			200, 409,
		]);
		const conflictResponse = responses.find(
			(response) => response.status === 409,
		);
		expect(await conflictResponse?.json()).toMatchObject({
			error: "revision_payload_conflict",
			acceptedRevision: 10,
		});
		const rows = await observerRows();
		expect(rows).toHaveLength(2);
		expect(rows.filter((row) => !row.paused)).toHaveLength(2);
		expect(rows.map((row) => row.action_args.salesTalkWeekday).sort()).toEqual([
			0, 3,
		]);
	});

	test("rejects an unrelated action holding a canonical observer key without mutation", async () => {
		await reconcileRequest(1, { salesTalkWeekdays: [0] });
		const conflict = await insertCanonicalKeyConflict({
			actionType: "wake_agent",
			toolboxScheduleId: "unrelated_schedule",
			weekday: 0,
		});
		const before = await getDb()<
			Array<{
				id: string;
				external_key: string;
				action_type: string;
				action_args: unknown;
			}>
		>`
			SELECT id, external_key, action_type, action_args
			FROM scheduled_jobs ORDER BY id
		`;

		const response = await reconcileRequest(2, { salesTalkWeekdays: [0] });

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			error: "observer_external_key_conflict",
			conflictingJobIds: [conflict.id],
		});
		const after = await getDb()<typeof before>`
			SELECT id, external_key, action_type, action_args
			FROM scheduled_jobs ORDER BY id
		`;
		expect(after).toEqual(before);
		const sync = await getDb()<Array<{ last_accepted_revision: number }>>`
			SELECT last_accepted_revision
			FROM toolbox_sales_battle_report_schedule_sync
			WHERE organization_id = ${ORGANIZATION_ID}
			  AND toolbox_schedule_id = 'sales_battle_report_schedule_001'
		`;
		expect(sync).toEqual([{ last_accepted_revision: 1 }]);
	});

	test("rejects a different observer schedule holding this schedule's canonical key", async () => {
		await reconcileRequest(1, { salesTalkWeekdays: [0] });
		const conflict = await insertCanonicalKeyConflict({
			actionType: "sales_battle_report_observer",
			toolboxScheduleId: "sales_battle_report_schedule_other",
			weekday: 0,
		});

		const response = await reconcileRequest(2, { salesTalkWeekdays: [0] });

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			error: "observer_external_key_conflict",
			conflictingJobIds: [conflict.id],
		});
		const holder = await getDb()<
			Array<{ external_key: string; action_args: Record<string, unknown> }>
		>`
			SELECT external_key, action_args FROM scheduled_jobs WHERE id = ${conflict.id}
		`;
		expect(holder).toEqual([
			{
				external_key: conflict.externalKey,
				action_args: {
					toolboxScheduleId: "sales_battle_report_schedule_other",
					salesTalkWeekday: 0,
				},
			},
		]);
	});

	test("uses the typed row revision when legacy action args revision is malformed", async () => {
		await reconcileRequest(1, { salesTalkWeekdays: [0] });
		const legacyId = await insertLegacyObserver({ weekday: 0, revision: 9 });
		await getDb()`
			UPDATE scheduled_jobs
			SET action_args = jsonb_set(action_args, '{scheduleRevision}', '"broken"'),
				created_at = '2100-01-01T00:00:00Z'
			WHERE id = ${legacyId}
		`;

		const response = await reconcileRequest(2, { salesTalkWeekdays: [0] });

		expect(response.status).toBe(200);
		const rows = await observerRows();
		expect(rows).toHaveLength(1);
		expect(rows[0].id).toBe(legacyId);
		expect(rows[0].action_args.scheduleRevision).toBe(2);
	});

	test("returns typed conflicts for canonical-key holders with non-object action args", async () => {
		await reconcileRequest(1, { salesTalkWeekdays: [0] });
		const malformedValues: Array<{
			label: string;
			value: unknown;
			actionType: string;
		}> = [
			{
				label: "json null",
				value: null,
				actionType: "sales_battle_report_observer",
			},
			{ label: "string", value: "primitive", actionType: "wake_agent" },
			{ label: "number", value: 42, actionType: "wake_agent" },
			{ label: "array", value: ["primitive"], actionType: "wake_agent" },
		];

		for (const malformed of malformedValues) {
			const conflict = await insertCanonicalKeyConflict({
				actionType: malformed.actionType,
				toolboxScheduleId: "will_be_replaced",
				weekday: 0,
			});
			await getDb()`
				UPDATE scheduled_jobs
				SET action_args = ${JSON.stringify(malformed.value)}::jsonb
				WHERE id = ${conflict.id}
			`;

			const response = await reconcileRequest(2, { salesTalkWeekdays: [0] });

			expect(response.status, malformed.label).toBe(409);
			expect(await response.json()).toEqual({
				error: "observer_external_key_conflict",
				conflictingJobIds: [conflict.id],
			});
			const holder = await getDb()<
				Array<{
					external_key: string;
					action_type: string;
					action_args: unknown;
				}>
			>`
				SELECT external_key, action_type, action_args
				FROM scheduled_jobs WHERE id = ${conflict.id}
			`;
			expect(holder).toEqual([
				{
					external_key: conflict.externalKey,
					action_type: malformed.actionType,
					action_args: malformed.value,
				},
			]);
			const sync = await getDb()<Array<{ last_accepted_revision: number }>>`
				SELECT last_accepted_revision
				FROM toolbox_sales_battle_report_schedule_sync
				WHERE organization_id = ${ORGANIZATION_ID}
				  AND toolbox_schedule_id = 'sales_battle_report_schedule_001'
			`;
			expect(sync).toEqual([{ last_accepted_revision: 1 }]);
			await getDb()`DELETE FROM scheduled_jobs WHERE id = ${conflict.id}`;
		}
	});

	test("falls back to typed revisions for null empty-string and false action revisions", async () => {
		await reconcileRequest(1, { salesTalkWeekdays: [0, 1, 2] });
		const nullRevision = await insertLegacyObserver({
			weekday: 0,
			revision: 9,
		});
		const emptyRevision = await insertLegacyObserver({
			weekday: 1,
			revision: 10,
		});
		const falseRevision = await insertLegacyObserver({
			weekday: 2,
			revision: 11,
		});
		await getDb()`
			UPDATE scheduled_jobs SET action_args = jsonb_set(action_args, '{scheduleRevision}', 'null')
			WHERE id = ${nullRevision}
		`;
		await getDb()`
			UPDATE scheduled_jobs SET action_args = jsonb_set(action_args, '{scheduleRevision}', '""')
			WHERE id = ${emptyRevision}
		`;
		await getDb()`
			UPDATE scheduled_jobs SET action_args = jsonb_set(action_args, '{scheduleRevision}', 'false')
			WHERE id = ${falseRevision}
		`;

		const response = await reconcileRequest(2, {
			salesTalkWeekdays: [0, 1, 2],
		});

		expect(response.status).toBe(200);
		const rows = await observerRows();
		expect(rows.map((row) => row.id).sort()).toEqual(
			[nullRevision, emptyRevision, falseRevision].sort(),
		);
		expect(rows.every((row) => row.action_args.scheduleRevision === 2)).toBe(
			true,
		);
	});
});
