import { createLogger } from "@lobu/core";
import { Hono } from "hono";
import {
  createExecutionTask,
  createExecutionTaskIdempotent,
  getExecutionTaskStatus,
  recordExecutionEvent,
  type ExecutionTaskStatus,
} from "../../execution/execution-events.js";
import { errorResponse, getVerifiedWorker } from "../shared/helpers.js";
import { authenticateWorker } from "./middleware.js";
import type { WorkerContext } from "./types.js";
import { getDb } from "../../../db/client.js";
import {
  createPostgresEffectiveToolInventoryStore,
  recordAgentEffectiveToolInventoryTruth,
  type EffectiveToolInventoryStore,
} from "../../../lobu/release-assurance-readback.js";

const logger = createLogger("internal-execution-events-routes");

const EXECUTION_STATUSES = new Set<ExecutionTaskStatus>([
  "running",
  "waiting_for_tool",
  "completed",
  "failed",
  "cancelled",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function readOptionalRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  return value === undefined ? undefined : isRecord(value) ? value : undefined;
}

function readOptionalStatus(value: unknown): ExecutionTaskStatus | undefined {
  return typeof value === "string" &&
    EXECUTION_STATUSES.has(value as ExecutionTaskStatus)
    ? (value as ExecutionTaskStatus)
    : undefined;
}

function workerScopeMatches(
  worker: WorkerContext["Variables"]["worker"],
  body: Record<string, unknown>,
): boolean {
  const conversationId = readNonEmptyString(body.conversationId);
  const agentId = readNonEmptyString(body.agentId);
  const userId = readNonEmptyString(body.userId);

  if (conversationId && conversationId !== worker.conversationId) {
    return false;
  }
  if (worker.agentId && agentId && agentId !== worker.agentId) {
    return false;
  }
  if (userId && userId !== worker.userId) {
    return false;
  }
  return true;
}

function taskScopeMatchesWorker(
  worker: WorkerContext["Variables"]["worker"],
  task: {
    agentId: string;
    conversationId: string | null;
    userId: string | null;
  },
): boolean {
  if (worker.agentId && task.agentId !== worker.agentId) {
    return false;
  }
  if (task.conversationId && task.conversationId !== worker.conversationId) {
    return false;
  }
  if (task.userId && task.userId !== worker.userId) {
    return false;
  }
  return true;
}

export function createExecutionEventRoutes(
  options: {
    inventoryStore?: EffectiveToolInventoryStore;
    createTask?: typeof createExecutionTask;
    sql?: ReturnType<typeof getDb>;
    now?: () => Date;
  } = {},
): Hono<WorkerContext> {
  const router = new Hono<WorkerContext>();

  router.post("/internal/execution-events", authenticateWorker, async (c) => {
    try {
      const worker = getVerifiedWorker(c);
      const body = await c.req.json();
      if (!isRecord(body)) {
        return errorResponse(
          c,
          "Execution event request must be an object",
          400,
        );
      }
      if (!workerScopeMatches(worker, body)) {
        return errorResponse(
          c,
          "Execution event identity does not match worker token",
          400,
        );
      }

      const action = readNonEmptyString(body.action);
      const taskId = readNonEmptyString(body.taskId);
      if (!action || !taskId) {
        return errorResponse(
          c,
          "Execution event request requires action and taskId",
          400,
        );
      }

      if (action === "create") {
        const agentId = readNonEmptyString(body.agentId) ?? worker.agentId;
        if (!agentId) {
          return errorResponse(c, "Execution task requires agentId", 400);
        }
        const taskInput = {
          id: taskId,
          agentId,
          sessionId: readNonEmptyString(body.sessionId),
          conversationId:
            readNonEmptyString(body.conversationId) ?? worker.conversationId,
          userId: readNonEmptyString(body.userId) ?? worker.userId,
          source:
            readNonEmptyString(body.source) ?? worker.platform ?? "worker",
          status: readOptionalStatus(body.status) ?? "running",
          metadata: readOptionalRecord(body.metadata) ?? {},
        };
        const inventory = readEffectiveInventory(body.metadata);
        if (inventory) {
          if (
            !worker.organizationId ||
            !worker.agentId ||
            worker.releaseState?.status !== "active"
          ) {
            return errorResponse(
              c,
              "Effective inventory authority is not active",
              403,
            );
          }
          const claim = worker.releaseState.claim;
          const observedAt = options.now?.() ?? new Date();
          const inventoryInput = {
            organizationId: worker.organizationId,
            agentId: worker.agentId,
            releaseId: claim.releaseId,
            releaseSequence: claim.releaseSequence,
            capabilitySnapshotDigest: claim.snapshotDigest,
            snapshotAuthority: taskId,
            toolNames: inventory.names,
            fingerprint: inventory.fingerprint,
          };
          try {
            let task;
            if (options.createTask || options.inventoryStore) {
              task = await (options.createTask ?? createExecutionTask)(
                taskInput,
              );
              await (
                options.inventoryStore ??
                createPostgresEffectiveToolInventoryStore(getDb())
              ).write(inventoryInput, observedAt);
            } else {
              const sql = options.sql ?? getDb();
              task = await sql.begin(async (tx) => {
                const created = await createExecutionTaskIdempotent(
                  taskInput,
                  tx,
                );
                await recordAgentEffectiveToolInventoryTruth(
                  inventoryInput,
                  tx,
                  observedAt,
                );
                return created;
              });
            }
            return c.json({ success: true, taskId: task.id });
          } catch (error) {
            logger.warn("Rejected effective tool inventory snapshot:", error);
            return errorResponse(
              c,
              "Effective inventory authority is not current",
              409,
            );
          }
        }
        const task = await (
          options.createTask ?? createExecutionTaskIdempotent
        )(taskInput);
        return c.json({ success: true, taskId: task.id });
      }

      if (action === "record") {
        const type = readNonEmptyString(body.type);
        if (!type) {
          return errorResponse(c, "Execution event record requires type", 400);
        }
        const task = await getExecutionTaskStatus(taskId, { limit: 1 });
        if (!task) {
          return errorResponse(c, "Execution task not found", 404);
        }
        if (!taskScopeMatchesWorker(worker, task)) {
          return errorResponse(
            c,
            "Execution task does not match worker token",
            403,
          );
        }
        const event = await recordExecutionEvent({
          taskId,
          type,
          message: readNonEmptyString(body.message),
          payload: readOptionalRecord(body.payload),
          status: readOptionalStatus(body.status),
          finalSummary: body.finalSummary,
          error: body.error,
        });
        return c.json({ success: true, eventId: event.id });
      }

      return errorResponse(c, "Unsupported execution event action", 400);
    } catch (error) {
      logger.warn("Failed to record execution event:", error);
      const message =
        error instanceof Error
          ? error.message
          : "Invalid execution event request";
      return errorResponse(c, message, 400);
    }
  });

  logger.debug("Internal execution event routes registered");
  return router;
}

function readEffectiveInventory(
  metadata: unknown,
): { names: string[]; fingerprint: string } | null {
  if (!isRecord(metadata) || !isRecord(metadata.effectiveToolInventory))
    return null;
  const value = metadata.effectiveToolInventory;
  if (
    !Array.isArray(value.names) ||
    value.names.length > 256 ||
    !value.names.every((name) => typeof name === "string") ||
    typeof value.fingerprint !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.fingerprint)
  )
    return null;
  return { names: value.names, fingerprint: `sha256:${value.fingerprint}` };
}
