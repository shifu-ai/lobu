export function isContextOverflowError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("prompt is too long") ||
    normalized.includes("maximum context") ||
    normalized.includes("context window") ||
    normalized.includes("context length")
  );
}

export function buildContextOverflowRecoveryMessage(): string {
  return "這段內容太長，我會改用分段方式讀取。請我「繼續讀下一段」或指定要查的主題，我會用搜尋/分頁工具處理。";
}

export function toUserVisibleSessionError(message: string): string {
  if (isContextOverflowError(message)) {
    return buildContextOverflowRecoveryMessage();
  }
  return message;
}

export function formatContextOverflowExecutionError(
  error: unknown
): string | null {
  const message = error instanceof Error ? error.message : String(error);
  if (!isContextOverflowError(message)) {
    return null;
  }
  return buildContextOverflowRecoveryMessage();
}
