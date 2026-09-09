import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReleaseCapabilityState } from "@lobu/core";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import type { ProgressUpdate } from "../core/types";
import { OpenClawProgressProcessor } from "../openclaw/processor";
import { runAISession } from "../openclaw/session-runner";

function activeRelease(capabilityIds: string[]): ReleaseCapabilityState {
  return {
    status: "active",
    claim: {
      environment: "production",
      toolboxUserId: "fixture",
      agentId: "fixture",
      releaseId: "candidate-fixture",
      releaseSequence: 1,
      snapshotDigest: "fixture",
      expiresAt: "2099-01-01T00:00:00Z",
      capabilityIds,
    },
  };
}
const STRICT_RELEASE = activeRelease(["calendar.output_consistency.v2"]);

// Exercise the real runner/processor/output callback. Only the provider and
// context loading are replaced; no source-text assertions or live model calls.
async function runOutputFixture(
  chunks: string[],
  options: {
    stopReason?: "stop" | "error";
    stream?: boolean;
    withTool?: boolean;
    silentFirst?: boolean;
    userPrompt?: string;
    toolName?: string;
    toolError?: boolean;
    releaseState?: ReleaseCapabilityState | null;
  } = {}
) {
  const stopReason = options.stopReason ?? "stop";
  const workspaceDir = await mkdtemp(join(tmpdir(), "lobu-date-output-"));
  const updates: ProgressUpdate[] = [];
  const beforeFinal: ProgressUpdate[] = [];
  const processor = new OpenClawProgressProcessor();
  let promptCount = 0;
  let listener: (event: AgentSessionEvent) => void = () => undefined;
  const emit = (event: unknown) => listener(event as AgentSessionEvent);
  try {
    const result = await runAISession({
      userPrompt: options.userPrompt ?? "請整理這份資料",
      customInstructions: "",
      onProgress: async (update) => {
        updates.push(update);
      },
      agentOptions: JSON.stringify({ model: "openai/gpt-4o-mini" }),
      sessionKey: "date-output",
      channelId: "date-output",
      conversationId: "date-output",
      platform: "internal",
      platformMetadata: {},
      agentId: undefined,
      workspaceDir,
      progressProcessor: processor,
      onSessionFilePathResolved: () => undefined,
      onModelResolved: () => undefined,
      loadImageAttachments: async () => [],
      maybeRunPreCompactionMemoryFlush: async ({ runSilentPrompt }) => {
        if (options.silentFirst) await runSilentPrompt("internal memory flush");
      },
      maybeBuildAuthHintMessage: (message) => message,
      runAISessionDependencies: {
        sessionContextLoader: async () => ({
          agentInstructions: "",
          gatewayInstructions: "",
          providerConfig: {
            defaultProvider: "openai",
            defaultModel: "gpt-4o-mini",
          },
          skillsConfig: [],
          mcpStatus: [],
          mcpTools: {},
          mcpContext: {},
          toolboxPersonalAgentTools: [],
          userId: "",
          agentId: "",
          releaseState:
            options.releaseState === null
              ? undefined
              : (options.releaseState ?? STRICT_RELEASE),
        }),
        agentSessionBuilder: async () =>
          ({
            session: {
              agent: { abort: () => undefined },
              messages: [],
              subscribe: (callback: typeof listener) => {
                listener = callback;
                return () => {
                  listener = () => undefined;
                };
              },
              prompt: async () => {
                promptCount += 1;
                if (options.silentFirst && promptCount === 1) {
                  emit({
                    type: "message_update",
                    message: { role: "assistant" },
                    assistantMessageEvent: {
                      type: "text_delta",
                      delta: "PRIVATE 2026-08-25（星期一）",
                    },
                  });
                  emit({ type: "agent_end" });
                  return;
                }
                if (options.withTool) {
                  emit({
                    type: "tool_execution_start",
                    toolCallId: "fixture-tool",
                    toolName: options.toolName ?? "search_memory",
                    args: {},
                  });
                  emit({
                    type: "tool_execution_end",
                    toolCallId: "fixture-tool",
                    toolName: options.toolName ?? "search_memory",
                    result: { content: [{ type: "text", text: "ok" }] },
                    isError: options.toolError === true,
                  });
                }
                for (const delta of options.stream === false ? [] : chunks) {
                  emit({
                    type: "message_update",
                    message: { role: "assistant" },
                    assistantMessageEvent: { type: "text_delta", delta },
                  });
                  // Cross the old 150ms batching boundary, including after the
                  // complete erroneous weekday, before final guards can run.
                  await new Promise((resolve) => setTimeout(resolve, 180));
                }
                beforeFinal.push(...updates);
                emit({
                  type: "message_end",
                  message: {
                    role: "assistant",
                    content: [{ type: "text", text: chunks.join("") }],
                    stopReason,
                    ...(stopReason === "error"
                      ? { errorMessage: "fixture provider failure" }
                      : {}),
                  },
                });
                emit({ type: "agent_end" });
              },
              dispose: () => undefined,
            },
          }) as never,
        emitEvent: () => undefined,
      },
    });
    return { result, updates, beforeFinal, final: processor.getFinalResult() };
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

describe("runAISession date output boundary", () => {
  test.each([
    null,
    { status: "legacy_unenrolled" } as const,
    {
      status: "enrolled_inactive",
      environment: "production",
      reason: "capability_expired",
    } as const,
    activeRelease([]),
    activeRelease(["sales_battle_report.session_mode.v1"]),
  ])("preserves legacy ordinary streaming without an active calendar claim: %j", async (releaseState) => {
    const { result, beforeFinal, updates, final } = await runOutputFixture(
      ["2026/8/25 是星期一"],
      { releaseState }
    );
    expect(result.success).toBe(true);
    expect(
      beforeFinal.filter((u) => u.type === "output").map((u) => u.data)
    ).toEqual(["2026/8/25 是星期一"]);
    expect(
      updates.filter((u) => u.type === "output").map((u) => u.data)
    ).toEqual(["2026/8/25 是星期一"]);
    expect(final?.text).toBe("2026/8/25 是星期一");
  });

  test("legacy date-intent still buffers and corrects the existing ISO weekday syntax", async () => {
    const { result, beforeFinal, updates } = await runOutputFixture(
      ["2026-08-", "25（星期一）"],
      { releaseState: null, userPrompt: "核對日期" }
    );
    expect(result.success).toBe(true);
    expect(beforeFinal.filter((u) => u.type === "output")).toEqual([]);
    expect(
      updates.filter((u) => u.type === "output").map((u) => u.data)
    ).toEqual(["2026-08-25（星期二）"]);
  });

  test("legacy completion claims still buffer and reject missing tool evidence", async () => {
    const { beforeFinal, updates } = await runOutputFixture(
      ["已完成暫停戰報。"],
      { releaseState: null, userPrompt: "暫停戰報", silentFirst: true }
    );
    expect(beforeFinal.filter((u) => u.type === "output")).toEqual([]);
    expect(
      updates
        .filter((u) => u.type === "output")
        .map((u) => u.data)
        .join("")
    ).toContain("還沒有成功呼叫對應工具");
    expect(
      updates
        .filter((u) => u.type === "output")
        .map((u) => u.data)
        .join("")
    ).not.toContain("PRIVATE");
  });

  test("legacy date-intent provider errors do not flush raw buffered text", async () => {
    const { result, updates } = await runOutputFixture(
      ["2026-08-25（星期一）"],
      { releaseState: null, userPrompt: "核對日期", stopReason: "error" }
    );
    expect(result.success).toBe(false);
    expect(updates.filter((u) => u.type === "output")).toEqual([]);
  });

  test.each([
    ["2026-08-", "25（星期", "一）"],
    ["2026/8/", "25 是星期", "一"],
  ])("withholds cross-chunk wrong weekdays on non-date prompts: %j", async (...chunks) => {
    const { result, updates, beforeFinal, final } =
      await runOutputFixture(chunks);
    expect(result.success).toBe(true);
    expect(beforeFinal.filter((update) => update.type === "output")).toEqual(
      []
    );
    const outputs = updates
      .filter((update) => update.type === "output")
      .map((update) => update.data);
    expect(outputs).toEqual([chunks.join("").replace("星期一", "星期二")]);
    expect(final?.text).toBe(outputs[0]);
    expect(outputs.join("")).not.toContain("星期一");
  });

  test("never sends an impossible date even after a batch timer would fire", async () => {
    const { result, updates, beforeFinal, final } = await runOutputFixture([
      "2026/2/29 星期一",
    ]);
    expect(result.success).toBe(true);
    expect(beforeFinal.filter((update) => update.type === "output")).toEqual(
      []
    );
    const outputs = updates
      .filter((update) => update.type === "output")
      .map((update) => update.data);
    expect(outputs).toHaveLength(1);
    expect(outputs.join("")).not.toContain("2026/2/29");
    expect(final?.text).toBe(outputs[0]);
  });

  test("buffers ordinary text until completion too (latency tradeoff)", async () => {
    const { result, updates, beforeFinal } = await runOutputFixture([
      "整理",
      "完成",
    ]);
    expect(result.success).toBe(true);
    expect(beforeFinal.filter((update) => update.type === "output")).toEqual(
      []
    );
    expect(
      updates
        .filter((update) => update.type === "output")
        .map((update) => update.data)
    ).toEqual(["整理完成"]);
  });

  test("discards buffered partial output when the provider fails", async () => {
    const { result, updates } = await runOutputFixture(
      ["2026-08-25（星期一）"],
      { stopReason: "error" }
    );
    expect(result.success).toBe(false);
    expect(updates.filter((update) => update.type === "output")).toEqual([]);
  });

  test("validates a message_end-only provider before sending the fallback text", async () => {
    const { result, updates, final } = await runOutputFixture(
      ["2026/8/25 是星期一"],
      { stream: false }
    );
    expect(result.success).toBe(true);
    expect(
      updates
        .filter((update) => update.type === "output")
        .map((update) => update.data)
    ).toEqual(["2026/8/25 是星期二"]);
    expect(final?.text).toBe("2026/8/25 是星期二");
  });

  test("keeps tool events live while model text is buffered", async () => {
    const { result, beforeFinal, updates } = await runOutputFixture(
      ["2026-08-25（星期一）"],
      { withTool: true }
    );
    expect(result.success).toBe(true);
    expect(
      beforeFinal.some(
        (update) =>
          update.type === "custom_event" && update.data.name === "tool_use"
      )
    ).toBe(true);
    expect(beforeFinal.filter((update) => update.type === "output")).toEqual(
      []
    );
    expect(
      updates
        .filter((update) => update.type === "output")
        .map((update) => update.data)
        .join("")
    ).not.toContain("星期一");
  });

  test("silent memory turns cannot contaminate the visible answer", async () => {
    const { result, updates, final } = await runOutputFixture(
      ["2026-08-25（星期一）"],
      { silentFirst: true }
    );
    expect(result.success).toBe(true);
    expect(
      updates
        .filter((update) => update.type === "output")
        .map((update) => update.data)
    ).toEqual(["2026-08-25（星期二）"]);
    expect(final?.text).toBe("2026-08-25（星期二）");
  });

  test.each([
    "absent",
    "failed",
    "successful",
  ] as const)("completion-claim guard remains authoritative with %s tool evidence", async (evidence) => {
    const { result, updates, beforeFinal, final } = await runOutputFixture(
      ["已完成暫停戰報，2026-08-25（星期一）。"],
      {
        userPrompt: "暫停戰報",
        withTool: evidence !== "absent",
        toolName: "sales_battle_report_schedule_pause",
        toolError: evidence === "failed",
      }
    );
    expect(result.success).toBe(true);
    expect(beforeFinal.filter((update) => update.type === "output")).toEqual(
      []
    );
    const outputs = updates
      .filter((update) => update.type === "output")
      .map((update) => update.data);
    expect(outputs).toHaveLength(1);
    expect(final?.text).toBe(outputs[0]);
    expect(outputs.join("")).not.toContain("星期一");
    if (evidence === "successful") {
      expect(outputs[0]).toContain("已完成暫停戰報，2026-08-25（星期二）。");
    } else {
      expect(outputs[0]).not.toContain("已完成暫停戰報");
      expect(outputs[0]).toContain("還沒有成功呼叫對應工具");
    }
  });
});
