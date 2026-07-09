const BATTLE_REPORT_MUTATING_TOOLS = [
  "sales_battle_report_run_now",
  "sales_battle_report_schedule_create",
  "sales_battle_report_schedule_pause",
  "sales_battle_report_schedule_update",
] as const;

export type BattleReportMutatingTool =
  (typeof BATTLE_REPORT_MUTATING_TOOLS)[number];

export type CompletionClaimGuardReason =
  "mutating_claim_without_tool_execution";

export type CompletionClaimGuardResult =
  | { allowed: true }
  | {
      allowed: false;
      reason: CompletionClaimGuardReason;
      safeText: string;
      requiredTools: BattleReportMutatingTool[];
    };

interface CompletionClaimGuardInput {
  userMessage: string;
  finalText: string;
  executedTools: string[];
}

interface ToolExecutionEvidenceInput {
  toolName: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
}

const DONE_CLAIM_PATTERNS = [
  /已(?:經)?(?:幫(?:你|我|忙)?\s*)?(?:完成|產生|生成|建立|新增|暫停|停止|更新|修改|調整|執行|跑完|排好|發送|送出)/i,
  /(?:完成|產生|生成|建立|新增|暫停|停止|更新|修改|調整|執行|跑完|排好|發送|送出)了/i,
  /\b(?:done|completed|created|scheduled|paused|updated|ran|generated|sent)\b/i,
];

const SAFE_TEXT =
  "我還沒有成功呼叫對應工具，所以不能宣稱這個銷售戰報動作已完成。請再試一次，或告訴我要調整的戰報動作。";

export function checkCompletionClaim(
  input: CompletionClaimGuardInput
): CompletionClaimGuardResult {
  const requiredTools = getRequiredBattleReportMutationTools(input.userMessage);
  if (requiredTools.length === 0) {
    return { allowed: true };
  }

  if (!claimsDone(input.finalText)) {
    return { allowed: true };
  }

  const requiredToolNames = new Set<string>(requiredTools);
  if (
    input.executedTools.some((toolName) =>
      normalizeCompletionClaimEvidence(toolName).some((candidate) =>
        requiredToolNames.has(candidate)
      )
    )
  ) {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: "mutating_claim_without_tool_execution",
    safeText: SAFE_TEXT,
    requiredTools,
  };
}

export function getSuccessfulCompletionClaimToolNames(
  input: ToolExecutionEvidenceInput
): string[] {
  if (input.isError === true || resultLooksFailed(input.result)) {
    return [];
  }

  const names = [input.toolName];
  if (input.toolName === "tool_call") {
    const delegatedToolName = readDelegatedToolName(input.args);
    if (delegatedToolName) {
      names.push(delegatedToolName);
    }
  }

  return names;
}

export function getRequiredBattleReportMutationTools(
  userMessage: string
): BattleReportMutatingTool[] {
  const normalized = userMessage.toLowerCase();
  if (!mentionsBattleReport(normalized)) {
    return [];
  }

  if (/(?:暫停|停止|pause|disable|stop)/i.test(normalized)) {
    return ["sales_battle_report_schedule_pause"];
  }
  if (/(?:更新|修改|調整|改成|change|update|reschedule)/i.test(normalized)) {
    return ["sales_battle_report_schedule_update"];
  }
  if (/(?:排程|定期|每週|每月|schedule|weekly|monthly)/i.test(normalized)) {
    return ["sales_battle_report_schedule_create"];
  }
  if (
    /(?:現在|立即|產生|生成|跑|執行|發送|送出|run|generate|create now|send)/i.test(
      normalized
    )
  ) {
    return ["sales_battle_report_run_now"];
  }

  return [];
}

function mentionsBattleReport(normalizedMessage: string): boolean {
  return /(?:戰報|battle report|sales report|銷售報告)/i.test(
    normalizedMessage
  );
}

function claimsDone(finalText: string): boolean {
  return DONE_CLAIM_PATTERNS.some((pattern) => pattern.test(finalText));
}

function readDelegatedToolName(args: unknown): string | null {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return null;
  }

  const toolName = (args as Record<string, unknown>).tool_name;
  if (typeof toolName !== "string") {
    return null;
  }

  const trimmed = toolName.trim();
  return trimmed ? trimmed : null;
}

function normalizeCompletionClaimEvidence(toolName: string): string[] {
  const trimmed = toolName.trim();
  if (!trimmed) {
    return [];
  }

  const normalized = [trimmed];
  const slashIndex = trimmed.lastIndexOf("/");
  if (slashIndex >= 0 && slashIndex < trimmed.length - 1) {
    normalized.push(trimmed.slice(slashIndex + 1));
  }

  return normalized;
}

function resultLooksFailed(result: unknown): boolean {
  if (!result || typeof result !== "object") {
    return false;
  }

  const record = result as Record<string, unknown>;
  if (record.isError === true) {
    return true;
  }

  const content = record.content;
  if (!Array.isArray(content)) {
    return false;
  }

  return content.some((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return false;
    }
    const text = (entry as Record<string, unknown>).text;
    return typeof text === "string" && /^Error:/i.test(text.trim());
  });
}
