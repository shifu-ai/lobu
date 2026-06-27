import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  createExecutionTask,
  getExecutionTaskStatus,
  recordExecutionEvent,
} from "../execution/execution-events.js";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
} from "./helpers/db-setup.js";

describe("execution event store", () => {
  beforeAll(async () => {
    await ensureDbForGatewayTests();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  test("creates a task and returns a compact status with oldest-first recent events", async () => {
    const task = await createExecutionTask({
      id: "task-1",
      agentId: "agent-1",
      sessionId: "session-1",
      conversationId: "conversation-1",
      userId: "user-1",
      source: "line",
      metadata: { lineMessageId: "msg-1" },
    });

    expect(task).toMatchObject({
      id: "task-1",
      agentId: "agent-1",
      sessionId: "session-1",
      conversationId: "conversation-1",
      userId: "user-1",
      source: "line",
      status: "running",
      metadata: { lineMessageId: "msg-1" },
    });

    await recordExecutionEvent({
      taskId: "task-1",
      type: "assistant.delta",
      message: "Starting",
      payload: { step: 1 },
    });
    await recordExecutionEvent({
      taskId: "task-1",
      type: "tool.wait",
      status: "waiting_for_tool",
      message: "Waiting for approval",
      payload: { toolName: "docs_create" },
    });

    const status = await getExecutionTaskStatus("task-1");

    expect(status).toMatchObject({
      id: "task-1",
      agentId: "agent-1",
      sessionId: "session-1",
      conversationId: "conversation-1",
      userId: "user-1",
      source: "line",
      status: "waiting_for_tool",
      finalSummary: null,
      error: null,
      metadata: { lineMessageId: "msg-1" },
    });
    expect(status?.events.map((event) => event.type)).toEqual([
      "assistant.delta",
      "tool.wait",
    ]);
    expect(status?.events[0]).toMatchObject({
      message: "Starting",
      payload: { step: 1 },
    });
  });

  test("marks a task terminal when recording completed or failed events", async () => {
    await createExecutionTask({
      id: "task-terminal",
      agentId: "agent-1",
      source: "api",
    });

    await recordExecutionEvent({
      taskId: "task-terminal",
      type: "assistant.completed",
      status: "completed",
      message: "Done",
      finalSummary: { text: "Finished safely" },
    });

    const completed = await getExecutionTaskStatus("task-terminal");
    expect(completed).toMatchObject({
      status: "completed",
      finalSummary: { text: "Finished safely" },
      error: null,
    });
    expect(completed?.completedAt).toBeTruthy();

    await createExecutionTask({
      id: "task-failed",
      agentId: "agent-1",
      source: "api",
    });
    await recordExecutionEvent({
      taskId: "task-failed",
      type: "assistant.failed",
      status: "failed",
      error: { code: "tool_error", message: "Tool failed" },
    });

    const failed = await getExecutionTaskStatus("task-failed");
    expect(failed).toMatchObject({
      status: "failed",
      finalSummary: null,
      error: { code: "tool_error", message: "Tool failed" },
    });
    expect(failed?.completedAt).toBeTruthy();
  });

  test("requires a task to exist before recording an event", async () => {
    await expect(
      recordExecutionEvent({
        taskId: "missing-task",
        type: "assistant.delta",
        message: "No implicit task creation",
      })
    ).rejects.toThrow(/execution task not found/i);
  });

  test("returns null for a missing task", async () => {
    await expect(getExecutionTaskStatus("missing-task")).resolves.toBeNull();
  });
});
