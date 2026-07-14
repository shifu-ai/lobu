import { expect, mock, test } from "bun:test";
import { UnifiedThreadResponseConsumer } from "../platform/unified-thread-consumer.js";
import { enqueueAgentMessage } from "../services/agent-threads.js";

const scheduledPersonalReminder = {
	schemaVersion: 1 as const,
	contractVersion: "personal_reminder_delivery.v1" as const,
	source: "personal_scheduled_reminder" as const,
	toolboxUserId: "owner-1",
	lobuAgentId: "agent-1",
	conversationId: "conversation-1",
	reminderContent: "回覆客戶",
	jobId: "job-1",
	runId: 42,
};

test("replica-independent terminal wake delivery uses durable routing metadata and no SSE owner", async () => {
	const replicaAProducer = mock(async () => "worker-run-1");
	const replicaBSessionManager = {
		getSession: mock(async () => ({
			userId: "owner-1",
			agentId: "agent-1",
			organizationId: "org-1",
			conversationId: "conversation-1",
			channelId: "api_owner-1",
			dryRun: false,
		})),
		touchSession: mock(async () => undefined),
	};

	await enqueueAgentMessage(
		{
			sessionManager: replicaBSessionManager as never,
			queueProducer: { enqueueMessage: replicaAProducer } as never,
		},
		{
			threadId: "conversation-1",
			messageText: "wake",
			source: "scheduled-job",
			scheduledPersonalReminder,
		},
	);

	const routing = (
		replicaAProducer.mock.calls[0]?.[0] as unknown as {
			platformMetadata: Record<string, unknown>;
		}
	).platformMetadata;
	expect(routing.scheduledPersonalReminder).toEqual(scheduledPersonalReminder);
	expect(JSON.stringify(routing)).not.toContain("lineUserId");

	const callbackAttempts: unknown[] = [];
	const mechanicalDelivery = mock(async (input: unknown) => {
		callbackAttempts.push(input);
		if (callbackAttempts.length === 1)
			throw new Error("personal_reminder_delivery_retrying");
	});
	const replicaCNoSseManager = { hasActiveConnection: mock(() => false) };
	const consumer = new UnifiedThreadResponseConsumer(
		{} as never,
		{} as never,
		replicaCNoSseManager as never,
		undefined,
		mechanicalDelivery as never,
	) as unknown as {
		handleThreadResponse(job: { id: string; data: unknown }): Promise<void>;
	};
	const terminal = {
		messageId: "turn-1",
		channelId: "scheduled",
		conversationId: "conversation-1",
		userId: "owner-1",
		teamId: "api",
		platform: "api",
		timestamp: 1_789_000_000_000,
		processedMessageIds: ["turn-1"],
		finalText: "記得回覆客戶",
		platformMetadata: routing,
	};

	await expect(
		consumer.handleThreadResponse({ id: "terminal-run", data: terminal }),
	).rejects.toThrow("personal_reminder_delivery_retrying");
	await consumer.handleThreadResponse({ id: "terminal-run", data: terminal });

	expect(replicaAProducer).toHaveBeenCalledTimes(1);
	expect(mechanicalDelivery).toHaveBeenCalledTimes(2);
	expect(callbackAttempts[0]).toEqual(callbackAttempts[1]);
	expect(replicaCNoSseManager.hasActiveConnection).not.toHaveBeenCalled();
});
