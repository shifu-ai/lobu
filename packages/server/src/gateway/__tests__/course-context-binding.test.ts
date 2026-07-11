import type { MessagePayload } from "@lobu/core";
import { describe, expect, test, vi } from "vitest";
import { ConversationStateStore } from "../connections/conversation-state-store.js";
import { attachCourseContextForReviewedScope } from "../orchestration/course-context-gate.js";
import {
	SessionManager,
	StateAdapterSessionStore,
} from "../services/session-manager.js";
import {
	computeSessionKey,
	type SessionStore,
	type ThreadSession,
} from "../session.js";
import { InMemoryStateAdapter } from "./fixtures/in-memory-state-adapter.js";
import { MessageConsumer } from "../orchestration/message-consumer.js";

function payload(): MessagePayload {
	return {
		userId: "pm-1",
		agentId: "shifu-u-pm-1",
		conversationId: "conv-1",
		channelId: "channel-1",
		messageId: "message-1",
		botId: "bot-1",
		platform: "line",
		messageText: "幫我處理課程",
		agentOptions: {},
		platformMetadata: { courseScope: "reviewed" },
	} as MessagePayload;
}

function fetcher() {
	return vi
		.fn()
		.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					status: "resolved",
					confidence: "high",
					matchedBy: ["single_course_default"],
					course: {
						courseKey: "course-a",
						courseEntityId: "course:pm-1:a",
						displayName: "A",
					},
				}),
				{ status: 200 },
			),
		)
		.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					course: {
						courseKey: "course-a",
						courseEntityId: "course:pm-1:a",
						displayName: "A",
						aliases: [], status: "active",
					},
					profile: { pmRole: null, teacher: null, collaborators: [], audience: null, coursePromise: null, resourceLocations: {} },
					evidence: { confirmed: [], candidates: [] },
					context: {
						agentMd: "summary", confidence: "high", generatedAt: "2026-07-11T00:00:00Z", lastIndexedAt: null,
						contextPackId: "pack-a",
						version: 1,
						stale: false,
					},
				}),
				{ status: 200 },
			),
		);
}

describe("course context binding", () => {
  test("blocks reviewed-scope dispatch until the shared session manager is wired", async () => {
    const queue = { createQueue: vi.fn(), send: vi.fn() };
    const consumer = new MessageConsumer({ queues: { expireInSeconds: 1, retryLimit: 1 } } as never, {} as never, queue as never);
    await expect((consumer as unknown as { dispatchCourseContextBoundary(data: MessagePayload, deployment: string): Promise<void> })
      .dispatchCourseContextBoundary(payload(), "deployment"))
      .rejects.toThrow("Course context persistence is not initialized");
    expect(queue.send).not.toHaveBeenCalled();
  });

	test("persists a high-confidence resolved course in the shared thread session", async () => {
		const adapter = new InMemoryStateAdapter();
		const manager = new SessionManager(
			new StateAdapterSessionStore(new ConversationStateStore(adapter)),
		);
		const data = payload();
		const session: ThreadSession = {
			conversationId: data.conversationId,
			channelId: data.channelId,
			userId: data.userId,
			createdAt: 1,
			lastActivity: 2,
			status: "running",
		};
		await manager.setSession(session);

		const result = await attachCourseContextForReviewedScope(data, {
			baseUrl: "https://toolbox.test",
			secret: "secret",
			fetcher: fetcher(),
			sessionManager: manager,
			sessionKey: computeSessionKey(session),
		});

		expect(result).toMatchObject({ status: "ready", bindingStatus: { status: "persisted" } });
		const replica = new SessionManager(
			new StateAdapterSessionStore(new ConversationStateStore(adapter)),
		);
		expect(
			(await replica.getSession(computeSessionKey(session)))
				?.shifuCourseContext,
		).toMatchObject({
			courseKey: "course-a",
			courseEntityId: "course:pm-1:a",
			source: "resolver",
			contextPackId: "pack-a",
		});
	});

	test("reports a typed write failure while retaining resolved context for the current turn", async () => {
		const existing: ThreadSession = {
			conversationId: "conv-1",
			channelId: "channel-1",
			userId: "pm-1",
			createdAt: 1,
			lastActivity: 2,
		};
		const failingStore: SessionStore = {
			get: async () => existing,
			set: async () => {
				throw new Error("state unavailable");
			},
			mutate: async () => {
				throw new Error("state unavailable");
			},
			delete: async () => {},
			getByThread: async () => existing,
		};
		const data = payload();
		const result = await attachCourseContextForReviewedScope(data, {
			baseUrl: "https://toolbox.test",
			secret: "secret",
			fetcher: fetcher(),
			sessionManager: new SessionManager(failingStore),
			sessionKey: "channel-1:conv-1",
		});

		expect(result).toMatchObject({ status: "ready", bindingStatus: { status: "binding_write_failed", code: "binding_write_failed" } });
		expect(data.resolvedCourseContext?.course.courseKey).toBe("course-a");
		expect(data.platformMetadata.courseContextBinding).toEqual({
			status: "binding_write_failed",
			code: "binding_write_failed",
		});
	});
});
