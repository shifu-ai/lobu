import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  deliverCourseWakeCompletion,
  readCourseWakeDeliveryMetadata,
} from "../course-wake-delivery.js";

const metadata = {
  schemaVersion: 1 as const,
  source: "calendar_scheduled_wake" as const,
  automationId: "auto-1",
  jobId: "job-1",
  runId: 42,
  toolboxUserId: "owner-1",
  lobuAgentId: "agent-1",
};

afterEach(() => {
  delete process.env.TOOLBOX_TURN_COMPLETED_URL;
  delete process.env.TOOLBOX_INTERNAL_SECRET;
});

describe("course wake mechanical completion delivery", () => {
  test("parses only bounded trusted scheduled metadata and never accepts a LINE id", () => {
    expect(readCourseWakeDeliveryMetadata({ scheduledCourseWake: metadata })).toEqual(metadata);
    expect(readCourseWakeDeliveryMetadata({ scheduledCourseWake: { ...metadata, lineUserId: "U-secret" } })).toBeNull();
    expect(readCourseWakeDeliveryMetadata({ scheduledCourseWake: { ...metadata, source: "user" } })).toBeNull();
  });

  test("posts stored final output and trace identifiers without a LINE user id", async () => {
    process.env.TOOLBOX_TURN_COMPLETED_URL = "https://toolbox.test/agent-workbench/internal/turn-completed";
    process.env.TOOLBOX_INTERNAL_SECRET = "secret";
    const fetchFn = mock(async () => new Response(JSON.stringify({ ok: true, status: "delivered" }), { status: 202 }));

    await deliverCourseWakeCompletion({
      metadata, completion: { kind: "succeeded", finalOutput: "final answer" }, turnId: "turn-1",
    }, { fetchFn });

    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://toolbox.test/agent-workbench/internal/turn-completed");
    expect(init.headers).toEqual(expect.objectContaining({ "x-internal-secret": "secret" }));
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      ...metadata, completionKind: "succeeded", finalOutput: "final answer", turnId: "turn-1",
    });
    expect(JSON.stringify(body)).not.toContain("lineUserId");
  });

  test("throws on retryable Toolbox delivery so only the terminal PG row retries", async () => {
    process.env.TOOLBOX_TURN_COMPLETED_URL = "https://toolbox.test/turn-completed";
    process.env.TOOLBOX_INTERNAL_SECRET = "secret";
    const fetchFn = mock(async () => new Response(JSON.stringify({ status: "retrying" }), { status: 503 }));
    await expect(deliverCourseWakeCompletion(
      { metadata, completion: { kind: "succeeded", finalOutput: "stored output" }, turnId: "turn-1" }, { fetchFn },
    )).rejects.toThrow("course_wake_delivery_retrying");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  test.each(["delivery_blocked_unbound", "failed"])("accepts terminal projection status %s", async (status) => {
    process.env.TOOLBOX_TURN_COMPLETED_URL = "https://toolbox.test/turn-completed";
    process.env.TOOLBOX_INTERNAL_SECRET = "secret";
    const fetchFn = mock(async () => new Response(JSON.stringify({ ok: true, status }), { status: 202 }));
    await deliverCourseWakeCompletion({
      metadata, completion: { kind: "succeeded", finalOutput: "stored output" }, turnId: "turn-1",
    }, { fetchFn });
  });

  test("posts a bounded failure kind without worker error or unsafe final text", async () => {
    process.env.TOOLBOX_TURN_COMPLETED_URL = "https://toolbox.test/turn-completed";
    process.env.TOOLBOX_INTERNAL_SECRET = "secret";
    const fetchFn = mock(async () => new Response(JSON.stringify({ ok: true, status: "failed" }), { status: 202 }));
    await deliverCourseWakeCompletion({
      metadata, completion: { kind: "failed", failureCode: "generation_failed" }, turnId: "turn-1",
    }, { fetchFn });
    const body = JSON.parse(String((fetchFn.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body).toMatchObject({ completionKind: "failed", failureCode: "generation_failed" });
    expect(body).not.toHaveProperty("finalOutput");
    expect(JSON.stringify(body)).not.toContain("provider secret failure detail");
  });
});
