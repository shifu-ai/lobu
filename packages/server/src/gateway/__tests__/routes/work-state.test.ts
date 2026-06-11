import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { generateWorkerToken } from "@lobu/core";
import { TERMINAL_DELIVERY_SEND_OPTS } from "../../infrastructure/queue/types.js";
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
        requireSseOwner: true,
        data: eventBody,
      },
    });
    expect(queueProducer.send.mock.calls[0][2]).toEqual(
      TERMINAL_DELIVERY_SEND_OPTS
    );
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

  test.each([
    [
      "less than three options",
      { options: eventBody.options.slice(0, 2) },
      /exactly 3/i,
    ],
    [
      "no recommended option",
      {
        options: eventBody.options.map((option) => ({
          ...option,
          recommended: false,
        })),
      },
      /exactly one/i,
    ],
    [
      "two recommended options",
      {
        options: eventBody.options.map((option, index) => ({
          ...option,
          recommended: index < 2,
        })),
      },
      /exactly one/i,
    ],
    [
      "recommended option missing recommendation reason",
      {
        options: eventBody.options.map((option, index) => {
          if (index !== 0) return option;
          const { recommendationReason, ...withoutReason } = option;
          void recommendationReason;
          return withoutReason;
        }),
      },
      /recommendation reason/i,
    ],
    [
      "option missing tradeoff",
      {
        options: eventBody.options.map((option, index) =>
          index === 1 ? { ...option, tradeoff: " " } : option
        ),
      },
      /tradeoff/i,
    ],
    [
      "option missing value",
      {
        options: eventBody.options.map((option, index) =>
          index === 1 ? { ...option, value: "" } : option
        ),
      },
      /value/i,
    ],
    [
      "option missing label",
      {
        options: eventBody.options.map((option, index) =>
          index === 1 ? { ...option, label: "" } : option
        ),
      },
      /label/i,
    ],
  ])("rejects %s", async (_label, patch, errorPattern) => {
    const res = await router.request("/internal/work-state/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${workerToken}`,
      },
      body: JSON.stringify({ ...eventBody, ...patch }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: expect.stringMatching(errorPattern),
    });
    expect(queueProducer.send).not.toHaveBeenCalled();
  });
});
