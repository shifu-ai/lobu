import { afterEach, describe, expect, mock, test } from "bun:test";
import { GatewayClient } from "../gateway/sse-client";

const basePayload = () => ({ botId: "lobu-bot", userId: "user-1", agentId: "agent-1", conversationId: "conversation-1", platform: "line", channelId: "channel-1", messageId: "message-1", messageText: "hello", platformMetadata: {}, agentOptions: {} });

describe("GatewayClient heartbeat ACKs", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
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
    const client = new GatewayClient("https://gateway.example.com", "worker-token", "user-1", "worker-1");
    const handleThreadMessage = mock(async () => undefined);
    (client as any).handleThreadMessage = handleThreadMessage;
    const resolvedCourseContext = { course: { courseKey: "course-a", courseEntityId: "course:user:course-a", displayName: "Course A" }, resolution: { confidence: "high", matchedBy: ["message_name"] }, context: { contextPackId: "pack-a", contextVersion: 2, stale: false, confirmedSummary: "Confirmed A" }, retrieval: { status: "loaded", crossCourseGuard: "passed", eventIds: [5], evidenceRefs: ["lobu:event:5"], snippets: [{ eventId: 5, title: "A", text: "A only", sourceUrl: null }] } };
    await (client as any).handleEvent("job", JSON.stringify({ payload: { ...basePayload(), resolvedCourseContext } }));
    expect(handleThreadMessage.mock.calls[0]?.[0].resolvedCourseContext).toEqual(resolvedCourseContext);
    expect((client as any).payloadToWorkerConfig(handleThreadMessage.mock.calls[0]?.[0]).resolvedCourseContext).toEqual(resolvedCourseContext);
  });

  test("rejects malformed resolved course context at the worker wire boundary", async () => {
    const client = new GatewayClient("https://gateway.example.com", "worker-token", "user-1", "worker-1");
    const handleThreadMessage = mock(async () => undefined);
    (client as any).handleThreadMessage = handleThreadMessage;
    await (client as any).handleEvent("job", JSON.stringify({ payload: { ...basePayload(), resolvedCourseContext: { course: { courseKey: "a", courseEntityId: "course:a" }, resolution: { confidence: "high", matchedBy: ["latest"] }, context: { contextPackId: "p", contextVersion: 0, stale: "false", confirmedSummary: "x" }, retrieval: { status: "loaded", snippets: [] } } } }));
    expect(handleThreadMessage).not.toHaveBeenCalled();
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
