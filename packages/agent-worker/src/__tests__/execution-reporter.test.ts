import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { generateWorkerToken } from "@lobu/core";
import {
  createExecutionReporter,
  deriveExecutionTaskId,
} from "../openclaw/execution-reporter";

describe("execution reporter", () => {
  let originalEncryptionKey: string | undefined;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalEncryptionKey = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    if (originalEncryptionKey === undefined) {
      delete process.env.ENCRYPTION_KEY;
    } else {
      process.env.ENCRYPTION_KEY = originalEncryptionKey;
    }
    globalThis.fetch = originalFetch;
  });

  test("derives stable task id from worker token message id", () => {
    const token = generateWorkerToken("user-1", "conversation-1", "deploy-1", {
      channelId: "line:U1",
      agentId: "agent-1",
      messageId: "line-message-1",
    });

    expect(deriveExecutionTaskId(token, "session-1", "line-message-1")).toBe(
      "exec:line-message-1"
    );
  });

  test("posts create and record events to the gateway endpoint", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = mock(async (url, init) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const token = generateWorkerToken("user-1", "conversation-1", "deploy-1", {
      channelId: "line:U1",
      agentId: "agent-1",
      messageId: "line-message-1",
    });
    const reporter = createExecutionReporter({
      gatewayUrl: "https://gateway.example.test",
      workerToken: token,
      agentId: "agent-1",
      sessionId: "session-1",
      messageId: "line-message-1",
      conversationId: "conversation-1",
      userId: "user-1",
      source: "line",
    });

    await reporter.createTask({ metadata: { model: "claude-sonnet-4-5" } });
    await reporter.record({
      type: "agent.heartbeat",
      payload: { elapsedSeconds: 20 },
      status: "running",
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      url: "https://gateway.example.test/internal/execution-events",
      body: {
        action: "create",
        taskId: "exec:line-message-1",
        agentId: "agent-1",
        conversationId: "conversation-1",
        userId: "user-1",
        source: "line",
        metadata: { model: "claude-sonnet-4-5" },
      },
    });
    expect(calls[1]).toMatchObject({
      body: {
        action: "record",
        taskId: "exec:line-message-1",
        type: "agent.heartbeat",
        payload: { elapsedSeconds: 20 },
        status: "running",
      },
    });
  });

  test("is a no-op when required gateway fields are missing", async () => {
    const fetchMock = mock(async () => new Response(null, { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const reporter = createExecutionReporter({
      gatewayUrl: "",
      workerToken: "",
      agentId: "",
      sessionId: "session-1",
      conversationId: "conversation-1",
      source: "line",
    });

    await reporter.createTask();
    await reporter.record({ type: "agent.started" });

    expect(reporter.taskId).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
