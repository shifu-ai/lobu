export interface CourseWakeDeliveryMetadata {
  schemaVersion: 1;
  source: "calendar_scheduled_wake";
  automationId: string;
  jobId: string;
  runId: number;
  toolboxUserId: string;
  lobuAgentId: string;
}

export type CourseWakeCompletion =
  | { kind: "succeeded"; finalOutput: string }
  | { kind: "failed"; failureCode: "generation_failed" | "invalid_final_output" };

export function readCourseWakeDeliveryMetadata(
  platformMetadata: Record<string, unknown> | undefined,
): CourseWakeDeliveryMetadata | null {
  const value = platformMetadata?.scheduledCourseWake;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    "lineUserId" in row ||
    row.schemaVersion !== 1 ||
    row.source !== "calendar_scheduled_wake"
  ) {
    return null;
  }
  if (
    !bounded(row.automationId, 256) ||
    !bounded(row.jobId, 256) ||
    !bounded(row.toolboxUserId, 256) ||
    !bounded(row.lobuAgentId, 256) ||
    !Number.isInteger(row.runId) ||
    Number(row.runId) <= 0
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    source: "calendar_scheduled_wake",
    automationId: row.automationId,
    jobId: row.jobId,
    runId: Number(row.runId),
    toolboxUserId: row.toolboxUserId,
    lobuAgentId: row.lobuAgentId,
  };
}

export async function deliverCourseWakeCompletion(
  input: {
    metadata: CourseWakeDeliveryMetadata;
    completion: CourseWakeCompletion;
    turnId: string;
  },
  deps: { fetchFn?: typeof fetch } = {},
): Promise<void> {
  const url = process.env.TOOLBOX_TURN_COMPLETED_URL?.trim();
  const secret = process.env.TOOLBOX_INTERNAL_SECRET?.trim();
  if (!url || !secret) throw new Error("course_wake_delivery_not_configured");
  if (
    !bounded(input.turnId, 256)
  ) {
    throw new Error("course_wake_delivery_invalid_completion");
  }
  if (
    input.completion.kind === "succeeded"
    && (!input.completion.finalOutput.trim() || input.completion.finalOutput.length > 50_000)
  ) {
    throw new Error("course_wake_delivery_invalid_completion");
  }
  const completionPayload = input.completion.kind === "succeeded"
    ? { completionKind: "succeeded", finalOutput: input.completion.finalOutput }
    : { completionKind: "failed", failureCode: input.completion.failureCode };
  const response = await (deps.fetchFn ?? fetch)(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-secret": secret,
    },
    body: JSON.stringify({
      ...input.metadata,
      turnId: input.turnId,
      occurredAt: new Date().toISOString(),
      ...completionPayload,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (response.status === 503 && body.status === "retrying") {
    throw new Error("course_wake_delivery_retrying");
  }
  if (
    !response.ok ||
    ![
      "delivered",
      "delivery_blocked_unbound",
      "failed",
      "delivery_unknown",
      "retrying",
    ].includes(String(body.status))
  ) {
    throw new Error(`course_wake_delivery_failed:${response.status}`);
  }
}

function bounded(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}
