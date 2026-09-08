import type { WorkerTokenData } from "@lobu/core";
import { setTimeout as delay } from "node:timers/promises";
import { Hono } from "hono";
import { z } from "zod";
import { authenticateWorker } from "../routes/internal/middleware";
import type { WorkerContext } from "../routes/internal/types";
import type { SubagentStore } from "./store";
import { SUBAGENT_CAPABILITY, spawnSubagentSchema, subagentTaskView, type SubagentScope } from "./types";

const taskIdSchema = z.string().uuid();
const waitSchema = z.object({ taskIds: z.array(taskIdSchema).min(1).max(8),
  timeoutSeconds: z.number().int().min(0).max(25).default(20) }).strict();

export function scopeFromWorker(worker: WorkerTokenData): SubagentScope | null {
  if (worker.tokenKind !== "run" || !worker.organizationId || !worker.agentId ||
      !worker.userId || !worker.conversationId || !Number.isSafeInteger(worker.runId) || worker.runId! <= 0) return null;
  return { organizationId: worker.organizationId, userId: worker.userId, agentId: worker.agentId,
    parentConversationId: worker.conversationId, parentRunId: String(worker.runId),
    ...(worker.messageId ? { parentMessageId: worker.messageId } : {}) };
}

export function maySpawnSubagent(worker: WorkerTokenData, now = Date.now()): boolean {
  const state = worker.releaseState;
  return state?.status === "active" && state.claim.agentId === worker.agentId &&
    state.claim.toolboxUserId === worker.userId && Date.parse(state.claim.expiresAt) > now &&
    state.claim.capabilityIds.includes(SUBAGENT_CAPABILITY);
}

export function createSubagentRoutes(store: SubagentStore, onCreated?: (id: string) => Promise<unknown>): Hono<WorkerContext> {
  const app = new Hono<WorkerContext>();
  app.use("/internal/subagents/*", authenticateWorker);
  app.use("/internal/subagents", authenticateWorker);
  app.post("/internal/subagents", async (c) => {
    const worker = c.get("worker") as WorkerTokenData;
    const scope = scopeFromWorker(worker);
    if (!scope) return c.json({ error: "run_identity_required" }, 403);
    if (!maySpawnSubagent(worker)) return c.json({ error: "subagent_capability_inactive" }, 403);
    const request = spawnSubagentSchema.safeParse(await c.req.json().catch(() => null));
    if (!request.success) return c.json({ error: "invalid_subagent_request" }, 400);
    try {
      const task = await store.spawn(scope, request.data, worker.releaseState?.status === "active" ? worker.releaseState.claim : null);
      // Persistence is the acceptance boundary. Reconciliation retries a failed fast dispatch.
      await onCreated?.(task.id).catch(() => {});
      return c.json({ task: subagentTaskView(task) }, 202);
    }
    catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (["idempotency_conflict", "subagent_child_limit"].includes(code)) return c.json({ error: code }, 409);
      if (code === "subagent_recursion_denied") return c.json({ error: code }, 403);
      return c.json({ error: "subagent_unavailable" }, 503);
    }
  });
  app.get("/internal/subagents", async (c) => {
    const scope = scopeFromWorker(c.get("worker") as WorkerTokenData);
    if (!scope) return c.json({ error: "run_identity_required" }, 403);
    return c.json({ tasks: (await store.list(scope)).map((task) => subagentTaskView(task, false)) });
  });
  app.post("/internal/subagents/wait", async (c) => {
    const scope = scopeFromWorker(c.get("worker") as WorkerTokenData);
    if (!scope) return c.json({ error: "run_identity_required" }, 403);
    const request = waitSchema.safeParse(await c.req.json().catch(() => null));
    if (!request.success) return c.json({ error: "invalid_subagent_request" }, 400);
    const expires = Date.now() + request.data.timeoutSeconds * 1000;
    while (!c.req.raw.signal.aborted) {
      const tasks = await Promise.all(request.data.taskIds.map((id) => store.get(scope, id)));
      if (tasks.some((task) => !task)) return c.json({ error: "task_not_found" }, 404);
      const completed = tasks.filter((task) => task && !["queued", "running"].includes(task.status));
      if (completed.length || Date.now() >= expires) {
        for (const task of completed) await store.observeCompletion(scope, task!.id);
        return c.json({ tasks: tasks.map((task) => subagentTaskView(task!)), timedOut: completed.length === 0 });
      }
      await delay(Math.min(500, expires - Date.now()), undefined, { signal: c.req.raw.signal }).catch(() => {});
    }
    return c.json({ error: "wait_aborted" }, 408);
  });
  app.get("/internal/subagents/:taskId", async (c) => {
    const scope = scopeFromWorker(c.get("worker") as WorkerTokenData);
    if (!scope) return c.json({ error: "run_identity_required" }, 403);
    const id = taskIdSchema.safeParse(c.req.param("taskId"));
    if (!id.success) return c.json({ error: "invalid_task_id" }, 400);
    const task = await store.get(scope, id.data);
    return task ? c.json({ task: subagentTaskView(task) }) : c.json({ error: "task_not_found" }, 404);
  });
  app.post("/internal/subagents/:taskId/cancel", async (c) => {
    const scope = scopeFromWorker(c.get("worker") as WorkerTokenData);
    if (!scope) return c.json({ error: "run_identity_required" }, 403);
    const id = taskIdSchema.safeParse(c.req.param("taskId"));
    if (!id.success) return c.json({ error: "invalid_task_id" }, 400);
    const task = await store.cancel(scope, id.data);
    return task ? c.json({ task: subagentTaskView(task) }) : c.json({ error: "task_not_found" }, 404);
  });
  return app;
}
