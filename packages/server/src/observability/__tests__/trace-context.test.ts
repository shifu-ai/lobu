import { describe, expect, test } from "bun:test";
import {
  headersFromTraceContext,
  newSpanId,
  parseShifuTraceHeaders,
} from "../trace-context";

describe("Shifu trace context", () => {
  test("preserves incoming Shifu trace headers", () => {
    const trace = parseShifuTraceHeaders(
      new Headers({
        "X-Shifu-Trace-Id": "tr_test",
        "X-Shifu-Span-Id": "sp_parent",
        "X-Shifu-Journey": "line_text_agent_turn",
        "X-Shifu-Turn-Id": "turn_1",
        "X-Shifu-Actor": "line",
      })
    );

    expect(trace).toEqual({
      traceId: "tr_test",
      parentSpanId: "sp_parent",
      journeyId: "line_text_agent_turn",
      turnId: "turn_1",
      actor: "line",
      traceSource: "incoming",
    });
  });

  test("missing headers generates safe fallback", () => {
    const trace = parseShifuTraceHeaders(new Headers());

    expect(trace.traceId).toMatch(/^tr_lobu_[a-f0-9]{32}$/);
    expect(trace.journeyId).toBe("lobu_runtime_unknown");
    expect(trace.actor).toBe("unknown");
    expect(trace.traceSource).toBe("generated_missing_header");
  });

  test("serializes context back to headers", () => {
    expect(
      headersFromTraceContext({
        traceId: "tr_test",
        parentSpanId: "sp_parent",
        journeyId: "line_text_agent_turn",
        turnId: "turn_1",
        actor: "line",
        traceSource: "incoming",
      })
    ).toEqual({
      "X-Shifu-Trace-Id": "tr_test",
      "X-Shifu-Span-Id": "sp_parent",
      "X-Shifu-Journey": "line_text_agent_turn",
      "X-Shifu-Turn-Id": "turn_1",
      "X-Shifu-Actor": "line",
    });
  });

  test("newSpanId returns a Shifu span id", () => {
    expect(newSpanId()).toMatch(/^sp_[a-f0-9]{32}$/);
  });
});
