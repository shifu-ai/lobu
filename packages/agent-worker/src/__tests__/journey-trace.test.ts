import { describe, expect, mock, test } from "bun:test";
import { selectMcpToolsByMcpForTurn } from "../openclaw/dynamic-tool-loader";
import { buildEffectiveToolInventory } from "../openclaw/effective-tool-inventory";
import {
  buildToolRouterJourneyEventInput,
  initializeExternalTurnToolRouting,
} from "../openclaw/session-runner";
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
      routerMode: "semantic",
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
      router_mode: "semantic",
      semantic_computed: true,
      cache_hit: expect.any(Boolean),
      tool_count: expect.any(Number),
      eligible_tool_count: expect.any(Number),
      selected_tools: expect.any(Array),
      blocked_tools: expect.any(Array),
      timing_ms: expect.objectContaining({ total: expect.any(Number) }),
    });
  });

  test("normalizes every non-finite or negative router metric", () => {
    const selection = selectMcpToolsByMcpForTurn({
      toolsByMcp: {
        lobu: [
          {
            name: "search_memory",
            description: "Search memory",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      },
      message: "search memory",
      budget: 1,
    });
    const invalidTrace = {
      ...selection.trace,
      totalTools: Number.NaN,
      eligibleToolCount: Number.POSITIVE_INFINITY,
      candidateCount: Number.NEGATIVE_INFINITY,
      estimatedIndexBytes: Number.NEGATIVE_INFINITY,
      cacheEvictionCount: -1,
      timingMs: {
        build: Number.NaN,
        retrieve: Number.POSITIVE_INFINITY,
        rank: -1,
      },
      candidates: selection.trace.candidates.map((candidate) => ({
        ...candidate,
        totalScore: Number.NaN,
        scoreBreakdown: candidate.scoreBreakdown
          ? {
              ...candidate.scoreBreakdown,
              exactName: Number.POSITIVE_INFINITY,
              negativePenalty: -1,
            }
          : undefined,
      })),
    };
    const event = journeyEvent(
      buildToolRouterJourneyEventInput({
        trace: parseWorkerShifuTrace({}),
        selectionTrace: invalidTrace,
        totalMs: Number.POSITIVE_INFINITY,
      })
    );

    expect(event).toMatchObject({
      tool_count: 0,
      eligible_tool_count: 0,
      candidate_count: 0,
      timing_ms: { build: 0, retrieve: 0, rank: 0, total: 0 },
      estimated_index_bytes: 0,
      cache_eviction_count: 0,
    });
    for (const candidate of event.candidates as Array<{
      totalScore: number;
      scoreBreakdown?: Record<string, number>;
    }>) {
      expect(candidate.totalScore).toBe(0);
      expect(candidate.scoreBreakdown?.exactName).toBe(0);
      expect(candidate.scoreBreakdown?.negativePenalty).toBe(0);
    }
    const serialized = JSON.stringify(event);
    for (const field of [
      "tool_count",
      "eligible_tool_count",
      "candidate_count",
      "estimated_index_bytes",
      "cache_eviction_count",
    ]) {
      expect(serialized).not.toContain(`"${field}":null`);
    }
  });

  test("emits effective eligibility separately from the descriptor index fingerprint", () => {
    const toolsByMcp = {
      "lobu-memory": [
        {
          name: "manage_schedules",
          description: "Manage personal schedules",
          inputSchema: { type: "object" },
        },
      ],
    };
    const activeInventory = buildEffectiveToolInventory({
      scopedTools: toolsByMcp,
      releaseState: {
        status: "active",
        claim: {
          environment: "production",
          toolboxUserId: "user-1",
          agentId: "agent-1",
          releaseId: "release-1",
          releaseSequence: 1,
          snapshotDigest: "sha256:snapshot-1",
          expiresAt: "2099-01-01T00:00:00.000Z",
          capabilityIds: ["personal_reminder_delivery.v1"],
        },
      },
    });
    const inactiveInventory = buildEffectiveToolInventory({
      scopedTools: toolsByMcp,
      releaseState: {
        status: "enrolled_inactive",
        environment: "production",
        reason: "snapshot_unavailable",
      },
    });
    const selection = selectMcpToolsByMcpForTurn({
      toolsByMcp,
      message: "list schedules",
      budget: 1,
    });
    const trace = parseWorkerShifuTrace({});
    const eventFor = (inventory: typeof activeInventory, reason?: string) =>
      journeyEvent(
        buildToolRouterJourneyEventInput({
          trace,
          selectionTrace: {
            ...selection.trace,
            effectiveToolInventoryFingerprint: inventory.fingerprint,
            effectiveReleaseStatus: inventory.releaseProvenance.status,
            effectiveReleaseReason: reason,
          },
          totalMs: 1,
        })
      );

    const activeEvent = eventFor(activeInventory);
    const inactiveEvent = eventFor(inactiveInventory, "snapshot_missing");
    expect(activeEvent.descriptor_inventory_fingerprint).toBe(
      inactiveEvent.descriptor_inventory_fingerprint
    );
    expect(activeEvent.effective_tools_fingerprint).not.toBe(
      inactiveEvent.effective_tools_fingerprint
    );
    expect(inactiveEvent).toMatchObject({
      effective_release_status: "enrolled_inactive",
      effective_release_reason: "snapshot_missing",
    });
    expect(String(inactiveEvent.effective_tools_fingerprint)).toHaveLength(16);
  });

  test("emits bounded release provenance while rejecting arbitrary agent identifiers", () => {
    const selection = selectMcpToolsByMcpForTurn({
      toolsByMcp: {},
      message: "提醒我喝水",
      budget: 1,
    });
    const trace = parseWorkerShifuTrace({
      shifuTrace: {
        trace_id: "tr_release_trace_1",
        journey_id: "line_text_agent_turn",
        turn_id: "turn-release-1",
      },
    });
    const base = {
      ...selection.trace,
      releaseEnvironment: "production",
      releaseAgentId: "shifu-u-safe_1",
      releaseId: "release-17",
      releaseSequence: 17,
      releaseSnapshotDigest: `sha256:${"a".repeat(64)}`,
      releaseSnapshotExpiresAt: "2099-01-01T00:00:00.000Z",
      releaseSnapshotExpired: false,
      executionIntent: "personal_reminder:create:explicit",
      executionClarificationRequired: false,
      routerStageCorrelationStatus: "not_available_at_router_stage" as const,
    };
    const safe = journeyEvent(
      buildToolRouterJourneyEventInput({
        trace,
        selectionTrace: base,
        totalMs: 1,
      })
    );
    expect(safe).toMatchObject({
      release_environment: "production",
      release_agent_id: "shifu-u-safe_1",
      release_id: "release-17",
      release_sequence: 17,
      release_snapshot_digest: "sha256:aaaaaaaaa",
      release_snapshot_expired: false,
      execution_intent: "personal_reminder:create:explicit",
      execution_clarification_required: false,
      reminder_correlation_status: "not_available_at_router_stage",
      schedule_id_status: "not_available_at_router_stage",
      wake_run_id_status: "not_available_at_router_stage",
      line_delivery_correlation_status: "not_available_at_router_stage",
    });
    const unsafe = journeyEvent(
      buildToolRouterJourneyEventInput({
        trace,
        selectionTrace: { ...base, releaseAgentId: "user@example.com" },
        totalMs: 1,
      })
    );
    expect(unsafe.release_agent_id).toBeUndefined();
    const hostile = journeyEvent({
      event: "lobu.worker.tool_router_decision",
      trace,
      status: "ok",
      fields: {
        release_id: `release\n${"x".repeat(10_000)}`,
        release_agent_id: `agent\u0000${"x".repeat(10_000)}`,
        release_snapshot_expires_at: `${"9".repeat(10_000)}`,
        release_snapshot_digest: `sha256:${"a".repeat(10_000)}`,
        execution_intent: `personal\n${"x".repeat(10_000)}`,
      },
    });
    expect(hostile.release_id).toBeUndefined();
    expect(hostile.release_agent_id).toBeUndefined();
    expect(hostile.release_snapshot_expires_at).toBeUndefined();
    expect(hostile.release_snapshot_digest).toBeUndefined();
    expect(hostile.execution_intent).toBeUndefined();
  });

  test.each([
    ["legacy", "unknown", "agent-legacy-1"],
    ["inactive", "production", "agent-inactive-1"],
  ])("%s external turn emits bounded provenance and unavailable delivery refs", (_state, environment, agentId) => {
    let emitted: Record<string, unknown> | undefined;
    initializeExternalTurnToolRouting(
      {
        toolsByMcp: {},
        message: "你好",
        budget: 1,
        releaseTrace: { environment, agentId },
        trace: {
          traceId: "tr_release_nonactive_1",
          journeyId: "line_text_agent_turn",
          actor: "worker",
          traceSource: "incoming",
        },
      },
      {
        emitEvent: (input) => {
          emitted = journeyEvent(input);
        },
      }
    );
    expect(emitted).toMatchObject({
      release_environment: environment,
      release_agent_id: agentId,
      reminder_correlation_status: "not_available_at_router_stage",
      execution_clarification_required: false,
    });
    expect(emitted?.release_id).toBeUndefined();
  });
});
