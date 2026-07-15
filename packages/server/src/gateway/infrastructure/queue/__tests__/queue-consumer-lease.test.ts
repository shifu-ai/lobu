import { describe, expect, it } from "vitest";
import { recordQueueConsumerHeartbeat } from "../queue-consumer-lease";

describe("queue consumer durable heartbeat", () => {
	it("upserts a bounded lease and preserves a conflict when identity changes", async () => {
		const queries: string[] = [];
		const values: unknown[][] = [];
		const sql = ((strings: TemplateStringsArray, ...parameters: unknown[]) => {
			queries.push(strings.join("?"));
			values.push(parameters);
			return Promise.resolve([]);
		}) as never;

		await recordQueueConsumerHeartbeat(sql, {
			queueName: "messages",
			consumerId: "gateway-1",
			deploymentRevision: "rev-1",
			declaredImageDigest: `sha256:${"a".repeat(64)}`,
			startedAt: new Date("2026-07-15T09:00:00.000Z"),
			now: new Date("2026-07-15T10:00:00.000Z"),
		});

		expect(queries.join("\n")).toContain(
			"ON CONFLICT (queue_name, consumer_id) DO UPDATE",
		);
		expect(queries.join("\n")).toContain(
			"identity_conflict = queue_consumer_leases.identity_conflict OR",
		);
		expect(values[0]).toEqual(
			expect.arrayContaining(["messages", "gateway-1", "rev-1"]),
		);
	});
});
