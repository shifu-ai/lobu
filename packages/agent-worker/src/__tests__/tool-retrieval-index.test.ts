import { describe, expect, test } from "bun:test";
import type { McpToolDef } from "@lobu/core";
import { catalogEntryForTool } from "../openclaw/tool-catalog";
import {
	buildToolDescriptor,
	inventoryFingerprint,
	type ToolDescriptor,
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

	test("normalizes NFKC, strips controls, splits separators, and deduplicates", () => {
		expect(tokenizeToolText("Ｆｏｏ_bar-baz42\u0000 foo BAR baz42")).toEqual([
			"foo",
			"bar",
			"baz42",
		]);
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

	test("preserves a huge raw identity while bounding indexed identity text", () => {
		const hugeName = `search_${"x".repeat(20_000)}`;
		const descriptor = buildToolDescriptor(
			tool(hugeName, "Find records"),
			"large-mcp",
			0,
		);
		const searchable = descriptor as ToolDescriptor & {
			indexedKey?: string;
			indexedName?: string;
		};

		expect(descriptor.name).toBe(hugeName);
		expect(descriptor.key).toBe(`large-mcp/${hugeName}`);
		expect(searchable.indexedName).toBeDefined();
		expect(searchable.indexedKey).toBeDefined();
		expect(descriptor.indexedTextBytes).toBeLessThanOrEqual(16 * 1024);
	});

	test("does not apply exact overrides after sanitizing raw identity", () => {
		const descriptor = buildToolDescriptor(
			tool("manage_schedules", "Manage schedules"),
			" lobu-memory ",
			0,
		);

		expect(descriptor.destinations).toEqual([]);
		expect(descriptor.mutatesState).toBe(false);
	});

	test("reads metadata titles using dispatcher precedence", () => {
		const metaTitle = buildToolDescriptor(
			Object.assign(tool("meta_tool", "Meta tool"), {
				_meta: { title: "Metadata title" },
				annotations: { title: "Annotation title" },
			}),
			"mcp",
			0,
		);
		const annotationsTitle = buildToolDescriptor(
			Object.assign(tool("annotation_tool", "Annotation tool"), {
				annotations: { title: "Annotation fallback" },
			}),
			"mcp",
			1,
		);

		expect(metaTitle.title).toBe("Metadata title");
		expect(annotationsTitle.title).toBe("Annotation fallback");
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

	test("fingerprints descriptor array order with unchanged descriptor objects", () => {
		const first = buildToolDescriptor(tool("alpha", "same"), "mcp", 0);
		const second = buildToolDescriptor(tool("beta", "same"), "mcp", 1);

		expect(inventoryFingerprint([first, second])).not.toBe(
			inventoryFingerprint([second, first]),
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

	test("conservatively estimates serialized map and posting storage", () => {
		const descriptor = buildToolDescriptor(
			tool(
				"search_many",
				Array.from({ length: 200 }, (_, index) => `term${index}`).join(" "),
			),
			"mcp",
			0,
		);
		const index = buildToolRetrievalIndex([descriptor]);
		const serializedLowerBound = Buffer.byteLength(
			JSON.stringify({
				descriptors: index.descriptors.map(
					({ tool: _tool, ...searchable }) => searchable,
				),
				documentFrequency: [...index.documentFrequency],
				postings: [...index.postings],
			}),
			"utf8",
		);
		// Serialization covers payload bytes but not the two Map node structures.
		const minimumMapNodeBytes =
			(index.documentFrequency.size + index.postings.size) * 24;

		expect(index.estimatedBytes).toBeGreaterThanOrEqual(
			serializedLowerBound + minimumMapNodeBytes,
		);
	});

	test("uses linear mode without dropping descriptors under a tiny budget", () => {
		const descriptors = [
			buildToolDescriptor(tool("alpha", "first tool"), "mcp", 0),
			buildToolDescriptor(tool("beta", "second tool"), "mcp", 1),
		];
		const index = buildToolRetrievalIndex(descriptors, { maxIndexBytes: 1 });

		expect(index.mode).toBe("linear");
		expect(index.descriptors).toHaveLength(2);
		expect(searchToolRetrievalIndex(index, "tool", 2)).toHaveLength(2);
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
