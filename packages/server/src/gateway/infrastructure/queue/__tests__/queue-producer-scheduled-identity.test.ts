import { describe, expect, mock, test } from "bun:test";
import type { MessagePayload } from "@lobu/core";
import { QueueProducer } from "../queue-producer";
import type { IMessageQueue } from "../types";

describe("QueueProducer scheduled identity", () => {
	test("forwards the same durable singleton to the runs queue across crash retries", async () => {
		const send = mock(async () => "run-1");
		const queue = {
			createQueue: mock(async () => {}),
			send,
			isHealthy: () => true,
		} as unknown as IMessageQueue;
		const producer = new QueueProducer(queue);
		await producer.start();
		const payload = {
			userId: "user-1",
			conversationId: "thread-1",
			messageId: "scheduled-job-1-run-42",
			channelId: "scheduled",
			agentId: "agent-1",
			organizationId: "org-1",
			botId: "lobu-api",
			platform: "api",
			messageText: "coach",
			platformMetadata: {},
			agentOptions: {},
		} satisfies MessagePayload;
		const options = {
			singletonKey: "scheduled-job-1-run-42",
			durableSingleton: true,
		};

		await producer.enqueueMessage(payload, options);
		await producer.enqueueMessage(payload, options);

		expect(send.mock.calls.map((call) => call[2])).toEqual([
			expect.objectContaining({
				singletonKey: "scheduled-job-1-run-42",
				durableSingleton: true,
			}),
			expect.objectContaining({
				singletonKey: "scheduled-job-1-run-42",
				durableSingleton: true,
			}),
		]);
	});
});
