import type { MessagePayload } from "@lobu/core";
import { describe, expect, test, vi } from "vitest";
import {
	attachCourseContextForReviewedScope,
	decideCourseTurn,
	requiresCourseContext,
} from "../orchestration/course-context-gate.js";
import {
	normalizeCourseContextRequestPolicy,
	ToolboxCourseContextRequestError,
} from "../services/course-context-request-policy.js";
import { ToolboxCourseContextClient } from "../services/toolbox-course-context-client.js";
const payload = (
	messageText: string,
	platformMetadata: Record<string, unknown> = {},
): MessagePayload =>
	({
		userId: "u",
		agentId: "a",
		conversationId: "c",
		channelId: "ch",
		messageId: "m",
		platform: "line",
		messageText,
		platformMetadata,
		agentOptions: {},
	}) as MessagePayload;
const candidate = {
	courseKey: "b",
	courseEntityId: "course:b",
	displayName: "B 課",
	aliases: ["B"],
	status: "active",
	reasons: ["message_alias"],
};
describe("course context gate", () => {
	test("fire-time mode propagates transient resolver failure to the durable task runner", async () => {
		const data = payload("準備排程課程任務");
		data.scheduledCourseContext = {
			schemaVersion: 1,
			source: "calendar_scheduled_wake",
			automationId: "auto-1",
			jobId: "job-1",
			runId: 42,
			taskKind: "opp_coach_rehearsal_prompt",
			course: {
				ownerUserId: "u",
				agentId: "a",
				courseKey: "a",
				courseEntityId: "course:a",
				displayName: "A 課",
			},
			evidenceReadiness: "canonical_only",
		};
		const fetcher = vi.fn().mockRejectedValue(new Error("toolbox timeout"));
		await expect(
			attachCourseContextForReviewedScope(data, {
				baseUrl: "https://t",
				secret: "s",
				fetcher,
				propagateInfrastructureErrors: true,
			}),
		).rejects.toThrow("toolbox timeout");
	});
	test("retries one transient resolver failure and attaches canonical context", async () => {
		const data = payload("我要設定超級 AI 個體戰報");
		const fetcher = vi
			.fn()
			.mockRejectedValueOnce(new DOMException("timed out", "AbortError"))
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						status: "resolved",
						confidence: "high",
						matchedBy: ["single_course_default"],
						course: {
							courseKey: "super-ai",
							courseEntityId: "course:super-ai",
							displayName: "超級 AI 個體",
						},
					}),
					{ status: 200 },
				),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify(canonicalBundle("super-ai")), { status: 200 }),
			);

		const result = await attachCourseContextForReviewedScope(data, {
			baseUrl: "https://toolbox.test",
			secret: "secret",
			fetcher,
		});

		expect(result).toMatchObject({
			status: "ready",
			context: { course: { courseKey: "super-ai" } },
		});
		expect(fetcher).toHaveBeenCalledTimes(3);
	});
	test("does not retry an ordinary resolver error", async () => {
		const fetcher = vi.fn().mockRejectedValue(new Error("toolbox unavailable"));

		await expect(
			attachCourseContextForReviewedScope(payload("設定課程"), {
				baseUrl: "https://toolbox.test",
				secret: "secret",
				fetcher,
			}),
		).resolves.toEqual({
			status: "context_unavailable",
			reasonCode: "resolver_unavailable",
		});
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
	test("stops after two transient resolver failures", async () => {
		const fetcher = vi
			.fn()
			.mockRejectedValueOnce(new DOMException("timed out", "AbortError"))
			.mockRejectedValueOnce(new DOMException("timed out", "AbortError"));

		await expect(
			attachCourseContextForReviewedScope(payload("設定課程"), {
				baseUrl: "https://toolbox.test",
				secret: "secret",
				fetcher,
			}),
		).resolves.toEqual({
			status: "context_unavailable",
			reasonCode: "resolver_unavailable",
		});
		expect(fetcher).toHaveBeenCalledTimes(2);
	});
	test("does not retry a lookalike AbortError object", async () => {
		const fetcher = vi.fn().mockRejectedValue({ name: "AbortError" });

		await expect(
			attachCourseContextForReviewedScope(payload("設定課程"), {
				baseUrl: "https://toolbox.test",
				secret: "secret",
				fetcher,
			}),
		).resolves.toEqual({
			status: "context_unavailable",
			reasonCode: "resolver_unavailable",
		});
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
	test("scheduled course A overrides conversation binding B without persisting A", async () => {
		const data = payload("準備排程課程任務");
		data.scheduledCourseContext = {
			schemaVersion: 1,
			source: "calendar_scheduled_wake",
			automationId: "auto-1",
			jobId: "job-1",
			runId: 42,
			taskKind: "opp_coach_rehearsal_prompt",
			course: {
				ownerUserId: "u",
				agentId: "a",
				courseKey: "a",
				courseEntityId: "course:a",
				displayName: "A 課",
			},
			evidenceReadiness: "canonical_only",
		};
		const manager = {
			getSessionStrict: vi
				.fn()
				.mockResolvedValue({
					shifuCourseContext: { courseKey: "b", courseEntityId: "course:b" },
				}),
			bindActiveCourse: vi.fn(),
		};
		const recordScheduledExecutionTrace = vi.fn(async () => {});
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						status: "resolved",
						confidence: "high",
						matchedBy: ["explicit_course_key"],
						course: {
							courseKey: "a",
							courseEntityId: "course:a",
							displayName: "A 課",
						},
					}),
					{ status: 200 },
				),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify(canonicalBundle("a")), { status: 200 }),
			);
		const result = await attachCourseContextForReviewedScope(data, {
			baseUrl: "https://t",
			secret: "s",
			fetcher,
			sessionManager: manager as never,
			sessionKey: "session",
			recordScheduledExecutionTrace,
		});
		const request = JSON.parse(
			(fetcher.mock.calls[0]?.[1] as RequestInit).body as string,
		);
		expect(request).toMatchObject({ explicitCourseKey: "a" });
		expect(request).not.toHaveProperty("boundCourseKey");
		expect(result).toMatchObject({
			status: "ready",
			context: { course: { courseKey: "a" } },
		});
		expect(manager.bindActiveCourse).not.toHaveBeenCalled();
		expect(recordScheduledExecutionTrace).toHaveBeenCalledWith(expect.objectContaining({
			status: "context_ready", runId: 42, courseEntityId: "course:a",
			conversationBindingCourseEntityId: "course:b", contextVersion: 1,
			evidenceReadiness: "canonical_only",
		}));
	});
	test.each([
		[
			"same_course_evidence",
			{
				owner_user_id: "u",
				agent_id: "a",
				course_entity_ids: ["course:a"],
			},
			{semantic_type:"meeting_notes",origin_type:"meeting",origin_id:"gmeet-1",connector_key:"google_workspace",connection_id:41},
		],
		[
			"canonical_only",
			{
				owner_user_id: "u",
				agent_id: "a",
				course_entity_ids: ["course:a"],
				source_type: "transcript",
			},
			{semantic_type:"note",origin_type:null,origin_id:"uc_caller",connector_key:null,connection_id:null},
		],
	] as const)("scheduled readiness becomes %s only from exact scoped evidence", async (expected, metadata, provenance) => {
		const data = payload("準備排程課程任務");
		data.organizationId = "org";
		data.scheduledCourseContext = {
			schemaVersion: 1,
			source: "calendar_scheduled_wake",
			automationId: "auto-1",
			jobId: "job-1",
			runId: 42,
			taskKind: "opp_coach_rehearsal_prompt",
			course: {
				ownerUserId: "u",
				agentId: "a",
				courseKey: "a",
				courseEntityId: "course:a",
				displayName: "A 課",
			},
			evidenceReadiness: "canonical_only",
		};
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						status: "resolved",
						confidence: "high",
						matchedBy: ["explicit_course_key"],
						course: {
							courseKey: "a",
							courseEntityId: "course:a",
							displayName: "A 課",
						},
					}),
					{ status: 200 },
				),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify(canonicalBundle("a")), { status: 200 }),
			);
		const memorySearch = vi
			.fn()
			.mockResolvedValue([
				{
					id: 9,
					payload_text: "meeting evidence",
					title: "meeting",
					source_url: null,
					organization_id: "org",
					metadata,
					...provenance,
				},
			]);
		await attachCourseContextForReviewedScope(data, {
			baseUrl: "https://t",
			secret: "s",
			fetcher,
			memorySearch,
		});
		expect(data.scheduledCourseContext.evidenceReadiness).toBe(expected);
		expect(memorySearch).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: "org",
				ownerUserId: "u",
				agentId: "a",
				entityIds: ["course:a"],
			}),
		);
	});
	test.each([
		["schema", { schemaVersion: 2 }],
		["owner", { course: { ownerUserId: "other" } }],
		["agent", { course: { agentId: "other" } }],
	])("invalid scheduled %s fails closed before Toolbox", async (_name, patch) => {
		const data = payload("scheduled");
		const base: any = {
			schemaVersion: 1,
			source: "calendar_scheduled_wake",
			automationId: "auto",
			jobId: "job",
			runId: 1,
			taskKind: "opp_coach_event_prompt",
			course: {
				ownerUserId: "u",
				agentId: "a",
				courseKey: "a",
				courseEntityId: "course:a",
				displayName: "A",
			},
			evidenceReadiness: "canonical_only",
		};
		data.scheduledCourseContext = {
			...base,
			...patch,
			course: { ...base.course, ...((patch as any).course ?? {}) },
		};
		const fetcher = vi.fn();
		await expect(
			attachCourseContextForReviewedScope(data, {
				baseUrl: "https://t",
				secret: "s",
				fetcher,
			}),
		).resolves.toEqual({
			status: "context_unavailable",
			reasonCode: "invalid_scheduled_course_context",
		});
		expect(fetcher).not.toHaveBeenCalled();
	});
	test.each([
		[{ status: "missing", reason: "archived_only" }, "context_unavailable"],
		[
			{
				status: "resolved",
				confidence: "high",
				matchedBy: ["explicit_course_key"],
				course: {
					courseKey: "a",
					courseEntityId: "course:changed",
					displayName: "A",
				},
			},
			"context_unavailable",
		],
	])("scheduled canonical status fails closed: %#", async (response, status) => {
		const data = payload("scheduled");
		data.scheduledCourseContext = {
			schemaVersion: 1,
			source: "calendar_scheduled_wake",
			automationId: "auto",
			jobId: "job",
			runId: 1,
			taskKind: "opp_coach_event_prompt",
			course: {
				ownerUserId: "u",
				agentId: "a",
				courseKey: "a",
				courseEntityId: "course:a",
				displayName: "A",
			},
			evidenceReadiness: "canonical_only",
		};
		const fetcher = vi
			.fn()
			.mockResolvedValue(
				new Response(JSON.stringify(response), { status: 200 }),
			);
		await expect(
			attachCourseContextForReviewedScope(data, {
				baseUrl: "https://t",
				secret: "s",
				fetcher,
			}),
		).resolves.toMatchObject({ status });
	});
	test.each([
		["銷講", true],
		["三個秘密", true],
		["課綱", true],
		["課程", true],
		["老師回饋", true],
		["課程會議", true],
		["課程文件", true],
		["戰報", true],
		["招生 Offer", true],
		["提醒我明天繳電話費", false],
	])("%s => %s", (text, want) =>
		expect(requiresCourseContext(payload(text))).toBe(want));
	test("personal reminder bypasses skill, reviewed marker, and active binding unless course wording is explicit", () => {
		expect(
			requiresCourseContext(
				payload("提醒我明天繳電話費", { courseScope: "reviewed" }),
				{ hasActiveCourse: true },
			),
		).toBe(false);
		expect(
			requiresCourseContext(payload("提醒我明天整理課程文件"), {
				hasActiveCourse: true,
			}),
		).toBe(true);
	});
	test.each([
		["幫我寫信跟老師確認下週錄課時間", true],
		["整理今天的課程會議待辦", true],
		["這堂課的三個秘密幫我想一下", true],
		["幫我看這段銷講彩排哪裡要改", true],
		["提醒我繳電話費", false],
		["你好", false],
	] as const)("classifies general course context without selecting a skill for %s", (message, courseContextRequired) => {
		expect(decideCourseTurn(payload(message))).toEqual({ courseContextRequired });
	});
	test("reviewed scope requires general course context without activating opp-coach", () => {
		expect(decideCourseTurn(payload("你好", { courseScope: "reviewed" }))).toEqual({
			courseContextRequired: true,
		});
	});
	test("accepts the complete canonical ambiguous contract and preserves order", async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValue(
				new Response(
					JSON.stringify({
						status: "ambiguous",
						reason: "alias_overlap",
						candidates: [
							candidate,
							{
								...candidate,
								courseKey: "a",
								courseEntityId: "course:a",
								displayName: "A 課",
							},
						],
					}),
					{ status: 200 },
				),
			);
		await expect(
			attachCourseContextForReviewedScope(payload("課程"), {
				baseUrl: "https://t",
				secret: "s",
				fetcher,
			}),
		).resolves.toEqual({
			status: "clarification_required",
			candidates: [
				{ courseKey: "b", displayName: "B 課" },
				{ courseKey: "a", displayName: "A 課" },
			],
		});
	});
	test.each([
		[
			{
				status: "ambiguous",
				reason: "alias_overlap",
				candidates: [{ courseKey: "b", displayName: "B" }],
			},
		],
		[{ status: "ambiguous", reason: "unknown", candidates: [candidate] }],
		[
			{
				status: "ambiguous",
				reason: "alias_overlap",
				candidates: [{ ...candidate, status: "archived" }],
			},
		],
		[
			{
				status: "ambiguous",
				reason: "alias_overlap",
				candidates: [{ ...candidate, reasons: ["unknown"] }],
			},
		],
		[{ status: "missing", reason: "no_match" }],
	])("maps malformed closed contract %# to unavailable", async (body) => {
		const fetcher = vi
			.fn()
			.mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
		await expect(
			attachCourseContextForReviewedScope(payload("課程"), {
				baseUrl: "https://t",
				secret: "s",
				fetcher,
			}),
		).resolves.toEqual({
			status: "context_unavailable",
			reasonCode: "resolver_unavailable",
		});
	});
	test("maps missing/no_courses to a trusted onboarding execution scope", async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValue(
				new Response(JSON.stringify({ status: "missing", reason: "no_courses" }), {
					status: 200,
				}),
			);
		await expect(
			attachCourseContextForReviewedScope(payload("課程"), {
				baseUrl: "https://t",
				secret: "s",
				fetcher,
			}),
		).resolves.toEqual({
			status: "onboarding_ready",
			scope: {
				mode: "onboarding",
				source: "toolbox_course_resolution",
				reason: "no_courses",
				ownerUserId: "u",
				agentId: "a",
				conversationId: "c",
			},
		});
	});
	test("keeps missing/archived_only fail closed", async () => {
		const fetcher = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ status: "missing", reason: "archived_only" }), {
				status: 200,
			}),
		);
		await expect(
			attachCourseContextForReviewedScope(payload("課程"), {
				baseUrl: "https://t",
				secret: "s",
				fetcher,
			}),
		).resolves.toEqual({ status: "context_unavailable", reasonCode: "archived_only" });
	});
	test.each([
		"multiple_active_courses",
		"explicit_course_key_not_found",
	] as const)("allows empty candidate reasons for %s", async (reason) => {
		const fetcher = vi
			.fn()
			.mockResolvedValue(
				new Response(
					JSON.stringify({
						status: "ambiguous",
						reason,
						candidates: [{ ...candidate, reasons: [] }],
					}),
					{ status: 200 },
				),
			);
		await expect(
			attachCourseContextForReviewedScope(payload("課程"), {
				baseUrl: "https://t",
				secret: "s",
				fetcher,
			}),
		).resolves.toMatchObject({ status: "clarification_required" });
	});
	test.each([
		"explicit_course_key",
		"message_name",
		"message_alias",
		"conversation_binding",
		"single_course_default",
	] as const)("accepts and preserves resolved match %s", async (matchedBy) => {
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						status: "resolved",
						confidence: "high",
						matchedBy: [matchedBy],
						course: {
							courseKey: "x",
							courseEntityId: "course:x",
							displayName: "X",
						},
					}),
					{ status: 200 },
				),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify(canonicalBundle("x")), { status: 200 }),
			);
		const result = await attachCourseContextForReviewedScope(payload("課程"), {
			baseUrl: "https://t",
			secret: "s",
			fetcher,
		});
		expect(result).toMatchObject({
			status: "ready",
			context: { resolution: { matchedBy: [matchedBy] } },
		});
	});
	test.each([
		[],
		["unknown"],
		["message_name", "message_alias"],
	])("rejects invalid resolved matchedBy %j", async (matchedBy) => {
		const fetcher = vi
			.fn()
			.mockResolvedValue(
				new Response(
					JSON.stringify({
						status: "resolved",
						confidence: "high",
						matchedBy,
						course: {
							courseKey: "x",
							courseEntityId: "course:x",
							displayName: "X",
						},
					}),
					{ status: 200 },
				),
			);
		await expect(
			attachCourseContextForReviewedScope(payload("課程"), {
				baseUrl: "https://t",
				secret: "s",
				fetcher,
			}),
		).resolves.toEqual({
			status: "context_unavailable",
			reasonCode: "resolver_unavailable",
		});
	});
	test("personal reminder bypasses a failed session store read", async () => {
		const manager = {
			getSession: vi.fn().mockRejectedValue(new Error("down")),
		};
		await expect(
			attachCourseContextForReviewedScope(payload("提醒我明天繳電話費"), {
				baseUrl: "https://t",
				secret: "s",
				sessionManager: manager as never,
				sessionKey: "s",
			}),
		).resolves.toEqual({ status: "not_required" });
		expect(manager.getSession).not.toHaveBeenCalled();
	});
	test("accepts the real canonical Toolbox bundle shape and rejects identity mismatch", async () => {
		const resolved = {
			status: "resolved",
			confidence: "high",
			matchedBy: ["message_name"],
			course: { courseKey: "x", courseEntityId: "course:x", displayName: "X" },
		};
		const canonical = {
			course: {
				courseKey: "x",
				courseEntityId: "course:x",
				displayName: "X",
				aliases: ["別名"],
				status: "active",
			},
			profile: {
				pmRole: null,
				teacher: null,
				collaborators: [],
				audience: null,
				coursePromise: null,
				resourceLocations: {},
			},
			context: {
				agentMd: "# 課程 X",
				contextPackId: "p",
				version: 3,
				confidence: "high",
				generatedAt: "2026-07-09T03:00:00.000Z",
				lastIndexedAt: "2026-07-09T03:59:00.000Z",
				stale: false,
			},
			evidence: { confirmed: [], candidates: [] },
		};
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify(resolved), { status: 200 }),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify(canonical), { status: 200 }),
			);
		await expect(
			attachCourseContextForReviewedScope(payload("課程 X"), {
				baseUrl: "https://t",
				secret: "s",
				fetcher,
			}),
		).resolves.toMatchObject({
			status: "ready",
			context: { context: { confirmedSummary: "# 課程 X" } },
		});
		const mismatch = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify(resolved), { status: 200 }),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						...canonical,
						course: { ...canonical.course, courseEntityId: "course:y" },
					}),
					{ status: 200 },
				),
			);
		await expect(
			attachCourseContextForReviewedScope(payload("課程 X"), {
				baseUrl: "https://t",
				secret: "s",
				fetcher: mismatch,
			}),
		).resolves.toMatchObject({
			status: "context_unavailable",
			reasonCode: "bundle_identity_mismatch",
		});
	});
	test("accepts producer-sized bundles above 12k and projects agentMd", async () => {
		const resolved = {
			status: "resolved",
			confidence: "high",
			matchedBy: ["message_name"],
			course: { courseKey: "x", courseEntityId: "course:x", displayName: "x" },
		};
		const large: any = canonicalBundle("x");
		large.context.agentMd = "a".repeat(50000);
		large.evidence.confirmed = Array.from({ length: 30 }, (_, i) => ({
			id: String(i),
			sourceType: "doc",
			sourceId: String(i),
			sourceUrl: null,
			sourceTitle: null,
			excerptPreview: "e".repeat(500),
			evidenceKind: "fact",
			confidence: "high",
			observedAt: "2026-07-11T00:00:00Z",
		}));
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify(resolved), { status: 200 }),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify(large), { status: 200 }),
			);
		const result = await attachCourseContextForReviewedScope(payload("課程"), {
			baseUrl: "https://t",
			secret: "s",
			fetcher,
		});
		expect(
			result.status === "ready" && result.context.context.confirmedSummary,
		).toHaveLength(8000);
		large.context.agentMd += "x";
		const bad = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify(resolved), { status: 200 }),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify(large), { status: 200 }),
			);
		await expect(
			attachCourseContextForReviewedScope(payload("課程"), {
				baseUrl: "https://t",
				secret: "s",
				fetcher: bad,
			}),
		).resolves.toMatchObject({ status: "context_unavailable" });
	});
	test("retrieval failure preserves ready canonical bundle", async () => {
		const resolved = {
			status: "resolved",
			confidence: "high",
			matchedBy: ["single_course_default"],
			course: { courseKey: "x", courseEntityId: "course:x", displayName: "X" },
		};
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify(resolved), { status: 200 }),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify(canonicalBundle("x")), { status: 200 }),
			);
		const memorySearch = vi.fn().mockRejectedValue(new Error("down"));
		const actual = payload("請整理課程 Offer");
		actual.organizationId = "org";
		await expect(
			attachCourseContextForReviewedScope(actual, {
				baseUrl: "https://t",
				secret: "s",
				fetcher,
				memorySearch,
				activeSpecializedSkill: "opp-coach",
			}),
		).resolves.toMatchObject({
			status: "ready",
			context: {
				retrieval: {
					status: "degraded",
					crossCourseGuard: "passed",
					eventIds: [],
				},
			},
		});
		expect(memorySearch).toHaveBeenCalledWith(
			expect.objectContaining({
				entityIds: ["course:x"],
				limit: 8,
				query: expect.stringContaining("Offer"),
			}),
		);
	});
	test("empty retrieval emits the empty journey convention", async () => {
		const resolved = {
			status: "resolved",
			confidence: "high",
			matchedBy: ["single_course_default"],
			course: { courseKey: "x", courseEntityId: "course:x", displayName: "X" },
		};
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify(resolved), { status: 200 }),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify(canonicalBundle("x")), { status: 200 }),
			);
		const actual = payload("請整理課程");
		actual.organizationId = "org";
		const events: Array<{ event: string; status: string }> = [];
		await attachCourseContextForReviewedScope(actual, {
			baseUrl: "https://t",
			secret: "s",
			fetcher,
			memorySearch: vi.fn().mockResolvedValue([]),
			traceEmitter: async (event) => {
				events.push(event);
			},
		});
		expect(events).toContainEqual(
			expect.objectContaining({ event: "context.memory.empty", status: "ok" }),
		);
	});
	test.each([
		[
			"loaded",
			[
				{
					id: 1,
					payload_text: "safe",
					title: null,
					source_url: null,
					organization_id: "org",
					metadata: {
						owner_user_id: "u",
						agent_id: "a",
						course_entity_ids: ["course:x"],
					},
				},
			],
		],
		["degraded", new Error("down")],
		[
			"invariant_violation",
			[
				{
					id: 2,
					payload_text: "UNSAFE_EVENT_TEXT",
					title: null,
					source_url: null,
					organization_id: "org",
					metadata: {
						owner_user_id: "other",
						agent_id: "a",
						course_entity_ids: ["course:x"],
					},
				},
			],
		],
	])("emits low-cardinality context.memory.%s without identity or content fields", async (expected, answer) => {
		const resolved = {
			status: "resolved",
			confidence: "high",
			matchedBy: ["single_course_default"],
			course: { courseKey: "x", courseEntityId: "course:x", displayName: "X" },
		};
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify(resolved), { status: 200 }),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify(canonicalBundle("x")), { status: 200 }),
			);
		const actual = payload("SECRET_QUERY");
		actual.organizationId = "org";
		const events: any[] = [];
		const memorySearch =
			answer instanceof Error
				? vi.fn().mockRejectedValue(answer)
				: vi.fn().mockResolvedValue(answer);
		await attachCourseContextForReviewedScope(actual, {
			baseUrl: "https://t",
			secret: "s",
			fetcher,
			memorySearch,
			activeSpecializedSkill: "opp-coach",
			traceEmitter: async (event) => {
				events.push(event);
			},
		});
		const event = events.find(
			(item) => item.event === `context.memory.${expected}`,
		);
		expect(event).toMatchObject({
			candidate_count: expect.any(Number),
			safe_count: expect.any(Number),
			dropped_count: expect.any(Number),
			duration_ms: expect.any(Number),
		});
		for (const key of [
			"owner_hash",
			"agent_key",
			"course_entity_id",
			"conversation_hash",
			"query",
			"message",
			"snippet",
			"prompt",
			"header",
			"result_count",
			"course_key",
		])
			expect(event).not.toHaveProperty(key);
		expect(JSON.stringify(event)).not.toContain("SECRET_QUERY");
		expect(JSON.stringify(event)).not.toContain("UNSAFE_EVENT_TEXT");
		expect(JSON.stringify(event)).not.toContain("course:x");
	});
	test("persisted binding emits updated with ok status", async () => {
		const resolved = {
			status: "resolved",
			confidence: "high",
			matchedBy: ["single_course_default"],
			course: { courseKey: "x", courseEntityId: "course:x", displayName: "X" },
		};
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify(resolved), { status: 200 }),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify(canonicalBundle("x")), { status: 200 }),
			);
		const events: Array<{ event: string; status: string }> = [];
		const sessionManager = {
			getSessionStrict: vi.fn().mockResolvedValue(null),
			bindActiveCourse: vi.fn().mockResolvedValue({ status: "persisted" }),
		};
		await attachCourseContextForReviewedScope(payload("課程"), {
			baseUrl: "https://t",
			secret: "s",
			fetcher,
			sessionManager: sessionManager as never,
			sessionKey: "s",
			traceEmitter: async (event) => {
				events.push(event);
			},
		});
		expect(events).toContainEqual(
			expect.objectContaining({
				event: "context.binding.updated",
				status: "ok",
			}),
		);
	});
	test("uses both advertised terms within three queries without querying context field names", async () => {
		const resolved = {
			status: "resolved",
			confidence: "high",
			matchedBy: ["single_course_default"],
			course: { courseKey: "x", courseEntityId: "course:x", displayName: "X" },
		};
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify(resolved), { status: 200 }),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify(canonicalBundle("x")), { status: 200 }),
			);
		const memorySearch = vi.fn().mockResolvedValue([]);
		const actual = payload("review now");
		actual.organizationId = "org";
		await attachCourseContextForReviewedScope(actual, {
			baseUrl: "https://t",
			secret: "s",
			fetcher,
			memorySearch,
			activeSpecializedSkill: "opp-coach",
			courseSkillRetrievalTerms: ["Key Learning", "Offer"],
			courseSkillRetrievalLimit: 3,
			courseSkillContextFields: ["audience"],
		});
		expect(memorySearch.mock.calls.map(([call]) => call.query)).toEqual([
			"review now",
			"Key Learning",
			"Offer",
		]);
		expect(memorySearch).not.toHaveBeenCalledWith(
			expect.objectContaining({ query: "audience" }),
		);
	});
	test("projects only requested canonical fields and marks structurally unavailable fields missing", async () => {
		const resolved = {
			status: "resolved",
			confidence: "high",
			matchedBy: ["single_course_default"],
			course: { courseKey: "x", courseEntityId: "course:x", displayName: "X" },
		};
		const bundle = canonicalBundle("x");
		bundle.context.agentMd = "SECRET_UNREQUESTED\nOffer invented in prose";
		bundle.profile.audience = "課程 PM";
		bundle.profile.coursePromise = "完成銷講";
		bundle.evidence.confirmed = [
			{
				id: "ev-1",
				sourceType: "doc",
				sourceId: "d",
				sourceUrl: null,
				sourceTitle: "正式論述",
				excerptPreview: "已確認證據",
				evidenceKind: "fact",
				confidence: "high",
				observedAt: "2026-07-11T00:00:00Z",
			},
		];
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify(resolved), { status: 200 }),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify(bundle), { status: 200 }),
			);
		const result = await attachCourseContextForReviewedScope(
			payload("review now"),
			{
				baseUrl: "https://t",
				secret: "s",
				fetcher,
				activeSpecializedSkill: "opp-coach",
				courseSkillContextFields: [
					"audience",
					"course_promise",
					"evidence",
					"offer",
				],
			},
		);
		expect(result).toMatchObject({ status: "ready" });
		const summary =
			result.status === "ready" ? result.context.context.confirmedSummary : "";
		expect(summary).toContain("audience: 課程 PM");
		expect(summary).toContain("course_promise: 完成銷講");
		expect(summary).toContain("evidence:");
		expect(summary).toContain("正式論述");
		expect(summary).toContain("已確認證據");
		expect(summary).toContain("offer: [missing]");
		expect(summary).not.toContain("SECRET_UNREQUESTED");
		expect(summary).not.toContain("invented in prose");
	});
	test("uses only exact structured retrieval fields for readiness, preserving canonical conflicts with clarification", async () => {
		const resolved = {
			status: "resolved",
			confidence: "high",
			matchedBy: ["single_course_default"],
			course: { courseKey: "x", courseEntityId: "course:x", displayName: "X" },
		};
		const bundle = canonicalBundle("x");
		bundle.profile.audience = "canonical audience";
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify(resolved), { status: 200 }),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify(bundle), { status: 200 }),
			);
		const actual = payload("course_promise: prose must not count");
		actual.organizationId = "org";
		const memorySearch = vi
			.fn()
			.mockResolvedValue([
				{
					id: 1,
					payload_text: "key_learning: prose must not count",
					title: null,
					source_url: null,
					organization_id: "org",
					metadata: {
						owner_user_id: "u",
						agent_id: "a",
						course_entity_ids: ["course:x"],
						source_ref: "doc:1",
						course_readiness: {
							audience: "different audience",
							course_promise: "retrieved promise",
						},
					},
				},
			]);
		const result = await attachCourseContextForReviewedScope(actual, {
			baseUrl: "https://t",
			secret: "s",
			fetcher,
			memorySearch,
			activeSpecializedSkill: "opp-coach",
		});
		expect(result).toMatchObject({
			status: "ready",
			context: {
				readiness: {
					level: "conflicted",
					answerPolicy: "answer_conservatively",
					availableFields: ["audience", "course_promise"],
					missingFields: ["key_learning", "existing_sales_talk"],
					suggestedQuestions: expect.arrayContaining([
						expect.stringContaining("受眾"),
					]),
				},
				evidence: [
					expect.objectContaining({
						kind: "canonical_context",
						fields: ["audience"],
					}),
					expect.objectContaining({
						kind: "fresh_course_retrieval",
						fields: ["audience", "course_promise"],
					}),
				],
			},
		});
	});
	test("empty retrieval preserves general canonical context without opp-coach readiness", async () => {
		const resolved = {
			status: "resolved",
			confidence: "high",
			matchedBy: ["single_course_default"],
			course: { courseKey: "x", courseEntityId: "course:x", displayName: "X" },
		};
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify(resolved), { status: 200 }),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify(canonicalBundle("x")), { status: 200 }),
			);
		const actual = payload("課程");
		actual.organizationId = "org";
		const result = await attachCourseContextForReviewedScope(actual, {
			baseUrl: "https://t",
			secret: "s",
			fetcher,
			memorySearch: vi.fn().mockResolvedValue([]),
		});
		expect(result).toMatchObject({
			status: "ready",
			context: {
				context: { confirmedSummary: "s" },
				retrieval: { status: "empty" },
			},
		});
		if (result.status === "ready") {
			expect(result.context.activeSpecializedSkill).toBeNull();
			expect(result.context.readiness).toBeUndefined();
		}
	});
	test("non-text input is safe", () =>
		expect(
			requiresCourseContext({
				...payload("x"),
				messageText: undefined,
			} as MessagePayload),
		).toBe(false));
	test("strict session outage fails a bound continuation closed", async () => {
		const manager = {
			getSessionStrict: vi.fn().mockRejectedValue(new Error("down")),
		};
		await expect(
			attachCourseContextForReviewedScope(payload("繼續"), {
				baseUrl: "https://t",
				secret: "s",
				sessionManager: manager as never,
				sessionKey: "s",
			}),
		).resolves.toEqual({
			status: "context_unavailable",
			reasonCode: "session_unavailable",
		});
	});
	test("non-text attachment leaves pending selection untouched", async () => {
		const pending = {
			pendingId: "p",
			version: 1,
			status: "pending",
			ownerUserId: "u",
			agentId: "a",
			candidates: [{ courseKey: "x", displayName: "X" }],
			originalMessage: "task",
			createdAt: Date.now(),
		};
		const manager = {
			getSessionStrict: vi
				.fn()
				.mockResolvedValue({ pendingCourseSelection: pending }),
			claimPendingCourseSelection: vi.fn(),
		};
		const result = await attachCourseContextForReviewedScope(
			{ ...payload("x"), messageText: undefined } as MessagePayload,
			{
				baseUrl: "https://t",
				secret: "s",
				sessionManager: manager as never,
				sessionKey: "s",
			},
		);
		expect(result).toEqual({
			status: "clarification_required",
			candidates: pending.candidates,
		});
		expect(manager.claimPendingCourseSelection).not.toHaveBeenCalled();
	});
	test("pending set and expiry clear failures fail closed", async () => {
		const ambiguous = {
			status: "ambiguous",
			reason: "multiple_active_courses",
			candidates: [candidate],
		};
		const setManager = {
			getSessionStrict: vi.fn().mockResolvedValue(null),
			createPendingCourseSelection: vi
				.fn()
				.mockResolvedValue({ status: "failed" }),
		};
		const fetcher = vi
			.fn()
			.mockResolvedValue(
				new Response(JSON.stringify(ambiguous), { status: 200 }),
			);
		await expect(
			attachCourseContextForReviewedScope(payload("課程"), {
				baseUrl: "https://t",
				secret: "s",
				fetcher,
				sessionManager: setManager as never,
				sessionKey: "s",
			}),
		).resolves.toMatchObject({
			status: "context_unavailable",
			reasonCode: "pending_write_failed",
		});
		const expired = {
			pendingId: "old",
			version: 1,
			status: "pending",
			ownerUserId: "u",
			agentId: "a",
			candidates: [{ courseKey: "x", displayName: "X" }],
			originalMessage: "task",
			createdAt: 0,
		};
		const clearManager = {
			getSessionStrict: vi
				.fn()
				.mockResolvedValue({ pendingCourseSelection: expired }),
			clearPendingCourseSelection: vi
				.fn()
				.mockResolvedValue({ status: "failed" }),
		};
		await expect(
			attachCourseContextForReviewedScope(payload("繼續"), {
				baseUrl: "https://t",
				secret: "s",
				sessionManager: clearManager as never,
				sessionKey: "s",
			}),
		).resolves.toMatchObject({
			status: "context_unavailable",
			reasonCode: "pending_clear_failed",
		});
	});
	test.each([
		[
			"legacy unscoped",
			{
				pendingId: "p",
				version: 1,
				status: "pending",
				candidates: [{ courseKey: "x", displayName: "X" }],
				originalMessage: "private",
				createdAt: Date.now(),
			},
		],
		[
			"other owner",
			{
				pendingId: "p",
				version: 1,
				status: "pending",
				ownerUserId: "other",
				agentId: "a",
				candidates: [{ courseKey: "x", displayName: "X" }],
				originalMessage: "private",
				createdAt: Date.now(),
			},
		],
		[
			"other agent",
			{
				pendingId: "p",
				version: 1,
				status: "pending",
				ownerUserId: "u",
				agentId: "other",
				candidates: [{ courseKey: "x", displayName: "X" }],
				originalMessage: "private",
				createdAt: Date.now(),
			},
		],
	])("fails closed without reading or replaying a %s pending record", async (_name, pending) => {
		const manager = {
			getSessionStrict: vi
				.fn()
				.mockResolvedValue({ pendingCourseSelection: pending }),
			claimPendingCourseSelection: vi.fn(),
			clearPendingCourseSelection: vi.fn(),
		};
		await expect(
			attachCourseContextForReviewedScope(payload("1"), {
				baseUrl: "https://t",
				secret: "s",
				sessionManager: manager as never,
				sessionKey: "s",
			}),
		).resolves.toEqual({
			status: "context_unavailable",
			reasonCode: "pending_scope_mismatch",
		});
		expect(manager.claimPendingCourseSelection).not.toHaveBeenCalled();
		expect(manager.clearPendingCourseSelection).not.toHaveBeenCalled();
	});
	test.each([
		["network", () => Promise.reject(new TypeError("fetch failed")), 2],
		[
			"502",
			() => Promise.resolve(new Response("bad gateway", { status: 502 })),
			2,
		],
		[
			"503",
			() => Promise.resolve(new Response("unavailable", { status: 503 })),
			2,
		],
		["504", () => Promise.resolve(new Response("timeout", { status: 504 })), 2],
		[
			"403",
			() => Promise.resolve(new Response("forbidden", { status: 403 })),
			1,
		],
		[
			"409",
			() => Promise.resolve(new Response("conflict", { status: 409 })),
			1,
		],
		[
			"429",
			() => Promise.resolve(new Response("rate limited", { status: 429 })),
			1,
		],
		[
			"invalid-json",
			() => Promise.resolve(new Response("{", { status: 200 })),
			1,
		],
	] as const)("classifies %s and uses %i attempt(s)", async (_name, response, attempts) => {
		const fetcher = vi.fn(response);
		const client = new ToolboxCourseContextClient({
			baseUrl: "https://toolbox.test",
			secret: "secret",
			fetcher,
			sleep: async () => {},
			random: () => 0,
		});
		await expect(
			client.resolve({
				ownerUserId: "u",
				agentId: "a",
				conversationId: "c",
				message: "課程資料",
			}),
		).rejects.toBeInstanceOf(ToolboxCourseContextRequestError);
		expect(fetcher).toHaveBeenCalledTimes(attempts);
	});

	test("policy clamps overrides to the bounded request contract", () => {
		expect(normalizeCourseContextRequestPolicy({
			operationDeadlineMs: 9999,
			attemptTimeoutMs: 9999,
			maxAttempts: 99,
			retryJitterMinMs: -1,
			retryJitterMaxMs: 9999,
		})).toEqual({
			operationDeadlineMs: 5000,
			attemptTimeoutMs: 2250,
			maxAttempts: 2,
			retryJitterMinMs: 100,
			retryJitterMaxMs: 200,
		});
		expect(normalizeCourseContextRequestPolicy({
			operationDeadlineMs: Number.POSITIVE_INFINITY,
			attemptTimeoutMs: -1,
			maxAttempts: Number.NaN,
			retryJitterMinMs: 200,
			retryJitterMaxMs: 100,
		})).toEqual({
			operationDeadlineMs: 5000,
			attemptTimeoutMs: 0,
			maxAttempts: 2,
			retryJitterMinMs: 200,
			retryJitterMaxMs: 200,
		});
	});

	test("deadline uses one scheduler for both attempts and the retry delay", async () => {
		const scheduler = deterministicScheduler();
		const startedAt: number[] = [];
		const abortedAfter: number[] = [];
		const events: Array<{ attemptTimeoutMs: number; totalDurationMs: number }> = [];
		const fetcher = vi.fn(
			(_url: string, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					const started = scheduler.now();
					startedAt.push(started);
					(init?.signal as AbortSignal).addEventListener(
						"abort",
						() => {
							abortedAfter.push(scheduler.now() - started);
							reject(new DOMException("timed out", "AbortError"));
						},
						{ once: true },
					);
				}),
		);
		const client = new ToolboxCourseContextClient({
			baseUrl: "https://toolbox.test",
			secret: "secret",
			fetcher,
			scheduler,
			random: () => 0,
			onAttempt: (event) => {
				events.push(event);
			},
		});
		const request = client.resolve({
			ownerUserId: "u",
			agentId: "a",
			conversationId: "c",
			message: "課程資料",
		});
		await scheduler.advanceBy(2250);
		await scheduler.advanceBy(100);
		await scheduler.advanceBy(2250);
		await expect(request).rejects.toBeInstanceOf(
			ToolboxCourseContextRequestError,
		);
		expect(startedAt).toEqual([0, 2350]);
		expect(abortedAfter).toEqual([2250, 2250]);
		expect(events.map((event) => event.attemptTimeoutMs)).toEqual([2250, 2250]);
		expect(scheduler.now()).toBe(4600);
		expect(events.at(-1)?.totalDurationMs).toBeLessThanOrEqual(5000);
	});

	test("deadline respects an externally supplied gate deadline for a second operation", async () => {
		const scheduler = deterministicScheduler();
		const fetcher = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					status: "missing",
					reason: "no_courses",
				}),
				{ status: 200 },
			),
		);
		const client = new ToolboxCourseContextClient({
			baseUrl: "https://toolbox.test",
			secret: "secret",
			fetcher,
			scheduler,
			gateDeadlineAt: 100,
		});
		await client.resolve({
			ownerUserId: "u",
			agentId: "a",
			conversationId: "c",
			message: "課程資料",
		});
		await scheduler.advanceBy(100);
		await expect(
			client.resolve({
				ownerUserId: "u",
				agentId: "a",
				conversationId: "c",
				message: "課程資料",
			}),
		).rejects.toMatchObject({
			failureClass: "timeout",
		});
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	test("settles an abort-ignoring fetch at the attempt deadline", async () => {
		const scheduler = deterministicScheduler();
		const fetcher = vi.fn(() => new Promise<Response>(() => {}));
		const client = new ToolboxCourseContextClient({
			baseUrl: "https://toolbox.test", secret: "secret", fetcher, scheduler, policy: { maxAttempts: 1 },
		});
		const request = client.resolve({ ownerUserId: "u", agentId: "a", conversationId: "c", message: "課程資料" });
		await scheduler.advanceBy(2250);
		await expect(request).rejects.toMatchObject({ failureClass: "timeout", attempt: 1, totalDurationMs: 2250 });
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	test("settles a hanging retry sleep at the operation deadline", async () => {
		const base = deterministicScheduler();
		const scheduler = { ...base, sleep: () => new Promise<void>(() => {}) };
		const events: Array<{ attempt: number; retrying: boolean }> = [];
		const fetcher = vi.fn(() => Promise.reject(new TypeError("fetch failed")));
		const client = new ToolboxCourseContextClient({
			baseUrl: "https://toolbox.test", secret: "secret", fetcher, scheduler, random: () => 0, onAttempt: (event) => { events.push(event); },
		});
		const request = client.resolve({ ownerUserId: "u", agentId: "a", conversationId: "c", message: "課程資料" });
		await scheduler.advanceBy(1);
		await scheduler.advanceBy(4999);
		await expect(request).rejects.toMatchObject({ failureClass: "timeout", attempt: 1, totalDurationMs: 5000 });
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(events).toEqual([expect.objectContaining({ attempt: 1, retrying: true })]);
	});

	test("bounds a hanging terminal attempt callback as a request timeout", async () => {
		const scheduler = deterministicScheduler();
		const fetcher = vi.fn().mockResolvedValue({ ok: false, status: 403, text: async () => "" } as Response);
		const client = new ToolboxCourseContextClient({ baseUrl: "https://toolbox.test", secret: "secret", fetcher, scheduler, onAttempt: async () => new Promise<void>(() => {}) });
		const request = client.resolve({ ownerUserId: "u", agentId: "a", conversationId: "c", message: "課程資料" });
		await scheduler.advanceBy(1);
		await scheduler.advanceBy(4999);
		await expect(request).rejects.toMatchObject({ failureClass: "timeout", attempt: 1, totalDurationMs: 5000 });
	});

	test("includes a slow terminal callback in the outward error duration", async () => {
		const scheduler = deterministicScheduler();
		const fetcher = vi.fn().mockResolvedValue({ ok: false, status: 403, text: async () => "" } as Response);
		const client = new ToolboxCourseContextClient({ baseUrl: "https://toolbox.test", secret: "secret", fetcher, scheduler, onAttempt: () => scheduler.sleep(50) });
		const request = client.resolve({ ownerUserId: "u", agentId: "a", conversationId: "c", message: "課程資料" });
		await scheduler.advanceBy(1);
		await scheduler.advanceBy(50);
		await expect(request).rejects.toMatchObject({ failureClass: "upstream_4xx", attempt: 1, totalDurationMs: 51 });
	});

	test("bounds a hanging retrying callback without starting a retry", async () => {
		const scheduler = deterministicScheduler();
		const fetcher = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
		const events: Array<{ attempt: number; retrying: boolean }> = [];
		const client = new ToolboxCourseContextClient({ baseUrl: "https://toolbox.test", secret: "secret", fetcher, scheduler, random: () => 0, onAttempt: async (event) => { events.push(event); await new Promise<void>(() => {}); } });
		const request = client.resolve({ ownerUserId: "u", agentId: "a", conversationId: "c", message: "課程資料" });
		await scheduler.advanceBy(1);
		await scheduler.advanceBy(4899);
		await expect(request).rejects.toMatchObject({ failureClass: "timeout", attempt: 1, totalDurationMs: 4900 });
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(events).toEqual([expect.objectContaining({ attempt: 1, retrying: true })]);
	});

	test("preserves only the real secret across mixed-case header collisions", async () => {
		const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "missing", reason: "no_courses" })));
		const client = new ToolboxCourseContextClient({
			baseUrl: "https://toolbox.test", secret: "real-secret", fetcher,
			traceHeaders: { "X-Internal-Secret": "trace-secret" },
		});
		await client.resolve({ ownerUserId: "u", agentId: "a", conversationId: "c", message: "課程資料" });
		const headers = (fetcher.mock.calls[0]?.[1] as RequestInit).headers as Headers;
		expect(headers.get("x-internal-secret")).toBe("real-secret");
		expect([...headers.keys()].filter((name) => name === "x-internal-secret")).toHaveLength(1);
	});

	test.each([
		[399, "invalid_contract"], [400, "upstream_4xx"], [499, "upstream_4xx"],
		[500, "upstream_5xx"], [599, "upstream_5xx"], [600, "invalid_contract"],
	] as const)("classifies HTTP boundary %i as %s without retry", async (status, failureClass) => {
		const fetcher = vi.fn().mockResolvedValue({ ok: false, status, text: async () => "" } as Response);
		const client = new ToolboxCourseContextClient({ baseUrl: "https://toolbox.test", secret: "secret", fetcher, sleep: async () => {} });
		await expect(client.resolve({ ownerUserId: "u", agentId: "a", conversationId: "c", message: "課程資料" })).rejects.toMatchObject({ failureClass, upstreamStatus: status, attempt: 1 });
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	test("retries a body-read TypeError as a network failure", async () => {
		const fetcher = vi.fn()
			.mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.reject(new TypeError("body failed")) } as Response)
			.mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.reject(new TypeError("body failed")) } as Response);
		const client = new ToolboxCourseContextClient({ baseUrl: "https://toolbox.test", secret: "secret", fetcher, sleep: async () => {} });
		await expect(client.resolve({ ownerUserId: "u", agentId: "a", conversationId: "c", message: "課程資料" })).rejects.toMatchObject({ failureClass: "network", attempt: 2 });
		expect(fetcher).toHaveBeenCalledTimes(2);
	});

	test.each([[-1, 100], [1, 200], [Number.NaN, 100], [Number.POSITIVE_INFINITY, 100]] as const)("normalizes random sample %s to retry delay %i", async (sample, expectedDelay) => {
		const delays: number[] = [];
		const fetcher = vi.fn()
			.mockRejectedValueOnce(new TypeError("fetch failed"))
			.mockResolvedValueOnce(new Response(JSON.stringify({ status: "missing", reason: "no_courses" })));
		const client = new ToolboxCourseContextClient({ baseUrl: "https://toolbox.test", secret: "secret", fetcher, random: () => sample, sleep: async (delay) => { delays.push(delay); } });
		await client.resolve({ ownerUserId: "u", agentId: "a", conversationId: "c", message: "課程資料" });
		expect(delays).toEqual([expectedDelay]);
	});

});

function deterministicScheduler() {
	let now = 0;
	let nextTimerId = 0;
	const timers = new Map<number, { at: number; callback: () => void }>();
	const schedule = (callback: () => void, ms: number): number => {
		const id = nextTimerId++;
		timers.set(id, { at: now + Math.max(0, ms), callback });
		return id;
	};
	const drain = async (): Promise<void> => {
		for (let index = 0; index < 8; index += 1) await Promise.resolve();
	};
	return {
		now: () => now,
		sleep: (ms: number) => new Promise<void>((resolve) => {
			schedule(resolve, ms);
		}),
		setTimeout: schedule,
		clearTimeout: (timer: unknown) => {
			timers.delete(timer as number);
		},
		advanceBy: async (ms: number): Promise<void> => {
			const target = now + ms;
			for (;;) {
				const next = [...timers.entries()]
					.filter(([, timer]) => timer.at <= target)
					.sort(([, left], [, right]) => left.at - right.at)[0];
				if (!next) break;
				timers.delete(next[0]);
				now = next[1].at;
				next[1].callback();
				await drain();
			}
			now = target;
			await drain();
		},
	};
}

function canonicalBundle(key: string) {
	return {
		course: {
			courseKey: key,
			courseEntityId: `course:${key}`,
			displayName: key,
			aliases: [],
			status: "active",
		},
		profile: {
			pmRole: null,
			teacher: null,
			collaborators: [],
			audience: null,
			coursePromise: null,
			resourceLocations: {},
		},
		context: {
			agentMd: "s",
			contextPackId: "p",
			version: 1,
			confidence: "high",
			generatedAt: "2026-07-11T00:00:00Z",
			lastIndexedAt: null,
			stale: false,
		},
		evidence: { confirmed: [], candidates: [] },
	};
}
