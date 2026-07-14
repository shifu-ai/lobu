import { describe, expect, mock, test } from "bun:test";
import { selectMcpToolsByMcpForTurn } from "../openclaw/dynamic-tool-loader";
import { buildToolRouterJourneyEventInput } from "../openclaw/session-runner";
import {
  emitJourneyEvent,
  journeyEvent,
  parseWorkerShifuTrace,
  shifuTraceHeaders,
} from "../shared/journey-trace";

describe("worker journey trace", () => {
  test("parses trace from platformMetadata envelope", () => {
    const trace = parseWorkerShifuTrace({
      shifuTrace: {
        trace_id: "tr_worker_1",
        parent_span_id: "sp_lobu",
        journey_id: "line_text_agent_turn",
        turn_id: "turn-001",
      },
      agentId: "shifu-u-secret",
    });

    expect(trace).toEqual({
      traceId: "tr_worker_1",
      parentSpanId: "sp_lobu",
      journeyId: "line_text_agent_turn",
      actor: "worker",
      turnId: "turn-001",
      traceSource: "incoming",
    });
    expect(shifuTraceHeaders(trace)).toEqual({
      "X-Shifu-Trace-Id": "tr_worker_1",
      "X-Shifu-Span-Id": "sp_lobu",
      "X-Shifu-Journey-Id": "line_text_agent_turn",
      "X-Shifu-Turn-Id": "turn-001",
    });
  });

  test("drops malformed trace values and redacts sensitive fields", () => {
    const trace = parseWorkerShifuTrace({
      shifuTrace: {
        trace_id: "bad trace id",
        parent_span_id: "sp_bad\ninjected",
        journey_id: "line_text_agent_turn",
      },
    });

    expect(trace.traceId).toMatch(/^tr_[a-f0-9]{32}$/);
    expect(trace.parentSpanId).toBeUndefined();
    expect(trace.journeyId).toBe("line_text_agent_turn");
    expect(trace.traceSource).toBe("generated_missing_header");

    const event = journeyEvent({
      event: "worker.tools_registered",
      trace,
      status: "ok",
      fields: {
        mcp_id: "toolbox",
        tool_count: 3,
        agent_id: "shifu-u-secret",
        user_id: "user-secret",
        authorization: "Bearer secret",
      },
    });

    expect(event).toMatchObject({
      schema_version: "journey.trace.v1",
      event: "worker.tools_registered",
      service: "lobu",
      module: "agent-worker",
      status: "ok",
      actor: "worker",
      mcp_id: "toolbox",
      tool_count: 3,
    });
    expect(JSON.stringify(event)).not.toContain("shifu-u-secret");
    expect(JSON.stringify(event)).not.toContain("user-secret");
    expect(JSON.stringify(event)).not.toContain("Bearer secret");
  });

  test("rejects raw identity-shaped values from platformMetadata envelope", () => {
    const trace = parseWorkerShifuTrace({
      shifuTrace: {
        trace_id: "shifu-u-a4175b7e71f4",
        parent_span_id: "U-line-1",
        journey_id: "line_text_agent_turn",
        turn_id: "shifu-u-secret",
      },
    });

    expect(trace.traceId).toMatch(/^tr_[a-f0-9]{32}$/);
    expect(trace.parentSpanId).toBeUndefined();
    expect(trace.journeyId).toBe("line_text_agent_turn");
    expect(trace.turnId).toBeUndefined();
    expect(trace.traceSource).toBe("generated_missing_header");
  });

  test("emits standalone JSON lines", () => {
    const log = mock(() => undefined);
    const original = console.log;
    console.log = log;
    try {
      emitJourneyEvent({
        event: "worker.mcp_tool_invoked",
        trace: parseWorkerShifuTrace({
          shifuTrace: {
            trace_id: "tr_worker_emit",
            journey_id: "line_text_agent_turn",
          },
        }),
        status: "started",
        fields: { mcp_id: "toolbox", tool_name: "search" },
      });
    } finally {
      console.log = original;
    }

    expect(log).toHaveBeenCalledTimes(1);
    const event = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(event).toMatchObject({
      schema_version: "journey.trace.v1",
      event: "worker.mcp_tool_invoked",
      trace_id: "tr_worker_emit",
      status: "started",
    });
  });

  test("builds a bounded tool-router decision event without raw prompt data", () => {
    const userPrompt = `幫我排明天下午三點跟老師開會-${"private".repeat(200)}`;
    const selection = selectMcpToolsByMcpForTurn({
      toolsByMcp: {
        "lobu-memory": [
          {
            name: "manage_schedules",
            description: "Create a personal reminder schedule.",
            inputSchema: {
              type: "object",
              properties: {
                raw_schema_secret: { description: "oauth-secret" },
              },
            },
          },
        ],
        google_workspace: [
          {
            name: "gws_calendar_events_create",
            description: "Create a Google Calendar event.",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      },
      message: userPrompt,
      budget: 8,
    });
    const input = buildToolRouterJourneyEventInput({
      trace: parseWorkerShifuTrace({
        shifuTrace: {
          trace_id: "tr_toolrouter1234",
          journey_id: "line_text_agent_turn",
        },
      }),
      selectionTrace: selection.trace,
      totalMs: 12.5,
    });
    const event = journeyEvent(input);
    const serializedEvent = JSON.stringify(event);
    const emitted = JSON.parse(serializedEvent) as Record<string, unknown>;

    expect(emitted.inventory_fingerprint).toHaveLength(16);
    expect(emitted.candidates).toHaveLength(
      Math.min(5, selection.trace.candidateCount)
    );
    expect(serializedEvent).not.toContain(userPrompt);
    expect(serializedEvent).not.toContain("raw_schema_secret");
    expect(serializedEvent).not.toContain("oauth-secret");
    expect((emitted.candidates as unknown[]).length <= 5).toBe(true);
    expect(emitted.selected_tools).toHaveLength(0);
    expect(emitted.blocked_tools).toHaveLength(2);
    expect(emitted.candidates).toEqual(
      selection.trace.candidates.slice(0, 5).map((candidate) => ({
        key: candidate.key,
        totalScore: candidate.totalScore,
        reasons: candidate.reasons,
        scoreBreakdown: candidate.scoreBreakdown,
      }))
    );
    expect(emitted).toMatchObject({
      event: "lobu.worker.tool_router_decision",
      module: "agent-worker",
      status: "ok",
      router_version: "semantic-v1",
      cache_hit: expect.any(Boolean),
      tool_count: expect.any(Number),
      eligible_tool_count: expect.any(Number),
      selected_tools: expect.any(Array),
      blocked_tools: expect.any(Array),
      timing_ms: expect.objectContaining({ total: expect.any(Number) }),
    });
  });
});
