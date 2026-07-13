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

function terminalPayload(
	overrides: Partial<ThreadResponsePayload> = {},
): ThreadResponsePayload {
	return {
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
		...overrides,
	};
}

async function renderTerminalPayload(payload: ThreadResponsePayload) {
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
	const handleThreadResponse = Reflect.get(
		consumer,
		"handleThreadResponse",
	) as (job: QueueJob<ThreadResponsePayload>) => Promise<void>;
	await handleThreadResponse.call(consumer, { id: "job-1", data: payload });

	return sseManager.getRecentEvents("conversation-1");
}

describe("API terminal completion contract", () => {
	test("broadcasts one completion with the worker's authoritative final text", async () => {
		const completions = (await renderTerminalPayload(terminalPayload()))
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

	test("broadcasts one error pair and one completion for a terminal error", async () => {
		const events = await renderTerminalPayload(
			terminalPayload({ finalText: undefined, error: "provider unavailable" }),
		);

		expect(events.filter((event) => event.event === "error")).toHaveLength(1);
		expect(events.filter((event) => event.event === "agent-error")).toHaveLength(
			1,
		);
		const completions = events.filter((event) => event.event === "complete");
		expect(completions).toHaveLength(1);
		expect(completions[0]?.data).toEqual({
			type: "complete",
			messageId: "message-1",
			processedMessageIds: ["message-1"],
			finalText: undefined,
			timestamp: 1000,
		});
	});

	test("preserves an explicit undefined finalText from an older worker", async () => {
		const completions = (
			await renderTerminalPayload(terminalPayload({ finalText: undefined }))
		).filter((event) => event.event === "complete");

		expect(completions).toHaveLength(1);
		expect(Object.hasOwn(completions[0]?.data ?? {}, "finalText")).toBe(true);
		expect(completions[0]?.data.finalText).toBeUndefined();
	});
});
