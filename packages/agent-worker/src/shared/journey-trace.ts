import { randomUUID } from "node:crypto";

export type JourneyTraceStatus =
  | "started"
  | "ok"
  | "skipped"
  | "failed"
  | "timeout"
  | "blocked"
  | "degraded";

export interface WorkerShifuTraceContext {
  traceId: string;
  parentSpanId?: string;
  journeyId: string;
  actor: string;
  turnId?: string;
  traceSource: "incoming" | "generated_missing_header";
}

export interface WorkerJourneyEventInput {
  event: string;
  trace: WorkerShifuTraceContext;
  env?: string;
  module?: string;
  status: JourneyTraceStatus;
  fields?: Record<string, unknown>;
}

const TRACE_ID_PATTERN = /^(?:tr|trace)_[a-zA-Z0-9_-]{8,80}$/;
const SPAN_ID_PATTERN = /^(?:sp|span)_[a-zA-Z0-9_-]{3,100}$/;
const JOURNEY_ID_PATTERN = /^[a-z][a-z0-9_]{2,80}$/;
const TURN_ID_PATTERN = /^turn[_-][a-zA-Z0-9_-]{3,100}$/;
const sensitiveKeyFragments = [
  "authorization",
  "bearer",
  "secret",
  "token",
  "cookie",
  "password",
  "credential",
  "apikey",
  "api_key",
  "userid",
  "user_id",
  "lineuserid",
  "line_user_id",
  "agent_id",
  "agentid",
  "lobu_user_id",
  "toolbox_user_id",
];

function createId(prefix: "tr" | "sp") {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}

function safeString(value: unknown, pattern: RegExp): string | undefined {
  return typeof value === "string" && pattern.test(value)
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSensitiveKey(key: string) {
  const normalized = key.replace(/[^a-zA-Z0-9_]/g, "").toLowerCase();
  return sensitiveKeyFragments.some((fragment) => normalized.includes(fragment));
}

function sanitizeFields(fields: Record<string, unknown> = {}) {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (key === "body" || isSensitiveKey(key)) continue;
    sanitized[key] = value;
  }
  return sanitized;
}

export function parseWorkerShifuTrace(
  platformMetadata: unknown,
  actor = "worker"
): WorkerShifuTraceContext {
  const traceEnvelope = isRecord(platformMetadata)
    ? platformMetadata.shifuTrace
    : undefined;
  const trace = isRecord(traceEnvelope) ? traceEnvelope : {};
  const traceId = safeString(trace.trace_id, TRACE_ID_PATTERN);
  return {
    traceId: traceId ?? createId("tr"),
    parentSpanId: safeString(trace.parent_span_id, SPAN_ID_PATTERN),
    journeyId: safeString(trace.journey_id, JOURNEY_ID_PATTERN) ?? "unknown",
    actor,
    turnId: safeString(trace.turn_id, TURN_ID_PATTERN),
    traceSource: traceId ? "incoming" : "generated_missing_header",
  };
}

export function shifuTraceHeaders(
  trace: WorkerShifuTraceContext
): Record<string, string> {
  return {
    "X-Shifu-Trace-Id": trace.traceId,
    ...(trace.parentSpanId ? { "X-Shifu-Span-Id": trace.parentSpanId } : {}),
    "X-Shifu-Journey-Id": trace.journeyId,
    ...(trace.turnId ? { "X-Shifu-Turn-Id": trace.turnId } : {}),
  };
}

export function journeyEvent(input: WorkerJourneyEventInput) {
  return {
    schema_version: "journey.trace.v1",
    timestamp: new Date().toISOString(),
    event: input.event,
    journey_id: input.trace.journeyId,
    trace_id: input.trace.traceId,
    span_id: createId("sp"),
    parent_span_id: input.trace.parentSpanId,
    service: "lobu",
    module: input.module ?? "agent-worker",
    env: input.env ?? process.env.NODE_ENV ?? "unknown",
    status: input.status,
    actor: input.trace.actor,
    ...(input.trace.turnId ? { turn_id: input.trace.turnId } : {}),
    trace_source: input.trace.traceSource,
    ...sanitizeFields(input.fields),
  };
}

export function emitJourneyEvent(input: WorkerJourneyEventInput): void {
  console.log(JSON.stringify(journeyEvent(input)));
}
