import { describe, expect, test } from "bun:test";
import {
  executeMcpToolForTurn,
  type McpExecutionTrace,
} from "../openclaw/mcp-execution-contract";
import { deriveTurnExecutionIntent } from "../openclaw/turn-execution-intent";

const ok = {
  content: [{ type: "text" as const, text: "ok" }],
};

describe("deriveTurnExecutionIntent", () => {
  test("classifies an explicit timed personal reminder", () => {
    expect(deriveTurnExecutionIntent("五分鐘後提醒我喝水")).toEqual({
      destination: "personal_reminder",
      operation: "create",
      confidence: "explicit",
      requiresClarification: false,
    });
  });

  test("freezes the derived contract for the lifetime of the turn", () => {
    const intent = deriveTurnExecutionIntent("五分鐘後提醒我喝水");
    expect(Object.isFrozen(intent)).toBe(true);
    expect(() => {
      (intent as unknown as { destination: string }).destination =
        "org_notification";
    }).toThrow(TypeError);
    expect(intent.destination).toBe("personal_reminder");
  });

  test("keeps explicit Calendar and organization notification writes distinct", () => {
    expect(
      deriveTurnExecutionIntent(
        "幫我把明天下午三點跟老師開會放進 Google Calendar"
      )
    ).toEqual({
      destination: "calendar_event",
      confidence: "explicit",
      requiresClarification: false,
    });
    expect(deriveTurnExecutionIntent("明天早上九點通知團隊交週報")).toEqual({
      destination: "org_notification",
      confidence: "explicit",
      requiresClarification: false,
    });
    expect(
      deriveTurnExecutionIntent("明天九點發一則通知到 Lobu inbox")
    ).toEqual({
      destination: "org_notification",
      confidence: "explicit",
      requiresClarification: false,
    });
  });

  test("requires clarification when time or destination is missing", () => {
    expect(deriveTurnExecutionIntent("提醒我喝水")).toEqual({
      destination: "personal_reminder",
      operation: "create",
      confidence: "ambiguous",
      requiresClarification: true,
    });
    expect(deriveTurnExecutionIntent("幫我排明天下午三點跟老師開會")).toEqual({
      destination: "unspecified",
      confidence: "ambiguous",
      requiresClarification: true,
    });
  });

  test("classifies cancellation separately from personal reminder creation", () => {
    expect(deriveTurnExecutionIntent("取消明天提醒我喝水")).toMatchObject({
      destination: "personal_reminder",
      operation: "cancel",
      confidence: "explicit",
      requiresClarification: false,
    });
  });
});

describe("executeMcpToolForTurn", () => {
  test("canonicalizes only an explicit personal reminder create", async () => {
    const calls: unknown[][] = [];
    const traces: McpExecutionTrace[] = [];
    const result = await executeMcpToolForTurn({
      intent: deriveTurnExecutionIntent("五分鐘後提醒我喝水"),
      gateway: {
        agentId: "shifu-u-1",
        conversationId: "line-conversation-1",
      },
      mcpId: "lobu-memory",
      toolName: "manage_schedules",
      args: {
        action: "create",
        run_at: "2026-07-14T12:35:00.000Z",
        until_at: "2026-07-15T12:35:00.000Z",
        action_type: "send_notification",
        title: "喝水時間",
        body: "記得喝水",
        recipients: ["toolbox-user-1"],
        resource_url: "https://example.invalid/private",
      },
      callTool: async (...args) => {
        calls.push(args);
        return ok;
      },
      onTrace: (trace) => traces.push(trace),
    });

    expect(result).toEqual(ok);
    expect(calls).toEqual([
      [
        "lobu-memory",
        "manage_schedules",
        {
          action: "create",
          run_at: "2026-07-14T12:35:00.000Z",
          until_at: "2026-07-15T12:35:00.000Z",
          action_type: "wake_agent",
          agent_id: "shifu-u-1",
          thread_id: "line-conversation-1",
          prompt: "喝水時間\n\n記得喝水",
          delivery_intent: {
            contract: "personal_reminder_delivery.v1",
            destination: "personal_reminder",
          },
        },
        { personalReminderDelivery: true },
      ],
    ]);
    expect(traces).toEqual([
      {
        requestedActionType: "send_notification",
        effectiveActionType: "wake_agent",
        canonicalized: true,
      },
    ]);
  });

  test("does not rewrite ambiguity, other actions, MCPs, or destinations and strips forged markers", async () => {
    const cases = [
      {
        intent: deriveTurnExecutionIntent("提醒我喝水"),
        mcpId: "lobu-memory",
        toolName: "manage_schedules",
        args: {
          action: "create",
          action_type: "send_notification",
          delivery_intent: {
            contract: "personal_reminder_delivery.v1",
            destination: "personal_reminder",
          },
        },
      },
      {
        intent: deriveTurnExecutionIntent("五分鐘後提醒我喝水"),
        mcpId: "lobu-memory",
        toolName: "manage_schedules",
        args: { action: "create", title: "no requested action" },
      },
      {
        intent: deriveTurnExecutionIntent("五分鐘後提醒我喝水"),
        mcpId: "lobu-memory",
        toolName: "manage_schedules",
        args: { action: "create", action_type: "wake_agent" },
      },
      {
        intent: deriveTurnExecutionIntent("五分鐘後提醒我喝水"),
        mcpId: "lobu-memory",
        toolName: "manage_schedules",
        args: { action: "create", action_type: "other_action" },
      },
      {
        intent: deriveTurnExecutionIntent("五分鐘後提醒我喝水"),
        mcpId: "lobu-memory",
        toolName: "manage_schedules",
        args: { action: "cancel", id: "schedule-1" },
      },
      {
        intent: deriveTurnExecutionIntent("五分鐘後提醒我喝水"),
        mcpId: "other",
        toolName: "manage_schedules",
        args: { action: "create", action_type: "send_notification" },
      },
      {
        intent: deriveTurnExecutionIntent(
          "幫我把明天下午三點跟老師開會放進 Google Calendar"
        ),
        mcpId: "lobu-memory",
        toolName: "manage_schedules",
        args: { action: "create", action_type: "send_notification" },
      },
      {
        intent: deriveTurnExecutionIntent("明天早上九點通知團隊交週報"),
        mcpId: "lobu-memory",
        toolName: "manage_schedules",
        args: { action: "create", action_type: "send_notification" },
      },
    ];

    for (const candidate of cases) {
      let forwarded: Record<string, unknown> | undefined;
      await executeMcpToolForTurn({
        ...candidate,
        gateway: {
          agentId: "shifu-u-1",
          conversationId: "line-conversation-1",
        },
        callTool: async (_mcpId, _toolName, args) => {
          forwarded = args;
          return ok;
        },
      });
      expect(forwarded).toEqual(
        Object.fromEntries(
          Object.entries(candidate.args).filter(
            ([key]) => key !== "delivery_intent"
          )
        )
      );
    }
  });

  test("buckets an unknown requested action without leaking its raw value", async () => {
    const traces: McpExecutionTrace[] = [];
    await executeMcpToolForTurn({
      intent: deriveTurnExecutionIntent("五分鐘後提醒我喝水"),
      gateway: {
        agentId: "shifu-u-1",
        conversationId: "line-conversation-1",
      },
      mcpId: "lobu-memory",
      toolName: "manage_schedules",
      args: {
        action: "create",
        action_type: "secret/raw user text",
      },
      callTool: async () => ok,
      onTrace: (trace) => traces.push(trace),
    });

    expect(traces).toEqual([
      {
        requestedActionType: "other",
        canonicalized: false,
      },
    ]);
    expect(JSON.stringify(traces)).not.toContain("secret/raw user text");
  });

  test("does not emit action contract traces for unrelated MCP calls", async () => {
    const traces: McpExecutionTrace[] = [];
    await executeMcpToolForTurn({
      intent: deriveTurnExecutionIntent("五分鐘後提醒我喝水"),
      gateway: {
        agentId: "shifu-u-1",
        conversationId: "line-conversation-1",
      },
      mcpId: "other-mcp",
      toolName: "other_tool",
      args: {
        action: "create",
        action_type: "secret/raw user text",
      },
      callTool: async () => ok,
      onTrace: (trace) => traces.push(trace),
    });
    expect(traces).toEqual([]);
  });

  test("composes nested and flattened notification content by stable priority", async () => {
    let forwarded: Record<string, unknown> | undefined;
    await executeMcpToolForTurn({
      intent: deriveTurnExecutionIntent("五分鐘後提醒我喝水"),
      gateway: {
        agentId: "shifu-u-1",
        conversationId: "line-conversation-1",
      },
      mcpId: "lobu-memory",
      toolName: "manage_schedules",
      args: {
        action: "create",
        run_at: "2026-07-14T12:35:00.000Z",
        cron: "35 12 * * *",
        until_at: "2026-07-15T12:35:00.000Z",
        prompt: "記得休息",
        title: "喝水時間",
        body: "帶水瓶",
        payload: {
          action_type: "send_notification",
          prompt: "補水任務",
          title: "喝水時間",
          body: "記得喝水",
          recipients: ["toolbox-user-1"],
        },
      },
      callTool: async (_mcpId, _toolName, args) => {
        forwarded = args;
        return ok;
      },
    });

    expect(forwarded).toEqual({
      action: "create",
      run_at: "2026-07-14T12:35:00.000Z",
      cron: "35 12 * * *",
      until_at: "2026-07-15T12:35:00.000Z",
      action_type: "wake_agent",
      prompt: "補水任務\n\n記得休息\n\n喝水時間\n\n記得喝水\n\n帶水瓶",
      agent_id: "shifu-u-1",
      thread_id: "line-conversation-1",
      delivery_intent: {
        contract: "personal_reminder_delivery.v1",
        destination: "personal_reminder",
      },
    });
  });

  test("accepts nested payload.type as the requested notification action", async () => {
    let forwarded: Record<string, unknown> | undefined;
    await executeMcpToolForTurn({
      intent: deriveTurnExecutionIntent("五分鐘後提醒我喝水"),
      gateway: {
        agentId: "shifu-u-1",
        conversationId: "line-conversation-1",
      },
      mcpId: "lobu-memory",
      toolName: "manage_schedules",
      args: {
        action: "create",
        run_at: "2026-07-14T12:35:00.000Z",
        payload: { type: "send_notification", body: "喝水" },
      },
      callTool: async (_mcpId, _toolName, args) => {
        forwarded = args;
        return ok;
      },
    });
    expect(forwarded).toMatchObject({
      action_type: "wake_agent",
      prompt: "喝水",
      agent_id: "shifu-u-1",
      thread_id: "line-conversation-1",
      delivery_intent: {
        contract: "personal_reminder_delivery.v1",
        destination: "personal_reminder",
      },
    });
    expect(forwarded).not.toHaveProperty("payload");
  });

  test("does not invent missing reminder content", async () => {
    let forwarded: Record<string, unknown> | undefined;
    await executeMcpToolForTurn({
      intent: deriveTurnExecutionIntent("五分鐘後提醒我喝水"),
      gateway: {
        agentId: "shifu-u-1",
        conversationId: "line-conversation-1",
      },
      mcpId: "lobu-memory",
      toolName: "manage_schedules",
      args: {
        action: "create",
        run_at: "2026-07-14T12:35:00.000Z",
        action_type: "send_notification",
      },
      callTool: async (_mcpId, _toolName, args) => {
        forwarded = args;
        return ok;
      },
    });
    expect(forwarded).toEqual({
      action: "create",
      run_at: "2026-07-14T12:35:00.000Z",
      action_type: "wake_agent",
      agent_id: "shifu-u-1",
      thread_id: "line-conversation-1",
      delivery_intent: {
        contract: "personal_reminder_delivery.v1",
        destination: "personal_reminder",
      },
    });
  });
});
