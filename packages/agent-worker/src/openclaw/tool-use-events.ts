/**
 * Helpers for surfacing tool-call traces from worker → gateway → SSE clients.
 *
 * Workers emit a `tool_use` custom event per `tool_execution_end` so any SSE
 * subscriber (the @lobu/promptfoo-provider, the Mac menubar, the CLI eval) can
 * inspect tool calls without having to scrape worker logs. The shape mirrors
 * Anthropic's tool-use block (name + input) plus a `result_summary` field for
 * structured, tool-specific metadata that's small enough to ship over SSE.
 *
 * For retrieval tools (`search_memory` / `lobu_search_memory`) we extract the
 * matched event IDs and the snippet text content so promptfoo RAG assertions
 * (`context-recall`, `context-faithfulness`, custom `javascript`) can join the
 * agent's answer back to the retrieved evidence.
 */

interface ToolUseEventPayload {
  toolCallId: string;
  name: string;
  input: unknown;
  isError: boolean;
  result_summary?: ToolUseResultSummary;
}

export interface ToolUseResultSummary {
  /** Event IDs the tool returned (search_memory etc). */
  event_ids?: number[];
  /** Inline snippet text keyed by event id — populated by retrieval tools so
   * provider clients can compute `retrievedContext` without a round-trip. */
  snippets?: Array<{ id: number; text: string }>;
  /** Tools may also include a short error string. */
  error?: string;
  /** Tool-specific writeback effect metadata. */
  operation?: string;
  document_id?: string;
  request_count?: number;
  reply_count?: number;
  effect_verified?: boolean;
  effect_status?: "verified" | "unknown" | "failed";
  occurrences_changed?: number;
  raw_reply_preserved?: boolean;
  raw_reply?: unknown;
}

const SEARCH_MEMORY_TOOL_NAMES = new Set([
  "search_memory",
  "lobu_search_memory",
]);
const GOOGLE_DOCS_BATCH_UPDATE_TOOL_NAMES = new Set([
  "docs_batch_update",
  "gws_docs_batch_update",
  "google_workspace_docs_batch_update",
]);

/**
 * Build the SSE payload for a `tool_execution_end` pi-agent event.
 *
 * Always returns a record — even on parse failure — so the SSE event reliably
 * fires for every tool call. `result_summary` is best-effort: tool-specific
 * shape parsing is wrapped in try/catch and a parse failure just leaves the
 * summary off, never throws.
 */
export function buildToolUseEventPayload(event: {
  toolCallId: string;
  toolName: string;
  args?: unknown;
  result: unknown;
  isError: boolean;
}): ToolUseEventPayload {
  const payload: ToolUseEventPayload = {
    toolCallId: event.toolCallId,
    name: event.toolName,
    input: event.args ?? null,
    isError: event.isError === true,
  };

  if (event.isError) {
    const message = extractErrorMessage(event.result);
    if (message) {
      payload.result_summary = { error: message };
    }
    return payload;
  } else if (isWorkerErrorTextResult(event.result)) {
    // The worker's `withErrorHandling`/`textResult` convention (see
    // packages/agent-worker/src/shared/tool-implementations.ts) swallows
    // thrown errors (e.g. the gateway proxy's 403 approval-required
    // rejection) and returns a normal, non-error tool result whose first
    // text content is prefixed with "Error: ". Surface that here so
    // downstream consumers (task-completion-guard's
    // hasApprovalBlockedToolResult) can detect it — this is the only shape
    // that signal ever actually arrives in on the real production path.
    const text = extractFirstMcpText(event.result);
    if (text) {
      payload.result_summary = { error: text };
    }
  }

  if (SEARCH_MEMORY_TOOL_NAMES.has(event.toolName)) {
    const summary = summarizeSearchMemoryResult(event.result);
    if (summary) {
      payload.result_summary = summary;
    }
  } else if (GOOGLE_DOCS_BATCH_UPDATE_TOOL_NAMES.has(event.toolName)) {
    payload.result_summary = summarizeGoogleDocsBatchUpdate(
      event.args,
      event.result
    );
  }

  return payload;
}

function summarizeSearchMemoryResult(
  raw: unknown
): ToolUseResultSummary | null {
  const result = extractSearchMemoryBody(raw);
  if (!result || typeof result !== "object") return null;

  const summary: ToolUseResultSummary = {};
  const contentArr = (result as { content?: unknown }).content;
  if (Array.isArray(contentArr) && contentArr.length > 0) {
    const ids: number[] = [];
    const snippets: Array<{ id: number; text: string }> = [];
    for (const snippet of contentArr) {
      if (!snippet || typeof snippet !== "object") continue;
      const idVal = (snippet as { id?: unknown }).id;
      const textVal = (snippet as { text_content?: unknown }).text_content;
      if (typeof idVal !== "number") continue;
      ids.push(idVal);
      if (typeof textVal === "string" && textVal.length > 0) {
        snippets.push({ id: idVal, text: textVal });
      }
    }
    if (ids.length > 0) summary.event_ids = ids;
    if (snippets.length > 0) summary.snippets = snippets;
  }

  return Object.keys(summary).length > 0 ? summary : null;
}

function summarizeGoogleDocsBatchUpdate(
  args: unknown,
  raw: unknown
): ToolUseResultSummary {
  const input =
    args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const result = extractMcpJsonBody(raw);
  const rawReply = sanitizeToolUseSummaryValue(result ?? raw);
  const replies = extractReplies(rawReply);
  const occurrencesChanged = sumOccurrencesChanged(replies);
  const effectVerified = occurrencesChanged > 0;
  const documentId =
    typeof input.documentId === "string"
      ? input.documentId
      : typeof input.document_id === "string"
        ? input.document_id
        : undefined;
  const requestCount = Array.isArray(input.requests)
    ? input.requests.length
    : undefined;

  const summary: ToolUseResultSummary = {
    operation: "google_docs_batch_update",
    reply_count: replies.length,
    effect_verified: effectVerified,
    effect_status: effectVerified ? "verified" : "unknown",
    occurrences_changed: occurrencesChanged,
    raw_reply_preserved: true,
    raw_reply: rawReply,
  };
  if (documentId) summary.document_id = documentId;
  if (requestCount !== undefined) summary.request_count = requestCount;
  return summary;
}

function extractReplies(value: unknown): unknown[] {
  if (!value || typeof value !== "object") return [];
  const replies = (value as { replies?: unknown }).replies;
  return Array.isArray(replies) ? replies : [];
}

function sumOccurrencesChanged(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce((sum, item) => sum + sumOccurrencesChanged(item), 0);
  }
  if (!value || typeof value !== "object") {
    return 0;
  }
  let total = 0;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "occurrencesChanged" && typeof child === "number") {
      total += child;
      continue;
    }
    total += sumOccurrencesChanged(child);
  }
  return total;
}

function sanitizeToolUseSummaryValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeToolUseSummaryValue(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const record = value as Record<string, unknown>;
  if (
    record.type === "image" &&
    typeof record.data === "string" &&
    typeof record.mimeType === "string"
  ) {
    const metadata: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(record)) {
      if (key === "data") continue;
      metadata[key] = child;
    }
    return {
      ...sanitizeRecord(metadata),
      type: "image",
      mimeType: record.mimeType,
      dataLength: record.data.length,
    };
  }

  return sanitizeRecord(record);
}

function sanitizeRecord(
  record: Record<string, unknown>
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    sanitized[key] = sanitizeToolUseSummaryValue(child);
  }
  return sanitized;
}

/**
 * MCP tool results from the gateway proxy land here as
 *   { content: [{ type: 'text', text: '<json>' }], isError: false }
 * but in-process tools sometimes pass the raw object straight through. Handle
 * both shapes.
 */
function extractSearchMemoryBody(raw: unknown): unknown {
  return extractMcpJsonBody(raw);
}

function extractMcpJsonBody(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return null;

  // MCP CallToolResult shape — text content holds a JSON-stringified payload.
  const mcpContent = (raw as { content?: unknown }).content;
  if (Array.isArray(mcpContent)) {
    const text = extractFirstMcpText(raw);
    if (text !== null) {
      try {
        return JSON.parse(text);
      } catch {
        // Plain text result — nothing to summarise.
        return null;
      }
    }
    // No { type: 'text', text } part found — fall through and treat the
    // array as the body itself (e.g. search_memory's content array of
    // snippet objects, which has no `type`/`text` fields).
  }

  // Already the search_memory body.
  return raw;
}

/**
 * Extracts the first `{ type: 'text', text }` content entry's raw text from
 * an MCP CallToolResult-shaped value, without attempting JSON parsing
 * (unlike `extractMcpJsonBody`, which is for structured tool payloads).
 */
function extractFirstMcpText(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const content = (raw as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const type = (part as { type?: unknown }).type;
    const text = (part as { text?: unknown }).text;
    if (type === "text" && typeof text === "string") {
      return text;
    }
  }
  return null;
}

/**
 * True when a non-error tool result's first text content starts with the
 * worker's deliberate "Error: " prefix convention (see `textResult` /
 * `withErrorHandling` in tool-implementations.ts).
 */
function isWorkerErrorTextResult(raw: unknown): boolean {
  const text = extractFirstMcpText(raw);
  return typeof text === "string" && text.startsWith("Error:");
}

function extractErrorMessage(result: unknown): string | null {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return null;
  const msg = (result as { message?: unknown }).message;
  if (typeof msg === "string") return msg;
  const err = (result as { error?: unknown }).error;
  if (typeof err === "string") return err;
  return null;
}
