import { beforeAll, describe, expect, mock, test } from "bun:test";

import { ApiResponseRenderer } from "../api/response-renderer.js";
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
    handleContent: mock(async () => undefined),
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

  test("a non-ephemeral `content` notice is surfaced via handleContent, then completes (scalable router fix)", async () => {
    const { consumer, renderer, sseManager } = createApiConsumer();

    await consumer.handleThreadResponse({
      id: "job-content",
      data: {
        ...apiPayloadBase,
        // A human-readable message in `content` with no `ephemeral` flag.
        // Pre-fix this was dropped (only `complete` fired); now the router
        // renders it through handleContent so no notice silently vanishes.
        content: "A buffered, non-streamed notice for the user.",
        processedMessageIds: ["m1"],
      },
    });

    expect(renderer.handleContent).toHaveBeenCalledTimes(1);
    // Falls through to completion so the turn still terminates.
    expect(renderer.handleCompletion).toHaveBeenCalledTimes(1);
    // Not misrouted as a stream chunk, ephemeral, or error.
    expect(renderer.handleDelta).not.toHaveBeenCalled();
    expect(renderer.handleEphemeral).not.toHaveBeenCalled();
    expect(renderer.handleError).not.toHaveBeenCalled();
    void sseManager;
  });

  test("an `ephemeral` content payload still routes to handleEphemeral, not handleContent", async () => {
    const { consumer, renderer } = createApiConsumer();

    await consumer.handleThreadResponse({
      id: "job-ephemeral",
      data: {
        ...apiPayloadBase,
        ephemeral: true,
        content: "Visit https://example.com to authorize.",
      },
    });

    expect(renderer.handleEphemeral).toHaveBeenCalledTimes(1);
    expect(renderer.handleContent).not.toHaveBeenCalled();
  });

  // Real renderer (no mock for the rendering step): confirm the actual SSE
  // event `lobu chat` parses is emitted. The CLI's `output` case reads
  // `data.content` (chat.ts), so the wire shape matters.
  test("real ApiResponseRenderer.handleContent emits an `output` SSE event the CLI renders", async () => {
    const broadcasts: Array<{ session: string; event: string; data: any }> = [];
    const sseManager = {
      broadcast: (session: string, event: string, data: unknown) => {
        broadcasts.push({ session, event, data });
      },
    };
    const renderer = new ApiResponseRenderer(sseManager as any);

    await renderer.handleContent(
      {
        ...apiPayloadBase,
        content: "Worker startup failed and your request could not be processed.",
      } as any,
      "u1:m1"
    );

    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]?.event).toBe("output");
    expect(broadcasts[0]?.session).toBe("conv-1");
    expect(broadcasts[0]?.data).toMatchObject({
      type: "delta",
      content: "Worker startup failed and your request could not be processed.",
      messageId: "m1",
    });
  });
});
