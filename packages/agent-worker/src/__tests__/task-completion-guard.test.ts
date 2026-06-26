import { describe, expect, test } from "bun:test";
import { evaluateTaskCompletion } from "../openclaw/task-completion-guard";

describe("evaluateTaskCompletion empty final guard", () => {
  test("fails incomplete when final visible text is empty", () => {
    const result = evaluateTaskCompletion({
      latestUserText: "請幫我整理這份文件",
      finalVisibleText: "",
      toolExecutions: [],
    });

    expect(result).toEqual({
      outcome: "failed_incomplete",
      reason: "task_completion_empty_final",
      userVisibleMessage:
        "我這輪沒有產生可交付的回覆，因此沒有把任務標成完成。請重新指示或稍後再試。",
    });
  });

  test("fails incomplete when final visible text is whitespace only", () => {
    const result = evaluateTaskCompletion({
      latestUserText: "summarize this",
      finalVisibleText: " \n\t ",
      toolExecutions: [],
    });

    expect(result.outcome).toBe("failed_incomplete");
    expect(result.reason).toBe("task_completion_empty_final");
  });

  test("allows completed when final visible text is non-empty and no write intent exists", () => {
    const result = evaluateTaskCompletion({
      latestUserText: "幫我摘要這份文件",
      finalVisibleText: "這份文件的重點是 A、B、C。",
      toolExecutions: [],
    });

    expect(result).toEqual({
      outcome: "completed",
      reason: "ok",
    });
  });
});
