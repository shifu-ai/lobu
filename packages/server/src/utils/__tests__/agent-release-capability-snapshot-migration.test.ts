import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("durable capability snapshot receipt migration", () => {
	it("stores only bounded identity and digest facts", () => {
		const sql = readFileSync(
			path.resolve(
				__dirname,
				"../../../../../db/migrations/20260715030000_agent_release_capability_snapshots.sql",
			),
			"utf8",
		);
		expect(sql).toContain(
			"CREATE TABLE public.agent_release_capability_snapshots",
		);
		expect(sql).toContain("snapshot_digest text NOT NULL");
		expect(sql).toContain("capability_ids jsonb NOT NULL");
		expect(sql).not.toMatch(/prompt|settings|credential|token|secret/);
	});
});
