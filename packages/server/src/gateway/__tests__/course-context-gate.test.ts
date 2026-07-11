import type { MessagePayload } from "@lobu/core";
import { describe, expect, test, vi } from "vitest";
import {
	attachCourseContextForReviewedScope,
	requiresCourseContext,
} from "../orchestration/course-context-gate.js";

const message = (
	messageText: string,
	metadata: Record<string, unknown> = {},
): MessagePayload =>
	({
		userId: "pm-1",
		agentId: "agent-1",
		conversationId: "conv-1",
		channelId: "line-1",
		messageId: "msg-1",
		platform: "line",
		messageText,
		platformMetadata: metadata,
		agentOptions: {},
	}) as MessagePayload;

describe("course context gate", () => {
	test.each([
		["幫我整理銷講", true],
		["想三個秘密", true],
		["更新課綱", true],
		["看看老師回饋", true],
		["準備課程會議", true],
		["找課程文件", true],
		["本週戰報", true],
		["招生 Offer", true],
		["提醒我明天繳電話費", false],
		["提醒我明天買牛奶", false],
		["明天天氣如何", false],
	])("classifies %s", (text, expected) =>
		expect(requiresCourseContext(message(text))).toBe(expected));

	test("enabled course skill and reviewed marker take precedence", () => {
		expect(
			requiresCourseContext(message("hello"), { courseSkillEnabled: true }),
		).toBe(true);
		expect(
			requiresCourseContext(message("hello", { courseScope: "reviewed" })),
		).toBe(true);
	});

	test("active-course continuation is scoped without classifying arbitrary reminders", () => {
		expect(
			requiresCourseContext(message("繼續處理"), { hasActiveCourse: true }),
		).toBe(true);
		expect(
			requiresCourseContext(message("提醒我明天繳電話費"), {
				hasActiveCourse: true,
			}),
		).toBe(false);
	});

	test("returns bounded ambiguous candidates in Toolbox order", async () => {
		const fetcher = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					status: "ambiguous",
					reason: "multiple_matches",
					candidates: [
						{ courseKey: "b", displayName: "B 課" },
						{ courseKey: "a", displayName: "A 課" },
					],
				}),
				{ status: 200 },
			),
		);
		await expect(
			attachCourseContextForReviewedScope(
				message("課程", { courseScope: "reviewed" }),
				{
					baseUrl: "https://toolbox.test",
					secret: "secret",
					fetcher,
				},
			),
		).resolves.toEqual({
			status: "clarification_required",
			candidates: [
				{ courseKey: "b", displayName: "B 課" },
				{ courseKey: "a", displayName: "A 課" },
			],
		});
	});

	test("maps missing and malformed/upstream responses to safe typed results", async () => {
		const missing = vi
			.fn()
			.mockResolvedValue(
				new Response(
					JSON.stringify({ status: "missing", reason: "no_courses" }),
					{ status: 200 },
				),
			);
		await expect(
			attachCourseContextForReviewedScope(message("課程"), {
				baseUrl: "https://toolbox.test",
				secret: "secret",
				fetcher: missing,
			}),
		).resolves.toEqual({ status: "onboarding_required" });
		const malformed = vi
			.fn()
			.mockResolvedValue(new Response("{", { status: 200 }));
		await expect(
			attachCourseContextForReviewedScope(message("課程"), {
				baseUrl: "https://toolbox.test",
				secret: "secret",
				fetcher: malformed,
			}),
		).resolves.toEqual({
			status: "context_unavailable",
			reasonCode: "resolver_unavailable",
		});
	});
});
