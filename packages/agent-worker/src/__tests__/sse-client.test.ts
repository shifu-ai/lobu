import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  __resetEncryptionKeyCacheForTests,
  generateWorkerToken,
} from "@lobu/core";
import { GatewayClient } from "../gateway/sse-client";

const basePayload = () => ({
  botId: "lobu-bot",
  userId: "user-1",
  agentId: "agent-1",
  conversationId: "conversation-1",
  platform: "line",
  channelId: "channel-1",
  messageId: "message-1",
  messageText: "hello",
  platformMetadata: {},
  agentOptions: {},
});
const validResolvedCourseContext = () => ({
  activeSpecializedSkill: null,
  trust: {
    ownerUserId: "user-1",
    agentId: "agent-1",
    conversationId: "conversation-1",
    courseKey: "course-a",
    courseEntityId: "course:user:course-a",
    contextPackId: "pack-a",
    contextVersion: 2,
  },
  course: {
    courseKey: "course-a",
    courseEntityId: "course:user:course-a",
    displayName: "Course A",
  },
  resolution: { confidence: "high", matchedBy: ["message_name"] },
  context: {
    contextPackId: "pack-a",
    contextVersion: 2,
    stale: false,
    confirmedSummary: "Confirmed A",
  },
  retrieval: {
    status: "loaded",
    crossCourseGuard: "passed",
    eventIds: [5],
    evidenceRefs: ["lobu:event:5"],
    snippets: [
      {
        eventId: 5,
        title: "A",
        text: "A only",
        sourceUrl: null,
        sourceRef: "lobu:event:5",
        provenanceKind: "fresh_course_retrieval",
        courseEntityId: "course:user:course-a",
        readinessFields: {},
      },
    ],
  },
});

describe("GatewayClient heartbeat ACKs", () => {
  const originalFetch = globalThis.fetch;
  const originalEncryptionKey = process.env.ENCRYPTION_KEY;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = originalEncryptionKey;
    __resetEncryptionKeyCacheForTests();
  });

  test("validates and preserves an identity-bound onboarding execution scope", async () => {
    process.env.ENCRYPTION_KEY =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    __resetEncryptionKeyCacheForTests();
    const runJobToken = generateWorkerToken(
      "user-1",
      "conversation-1",
      "worker-1",
      {
        channelId: "channel-1",
        agentId: "agent-1",
        runId: 9,
        messageId: "message-1",
        tokenKind: "run",
        executionMode: "onboarding",
      }
    );
    const trustedExecutionScope = {
      mode: "onboarding",
      source: "toolbox_course_resolution",
      reason: "no_courses",
      ownerUserId: "user-1",
      agentId: "agent-1",
      conversationId: "conversation-1",
    } as const;
    const client = new GatewayClient(
      "https://gateway.example.com",
      "worker-token",
      "user-1",
      "worker-1"
    );
    const handleThreadMessage = mock(async () => undefined);
    (client as any).handleThreadMessage = handleThreadMessage;
    await (client as any).handleEvent(
      "job",
      JSON.stringify({
        payload: {
          ...basePayload(),
          runId: 9,
          runJobToken,
          trustedExecutionScope,
        },
      })
    );
    expect(handleThreadMessage).toHaveBeenCalledTimes(1);
    const forwarded = handleThreadMessage.mock.calls[0]?.[0];
    expect(forwarded.trustedExecutionScope).toEqual(trustedExecutionScope);
    expect(
      (client as any).payloadToWorkerConfig(forwarded).trustedExecutionScope
    ).toEqual(trustedExecutionScope);
  });

  test.each([
    null,
    "opp-coach",
  ] as const)("validates and preserves bounded course skill selection %s", async (activeSpecializedSkill) => {
    process.env.ENCRYPTION_KEY =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    __resetEncryptionKeyCacheForTests();
    const resolvedCourseContext = {
      ...validResolvedCourseContext(),
      activeSpecializedSkill,
    };
    const trustedExecutionScope = {
      mode: "course",
      ownerUserId: "user-1",
      agentId: "agent-1",
      conversationId: "conversation-1",
      courseEntityId: "course:user:course-a",
      contextPackId: "pack-a",
      contextVersion: 2,
      activeSpecializedSkill,
    } as const;
    const runJobToken = generateWorkerToken(
      "user-1",
      "conversation-1",
      "worker-1",
      {
        channelId: "channel-1",
        agentId: "agent-1",
        runId: 11,
        messageId: "message-1",
        tokenKind: "run",
        executionMode: "course",
        courseToolScope: {
          ownerUserId: "user-1",
          agentId: "agent-1",
          courseEntityId: "course:user:course-a",
        },
      }
    );
    const client = new GatewayClient(
      "https://gateway.example.com",
      "worker-token",
      "user-1",
      "worker-1"
    );
    const handleThreadMessage = mock(async () => undefined);
    (client as any).handleThreadMessage = handleThreadMessage;
    await (client as any).handleEvent(
      "job",
      JSON.stringify({
        payload: {
          ...basePayload(),
          runId: 11,
          runJobToken,
          resolvedCourseContext,
          trustedExecutionScope,
        },
      })
    );
    expect(handleThreadMessage).toHaveBeenCalledTimes(1);
    expect(
      handleThreadMessage.mock.calls[0]?.[0].resolvedCourseContext
        .activeSpecializedSkill
    ).toBe(activeSpecializedSkill);
    expect(
      handleThreadMessage.mock.calls[0]?.[0].trustedExecutionScope
        .activeSpecializedSkill
    ).toBe(activeSpecializedSkill);
  });

  test("rejects onboarding scope identity mismatch and missing scope for an onboarding token", async () => {
    process.env.ENCRYPTION_KEY =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    __resetEncryptionKeyCacheForTests();
    const runJobToken = generateWorkerToken(
      "user-1",
      "conversation-1",
      "worker-1",
      {
        channelId: "channel-1",
        agentId: "agent-1",
        runId: 10,
        messageId: "message-1",
        tokenKind: "run",
        executionMode: "onboarding",
      }
    );
    const client = new GatewayClient(
      "https://gateway.example.com",
      "worker-token",
      "user-1",
      "worker-1"
    );
    const handleThreadMessage = mock(async () => undefined);
    (client as any).handleThreadMessage = handleThreadMessage;
    const scope = {
      mode: "onboarding",
      source: "toolbox_course_resolution",
      reason: "no_courses",
      ownerUserId: "other",
      agentId: "agent-1",
      conversationId: "conversation-1",
    };
    await (client as any).handleEvent(
      "job",
      JSON.stringify({
        payload: {
          ...basePayload(),
          runId: 10,
          runJobToken,
          trustedExecutionScope: scope,
        },
      })
    );
    await (client as any).handleEvent(
      "job",
      JSON.stringify({ payload: { ...basePayload(), runId: 10, runJobToken } })
    );
    await (client as any).handleEvent(
      "job",
      JSON.stringify({
        payload: {
          ...basePayload(),
          runId: 10,
          runJobToken,
          trustedExecutionScope: { ...scope, ownerUserId: "user-1" },
          resolvedCourseContext: validResolvedCourseContext(),
        },
      })
    );
    expect(handleThreadMessage).not.toHaveBeenCalled();
  });

  test("rejects onboarding token replay across run, message, channel, or deployment", async () => {
    process.env.ENCRYPTION_KEY =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    __resetEncryptionKeyCacheForTests();
    const trustedExecutionScope = {
      mode: "onboarding",
      source: "toolbox_course_resolution",
      reason: "no_courses",
      ownerUserId: "user-1",
      agentId: "agent-1",
      conversationId: "conversation-1",
    } as const;
    const cases = [
      {
        tokenRunId: 19,
        tokenMessageId: "message-1",
        tokenChannelId: "channel-1",
        tokenDeployment: "worker-1",
      },
      {
        tokenRunId: 20,
        tokenMessageId: "other-message",
        tokenChannelId: "channel-1",
        tokenDeployment: "worker-1",
      },
      {
        tokenRunId: 20,
        tokenMessageId: "message-1",
        tokenChannelId: "other-channel",
        tokenDeployment: "worker-1",
      },
      {
        tokenRunId: 20,
        tokenMessageId: "message-1",
        tokenChannelId: "channel-1",
        tokenDeployment: "other-worker",
      },
    ];
    for (const item of cases) {
      const runJobToken = generateWorkerToken(
        "user-1",
        "conversation-1",
        item.tokenDeployment,
        {
          channelId: item.tokenChannelId,
          agentId: "agent-1",
          runId: item.tokenRunId,
          messageId: item.tokenMessageId,
          tokenKind: "run",
          executionMode: "onboarding",
        }
      );
      const client = new GatewayClient(
        "https://gateway.example.com",
        "worker-token",
        "user-1",
        "worker-1"
      );
      const handleThreadMessage = mock(async () => undefined);
      (client as any).handleThreadMessage = handleThreadMessage;
      await (client as any).handleEvent(
        "job",
        JSON.stringify({
          payload: {
            ...basePayload(),
            runId: 20,
            runJobToken,
            trustedExecutionScope,
          },
        })
      );
      expect(handleThreadMessage).not.toHaveBeenCalled();
    }
  });

  test("accepts nested platform metadata on job events", async () => {
    const client = new GatewayClient(
      "https://gateway.example.com",
      "worker-token",
      "user-1",
      "worker-1"
    );
    const handleThreadMessage = mock(async () => undefined);
    (client as any).handleThreadMessage = handleThreadMessage;

    await (client as any).handleEvent(
      "job",
      JSON.stringify({
        payload: {
          botId: "lobu-api",
          userId: "watcher_218",
          agentId: "marketing",
          conversationId: "marketing_watcher_218_run_120947",
          platform: "api",
          channelId: "api_watcher_218",
          messageId: "message-1",
          messageText: "run watcher",
          platformMetadata: {
            agentId: "marketing",
            source: "watcher-run",
            intent: { kind: "watcher_run", runId: 120947, watcherId: 218 },
          },
          agentOptions: {},
        },
      })
    );

    expect(handleThreadMessage).toHaveBeenCalledTimes(1);
    expect(
      handleThreadMessage.mock.calls[0]?.[0].platformMetadata.intent
    ).toEqual({
      kind: "watcher_run",
      runId: 120947,
      watcherId: 218,
    });
  });

  test("propagates runId and runJobToken from job payload to handleThreadMessage", async () => {
    // Regression test for the bug shipped in PR #871: snapshot mode became
    // the default, but JobEventSchema was a plain z.object() (default zod
    // mode strips unknown keys). MessageConsumer stamps runId + runJobToken
    // onto the MessagePayload before SSE dispatch, but those fields were
    // silently dropped by safeParse — so every snapshot-mode chat threw
    // "WorkerConfig.runId is missing" at boot. Pre-fix: this assertion
    // sees `undefined`. Post-fix: the fields survive parsing.
    const client = new GatewayClient(
      "https://gateway.example.com",
      "worker-token",
      "user-1",
      "worker-1"
    );
    const handleThreadMessage = mock(async () => undefined);
    (client as any).handleThreadMessage = handleThreadMessage;

    await (client as any).handleEvent(
      "job",
      JSON.stringify({
        payload: {
          botId: "lobu-bot",
          userId: "telegram-user-1",
          agentId: "default",
          conversationId: "telegram:6570514069",
          platform: "telegram",
          channelId: "6570514069",
          messageId: "6570514069:29",
          messageText: "hi",
          platformMetadata: {},
          agentOptions: {},
          runId: 12345,
          runJobToken: "per-run-jwt-abc",
        },
        jobId: "12345",
      })
    );

    expect(handleThreadMessage).toHaveBeenCalledTimes(1);
    const forwarded = handleThreadMessage.mock.calls[0]?.[0];
    expect(forwarded.runId).toBe(12345);
    expect(forwarded.runJobToken).toBe("per-run-jwt-abc");
  });

  test("payloadToWorkerConfig threads runId + runJobToken into WorkerConfig", async () => {
    // The dispatch-path bug's second half: even if zod kept the fields,
    // payloadToWorkerConfig has to forward them onto the WorkerConfig the
    // worker reads at boot (worker.ts:353-360). Lock that mapping in.
    const client = new GatewayClient(
      "https://gateway.example.com",
      "worker-token",
      "user-1",
      "worker-1"
    );
    const config = (client as any).payloadToWorkerConfig({
      botId: "lobu-bot",
      userId: "telegram-user-1",
      agentId: "default",
      conversationId: "telegram:6570514069",
      platform: "telegram",
      channelId: "6570514069",
      messageId: "6570514069:29",
      messageText: "hi",
      platformMetadata: {},
      agentOptions: {},
      runId: 67890,
      runJobToken: "per-run-jwt-xyz",
    });
    expect(config.messageId).toBe("6570514069:29");
    expect(config.runId).toBe(67890);
    expect(config.runJobToken).toBe("per-run-jwt-xyz");
  });

  test("validates and preserves resolved course context instead of relying on passthrough", async () => {
    const client = new GatewayClient(
      "https://gateway.example.com",
      "worker-token",
      "user-1",
      "worker-1"
    );
    const handleThreadMessage = mock(async () => undefined);
    (client as any).handleThreadMessage = handleThreadMessage;
    const resolvedCourseContext = validResolvedCourseContext();
    await (client as any).handleEvent(
      "job",
      JSON.stringify({ payload: { ...basePayload(), resolvedCourseContext } })
    );
    expect(
      handleThreadMessage.mock.calls[0]?.[0].resolvedCourseContext
    ).toEqual(resolvedCourseContext);
    expect(
      (client as any).payloadToWorkerConfig(
        handleThreadMessage.mock.calls[0]?.[0]
      ).resolvedCourseContext
    ).toEqual(resolvedCourseContext);
  });

  test("preserves bounded course readiness and evidence through job event parsing", async () => {
    const client = new GatewayClient(
      "https://gateway.example.com",
      "worker-token",
      "user-1",
      "worker-1"
    );
    const handleThreadMessage = mock(async () => undefined);
    (client as any).handleThreadMessage = handleThreadMessage;
    const resolvedCourseContext = {
      ...validResolvedCourseContext(),
      retrieval: {
        ...validResolvedCourseContext().retrieval,
        snippets: [
          {
            eventId: 5,
            title: "A",
            text: "A only",
            sourceUrl: null,
            sourceRef: "drive:file-1",
            provenanceKind: "fresh_course_retrieval",
            courseEntityId: "course:user:course-a",
            readinessFields: { audience: "課程 PM" },
          },
        ],
      },
      readiness: {
        level: "partial",
        answerPolicy: "answer_with_assumptions",
        availableFields: ["audience", "key_learning"],
        missingFields: ["course_promise", "existing_sales_talk"],
        suggestedQuestions: ["課程承諾是什麼？", "目前有哪些銷講？"],
      },
      evidence: [
        {
          kind: "canonical_context",
          fields: ["audience", "key_learning"],
          sourceLabel: "已驗證的課程脈絡",
          sourceHash: "abcd1234",
        },
      ],
    };

    await (client as any).handleEvent(
      "job",
      JSON.stringify({ payload: { ...basePayload(), resolvedCourseContext } })
    );

    expect(
      handleThreadMessage.mock.calls[0]?.[0].resolvedCourseContext
    ).toEqual(resolvedCourseContext);
  });

  test("accepts a partial bounded readiness field map through transport", async () => {
    const client = new GatewayClient(
      "https://gateway.example.com",
      "worker-token",
      "user-1",
      "worker-1"
    );
    const handleThreadMessage = mock(async () => undefined);
    (client as any).handleThreadMessage = handleThreadMessage;
    const context = validResolvedCourseContext();
    context.retrieval.snippets[0].readinessFields = { audience: "course PMs" };

    await (client as any).handleEvent(
      "job",
      JSON.stringify({
        payload: { ...basePayload(), resolvedCourseContext: context },
      })
    );

    expect(handleThreadMessage).toHaveBeenCalledTimes(1);
    expect(
      handleThreadMessage.mock.calls[0]?.[0].resolvedCourseContext.retrieval
        .snippets[0].readinessFields
    ).toEqual({ audience: "course PMs" });
  });

  test.each([
    ["unknown", { audience: "course PMs", internal_notes: "do not transport" }],
    ["restricted", { audience: "course PMs", constructor: "do not transport" }],
    ["oversized", { audience: "a".repeat(501) }],
  ])("rejects %s readiness fields", async (_case, readinessFields) => {
    const client = new GatewayClient(
      "https://gateway.example.com",
      "worker-token",
      "user-1",
      "worker-1"
    );
    const handleThreadMessage = mock(async () => undefined);
    (client as any).handleThreadMessage = handleThreadMessage;
    const context: any = validResolvedCourseContext();
    context.retrieval.snippets[0].readinessFields = readinessFields;

    await (client as any).handleEvent(
      "job",
      JSON.stringify({
        payload: { ...basePayload(), resolvedCourseContext: context },
      })
    );

    expect(handleThreadMessage).not.toHaveBeenCalled();
  });

  test.each([
    "sourceRef",
    "provenanceKind",
    "courseEntityId",
  ])("rejects a fresh snippet missing required %s", async (field) => {
    const client = new GatewayClient(
      "https://gateway.example.com",
      "worker-token",
      "user-1",
      "worker-1"
    );
    const handleThreadMessage = mock(async () => undefined);
    (client as any).handleThreadMessage = handleThreadMessage;
    const context: any = validResolvedCourseContext();
    delete context.retrieval.snippets[0][field];
    await (client as any).handleEvent(
      "job",
      JSON.stringify({
        payload: { ...basePayload(), resolvedCourseContext: context },
      })
    );
    expect(handleThreadMessage).not.toHaveBeenCalled();
  });
  test("rejects a fresh snippet stamped for a different course", async () => {
    const client = new GatewayClient(
      "https://gateway.example.com",
      "worker-token",
      "user-1",
      "worker-1"
    );
    const handleThreadMessage = mock(async () => undefined);
    (client as any).handleThreadMessage = handleThreadMessage;
    const context: any = validResolvedCourseContext();
    context.retrieval.snippets[0].courseEntityId = "course:other";
    await (client as any).handleEvent(
      "job",
      JSON.stringify({
        payload: { ...basePayload(), resolvedCourseContext: context },
      })
    );
    expect(handleThreadMessage).not.toHaveBeenCalled();
  });
  test("rejects a retrieval envelope above 8KB even when individual fields are bounded", async () => {
    const client = new GatewayClient(
      "https://gateway.example.com",
      "worker-token",
      "user-1",
      "worker-1"
    );
    const handleThreadMessage = mock(async () => undefined);
    (client as any).handleThreadMessage = handleThreadMessage;
    const context: any = validResolvedCourseContext();
    const readinessFields = {
      audience: "a".repeat(500),
      key_learning: "k".repeat(500),
      course_promise: "p".repeat(500),
      existing_sales_talk: "s".repeat(500),
    };
    context.retrieval.snippets = Array.from({ length: 4 }, (_, index) => ({
      ...context.retrieval.snippets[0],
      eventId: index + 1,
      sourceRef: `lobu:event:${index + 1}`,
      readinessFields,
    }));
    context.retrieval.eventIds = [1, 2, 3, 4];
    context.retrieval.evidenceRefs = [
      "lobu:event:1",
      "lobu:event:2",
      "lobu:event:3",
      "lobu:event:4",
    ];
    expect(JSON.stringify(context.retrieval).length).toBeGreaterThan(8000);
    await (client as any).handleEvent(
      "job",
      JSON.stringify({
        payload: { ...basePayload(), resolvedCourseContext: context },
      })
    );
    expect(handleThreadMessage).not.toHaveBeenCalled();
  });
  test("normalizes an exact trusted pre-Task2 retrieval and sends its delivery receipt", async () => {
    const requests: unknown[] = [];
    globalThis.fetch = mock(async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response("ok");
    }) as typeof fetch;
    const client = new GatewayClient(
      "https://gateway.example.com",
      "worker-token",
      "user-1",
      "worker-1"
    );
    const handleThreadMessage = mock(async () => undefined);
    (client as any).handleThreadMessage = handleThreadMessage;
    const context: any = validResolvedCourseContext();
    context.retrieval.snippets = [
      { eventId: 5, title: "A", text: "A only", sourceUrl: null },
    ];
    await (client as any).handleEvent(
      "job",
      JSON.stringify({
        jobId: "legacy-job",
        payload: { ...basePayload(), resolvedCourseContext: context },
      })
    );
    expect(requests).toContainEqual({ jobId: "legacy-job", received: true });
    expect(handleThreadMessage).toHaveBeenCalledTimes(1);
    expect(
      handleThreadMessage.mock.calls[0]?.[0].resolvedCourseContext.retrieval
        .snippets
    ).toEqual([
      {
        eventId: 5,
        title: "A",
        text: "A only",
        sourceUrl: null,
        sourceRef: "lobu:event:5",
        provenanceKind: "fresh_course_retrieval",
        courseEntityId: "course:user:course-a",
        readinessFields: {},
      },
    ]);
  });

  test("accepts every canonical retrieval status and sends a delivery receipt", async () => {
    const canonicalStatuses = [
      "loaded",
      "empty",
      "degraded",
      "invariant_violation",
    ] as const;
    const requests: unknown[] = [];
    globalThis.fetch = mock(async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response("ok");
    }) as typeof fetch;
    const client = new GatewayClient(
      "https://gateway.example.com",
      "worker-token",
      "user-1",
      "worker-1"
    );
    const handleThreadMessage = mock(async () => undefined);
    (client as any).handleThreadMessage = handleThreadMessage;

    for (const status of canonicalStatuses) {
      const resolvedCourseContext = validResolvedCourseContext();
      resolvedCourseContext.retrieval.status = status;
      await (client as any).handleEvent(
        "job",
        JSON.stringify({
          jobId: `job-${status}`,
          payload: { ...basePayload(), resolvedCourseContext },
        })
      );
    }

    expect(handleThreadMessage).toHaveBeenCalledTimes(canonicalStatuses.length);
    expect(requests).toEqual(
      canonicalStatuses.map((status) => ({
        jobId: `job-${status}`,
        received: true,
      }))
    );
  });

  test.each([
    "partial",
    "failed",
  ])("rejects obsolete retrieval status %s", async (status) => {
    const client = new GatewayClient(
      "https://gateway.example.com",
      "worker-token",
      "user-1",
      "worker-1"
    );
    const handleThreadMessage = mock(async () => undefined);
    (client as any).handleThreadMessage = handleThreadMessage;
    const resolvedCourseContext = validResolvedCourseContext();
    resolvedCourseContext.retrieval.status = status;

    await (client as any).handleEvent(
      "job",
      JSON.stringify({
        payload: { ...basePayload(), resolvedCourseContext },
      })
    );

    expect(handleThreadMessage).not.toHaveBeenCalled();
  });

  test("terminally rejects a queued legacy course context without executing it", async () => {
    const client = new GatewayClient(
      "https://gateway.example.com",
      "worker-token",
      "user-1",
      "worker-1"
    );
    const handleThreadMessage = mock(async () => undefined);
    (client as any).handleThreadMessage = handleThreadMessage;
    const legacy: any = validResolvedCourseContext();
    delete legacy.trust;
    const requests: unknown[] = [];
    globalThis.fetch = mock(async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response("ok");
    }) as typeof fetch;
    await (client as any).handleEvent(
      "job",
      JSON.stringify({
        jobId: "queued-old-job",
        payload: { ...basePayload(), resolvedCourseContext: legacy },
      })
    );
    expect(handleThreadMessage).not.toHaveBeenCalled();
    expect(requests).toContainEqual(
      expect.objectContaining({
        jobId: "queued-old-job",
        messageId: "message-1",
        error: "Course context is unavailable. Please retry.",
        errorCode: "course_context_unavailable",
      })
    );
  });

  test("rejects fabricated trust that disagrees with payload and context", async () => {
    const client = new GatewayClient(
      "https://gateway.example.com",
      "worker-token",
      "user-1",
      "worker-1"
    );
    const handleThreadMessage = mock(async () => undefined);
    (client as any).handleThreadMessage = handleThreadMessage;
    const fabricated: any = validResolvedCourseContext();
    fabricated.trust.ownerUserId = "other";
    fabricated.trust.contextPackId = "other-pack";
    await (client as any).handleEvent(
      "job",
      JSON.stringify({
        payload: { ...basePayload(), resolvedCourseContext: fabricated },
      })
    );
    expect(handleThreadMessage).not.toHaveBeenCalled();
  });

  test("rejects malformed resolved course context at the worker wire boundary", async () => {
    const client = new GatewayClient(
      "https://gateway.example.com",
      "worker-token",
      "user-1",
      "worker-1"
    );
    const handleThreadMessage = mock(async () => undefined);
    (client as any).handleThreadMessage = handleThreadMessage;
    await (client as any).handleEvent(
      "job",
      JSON.stringify({
        payload: {
          ...basePayload(),
          resolvedCourseContext: {
            course: { courseKey: "a", courseEntityId: "course:a" },
            resolution: { confidence: "high", matchedBy: ["latest"] },
            context: {
              contextPackId: "p",
              contextVersion: 0,
              stale: "false",
              confirmedSummary: "x",
            },
            retrieval: { status: "loaded", snippets: [] },
          },
        },
      })
    );
    expect(handleThreadMessage).not.toHaveBeenCalled();
  });

  test.each([
    [
      "course key",
      (value: any) => {
        value.course.courseKey = "x".repeat(201);
      },
    ],
    [
      "course entity",
      (value: any) => {
        value.course.courseEntityId = "x".repeat(201);
      },
    ],
    [
      "display name",
      (value: any) => {
        value.course.displayName = "x".repeat(501);
      },
    ],
    [
      "context pack",
      (value: any) => {
        value.context.contextPackId = "x".repeat(201);
      },
    ],
    [
      "confirmed summary",
      (value: any) => {
        value.context.confirmedSummary = "x".repeat(8001);
      },
    ],
    [
      "event ids",
      (value: any) => {
        value.retrieval.eventIds = Array.from(
          { length: 9 },
          (_, index) => index + 1
        );
      },
    ],
    [
      "evidence refs",
      (value: any) => {
        value.retrieval.evidenceRefs = Array.from(
          { length: 9 },
          (_, index) => `lobu:event:${index + 1}`
        );
      },
    ],
    [
      "snippets",
      (value: any) => {
        value.retrieval.snippets = Array.from({ length: 9 }, (_, index) => ({
          eventId: index + 1,
          title: null,
          text: "x",
          sourceUrl: null,
        }));
      },
    ],
    [
      "evidence ref length",
      (value: any) => {
        value.retrieval.evidenceRefs = ["x".repeat(257)];
      },
    ],
    [
      "snippet title",
      (value: any) => {
        value.retrieval.snippets[0].title = "x".repeat(201);
      },
    ],
    [
      "snippet text",
      (value: any) => {
        value.retrieval.snippets[0].text = "x".repeat(301);
      },
    ],
    [
      "source url",
      (value: any) => {
        value.retrieval.snippets[0].sourceUrl = `https://example.com/${"x".repeat(237)}`;
      },
    ],
  ])("rejects oversized resolved context %s", async (_name, mutate) => {
    const client = new GatewayClient(
      "https://gateway.example.com",
      "worker-token",
      "user-1",
      "worker-1"
    );
    const handleThreadMessage = mock(async () => undefined);
    (client as any).handleThreadMessage = handleThreadMessage;
    const resolvedCourseContext: any = validResolvedCourseContext();
    mutate(resolvedCourseContext);
    await (client as any).handleEvent(
      "job",
      JSON.stringify({ payload: { ...basePayload(), resolvedCourseContext } })
    );
    expect(handleThreadMessage).not.toHaveBeenCalled();
  });

  test("rejects aggregate resolved context above the serialized wire cap", async () => {
    const client = new GatewayClient(
      "https://gateway.example.com",
      "worker-token",
      "user-1",
      "worker-1"
    );
    const handleThreadMessage = mock(async () => undefined);
    (client as any).handleThreadMessage = handleThreadMessage;
    const resolvedCourseContext: any = validResolvedCourseContext();
    resolvedCourseContext.context.confirmedSummary = "\\".repeat(8000);
    resolvedCourseContext.retrieval.evidenceRefs = Array.from(
      { length: 8 },
      () => "\\".repeat(256)
    );
    await (client as any).handleEvent(
      "job",
      JSON.stringify({ payload: { ...basePayload(), resolvedCourseContext } })
    );
    expect(handleThreadMessage).not.toHaveBeenCalled();
  });

  test("accepts a legitimate payload at all producer field and array limits", async () => {
    const client = new GatewayClient(
      "https://gateway.example.com",
      "worker-token",
      "user-1",
      "worker-1"
    );
    const handleThreadMessage = mock(async () => undefined);
    (client as any).handleThreadMessage = handleThreadMessage;
    const resolvedCourseContext: any = validResolvedCourseContext();
    resolvedCourseContext.course = {
      courseKey: "k".repeat(200),
      courseEntityId: "e".repeat(200),
      displayName: "d".repeat(500),
    };
    resolvedCourseContext.context = {
      ...resolvedCourseContext.context,
      contextPackId: "p".repeat(200),
      confirmedSummary: "s".repeat(8000),
    };
    resolvedCourseContext.trust = {
      ...resolvedCourseContext.trust,
      courseKey: resolvedCourseContext.course.courseKey,
      courseEntityId: resolvedCourseContext.course.courseEntityId,
      contextPackId: resolvedCourseContext.context.contextPackId,
    };
    resolvedCourseContext.retrieval.eventIds = Array.from(
      { length: 8 },
      (_, index) => index + 1
    );
    resolvedCourseContext.retrieval.evidenceRefs = Array.from(
      { length: 8 },
      () => "r".repeat(256)
    );
    resolvedCourseContext.retrieval.snippets = Array.from(
      { length: 8 },
      (_, index) => ({
        eventId: index + 1,
        title: index === 0 ? "t".repeat(200) : "t",
        text: index === 0 ? "x".repeat(300) : "x",
        sourceUrl: null,
        sourceRef: `lobu:event:${index + 1}`,
        provenanceKind: "fresh_course_retrieval",
        courseEntityId: resolvedCourseContext.course.courseEntityId,
        readinessFields: {},
      })
    );
    await (client as any).handleEvent(
      "job",
      JSON.stringify({ payload: { ...basePayload(), resolvedCourseContext } })
    );
    expect(handleThreadMessage).toHaveBeenCalledTimes(1);
  });

  test.each([
    [
      "course A and B",
      validResolvedCourseContext(),
      {
        ...validResolvedCourseContext(),
        course: {
          courseKey: "course-b",
          courseEntityId: "course:b",
          displayName: "Course B",
        },
      },
      2,
    ],
    ["undefined and B", undefined, validResolvedCourseContext(), 2],
    [
      "same exact snapshot",
      validResolvedCourseContext(),
      validResolvedCourseContext(),
      1,
    ],
    [
      "same course different version",
      validResolvedCourseContext(),
      {
        ...validResolvedCourseContext(),
        context: { ...validResolvedCourseContext().context, contextVersion: 3 },
      },
      2,
    ],
    [
      "same course different retrieval",
      validResolvedCourseContext(),
      {
        ...validResolvedCourseContext(),
        retrieval: {
          ...validResolvedCourseContext().retrieval,
          evidenceRefs: ["lobu:event:99"],
        },
      },
      2,
    ],
  ])("batches only compatible resolved context snapshots: %s", async (_name, firstContext, secondContext, expectedTurns) => {
    const client = new GatewayClient(
      "https://gateway.example.com",
      "worker-token",
      "user-1",
      "worker-1"
    );
    const processSingleMessage = mock(async () => undefined);
    (client as any).processSingleMessage = processSingleMessage;
    await (client as any).processBatchedMessages([
      {
        timestamp: 1,
        payload: {
          ...basePayload(),
          messageId: "m1",
          platformMetadata: { responseId: "shared" },
          resolvedCourseContext: firstContext,
        },
      },
      {
        timestamp: 2,
        payload: {
          ...basePayload(),
          messageId: "m2",
          platformMetadata: { responseId: "shared" },
          resolvedCourseContext: secondContext,
        },
      },
    ]);
    expect(processSingleMessage).toHaveBeenCalledTimes(expectedTurns);
    if (expectedTurns === 2) {
      expect(
        processSingleMessage.mock.calls[0]?.[0].payload.resolvedCourseContext
      ).toEqual(firstContext);
      expect(
        processSingleMessage.mock.calls[1]?.[0].payload.resolvedCourseContext
      ).toEqual(secondContext);
    }
  });

  test.each([
    [
      "responseChannel",
      (payload: any) => {
        payload.platformMetadata.responseChannel = "other-channel";
      },
    ],
    [
      "responseId",
      (payload: any) => {
        payload.platformMetadata.responseId = "other-response";
      },
    ],
    [
      "botResponseId",
      (payload: any) => {
        payload.platformMetadata.botResponseId = "other-bot-response";
      },
    ],
    [
      "top-level teamId",
      (payload: any) => {
        payload.teamId = "other-team";
      },
    ],
    [
      "metadata teamId",
      (payload: any) => {
        delete payload.teamId;
        payload.platformMetadata.teamId = "other-team";
      },
    ],
    [
      "responseThreadId",
      (payload: any) => {
        payload.platformMetadata.responseThreadId = "other-thread";
      },
    ],
    [
      "chatId",
      (payload: any) => {
        payload.platformMetadata.chatId = "other-chat";
      },
    ],
    [
      "connectionId",
      (payload: any) => {
        payload.platformMetadata.connectionId = "other-connection";
      },
    ],
  ])("splits identical context when routing field differs: %s", async (_name, mutate) => {
    const client = new GatewayClient(
      "https://gateway.example.com",
      "worker-token",
      "user-1",
      "worker-1"
    );
    const processSingleMessage = mock(async () => undefined);
    (client as any).processSingleMessage = processSingleMessage;
    const first: any = {
      ...basePayload(),
      messageId: "m1",
      teamId: "team",
      platformMetadata: {
        responseChannel: "channel",
        responseId: "response",
        botResponseId: "bot-response",
        teamId: "team",
        responseThreadId: "thread",
        chatId: "chat",
        connectionId: "connection",
      },
      resolvedCourseContext: validResolvedCourseContext(),
    };
    const second: any = structuredClone({ ...first, messageId: "m2" });
    mutate(second);
    await (client as any).processBatchedMessages([
      { timestamp: 1, payload: first },
      { timestamp: 2, payload: second },
    ]);
    expect(processSingleMessage).toHaveBeenCalledTimes(2);
  });

  test("payloadToWorkerConfig leaves runId/runJobToken undefined when absent (legacy direct-enqueue path)", async () => {
    // Backwards-compat: legacy direct-enqueue paths don't set runId. The
    // fields must survive end-to-end as `undefined`, not be coerced into
    // NaN/empty-string.
    const client = new GatewayClient(
      "https://gateway.example.com",
      "worker-token",
      "user-1",
      "worker-1"
    );
    const config = (client as any).payloadToWorkerConfig({
      botId: "lobu-bot",
      userId: "user-1",
      agentId: "default",
      conversationId: "conv",
      platform: "api",
      channelId: "channel",
      messageId: "msg-1",
      messageText: "hi",
      platformMetadata: {},
      agentOptions: {},
    });
    expect(config.runId).toBeUndefined();
    expect(config.runJobToken).toBeUndefined();
  });

  test("ACKs heartbeat pings over the worker response endpoint", async () => {
    const fetchMock = mock(
      async (_url: string | URL | Request, _options?: RequestInit) =>
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new GatewayClient(
      "https://gateway.example.com",
      "worker-token",
      "user-1",
      "worker-1"
    );

    await (client as any).handleEvent(
      "ping",
      JSON.stringify({ timestamp: Date.now() })
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://gateway.example.com/worker/response"
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer worker-token",
      },
    });
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({ received: true, heartbeat: true })
    );
  });
});
