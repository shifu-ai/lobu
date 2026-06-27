import { describe, expect, test } from "bun:test";
import { buildToolUseEventPayload } from "../openclaw/tool-use-events";

// pi-agent's `tool_execution_end` event omits `args` (those live on the
// matching `tool_execution_start`); worker.ts re-attaches them from a Map
// before calling buildToolUseEventPayload. Tests mirror that — pass args
// explicitly to validate the merged shape.
const baseEvent = {
  toolCallId: "call_1",
  toolName: "search_memory",
  args: { query: "rent due dates" },
  result: {
    matches: [{ id: 1, name: "Acme Ltd" }],
    content: [
      {
        id: 42,
        title: "Rent",
        text_content: "Tenant Acme pays £1,200 on the 1st of each month",
        author_name: null,
        source_url: null,
        platform: "manual",
        occurred_at: null,
        entity_ids: [1],
      },
      {
        id: 43,
        title: "Lease renewal",
        text_content: "Lease renewed through Dec 2027",
        author_name: null,
        source_url: null,
        platform: "manual",
        occurred_at: null,
        entity_ids: [1],
      },
    ],
    metadata: { total_matches: 1, page_size: 5 },
  },
  isError: false,
};

describe("buildToolUseEventPayload", () => {
  test("includes name, input, toolCallId for any tool", () => {
    const payload = buildToolUseEventPayload({
      toolCallId: "abc",
      toolName: "bash",
      args: { command: "ls" },
      result: "ok",
      isError: false,
    });
    expect(payload.name).toBe("bash");
    expect(payload.toolCallId).toBe("abc");
    expect(payload.input).toEqual({ command: "ls" });
    expect(payload.isError).toBe(false);
    // Non-retrieval tools get no result_summary unless they error.
    expect(payload.result_summary).toBeUndefined();
  });

  test("extracts event_ids + snippets for search_memory", () => {
    const payload = buildToolUseEventPayload(baseEvent);
    expect(payload.result_summary?.event_ids).toEqual([42, 43]);
    expect(payload.result_summary?.snippets).toEqual([
      {
        id: 42,
        text: "Tenant Acme pays £1,200 on the 1st of each month",
      },
      { id: 43, text: "Lease renewed through Dec 2027" },
    ]);
  });

  test("treats lobu_search_memory the same as search_memory", () => {
    const payload = buildToolUseEventPayload({
      ...baseEvent,
      toolName: "lobu_search_memory",
    });
    expect(payload.result_summary?.event_ids).toEqual([42, 43]);
  });

  test("handles MCP CallToolResult wrapping", () => {
    const payload = buildToolUseEventPayload({
      ...baseEvent,
      result: {
        content: [{ type: "text", text: JSON.stringify(baseEvent.result) }],
        isError: false,
      },
    });
    expect(payload.result_summary?.event_ids).toEqual([42, 43]);
  });

  test("returns no result_summary when search_memory has no content", () => {
    const payload = buildToolUseEventPayload({
      ...baseEvent,
      result: { matches: [], metadata: { total_matches: 0, page_size: 0 } },
    });
    expect(payload.result_summary).toBeUndefined();
  });

  test("propagates error message when isError", () => {
    const payload = buildToolUseEventPayload({
      toolCallId: "x",
      toolName: "search_memory",
      args: {},
      result: { message: "authentication required" },
      isError: true,
    });
    expect(payload.isError).toBe(true);
    expect(payload.result_summary?.error).toBe("authentication required");
  });

  test("summarizes Google Docs batchUpdate empty replies as unknown effect", () => {
    const rawReply = {
      documentId: "doc-1",
      replies: [{}, {}, {}, {}, {}],
    };
    const payload = buildToolUseEventPayload({
      toolCallId: "docs_1",
      toolName: "gws_docs_batch_update",
      args: {
        documentId: "doc-1",
        requests: [
          { replaceAllText: { containsText: { text: "old" }, replaceText: "new" } },
          { replaceAllText: { containsText: { text: "a" }, replaceText: "b" } },
          { replaceAllText: { containsText: { text: "c" }, replaceText: "d" } },
          { replaceAllText: { containsText: { text: "e" }, replaceText: "f" } },
          { replaceAllText: { containsText: { text: "g" }, replaceText: "h" } },
        ],
      },
      result: {
        content: [{ type: "text", text: JSON.stringify(rawReply) }],
        isError: false,
      },
      isError: false,
    });

    expect(payload.result_summary).toMatchObject({
      operation: "google_docs_batch_update",
      document_id: "doc-1",
      request_count: 5,
      reply_count: 5,
      occurrences_changed: 0,
      effect_verified: false,
      effect_status: "unknown",
      raw_reply_preserved: true,
      raw_reply: rawReply,
    });
  });

  test("summarizes Google Docs replaceAllText occurrences as verified effect", () => {
    const payload = buildToolUseEventPayload({
      toolCallId: "docs_2",
      toolName: "google_workspace_docs_batch_update",
      args: {
        documentId: "doc-2",
        requests: [
          { replaceAllText: { containsText: { text: "old" }, replaceText: "new" } },
        ],
      },
      result: {
        documentId: "doc-2",
        replies: [{ replaceAllText: { occurrencesChanged: 3 } }],
      },
      isError: false,
    });

    expect(payload.result_summary).toMatchObject({
      operation: "google_docs_batch_update",
      document_id: "doc-2",
      request_count: 1,
      reply_count: 1,
      occurrences_changed: 3,
      effect_verified: true,
      effect_status: "verified",
      raw_reply_preserved: true,
    });
  });
});
