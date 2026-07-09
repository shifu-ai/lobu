import { describe, expect, test } from "bun:test";
import {
  checkCompletionClaim,
  getSuccessfulCompletionClaimToolNames,
} from "../openclaw/completion-claim-guard";

describe("checkCompletionClaim", () => {
  test("blocks a battle report run claim without matching tool execution", () => {
    const result = checkCompletionClaim({
      userMessage: "幫我現在產生本週戰報",
      finalText: "已完成，本週戰報已經產生。",
      executedTools: [],
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("mutating_claim_without_tool_execution");
    expect(result.safeText).toContain("我還沒有成功呼叫對應工具");
    expect(result.requiredTools).toEqual(["sales_battle_report_run_now"]);
  });

  test("blocks a battle report send claim without matching tool execution", () => {
    const result = checkCompletionClaim({
      userMessage: "發送戰報",
      finalText: "已發送戰報。",
      executedTools: [],
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("mutating_claim_without_tool_execution");
    expect(result.requiredTools).toEqual(["sales_battle_report_run_now"]);
  });

  test("blocks the Irene battle report completion claim without tool execution", () => {
    const result = checkCompletionClaim({
      userMessage: "幫我立即發送 Irene 的戰報",
      finalText: "已幫你發送 Irene 的戰報。",
      executedTools: [],
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("mutating_claim_without_tool_execution");
    expect(result.safeText).toContain("我還沒有成功呼叫對應工具");
  });

  test("allows an immediate battle report send claim with matching tool execution", () => {
    const result = checkCompletionClaim({
      userMessage: "立即發送戰報",
      finalText: "已發送戰報。",
      executedTools: ["sales_battle_report_run_now"],
    });

    expect(result.allowed).toBe(true);
  });

  test("blocks immediate send claims when only schedule tools ran", () => {
    for (const toolName of [
      "sales_battle_report_schedule_create",
      "sales_battle_report_schedule_pause",
      "sales_battle_report_schedule_update",
    ]) {
      const result = checkCompletionClaim({
        userMessage: "幫我立即發送 Irene 的戰報",
        finalText: "已幫你發送 Irene 的戰報。",
        executedTools: [toolName],
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("mutating_claim_without_tool_execution");
      expect(result.requiredTools).toEqual(["sales_battle_report_run_now"]);
    }
  });

  test("allows battle report send claims only after run_now succeeds", () => {
    const result = checkCompletionClaim({
      userMessage: "幫我立即發送 Irene 的戰報",
      finalText: "已幫你發送 Irene 的戰報。",
      executedTools: ["sales_battle_report_run_now"],
    });

    expect(result.allowed).toBe(true);
  });

  test("blocks an English imperative send claim without matching tool execution", () => {
    const result = checkCompletionClaim({
      userMessage: "send battle report",
      finalText: "Done, I sent the battle report.",
      executedTools: [],
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("mutating_claim_without_tool_execution");
    expect(result.requiredTools).toEqual(["sales_battle_report_run_now"]);
  });

  test("allows English sent status answers without tool execution", () => {
    const result = checkCompletionClaim({
      userMessage: "Was yesterday battle report sent?",
      finalText: "Yes, it was sent.",
      executedTools: [],
    });

    expect(result.allowed).toBe(true);
  });

  test("allows a battle report schedule claim with matching tool execution", () => {
    const result = checkCompletionClaim({
      userMessage: "幫我建立每週一早上的銷售戰報排程",
      finalText: "排程已建立。",
      executedTools: ["sales_battle_report_schedule_create"],
    });

    expect(result.allowed).toBe(true);
  });

  test("allows read-only battle report answers", () => {
    const result = checkCompletionClaim({
      userMessage: "幫我看一下目前銷售戰報排程有哪些",
      finalText: "目前有一個每週一早上的排程。",
      executedTools: [],
    });

    expect(result.allowed).toBe(true);
  });

  test("allows mutating battle report requests when final text does not claim done", () => {
    const result = checkCompletionClaim({
      userMessage: "暫停每週銷售戰報排程",
      finalText: "我需要先確認要暫停哪一個排程。",
      executedTools: [],
    });

    expect(result.allowed).toBe(true);
  });

  test("blocks schedule pause claims after only schedule create ran", () => {
    const result = checkCompletionClaim({
      userMessage: "暫停每週銷售戰報排程",
      finalText: "已暫停排程。",
      executedTools: ["sales_battle_report_schedule_create"],
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("mutating_claim_without_tool_execution");
    expect(result.requiredTools).toEqual([
      "sales_battle_report_schedule_pause",
    ]);
  });

  test("allows schedule pause claims with matching pause tool execution", () => {
    const result = checkCompletionClaim({
      userMessage: "暫停每週銷售戰報排程",
      finalText: "已暫停排程。",
      executedTools: ["sales_battle_report_schedule_pause"],
    });

    expect(result.allowed).toBe(true);
  });

  test("blocks schedule create claims when only other battle report tools ran", () => {
    for (const toolName of [
      "sales_battle_report_schedule_pause",
      "sales_battle_report_schedule_update",
      "sales_battle_report_run_now",
    ]) {
      const result = checkCompletionClaim({
        userMessage: "幫我建立每週一早上的銷售戰報排程",
        finalText: "排程已建立。",
        executedTools: [toolName],
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("mutating_claim_without_tool_execution");
      expect(result.requiredTools).toEqual([
        "sales_battle_report_schedule_create",
      ]);
    }
  });

  test("allows schedule update claims with matching update tool execution", () => {
    const result = checkCompletionClaim({
      userMessage: "把每週銷售戰報排程改成週五下午",
      finalText: "已更新排程。",
      executedTools: ["sales_battle_report_schedule_update"],
    });

    expect(result.allowed).toBe(true);
  });

  test("does not treat failed catalog tool_call results as successful evidence", () => {
    const executedTools = getSuccessfulCompletionClaimToolNames({
      toolName: "tool_call",
      args: { tool_name: "sales_battle_report_run_now" },
      result: {
        content: [
          {
            type: "text",
            text: "Error: Tool call requires approval.",
          },
        ],
      },
      isError: false,
    });
    const result = checkCompletionClaim({
      userMessage: "幫我立即發送 Irene 的戰報",
      finalText: "已幫你發送 Irene 的戰報。",
      executedTools,
    });

    expect(executedTools).toEqual([]);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("mutating_claim_without_tool_execution");
  });

  test("treats successful catalog tool_call targets as completion evidence", () => {
    const executedTools = getSuccessfulCompletionClaimToolNames({
      toolName: "tool_call",
      args: { tool_name: "sales_battle_report_run_now" },
      result: {
        content: [{ type: "text", text: "ok" }],
      },
      isError: false,
    });
    const result = checkCompletionClaim({
      userMessage: "幫我立即發送 Irene 的戰報",
      finalText: "已幫你發送 Irene 的戰報。",
      executedTools,
    });

    expect(executedTools).toEqual(["tool_call", "sales_battle_report_run_now"]);
    expect(result.allowed).toBe(true);
  });

  test("does not treat the tool_call wrapper alone as mutating evidence", () => {
    const executedTools = getSuccessfulCompletionClaimToolNames({
      toolName: "tool_call",
      args: {},
      result: {
        content: [{ type: "text", text: "ok" }],
      },
      isError: false,
    });
    const result = checkCompletionClaim({
      userMessage: "幫我立即發送 Irene 的戰報",
      finalText: "已幫你發送 Irene 的戰報。",
      executedTools,
    });

    expect(executedTools).toEqual(["tool_call"]);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("mutating_claim_without_tool_execution");
  });
});
