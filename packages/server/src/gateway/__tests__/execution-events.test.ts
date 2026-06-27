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
    expect(status).toMatchObject({
      hasMoreEvents: false,
      eventsTruncated: false,
      nextCursor: expect.any(Number),
    });
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

  test("does not let late non-terminal events revive terminal tasks", async () => {
    await createExecutionTask({
      id: "task-no-revive",
      agentId: "agent-1",
      source: "api",
    });

    await recordExecutionEvent({
      taskId: "task-no-revive",
      type: "assistant.completed",
      status: "completed",
      finalSummary: { text: "done" },
    });
    const terminal = await getExecutionTaskStatus("task-no-revive");

    await recordExecutionEvent({
      taskId: "task-no-revive",
      type: "tool.wait",
      status: "waiting_for_tool",
      payload: { toolName: "docs_create" },
    });

    const status = await getExecutionTaskStatus("task-no-revive");
    expect(status).toMatchObject({
      status: "completed",
      completedAt: terminal?.completedAt,
      finalSummary: { text: "done" },
      error: null,
    });
  });

  test("supports cursor pagination with oldest-first events and truncation signals", async () => {
    await createExecutionTask({
      id: "task-cursor",
      agentId: "agent-1",
      source: "api",
    });

    for (const step of [1, 2, 3]) {
      await recordExecutionEvent({
        taskId: "task-cursor",
        type: "assistant.delta",
        payload: { step },
      });
    }

    const firstPage = await getExecutionTaskStatus("task-cursor", { limit: 2 });
    expect(firstPage?.events.map((event) => event.payload.step)).toEqual([
      2,
      3,
    ]);
    expect(firstPage).toMatchObject({
      hasMoreEvents: true,
      eventsTruncated: true,
      nextCursor: firstPage?.events[1]?.id,
    });

    const nextPage = await getExecutionTaskStatus("task-cursor", {
      afterEventId: firstPage?.events[0]?.id,
      limit: 1,
    });
    expect(nextPage?.events.map((event) => event.payload.step)).toEqual([3]);
    expect(nextPage).toMatchObject({
      hasMoreEvents: false,
      eventsTruncated: false,
      nextCursor: nextPage?.events[0]?.id,
    });
  });

  test("stores safe summaries for oversized event payloads and terminal fields", async () => {
    await createExecutionTask({
      id: "task-large-payload",
      agentId: "agent-1",
      source: "api",
    });

    const oversized = "x".repeat(70 * 1024);
    await recordExecutionEvent({
      taskId: "task-large-payload",
      type: "assistant.completed",
      status: "completed",
      payload: { oversized },
      finalSummary: { oversized },
      error: { oversized },
    });

    const status = await getExecutionTaskStatus("task-large-payload");
    expect(status?.events[0]?.payload).toEqual({
      truncated: true,
      originalBytes: expect.any(Number),
    });
    expect(status?.finalSummary).toEqual({
      truncated: true,
      originalBytes: expect.any(Number),
    });
    expect(status?.error).toEqual({
      truncated: true,
      originalBytes: expect.any(Number),
    });
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
