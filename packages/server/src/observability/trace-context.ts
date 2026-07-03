import { randomUUID } from "node:crypto";

export type ShifuTraceContext = {
  traceId: string;
  parentSpanId?: string;
  journeyId: string;
  turnId?: string;
  actor: string;
  traceSource: "incoming" | "generated_missing_header";
};

type TraceHeaders = Pick<Headers, "get">;

function uuidHex(): string {
  return randomUUID().replace(/-/g, "");
}

export function newSpanId(): string {
  return `sp_${uuidHex()}`;
}

function getHeader(headers: TraceHeaders, name: string): string | undefined {
  const value = headers.get(name) ?? headers.get(name.toLowerCase());
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function parseShifuTraceHeaders(headers: TraceHeaders): ShifuTraceContext {
  const traceId = getHeader(headers, "X-Shifu-Trace-Id");

  return {
    traceId: traceId ?? `tr_lobu_${uuidHex()}`,
    parentSpanId: getHeader(headers, "X-Shifu-Span-Id"),
    journeyId: getHeader(headers, "X-Shifu-Journey") ?? "lobu_runtime_unknown",
    turnId: getHeader(headers, "X-Shifu-Turn-Id"),
    actor: getHeader(headers, "X-Shifu-Actor") ?? "unknown",
    traceSource: traceId ? "incoming" : "generated_missing_header",
  };
}

export function headersFromTraceContext(
  context: ShifuTraceContext
): Record<string, string> {
  return {
    "X-Shifu-Trace-Id": context.traceId,
    ...(context.parentSpanId ? { "X-Shifu-Span-Id": context.parentSpanId } : {}),
    "X-Shifu-Journey": context.journeyId,
    ...(context.turnId ? { "X-Shifu-Turn-Id": context.turnId } : {}),
    "X-Shifu-Actor": context.actor,
  };
}
