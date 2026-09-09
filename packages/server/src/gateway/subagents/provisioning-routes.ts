import { Hono, type Context } from "hono";
import { z } from "zod";
import type { Env } from "../../index";
import { getDb, type DbClient } from "../../db/client";
import { requireAdminPat } from "../../lobu/provisioning-auth";
import type { IMessageQueue } from "../infrastructure/queue/types";
import { CodexAuthStore } from "./codex-auth-store";
import { enqueueCodexLogin } from "./codex-auth-scheduler";
import { CodexCredentialStore } from "./codex-credentials";
import { SubagentStore } from "./store";
import { subagentTaskView } from "./types";
import { getSubagentParentCompletion } from "./parent-completion";
import { SubagentArtifactStore } from "./artifacts";

const ownerSchema = z.object({ userId: z.string().trim().min(1).max(256) }).strict();
const idSchema = z.string().uuid();

/** Toolbox service PAT; the personal agent owner is checked inside this organization. */
export function createSubagentProvisioningRoutes(options: { queue?: IMessageQueue; sql?: DbClient } = {}) {
  const app = new Hono<{ Bindings: Env }>();
  const database = () => options.sql ?? getDb();
  async function owner(c: Context<{ Bindings: Env }>) {
    const denied = requireAdminPat(c);
    if (denied) return denied;
    const parsed = ownerSchema.safeParse(c.req.method === "GET" ? { userId: c.req.query("userId") } : await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_owner_request" }, 400);
    const agentId = c.req.param("agentId") ?? "";
    const organizationId = c.get("organizationId") as string | null;
    if (!organizationId) return c.json({ error: "organization_required" }, 403);
    const sql = database();
    const rows = await sql`SELECT 1 FROM agents WHERE organization_id=${organizationId} AND id=${agentId}
      AND owner_platform='toolbox' AND owner_user_id=${parsed.data.userId}`;
    if (rows.length !== 1) return c.json({ error: "agent_owner_mismatch" }, 404);
    c.header("Cache-Control", "no-store");
    return { organizationId, agentId, userId: parsed.data.userId };
  }
  app.onError(() => new Response(JSON.stringify({ error: "subagent_service_unavailable" }), { status: 503, headers: { "content-type": "application/json", "cache-control": "no-store" } }));
  app.get("/agents/:agentId/subagents", async (c) => {
    const scope = await owner(c); if (scope instanceof Response) return scope;
    const parentMessageId = c.req.query("parentMessageId");
    if (parentMessageId !== undefined && (!parentMessageId.trim() || parentMessageId.length > 256)) return c.json({ error: "invalid_parent_message_id" }, 400);
    const tasks = await new SubagentStore(database()).listForOwner(scope, parentMessageId);
    return c.json({ tasks: tasks.map((task) => subagentTaskView(task, false)) });
  });
  app.get("/agents/:agentId/subagents/tasks/:taskId", async (c) => {
    const scope = await owner(c); if (scope instanceof Response) return scope;
    const id = idSchema.safeParse(c.req.param("taskId")); if (!id.success) return c.json({ error: "invalid_task_id" }, 400);
    const task = await new SubagentStore(database()).getForOwner(scope, id.data);
    return task ? c.json({ task: subagentTaskView(task) }) : c.json({ error: "task_not_found" }, 404);
  });
  app.post("/agents/:agentId/subagents/tasks/:taskId/cancel", async (c) => {
    const scope = await owner(c); if (scope instanceof Response) return scope;
    const id = idSchema.safeParse(c.req.param("taskId")); if (!id.success) return c.json({ error: "invalid_task_id" }, 400);
    const store = new SubagentStore(database());
    const task = await store.getForOwner(scope, id.data);
    if (!task) return c.json({ error: "task_not_found" }, 404);
    return c.json({ task: subagentTaskView((await store.cancel(task, task.id))!) });
  });
  app.get("/agents/:agentId/subagents/tasks/:taskId/parent-completion", async (c) => {
    const scope = await owner(c); if (scope instanceof Response) return scope;
    const id = idSchema.safeParse(c.req.param("taskId")); if (!id.success) return c.json({ error: "invalid_task_id" }, 400);
    const task = await new SubagentStore(database()).getForOwner(scope, id.data);
    if (!task) return c.json({ error: "task_not_found" }, 404);
    return c.json({ completion: await getSubagentParentCompletion(database(), task) });
  });
  app.get("/agents/:agentId/subagents/tasks/:taskId/artifacts/:artifactId", async (c) => {
    const scope = await owner(c); if (scope instanceof Response) return scope;
    const taskId = idSchema.safeParse(c.req.param("taskId")); const artifactId = idSchema.safeParse(c.req.param("artifactId"));
    if (!taskId.success || !artifactId.success) return c.json({ error: "invalid_artifact_id" }, 400);
    const task = await new SubagentStore(database()).getForOwner(scope, taskId.data);
    if (!task) return c.json({ error: "task_not_found" }, 404);
    const artifact = await new SubagentArtifactStore(database()).get(task, artifactId.data);
    return artifact ? c.json({ artifact }) : c.json({ error: "artifact_not_found" }, 404);
  });
  app.get("/agents/:agentId/subagents/codex", async (c) => {
    const scope = await owner(c); if (scope instanceof Response) return scope;
    const sql = database();
    const [row] = await sql<{ connected: boolean }>`SELECT credential_ciphertext IS NOT NULL AS connected FROM subagent_codex_accounts
      WHERE organization_id=${scope.organizationId} AND user_id=${scope.userId}`;
    return c.json({ connected: row?.connected ?? false, available: Boolean(process.env.CODEX_BINARY) });
  });
  app.post("/agents/:agentId/subagents/codex/connect", async (c) => {
    const scope = await owner(c); if (scope instanceof Response) return scope;
    if (!process.env.CODEX_BINARY) return c.json({ error: "codex_runtime_unavailable" }, 503);
    const flow = await new CodexAuthStore(database()).start(scope);
    if (options.queue) await enqueueCodexLogin(options.queue, flow.id).catch(() => {});
    return c.json({ flow: { id: flow.id, status: flow.status, expiresAt: flow.expiresAt } }, 202);
  });
  app.get("/agents/:agentId/subagents/codex/connect/:flowId", async (c) => {
    const scope = await owner(c); if (scope instanceof Response) return scope;
    const id = idSchema.safeParse(c.req.param("flowId")); if (!id.success) return c.json({ error: "invalid_flow_id" }, 400);
    const flow = await new CodexAuthStore(database()).get(scope, id.data);
    return flow ? c.json({ flow: { id: flow.id, status: flow.status, expiresAt: flow.expiresAt,
      userCode: flow.userCode, verificationUrl: flow.verificationUrl, errorCode: flow.errorCode } }) : c.json({ error: "flow_not_found" }, 404);
  });
  app.post("/agents/:agentId/subagents/codex/disconnect", async (c) => {
    const scope = await owner(c); if (scope instanceof Response) return scope;
    await new CodexCredentialStore(database()).disconnect(scope);
    return c.json({ connected: false });
  });
  return app;
}
