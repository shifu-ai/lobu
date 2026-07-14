/**
 * Worker-side MCP tool call tests (callMcpTool)
 *
 * callMcpTool is the function the agent calls to invoke an MCP tool via the
 * gateway proxy. It routes to POST /mcp/<mcpId>/tools/<toolName> using the
 * worker's JWT, then normalises the JSON response into the shared tool result
 * shape. These tests cover:
 *
 *   - Happy path: content text forwarded
 *   - isError=true response: wrapped in "Error: ..." prefix
 *   - Non-200 HTTP: error text extracted
 *   - Empty content array: falls back to "<toolName> completed."
 *   - Correct Authorization header forwarding
 *   - Unknown tool name (404 from proxy): error wrapped
 *   - Tool approval required (403): error message surfaced to model
 *   - fetch throws: caught and returned as error text
 *   - AskUser / UploadFile: gateway error propagation
 *   - getChannelHistory: empty-messages branch
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { RESERVED_AUTOMATION_TOOL_NAMES } from "@lobu/core";
import { createMcpToolDefinitions } from "../openclaw/custom-tools";
import {
  emitMcpToolCallLifecycleObsEvent,
  emitWorkerLifecycleObsEvent,
  emitWorkerLifecycleObsEventFromPlatformMetadata,
  emitWorkerToolsRegisteredObsEvent,
} from "../openclaw/session-runner";
import {
  askUserQuestion,
  callMcpTool,
  getChannelHistory,
  uploadUserFile,
} from "../shared/tool-implementations";
import type { GatewayParams } from "../shared/tool-implementations";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalFetch = globalThis.fetch;
const originalObsEnv = {
  enabled: process.env.SHIFU_AGENT_OBS_ENABLED,
  ingestUrl: process.env.SHIFU_AGENT_OBS_INGEST_URL,
  token: process.env.SHIFU_AGENT_OBS_TOKEN,
  toolboxUrl: process.env.TOOLBOX_AGENT_OBSERVABILITY_URL,
  toolboxSecret: process.env.TOOLBOX_INTERNAL_SECRET,
};

const gw: GatewayParams = {
  gatewayUrl: "http://gateway",
  workerToken: "tok-abc",
  agentId: "agent-1",
  channelId: "ch-1",
  conversationId: "conv-1",
  platform: "telegram",
};

function extractText(result: {
  content: Array<{ type: string; text?: string }>;
}): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => {
      return c.type === "text" && typeof c.text === "string";
    })
    .map((c) => c.text)
    .join("\n");
}

function parseFetchBodies(fetchMock: ReturnType<typeof mock>) {
  return fetchMock.mock.calls.map((call) =>
    JSON.parse(String((call as unknown as [string, RequestInit])[1].body))
  );
}

function expectNoRawIdentifiers(
  bodies: unknown[],
  identifiers: Array<string | undefined>
): void {
  const serialized = JSON.stringify(bodies);
  for (const identifier of identifiers) {
    if (!identifier) continue;
    expect(serialized).not.toContain(identifier);
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalObsEnv.enabled === undefined) {
    delete process.env.SHIFU_AGENT_OBS_ENABLED;
  } else {
    process.env.SHIFU_AGENT_OBS_ENABLED = originalObsEnv.enabled;
  }
  if (originalObsEnv.ingestUrl === undefined) {
    delete process.env.SHIFU_AGENT_OBS_INGEST_URL;
  } else {
    process.env.SHIFU_AGENT_OBS_INGEST_URL = originalObsEnv.ingestUrl;
  }
  if (originalObsEnv.token === undefined) {
    delete process.env.SHIFU_AGENT_OBS_TOKEN;
  } else {
    process.env.SHIFU_AGENT_OBS_TOKEN = originalObsEnv.token;
  }
  if (originalObsEnv.toolboxUrl === undefined) {
    delete process.env.TOOLBOX_AGENT_OBSERVABILITY_URL;
  } else {
    process.env.TOOLBOX_AGENT_OBSERVABILITY_URL = originalObsEnv.toolboxUrl;
  }
  if (originalObsEnv.toolboxSecret === undefined) {
    delete process.env.TOOLBOX_INTERNAL_SECRET;
  } else {
    process.env.TOOLBOX_INTERNAL_SECRET = originalObsEnv.toolboxSecret;
  }
  mock.restore();
});

// ---------------------------------------------------------------------------
// callMcpTool happy path
// ---------------------------------------------------------------------------

describe("callMcpTool", () => {
  test("happy path: forwards content text from proxy response", async () => {
    let capturedUrl = "";
    let capturedAuth = "";

    globalThis.fetch = mock(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl =
          typeof input === "string" ? input : (input as Request).url;
        capturedAuth = new Headers(init?.headers).get("Authorization") ?? "";
        return Response.json({
          content: [{ type: "text", text: "the answer" }],
          isError: false,
        });
      }
    ) as unknown as typeof fetch;

    const result = await callMcpTool(gw, "lobu", "search_memory", {
      query: "test",
    });

    expect(extractText(result)).toBe("the answer");
    expect(capturedUrl).toBe("http://gateway/mcp/lobu/tools/search_memory");
    expect(capturedAuth).toBe("Bearer tok-abc");
  });

  test.each(
    RESERVED_AUTOMATION_TOOL_NAMES
  )("binds the discovery config identity to fake gateway call for %s", async (toolName) => {
    let capturedHeaders = new Headers();
    globalThis.fetch = mock(async (_input, init) => {
      capturedHeaders = new Headers(init?.headers);
      return Response.json({ content: [{ type: "text", text: "ok" }] });
    }) as unknown as typeof fetch;

    await callMcpTool(
      gw,
      "shifu-toolbox",
      toolName,
      {},
      {
        expectedMcpIdentity: {
          upstreamOrigin: "https://mcp.shifu-ai.org",
          configSource: "agent",
          configDigest: "digest-123",
        },
      }
    );

    expect(capturedHeaders.get("x-lobu-mcp-expected-origin")).toBe(
      "https://mcp.shifu-ai.org"
    );
    expect(capturedHeaders.get("x-lobu-mcp-expected-config-source")).toBe(
      "agent"
    );
    expect(capturedHeaders.get("x-lobu-mcp-expected-config-digest")).toBe(
      "digest-123"
    );
  });

  test("isError=true from proxy: wrapped in Error prefix", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({
        content: [{ type: "text", text: "not allowed" }],
        isError: true,
      })
    ) as unknown as typeof fetch;

    const result = await callMcpTool(gw, "gh", "delete_repo", {
      name: "myrepo",
    });

    expect(extractText(result)).toContain("Error:");
    expect(extractText(result)).toContain("not allowed");
  });

  test("isError=true from proxy: extracts text content before Error prefix", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({
        content: [
          { type: "image", mimeType: "image/jpeg", data: "YWJj" },
          { type: "text", text: "vision tool failed" },
        ],
        isError: true,
      })
    ) as unknown as typeof fetch;

    const result = await callMcpTool(gw, "vision", "read_image", {});

    expect(result.content).toEqual([
      { type: "text", text: "Error: vision tool failed" },
    ]);
  });

  test("non-200 HTTP status: error message surfaced", async () => {
    globalThis.fetch = mock(async () =>
      Response.json(
        { error: "Tool approval required", content: [], isError: true },
        { status: 403 }
      )
    ) as unknown as typeof fetch;

    const result = await callMcpTool(gw, "gh", "create_issue", {});

    expect(extractText(result)).toContain("Error:");
  });

  test("empty content array falls back to '<toolName> completed.'", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({
        content: [],
        isError: false,
      })
    ) as unknown as typeof fetch;

    const result = await callMcpTool(gw, "lobu", "noop_tool", {});

    expect(extractText(result)).toBe("noop_tool completed.");
  });

  test("error field on response used as error message", async () => {
    globalThis.fetch = mock(async () =>
      Response.json(
        { content: [], isError: true, error: "Upstream timed out" },
        { status: 502 }
      )
    ) as unknown as typeof fetch;

    const result = await callMcpTool(gw, "sentry", "resolve_issue", {});

    expect(extractText(result)).toContain("Upstream timed out");
  });

  test("fetch throws (network down): error returned as text", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("network unreachable");
    }) as unknown as typeof fetch;

    const result = await callMcpTool(gw, "lobu", "search_memory", {});

    expect(extractText(result)).toContain("network unreachable");
  });

  test("unknown tool name (404): error wrapped", async () => {
    globalThis.fetch = mock(async () =>
      Response.json(
        { error: "MCP server 'ghost' not found", content: [], isError: true },
        { status: 404 }
      )
    ) as unknown as typeof fetch;

    const result = await callMcpTool(gw, "ghost", "missing_tool", {});

    expect(extractText(result)).toContain("Error:");
  });

  test("multiple content items concatenated", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({
        content: [
          { type: "text", text: "line one" },
          { type: "text", text: "line two" },
        ],
        isError: false,
      })
    ) as unknown as typeof fetch;

    const result = await callMcpTool(gw, "lobu", "multi_content", {});

    const text = extractText(result);
    expect(text).toContain("line one");
    expect(text).toContain("line two");
  });

  test("pure text content returns one joined text block", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({
        content: [
          { type: "text", text: "line one" },
          { type: "text", text: "line two" },
        ],
        isError: false,
      })
    ) as unknown as typeof fetch;

    const result = await callMcpTool(gw, "lobu", "multi_content", {});

    expect(result.content).toEqual([
      { type: "text", text: "line one\nline two" },
    ]);
  });

  test("MCP response with image block is preserved", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({
        content: [{ type: "image", mimeType: "image/png", data: "YWJjZA==" }],
        isError: false,
      })
    ) as unknown as typeof fetch;

    const result = await callMcpTool(gw, "vision", "read_image", {});

    expect(result.content).toEqual([
      { type: "image", mimeType: "image/png", data: "YWJjZA==" },
    ]);
  });

  test("mixed text and image content order is preserved", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({
        content: [
          { type: "text", text: "before" },
          { type: "image", mimeType: "image/png", data: "YWJj" },
          { type: "text", text: "after" },
        ],
        isError: false,
      })
    ) as unknown as typeof fetch;

    const result = await callMcpTool(gw, "lobu", "mixed_content", {});

    expect(result.content).toEqual([
      { type: "text", text: "before" },
      { type: "image", mimeType: "image/png", data: "YWJj" },
      { type: "text", text: "after" },
    ]);
  });

  test("malformed image and text parts are dropped without crashing", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({
        content: [
          { type: "text", text: 123 },
          { type: "image", mimeType: "image/png" },
          { type: "image", data: "YWJj" },
          { type: "resource_link", uri: "https://example.com/docs" },
          null,
          { type: "text", text: "kept" },
          { type: "image", mimeType: "image/jpeg", data: "ZGF0YQ==" },
        ],
        isError: false,
      })
    ) as unknown as typeof fetch;

    const result = await callMcpTool(gw, "lobu", "mixed_content", {});

    expect(result.content).toEqual([
      { type: "text", text: "kept" },
      { type: "image", mimeType: "image/jpeg", data: "ZGF0YQ==" },
    ]);
  });

  test("large MCP text result is replaced with a context artifact descriptor", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "lobu-mcp-large-result-"));
    const localGw: GatewayParams = { ...gw, workspaceDir };
    try {
      globalThis.fetch = mock(async () =>
        Response.json({
          content: [{ type: "text", text: "X".repeat(120_000) }],
          isError: false,
        })
      ) as unknown as typeof fetch;

      const result = await callMcpTool(localGw, "docs", "read_big_doc", {});
      const text = extractText(result);

      expect(text.length).toBeLessThan(4_000);
      expect(text).toContain("ctx_art_");
      expect(text).toContain("artifact_read");
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  test("sends correct Content-Type header", async () => {
    let capturedContentType = "";
    globalThis.fetch = mock(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedContentType =
          new Headers(init?.headers).get("Content-Type") ?? "";
        return Response.json({
          content: [{ type: "text", text: "ok" }],
          isError: false,
        });
      }
    ) as unknown as typeof fetch;

    await callMcpTool(gw, "lobu", "search_memory", { q: "hello" });

    expect(capturedContentType).toBe("application/json");
  });

  test("sends POST method", async () => {
    let capturedMethod = "";
    globalThis.fetch = mock(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedMethod = init?.method ?? "";
        return Response.json({
          content: [{ type: "text", text: "ok" }],
          isError: false,
        });
      }
    ) as unknown as typeof fetch;

    await callMcpTool(gw, "lobu", "search_memory", {});

    expect(capturedMethod).toBe("POST");
  });
});

// ---------------------------------------------------------------------------
// ask_user edge cases
// ---------------------------------------------------------------------------

describe("askUserQuestion edge cases", () => {
  test("gateway HTTP error surfaced as error text", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({ error: "channel not found" }, { status: 404 })
    ) as unknown as typeof fetch;

    const result = await askUserQuestion(gw, {
      question: "Pick?",
      options: ["A"],
    });

    expect(extractText(result)).toContain("Error:");
  });

  test("sends correct interaction type", async () => {
    let body: Record<string, unknown> | null = null;
    globalThis.fetch = mock(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        body = JSON.parse(String(init?.body ?? "{}"));
        return Response.json({ id: "q-1" });
      }
    ) as unknown as typeof fetch;

    await askUserQuestion(gw, {
      question: "Yes or No?",
      options: ["Yes", "No"],
    });

    expect(body?.interactionType).toBe("question");
  });
});

// ---------------------------------------------------------------------------
// upload_file edge cases
// ---------------------------------------------------------------------------

describe("uploadUserFile edge cases", () => {
  test("upload HTTP error surfaced as error text", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lobu-up-err-"));
    const filePath = join(tempDir, "f.txt");
    writeFileSync(filePath, "content");

    globalThis.fetch = mock(
      async () => new Response("Forbidden", { status: 403 })
    ) as unknown as typeof fetch;

    try {
      const result = await uploadUserFile(gw, { file_path: filePath });
      expect(extractText(result as any)).toContain("Error:");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("relative path without workspaceDir returns error", async () => {
    const result = await uploadUserFile(gw, { file_path: "relative/path.txt" });
    expect(extractText(result as any)).toContain("workspaceDir not set");
  });

  test("directory path (not a file) returns error", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lobu-dir-test-"));
    try {
      const result = await uploadUserFile(gw, { file_path: tempDir });
      expect(extractText(result as any)).toContain(
        "not found or is not a file"
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("empty file returns error", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lobu-empty-"));
    const filePath = join(tempDir, "empty.txt");
    writeFileSync(filePath, "");

    try {
      const result = await uploadUserFile(gw, { file_path: filePath });
      expect(extractText(result as any)).toContain("Cannot show empty file");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// get_channel_history edge cases
// ---------------------------------------------------------------------------

describe("getChannelHistory edge cases", () => {
  test("empty messages array returns 'No messages found'", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({
        messages: [],
        nextCursor: null,
        hasMore: false,
      })
    ) as unknown as typeof fetch;

    const result = await getChannelHistory(gw, { limit: 10 });
    expect(extractText(result as any)).toContain("No messages found");
  });

  test("hasMore=false with nextCursor null: no pagination hint appended", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({
        messages: [
          {
            timestamp: "2026-05-13T10:00:00.000Z",
            user: "Alice",
            text: "Hi",
            isBot: false,
          },
        ],
        nextCursor: null,
        hasMore: false,
      })
    ) as unknown as typeof fetch;

    const result = await getChannelHistory(gw, {});
    const text = extractText(result as any);
    expect(text).toContain("Alice: Hi");
    expect(text).not.toContain("before=");
  });

  test("bot messages prefixed with [Bot]", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({
        messages: [
          {
            timestamp: "2026-05-13T10:00:00.000Z",
            user: "Lobu",
            text: "I can help",
            isBot: true,
          },
        ],
        nextCursor: null,
        hasMore: false,
      })
    ) as unknown as typeof fetch;

    const result = await getChannelHistory(gw, { limit: 1 });
    const text = extractText(result as any);
    expect(text).toContain("[Bot] Lobu");
  });

  test("gateway HTTP error surfaced as error text", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({ error: "channel forbidden" }, { status: 403 })
    ) as unknown as typeof fetch;

    const result = await getChannelHistory(gw, { limit: 5 });
    expect(extractText(result as any)).toContain("Error:");
  });
});

// ---------------------------------------------------------------------------
// Tool-policy integration: callMcpTool approval-blocked response
// ---------------------------------------------------------------------------

describe("callMcpTool: approval-blocked response from gateway", () => {
  test("403 with requires-approval text surfaces as Error prefix", async () => {
    globalThis.fetch = mock(async () =>
      Response.json(
        {
          content: [
            {
              type: "text",
              text: "Tool call requires approval. The user has been asked to approve.",
            },
          ],
          isError: true,
        },
        { status: 403 }
      )
    ) as unknown as typeof fetch;

    const result = await callMcpTool(gw, "gh", "delete_branch", {
      branch: "main",
    });

    const text = extractText(result);
    expect(text).toContain("Error:");
    expect(text).toContain("requires approval");
    expect(result.isError).toBe(true);
    expect(result.errorCode).toBe("approval_required");
  });
});

describe("worker MCP tool registration observability", () => {
  test("emits worker lifecycle events from platformMetadata shifuTrace", async () => {
    process.env.SHIFU_AGENT_OBS_ENABLED = "true";
    process.env.SHIFU_AGENT_OBS_INGEST_URL = "https://obs.example.test/ingest";
    delete process.env.SHIFU_AGENT_OBS_TOKEN;

    const fetchMock = mock(async () => new Response("{}", { status: 202 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    emitWorkerLifecycleObsEventFromPlatformMetadata({
      platformMetadata: {
        shifuTrace: {
          trace_id: "tr_platformworker123",
          parent_span_id: "sp_gatewayworker123",
          journey_id: "line_reply",
          turn_id: "turn_platformworker123",
        },
        line_user_id: "U-line-secret",
      },
      conversationId: "conv-1",
      sessionId: "session-1",
      agentId: "shifu-u-a4175b7e71f4",
      userId: "toolbox-user-raw-123",
      event: "lobu.worker.started",
      status: "started",
      fields: {
        mcp_exposure: "tools",
        authorization: "Bearer worker-token-secret",
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const bodies = parseFetchBodies(fetchMock);
    const journeyPayload = bodies[0];
    expect(journeyPayload).toMatchObject({
      schemaVersion: "journey.trace.v1",
      payload: {
        event: "lobu.worker.started",
        trace_id: "tr_platformworker123",
        parent_span_id: "sp_gatewayworker123",
        journey_id: "line_reply",
        turn_id: "turn_platformworker123",
        status: "started",
        trace_source: "incoming",
        mcp_exposure: "tools",
      },
    });
    expectNoRawIdentifiers(bodies, [
      "U-line-secret",
      "shifu-u-a4175b7e71f4",
      "toolbox-user-raw-123",
      "worker-token-secret",
    ]);
  });

  test("emits worker lifecycle events with incoming trace lineage", async () => {
    process.env.SHIFU_AGENT_OBS_ENABLED = "true";
    process.env.SHIFU_AGENT_OBS_INGEST_URL = "https://obs.example.test/ingest";
    delete process.env.SHIFU_AGENT_OBS_TOKEN;

    const fetchMock = mock(async () => new Response("{}", { status: 202 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await emitWorkerLifecycleObsEvent({
      trace: {
        traceId: "tr_workerlife123456",
        parentSpanId: "sp_gatewayparent123",
        journeyId: "line_reply",
        turnId: "turn_workerlife123",
        actor: "worker",
        traceSource: "incoming",
      },
      conversationId: "conv-1",
      sessionId: "session-1",
      agentId: "shifu-u-b5286c8f82a5",
      userId: "toolbox-user-raw-456",
      event: "lobu.worker.completed",
      status: "ok",
      durationMs: 37,
      fields: {
        output_chars: 42,
        authorization: "Bearer leaked-token",
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const bodies = parseFetchBodies(fetchMock);
    const journeyPayload = bodies[0];
    expect(journeyPayload).toMatchObject({
      schemaVersion: "journey.trace.v1",
      payload: {
        schema_version: "journey.trace.v1",
        event: "lobu.worker.completed",
        trace_id: "tr_workerlife123456",
        parent_span_id: "sp_gatewayparent123",
        journey_id: "line_reply",
        turn_id: "turn_workerlife123",
        service: "lobu",
        module: "agent-worker",
        status: "ok",
        duration_ms: 37,
        output_chars: 42,
        conversation_id: "conv-1",
        session_id: "session-1",
      },
    });

    const obsPayload = bodies[1];
    expect(obsPayload).toMatchObject({
      eventName: "lobu.worker.completed",
      status: "ok",
      stage: "lobu.worker.completed",
      traceId: "tr_workerlife123456",
      turnId: "turn_workerlife123",
      conversationId: "conv-1",
      sessionId: "session-1",
      metadata: {
        journey_id: "line_reply",
        parent_span_id: "sp_gatewayparent123",
        trace_source: "incoming",
        module: "agent-worker",
        duration_ms: 37,
        output_chars: 42,
      },
    });
    expect(obsPayload).not.toHaveProperty("agentId");
    expect(obsPayload).not.toHaveProperty("userId");
    expect(obsPayload).not.toHaveProperty("toolboxUserId");
    expectNoRawIdentifiers(bodies, [
      "shifu-u-b5286c8f82a5",
      "toolbox-user-raw-456",
      "leaked-token",
    ]);
  });

  test("emits failed MCP tool lifecycle events with trace lineage and redaction", async () => {
    process.env.SHIFU_AGENT_OBS_ENABLED = "true";
    process.env.SHIFU_AGENT_OBS_INGEST_URL = "https://obs.example.test/ingest";
    delete process.env.SHIFU_AGENT_OBS_TOKEN;

    const fetchMock = mock(async () => new Response("{}", { status: 202 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    emitMcpToolCallLifecycleObsEvent({
      trace: {
        traceId: "tr_mcptool123456",
        parentSpanId: "sp_gatewaytool123",
        journeyId: "line_reply",
        turnId: "turn_mcptool123",
        actor: "worker",
        traceSource: "incoming",
      },
      conversationId: "conv-1",
      sessionId: "session-1",
      agentId: "shifu-u-c6397d9f93b6",
      userId: "toolbox-user-raw-789",
      toolCallId: "call-1",
      toolName: "calendar_events_list",
      isError: true,
      durationMs: 25,
      fields: {
        authorization: "Bearer tool-token-secret",
        tool: {
          name: "calendar_events_list",
          api_key: "sk-tool-secret",
        },
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const journeyPayload = JSON.parse(
      String(
        (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body
      )
    );
    expect(journeyPayload).toMatchObject({
      schemaVersion: "journey.trace.v1",
      payload: {
        schema_version: "journey.trace.v1",
        event: "mcp.tool_call.failed",
        trace_id: "tr_mcptool123456",
        parent_span_id: "sp_gatewaytool123",
        journey_id: "line_reply",
        turn_id: "turn_mcptool123",
        service: "lobu",
        module: "agent-worker",
        status: "failed",
        tool_call_id: "call-1",
        tool: {
          name: "calendar_events_list",
          api_key: "[REDACTED]",
        },
        duration_ms: 25,
      },
    });
    expectNoRawIdentifiers(
      [journeyPayload],
      [
        "shifu-u-c6397d9f93b6",
        "toolbox-user-raw-789",
        "tool-token-secret",
        "sk-tool-secret",
      ]
    );
  });

  test("does not wait for tools_registered observability ingest response", async () => {
    process.env.SHIFU_AGENT_OBS_ENABLED = "true";
    process.env.SHIFU_AGENT_OBS_INGEST_URL = "https://obs.example.test/ingest";
    delete process.env.SHIFU_AGENT_OBS_TOKEN;

    let settleFetch: (() => void) | undefined;
    const fetchMock = mock(
      () =>
        new Promise<Response>((resolve) => {
          settleFetch = () => resolve(new Response("{}", { status: 202 }));
        })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    let eventSettled = false;
    const eventPromise = Promise.resolve(
      emitWorkerToolsRegisteredObsEvent({
        trace: {
          traceId: "tr_workerobs123456",
          journeyId: "line_reply",
          turnId: "turn_workerobs123",
          actor: "worker",
          traceSource: "incoming",
        },
        conversationId: gw.conversationId,
        agentId: gw.agentId,
        userId: gw.userId,
        toolCount: 1,
        mcpToolCount: 1,
        authToolCount: 0,
        pluginToolCount: 0,
        mcpIds: ["lobu"],
      })
    ).then(() => {
      eventSettled = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    const settledBeforeIngestResponse = eventSettled;

    settleFetch?.();
    await eventPromise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(settledBeforeIngestResponse).toBe(true);
  });

  test("emits lobu.worker.tools_registered with MCP registration counts", async () => {
    process.env.SHIFU_AGENT_OBS_ENABLED = "true";
    process.env.SHIFU_AGENT_OBS_INGEST_URL = "https://obs.example.test/ingest";
    delete process.env.SHIFU_AGENT_OBS_TOKEN;
    process.env.TOOLBOX_AGENT_OBSERVABILITY_URL =
      "https://toolbox.example.test/ingest";
    process.env.TOOLBOX_INTERNAL_SECRET = "internal-secret";

    const fetchMock = mock(async () => new Response("{}", { status: 202 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const mcpTools = {
      lobu: [
        {
          name: "search_memory",
          description: "Search memory",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
          },
        },
      ],
    };
    const registered = createMcpToolDefinitions(
      mcpTools,
      gw,
      {},
      {
        shifuTrace: {
          traceId: "tr_workerobs123456",
          journeyId: "line_reply",
          turnId: "turn_workerobs123",
          actor: "worker",
          traceSource: "incoming",
        },
      }
    );

    await emitWorkerToolsRegisteredObsEvent({
      trace: {
        traceId: "tr_workerobs123456",
        journeyId: "line_reply",
        turnId: "turn_workerobs123",
        actor: "worker",
        traceSource: "incoming",
      },
      conversationId: gw.conversationId,
      agentId: gw.agentId,
      userId: gw.userId,
      toolCount: registered.length,
      mcpToolCount: registered.length,
      authToolCount: 0,
      pluginToolCount: 0,
      mcpIds: Object.keys(mcpTools),
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, journeyInit] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const journeyPayload = JSON.parse(String(journeyInit.body));
    expect(journeyPayload).toMatchObject({
      schemaVersion: "journey.trace.v1",
      payload: {
        schema_version: "journey.trace.v1",
        event: "lobu.worker.tools_registered",
        trace_id: "tr_workerobs123456",
        journey_id: "line_reply",
        service: "lobu",
        module: "agent-worker",
        status: "ok",
        tool_count: 1,
        mcp_tool_count: 1,
      },
    });
    expect(journeyPayload.payload.mcp_ids).toEqual(["lobu"]);

    const [, init] = fetchMock.mock.calls[1] as unknown as [
      string,
      RequestInit,
    ];
    const payload = JSON.parse(String(init.body));
    expect(payload).toMatchObject({
      eventName: "lobu.worker.tools_registered",
      status: "ok",
      stage: "lobu.worker.tools_registered",
      traceId: "tr_workerobs123456",
      turnId: "turn_workerobs123",
      conversationId: "conv-1",
      metadata: {
        module: "agent-worker",
        tool_count: 1,
        mcp_tool_count: 1,
      },
    });
    expect(payload).not.toHaveProperty("agentId");
    expect(payload).not.toHaveProperty("userId");
    expect(payload).not.toHaveProperty("toolboxUserId");
    expectNoRawIdentifiers(parseFetchBodies(fetchMock), [
      gw.agentId,
      gw.userId,
    ]);
    expect(payload.metadata.mcp_ids).toEqual(["lobu"]);
  });
});
