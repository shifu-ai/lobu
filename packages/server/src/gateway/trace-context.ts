import { randomUUID } from "node:crypto";

export type JourneyTraceStatus =
  | "started"
  | "ok"
  | "skipped"
  | "failed"
  | "timeout"
  | "blocked"
  | "degraded";

export interface ShifuTraceContext {
  traceId: string;
  parentSpanId?: string;
  journeyId: string;
  actor: string;
  turnId?: string;
  traceSource: "incoming" | "generated_missing_header";
}

export interface ShifuTraceEnvelope {
  trace_id: string;
  parent_span_id?: string;
  journey_id: string;
  turn_id?: string;
  trace_source: ShifuTraceContext["traceSource"];
}

export interface JourneyEventInput {
  event: string;
  trace: ShifuTraceContext;
  env?: string;
  module?: string;
  status: JourneyTraceStatus;
  fields?: Record<string, unknown>;
}

type HeadersLike = {
  get?: (name: string) => string | null | undefined;
};

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

const TRACE_ID_PATTERN = /^(?:tr|trace)_[a-zA-Z0-9_-]{8,80}$/;
const SPAN_ID_PATTERN = /^(?:sp|span)_[a-zA-Z0-9_-]{3,100}$/;
const JOURNEY_ID_PATTERN = /^[a-z][a-z0-9_]{2,80}$/;
const TURN_ID_PATTERN = /^turn[_-][a-zA-Z0-9_-]{3,100}$/;

function createId(prefix: "tr" | "sp") {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}

function normalizeHeaderName(name: string) {
  return name.toLowerCase();
}

function headerValue(headers: HeadersLike | Record<string, unknown>, name: string): string | undefined {
  if (typeof headers.get === "function") {
    const value = headers.get(name);
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }

  const wanted = normalizeHeaderName(name);
  for (const [key, value] of Object.entries(headers)) {
    if (normalizeHeaderName(key) === wanted && typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  return undefined;
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

function safeHeaderValue(
  headers: HeadersLike | Record<string, unknown>,
  name: string,
  pattern: RegExp
): string | undefined {
  const value = headerValue(headers, name);
  if (!value) return undefined;
  return pattern.test(value) ? value : undefined;
}

export function parseShifuTraceHeaders(
  headers: HeadersLike | Record<string, unknown>,
  actor = "api"
): ShifuTraceContext {
  const incomingTraceId = safeHeaderValue(headers, "X-Shifu-Trace-Id", TRACE_ID_PATTERN);
  return {
    traceId: incomingTraceId ?? createId("tr"),
    parentSpanId: safeHeaderValue(headers, "X-Shifu-Span-Id", SPAN_ID_PATTERN),
    journeyId:
      safeHeaderValue(headers, "X-Shifu-Journey-Id", JOURNEY_ID_PATTERN) ??
      safeHeaderValue(headers, "X-Shifu-Journey", JOURNEY_ID_PATTERN) ??
      "unknown",
    actor,
    turnId: safeHeaderValue(headers, "X-Shifu-Turn-Id", TURN_ID_PATTERN),
    traceSource: incomingTraceId ? "incoming" : "generated_missing_header",
  };
}

export function shifuTraceHeaders(trace: ShifuTraceContext): Record<string, string> {
  return {
    "X-Shifu-Trace-Id": trace.traceId,
    ...(trace.parentSpanId ? { "X-Shifu-Span-Id": trace.parentSpanId } : {}),
    "X-Shifu-Journey-Id": trace.journeyId,
    ...(trace.turnId ? { "X-Shifu-Turn-Id": trace.turnId } : {}),
  };
}

export function shifuTraceEnvelope(trace: ShifuTraceContext): ShifuTraceEnvelope {
  return {
    trace_id: trace.traceId,
    ...(trace.parentSpanId ? { parent_span_id: trace.parentSpanId } : {}),
    journey_id: trace.journeyId,
    ...(trace.turnId ? { turn_id: trace.turnId } : {}),
    trace_source: trace.traceSource,
  };
}

export function journeyEvent(input: JourneyEventInput) {
  return {
    schema_version: "journey.trace.v1",
    timestamp: new Date().toISOString(),
    event: input.event,
    journey_id: input.trace.journeyId,
    trace_id: input.trace.traceId,
    span_id: createId("sp"),
    parent_span_id: input.trace.parentSpanId,
    service: "lobu",
    module: input.module ?? "agent-api",
    env: input.env ?? process.env.NODE_ENV ?? "unknown",
    status: input.status,
    actor: input.trace.actor,
    ...(input.trace.turnId ? { turn_id: input.trace.turnId } : {}),
    trace_source: input.trace.traceSource,
    ...sanitizeFields(input.fields),
  };
}

export function emitJourneyEvent(input: JourneyEventInput): void {
  console.log(JSON.stringify(journeyEvent(input)));
}
