export type ToolCallClassification = 'needs_reauth' | 'transient_error' | 'config_error';

export type ToolCallOutcome =
  | { ok: true; content: unknown }
  | {
      ok: false;
      classification: ToolCallClassification | 'not_connected';
      errorCode: string;
      message: string;
    };

const REAUTH_STATUS = new Set([401, 403]);
const REAUTH_PATTERN =
  /\b(auth|oauth|tokens?|credentials?|reauth|unauthorized|forbidden|invalid_grant|authentication|authorization)\b/i;
const CONFIG_PATTERN = /\b(tool not found|not allowed|allowlist|unknown tool|tools\/list)\b/i;
const TRANSIENT_PATTERN =
  /\b(timeout|timed out|econnreset|econnrefused|network|fetch failed|socket|unavailable|connection reset|reset by peer)\b/i;

export function classifyToolCallFailure(input: {
  errorMessage?: string;
  httpStatus?: number;
}): ToolCallClassification {
  const message = input.errorMessage ?? '';
  // 狀態碼無子字串歧義，401/403 最優先
  if (input.httpStatus !== undefined && REAUTH_STATUS.has(input.httpStatus)) return 'needs_reauth';
  // config 先於訊息類 reauth，避免 "unknown tool: author-lookup" 這類訊息被誤判成 needs_reauth
  if (CONFIG_PATTERN.test(message)) return 'config_error';
  if (REAUTH_PATTERN.test(message)) return 'needs_reauth';
  if (input.httpStatus !== undefined && input.httpStatus >= 500) return 'transient_error';
  if (TRANSIENT_PATTERN.test(message)) return 'transient_error';
  // default-deny：不認識的失敗當 transient，永不 not_connected（spec §5 最後一列）
  return 'transient_error';
}
