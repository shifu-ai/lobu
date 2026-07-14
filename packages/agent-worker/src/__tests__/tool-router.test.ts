import { describe, expect, test } from "bun:test";
import type { McpToolDef } from "@lobu/core";
import { selectMcpToolsByMcpForTurn } from "../openclaw/dynamic-tool-loader";
import { catalogEntryForTool } from "../openclaw/tool-catalog";
import { buildToolRouteQuery } from "../openclaw/tool-route-query";
import { routeToolEntries } from "../openclaw/tool-router";

function tool(
	name: string,
	description: string,
	extras: Record<string, unknown> = {},
): McpToolDef {
	return {
		name,
		description,
		inputSchema: { type: "object", properties: {} },
		...extras,
	};
}

const manageSchedules = tool(
	"manage_schedules",
	"Create and manage delayed or recurring personal reminders.",
);
const createCalendarEvent = tool(
	"gws_calendar_events_create",
	"Create meetings and events in Google Calendar.",
);

function schedulingTools() {
	return {
		"lobu-memory": [manageSchedules],
		google_workspace: [createCalendarEvent],
	};
}

describe("semantic tool routing authorization and write ambiguity", () => {
	test("asks which destination to use for an ambiguous meeting write", () => {
		const result = selectMcpToolsByMcpForTurn({
			toolsByMcp: schedulingTools(),
			message: "幫我排明天下午三點跟老師開會",
			budget: 12,
		});

		expect(result.trace.clarificationRequired).toBe(true);
		expect(result.trace.blockedToolNames).toEqual([
			"google_workspace/gws_calendar_events_create",
			"lobu-memory/manage_schedules",
		]);
		expect(result.trace.clarificationQuestion).toBe(
			"你要我建立 Google Calendar 行事曆事件，還是只在時間到時提醒你？",
		);
		expect(result.trace.selectedToolNames).not.toContain(
			"google_workspace/gws_calendar_events_create",
		);
		expect(result.trace.selectedToolNames).not.toContain(
			"lobu-memory/manage_schedules",
		);
	});

	test("applies authorization before retrieval and clarification", () => {
		const result = selectMcpToolsByMcpForTurn({
			toolsByMcp: schedulingTools(),
			message: "放進 Google Calendar",
			budget: 12,
			allowedToolNames: ["lobu-memory/manage_schedules"],
		});

		expect(
			result.trace.candidates.map((candidate) => candidate.key),
		).not.toContain("google_workspace/gws_calendar_events_create");
		expect(result.trace.selectedToolNames).not.toContain(
			"google_workspace/gws_calendar_events_create",
		);
		expect(result.trace.blockedToolNames).not.toContain(
			"google_workspace/gws_calendar_events_create",
		);
		expect(result.trace.clarificationChoices ?? []).not.toContain(
			"google_workspace/gws_calendar_events_create",
		);
		expect(result.trace.omittedToolNames).not.toContain(
			"google_workspace/gws_calendar_events_create",
		);
		expect(result.trace.omitted).not.toContain(
			"google_workspace/gws_calendar_events_create",
		);
	});

	test("selects only the reminder destination when explicitly requested", () => {
		const result = selectMcpToolsByMcpForTurn({
			toolsByMcp: schedulingTools(),
			message: "五分鐘後提醒我吃午餐",
			budget: 12,
		});

		expect(result.trace.clarificationRequired).toBe(false);
		expect(result.trace.selectedToolNames).toEqual([
			"lobu-memory/manage_schedules",
		]);
	});

	test("selects only Google Calendar when explicitly requested", () => {
		const result = selectMcpToolsByMcpForTurn({
			toolsByMcp: schedulingTools(),
			message: "放進 Google Calendar",
			budget: 12,
		});

		expect(result.trace.clarificationRequired).toBe(false);
		expect(result.trace.selectedToolNames).toEqual([
			"google_workspace/gws_calendar_events_create",
		]);
	});

	test("does not select a Calendar create tool for an explicit read operation", () => {
		const result = selectMcpToolsByMcpForTurn({
			toolsByMcp: schedulingTools(),
			message: "get Google Calendar events",
			budget: 12,
		});

		expect(result.trace.explicitDestinations).toContain("google_calendar");
		expect(result.trace.selectedToolNames).toEqual([]);
	});

	test("extracts read operations from Chinese requests", () => {
		expect(buildToolRouteQuery("讀取會議紀錄").operations).toContain("read");
	});

	test("matches English operation words only at token boundaries", () => {
		const result = selectMcpToolsByMcpForTurn({
			toolsByMcp: {
				"shifu-toolbox": [
					tool("create_address", "Create an address record", {
						_meta: {
							shifuTool: {
								domain: "unknown",
								priority: "P2",
								aliases: ["address"],
								readOnly: false,
								mutatesState: true,
								requiresConfirmation: true,
							},
						},
					}),
				],
			},
			message: "find address",
			budget: 12,
		});

		expect(buildToolRouteQuery("find address").operations).toEqual(["search"]);
		expect(result.trace.selectedToolNames).toEqual([]);
	});

	test("exposes qualified display keys in the clarification contract", () => {
		const entries = [
			catalogEntryForTool(manageSchedules, 0, "lobu-memory"),
			catalogEntryForTool(createCalendarEvent, 1, "google_workspace"),
		];
		const route = routeToolEntries({
			entries,
			message: "幫我排明天下午三點跟老師開會",
			budget: 12,
			reservedEntries: [],
		});

		expect(route.clarification?.blockedToolKeys.sort()).toEqual([
			"google_workspace/gws_calendar_events_create",
			"lobu-memory/manage_schedules",
		]);
	});

	test("does not clarify when several read-only sources match", () => {
		const result = selectMcpToolsByMcpForTurn({
			toolsByMcp: {
				drive: [tool("search", "Search meeting notes in Google Drive")],
				notion: [tool("search", "Search meeting notes in Notion")],
			},
			message: "search meeting notes",
			budget: 2,
		});

		expect(result.trace.clarificationRequired).toBe(false);
		expect(result.trace.selectedToolNames).toHaveLength(2);
	});

	test("supports plain and qualified allow names without identity collisions", () => {
		const plain = selectMcpToolsByMcpForTurn({
			toolsByMcp: {
				one: [tool("shared", "Find shared records")],
				two: [tool("shared", "Find shared records")],
			},
			message: "shared",
			budget: 2,
			allowedToolNames: ["shared"],
		});
		expect(plain.trace.selectedToolNames).toEqual(["one/shared", "two/shared"]);

		const collision = selectMcpToolsByMcpForTurn({
			toolsByMcp: {
				a: [tool("b/c", "Find collision-safe records")],
				"a/b": [tool("c", "Find collision-safe records")],
			},
			message: "collision safe records",
			budget: 2,
			allowedToolNames: ["a/b/c"],
		});
		expect(collision.selectedTools).toEqual({});
		expect(collision.trace.candidates).toEqual([]);
		expect(collision.trace.omittedToolNames).toEqual([]);
	});

	test("treats slash allow names exclusively as qualified names", () => {
		const result = selectMcpToolsByMcpForTurn({
			toolsByMcp: {
				a: [tool("b", "Find authorized records")],
				x: [tool("a/b", "Find unauthorized records")],
			},
			message: "find records",
			budget: 2,
			allowedToolNames: ["a/b"],
		});

		expect(result.trace.selectedToolNames).toEqual(["a/b"]);
		expect(result.selectedTools.x).toBeUndefined();
		expect(result.trace.candidates.map((candidate) => candidate.key)).toEqual([
			"a/b",
		]);
		expect(result.trace.omittedToolNames).not.toContain("x/a/b");
		expect(result.trace.omitted).not.toContain("x/a/b");
	});

	test("does not backfill unrelated read-only tools", () => {
		const result = selectMcpToolsByMcpForTurn({
			toolsByMcp: {
				drive: [tool("search", "Search meeting notes in Google Drive")],
				notion: [tool("search", "Search meeting notes in Notion")],
			},
			message: "weather tomorrow",
			budget: 12,
		});

		expect(result.trace.candidates).toEqual([]);
		expect(result.trace.selectedToolNames).toEqual([]);
	});

	test("does not backfill read-only tools for an empty message", () => {
		const result = selectMcpToolsByMcpForTurn({
			toolsByMcp: {
				drive: [tool("search", "Search meeting notes in Google Drive")],
				notion: [tool("search", "Search meeting notes in Notion")],
			},
			message: "",
			budget: 12,
		});

		expect(result.trace.candidates).toEqual([]);
		expect(result.trace.selectedToolNames).toEqual([]);
		expect(result.trace.fallback).toBe("empty_query");
	});

	test("falls back to eligible reserved tools when retrieval fails", () => {
		const askUser = catalogEntryForTool(
			tool("ask_user", "Ask the user"),
			0,
			"core",
		);
		const disallowed = catalogEntryForTool(
			tool("secret_write", "Create secret"),
			1,
			"secret",
		);
		const route = routeToolEntries({
			entries: [askUser, disallowed],
			message: "create something",
			budget: 2,
			reservedEntries: [askUser],
			allowedToolNames: ["core/ask_user"],
			retrieval: {
				search: () => {
					throw new Error("synthetic retrieval failure");
				},
			},
		});

		expect(route.fallback).toBe("router_error");
		expect(route.selectedEntries.map(({ name }) => name)).toEqual(["ask_user"]);
		expect(route.candidates).toEqual([]);
	});

	test("clarifies conflicting generic write side effects", () => {
		const result = selectMcpToolsByMcpForTurn({
			toolsByMcp: {
				mail: [tool("send_email", "發布 announcement using email")],
				social: [tool("publish_post", "發布 announcement using social post")],
			},
			message: "發布 announcement",
			budget: 2,
			routerMode: "semantic",
		});

		expect(result.trace.clarificationRequired).toBe(true);
		expect(result.trace.clarificationReason).toBe("conflicting_side_effect");
		expect(result.trace.blockedToolNames).toEqual([
			"mail/send_email",
			"social/publish_post",
		]);
		expect(result.trace.clarificationQuestion).toContain("send_email");
		expect(result.trace.clarificationQuestion).toContain("publish_post");
	});

	test("explicit generic write evidence selects one side effect", () => {
		const result = selectMcpToolsByMcpForTurn({
			toolsByMcp: {
				mail: [tool("send_email", "Send an email announcement")],
				social: [tool("publish_post", "Publish a social post announcement")],
			},
			message: "send this announcement by email",
			budget: 2,
			routerMode: "semantic",
		});

		expect(result.trace.clarificationRequired).toBe(false);
		expect(result.trace.selectedToolNames).toEqual(["mail/send_email"]);
	});
});
