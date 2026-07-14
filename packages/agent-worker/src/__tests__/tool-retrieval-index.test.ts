import { describe, expect, test } from "bun:test";
import type { McpToolDef } from "@lobu/core";
import { catalogEntryForTool } from "../openclaw/tool-catalog";
import {
	buildToolDescriptor,
	inventoryFingerprint,
} from "../openclaw/tool-descriptor";
import {
	buildToolRetrievalIndex,
	searchToolRetrievalIndex,
} from "../openclaw/tool-retrieval-index";
import { routeToolEntries } from "../openclaw/tool-router";
import { tokenizeToolText } from "../openclaw/tool-tokenizer";

function tool(
	name: string,
	description: string,
	properties: Record<string, unknown> = {},
): McpToolDef {
	return {
		name,
		description,
		inputSchema: { type: "object", properties },
	};
}

describe("tool tokenizer", () => {
	test("tokenizes camel case English and overlapping CJK terms", () => {
		const tokens = tokenizeToolText("manageSchedules 提醒我吃午餐");

		expect(tokens).toContain("manage");
		expect(tokens).toContain("schedules");
		expect(tokens).toContain("提醒");
		expect(tokens).toContain("醒我");
	});
});

describe("tool descriptors", () => {
	test("bounds searchable text and applies the exact reminder override", () => {
		const descriptor = buildToolDescriptor(
			tool("manage_schedules", "x".repeat(40_000), {
				delay_minutes: {
					type: "number",
					description: "Delay before sending the reminder",
				},
			}),
			"lobu-memory",
			4,
		);

		expect(descriptor.key).toBe("lobu-memory/manage_schedules");
		expect(descriptor.indexedTextBytes).toBeLessThanOrEqual(16 * 1024);
		expect(descriptor.parameterNames).toContain("delay_minutes");
		expect(descriptor.destinations).toContain("personal_reminder");
		expect(descriptor.mutatesState).toBe(true);
	});

	test("bounds oversized optional searchable metadata", () => {
		const titledTool = Object.assign(tool("search_students", "Find students"), {
			title: "課".repeat(20_000),
		});

		const descriptor = buildToolDescriptor(titledTool, "school", 0);

		expect(descriptor.indexedTextBytes).toBeLessThanOrEqual(16 * 1024);
	});

	test("fingerprints clones deterministically and searchable changes distinctly", () => {
		const original = buildToolDescriptor(
			tool("search_students", "Find enrolled students"),
			"school",
			1,
		);
		const clone = buildToolDescriptor(
			structuredClone(original.tool),
			"school",
			1,
		);
		const changed = buildToolDescriptor(
			tool("search_students", "Find active enrolled students"),
			"school",
			1,
		);

		expect(inventoryFingerprint([original])).toBe(
			inventoryFingerprint([clone]),
		);
		expect(inventoryFingerprint([original])).not.toBe(
			inventoryFingerprint([changed]),
		);
	});

	test("fingerprints original order because it is the final compatibility tie-break", () => {
		const first = buildToolDescriptor(tool("alpha", "same"), "mcp", 0);
		const second = buildToolDescriptor(tool("beta", "same"), "mcp", 1);
		const reorderedFirst = buildToolDescriptor(tool("alpha", "same"), "mcp", 1);
		const reorderedSecond = buildToolDescriptor(tool("beta", "same"), "mcp", 0);

		expect(inventoryFingerprint([first, second])).not.toBe(
			inventoryFingerprint([reorderedFirst, reorderedSecond]),
		);
	});
});

describe("tool retrieval index", () => {
	test("ranks personal reminders and Google Calendar requests by semantics", () => {
		const reminder = buildToolDescriptor(
			tool("manage_schedules", "Manage agent schedules"),
			"lobu-memory",
			0,
		);
		const calendar = buildToolDescriptor(
			tool("gws_calendar_events_create", "Create a calendar event"),
			"google_workspace",
			1,
		);
		const index = buildToolRetrievalIndex([reminder, calendar]);

		expect(
			searchToolRetrievalIndex(index, "五分鐘後提醒我", 2)[0]?.descriptor.key,
		).toBe("lobu-memory/manage_schedules");
		expect(
			searchToolRetrievalIndex(index, "放進 Google Calendar", 2)[0]?.descriptor
				.key,
		).toBe("google_workspace/gws_calendar_events_create");
	});

	test("retrieves an unknown tool from its parameter description", () => {
		const distractor = buildToolDescriptor(
			tool("list_courses", "List available courses"),
			"school",
			0,
		);
		const studentSearch = buildToolDescriptor(
			tool("search_students", "Search students", {
				email: { type: "string", description: "學員電子郵件" },
			}),
			"school",
			1,
		);
		const index = buildToolRetrievalIndex([distractor, studentSearch]);

		expect(
			searchToolRetrievalIndex(index, "用 email 查學員", 2)[0]?.descriptor.key,
		).toBe("school/search_students");
	});
});

describe("tool router retrieval integration", () => {
	test("routes generic parameter semantics through the public contract", () => {
		const entries = [
			catalogEntryForTool(tool("list_courses", "List courses"), 0, "school"),
			catalogEntryForTool(
				tool("search_students", "Search students", {
					email: { type: "string", description: "學員電子郵件" },
				}),
				1,
				"school",
			),
		];

		const route = routeToolEntries({
			entries,
			message: "用 email 查學員",
			budget: 1,
			reservedEntries: [],
		});

		expect(route.selectedEntries[0]?.name).toBe("search_students");
		expect(route.fallback).toBeNull();
	});
});
