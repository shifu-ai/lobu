import { describe, expect, test } from "bun:test";
import type { DbClient } from "../../../../db/client";
import { createPostgresQueueConsumerLeaseStore } from "../queue-consumer-lease";

describe("createPostgresQueueConsumerLeaseStore", () => {
  test("lists required queues with a production-safe text array literal", async () => {
    const sql = (async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      expect(values[0]).toBe('{"messages","thread_response","task"}');
      return rows([
        {
          queue_name: "messages",
          consumer_id: "replica-a",
          lease_instance_id: "lease-a",
          deployment_revision: "a".repeat(40),
          declared_image_digest: `sha256:${"b".repeat(64)}`,
          started_at: new Date("2026-07-15T10:00:00.000Z"),
          last_seen_at: new Date("2026-07-15T10:00:30.000Z"),
          lease_expires_at: new Date("2026-07-15T10:02:00.000Z"),
          identity_conflict: false,
        },
      ]);
    }) as unknown as DbClient;

    const store = createPostgresQueueConsumerLeaseStore(sql);

    await expect(
      store.list(["messages", "thread_response", "task"])
    ).resolves.toEqual([
      expect.objectContaining({
        queueName: "messages",
        consumerId: "replica-a",
        lastSeenAt: "2026-07-15T10:00:30.000Z",
      }),
    ]);
  });
});

function rows<T>(values: T[]) {
  Object.defineProperty(values, "count", { value: values.length });
  return values as T[] & { count: number };
}
