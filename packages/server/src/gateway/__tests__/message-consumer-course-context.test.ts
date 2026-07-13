import {
	__resetEncryptionKeyCacheForTests,
	type MessagePayload,
	verifyWorkerToken,
} from "@lobu/core";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
	MessageConsumer,
	terminalCourseContextSingletonKey,
	workerMessageSingletonKey,
} from "../orchestration/message-consumer.js";
const originalFetch = globalThis.fetch;
const oppSkill = {
	name: "opp-coach",
	repo: "local",
	enabled: true,
	content: `---\nname: opp-coach\nmetadata:\n  course-context-contract: 1\n  scope: course\n  context-fields: [audience, offer]\n  retrieval-terms: [Key Learning, Offer]\n  retrieval-limit: 3\n---`,
};
afterEach(() => {
	delete process.env.TOOLBOX_COURSE_CONTEXT_URL;
	delete process.env.TOOLBOX_INTERNAL_SECRET;
	delete process.env.COURSE_CONTEXT_GATE_MODE;
	globalThis.fetch = originalFetch;
});
function setup(
	body: unknown,
	text = "課程",
	metadata: Record<string, unknown> = {},
	rejectTerminal = false,
	withSession = true,
	rejectWorkerOnce = false,
	cleanupFails = false,
) {
	let handler:
		| ((job: { id: string; data: MessagePayload }) => Promise<void>)
		| undefined;
	const sends: Array<[string, unknown, unknown]> = [];
	const order: string[] = [];
	let workerRejected = false;
	const queue = {
		start: vi.fn(),
		stop: vi.fn(),
		createQueue: vi.fn(async (n) => {
			order.push(`create:${n}`);
		}),
		work: vi.fn(async (_n, cb) => {
			handler = cb;
		}),
		send: vi.fn(async (n, d, o) => {
			order.push(`send:${n}`);
			sends.push([n, d, o]);
			if (rejectTerminal && n === "thread_response")
				throw new Error("terminal failed");
			if (
				rejectWorkerOnce &&
				!workerRejected &&
				n.startsWith("thread_message_")
			) {
				workerRejected = true;
				throw new Error("worker send failed");
			}
			return "job";
		}),
		getQueueStats: vi.fn(),
		isHealthy: vi.fn(),
		pauseWorker: vi.fn(),
		resumeWorker: vi.fn(),
	};
	const consumer = new MessageConsumer(
		{ queues: { expireInSeconds: 1, retryLimit: 1 } } as never,
		{
			listDeployments: vi.fn().mockResolvedValue([]),
			createWorkerDeployment: vi.fn(),
			updateDeploymentActivity: vi.fn(),
		} as never,
		queue as never,
		undefined,
		undefined,
		vi.fn(async () => {}),
	);
	let cleanupFailed = false;
	let pending: any;
	if (withSession) {
		const get = vi.fn(async () => ({
			shifuCourseContext: { courseKey: "old" },
			pendingCourseSelection: pending,
		}));
		consumer.setSessionManager({
			getSession: get,
			getSessionStrict: get,
			bindActiveCourse: vi.fn(async () => {
				order.push("bind");
				return { status: "persisted" };
			}),
			createPendingCourseSelection: vi.fn(async (_k, value) => {
				pending = {
					...value,
					pendingId: "pending-1",
					version: 1,
					status: "pending",
				};
				return { status: "persisted", pending };
			}),
			claimPendingCourseSelection: vi.fn(
				async (_k, _id, _owner, _agent, key, messageId) => {
					pending = {
						...pending,
						status: "claimed",
						claimedAt: Date.now(),
						claimedCourseKey: key,
						claimedMessageId: messageId,
					};
					return { status: "claimed", pending };
				},
			),
			markPendingCourseSelectionDispatched: vi.fn(async () => {
				pending = {
					...pending,
					status: "dispatched",
					dispatchedAt: Date.now(),
				};
				return { status: "dispatched" };
			}),
			clearPendingCourseSelection: vi.fn(async () => {
				if (cleanupFails && !cleanupFailed) {
					cleanupFailed = true;
					return { status: "failed" };
				}
				pending = undefined;
				return { status: "cleared" };
			}),
		} as never);
	}
	process.env.TOOLBOX_COURSE_CONTEXT_URL = "https://t";
	process.env.TOOLBOX_INTERNAL_SECRET = "s";
	const fetcher = vi.fn();
	for (let value of Array.isArray(body) ? body : [body]) {
		const record = value as Record<string, any>;
		if (record?.context?.confirmedSummary)
			value = {
				course: { ...record.course, aliases: [], status: "active" },
				profile: {
					pmRole: null,
					teacher: null,
					collaborators: [],
					audience: null,
					coursePromise: null,
					resourceLocations: {},
				},
				context: {
					agentMd: record.context.confirmedSummary,
					contextPackId: record.context.contextPackId,
					version: record.context.version,
					confidence: "high",
					generatedAt: "2026-07-11T00:00:00Z",
					lastIndexedAt: null,
					stale: record.context.stale,
				},
				evidence: { confirmed: [], candidates: [] },
			};
		fetcher.mockResolvedValueOnce(
			new Response(JSON.stringify(value), { status: 200 }),
		);
	}
	globalThis.fetch = fetcher as never;
	const data = {
		userId: "u",
		agentId: "a",
		conversationId: "c",
		channelId: "ch",
		messageId: "m",
		platform: "line",
		messageText: text,
		platformMetadata: metadata,
		agentOptions: {},
	} as MessagePayload;
	return {
		sends,
		order,
		fetcher,
		consumer,
		data,
		run: async (nextText?: string, nextId?: string) => {
			if (nextText) data.messageText = nextText;
			if (nextId) data.messageId = nextId;
			await consumer.start();
			return handler?.({ id: "legacy", data });
		},
	};
}
describe("message consumer course boundary", () => {
	const scheduled = (
		ownerUserId = "u",
	): NonNullable<MessagePayload["scheduledCourseContext"]> => ({
		schemaVersion: 1,
		source: "calendar_scheduled_wake",
		automationId: "auto",
		jobId: "scheduled-job",
		runId: 7,
		taskKind: "opp_coach_event_prompt",
		course: {
			ownerUserId,
			agentId: "a",
			courseKey: "x",
			courseEntityId: "course:x",
			displayName: "X",
		},
		evidenceReadiness: "canonical_only",
	});
	const prevalidated = (): NonNullable<
		MessagePayload["resolvedCourseContext"]
	> => ({
		activeSpecializedSkill: "opp-coach",
		trust: {
			ownerUserId: "u",
			agentId: "a",
			conversationId: "c",
			courseKey: "x",
			courseEntityId: "course:x",
			contextPackId: "p",
			contextVersion: 1,
		},
		course: { courseKey: "x", courseEntityId: "course:x", displayName: "X" },
		resolution: { confidence: "high", matchedBy: ["explicit_course_key"] },
		context: {
			contextPackId: "p",
			contextVersion: 1,
			stale: false,
			confirmedSummary: "canonical",
		},
		retrieval: {
			status: "degraded",
			crossCourseGuard: "passed",
			candidateCount: 0,
			safeCount: 0,
			droppedCount: 0,
			durationMs: 0,
			eventIds: [],
			evidenceRefs: [],
			snippets: [],
		},
		readiness: {
			level: "thin",
			answerPolicy: "answer_conservatively",
			availableFields: [],
			missingFields: [
				"audience",
				"key_learning",
				"course_promise",
				"existing_sales_talk",
			],
			conflictedFields: [],
			suggestedQuestions: [],
		},
		evidence: [],
	});
	test.each([
		"off",
		"shadow",
		"single_course",
		"enforce",
	] as const)("scheduled scope enforces the prevalidated fire context in %s rollout mode without refetching", async (mode) => {
		const previousKey = process.env.ENCRYPTION_KEY;
		process.env.ENCRYPTION_KEY = "a".repeat(64);
		__resetEncryptionKeyCacheForTests();
		try {
			process.env.COURSE_CONTEXT_GATE_MODE = mode;
			const h = setup({});
			h.data.runId = 7;
			h.data.scheduledCourseContext = scheduled();
			h.data.resolvedCourseContext = prevalidated();
			await h.run();
			expect(h.fetcher).not.toHaveBeenCalled();
			const workerMessages = h.sends.filter(([name]) =>
				name.startsWith("thread_message_"),
			);
			expect(workerMessages).toHaveLength(1);
			const workerPayload = workerMessages[0]?.[1] as MessagePayload;
			expect(workerPayload.resolvedCourseContext?.trust.contextPackId).toBe("p");
			expect(workerPayload.resolvedCourseContext?.activeSpecializedSkill).toBe(
				"opp-coach",
			);
			expect(workerPayload.trustedExecutionScope).toMatchObject({
				mode: "course",
				activeSpecializedSkill: "opp-coach",
			});
			expect(verifyWorkerToken(workerPayload.runJobToken ?? "")).toMatchObject({
				executionMode: "course",
				courseToolScope: { activeSpecializedSkill: "opp-coach" },
			});
		} finally {
			if (previousKey === undefined) delete process.env.ENCRYPTION_KEY;
			else process.env.ENCRYPTION_KEY = previousKey;
			__resetEncryptionKeyCacheForTests();
		}
	});
	test("prevalidated scheduled context skips Toolbox and performs memory hydration once", async () => {
		const h = setup({});
		h.data.organizationId = "org";
		h.data.scheduledCourseContext = scheduled();
		h.data.resolvedCourseContext = prevalidated();
		const memorySearch = vi.fn().mockResolvedValue([
			{
				id: 8,
				payload_text: "scoped transcript",
				title: "meeting",
				source_url: null,
				organization_id: "org",
				semantic_type: "content",
				origin_type: "audio",
				origin_id: "gmeet-1#transcript",
				connector_key: "google_workspace",
				connection_id: 41,
				metadata: {
					owner_user_id: "u",
					agent_id: "a",
					course_entity_ids: ["course:x"],
					source_kind: "transcript",
				},
			},
		]);
		h.consumer.setCourseMemorySearch(memorySearch);
		await h.run();
		expect(h.fetcher).not.toHaveBeenCalled();
		expect(memorySearch).toHaveBeenCalledTimes(1);
		const worker = h.sends.find(([name]) =>
			name.startsWith("thread_message_"),
		)?.[1] as MessagePayload;
		expect(worker.scheduledCourseContext?.evidenceReadiness).toBe(
			"same_course_evidence",
		);
	});
	test("invalid scheduled scope terminalizes before worker dispatch", async () => {
		const h = setup({});
		h.data.scheduledCourseContext = scheduled("other");
		await h.run();
		expect(h.fetcher).not.toHaveBeenCalled();
		expect(h.sends.filter(([n]) => n === "thread_response")).toHaveLength(1);
		expect(h.sends.some(([n]) => n.startsWith("thread_message_"))).toBe(false);
	});
	test("unavailable archived scheduled scope terminalizes before worker dispatch", async () => {
		const h = setup({ status: "missing", reason: "archived_only" });
		h.data.scheduledCourseContext = scheduled();
		await h.run();
		expect(h.sends.filter(([n]) => n === "thread_response")).toHaveLength(1);
		expect(h.sends.some(([n]) => n.startsWith("thread_message_"))).toBe(false);
	});
	test("exact scoped scheduled evidence reaches worker as same-course readiness", async () => {
		const h = setup([
			{
				status: "resolved",
				confidence: "high",
				matchedBy: ["explicit_course_key"],
				course: {
					courseKey: "x",
					courseEntityId: "course:x",
					displayName: "X",
				},
			},
			{
				course: {
					courseKey: "x",
					courseEntityId: "course:x",
					displayName: "X",
				},
				context: {
					contextPackId: "p",
					version: 1,
					stale: false,
					confirmedSummary: "canonical",
				},
			},
		]);
		h.data.organizationId = "org";
		h.data.scheduledCourseContext = scheduled();
		h.consumer.setCourseMemorySearch(
			vi.fn().mockResolvedValue([
				{
					id: 8,
					payload_text: "scoped meeting",
					title: "meeting",
					source_url: null,
					organization_id: "org",
					semantic_type: "meeting_notes",
					origin_type: "meeting",
					origin_id: "gmeet-1",
					connector_key: "google_workspace",
					connection_id: 41,
					metadata: {
						owner_user_id: "u",
						agent_id: "a",
						course_entity_ids: ["course:x"],
						source_kind: "transcript",
					},
				},
			]),
		);
		await h.run();
		const worker = h.sends.find(([n]) =>
			n.startsWith("thread_message_"),
		)?.[1] as MessagePayload;
		expect(worker.scheduledCourseContext?.evidenceReadiness).toBe(
			"same_course_evidence",
		);
		expect(worker.resolvedCourseContext?.retrieval.snippets[0]?.text).toBe(
			"scoped meeting",
		);
	});
	test("worker idempotency key is stable per turn and distinct across canonical threads", () => {
		const base = {
			userId: "u",
			agentId: "a",
			conversationId: "c1",
			channelId: "ch",
			messageId: "same",
			platform: "line",
			messageText: "x",
			platformMetadata: {},
			agentOptions: {},
		} as MessagePayload;
		expect(workerMessageSingletonKey(base)).toBe(
			workerMessageSingletonKey({ ...base }),
		);
		expect(workerMessageSingletonKey(base)).not.toBe(
			workerMessageSingletonKey({ ...base, conversationId: "c2" }),
		);
		expect(workerMessageSingletonKey(base)).not.toBe(
			workerMessageSingletonKey({ ...base, platform: "slack" }),
		);
		expect(
			workerMessageSingletonKey({ ...base, organizationId: "org-1" }),
		).not.toBe(workerMessageSingletonKey({ ...base, organizationId: "org-2" }));
	});
	test("terminal key scopes the source turn, agent, and clarification candidates", () => {
		const base = {
			userId: "u",
			agentId: "a",
			organizationId: "org",
			conversationId: "c",
			channelId: "ch",
			messageId: "same",
			platform: "line",
		} as MessagePayload;
		const first = {
			status: "clarification_required",
			candidates: [{ courseKey: "a", displayName: "A" }],
		} as const;
		expect(terminalCourseContextSingletonKey(base, first)).toBe(
			terminalCourseContextSingletonKey({ ...base }, first),
		);
		expect(terminalCourseContextSingletonKey(base, first)).not.toBe(
			terminalCourseContextSingletonKey(base, {
				status: "clarification_required",
				candidates: [{ courseKey: "b", displayName: "B" }],
			}),
		);
		expect(terminalCourseContextSingletonKey(base, first)).not.toBe(
			terminalCourseContextSingletonKey({ ...base, agentId: "other" }, first),
		);
		expect(terminalCourseContextSingletonKey(base, first)).not.toBe(
			terminalCourseContextSingletonKey({ ...base, messageId: "next" }, first),
		);
	});
	test("reviewed personal bypass needs no session and touches neither settings nor Toolbox", async () => {
		const h = setup(
			{},
			"提醒我明天繳電話費",
			{ courseScope: "reviewed" },
			false,
			false,
		);
		const settings = { getSettings: vi.fn() };
		h.consumer.setGuardrails(undefined, settings as never);
		await h.run();
		expect(settings.getSettings).not.toHaveBeenCalled();
		expect(h.fetcher).not.toHaveBeenCalled();
		expect(h.sends.some(([n]) => n.startsWith("thread_message_"))).toBe(true);
	});
	test("reviewed explicit course still requires session persistence", async () => {
		const h = setup({}, "整理課程", { courseScope: "reviewed" }, false, false);
		await expect(h.run()).rejects.toThrow(
			"Course context persistence is not initialized",
		);
		expect(h.sends.some(([n]) => n.startsWith("thread_message_"))).toBe(false);
	});
	test("settings outage does not block personal bypass or explicit keyword gating", async () => {
		const broken = {
			getSettings: vi.fn().mockRejectedValue(new Error("down")),
		};
		const personal = setup({}, "提醒我明天繳電話費", {
			courseScope: "reviewed",
		});
		personal.consumer.setGuardrails(undefined, broken as never);
		await personal.run();
		expect(fetch).not.toHaveBeenCalled();
		expect(personal.sends.some(([n]) => n.startsWith("thread_message_"))).toBe(
			true,
		);
		const course = setup(
			{ status: "missing", reason: "no_courses" },
			"整理課程",
		);
		course.consumer.setGuardrails(undefined, broken as never);
		await course.run();
		expect(course.sends.filter(([n]) => n === "thread_response")).toHaveLength(0);
		expect(course.sends.some(([n]) => n.startsWith("thread_message_"))).toBe(true);
	});
	test("strict malformed ambiguous contract terminalizes and never dispatches worker", async () => {
		const h = setup({
			status: "ambiguous",
			reason: "alias_overlap",
			candidates: [{ courseKey: "x", displayName: "X" }],
		});
		await h.run();
		expect(h.sends.filter(([n]) => n === "thread_response")).toHaveLength(1);
		expect(h.sends.some(([n]) => n.startsWith("thread_message_"))).toBe(false);
	});
	test("valid ambiguity terminalizes while no-courses dispatches onboarding", async () => {
		const ambiguous = setup({
				status: "ambiguous",
				reason: "multiple_active_courses",
				candidates: [
					{
						courseKey: "x",
						courseEntityId: "course:x",
						displayName: "X",
						aliases: [],
						status: "active",
						reasons: [],
					},
				],
			});
		await ambiguous.run();
		expect(ambiguous.sends.filter(([n]) => n === "thread_response")).toHaveLength(1);
		expect(ambiguous.sends.some(([n]) => n.startsWith("thread_message_"))).toBe(false);
		const missing = setup({ status: "missing", reason: "no_courses" });
		await missing.run();
		expect(missing.sends.filter(([n]) => n === "thread_response")).toHaveLength(0);
		expect(missing.sends.some(([n]) => n.startsWith("thread_message_"))).toBe(true);
	});
	test("ready binds before arm and worker send", async () => {
		const h = setup([
			{
				status: "resolved",
				confidence: "high",
				matchedBy: ["single_course_default"],
				course: {
					courseKey: "x",
					courseEntityId: "course:x",
					displayName: "X",
				},
			},
			{
				course: {
					courseKey: "x",
					courseEntityId: "course:x",
					displayName: "X",
				},
				context: {
					contextPackId: "p",
					version: 1,
					stale: false,
					confirmedSummary: "s",
				},
			},
		]);
		await h.run();
		const bind = h.order.indexOf("bind");
		const arm = h.order.findIndex(
			(v, index) => index > bind && v.startsWith("create:"),
		);
		const send = h.order.findIndex((v) => v.startsWith("send:thread_message_"));
		expect(bind).toBeLessThan(arm);
		expect(arm).toBeLessThan(send);
		expect(
			h.sends.filter(([n]) => n.startsWith("thread_message_")),
		).toHaveLength(1);
	});
	test("legacy unscoped course-memory candidates violate hydration and never dispatch", async () => {
		const h = setup([
			{
				status: "resolved",
				confidence: "high",
				matchedBy: ["single_course_default"],
				course: {
					courseKey: "x",
					courseEntityId: "course:x",
					displayName: "X",
				},
			},
			{
				course: {
					courseKey: "x",
					courseEntityId: "course:x",
					displayName: "X",
				},
				context: {
					contextPackId: "p",
					version: 1,
					stale: false,
					confirmedSummary: "canonical summary",
				},
			},
		]);
		h.data.organizationId = "org";
		h.consumer.setCourseMemorySearch(
			vi.fn().mockResolvedValue([
				{
					id: 7,
					payload_text: "legacy-unscoped-text",
					title: "legacy",
					source_url: null,
					organization_id: "org",
					metadata: { agent_id: "a" },
				},
			]),
		);
		await h.run();
		expect(
			h.sends.filter(([name]) => name.startsWith("thread_message_")),
		).toHaveLength(0);
		expect(JSON.stringify(h.sends)).not.toContain("legacy-unscoped-text");
	});
	test("bound course conversation match persists into the dispatched context", async () => {
		const h = setup(
			[
				{
					status: "resolved",
					confidence: "high",
					matchedBy: ["conversation_binding"],
					course: {
						courseKey: "old",
						courseEntityId: "course:old",
						displayName: "Old",
					},
				},
				{
					course: {
						courseKey: "old",
						courseEntityId: "course:old",
						displayName: "Old",
					},
					context: {
						contextPackId: "p",
						version: 1,
						stale: false,
						confirmedSummary: "s",
					},
				},
			],
			"繼續",
		);
		await h.run();
		expect(
			JSON.parse((h.fetcher.mock.calls[0]?.[1] as RequestInit).body as string),
		).toMatchObject({ boundCourseKey: "old" });
		const worker = h.sends.find(([n]) =>
			n.startsWith("thread_message_"),
		)?.[1] as MessagePayload;
		expect(worker.resolvedCourseContext?.resolution.matchedBy).toEqual([
			"conversation_binding",
		]);
		const bind = h.order.indexOf("bind");
		const arm = h.order.findIndex(
			(v, index) => index > bind && v.startsWith("create:"),
		);
		expect(bind).toBeLessThan(arm);
		expect(arm).toBeLessThan(
			h.order.findIndex((v) => v.startsWith("send:thread_message_")),
		);
	});
	test("missing durable receipt migration fails terminal enqueue closed with zero worker dispatch", async () => {
		const h = setup(
			{ status: "missing", reason: "archived_only" },
			"課程",
			{},
			true,
		);
		await expect(h.run()).rejects.toThrow("Failed to process message job");
		expect(h.sends.some(([n]) => n.startsWith("thread_message_"))).toBe(false);
		const terminal = h.sends.find(([name]) => name === "thread_response");
		expect(terminal?.[2]).toMatchObject({
			durableSingleton: true,
			singletonKey: expect.stringMatching(/^course-terminal:/),
		});
	});
	test("selection 1 replays the bounded original task with explicit course key", async () => {
		const ambiguous = {
			status: "ambiguous",
			reason: "multiple_active_courses",
			candidates: [
				{
					courseKey: "x",
					courseEntityId: "course:x",
					displayName: "X",
					aliases: [],
					status: "active",
					reasons: [],
				},
			],
		};
		const resolved = {
			status: "resolved",
			confidence: "high",
			matchedBy: ["explicit_course_key"],
			course: { courseKey: "x", courseEntityId: "course:x", displayName: "X" },
		};
		const h = setup(
			[
				ambiguous,
				resolved,
				{
					course: {
						courseKey: "x",
						courseEntityId: "course:x",
						displayName: "X",
					},
					context: {
						contextPackId: "p",
						version: 1,
						stale: false,
						confirmedSummary: "s",
					},
				},
			],
			"整理課程戰報",
		);
		await h.run();
		await h.run("1");
		expect(
			JSON.parse((h.fetcher.mock.calls[1]?.[1] as RequestInit).body as string),
		).toMatchObject({ explicitCourseKey: "x", message: "整理課程戰報" });
		const worker = h.sends.findLast(([n]) =>
			n.startsWith("thread_message_"),
		)?.[1] as MessagePayload;
		expect(worker.messageText).toBe("整理課程戰報");
	});
	test("send failure keeps claimed original task for retry", async () => {
		const ambiguous = {
			status: "ambiguous",
			reason: "multiple_active_courses",
			candidates: [
				{
					courseKey: "x",
					courseEntityId: "course:x",
					displayName: "X",
					aliases: [],
					status: "active",
					reasons: [],
				},
			],
		};
		const resolved = {
			status: "resolved",
			confidence: "high",
			matchedBy: ["explicit_course_key"],
			course: { courseKey: "x", courseEntityId: "course:x", displayName: "X" },
		};
		const bundle = {
			course: { courseKey: "x", courseEntityId: "course:x", displayName: "X" },
			context: {
				contextPackId: "p",
				version: 1,
				stale: false,
				confirmedSummary: "s",
			},
		};
		const h = setup(
			[ambiguous, resolved, bundle, resolved, bundle],
			"整理課程戰報",
			{},
			false,
			true,
			true,
		);
		await h.run();
		await expect(h.run("1")).rejects.toThrow();
		await h.run("1");
		const attempts = h.sends.filter(([n]) => n.startsWith("thread_message_"));
		expect(attempts).toHaveLength(2);
		expect((attempts[1]?.[1] as MessagePayload).messageText).toBe(
			"整理課程戰報",
		);
	});
	test("cleanup failure recovers without duplicate dispatch", async () => {
		const ambiguous = {
			status: "ambiguous",
			reason: "multiple_active_courses",
			candidates: [
				{
					courseKey: "x",
					courseEntityId: "course:x",
					displayName: "X",
					aliases: [],
					status: "active",
					reasons: [],
				},
			],
		};
		const resolved = {
			status: "resolved",
			confidence: "high",
			matchedBy: ["explicit_course_key"],
			course: { courseKey: "x", courseEntityId: "course:x", displayName: "X" },
		};
		const bundle = {
			course: { courseKey: "x", courseEntityId: "course:x", displayName: "X" },
			context: {
				contextPackId: "p",
				version: 1,
				stale: false,
				confirmedSummary: "s",
			},
		};
		const h = setup(
			[
				ambiguous,
				resolved,
				bundle,
				{ status: "missing", reason: "no_courses" },
			],
			"整理課程戰報",
			{},
			false,
			true,
			false,
			true,
		);
		await h.run();
		await h.run("1");
		await h.run("1");
		expect(
			h.sends.filter(([n]) => n.startsWith("thread_message_")),
		).toHaveLength(1);
		await h.run("整理課程", "m-next");
		expect(
			h.sends.filter(([n]) => n.startsWith("thread_message_")),
		).toHaveLength(2);
		expect(h.sends.filter(([n]) => n === "thread_response")).toHaveLength(1);
	});
});
