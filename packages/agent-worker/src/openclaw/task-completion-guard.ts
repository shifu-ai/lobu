export type TaskCompletionOutcome =
  | "completed"
  | "failed_incomplete"
  | "incomplete_retryable";

export type TaskCompletionReason =
  | "ok"
  | "task_completion_empty_final"
  | "task_completion_write_intent_without_write";

export interface ToolExecutionSummary {
  toolName: string;
  isError: boolean;
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

export function evaluateTaskCompletion(
  input: TaskCompletionInput
): TaskCompletionDecision {
  if (!input.finalVisibleText.trim()) {
    return {
      outcome: "failed_incomplete",
      reason: "task_completion_empty_final",
      userVisibleMessage: EMPTY_FINAL_MESSAGE,
    };
  }

  return {
    outcome: "completed",
    reason: "ok",
  };
}
