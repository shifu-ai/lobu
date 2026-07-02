import { describe, expect, mock, test } from "bun:test";
import {
  emitJourneyEvent,
  journeyEvent,
  parseShifuTraceHeaders,
  shifuTraceEnvelope,
  shifuTraceHeaders,
} from "../trace-context";

describe("Shifu journey trace context", () => {
  test("parses incoming trace headers", () => {
    const trace = parseShifuTraceHeaders({
      "X-Shifu-Trace-Id": "tr_test_lobu",
      "X-Shifu-Span-Id": "sp_gateway",
      "X-Shifu-Journey-Id": "line_text_agent_turn",
      "X-Shifu-Turn-Id": "turn-001",
    });

    expect(trace).toEqual({
      traceId: "tr_test_lobu",
      parentSpanId: "sp_gateway",
      journeyId: "line_text_agent_turn",
      actor: "api",
      turnId: "turn-001",
      traceSource: "incoming",
    });
  });

  test("generates a trace id when headers are missing", () => {
    const trace = parseShifuTraceHeaders({});

    expect(trace.traceId).toMatch(/^tr_[a-f0-9]{32}$/);
    expect(trace.journeyId).toBe("unknown");
    expect(trace.traceSource).toBe("generated_missing_header");
  });

  test("drops malformed or oversized public trace headers", () => {
    const trace = parseShifuTraceHeaders({
      "X-Shifu-Trace-Id": "x".repeat(256),
      "X-Shifu-Span-Id": "sp_bad\ninjected",
      "X-Shifu-Journey-Id": "line_text_agent_turn",
      "X-Shifu-Turn-Id": "turn with spaces",
    });

    expect(trace.traceId).toMatch(/^tr_[a-f0-9]{32}$/);
    expect(trace.parentSpanId).toBeUndefined();
    expect(trace.journeyId).toBe("line_text_agent_turn");
    expect(trace.turnId).toBeUndefined();
    expect(trace.traceSource).toBe("generated_missing_header");
  });

  test("rejects raw identity-shaped values in public trace headers", () => {
    const trace = parseShifuTraceHeaders({
      "X-Shifu-Trace-Id": "shifu-u-a4175b7e71f4",
      "X-Shifu-Span-Id": "U-line-1",
      "X-Shifu-Journey-Id": "line_text_agent_turn",
      "X-Shifu-Turn-Id": "shifu-u-secret",
    });

    expect(trace.traceId).toMatch(/^tr_[a-f0-9]{32}$/);
    expect(trace.parentSpanId).toBeUndefined();
    expect(trace.journeyId).toBe("line_text_agent_turn");
    expect(trace.turnId).toBeUndefined();
    expect(trace.traceSource).toBe("generated_missing_header");
  });

  test("returns normalized journey events without sensitive fields", () => {
    const trace = parseShifuTraceHeaders({
      "X-Shifu-Trace-Id": "tr_test_lobu",
      "X-Shifu-Span-Id": "sp_gateway",
      "X-Shifu-Journey-Id": "line_text_agent_turn",
    });

    const event = journeyEvent({
      event: "lobu.run.enqueued",
      trace,
      status: "ok",
      fields: {
        message_id: "msg-1",
        job_id: "job-1",
        agent_id: "shifu-u-secret",
        authorization: "Bearer secret",
        body: { content: "hidden" },
      },
    });

    expect(event).toMatchObject({
      schema_version: "journey.trace.v1",
      event: "lobu.run.enqueued",
      journey_id: "line_text_agent_turn",
      trace_id: "tr_test_lobu",
      parent_span_id: "sp_gateway",
      service: "lobu",
      module: "agent-api",
      status: "ok",
      actor: "api",
      trace_source: "incoming",
      message_id: "msg-1",
      job_id: "job-1",
    });
    expect(JSON.stringify(event)).not.toContain("shifu-u-secret");
    expect(JSON.stringify(event)).not.toContain("Bearer secret");
    expect(JSON.stringify(event)).not.toContain("hidden");
  });

  test("serializes safe trace headers and worker envelope without raw identities", () => {
    const trace = parseShifuTraceHeaders({
      "X-Shifu-Trace-Id": "tr_test_lobu",
      "X-Shifu-Span-Id": "sp_gateway",
      "X-Shifu-Journey-Id": "line_text_agent_turn",
      "X-Shifu-Turn-Id": "turn-001",
    });

    expect(shifuTraceHeaders(trace)).toEqual({
      "X-Shifu-Trace-Id": "tr_test_lobu",
      "X-Shifu-Span-Id": "sp_gateway",
      "X-Shifu-Journey-Id": "line_text_agent_turn",
      "X-Shifu-Turn-Id": "turn-001",
    });
    expect(shifuTraceEnvelope(trace)).toEqual({
      trace_id: "tr_test_lobu",
      parent_span_id: "sp_gateway",
      journey_id: "line_text_agent_turn",
      turn_id: "turn-001",
      trace_source: "incoming",
    });
    expect(JSON.stringify(shifuTraceEnvelope(trace))).not.toContain("shifu-u-secret");
    expect(JSON.stringify(shifuTraceEnvelope(trace))).not.toContain("user-secret");
  });

  test("emits journey events as standalone JSON log lines", () => {
    const log = mock(() => undefined);
    const original = console.log;
    console.log = log;
    try {
      emitJourneyEvent({
        event: "lobu.session.created",
        trace: parseShifuTraceHeaders({
          "X-Shifu-Trace-Id": "tr_test_lobu_emit",
          "X-Shifu-Journey-Id": "line_text_agent_turn",
        }),
        status: "ok",
      });
    } finally {
      console.log = original;
    }

    expect(log).toHaveBeenCalledTimes(1);
    const event = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(event).toMatchObject({
      schema_version: "journey.trace.v1",
      event: "lobu.session.created",
      trace_id: "tr_test_lobu_emit",
      status: "ok",
    });
  });
});
