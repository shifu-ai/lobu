import { createHash } from "node:crypto";
import type { ReleaseCapabilityClaim } from "@lobu/core";
import { z } from "zod";

export const SUBAGENT_CAPABILITY = "agent.subagents.v1";

export const spawnSubagentSchema = z.object({
  backend: z.enum(["codex", "lobu"]),
  title: z.string().trim().min(1).max(200),
  prompt: z.string().trim().min(1).refine((value) => Buffer.byteLength(value) <= 65536),
  idempotencyKey: z.string().trim().min(1).max(200),
  timeoutSeconds: z.number().int().min(10).max(1800).default(600),
}).strict();

export type SpawnSubagentInput = z.input<typeof spawnSubagentSchema>;
export type SubagentBackend = "codex" | "lobu";
export type SubagentStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "timed_out";

// 只能由已驗證的 run 身分建立，不能從模型 request body 解構。
export interface SubagentScope {
  organizationId: string;
  userId: string;
  agentId: string;
  parentConversationId: string;
  parentRunId: string;
  parentMessageId?: string;
}

export interface SubagentResult {
  summary: string;
  artifacts: Array<{ id?: string; path: string; mediaType: string; size: number }>;
}

export interface SubagentTask extends SubagentScope {
  id: string;
  /** Current dispatcher runs row; supplied only by the queue consumer. */
  executionRunId?: number;
  authorization?: ReleaseCapabilityClaim | null;
  backend: SubagentBackend;
  title: string;
  prompt: string;
  childConversationId: string;
  status: SubagentStatus;
  generation: number;
  deadlineAt: string;
  result: SubagentResult | null;
  errorCode: string | null;
}

export interface SubagentDelivery extends SubagentTask {
  deliveryId: string;
  deliveryGeneration: number;
}

export function subagentTaskView(task: SubagentTask, includeResult = true) {
  return { id: task.id, backend: task.backend, title: task.title, status: task.status,
    parentConversationId: task.parentConversationId, childConversationId: task.childConversationId,
    parentMessageId: task.parentMessageId ?? null,
    deadlineAt: task.deadlineAt, errorCode: task.errorCode,
    ...(includeResult ? { result: task.result } : {}) };
}

export function requestDigest(input: z.output<typeof spawnSubagentSchema>): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export function validateResult(result: SubagentResult): void {
  if (typeof result.summary !== "string" || !Array.isArray(result.artifacts) ||
      Buffer.byteLength(JSON.stringify(result)) > 262144 ||
      result.artifacts.some((artifact) =>
        !artifact.path || artifact.path.startsWith("/") || artifact.path.includes("\\") ||
        artifact.path.split("/").includes("..") ||
        typeof artifact.mediaType !== "string" || !Number.isSafeInteger(artifact.size) || artifact.size < 0)) {
    throw new Error("invalid_subagent_result");
  }
}
