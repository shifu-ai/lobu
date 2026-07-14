import { afterEach, describe, expect, mock, test } from "bun:test";
import {
	deliverPersonalReminderCompletion,
	readPersonalReminderDeliveryMetadata,
} from "../personal-reminder-delivery.js";

const metadata = {
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

afterEach(() => {
	delete process.env.TOOLBOX_TURN_COMPLETED_URL;
	delete process.env.TOOLBOX_INTERNAL_SECRET;
});

describe("personal reminder mechanical completion delivery", () => {
	test("parses only bounded trusted metadata without LINE identity", () => {
		expect(
			readPersonalReminderDeliveryMetadata({
				scheduledPersonalReminder: metadata,
			}),
		).toEqual(metadata);
		expect(
			readPersonalReminderDeliveryMetadata({
				scheduledPersonalReminder: { ...metadata, lineUserId: "U-secret" },
			}),
		).toBeNull();
		expect(
			readPersonalReminderDeliveryMetadata({
				scheduledPersonalReminder: {
					...metadata,
					conversationId: "x".repeat(513),
				},
			}),
		).toBeNull();
	});

	test("posts stable bounded completion identifiers with server secret", async () => {
		process.env.TOOLBOX_TURN_COMPLETED_URL =
			"https://toolbox.test/turn-completed";
		process.env.TOOLBOX_INTERNAL_SECRET = "secret";
		const fetchFn = mock(
			async () =>
				new Response(JSON.stringify({ ok: true, status: "delivered" }), {
					status: 202,
				}),
		);
		await deliverPersonalReminderCompletion(
			{
				metadata,
				completion: { kind: "succeeded", finalOutput: "記得回覆客戶" },
				turnId: "turn-1",
				occurredAt: "2026-07-14T13:00:00.000Z",
			},
			{ fetchFn },
		);

		const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
		expect(init.headers).toEqual(
			expect.objectContaining({ "x-internal-secret": "secret" }),
		);
		const body = JSON.parse(String(init.body));
		expect(body).toMatchObject({
			...metadata,
			turnId: "turn-1",
			occurredAt: "2026-07-14T13:00:00.000Z",
			completionStatus: "succeeded",
			finalOutput: "記得回覆客戶",
		});
		expect(JSON.stringify(body)).not.toContain("lineUserId");
	});

	test("rethrows retryable projection response for the terminal PG row", async () => {
		process.env.TOOLBOX_TURN_COMPLETED_URL =
			"https://toolbox.test/turn-completed";
		process.env.TOOLBOX_INTERNAL_SECRET = "secret";
		const fetchFn = mock(
			async () =>
				new Response(JSON.stringify({ status: "retrying" }), { status: 503 }),
		);
		await expect(
			deliverPersonalReminderCompletion(
				{
					metadata,
					completion: { kind: "failed", error: "agent_generation_failed" },
					turnId: "turn-1",
					occurredAt: "2026-07-14T13:00:00.000Z",
				},
				{ fetchFn },
			),
		).rejects.toThrow("personal_reminder_delivery_retrying");
	});
});
