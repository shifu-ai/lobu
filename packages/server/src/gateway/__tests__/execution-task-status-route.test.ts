import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { generateWorkerToken } from "@lobu/core";
import { createExecutionTaskStatusRoutes } from "../routes/public/execution-tasks.js";
import { ensureDbForGatewayTests } from "./helpers/db-setup.js";

describe("execution task status route", () => {
  let originalEncryptionKey: string | undefined;

  beforeAll(async () => {
    await ensureDbForGatewayTests();
  });

  beforeEach(() => {
    originalEncryptionKey = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  });

  afterEach(() => {
    if (originalEncryptionKey === undefined) {
      delete process.env.ENCRYPTION_KEY;
    } else {
      process.env.ENCRYPTION_KEY = originalEncryptionKey;
    }
  });

  test("returns 401 without bearer auth", async () => {
    const router = createExecutionTaskStatusRoutes({
      getStatus: async () => null,
    });

    const res = await router.request("/api/v1/execution-tasks/task-1/status");

    expect(res.status).toBe(401);
  });

  test("returns 404 when the task does not exist", async () => {
    const router = createExecutionTaskStatusRoutes({
      authorize: async () => true,
      getStatus: async () => null,
    });

    const res = await router.request("/api/v1/execution-tasks/missing/status", {
      headers: { Authorization: "Bearer test-token" },
    });

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({
      success: false,
      error: "Execution task not found",
    });
  });

  test("returns 403 for authenticated worker tokens without admin service scope", async () => {
    const getStatus = mock(async () => null);
    const router = createExecutionTaskStatusRoutes({ getStatus });
    const token = generateWorkerToken("user-1", "conversation-1", "deploy-1", {
      agentId: "agent-1",
      channelId: "line:U1",
      organizationId: "org-1",
    });

    const res = await router.request("/api/v1/execution-tasks/task-1/status", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      success: false,
      error: "Forbidden",
      error_description:
        "Execution task status requires an admin service token.",
    });
    expect(getStatus).not.toHaveBeenCalled();
  });

  test("returns compact task status JSON for admin service callers", async () => {
    const getStatus = mock(async (taskId: string) => ({
      id: taskId,
      agentId: "agent-1",
      sessionId: "session-1",
      conversationId: "conversation-1",
      userId: "user-1",
      source: "line",
      status: "running" as const,
      startedAt: "2026-06-27T00:00:00.000Z",
      lastEventAt: "2026-06-27T00:00:01.000Z",
      completedAt: null,
      finalSummary: null,
      error: null,
      metadata: {},
      hasMoreEvents: false,
      eventsTruncated: false,
      nextCursor: 1,
      events: [
        {
          id: 1,
          type: "assistant.delta",
          message: "Working",
          payload: { step: 1 },
          createdAt: "2026-06-27T00:00:01.000Z",
        },
      ],
    }));
    const router = createExecutionTaskStatusRoutes({
      authorize: async () => true,
      getStatus,
    });

    const res = await router.request("/api/v1/execution-tasks/task-1/status", {
      headers: { Authorization: "Bearer admin-service-token" },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      success: true,
      task: {
        id: "task-1",
        agentId: "agent-1",
        sessionId: "session-1",
        conversationId: "conversation-1",
        userId: "user-1",
        source: "line",
        status: "running",
        startedAt: "2026-06-27T00:00:00.000Z",
        lastEventAt: "2026-06-27T00:00:01.000Z",
        completedAt: null,
        finalSummary: null,
        error: null,
        metadata: {},
        hasMoreEvents: false,
        eventsTruncated: false,
        nextCursor: 1,
        events: [
          {
            id: 1,
            type: "assistant.delta",
            message: "Working",
            payload: { step: 1 },
            createdAt: "2026-06-27T00:00:01.000Z",
          },
        ],
      },
    });
    expect(getStatus).toHaveBeenCalledWith("task-1", {
      afterEventId: undefined,
      limit: undefined,
    });
  });

  test("passes cursor and bounded limit query params to status retrieval", async () => {
    const getStatus = mock(async (taskId: string) => ({
      id: taskId,
      agentId: "agent-1",
      sessionId: null,
      conversationId: null,
      userId: null,
      source: "line",
      status: "running" as const,
      startedAt: "2026-06-27T00:00:00.000Z",
      lastEventAt: "2026-06-27T00:00:01.000Z",
      completedAt: null,
      finalSummary: null,
      error: null,
      metadata: {},
      hasMoreEvents: true,
      eventsTruncated: false,
      nextCursor: 42,
      events: [],
    }));
    const router = createExecutionTaskStatusRoutes({
      authorize: async () => true,
      getStatus,
    });

    const res = await router.request(
      "/api/v1/execution-tasks/task-1/status?afterEventId=17&limit=500",
      { headers: { Authorization: "Bearer admin-service-token" } }
    );

    expect(res.status).toBe(200);
    expect(getStatus).toHaveBeenCalledWith("task-1", {
      afterEventId: 17,
      limit: 200,
    });
  });
});
