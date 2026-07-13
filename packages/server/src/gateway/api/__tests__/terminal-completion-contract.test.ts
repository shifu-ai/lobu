import { describe, expect, mock, test } from "bun:test";
import type {
	IMessageQueue,
	QueueJob,
	ThreadResponsePayload,
} from "../../infrastructure/queue/types.js";
import { UnifiedThreadResponseConsumer } from "../../platform/unified-thread-consumer.js";
import { type PlatformAdapter, PlatformRegistry } from "../../platform.js";
import { SseManager } from "../../services/sse-manager.js";

mock.module("../../../watchers/run-completion.js", () => ({
	resolveWatcherRunsByMessageIds: async () => ({ resolved: 0 }),
}));

const { ApiResponseRenderer } = await import("../response-renderer.js");

describe("API terminal completion contract", () => {
	test("broadcasts one completion with the worker's authoritative final text", async () => {
		const sseManager = new SseManager();
		sseManager.addConnection("conversation-1", {});

		const renderer = new ApiResponseRenderer(sseManager);
		const platformRegistry = new PlatformRegistry();
		const platform = {
			name: "api",
			initialize: async () => undefined,
			start: async () => undefined,
			stop: async () => undefined,
			isHealthy: () => true,
			getResponseRenderer: () => renderer,
		} satisfies PlatformAdapter;
		platformRegistry.register(platform);

		const consumer = new UnifiedThreadResponseConsumer(
			{} as IMessageQueue,
			platformRegistry,
			sseManager,
		);
		const payload: ThreadResponsePayload = {
			platform: "api",
			teamId: "api",
			messageId: "message-1",
			channelId: "conversation-1",
			conversationId: "conversation-1",
			userId: "user-1",
			processedMessageIds: ["message-1"],
			finalText: "請選擇這次要處理的課程",
			timestamp: 1000,
			platformMetadata: { sessionId: "conversation-1" },
		};

		const handleThreadResponse = Reflect.get(
			consumer,
			"handleThreadResponse",
		) as (job: QueueJob<ThreadResponsePayload>) => Promise<void>;
		await handleThreadResponse.call(consumer, { id: "job-1", data: payload });

		const completions = sseManager
			.getRecentEvents("conversation-1")
			.filter((event) => event.event === "complete");
		expect(completions).toHaveLength(1);
		expect(completions[0]?.data).toEqual({
			type: "complete",
			messageId: "message-1",
			processedMessageIds: ["message-1"],
			finalText: "請選擇這次要處理的課程",
			timestamp: 1000,
		});
	});
});
