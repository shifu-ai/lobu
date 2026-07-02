import { createLogger } from "@lobu/core";

const logger = createLogger("task-completion-guard");

export type TaskCompletionOutcome =
  | "completed"
  | "failed_incomplete"
  | "incomplete_retryable";

export type TaskCompletionReason =
  | "ok"
  | "task_completion_empty_final"
  | "task_completion_write_intent_without_write"
  | "task_completion_unverified_writeback";

export interface ToolExecutionSummary {
  toolName: string;
  isError: boolean;
  resultSummary?: {
    effect_verified?: boolean;
    effect_status?: string;
    error?: string;
  };
}

export interface TaskCompletionInput {
  latestUserText: string;
  finalVisibleText: string;
  toolExecutions: ToolExecutionSummary[];
}

export type TaskCompletionDecision =
  | {
      outcome: "completed";
      reason: "ok";
    }
  | {
      outcome: "failed_incomplete";
      reason: Exclude<TaskCompletionReason, "ok">;
      userVisibleMessage: string;
    }
  | {
      outcome: "incomplete_retryable";
      reason: Exclude<TaskCompletionReason, "ok">;
      continuationPrompt: string;
    };

const EMPTY_FINAL_MESSAGE =
  "我這輪沒有產生可交付的回覆，因此沒有把任務標成完成。請重新指示或稍後再試。";

const WRITE_INTENT_WITHOUT_WRITE_MESSAGE =
  "我讀到了任務需要的資料，但這輪沒有成功執行寫入工具，因此沒有把任務標成完成。我沒有把任何變更寫入外部文件。";
const UNVERIFIED_WRITEBACK_MESSAGE =
  "我有呼叫寫入工具，但這輪沒有取得外部文件確實被修改的證據，因此沒有把任務標成完成。請確認文件內容或重新指示我用可驗證的方式修改。";

const WRITE_INTENT_PATTERNS = [
  /直接.*幫我.*改/i,
  /幫我.*(?:改|修改|更新|寫入|建立|新增|刪除|寄出|發送|調整|編輯|補上|套用|插入|替換)/i,
  /(?:改|修改|更新|寫入|建立|新增|刪除|寄出|發送|調整|編輯|補上|套用|插入|替換).*(?:文件|doc|sheet|slide|簡報|訊息|email|郵件)/i,
  /\b(?:update|edit|write|send|create|delete|modify|revise|add|append|insert|replace)\b/i,
];

const BLOCKER_PATTERNS = [
  /(?:沒有|缺少|需要|無法|不能).*(?:權限|授權|確認|資訊|連結|存取)/i,
  /(?:請|需要).*(?:確認|授權|提供|補充)/i,
  /\b(?:cannot|can't|unable)\b.*\b(?:access|write|update|edit|modify|send|create|delete|permission|authorize|approval)\b/i,
  /\b(?:need|missing|lack|lacking|without)\b.*\b(?:permission|authorization|approval|access|confirmation|information|link)\b/i,
  /\b(?:please|need you to)\b.*\b(?:authorize|approve|confirm|provide|grant|share|send)\b/i,
  /(?:等|待|需要|請).*(?:核准|批准|同意|授權)/i,
  /(?:核准|批准|同意|授權).*(?:後|之後).*(?:執行|繼續|進行)/i,
  /\b(?:waiting for|awaiting|pending|once you|after you)\b.*\b(?:approv|authoriz|consent)/i,
  /(?:同意|授權)(?:卡|請求|按鈕)/i,
];

const TOOL_RESULT_APPROVAL_REQUIRED_PATTERN = /requires approval/i;

const WRITE_TOOL_PATTERNS = [
  /_batch_update(_\d+)?$/i,
  /_values_update(_\d+)?$/i,
  /_messages_create(_\d+)?$/i,
  /(^|_)(docs|sheets|slides|calendar_events)_(create|update|delete)(_\d+)?$/i,
  /^notion[-_](create|update|move|duplicate)[-_]/i,
  /^submit_course_pm_profile(_\d+)?$/i,
  /^write_segments(_\d+)?$/i,
  /^card_studio_(write|create|update|delete)_/i,
  /^sales_battle_report_schedule_(create|update|delete|pause)(_\d+)?$/i,
];
const GOOGLE_DOCS_WRITE_TOOL_PATTERNS = [
  /^(gws_|google_workspace_)?docs_batch_update(_\d+)?$/i,
];

const READ_ONLY_TOOL_PATTERNS = [
  /(^|[-_])(search|list|get|read|fetch|query|describe|check|status|find|help|access)([-_]|$|\d)/i,
];

function isReadOnlyTool(toolName: string): boolean {
  return READ_ONLY_TOOL_PATTERNS.some((pattern) => pattern.test(toolName));
}

export function evaluateTaskCompletion(
  input: TaskCompletionInput
): TaskCompletionDecision {
  const finalText = input.finalVisibleText.trim();

  logFailOpenWriteEvidence(input.toolExecutions);

  if (!finalText) {
    return {
      outcome: "failed_incomplete",
      reason: "task_completion_empty_final",
      userVisibleMessage: EMPTY_FINAL_MESSAGE,
    };
  }

  if (
    hasWriteIntent(input.latestUserText) &&
    hasUnverifiedWriteEvidence(input.toolExecutions) &&
    !hasVisibleBlocker(finalText) &&
    !hasApprovalBlockedToolResult(input.toolExecutions)
  ) {
    return {
      outcome: "failed_incomplete",
      reason: "task_completion_unverified_writeback",
      userVisibleMessage: UNVERIFIED_WRITEBACK_MESSAGE,
    };
  }

  if (
    hasWriteIntent(input.latestUserText) &&
    !hasSuccessfulWriteEvidence(input.toolExecutions) &&
    !hasVisibleBlocker(finalText) &&
    !hasApprovalBlockedToolResult(input.toolExecutions)
  ) {
    return {
      outcome: "failed_incomplete",
      reason: "task_completion_write_intent_without_write",
      userVisibleMessage: WRITE_INTENT_WITHOUT_WRITE_MESSAGE,
    };
  }

  return {
    outcome: "completed",
    reason: "ok",
  };
}

export function hasWriteIntent(text: string): boolean {
  return WRITE_INTENT_PATTERNS.some((pattern) => pattern.test(text));
}

export function hasSuccessfulWriteEvidence(
  toolExecutions: ToolExecutionSummary[]
): boolean {
  return toolExecutions.some(
    (tool) =>
      !tool.isError &&
      (!isGoogleDocsWriteTool(tool.toolName) ||
        tool.resultSummary?.effect_verified === true) &&
      (WRITE_TOOL_PATTERNS.some((pattern) => pattern.test(tool.toolName)) ||
        !isReadOnlyTool(tool.toolName))
  );
}

/**
 * Returns the tool names that only counted as write evidence via the
 * fail-open disjunct in `hasSuccessfulWriteEvidence` — i.e. tools that are
 * not error, not a recognized write tool, and not a recognized read-only
 * tool either. These are "unknown" tools the guard is uncertain about, and
 * their fail-open classification should be observable (spec AC2).
 */
function getFailOpenWriteEvidenceTools(
  toolExecutions: ToolExecutionSummary[]
): string[] {
  return toolExecutions
    .filter(
      (tool) =>
        !tool.isError &&
        !WRITE_TOOL_PATTERNS.some((pattern) => pattern.test(tool.toolName)) &&
        !isReadOnlyTool(tool.toolName)
    )
    .map((tool) => tool.toolName);
}

function logFailOpenWriteEvidence(
  toolExecutions: ToolExecutionSummary[]
): void {
  const failOpenTools = getFailOpenWriteEvidenceTools(toolExecutions);
  if (failOpenTools.length > 0) {
    logger.warn("guard_uncertain", {
      reason: "unknown_tool_fail_open_as_write_evidence",
      toolNames: failOpenTools,
    });
  }
}

export function hasUnverifiedWriteEvidence(
  toolExecutions: ToolExecutionSummary[]
): boolean {
  return toolExecutions.some(
    (tool) =>
      !tool.isError &&
      isGoogleDocsWriteTool(tool.toolName) &&
      tool.resultSummary?.effect_verified !== true
  );
}

function isGoogleDocsWriteTool(toolName: string): boolean {
  return GOOGLE_DOCS_WRITE_TOOL_PATTERNS.some((pattern) =>
    pattern.test(toolName)
  );
}

export function hasVisibleBlocker(finalVisibleText: string): boolean {
  return BLOCKER_PATTERNS.some((pattern) => pattern.test(finalVisibleText));
}

/**
 * Deterministic blocker signal: a turn whose tool executions include an
 * errored tool call whose result text indicates the call was blocked
 * pending approval (e.g. an MCP write tool rejected by the approval gate).
 * This does not depend on the model's final text mentioning approval at
 * all, so it catches cases where BLOCKER_PATTERNS would otherwise miss the
 * phrasing.
 */
export function hasApprovalBlockedToolResult(
  toolExecutions: ToolExecutionSummary[]
): boolean {
  return toolExecutions.some(
    (tool) =>
      tool.isError &&
      typeof tool.resultSummary?.error === "string" &&
      TOOL_RESULT_APPROVAL_REQUIRED_PATTERN.test(tool.resultSummary.error)
  );
}
