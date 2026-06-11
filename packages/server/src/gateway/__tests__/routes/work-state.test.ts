import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { generateWorkerToken } from "@lobu/core";
import { createWorkStateRoutes } from "../../routes/internal/work-state.js";

describe("work-state routes", () => {
  let originalKey: string | undefined;
  let workerToken: string;
  let queueProducer: { send: ReturnType<typeof mock> };
  let router: ReturnType<typeof createWorkStateRoutes>;

  const eventBody = {
    type: "human_input.requested",
    version: 1,
    eventId: "decision-1",
    agentId: "agent-1",
    conversationId: "conv-1",
    channel: "line",
    title: "Blocked",
    prompt: "Choose how to recover.",
    allowCustomResponse: true,
    options: [
      {
        value: "retry",
        label: "Retry",
        tradeoff: "May take longer.",
        recommended: true,
        recommendationReason: "Most likely to work.",
      },
      {
        value: "skip",
        label: "Skip",
        tradeoff: "Leaves this incomplete.",
      },
      {
        value: "manual",
        label: "Manual help",
        tradeoff: "Needs user effort.",
      },
    ],
    createdAt: "2026-06-11T00:00:00.000Z",
  };

  beforeEach(() => {
    originalKey = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    workerToken = generateWorkerToken("user-1", "conv-1", "deploy-1", {
      agentId: "agent-1",
      channelId: "line:U1",
      teamId: "team-1",
      platform: "line",
    });

    queueProducer = {
      send: mock(async () => "run-1"),
    };
    router = createWorkStateRoutes(queueProducer as any);
  });

  afterEach(() => {
    if (originalKey !== undefined) {
      process.env.ENCRYPTION_KEY = originalKey;
    } else {
      delete process.env.ENCRYPTION_KEY;
    }
  });

  test("returns 401 without worker auth", async () => {
    const res = await router.request("/internal/work-state/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(eventBody),
    });
    expect(res.status).toBe(401);
  });

  test("enqueues a shifu.work_state customEvent on thread_response", async () => {
    const res = await router.request("/internal/work-state/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${workerToken}`,
      },
      body: JSON.stringify(eventBody),
    });

    expect(res.status).toBe(200);
    expect(queueProducer.send).toHaveBeenCalledTimes(1);
    expect(queueProducer.send.mock.calls[0][0]).toBe("thread_response");
    expect(queueProducer.send.mock.calls[0][1]).toMatchObject({
      messageId: "decision-1",
      conversationId: "conv-1",
      channelId: "line:U1",
      teamId: "team-1",
      platform: "line",
      customEvent: {
        name: "shifu.work_state",
        data: eventBody,
      },
    });
  });

  test("rejects malformed work-state events", async () => {
    const res = await router.request("/internal/work-state/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${workerToken}`,
      },
      body: JSON.stringify({ ...eventBody, type: "assistant.text" }),
    });

    expect(res.status).toBe(400);
    expect(queueProducer.send).not.toHaveBeenCalled();
  });
});
