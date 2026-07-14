import { describe, expect, test } from "bun:test";
import type { McpToolDef } from "@lobu/core";
import { selectMcpToolsByMcpForTurn } from "../openclaw/dynamic-tool-loader";

function tool(name: string, description: string): McpToolDef {
	return {
		name,
		description,
		inputSchema: { type: "object", properties: {} },
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
	});

	test("selects only the reminder destination when explicitly requested", () => {
		const result = selectMcpToolsByMcpForTurn({
			toolsByMcp: schedulingTools(),
			message: "五分鐘後提醒我吃午餐",
			budget: 1,
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
			budget: 1,
		});

		expect(result.trace.clarificationRequired).toBe(false);
		expect(result.trace.selectedToolNames).toEqual([
			"google_workspace/gws_calendar_events_create",
		]);
	});

	test("does not clarify when several read-only sources match", () => {
		const result = selectMcpToolsByMcpForTurn({
			toolsByMcp: {
				drive: [tool("search", "Search meeting notes in Google Drive")],
				notion: [tool("search", "Search meeting notes in Notion")],
			},
			message: "搜尋老師會議紀錄",
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
		expect(collision.selectedTools.a).toHaveLength(1);
		expect(collision.selectedTools["a/b"]).toHaveLength(1);
	});
});
