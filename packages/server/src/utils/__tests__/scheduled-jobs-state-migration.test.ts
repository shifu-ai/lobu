import fs from "node:fs";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { getDb } from "../../db/client.js";
import {
	ensureDbForGatewayTests,
	resetTestDatabase,
	seedAgentRow,
} from "../../gateway/__tests__/helpers/db-setup.js";
import { createScheduledJob } from "../../scheduled/scheduled-jobs-service.js";

const MIGRATION = path.resolve(
	__dirname,
	"../../../../../db/migrations/20260714020000_scheduled_jobs_state.sql",
);
const ORGANIZATION_ID = "org-state-migration-down";
const USER_ID = "user-state-migration-down";
const AGENT_ID = "shifu-u-state-migration-down";

function downSql(): string {
	return fs.readFileSync(MIGRATION, "utf8").split("-- migrate:down")[1]?.trim() ?? "";
}

function upSql(): string {
	return (
		fs.readFileSync(MIGRATION, "utf8").split("-- migrate:down")[0]?.replace("-- migrate:up", "").trim() ??
		""
	);
}

describe("scheduled jobs state migration", () => {
	beforeAll(async () => {
		await ensureDbForGatewayTests();
	}, 60_000);

	beforeEach(async () => {
		await resetTestDatabase();
		await seedAgentRow(AGENT_ID, {
			organizationId: ORGANIZATION_ID,
			ownerPlatform: "toolbox",
			ownerUserId: USER_ID,
		});
	}, 30_000);

	test("preserves existing rows as active and limits the due index to active work", () => {
		const sql = fs.readFileSync(MIGRATION, "utf8");
		expect(sql).toContain("-- migrate:up");
		expect(sql).toContain("-- migrate:down");
		expect(sql).toContain("state text NOT NULL DEFAULT 'active'");
		expect(sql).toContain("CHECK (state IN ('staged', 'active'))");
		expect(sql).toContain("WHERE state = 'active' AND NOT paused");
	});

	test("down migration locks writers before checking for staged rows", () => {
		const sql = downSql();
		const lockPosition = sql.indexOf(
			"LOCK TABLE public.scheduled_jobs IN SHARE ROW EXCLUSIVE MODE",
		);
		const stagedCheckPosition = sql.indexOf("WHERE state = 'staged'");
		const dropIndexPosition = sql.indexOf(
			"DROP INDEX IF EXISTS public.idx_scheduled_jobs_due",
		);

		expect(lockPosition).toBeGreaterThanOrEqual(0);
		expect(lockPosition).toBeLessThan(stagedCheckPosition);
		expect(stagedCheckPosition).toBeLessThan(dropIndexPosition);
	});

	test("down migration aborts before changing schema when staged rows exist", async () => {
		const job = await createScheduledJob({
			organizationId: ORGANIZATION_ID,
			actionType: "wake_agent",
			actionArgs: { agent_id: AGENT_ID, prompt: "stay inert" },
			description: "stay inert",
			runAt: new Date("2030-07-15T09:00:00.000Z"),
			createdByUser: USER_ID,
			createdByAgent: AGENT_ID,
		});
		await getDb()`UPDATE scheduled_jobs SET state = 'staged' WHERE id = ${job.id}`;

		await expect(
			getDb().begin(async (tx) => {
				await tx.unsafe(downSql());
			}),
		).rejects.toThrow(/staged schedules exist/i);

		const [column] = await getDb()<Array<{ exists: boolean }>>`
			SELECT EXISTS (
				SELECT 1 FROM information_schema.columns
				WHERE table_schema = 'public' AND table_name = 'scheduled_jobs' AND column_name = 'state'
			) AS exists
		`;
		expect(column?.exists).toBe(true);
		expect((await getDb()<Array<{ state: string }>>`
			SELECT state FROM scheduled_jobs WHERE id = ${job.id}
		`)[0]?.state).toBe("staged");
	});

	test("down migration is safe when no staged rows exist", async () => {
		await getDb().begin(async (tx) => {
			await tx.unsafe(downSql());
			const [column] = await tx<Array<{ exists: boolean }>>`
					SELECT EXISTS (
						SELECT 1 FROM information_schema.columns
						WHERE table_schema = 'public' AND table_name = 'scheduled_jobs' AND column_name = 'state'
					) AS exists
				`;
			expect(column?.exists).toBe(false);
			const [index] = await tx<Array<{ predicate: string | null }>>`
					SELECT pg_get_expr(indexprs.indpred, indexprs.indrelid) AS predicate
					FROM pg_index indexprs
					JOIN pg_class indexes ON indexes.oid = indexprs.indexrelid
					WHERE indexes.relname = 'idx_scheduled_jobs_due'
				`;
			expect(index?.predicate).toMatch(/NOT paused/i);
			expect(index?.predicate).not.toMatch(/state/i);
			await tx.unsafe(upSql());
		});

		const [restored] = await getDb()<Array<{ exists: boolean }>>`
			SELECT EXISTS (
				SELECT 1 FROM information_schema.columns
				WHERE table_schema = 'public' AND table_name = 'scheduled_jobs' AND column_name = 'state'
			) AS exists
		`;
		expect(restored?.exists).toBe(true);
	});
});
