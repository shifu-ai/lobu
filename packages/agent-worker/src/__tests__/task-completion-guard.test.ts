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

describe("evaluateTaskCompletion write intent guard", () => {
  test("fails when Chinese write-intent task only executed read tools", () => {
    const result = evaluateTaskCompletion({
      latestUserText:
        "那可以幫我修改超級AI個體商品頁嗎？是一份google doc我想要根據銷講簡報v5的內容調整 可以直接幫我改",
      finalVisibleText: "我已經讀完文件。",
      toolExecutions: [
        { toolName: "google_workspace_docs_read", isError: false },
        { toolName: "google_workspace_slides_read", isError: false },
      ],
    });

    expect(result).toEqual({
      outcome: "failed_incomplete",
      reason: "task_completion_write_intent_without_write",
      userVisibleMessage:
        "我讀到了任務需要的資料，但這輪沒有成功執行寫入工具，因此沒有把任務標成完成。我沒有把任何變更寫入外部文件。",
    });
  });

  test("allows write-intent task when a docs batch update succeeds", () => {
    const result = evaluateTaskCompletion({
      latestUserText: "請直接幫我修改 Google Doc",
      finalVisibleText: "我已經完成 Google Doc 修改。",
      toolExecutions: [
        { toolName: "google_workspace_docs_read", isError: false },
        {
          toolName: "gws_docs_batch_update",
          isError: false,
          resultSummary: { effect_verified: true, effect_status: "verified" },
        },
      ],
    });

    expect(result).toEqual({
      outcome: "completed",
      reason: "ok",
    });
  });

  test("does not count failed write tool as write evidence", () => {
    const result = evaluateTaskCompletion({
      latestUserText: "update the Google Doc",
      finalVisibleText: "I tried to update it.",
      toolExecutions: [{ toolName: "docs_batch_update", isError: true }],
    });

    expect(result.outcome).toBe("failed_incomplete");
    expect(result.reason).toBe("task_completion_write_intent_without_write");
  });

  test("blocks Google Docs write-intent task when batch update effect is unknown", () => {
    const result = evaluateTaskCompletion({
      latestUserText: "請直接幫我修改 Google Doc",
      finalVisibleText: "我已經完成 Google Doc 修改。",
      toolExecutions: [
        {
          toolName: "gws_docs_batch_update",
          isError: false,
          resultSummary: { effect_verified: false, effect_status: "unknown" },
        },
      ],
    });

    expect(result).toEqual({
      outcome: "failed_incomplete",
      reason: "task_completion_unverified_writeback",
      userVisibleMessage:
        "我有呼叫寫入工具，但這輪沒有取得外部文件確實被修改的證據，因此沒有把任務標成完成。請確認文件內容或重新指示我用可驗證的方式修改。",
    });
  });

  test("does not treat 'I updated what you need' as a visible blocker", () => {
    const result = evaluateTaskCompletion({
      latestUserText: "update the Google Doc",
      finalVisibleText: "I updated what you need",
      toolExecutions: [],
    });

    expect(result.outcome).toBe("failed_incomplete");
    expect(result.reason).toBe("task_completion_write_intent_without_write");
  });

  test("does not treat 'I can confirm it is updated' as a visible blocker", () => {
    const result = evaluateTaskCompletion({
      latestUserText: "update the Google Doc",
      finalVisibleText: "I can confirm it is updated",
      toolExecutions: [],
    });

    expect(result.outcome).toBe("failed_incomplete");
    expect(result.reason).toBe("task_completion_write_intent_without_write");
  });

  test("fails when Chinese adjust-doc task only executed read tools", () => {
    const result = evaluateTaskCompletion({
      latestUserText: "請根據銷講簡報調整 Google Doc",
      finalVisibleText: "我已經讀完文件。",
      toolExecutions: [
        { toolName: "google_workspace_docs_read", isError: false },
        { toolName: "google_workspace_slides_read", isError: false },
      ],
    });

    expect(result.outcome).toBe("failed_incomplete");
    expect(result.reason).toBe("task_completion_write_intent_without_write");
  });

  test("allows write-intent task when final text asks for missing permission", () => {
    const result = evaluateTaskCompletion({
      latestUserText: "幫我改這份 Google Doc",
      finalVisibleText:
        "我目前沒有 Google Docs 寫入權限，請先授權後我才能修改。",
      toolExecutions: [
        { toolName: "google_workspace_docs_read", isError: false },
      ],
    });

    expect(result).toEqual({
      outcome: "completed",
      reason: "ok",
    });
  });
});

describe("2026-07-02 write tool pattern fail-open guard", () => {
  test("notion page creation counts as write evidence", () => {
    const decision = evaluateTaskCompletion({
      latestUserText: "幫我新增notion頁面 標題是AI",
      finalVisibleText: "已建立 Notion 頁面！",
      toolExecutions: [{ toolName: "notion-create-pages", isError: false }],
    });
    expect(decision.outcome).toBe("completed");
  });

  test("google docs creation counts as write evidence (suffixed variant)", () => {
    const decision = evaluateTaskCompletion({
      latestUserText: "幫我新增一個google doc 標題寫ai pm",
      finalVisibleText: "Google Doc 已建立成功！",
      toolExecutions: [
        { toolName: "google_workspace_docs_create_2", isError: false },
      ],
    });
    expect(decision.outcome).toBe("completed");
  });

  test("unknown non-read tool fails open as write evidence", () => {
    const decision = evaluateTaskCompletion({
      latestUserText: "幫我建立排程",
      finalVisibleText: "排程已建立。",
      toolExecutions: [
        { toolName: "sales_battle_report_schedule_create", isError: false },
      ],
    });
    expect(decision.outcome).toBe("completed");
  });

  test("write intent with only read tools still fails incomplete", () => {
    const decision = evaluateTaskCompletion({
      latestUserText: "幫我更新那份文件",
      finalVisibleText: "我找到了文件。",
      toolExecutions: [
        { toolName: "notion_search_2", isError: false },
        { toolName: "google_workspace_drive_search", isError: false },
      ],
    });
    expect(decision.outcome).toBe("failed_incomplete");
    expect(decision.reason).toBe("task_completion_write_intent_without_write");
  });

  test("gws read tools in write namespaces are not write evidence", () => {
    const decision = evaluateTaskCompletion({
      latestUserText: "幫我更新文件",
      finalVisibleText: "我看完文件了。",
      toolExecutions: [
        { toolName: "google_workspace_docs_read", isError: false },
        { toolName: "docs_search_2", isError: false },
      ],
    });
    expect(decision.outcome).toBe("failed_incomplete");
  });

  test("hyphenated notion read tools are not write evidence", () => {
    const decision = evaluateTaskCompletion({
      latestUserText: "幫我更新那份文件",
      finalVisibleText: "我查到了相關頁面。",
      toolExecutions: [
        { toolName: "notion-search", isError: false },
        { toolName: "notion-get-comments", isError: false },
        { toolName: "notion-query-data-sources", isError: false },
      ],
    });
    expect(decision.outcome).toBe("failed_incomplete");
  });
});

describe("2026-07-02 approval-blocked turn guard", () => {
  test("allows write-intent task when final text says waiting for approval (Chinese)", () => {
    const result = evaluateTaskCompletion({
      latestUserText: "幫我改這份 Google Doc",
      finalVisibleText: "我已送出授權請求，等你核准後就會執行。",
      toolExecutions: [
        { toolName: "google_workspace_docs_read", isError: false },
      ],
    });

    expect(result.outcome).toBe("completed");
  });

  test("allows write-intent task when final text says waiting for approval (English)", () => {
    const result = evaluateTaskCompletion({
      latestUserText: "please create the doc for me",
      finalVisibleText: "I'm waiting for your approval to create the doc.",
      toolExecutions: [],
    });

    expect(result.outcome).toBe("completed");
  });

  test("allows write-intent task when errored tool result text signals approval required", () => {
    const result = evaluateTaskCompletion({
      latestUserText: "幫我新增 Notion 頁面",
      finalVisibleText: "我先確認一下內容。",
      toolExecutions: [
        {
          toolName: "notion-create-pages",
          isError: false,
          resultSummary: {
            error:
              "Error: Tool call requires approval. The user has been asked to approve. Your session will end. The result will arrive as your next message.",
          },
        },
      ],
    });

    expect(result.outcome).toBe("completed");
  });
});

describe("2026-06-25 Google Doc rewrite regression", () => {
  test("blocks completed status when doc rewrite task only reads docs and slides", () => {
    const result = evaluateTaskCompletion({
      latestUserText:
        "那可以幫我修改超級AI個體商品頁嗎？是一份google doc我想要根據銷講簡報v5的內容調整 可以直接幫我改",
      finalVisibleText: "我現在會開始讀取文件內容。",
      toolExecutions: [
        { toolName: "google_workspace_docs_read", isError: false },
        { toolName: "google_workspace_slides_read", isError: false },
      ],
    });

    expect(result.outcome).toBe("failed_incomplete");
    expect(result.reason).toBe("task_completion_write_intent_without_write");
  });

  test("blocks completed status when same task ends thinking-only with no visible text", () => {
    const result = evaluateTaskCompletion({
      latestUserText:
        "那可以幫我修改超級AI個體商品頁嗎？是一份google doc我想要根據銷講簡報v5的內容調整 可以直接幫我改",
      finalVisibleText: "",
      toolExecutions: [
        { toolName: "google_workspace_docs_read", isError: false },
        { toolName: "google_workspace_slides_read", isError: false },
      ],
    });

    expect(result.outcome).toBe("failed_incomplete");
    expect(result.reason).toBe("task_completion_empty_final");
  });
});
