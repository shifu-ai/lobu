import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("durable bounded MCP inventory migration", () => {
	it("stores names and fingerprint without schemas or credentials", () => {
		const sql = readFileSync(
			path.resolve(
				__dirname,
				"../../../../../db/migrations/20260715020000_agent_mcp_tool_inventory_snapshots.sql",
			),
			"utf8",
		);
		expect(sql).toContain(
			"CREATE TABLE public.agent_mcp_tool_inventory_snapshots",
		);
		expect(sql).toContain("tool_names jsonb NOT NULL");
		expect(sql).toContain("inventory_fingerprint text NOT NULL");
		expect(sql).not.toMatch(/input_schema|credential|token|secret/);
	});
});
