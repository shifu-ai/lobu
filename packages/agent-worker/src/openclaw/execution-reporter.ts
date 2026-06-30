import { createLogger, verifyWorkerToken } from "@lobu/core";

const logger = createLogger("execution-reporter");

export interface ExecutionReporter {
  taskId: string | null;
  createTask: (input?: { metadata?: Record<string, unknown> }) => Promise<void>;
  record: (input: {
    type: string;
    message?: string;
    payload?: Record<string, unknown>;
    status?:
      | "running"
      | "waiting_for_tool"
      | "completed"
      | "failed"
      | "cancelled";
    finalSummary?: unknown;
    error?: unknown;
  }) => Promise<void>;
}

interface ExecutionReporterParams {
  gatewayUrl: string;
  workerToken: string;
  agentId: string;
  sessionId: string;
  messageId?: string;
  conversationId: string;
  userId?: string;
  source: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function deriveExecutionTaskId(
  workerToken: string,
  fallbackId: string,
  messageId?: string
): string {
  if (isNonEmptyString(messageId)) {
    return `exec:${messageId}`;
  }
  const tokenData = workerToken ? verifyWorkerToken(workerToken) : null;
  const tokenMessageId =
    tokenData && "messageId" in tokenData
      ? (tokenData as { messageId?: unknown }).messageId
      : undefined;
  if (isNonEmptyString(tokenMessageId)) {
    return `exec:${tokenMessageId}`;
  }
  if (typeof tokenData?.runId === "number") {
    return `exec:run:${tokenData.runId}`;
  }
  if (isNonEmptyString(tokenData?.jti)) {
    return `exec:jti:${tokenData.jti}`;
  }
  return `exec:session:${fallbackId}`;
}

export function createExecutionReporter(
  params: ExecutionReporterParams
): ExecutionReporter {
  const enabled = Boolean(
    params.gatewayUrl && params.workerToken && params.agentId
  );
  const taskId = enabled
    ? deriveExecutionTaskId(
        params.workerToken,
        params.sessionId,
        params.messageId
      )
    : null;

  const post = async (body: Record<string, unknown>): Promise<void> => {
    if (!enabled || !taskId) return;
    try {
      const response = await fetch(
        `${params.gatewayUrl}/internal/execution-events`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${params.workerToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ taskId, ...body }),
          signal: AbortSignal.timeout(10_000),
        }
      );
      if (!response.ok) {
        logger.warn(
          `Execution event report failed: ${response.status} ${response.statusText}`
        );
      }
    } catch (error) {
      logger.warn(
        `Execution event report failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  return {
    taskId,
    createTask: async (input) => {
      await post({
        action: "create",
        agentId: params.agentId,
        sessionId: params.sessionId,
        conversationId: params.conversationId,
        userId: params.userId,
        source: params.source,
        status: "running",
        metadata: input?.metadata ?? {},
      });
    },
    record: async (input) => {
      await post({
        action: "record",
        type: input.type,
        message: input.message,
        payload: input.payload,
        status: input.status,
        finalSummary: input.finalSummary,
        error: input.error,
      });
    },
  };
}
