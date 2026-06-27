import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { generateWorkerToken } from "@lobu/core";
import {
  createExecutionTask,
  getExecutionTaskStatus,
} from "../execution/execution-events.js";
import { createExecutionEventRoutes } from "../routes/internal/execution-events.js";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
} from "./helpers/db-setup.js";

describe("internal execution event routes", () => {
  beforeAll(async () => {
    await ensureDbForGatewayTests();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  function workerToken(options: { conversationId?: string; agentId?: string } = {}) {
    return generateWorkerToken(
      "user-1",
      options.conversationId ?? "conversation-1",
      "deploy-1",
      {
        channelId: "line:U1",
        agentId: options.agentId ?? "agent-1",
        platform: "line",
        messageId: "message-1",
      }
    );
  }

  test("creates an execution task scoped to the worker token", async () => {
    const router = createExecutionEventRoutes();
    const res = await router.request("/internal/execution-events", {
      method: "POST",
      headers: {
        authorization: `Bearer ${workerToken()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        action: "create",
        taskId: "exec:message-1",
        agentId: "agent-1",
        conversationId: "conversation-1",
        userId: "user-1",
        source: "line",
        metadata: { model: "claude-sonnet-4-5" },
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      success: true,
      taskId: "exec:message-1",
    });
    const snapshot = await getExecutionTaskStatus("exec:message-1");
    expect(snapshot?.agentId).toBe("agent-1");
    expect(snapshot?.conversationId).toBe("conversation-1");
    expect(snapshot?.metadata).toEqual({ model: "claude-sonnet-4-5" });
  });

  test("rejects event identity that does not match the worker token", async () => {
    const router = createExecutionEventRoutes();
    const res = await router.request("/internal/execution-events", {
      method: "POST",
      headers: {
        authorization: `Bearer ${workerToken({ conversationId: "conversation-1" })}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        action: "create",
        taskId: "exec:message-1",
        agentId: "agent-1",
        conversationId: "conversation-2",
      }),
    });

    expect(res.status).toBe(400);
  });

  test("records tool and terminal events", async () => {
    await createExecutionTask({
      id: "exec:message-1",
      agentId: "agent-1",
      conversationId: "conversation-1",
      userId: "user-1",
      source: "line",
    });
    const router = createExecutionEventRoutes();

    const toolRes = await router.request("/internal/execution-events", {
      method: "POST",
      headers: {
        authorization: `Bearer ${workerToken()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        action: "record",
        taskId: "exec:message-1",
        type: "tool.completed",
        message: "Tool completed: gws_docs_read",
        payload: { name: "gws_docs_read" },
        status: "running",
      }),
    });
    expect(toolRes.status).toBe(200);

    const doneRes = await router.request("/internal/execution-events", {
      method: "POST",
      headers: {
        authorization: `Bearer ${workerToken()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        action: "record",
        taskId: "exec:message-1",
        type: "agent.completed",
        status: "completed",
        finalSummary: { outputChars: 12 },
      }),
    });
    expect(doneRes.status).toBe(200);

    const snapshot = await getExecutionTaskStatus("exec:message-1");
    expect(snapshot?.status).toBe("completed");
    expect(snapshot?.events.map((event) => event.type)).toEqual([
      "tool.completed",
      "agent.completed",
    ]);
  });

  test("rejects recording to a task owned by another worker scope", async () => {
    await createExecutionTask({
      id: "exec:other-message",
      agentId: "agent-2",
      conversationId: "conversation-2",
      userId: "user-2",
      source: "line",
    });
    const router = createExecutionEventRoutes();

    const res = await router.request("/internal/execution-events", {
      method: "POST",
      headers: {
        authorization: `Bearer ${workerToken()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        action: "record",
        taskId: "exec:other-message",
        type: "agent.heartbeat",
        status: "running",
      }),
    });

    expect(res.status).toBe(403);
    const snapshot = await getExecutionTaskStatus("exec:other-message");
    expect(snapshot?.events).toEqual([]);
  });
});
