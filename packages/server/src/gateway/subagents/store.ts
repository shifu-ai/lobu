import type { ReleaseCapabilityClaim } from "@lobu/core";
import { randomUUID } from "node:crypto";
import type { DbClient } from "../../db/client";
import {
  requestDigest, spawnSubagentSchema, validateResult,
  type SpawnSubagentInput, type SubagentScope, type SubagentTask,
  type SubagentResult, type SubagentDelivery,
} from "./types";

interface TaskRow {
  id: string; organization_id: string; user_id: string; agent_id: string;
  parent_conversation_id: string; parent_run_id: string; child_conversation_id: string;
  parent_message_id: string | null;
  authorization_claim: ReleaseCapabilityClaim | null;
  request_digest: string; backend: SubagentTask["backend"]; title: string; prompt: string;
  status: SubagentTask["status"]; generation: number; deadline_at: Date | string;
  result: SubagentResult | null; error_code: string | null; delivery_generation: number;
}

function map(row: TaskRow): SubagentTask {
  return {
    authorization: row.authorization_claim,
    id: row.id, organizationId: row.organization_id, userId: row.user_id, agentId: row.agent_id,
    parentConversationId: row.parent_conversation_id, parentRunId: row.parent_run_id,
    ...(row.parent_message_id ? { parentMessageId: row.parent_message_id } : {}),
    childConversationId: row.child_conversation_id, backend: row.backend, title: row.title,
    prompt: row.prompt, status: row.status, generation: row.generation,
    deadlineAt: new Date(row.deadline_at).toISOString(), result: row.result, errorCode: row.error_code,
  };
}

export class SubagentStore {
  private readonly maxConcurrent: number;
  private readonly maxChildren: number;
  constructor(private readonly sql: DbClient, limits: { maxConcurrentPerUser?: number; maxChildrenPerRun?: number } = {}) {
    this.maxConcurrent = limits.maxConcurrentPerUser ?? 3;
    this.maxChildren = limits.maxChildrenPerRun ?? 8;
    if (![this.maxConcurrent, this.maxChildren].every((n) => Number.isSafeInteger(n) && n > 0 && n <= 100)) throw new Error("invalid_subagent_limits");
  }

  async spawn(scope: SubagentScope, input: SpawnSubagentInput, authorization: ReleaseCapabilityClaim | null = null): Promise<SubagentTask> {
    const request = spawnSubagentSchema.parse(input);
    if (Object.values(scope).some((value) => typeof value !== "string" || !value.trim())) throw new Error("invalid_subagent_scope");
    return this.sql.begin(async (sql) => {
      await this.lockOwner(sql, scope);
      const [existing] = await sql<TaskRow>`SELECT * FROM subagent_tasks
        WHERE organization_id = ${scope.organizationId} AND user_id = ${scope.userId}
          AND agent_id = ${scope.agentId} AND parent_conversation_id = ${scope.parentConversationId}
          AND parent_run_id = ${scope.parentRunId} AND idempotency_key = ${request.idempotencyKey}`;
      if (existing) {
        if (existing.request_digest !== requestDigest(request)) throw new Error("idempotency_conflict");
        return map(existing);
      }
      const [count] = await sql<{ n: number }>`SELECT count(*)::int AS n FROM subagent_tasks
        WHERE organization_id = ${scope.organizationId} AND user_id = ${scope.userId}
          AND agent_id = ${scope.agentId} AND parent_run_id = ${scope.parentRunId}
          AND parent_conversation_id = ${scope.parentConversationId}`;
      if ((count?.n ?? 0) >= this.maxChildren) throw new Error("subagent_child_limit");
      const [child] = await sql`SELECT id FROM subagent_tasks
        WHERE child_conversation_id = ${scope.parentConversationId} LIMIT 1`;
      if (child) throw new Error("subagent_recursion_denied");
      const id = randomUUID();
      const [row] = await sql<TaskRow>`INSERT INTO subagent_tasks
        (id, organization_id, user_id, agent_id, parent_conversation_id, parent_run_id, parent_message_id,
         idempotency_key, request_digest, authorization_claim, backend, title, prompt, child_conversation_id, deadline_at)
        VALUES (${id}, ${scope.organizationId}, ${scope.userId}, ${scope.agentId},
          ${scope.parentConversationId}, ${scope.parentRunId}, ${scope.parentMessageId ?? null}, ${request.idempotencyKey},
          ${requestDigest(request)}, ${sql.json(authorization)}, ${request.backend}, ${request.title}, ${request.prompt},
          ${`subagent:${id}`}, now() + ${request.timeoutSeconds} * interval '1 second') RETURNING *`;
      return map(row!);
    });
  }

  async get(scope: SubagentScope, id: string): Promise<SubagentTask | null> {
    const [row] = await this.sql<TaskRow>`SELECT * FROM subagent_tasks WHERE id = ${id}
      AND organization_id = ${scope.organizationId} AND user_id = ${scope.userId}
      AND agent_id = ${scope.agentId} AND parent_conversation_id = ${scope.parentConversationId}`;
    return row ? map(row) : null;
  }

  async list(scope: SubagentScope): Promise<SubagentTask[]> {
    const rows = await this.sql<TaskRow>`SELECT * FROM subagent_tasks
      WHERE organization_id = ${scope.organizationId} AND user_id = ${scope.userId}
      AND agent_id = ${scope.agentId} AND parent_conversation_id = ${scope.parentConversationId}
      ORDER BY created_at DESC LIMIT 100`;
    return rows.map(map);
  }

  async listForOwner(scope: Pick<SubagentScope, "organizationId" | "userId" | "agentId">, parentMessageId?: string): Promise<SubagentTask[]> {
    const rows = await this.sql<TaskRow>`SELECT * FROM subagent_tasks WHERE organization_id=${scope.organizationId}
      AND user_id=${scope.userId} AND agent_id=${scope.agentId}
      AND (${parentMessageId ?? null}::text IS NULL OR parent_message_id=${parentMessageId ?? null})
      ORDER BY created_at DESC LIMIT 100`;
    return rows.map(map);
  }

  async getForOwner(scope: Pick<SubagentScope, "organizationId" | "userId" | "agentId">, id: string): Promise<SubagentTask | null> {
    const [row] = await this.sql<TaskRow>`SELECT * FROM subagent_tasks WHERE id=${id}
      AND organization_id=${scope.organizationId} AND user_id=${scope.userId} AND agent_id=${scope.agentId}`;
    return row ? map(row) : null;
  }

  async pendingIds(): Promise<string[]> {
    const rows = await this.sql<{ id: string }>`SELECT id FROM subagent_tasks
      WHERE status = 'queued' OR (status = 'running' AND lease_until < now())
      ORDER BY created_at LIMIT 100`;
    return rows.map((row) => row.id);
  }

  async claim(id: string): Promise<SubagentTask | null> {
    return this.sql.begin(async (sql) => {
      const [candidate] = await sql<TaskRow>`SELECT * FROM subagent_tasks WHERE id = ${id}`;
      if (!candidate) return null;
      await this.lockOwner(sql, map(candidate));
      await sql`UPDATE subagent_tasks SET status = 'timed_out', completed_at = now(), updated_at = now(),
        lease_until = NULL, error_code = 'deadline_exceeded'
        WHERE id = ${id} AND status IN ('queued', 'running') AND deadline_at <= now()`;
      const [count] = await sql<{ n: number }>`SELECT count(*)::int AS n FROM subagent_tasks
        WHERE organization_id = ${candidate.organization_id} AND user_id = ${candidate.user_id}
          AND status = 'running' AND lease_until > now() AND deadline_at > now()`;
      if ((count?.n ?? 0) >= this.maxConcurrent) return null;
      const [row] = await sql<TaskRow>`UPDATE subagent_tasks SET status = 'running',
        generation = generation + 1, lease_until = now() + interval '30 seconds', updated_at = now()
        WHERE id = ${id} AND deadline_at > now()
          AND (status = 'queued' OR (status = 'running' AND lease_until < now())) RETURNING *`;
      return row ? map(row) : null;
    });
  }

  async heartbeat(task: SubagentTask): Promise<boolean> {
    const rows = await this.sql`UPDATE subagent_tasks SET lease_until = now() + interval '30 seconds', updated_at = now()
      WHERE id = ${task.id} AND generation = ${task.generation} AND status = 'running'
        AND lease_until > now() AND deadline_at > now() RETURNING id`;
    return rows.length === 1;
  }

  async complete(task: SubagentTask, result: SubagentResult): Promise<boolean> {
    validateResult(result);
    const rows = await this.sql`UPDATE subagent_tasks SET status = 'completed', result = ${this.sql.json(result)}::jsonb,
      completed_at = now(), updated_at = now(), lease_until = NULL
      WHERE id = ${task.id} AND generation = ${task.generation} AND status = 'running'
        AND lease_until > now() AND deadline_at > now() RETURNING id`;
    return rows.length === 1;
  }

  async fail(task: SubagentTask, errorCode: string): Promise<boolean> {
    const rows = await this.sql`UPDATE subagent_tasks SET
      status = CASE WHEN deadline_at <= now() THEN 'timed_out' ELSE 'failed' END,
      error_code = ${errorCode.slice(0, 100)}, completed_at = now(), updated_at = now(), lease_until = NULL
      WHERE id = ${task.id} AND generation = ${task.generation} AND status = 'running'
        AND lease_until > now() RETURNING id`;
    return rows.length === 1;
  }

  async cancel(scope: SubagentScope, id: string): Promise<SubagentTask | null> {
    await this.sql`UPDATE subagent_tasks SET status = 'cancelled', completed_at = now(), updated_at = now(), lease_until = NULL
      WHERE id = ${id} AND organization_id = ${scope.organizationId} AND user_id = ${scope.userId}
        AND agent_id = ${scope.agentId} AND parent_conversation_id = ${scope.parentConversationId}
        AND status IN ('queued', 'running')`;
    return this.get(scope, id);
  }

  async pendingDeliveryIds(): Promise<string[]> {
    const rows = await this.sql<{ id: string }>`SELECT id FROM subagent_tasks
      WHERE completed_at IS NOT NULL AND delivered_at IS NULL
        AND (delivery_lease_until IS NULL OR delivery_lease_until < now())
      ORDER BY completed_at LIMIT 100`;
    return rows.map((row) => row.id);
  }

  async claimDelivery(id: string): Promise<SubagentDelivery | null> {
    // An observed tool result counts as delivered only after that parent run succeeds.
    // If the parent crashes before it can use the result, the outbox still wakes it.
    await this.sql`UPDATE subagent_tasks SET delivered_at = now()
      WHERE id = ${id} AND completed_at IS NOT NULL AND delivered_at IS NULL
        AND EXISTS (SELECT 1 FROM execution_tasks e WHERE e.id = subagent_tasks.observed_execution_id
          AND e.agent_id = subagent_tasks.agent_id AND e.user_id = subagent_tasks.user_id
          AND e.conversation_id = subagent_tasks.parent_conversation_id AND e.status = 'completed')`;

    const [row] = await this.sql<TaskRow>`UPDATE subagent_tasks
      SET delivery_generation = delivery_generation + 1, delivery_lease_until = now() + interval '30 seconds'
      WHERE id = ${id} AND completed_at IS NOT NULL AND delivered_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.queue_name = 'internal:turn_timeout'
          AND r.action_input->>'conversationId' = subagent_tasks.parent_conversation_id
          AND r.action_input->>'userId' = subagent_tasks.user_id)
        AND (delivery_lease_until IS NULL OR delivery_lease_until < now()) RETURNING *`;
    return row ? { ...map(row), deliveryId: `subagent-completion:${row.id}`, deliveryGeneration: row.delivery_generation } : null;
  }

  async observeCompletion(scope: SubagentScope, id: string): Promise<boolean> {
    if (!scope.parentMessageId) return false;
    const rows = await this.sql`UPDATE subagent_tasks SET observed_execution_id = ${`exec:${scope.parentMessageId}`}
      WHERE id = ${id} AND organization_id = ${scope.organizationId} AND user_id = ${scope.userId}
        AND agent_id = ${scope.agentId} AND parent_conversation_id = ${scope.parentConversationId}
        AND completed_at IS NOT NULL AND delivered_at IS NULL
        AND (delivery_lease_until IS NULL OR delivery_lease_until < now()) RETURNING id`;
    return rows.length === 1;
  }

  async acknowledgeDelivery(task: SubagentDelivery): Promise<boolean> {
    const rows = await this.sql`UPDATE subagent_tasks SET delivered_at = now(), delivery_lease_until = NULL
      WHERE id = ${task.id} AND delivery_generation = ${task.deliveryGeneration}
        AND delivery_lease_until > now() AND delivered_at IS NULL RETURNING id`;
    return rows.length === 1;
  }

  private async lockOwner(sql: DbClient, scope: Pick<SubagentScope, "organizationId" | "userId">): Promise<void> {
    // 同 user 的入列與 claim 共用交易鎖，跨 agent／pod 仍遵守使用者併發上限。
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([scope.organizationId, scope.userId])}, 0))`;
  }
}
