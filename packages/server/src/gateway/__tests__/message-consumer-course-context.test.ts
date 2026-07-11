import type { MessagePayload } from "@lobu/core";
import { afterEach, describe, expect, test, vi } from "vitest";
import { MessageConsumer } from "../orchestration/message-consumer.js";

function payload(text = "幫我處理課程"): MessagePayload {
	return {
		userId: "pm-1",
		agentId: "agent-1",
		conversationId: "conv-1",
		channelId: "line-1",
		messageId: "msg-1",
		botId: "bot",
		platform: "line",
		messageText: text,
		platformMetadata: {},
		agentOptions: {},
	} as MessagePayload;
}

function harness(response: unknown, terminalFailure = false) {
	let handler:
		| ((job: { id: string; data: MessagePayload }) => Promise<void>)
		| undefined;
	const sends: Array<[string, unknown, unknown]> = [];
	const queue = {
		start: vi.fn(),
		stop: vi.fn(),
		createQueue: vi.fn(),
		work: vi.fn(async (_name, callback) => {
			handler = callback;
		}),
		send: vi.fn(async (name, data, options) => {
			sends.push([name, data, options]);
			if (terminalFailure && name === "thread_response")
				throw new Error("delivery failed");
			return "job";
		}),
		getQueueStats: vi.fn(),
		isHealthy: vi.fn(),
		pauseWorker: vi.fn(),
		resumeWorker: vi.fn(),
	};
	const deployments = {
		listDeployments: vi
			.fn()
			.mockResolvedValue([{ deploymentName: "irrelevant" }]),
	};
	const consumer = new MessageConsumer(
		{ queues: { expireInSeconds: 1, retryLimit: 1 } } as never,
		deployments as never,
		queue as never,
	);
	consumer.setSessionManager({
		getSession: vi.fn().mockResolvedValue(null),
		bindActiveCourse: vi.fn().mockResolvedValue({ status: "persisted" }),
	} as never);
	process.env.TOOLBOX_COURSE_CONTEXT_URL = "https://toolbox.test";
	process.env.TOOLBOX_INTERNAL_SECRET = "secret";
	const responses = Array.isArray(response) ? response : [response];
	const fetcher = vi.fn();
	for (const body of responses) {
		fetcher.mockResolvedValueOnce(
			new Response(JSON.stringify(body), { status: 200 }),
		);
	}
	globalThis.fetch = fetcher as never;
	return {
		consumer,
		queue,
		sends,
		run: async (data = payload()) => {
			await consumer.start();
			return handler?.({ id: "legacy-job", data });
		},
	};
}

const originalFetch = globalThis.fetch;
afterEach(() => {
	delete process.env.TOOLBOX_COURSE_CONTEXT_URL;
	delete process.env.TOOLBOX_INTERNAL_SECRET;
	globalThis.fetch = originalFetch;
});

describe("MessageConsumer course context boundary", () => {
	test("ambiguous response sends one ordered terminal clarification and no worker job", async () => {
		const h = harness({
			status: "ambiguous",
			reason: "multiple",
			candidates: [
				{ courseKey: "z", displayName: "Z 課" },
				{ courseKey: "a", displayName: "A 課" },
			],
		});
		await h.run();
		expect(
			h.sends.filter(([name]) => name.startsWith("thread_message_")),
		).toHaveLength(0);
		expect(h.sends).toHaveLength(1);
		expect(h.sends[0]?.[1]).toMatchObject({
			finalText: "請選擇這次要處理的課程：\n1. Z 課\n2. A 課",
		});
	});

	test.each([
		[{ status: "missing", reason: "no_courses" }, "目前還沒有可用的課程資料"],
		[{ nope: true }, "目前無法取得課程資料"],
	])("terminalizes missing/unavailable without worker dispatch", async (response, text) => {
		const h = harness(response);
		await h.run();
		expect(h.sends.some(([name]) => name.startsWith("thread_message_"))).toBe(
			false,
		);
		expect((h.sends[0]?.[1] as { finalText: string }).finalText).toContain(
			text,
		);
	});

	test("personal reminders bypass Toolbox and reach the worker", async () => {
		const h = harness({});
		await h.run(payload("提醒我明天繳電話費"));
		expect(fetch).not.toHaveBeenCalled();
		expect(h.sends.some(([name]) => name.startsWith("thread_message_"))).toBe(
			true,
		);
	});

	test("ready context is bound, armed, then dispatched exactly once", async () => {
		const h = harness([
			{
				status: "resolved",
				confidence: "high",
				matchedBy: ["single_course_default"],
				course: {
					courseKey: "a",
					courseEntityId: "course:a",
					displayName: "A 課",
				},
			},
			{
				course: {
					courseKey: "a",
					courseEntityId: "course:a",
					displayName: "A 課",
				},
				context: {
					contextPackId: "pack-a",
					version: 1,
					stale: false,
					confirmedSummary: "摘要",
				},
			},
		]);
		await h.run();
		const workerSends = h.sends.filter(([name]) =>
			name.startsWith("thread_message_"),
		);
		expect(workerSends).toHaveLength(1);
		expect(h.sends.filter(([name]) => name === "thread_response")).toHaveLength(
			0,
		);
		expect(
			(workerSends[0]?.[1] as MessagePayload).resolvedCourseContext?.course
				.courseKey,
		).toBe("a");
	});

	test("terminal delivery failure propagates and never falls through", async () => {
		const h = harness({ status: "missing", reason: "no_courses" }, true);
		await expect(h.run()).rejects.toThrow("Failed to process message job");
		expect(h.sends.some(([name]) => name.startsWith("thread_message_"))).toBe(
			false,
		);
	});
});
