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
];

const WRITE_TOOL_PATTERNS = [
  /_batch_update$/i,
  /_values_update$/i,
  /_messages_create$/i,
  /^docs_batch_update$/i,
  /^gws_docs_batch_update$/i,
  /^google_workspace_docs_batch_update$/i,
  /^sheets_values_update$/i,
  /^slides_batch_update$/i,
  /^chat_messages_create$/i,
];
const GOOGLE_DOCS_WRITE_TOOL_PATTERNS = [
  /^docs_batch_update$/i,
  /^gws_docs_batch_update$/i,
  /^google_workspace_docs_batch_update$/i,
];

export function evaluateTaskCompletion(
  input: TaskCompletionInput
): TaskCompletionDecision {
  const finalText = input.finalVisibleText.trim();

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
    !hasVisibleBlocker(finalText)
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
    !hasVisibleBlocker(finalText)
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
      WRITE_TOOL_PATTERNS.some((pattern) => pattern.test(tool.toolName))
  );
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
