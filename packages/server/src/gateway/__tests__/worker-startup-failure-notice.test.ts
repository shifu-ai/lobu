import { beforeAll, describe, expect, mock, test } from "bun:test";

import { MessageConsumer } from "../orchestration/message-consumer.js";
import { UnifiedThreadResponseConsumer } from "../platform/unified-thread-consumer.js";

// `new RunsQueue()` (built inside the MessageConsumer constructor) only guards
// on DATABASE_URL being present — it does not connect. We immediately replace
// the queue with a recording fake before exercising any method, so no Postgres
// is touched.
beforeAll(() => {
  process.env.DATABASE_URL ||= "postgres://test/test";
});

const apiPayloadBase = {
  messageId: "m1",
  channelId: "api_u1",
  conversationId: "conv-1",
  userId: "u1",
  teamId: "api",
  platform: "api",
  timestamp: 0,
  // Direct-API sessions carry no `sessionId` in platformMetadata, so the
  // consumer's cli-session broadcasts are skipped and every SSE event comes
  // from the renderer keyed on `conversationId`.
  platformMetadata: {},
};

function createApiConsumer() {
  const queue = {
    start: mock(async () => undefined),
    stop: mock(async () => undefined),
    createQueue: mock(async () => undefined),
    work: mock(async () => undefined),
  };
  const renderer = {
    handleDelta: mock(async () => "m1"),
    handleError: mock(async () => undefined),
    handleCompletion: mock(async () => undefined),
    handleEphemeral: mock(async () => undefined),
    handleStatusUpdate: mock(async () => undefined),
  };
  const platformRegistry = {
    get: mock(() => ({ getResponseRenderer: () => renderer })),
  };
  const sseManager = { broadcast: mock(() => undefined) };
  const consumer = new UnifiedThreadResponseConsumer(
    queue as any,
    platformRegistry as any,
    sseManager as any
  ) as any;
  return { consumer, renderer, sseManager };
}

describe("worker-startup-failure notice reaches direct-API clients (lobu-ai/lobu#946)", () => {
  test("producer emits the failure notice via `error`, not the ephemeral-only `content` field", async () => {
    const consumer = new MessageConsumer({} as any, {} as any) as any;
    const sends: Array<{ queue: string; data: Record<string, unknown> }> = [];
    consumer.queue = {
      createQueue: mock(async () => undefined),
      send: mock(async (queue: string, data: Record<string, unknown>) => {
        sends.push({ queue, data });
      }),
    };

    await consumer.trackFailedDeployment(
      "deploy-1",
      {
        messageId: "m1",
        userId: "u1",
        channelId: "api_u1",
        conversationId: "conv-1",
        platform: "api",
        platformMetadata: {},
      },
      new Error("spawn ENOENT")
    );

    const notice = sends.find((s) => s.queue === "thread_response");
    expect(notice).toBeDefined();
    // The fix: the notice rides the `error` field (rendered end-to-end), not
    // `content` (only the ephemeral branch renders content -> silently dropped).
    expect(notice?.data.error).toMatch(/Worker startup failed/);
    expect(notice?.data.content).toBeUndefined();
    expect(notice?.data.processedMessageIds).toEqual(["m1"]);
  });

  test("an `error` notice is surfaced to the API renderer (handleError + completion)", async () => {
    const { consumer, renderer } = createApiConsumer();

    await consumer.handleThreadResponse({
      id: "job-err",
      data: {
        ...apiPayloadBase,
        error: "Worker startup failed and your request could not be processed.",
        processedMessageIds: ["m1"],
      },
    });

    expect(renderer.handleError).toHaveBeenCalledTimes(1);
    expect(renderer.handleCompletion).toHaveBeenCalledTimes(1);
  });

  test("a non-ephemeral `content` notice is dropped — only completion fires (the original bug)", async () => {
    const { consumer, renderer } = createApiConsumer();

    await consumer.handleThreadResponse({
      id: "job-content",
      data: {
        ...apiPayloadBase,
        // The pre-fix shape: a human-readable message in `content` with no
        // `ephemeral` flag. Nothing renders it; the user only sees `complete`.
        content: "Worker startup failed and your request could not be processed.",
        processedMessageIds: ["m1"],
      },
    });

    expect(renderer.handleError).not.toHaveBeenCalled();
    expect(renderer.handleDelta).not.toHaveBeenCalled();
    expect(renderer.handleEphemeral).not.toHaveBeenCalled();
    // Completion still fires (this is why the gateway returns a bare `complete`).
    expect(renderer.handleCompletion).toHaveBeenCalledTimes(1);
  });
});
