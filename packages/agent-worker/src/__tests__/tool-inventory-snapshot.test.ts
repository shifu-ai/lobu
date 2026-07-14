import { describe, expect, test } from "bun:test";
import type { McpToolDef } from "@lobu/core";
import { initializeExternalTurnToolRouting } from "../openclaw/session-runner";
import {
	clearToolInventorySnapshotCacheForTests,
	snapshotToolsByMcp,
	toolInventorySnapshotCacheStats,
} from "../openclaw/tool-inventory-snapshot";
import { clearToolRetrievalIndexCacheForTests } from "../openclaw/tool-retrieval-index";

function tool(name: string, description: string): McpToolDef {
	return {
		name,
		description,
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string", description: "Original query" },
			},
		},
	};
}

describe("external-turn immutable tool inventory snapshots", () => {
	test("preserves caller identity for an already deeply immutable inventory", () => {
		clearToolInventorySnapshotCacheForTests();
		const immutableTool = Object.freeze({
			...tool("search_students", "Find students"),
			inputSchema: Object.freeze({
				type: "object",
				properties: Object.freeze({
					query: Object.freeze({
						type: "string",
						description: "Original query",
					}),
				}),
			}),
		});
		const source = Object.freeze({
			school: Object.freeze([immutableTool]) as unknown as McpToolDef[],
		});

		expect(snapshotToolsByMcp(source)).toBe(source);
		expect(toolInventorySnapshotCacheStats().immutableReuses).toBe(1);
	});

	test("reuses the same snapshot across equal logical inventories", () => {
		clearToolInventorySnapshotCacheForTests();
		const source = { school: [tool("search_students", "Find students")] };
		const first = snapshotToolsByMcp(source);
		const second = snapshotToolsByMcp({
			school: [structuredClone(source.school[0])],
		});

		expect(second).toBe(first);
		expect(toolInventorySnapshotCacheStats()).toMatchObject({
			entries: 1,
			hits: 1,
		});
		expect(Object.isFrozen(first)).toBe(true);
		expect(Object.isFrozen(first.school)).toBe(true);
		expect(Object.isFrozen(first.school[0]?.inputSchema)).toBe(true);
	});

	test("reuses production initialization caches while applying authorization per turn", () => {
		clearToolInventorySnapshotCacheForTests();
		clearToolRetrievalIndexCacheForTests();
		const source = {
			school: [tool("search_students", "Find records by email")],
			drive: [tool("search_files", "Find records by email")],
		};
		const initialize = (
			toolsByMcp: Record<string, McpToolDef[]>,
			allowedToolNames: string[],
		) =>
			initializeExternalTurnToolRouting(
				{
					toolsByMcp,
					message: "用 email 查資料",
					budget: 2,
					allowedToolNames,
					routerMode: "semantic",
					trace: {
						traceId: "tr_inventory_cache_test",
						journeyId: "line_text_agent_turn",
						actor: "worker",
						traceSource: "incoming",
					},
				},
				{ emitEvent: () => undefined },
			);

		const first = initialize(source, ["school/search_students"]);
		const equalFreshInventory = structuredClone(source);
		const second = initialize(equalFreshInventory, ["drive/search_files"]);
		(
			equalFreshInventory.drive[0]?.inputSchema?.properties as Record<
				string,
				{ description: string }
			>
		).query.description = "Changed schema description";
		const changed = initialize(equalFreshInventory, ["drive/search_files"]);

		expect(first.selection.trace.cacheHit).toBe(false);
		expect(second.selection.trace.cacheHit).toBe(true);
		expect(second.selection.trace.selectedToolNames).toEqual([
			"drive/search_files",
		]);
		expect(
			second.selection.trace.candidates.map(({ key }) => key),
		).not.toContain("school/search_students");
		expect(changed.selection.trace.cacheHit).toBe(false);
		expect(changed.selection.trace.inventoryFingerprint).not.toBe(
			second.selection.trace.inventoryFingerprint,
		);
		expect(first.selection.selectedTools.school[0]?.description).toBe(
			"Find records by email",
		);
		expect(toolInventorySnapshotCacheStats().hits).toBeGreaterThan(0);
	});

	test("invalidates name, schema, MCP order, and tool order changes", () => {
		clearToolInventorySnapshotCacheForTests();
		const alpha = tool("alpha_search", "Find alpha");
		const beta = tool("beta_search", "Find beta");
		const source = { first: [alpha, beta], second: [] as McpToolDef[] };
		const initial = snapshotToolsByMcp(source);

		alpha.name = "alpha_search_changed";
		const renamed = snapshotToolsByMcp(source);
		(
			alpha.inputSchema?.properties as Record<string, { description: string }>
		).query.description = "Changed query";
		const schemaChanged = snapshotToolsByMcp(source);
		const toolReordered = snapshotToolsByMcp({
			first: [beta, alpha],
			second: [],
		});
		const mcpReordered = snapshotToolsByMcp({
			second: [],
			first: [beta, alpha],
		});

		expect(renamed).not.toBe(initial);
		expect(schemaChanged).not.toBe(renamed);
		expect(toolReordered).not.toBe(schemaChanged);
		expect(mcpReordered).not.toBe(toolReordered);
		expect(initial.first[0]?.name).toBe("alpha_search");
		expect(
			(
				initial.first[0]?.inputSchema?.properties as Record<
					string,
					{ description: string }
				>
			).query.description,
		).toBe("Original query");
	});

	test("bounds immutable inventory snapshots to the worker cache budget", () => {
		clearToolInventorySnapshotCacheForTests();
		for (let version = 0; version < 12; version++) {
			snapshotToolsByMcp({
				synthetic: Array.from({ length: 100 }, (_, index) =>
					tool(
						`tool_${version}_${index}`,
						`${version}-${index}-${"x".repeat(10_000)}`,
					),
				),
			});
		}
		const stats = toolInventorySnapshotCacheStats();

		expect(stats.estimatedBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
		expect(stats.evictions).toBeGreaterThan(0);
		expect(stats.entries).toBeLessThan(12);
	});
});
