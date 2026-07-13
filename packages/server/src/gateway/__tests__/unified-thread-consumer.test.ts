import { describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { ApiPlatform } from "../api/platform.js";
import { UnifiedThreadResponseConsumer } from "../platform/unified-thread-consumer.js";

const basePayload = {
  messageId: "m1",
  channelId: "telegram:123",
  conversationId: "telegram:123",
  userId: "u1",
  teamId: "telegram",
  timestamp: 0,
  platform: "telegram",
  processedMessageIds: ["m1"],
  platformMetadata: {
    connectionId: "marketing-telegram",
  },
};

function createConsumer(overrides?: {
  chatResponseBridge?: unknown;
  renderer?: unknown;
  courseWakeDelivery?: unknown;
}) {
  const queue = {
    start: mock(async () => undefined),
    stop: mock(async () => undefined),
    createQueue: mock(async () => undefined),
    work: mock(async () => undefined),
  };
  const renderer = overrides?.renderer ?? {
    handleCompletion: mock(async () => undefined),
    handleError: mock(async () => undefined),
  };
  const platformRegistry = {
    get: mock(() => ({ getResponseRenderer: () => renderer })),
  };
  const sseManager = {
    broadcast: mock(() => undefined),
    hasActiveConnection: mock(() => false),
  };
  const consumer = new UnifiedThreadResponseConsumer(
    queue as any,
    platformRegistry as any,
    sseManager as any,
    overrides?.courseWakeDelivery as any,
  ) as any;
  if (overrides?.chatResponseBridge) {
    consumer.setChatResponseBridge(overrides.chatResponseBridge as any);
  }
  return { consumer, platformRegistry, renderer };
}

describe("UnifiedThreadResponseConsumer scheduled course delivery", () => {
  const scheduledPayload = {
    messageId: "turn-1", channelId: "scheduled", conversationId: "conversation-1",
    userId: "owner-1", teamId: "api", platform: "api", timestamp: 1,
    processedMessageIds: ["turn-1"], finalText: "stored final output",
    platformMetadata: { scheduledCourseWake: {
      schemaVersion: 1, source: "calendar_scheduled_wake", automationId: "auto-1",
      jobId: "job-1", runId: 42, toolboxUserId: "owner-1", lobuAgentId: "agent-1",
    } },
  };

  test("mechanically delivers terminal finalText without routing through SSE or a renderer", async () => {
    const courseWakeDelivery = mock(async () => undefined);
    const { consumer, renderer, platformRegistry } = createConsumer({ courseWakeDelivery });
    await consumer.handleThreadResponse({ id: "terminal-pg-run-1", data: scheduledPayload });
    expect(courseWakeDelivery).toHaveBeenCalledWith({
      metadata: scheduledPayload.platformMetadata.scheduledCourseWake,
      finalOutput: "stored final output",
      turnId: "turn-1",
    });
    expect(platformRegistry.get).not.toHaveBeenCalled();
    expect(renderer.handleCompletion).not.toHaveBeenCalled();
  });

  test("throws a transient delivery failure so the same terminal PG run retries", async () => {
    const courseWakeDelivery = mock(async () => { throw new Error("course_wake_delivery_retrying"); });
    const { consumer, renderer } = createConsumer({ courseWakeDelivery });
    await expect(consumer.handleThreadResponse({ id: "terminal-pg-run-1", data: scheduledPayload }))
      .rejects.toThrow("course_wake_delivery_retrying");
    expect(courseWakeDelivery).toHaveBeenCalledTimes(1);
    expect(renderer.handleCompletion).not.toHaveBeenCalled();
  });

  test("does not treat a synthetic wake delta as another user turn or delivery", async () => {
    const courseWakeDelivery = mock(async () => undefined);
    const renderer = { handleDelta: mock(async () => undefined), handleCompletion: mock(async () => undefined) };
    const { consumer } = createConsumer({ courseWakeDelivery, renderer });
    await consumer.handleThreadResponse({
      id: "delta-pg-run", data: { ...scheduledPayload, processedMessageIds: undefined, finalText: undefined, delta: "partial" },
    });
    expect(courseWakeDelivery).not.toHaveBeenCalled();
    expect(renderer.handleDelta).toHaveBeenCalledTimes(1);
  });
});

describe("UnifiedThreadResponseConsumer customEvent broadcast", () => {
  test("broadcasts tool_use customEvent to conversation + cli session", async () => {
    const renderer = {
      handleCompletion: mock(async () => undefined),
      handleError: mock(async () => undefined),
    };
    const queue = {
      start: mock(async () => undefined),
      stop: mock(async () => undefined),
      createQueue: mock(async () => undefined),
      work: mock(async () => undefined),
    };
    const broadcast = mock(() => undefined);
    const sseManager = { broadcast };
    const platformRegistry = {
      get: mock(() => ({ getResponseRenderer: () => renderer })),
    };
    const consumer = new UnifiedThreadResponseConsumer(
      queue as any,
      platformRegistry as any,
      sseManager as any
    ) as any;

    const payload = {
      messageId: "m1",
      channelId: "api:1",
      conversationId: "api:1",
      userId: "u1",
      teamId: "api",
      platform: "api",
      timestamp: 1000,
      platformMetadata: { sessionId: "cli-session-1" },
      customEvent: {
        name: "tool_use",
        data: {
          toolCallId: "tc-1",
          name: "search_memory",
          input: { query: "rent" },
          isError: false,
          result_summary: {
            event_ids: [42],
            snippets: [{ id: 42, text: "Rent is due 1st" }],
          },
        },
      },
    };

    await consumer.handleThreadResponse({ id: "job-1", data: payload });

    const broadcasts = broadcast.mock.calls;
    const toolUseBroadcasts = broadcasts.filter(
      (call: any[]) => call[1] === "tool_use"
    );
    expect(toolUseBroadcasts.length).toBe(2);
    const conversationBroadcast = toolUseBroadcasts.find(
      (call: any[]) => call[0] === "api:1"
    );
    const cliBroadcast = toolUseBroadcasts.find(
      (call: any[]) => call[0] === "cli-session-1"
    );
    expect(conversationBroadcast).toBeDefined();
    expect(cliBroadcast).toBeDefined();
    expect(conversationBroadcast?.[2]).toMatchObject({
      toolCallId: "tc-1",
      name: "search_memory",
      result_summary: {
        event_ids: [42],
      },
      messageId: "m1",
      timestamp: 1000,
    });
  });

  test("broadcasts shifu.work_state customEvent by event name without assistant text conversion", async () => {
    const queue = {
      start: mock(async () => undefined),
      stop: mock(async () => undefined),
      createQueue: mock(async () => undefined),
      work: mock(async () => undefined),
    };
    const broadcast = mock(() => undefined);
    const hasActiveConnection = mock(() => true);
    const renderer = {
      handleCompletion: mock(async () => undefined),
      handleError: mock(async () => undefined),
    };
    const platformRegistry = {
      get: mock((name: string) =>
        name === "api" ? { getResponseRenderer: () => renderer } : null
      ),
    };
    const consumer = new UnifiedThreadResponseConsumer(
      queue as any,
      platformRegistry as any,
      { broadcast, hasActiveConnection } as any
    ) as any;

    await consumer.handleThreadResponse({
      id: "job-work-state",
      data: {
        messageId: "decision-1",
        channelId: "line:U1",
        conversationId: "conv-1",
        userId: "user-1",
        teamId: "team-1",
        platform: "api",
        platformMetadata: {
          sourcePlatform: "line",
          sourceChannel: "line",
        },
        timestamp: 1000,
        customEvent: {
          name: "shifu.work_state",
          requireSseOwner: true,
          data: {
            type: "human_input.requested",
            eventId: "decision-1",
            title: "Blocked",
          },
        },
      },
    });

    expect(platformRegistry.get).toHaveBeenCalledWith("api");
    expect(platformRegistry.get).not.toHaveBeenCalledWith("line");
    expect(hasActiveConnection).toHaveBeenCalledWith("conv-1");
    expect(broadcast).toHaveBeenCalledWith(
      "conv-1",
      "shifu.work_state",
      expect.objectContaining({
        type: "human_input.requested",
        eventId: "decision-1",
        messageId: "decision-1",
        timestamp: 1000,
      })
    );
    expect(renderer.handleCompletion).not.toHaveBeenCalled();
  });

  test("re-queues shifu.work_state when this pod does not own the SSE", async () => {
    const queue = {
      start: mock(async () => undefined),
      stop: mock(async () => undefined),
      createQueue: mock(async () => undefined),
      work: mock(async () => undefined),
    };
    const broadcast = mock(() => undefined);
    const sseManager = {
      broadcast,
      hasActiveConnection: mock(() => false),
    };
    const platformRegistry = {
      get: mock(() => ({
        getResponseRenderer: () => ({
          handleCompletion: mock(async () => undefined),
          handleError: mock(async () => undefined),
        }),
      })),
    };
    const consumer = new UnifiedThreadResponseConsumer(
      queue as any,
      platformRegistry as any,
      sseManager as any
    ) as any;

    await expect(
      consumer.handleThreadResponse({
        id: "job-work-state",
        data: {
          messageId: "decision-1",
          channelId: "line:U1",
          conversationId: "conv-1",
          userId: "user-1",
          teamId: "team-1",
          platform: "api",
          platformMetadata: {
            sourcePlatform: "line",
            sourceChannel: "line",
          },
          timestamp: 1000,
          customEvent: {
            name: "shifu.work_state",
            requireSseOwner: true,
            data: {
              type: "human_input.requested",
              eventId: "decision-1",
              title: "Blocked",
            },
          },
        },
      })
    ).rejects.toThrow(/not owned by this gateway instance/);

    expect(sseManager.hasActiveConnection).toHaveBeenCalledWith("conv-1");
    expect(broadcast).not.toHaveBeenCalled();
  });
});

describe("UnifiedThreadResponseConsumer interaction card owner-routing", () => {
  function makeInteractionConsumer(hasActiveConnection: boolean) {
    const queue = {
      start: mock(async () => undefined),
      stop: mock(async () => undefined),
      createQueue: mock(async () => undefined),
      work: mock(async () => undefined),
    };
    const broadcast = mock(() => undefined);
    const sseManager = {
      broadcast,
      hasActiveConnection: mock(() => hasActiveConnection),
    };
    const platformRegistry = {
      get: mock(() => ({
        getResponseRenderer: () => ({
          handleCompletion: mock(async () => undefined),
          handleError: mock(async () => undefined),
        }),
      })),
    };
    const consumer = new UnifiedThreadResponseConsumer(
      queue as any,
      platformRegistry as any,
      sseManager as any
    ) as any;
    return { consumer, broadcast, sseManager };
  }

  const interactionPayload = {
    messageId: "m-int-1",
    channelId: "api:conv-1",
    conversationId: "api:conv-1",
    userId: "u1",
    teamId: "api",
    platform: "api",
    timestamp: 1234,
    customEvent: {
      name: "question",
      data: { type: "question", questionId: "q_1", question: "Proceed?" },
      requireSseOwner: true,
    },
  };

  test("re-queues an ask_user card when this pod does not own the SSE", async () => {
    const { consumer, broadcast, sseManager } = makeInteractionConsumer(false);

    await expect(
      consumer.handleThreadResponse({ id: "job-1", data: interactionPayload })
    ).rejects.toThrow(/not owned by this gateway instance/);

    expect(sseManager.hasActiveConnection).toHaveBeenCalledWith("api:conv-1");
    // Must NOT broadcast into the wrong pod's SseManager.
    expect(broadcast).not.toHaveBeenCalled();
  });

  test("delivers the card on the pod that owns the SSE connection", async () => {
    const { consumer, broadcast } = makeInteractionConsumer(true);

    await consumer.handleThreadResponse({
      id: "job-2",
      data: interactionPayload,
    });

    const questionBroadcasts = broadcast.mock.calls.filter(
      (call: any[]) => call[1] === "question"
    );
    expect(questionBroadcasts.length).toBe(1);
    expect(questionBroadcasts[0][0]).toBe("api:conv-1");
    expect(questionBroadcasts[0][2]).toMatchObject({
      type: "question",
      questionId: "q_1",
      messageId: "m-int-1",
      timestamp: 1234,
    });
  });
});

describe("ApiPlatform tool approval interaction queueing", () => {
  test("uses origin message id as queued payload messageId and SSE data correlation fields", async () => {
    const interactionService = new EventEmitter();
    const send = mock(async () => undefined);
    const platform = new ApiPlatform();

    await platform.initialize({
      getSseManager: () => ({
        broadcast: mock(() => undefined),
        hasActiveConnection: mock(() => true),
      }),
      getWatcherRunTracker: () => undefined,
      getInteractionService: () => interactionService,
      getQueue: () => ({ send }),
    } as any);

    interactionService.emit("tool:approval-needed", {
      id: "ta_approval_1",
      agentId: "agent-1",
      userId: "user-1",
      conversationId: "conv-1",
      channelId: "ch-1",
      teamId: "line",
      connectionId: "line-connection-1",
      platform: "api",
      mcpId: "line-tools",
      toolName: "send_reply",
      args: { text: "Hello" },
      grantPattern: "/mcp/line-tools/tools/send_reply",
      originMessageId: "line-message-1",
      processedMessageIds: ["line-message-1"],
    });

    expect(send).toHaveBeenCalledTimes(1);
    const [queueName, payload] = send.mock.calls[0] as any[];
    expect(queueName).toBe("thread_response");
    expect(payload).toMatchObject({
      messageId: "line-message-1",
      conversationId: "conv-1",
      customEvent: {
        name: "tool-approval",
        requireSseOwner: true,
        data: {
          type: "tool-approval",
          requestId: "ta_approval_1",
          originMessageId: "line-message-1",
          processedMessageIds: ["line-message-1"],
        },
      },
    });
  });
});

describe("UnifiedThreadResponseConsumer Chat SDK ownership", () => {
  test("throws for Chat SDK connection responses not owned by this gateway", async () => {
    const chatResponseBridge = {
      canHandle: mock(() => false),
      handleCompletion: mock(async () => undefined),
      handleError: mock(async () => undefined),
    };
    const { consumer, platformRegistry } = createConsumer({ chatResponseBridge });

    await expect(
      consumer.handleThreadResponse({ id: "job-1", data: basePayload })
    ).rejects.toThrow(/not managed by this gateway instance/);

    expect(chatResponseBridge.canHandle).toHaveBeenCalledTimes(1);
    expect(chatResponseBridge.handleCompletion).not.toHaveBeenCalled();
    expect(platformRegistry.get).not.toHaveBeenCalled();
  });

  test("routes Chat SDK responses through the owning gateway bridge", async () => {
    const chatResponseBridge = {
      canHandle: mock(() => true),
      handleCompletion: mock(async () => undefined),
      handleError: mock(async () => undefined),
    };
    const { consumer, platformRegistry } = createConsumer({ chatResponseBridge });

    await consumer.handleThreadResponse({ id: "job-1", data: basePayload });

    expect(chatResponseBridge.canHandle).toHaveBeenCalledTimes(1);
    expect(chatResponseBridge.handleCompletion).toHaveBeenCalledTimes(1);
    expect(platformRegistry.get).not.toHaveBeenCalled();
  });

  test("legacy platform responses without connectionId still use platform renderer", async () => {
    const renderer = {
      handleCompletion: mock(async () => undefined),
      handleError: mock(async () => undefined),
    };
    const { consumer, platformRegistry } = createConsumer({ renderer });
    const { platformMetadata, ...payloadWithoutMetadata } = basePayload;
    void platformMetadata;

    await consumer.handleThreadResponse({
      id: "job-1",
      data: payloadWithoutMetadata,
    });

    expect(platformRegistry.get).toHaveBeenCalledWith("telegram");
    expect(renderer.handleCompletion).toHaveBeenCalledTimes(1);
  });
});
