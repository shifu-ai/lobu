import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const MIGRATION = path.resolve(
	__dirname,
	"../../../../../db/migrations/20260714020000_scheduled_jobs_state.sql",
);

describe("scheduled jobs state migration", () => {
	test("preserves existing rows as active and limits the due index to active work", () => {
		const sql = fs.readFileSync(MIGRATION, "utf8");
		expect(sql).toContain("-- migrate:up");
		expect(sql).toContain("-- migrate:down");
		expect(sql).toContain("state text NOT NULL DEFAULT 'active'");
		expect(sql).toContain("CHECK (state IN ('staged', 'active'))");
		expect(sql).toContain("WHERE state = 'active' AND NOT paused");
	});
});
