import { randomUUID } from "node:crypto";
import {
  applyMcpToolFilter,
  createLogger,
  type GuardrailRegistry,
  type McpToolFilter,
  runGuardrailInstances,
  verifyWorkerToken,
} from "@lobu/core";
import { resolveAgentGuardrails } from "../../guardrails/aggregator.js";
import type { Context } from "hono";
import { Hono } from "hono";
import { storePendingTool } from "./pending-tool-store.js";
import { getRevokedTokenStore } from "../revoked-token-store.js";
import { requiresToolApproval } from "../../permissions/approval-policy.js";
import type { GrantStore } from "../../permissions/grant-store.js";
import type { AgentSettingsStore } from "../settings/agent-settings-store.js";
import { recordGuardrailTrip } from "../../guardrails/audit.js";
import { getOrgId, orgContext } from "../../../lobu/stores/org-context.js";
import {
  getStoredCredential,
  refreshCredential,
  startDeviceAuth,
  tryCompletePendingDeviceAuth,
} from "../../routes/internal/device-auth.js";
import type { WritableSecretStore } from "../../secrets/index.js";
import { isInternalUrl } from "../../proxy/ssrf-guard.js";
import { startAuthCodeFlow } from "./oauth-flow.js";
import { McpServerHealth } from "./server-health.js";
import type { CachedMcpServer, McpTool, McpToolCache } from "./tool-cache.js";
import {
  emitJourneyEvent,
  parseShifuTraceHeaders,
  type ShifuTraceContext,
} from "../../trace-context.js";
import { emitAgentObsEvent } from "../../../observability/shifu-agent-obs.js";

const logger = createLogger("mcp-proxy");

const MAX_BODY_SIZE = 1024 * 1024; // 1MB
const OBS_RESPONSE_INSPECT_MAX_BYTES = 64 * 1024;
const OBS_RESPONSE_INSPECT_TIMEOUT_MS = 1000;

// Bound upstream MCP calls so a slow/hung third-party server can't pin a
// worker turn (and the gateway request serving it) indefinitely. Applies to
// POST/DELETE (JSON-RPC calls) only — GET opens the streamable-HTTP SSE
// listening stream, which is long-lived by design and must not be aborted.
// 120s matches the worker-side MCP call budget.
const UPSTREAM_FETCH_TIMEOUT_MS = Number(
  process.env.MCP_PROXY_FETCH_TIMEOUT_MS ?? 120_000
);

function upstreamTimeoutSignal(method: string): AbortSignal | undefined {
  return method.toUpperCase() === "GET"
    ? undefined
    : AbortSignal.timeout(UPSTREAM_FETCH_TIMEOUT_MS);
}

function safeHost(value: string | URL | undefined): string {
  if (!value) return "";
  try {
    const url = value instanceof URL ? value : new URL(value);
    return url.hostname;
  } catch {
    return "";
  }
}

function safeUrlHost(value: string): string | undefined {
  return safeHost(value) || undefined;
}

function safeObjectKeys(value: unknown): string[] {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value).sort()
    : [];
}

function generatedMcpTrace(): ShifuTraceContext {
  return {
    traceId: `tr_${randomUUID().replace(/-/g, "")}`,
    journeyId: "unknown",
    actor: "worker",
    traceSource: "generated_missing_header",
  };
}

function mcpObsErrorSignal(error: unknown): string {
  if (error instanceof Error) {
    const record = error as Error & {
      code?: unknown;
      status?: unknown;
      diagnosticCode?: unknown;
    };
    return [
      error.name,
      error.message,
      record.code,
      record.status,
      record.diagnosticCode,
    ]
      .filter((value) => value !== undefined && value !== null)
      .map(String)
      .join(" ");
  }
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    return [
      record.name,
      record.message,
      record.code,
      record.status,
      record.diagnosticCode,
    ]
      .filter((value) => value !== undefined && value !== null)
      .map(String)
      .join(" ");
  }
  return String(error ?? "");
}

function classifyMcpObsError(error: unknown): string {
  const signal = mcpObsErrorSignal(error);
  const diagnosticCode = signal.toLowerCase().replace(/[-\s]+/g, "_");
  if (/401|403|unauthorized|forbidden|oauth|token/i.test(signal)) {
    return "needs_reauth";
  }
  if (
    /\b(?:tool_not_found|tool_schema_invalid|unknown_tool|unknown_mcp|unknown_server|allowlist_denied|not_allowed)\b/.test(
      diagnosticCode
    )
  ) {
    return "config_error";
  }
  if (
    /not found|allowlist|not allowed|\bunknown\s+(?:mcp|server|connector|tool)\b/i.test(
      signal
    )
  ) {
    return "config_error";
  }
  if (
    /timeout|timed out|econn|network|fetch failed|5\d\d|connector_unavailable/i.test(
      signal
    )
  ) {
    return "transient_error";
  }
  return "unknown_error";
}

function nextMcpDebugHint(errorClass: string): string {
  if (errorClass === "needs_reauth") {
    return "Check MCP OAuth connection, refresh flow, and required scopes.";
  }
  if (errorClass === "config_error") {
    return "Check MCP server config, tool allowlist, and the requested tool name.";
  }
  if (errorClass === "transient_error") {
    return "Check MCP upstream network health, timeouts, and 5xx responses.";
  }
  return "Check MCP proxy logs and upstream MCP server response details.";
}

const RESULT_PREVIEW_MAX_LENGTH = 300;
const SENSITIVE_PREVIEW_PATTERN =
  /\b(bearer|token|secret|password|api[_\-\s]?key|authorization)\b|sk-[a-z0-9_-]+/gi;

function sanitizeResultPreviewText(value: string): string {
  const redacted = value.replace(SENSITIVE_PREVIEW_PATTERN, "[REDACTED]");
  if (redacted.length <= RESULT_PREVIEW_MAX_LENGTH) return redacted;
  return `${redacted.slice(0, RESULT_PREVIEW_MAX_LENGTH)}...[truncated]`;
}

function resultPreviewFromValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return { value_type: typeof value };
  }

  const record = value as {
    content?: unknown;
    isError?: unknown;
    diagnosticCode?: unknown;
  };
  const content = Array.isArray(record.content) ? record.content : [];
  const preview: Record<string, unknown> = {
    is_error: Boolean(record.isError),
    content_count: content.length,
  };
  if (typeof record.diagnosticCode === "string") {
    preview.diagnostic_code = record.diagnosticCode;
  }

  const first = content[0];
  if (first && typeof first === "object") {
    const firstRecord = first as { type?: unknown; text?: unknown };
    if (typeof firstRecord.type === "string") {
      preview.first_content_type = firstRecord.type;
    }
    if (typeof firstRecord.text === "string") {
      preview.first_text = sanitizeResultPreviewText(firstRecord.text);
    }
  }
  return preview;
}

function resultPreviewFromJsonRpcError(
  error: { code?: unknown; message?: unknown } | unknown
): Record<string, unknown> {
  if (!error || typeof error !== "object") {
    return { value_type: typeof error };
  }

  const record = error as { code?: unknown; message?: unknown };
  return {
    ...(typeof record.code === "number" ? { error_code: record.code } : {}),
    ...(typeof record.message === "string"
      ? { message: sanitizeResultPreviewText(record.message) }
      : {}),
  };
}

function toolNameFromJsonRpcToolCall(bodyText: string): string | undefined {
  try {
    const parsed = JSON.parse(bodyText);
    if (Array.isArray(parsed)) return undefined;
    if (parsed?.method !== "tools/call") return undefined;
    const name = parsed.params?.name;
    return typeof name === "string" && name.trim() ? name.trim() : undefined;
  } catch {
    return undefined;
  }
}

function obsTraceMetadata(trace: ShifuTraceContext): Record<string, unknown> {
  return {
    journey_id: trace.journeyId,
    parent_span_id: trace.parentSpanId,
    trace_source: trace.traceSource,
  };
}

function emitMcpObsEvent(input: {
  trace: ShifuTraceContext;
  eventName: string;
  status: "started" | "ok" | "failed" | string;
  stage: string;
  agentId?: string;
  userId?: string;
  mcpId: string;
  toolName?: string;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}): void {
  void emitAgentObsEvent({
    traceId: input.trace.traceId,
    turnId: input.trace.turnId,
    agentId: input.agentId,
    userId: input.userId,
    toolboxUserId: input.userId,
    connectorKey: input.mcpId,
    toolName: input.toolName,
    eventName: input.eventName,
    status: input.status,
    stage: input.stage,
    durationMs: input.durationMs,
    metadata: {
      ...obsTraceMetadata(input.trace),
      event: input.eventName,
      module: "mcp-proxy",
      mcp_id: input.mcpId,
      ...(input.toolName ? { tool_name: input.toolName } : {}),
      ...input.metadata,
    },
  });
}

/** Standard MCP `initialize` request body. */
const INITIALIZE_BODY = JSON.stringify({
  jsonrpc: "2.0",
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "lobu-gateway", version: "1.0.0" },
  },
  id: 0,
});

/** Standard MCP `notifications/initialized` body. */
const INITIALIZED_NOTIFICATION_BODY = JSON.stringify({
  jsonrpc: "2.0",
  method: "notifications/initialized",
});

/** Payload shape surfaced to the user when an MCP upstream needs auth. */
type AuthRequiredPayload = {
  status: "login_required" | "pending";
  url?: string;
  userCode?: string;
  message: string;
  expiresInSeconds?: number;
};

/**
 * Parse a JSON-RPC response body that may be either a plain JSON object
 * (Content-Type: application/json) or a single-event SSE stream
 * (Content-Type: text/event-stream). Streamable-HTTP MCP servers may return
 * either form per the MCP spec.
 */
async function parseJsonRpcResponse(response: Response): Promise<any> {
  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();
  return parseJsonRpcResponseText(contentType, text);
}

function parseJsonRpcResponseText(contentType: string, text: string): any {
  if (contentType.includes("text/event-stream")) {
    // SSE frames: sequence of `event:`/`data:` lines separated by blank lines.
    // For request/response JSON-RPC we expect the last `data:` payload to be
    // the JSON-RPC response object.
    let payload = "";
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith("data:")) {
        payload = line.slice(5).trimStart();
      }
    }
    if (!payload) {
      throw new Error("SSE response contained no data payload");
    }
    return JSON.parse(payload);
  }
  return JSON.parse(text);
}

interface JsonRpcResponse {
  jsonrpc: string;
  id: unknown;
  result?: {
    tools?: McpTool[];
    content?: unknown[];
    isError?: boolean;
    diagnosticCode?: unknown;
    code?: unknown;
    name?: unknown;
  };
  error?: { code: number; message: string };
}

class McpHttpStatusError extends Error {
  constructor(
    public readonly status: number,
    message = `MCP upstream returned HTTP ${status}`
  ) {
    super(message);
    this.name = "McpHttpStatusError";
  }
}

class McpJsonRpcError extends Error {
  constructor(
    public readonly code: number | undefined,
    message = "MCP upstream returned a JSON-RPC error"
  ) {
    super(message);
    this.name = "McpJsonRpcError";
  }
}

class McpDiscoveryAuthError extends Error {
  constructor(
    public readonly diagnosticCode: "upstream_unauthorized" | "upstream_forbidden",
    message = "MCP tools/list requires authentication"
  ) {
    super(message);
    this.name = "McpDiscoveryAuthError";
  }
}

const SAFE_MCP_TOOL_DIAGNOSTIC_CODES = new Set([
  "oauth_scope_denied",
  "oauth_refresh_failed",
  "upstream_unauthorized",
  "upstream_forbidden",
  "upstream_rate_limited",
  "tool_schema_invalid",
  "connector_unavailable",
  "tool_not_found",
]);

function diagnosticCodeForHttpStatus(status: number): string {
  if (status === 401) return "upstream_unauthorized";
  if (status === 403) return "upstream_forbidden";
  if (status === 429) return "upstream_rate_limited";
  return "connector_unavailable";
}

function safeMcpToolDiagnosticCode(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_MCP_TOOL_DIAGNOSTIC_CODES.has(value)
    ? value
    : undefined;
}

function diagnosticCodeFromToolResult(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const record = result as {
    diagnosticCode?: unknown;
    code?: unknown;
    name?: unknown;
  };
  return (
    safeMcpToolDiagnosticCode(record.diagnosticCode) ??
    safeMcpToolDiagnosticCode(record.code) ??
    safeMcpToolDiagnosticCode(record.name)
  );
}

type ForwardedToolCallObsInspection = {
  status: "ok" | "failed";
  metadata: Record<string, unknown>;
  resultOrError?: unknown;
};

async function inspectForwardedToolCallResponseForObs(
  response: Response
): Promise<ForwardedToolCallObsInspection | null> {
  const contentType = response.headers.get("content-type") || "";
  if (
    !contentType.includes("application/json") &&
    !contentType.includes("text/event-stream")
  ) {
    return null;
  }

  try {
    const bodyText = await readResponseTextForObs(response);
    if (!bodyText) return null;
    const data = parseJsonRpcResponseText(
      contentType,
      bodyText
    ) as JsonRpcResponse;
    if (data?.error) {
      const errorMsg =
        data.error.message ||
        (typeof data.error === "string" ? data.error : "Upstream error");
      return {
        status: "failed",
        metadata: {
          jsonrpc_error_code: data.error.code,
          result_preview: resultPreviewFromJsonRpcError(data.error),
        },
        resultOrError: new McpJsonRpcError(data.error.code, errorMsg),
      };
    }

    const result = data?.result;
    if (result?.isError) {
      return {
        status: "failed",
        metadata: {
          result_preview: resultPreviewFromValue(result),
          ...(diagnosticCodeFromToolResult(result)
            ? { diagnostic_code: diagnosticCodeFromToolResult(result) }
            : {}),
        },
        resultOrError: result,
      };
    }
  } catch {
    return null;
  }

  return null;
}

async function readResponseTextForObs(
  response: Response
): Promise<string | null> {
  if (!response.body) return "";

  const reader = response.body.getReader();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  const readPromise = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        totalBytes += value.byteLength;
        if (totalBytes > OBS_RESPONSE_INSPECT_MAX_BYTES) {
          await reader.cancel().catch(() => {
            /* noop */
          });
          return null;
        }
        chunks.push(value);
      }
      const merged = new Uint8Array(totalBytes);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return new TextDecoder().decode(merged);
    } catch {
      return null;
    }
  })();

  const timeoutPromise = new Promise<null>((resolve) => {
    timeout = setTimeout(() => {
      timedOut = true;
      void reader.cancel().catch(() => {
        /* noop */
      });
      resolve(null);
    }, OBS_RESPONSE_INSPECT_TIMEOUT_MS);
  });

  const result = await Promise.race([readPromise, timeoutPromise]);
  if (timeout) clearTimeout(timeout);
  return timedOut ? null : result;
}

interface HttpMcpServerConfig {
  id: string;
  upstreamUrl: string;
  oauth?: import("@lobu/core").McpOAuthConfig;
  inputs?: unknown[];
  headers?: Record<string, string>;
  toolFilter?: McpToolFilter;
  /** Credential scoping strategy: "user" (default) or "channel" (shared in a Slack channel). */
  authScope?: "user" | "channel";
  /** True when the upstream is the same embedded Lobu process (lobu-memory). */
  internal?: boolean;
}

interface McpConfigSource {
  getHttpServer(
    id: string,
    agentId?: string
  ): Promise<HttpMcpServerConfig | undefined>;
  getAllHttpServers(
    agentId?: string
  ): Promise<Map<string, HttpMcpServerConfig>>;
}

export function buildMcpSessionKey(
  agentId: string,
  mcpId: string,
  scopeKey?: string
): string {
  const orgId = getOrgId();
  const scope = scopeKey ?? "_unscoped";
  return `mcp:session:${orgId}:${agentId}:${mcpId}:${scope}`;
}

function buildToolCacheMcpId(
  mcpId: string,
  filter?: McpToolFilter
): string {
  const cacheFilter = normalizeToolFilterForCache(filter);
  if (!cacheFilter) return mcpId;
  return `${mcpId}:toolFilter:${JSON.stringify(cacheFilter)}`;
}

function hasActiveToolFilter(filter?: McpToolFilter): boolean {
  return normalizeToolFilterForCache(filter) !== null;
}

function normalizeToolFilterForCache(
  filter?: McpToolFilter
): { include?: string[]; exclude?: string[] } | null {
  const include = filter?.include?.filter(Boolean) ?? [];
  const exclude = filter?.exclude?.filter(Boolean) ?? [];
  if (include.length === 0 && exclude.length === 0) return null;
  return {
    ...(include.length > 0 ? { include } : {}),
    ...(exclude.length > 0 ? { exclude } : {}),
  };
}

async function authenticateRequest(
  c: Context
): Promise<{ tokenData: any; token: string } | null> {
  const sessionToken = extractSessionToken(c);
  if (!sessionToken) return null;

  const tokenData = verifyWorkerToken(sessionToken);
  if (!tokenData) return null;

  if (
    tokenData.jti &&
    (await getRevokedTokenStore().isRevoked(tokenData.jti))
  ) {
    return null;
  }

  return { tokenData, token: sessionToken };
}

function extractSessionToken(c: Context): string | null {
  const authHeader = c.req.header("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.substring(7);
  }

  return null;
}

export class McpProxy {
  private readonly SESSION_TTL_SECONDS = 30 * 60; // 30 minutes
  // Tool-approval cards may sit in-thread for a long time before the user
  // actually clicks (Slack notifications, async review, etc.). The pending
  // invocation key holds the args needed to execute the tool after approval;
  // 24h gives users a realistic window to respond. Anything shorter silently
  // drops late clicks (the take-on-claim returns null and the click no-ops).
  private readonly PENDING_TOOL_TTL = 24 * 60 * 60; // 24 hours
  /**
   * Per-process MCP upstream session-id cache. The session id is opaque to
   * the gateway and only valid for the upstream MCP server, so on a gateway
   * restart the worker simply re-runs `initialize` and gets a new session —
   * no cross-replica coherence needed.
   */
  private readonly sessions = new Map<string, { sessionId: string; expiresAt: number }>();
  private app: Hono;
  private readonly toolCache?: McpToolCache;
  private readonly secretStore: WritableSecretStore;
  private readonly grantStore?: GrantStore;
  private readonly publicGatewayUrl?: string;
  private readonly agentSettingsStore?: AgentSettingsStore;
  private readonly guardrailRegistry?: GuardrailRegistry;
  private readonly serverHealth = new McpServerHealth();

  /** Callback invoked when a tool call is blocked for approval. */
  public onToolBlocked?: (
    requestId: string,
    agentId: string,
    userId: string,
    mcpId: string,
    toolName: string,
    args: Record<string, unknown>,
    grantPattern: string,
    channelId: string,
    conversationId: string,
    teamId: string | undefined,
    connectionId: string | undefined,
    platform: string | undefined,
    originMessageId: string | undefined,
    processedMessageIds: string[] | undefined
  ) => Promise<void>;

  /** Callback invoked when an MCP auth flow is started or already pending. */
  public onAuthRequired?: (
    agentId: string,
    userId: string,
    mcpId: string,
    payload: {
      status: "login_required" | "pending";
      url?: string;
      userCode?: string;
      message: string;
    },
    channelId: string,
    conversationId: string,
    teamId: string | undefined,
    connectionId: string | undefined,
    platform: string | undefined
  ) => Promise<void>;

  constructor(
    private readonly configService: McpConfigSource,
    options: {
      secretStore: WritableSecretStore;
      toolCache?: McpToolCache;
      grantStore?: GrantStore;
      /** Absolute gateway URL for OAuth redirect_uri construction. */
      publicGatewayUrl?: string;
      /** Source of per-agent guardrail enable lists for the pre-tool stage. */
      agentSettingsStore?: AgentSettingsStore;
      /** Shared registry of guardrails; pre-tool stage entries are queried. */
      guardrailRegistry?: GuardrailRegistry;
    }
  ) {
    this.secretStore = options.secretStore;
    this.toolCache = options.toolCache;
    this.grantStore = options.grantStore;
    this.publicGatewayUrl = options.publicGatewayUrl;
    this.agentSettingsStore = options.agentSettingsStore;
    this.guardrailRegistry = options.guardrailRegistry;
    this.app = new Hono();
    this.setupRoutes();
    logger.debug("MCP proxy initialized");
  }

  getApp(): Hono {
    return this.app;
  }

  /**
   * Execute an MCP tool call through guardrails and approval checks before
   * falling through to direct execution.
   */
  async callToolWithApproval(
    agentId: string,
    userId: string,
    mcpId: string,
    toolName: string,
    args: Record<string, unknown>,
    tokenContext: {
      token?: string;
      channelId?: string;
      conversationId?: string;
      organizationId?: string;
      messageId?: string;
      processedMessageIds?: string[];
      connectionId?: string;
      teamId?: string;
      platform?: string;
    } = {}
  ): Promise<{
    status: "executed" | "blocked-notified" | "blocked-no-channel";
    content: Array<{ type: string; text: string }>;
    isError: boolean;
    diagnosticCode?: string;
  }> {
    const tokenData = {
      userId,
      agentId,
      channelId: tokenContext.channelId,
      conversationId: tokenContext.conversationId,
      organizationId: tokenContext.organizationId,
      messageId: tokenContext.messageId,
      processedMessageIds: tokenContext.processedMessageIds,
      connectionId: tokenContext.connectionId,
      teamId: tokenContext.teamId,
      platform: tokenContext.platform,
    };
    const token = tokenContext.token ?? "";

    if (await this.runPreToolGuardrails(agentId, tokenData, toolName, args)) {
      return {
        status: "executed",
        content: [{ type: "text", text: "Tool call blocked by policy." }],
        isError: true,
      };
    }

    const approval = await this.evaluateToolApproval(
      mcpId,
      toolName,
      args,
      agentId,
      tokenData,
      token
    );

    if (approval === "blocked-notified") {
      return {
        status: "blocked-notified",
        content: [
          {
            type: "text",
            text: "Tool call requires approval. The user has been asked to approve.",
          },
        ],
        isError: true,
      };
    }

    if (approval === "blocked-no-channel") {
      return {
        status: "blocked-no-channel",
        content: [
          {
            type: "text",
            text: `Tool call requires approval. Request access approval in chat for: ${mcpId} → ${toolName}`,
          },
        ],
        isError: true,
      };
    }

    const result = await this.executeToolDirect(
      agentId,
      userId,
      mcpId,
      toolName,
      args
    );
    return { status: "executed", ...result };
  }

  async executeToolDirect(
    agentId: string,
    userId: string,
    mcpId: string,
    toolName: string,
    args: Record<string, unknown>,
    options?: { trace?: ShifuTraceContext }
  ): Promise<{
    content: Array<{ type: string; text: string }>;
    isError: boolean;
    diagnosticCode?: string;
  }> {
    const trace = options?.trace ?? generatedMcpTrace();
    const toolCallStartedAt = Date.now();
    const emitToolCallCompleted = (
      status: "ok" | "failed",
      metadata: Record<string, unknown>,
      resultOrError?: unknown
    ) => {
      const classification =
        status === "ok" ? "ok" : classifyMcpObsError(resultOrError);
      emitMcpObsEvent({
        trace,
        eventName: "lobu.mcp.tool_call.completed",
        status,
        stage: "lobu.mcp.tool_call",
        agentId,
        userId,
        mcpId,
        toolName,
        durationMs: Date.now() - toolCallStartedAt,
        metadata: {
          classification,
          ...metadata,
        },
      });
    };

    const httpServer = await this.configService.getHttpServer(mcpId, agentId);
    if (!httpServer) {
      const result = {
        content: [{ type: "text", text: `MCP server '${mcpId}' not found` }],
        isError: true,
        diagnosticCode: "tool_not_found",
      };
      emitToolCallCompleted(
        "failed",
        {
          result_preview: resultPreviewFromValue(result),
        },
        new Error(`MCP server '${mcpId}' not found`)
      );
      return {
        content: [{ type: "text", text: `MCP server '${mcpId}' not found` }],
        isError: true,
        diagnosticCode: "tool_not_found",
      };
    }

    // executeToolDirect is called from the interaction bridge after user
    // approval, where no channelId is carried — so we can only honor
    // authScope="user" here. For channel-scoped servers, fall back to
    // userId (still correct for the requesting user's personal credential).
    const scopeKey = this.computeScopeKey(httpServer, userId, undefined);
    const sessionKey = this.buildSessionKey(agentId, mcpId, scopeKey);
    const healthKey = this.buildServerHealthKey(agentId, mcpId);

    const pause = this.serverHealth.getPause(healthKey);
    if (pause) {
      logger.warn("Direct MCP tool execution paused after repeated failures", {
        mcpId,
        agentId,
        toolName,
        pausedUntil: pause.pausedUntil,
        lastError: pause.lastError,
      });
      const result = {
        content: [
          {
            type: "text",
            text: `MCP server '${mcpId}' is temporarily paused after repeated failures.`,
          },
        ],
        isError: true,
        diagnosticCode: "connector_unavailable",
      };
      emitToolCallCompleted(
        "failed",
        {
          result_preview: resultPreviewFromValue(result),
          server_paused: true,
        },
        pause.lastError || "MCP server paused"
      );
      return {
        content: [
          {
            type: "text",
            text: `MCP server '${mcpId}' is temporarily paused after repeated failures.`,
          },
        ],
        isError: true,
        diagnosticCode: "connector_unavailable",
      };
    }

    const jsonRpcBody = JSON.stringify({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: toolName, arguments: args },
      id: 1,
    });

    try {
      let lastResponseStatus: number | undefined;
      if (!this.getSession(sessionKey)) {
        await this.reinitializeSession(httpServer, agentId, mcpId, scopeKey);
      }

      let response = await this.sendUpstreamRequest(
        httpServer,
        agentId,
        mcpId,
        "POST",
        jsonRpcBody,
        scopeKey
      );
      lastResponseStatus = response.status;
      if (!response.ok && response.status === 404 && this.getSession(sessionKey)) {
        await response.body?.cancel().catch(() => {
          /* noop */
        });
        await this.reinitializeSession(httpServer, agentId, mcpId, scopeKey);
        response = await this.sendUpstreamRequest(
          httpServer,
          agentId,
          mcpId,
          "POST",
          jsonRpcBody,
          scopeKey
        );
        lastResponseStatus = response.status;
      }

      if (!response.ok) {
        const text = await response.text();
        if (response.status >= 500) {
          this.recordServerFailure(
            healthKey,
            mcpId,
            new McpHttpStatusError(response.status),
            response.status,
            "direct tool execution"
          );
        }
        const result = {
          content: [
            {
              type: "text",
              text: `Tool call failed: HTTP ${response.status}`,
            },
          ],
          isError: true,
          diagnosticCode: diagnosticCodeForHttpStatus(response.status),
        };
        emitToolCallCompleted(
          "failed",
          {
            http_status: response.status,
            result_preview: resultPreviewFromValue(result),
          },
          new McpHttpStatusError(response.status, text)
        );
        return {
          content: [
            {
              type: "text",
              text: `Tool call failed: ${response.status} ${text}`,
            },
          ],
          isError: true,
          diagnosticCode: diagnosticCodeForHttpStatus(response.status),
        };
      }

      const json = (await parseJsonRpcResponse(response)) as any;
      if (json?.error) {
        const result = {
          content: [],
          isError: true,
          diagnosticCode: diagnosticCodeForHttpStatus(lastResponseStatus ?? 502),
        };
        emitToolCallCompleted(
          "failed",
          {
            jsonrpc_error_code: json.error.code,
            result_preview: resultPreviewFromValue(result),
          },
          new McpJsonRpcError(json.error.code, json.error.message)
        );
        return {
          content: [],
          isError: true,
          diagnosticCode: diagnosticCodeForHttpStatus(lastResponseStatus ?? 502),
        };
      }
      const result = json.result || json;
      this.serverHealth.recordSuccess(healthKey);
      emitToolCallCompleted(
        result.isError ? "failed" : "ok",
        {
          result_preview: resultPreviewFromValue(result),
        },
        result
      );
      return {
        content: result.content || [
          { type: "text", text: JSON.stringify(result) },
        ],
        isError: result.isError || false,
        diagnosticCode: diagnosticCodeFromToolResult(result),
      };
    } catch (error) {
      this.recordServerFailure(
        healthKey,
        mcpId,
        error,
        this.statusFromError(error),
        "direct tool execution"
      );
      const result = {
        content: [
          {
            type: "text",
            text: `Tool execution error: ${String(error)}`,
          },
        ],
        isError: true,
        diagnosticCode: "connector_unavailable",
      };
      emitToolCallCompleted(
        "failed",
        {
          result_preview: resultPreviewFromValue(result),
        },
        error
      );
      return result;
    }
  }

  /**
   * Check if this request is an MCP proxy request (has X-Mcp-Id header)
   * Used by gateway to determine if root path requests should be handled by MCP proxy
   */
  isMcpRequest(c: Context): boolean {
    return !!c.req.header("x-mcp-id");
  }

  async listToolsDirect(
    agentId: string,
    userId: string,
    mcpId: string
  ): Promise<{ tools: McpTool[]; instructions?: string }> {
    return this.fetchToolsForMcp(
      mcpId,
      agentId,
      { userId, channelId: "" },
      undefined,
      { surfaceErrors: true }
    );
  }

  /**
   * Fetch tools and instructions for a specific MCP server.
   * Performs MCP initialize handshake first to capture server instructions,
   * then fetches tool list.
   */
  async fetchToolsForMcp(
    mcpId: string,
    agentId: string,
    tokenData: any,
    workerToken?: string,
    options?: { surfaceErrors?: boolean; trace?: ShifuTraceContext }
  ): Promise<{ tools: McpTool[]; instructions?: string }> {
    const trace = options?.trace ?? generatedMcpTrace();
    const listStartedAt = Date.now();
    const userId = tokenData?.userId;
    let toolsListObsCompleted = false;
    const emitToolsListCompleted = (
      status: "ok" | "failed",
      metadata: Record<string, unknown>,
      error?: unknown
    ) => {
      if (toolsListObsCompleted) return;
      toolsListObsCompleted = true;
      const errorClass = status === "failed" ? classifyMcpObsError(error) : undefined;
      emitMcpObsEvent({
        trace,
        eventName: "lobu.mcp.tools_list.completed",
        status,
        stage: "lobu.mcp.tools_list",
        agentId,
        userId,
        mcpId,
        durationMs: Date.now() - listStartedAt,
        metadata: {
          ...metadata,
          ...(errorClass
            ? {
                error_class: errorClass,
                next_debug_hint: nextMcpDebugHint(errorClass),
              }
            : {}),
        },
      });
    };
    const emitDiscoveryAuthFailure = (
      diagnosticCode: "upstream_unauthorized" | "upstream_forbidden",
      upstreamHost?: string
    ) => {
      emitToolsListCompleted(
        "failed",
        {
          cache_status: "miss",
          tool_count: 0,
          ...(upstreamHost ? { upstream_host: upstreamHost } : {}),
          diagnostic_code: diagnosticCode,
        },
        new McpDiscoveryAuthError(diagnosticCode)
      );
    };

    emitMcpObsEvent({
      trace,
      eventName: "lobu.mcp.tools_list.started",
      status: "started",
      stage: "lobu.mcp.tools_list",
      agentId,
      userId,
      mcpId,
      metadata: {
        cache_status: "unknown",
        has_agent_id: Boolean(agentId),
      },
    });

    const httpServer = await this.configService.getHttpServer(mcpId, agentId);
    if (!httpServer) {
      emitJourneyEvent({
        event: "mcp.agent_settings.loaded",
        trace,
        module: "mcp-proxy",
        status: "failed",
        fields: {
          mcp_id: mcpId,
          has_agent_id: Boolean(agentId),
          error_code: "mcp_server_not_found",
        },
      });
      emitToolsListCompleted(
        "failed",
        {
          cache_status: "unknown",
          tool_count: 0,
        },
        new Error(`MCP server '${mcpId}' not found`)
      );
      return { tools: [] };
    }
    emitJourneyEvent({
      event: "mcp.agent_settings.loaded",
      trace,
      module: "mcp-proxy",
      status: "ok",
      fields: {
        mcp_id: mcpId,
        has_agent_id: Boolean(agentId),
        upstream_url_host: safeUrlHost(httpServer.upstreamUrl),
        internal: httpServer.internal === true,
      },
    });
    const cacheMcpId = buildToolCacheMcpId(mcpId, httpServer.toolFilter);
    const healthKey = this.buildServerHealthKey(agentId, mcpId);

    let cached: CachedMcpServer | null = null;
    if (this.toolCache) {
      cached = this.toolCache.getServerInfo(cacheMcpId, agentId);
    }

    const pause = this.serverHealth.getPause(healthKey);
    if (pause) {
      logger.warn("MCP discovery paused after repeated failures", {
        mcpId,
        agentId,
        pausedUntil: pause.pausedUntil,
        lastError: pause.lastError,
        cacheHit: !!cached,
      });
      if (cached) {
        emitToolsListCompleted("ok", {
          cache_status: "hit",
          tool_count: cached.tools.length,
          has_instructions: Boolean(cached.instructions),
          server_paused: true,
        });
      } else {
        emitToolsListCompleted(
          "failed",
          {
            cache_status: "miss",
            tool_count: 0,
            server_paused: true,
          },
          pause.lastError || "MCP server paused"
        );
      }
      return cached ?? { tools: [] };
    }

    if (cached) {
      emitJourneyEvent({
        event: "mcp.tools_list.completed",
        trace,
        module: "mcp-proxy",
        status: "ok",
        fields: {
          mcp_id: mcpId,
          cache_status: "hit",
          tool_count: cached.tools.length,
          has_instructions: Boolean(cached.instructions),
          has_agent_id: Boolean(agentId),
        },
      });
      emitToolsListCompleted("ok", {
        cache_status: "hit",
        tool_count: cached.tools.length,
        has_instructions: Boolean(cached.instructions),
        has_agent_id: Boolean(agentId),
      });
      return cached;
    }

    const channelId = tokenData?.channelId || "";
    const scopeKey = this.computeScopeKey(httpServer, userId, channelId);
    const hasFilter = hasActiveToolFilter(httpServer.toolFilter);
    const startedAt = Date.now();
    emitJourneyEvent({
      event: "mcp.tools_list.requested",
      trace,
      module: "mcp-proxy",
      status: "started",
      fields: {
        mcp_id: mcpId,
        cache_status: "miss",
        has_agent_id: Boolean(agentId),
        upstream_url_host: safeUrlHost(httpServer.upstreamUrl),
      },
    });

    try {
      // Clear any stale session before fresh tool discovery
      this.deleteSession(this.buildSessionKey(agentId, mcpId, scopeKey));

      // Step 1: Send initialize to capture server instructions
      let instructions: string | undefined;
      try {
        const initResponse = await this.sendInitialize(
          httpServer,
          agentId,
          mcpId,
          scopeKey,
          workerToken
        );

        // Tool discovery runs before the agent has a chance to call anything.
        // If the server demands OAuth, kick off the auth-code flow here so the
        // "Connect X" link reaches the user up-front.
        if (initResponse.status === 401) {
          const wwwAuth = initResponse.headers.get("www-authenticate");
          await initResponse.body?.cancel().catch(() => {
            /* noop */
          });
          await this.fireAuthCodeFlowFromDiscovery({
            mcpId,
            agentId,
            httpServer,
            wwwAuthenticate: wwwAuth,
            scopeKey,
            tokenData,
          });
          if (options?.surfaceErrors) {
            throw new McpDiscoveryAuthError("upstream_unauthorized");
          }
          emitDiscoveryAuthFailure(
            "upstream_unauthorized",
            safeHost(httpServer.upstreamUrl)
          );
          return { tools: [] };
        }

        if (initResponse.status === 403) {
          await initResponse.body?.cancel().catch(() => {
            /* noop */
          });
          if (options?.surfaceErrors) {
            throw new McpDiscoveryAuthError("upstream_forbidden");
          }
          emitDiscoveryAuthFailure(
            "upstream_forbidden",
            safeHost(httpServer.upstreamUrl)
          );
          return { tools: [] };
        }

        const initData = (await parseJsonRpcResponse(initResponse)) as {
          result?: { instructions?: string };
          error?: { code: number; message: string };
        };

        if (initData?.result?.instructions) {
          instructions = initData.result.instructions;
          logger.info("Captured MCP server instructions", {
            mcpId,
            length: instructions.length,
          });
        }

        // Step 2: Send initialized notification (required by MCP spec)
        await this.sendInitializedNotification(
          httpServer,
          agentId,
          mcpId,
          scopeKey,
          workerToken
        );
      } catch (initError) {
        if (options?.surfaceErrors && initError instanceof McpDiscoveryAuthError) {
          throw initError;
        }
        logger.warn("MCP initialize failed (continuing with tools/list)", {
          mcpId,
          error:
            initError instanceof Error ? initError.message : String(initError),
        });
      }

      // Step 3: Fetch tools list
      const jsonRpcBody = JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/list",
        params: {},
        id: 1,
      });

      const response = await this.sendUpstreamRequest(
        httpServer,
        agentId,
        mcpId,
        "POST",
        jsonRpcBody,
        scopeKey,
        workerToken
      );

      if (response.status === 401) {
        const wwwAuth = response.headers.get("www-authenticate");
        await response.body?.cancel().catch(() => {
          /* noop */
        });
        await this.fireAuthCodeFlowFromDiscovery({
          mcpId,
          agentId,
          httpServer,
          wwwAuthenticate: wwwAuth,
          scopeKey,
          tokenData,
        });
        if (options?.surfaceErrors) {
          throw new McpDiscoveryAuthError("upstream_unauthorized");
        }
        emitDiscoveryAuthFailure(
          "upstream_unauthorized",
          safeHost(httpServer.upstreamUrl)
        );
        return { tools: [] };
      }

      if (!response.ok) {
        if (response.status === 403) {
          await response.body?.cancel().catch(() => {
            /* noop */
          });
          if (options?.surfaceErrors) {
            throw new McpDiscoveryAuthError("upstream_forbidden");
          }
          emitDiscoveryAuthFailure(
            "upstream_forbidden",
            safeHost(httpServer.upstreamUrl)
          );
          return { tools: [] };
        }
        throw new McpHttpStatusError(response.status);
      }

      const data = (await parseJsonRpcResponse(response)) as JsonRpcResponse;
      if (data?.error) {
        const errorMsg =
          data.error.message || "MCP tools/list returned a JSON-RPC error";
        if (this.isAuthStyleToolError(errorMsg)) {
          if (options?.surfaceErrors) {
            throw new McpDiscoveryAuthError(
              this.authDiagnosticCodeFromMessage(errorMsg),
              errorMsg
            );
          }
          emitDiscoveryAuthFailure(
            this.authDiagnosticCodeFromMessage(errorMsg),
            safeHost(httpServer.upstreamUrl)
          );
          return { tools: [] };
        }
        throw new McpJsonRpcError(data.error.code, errorMsg);
      }
      const tools: McpTool[] = data?.result?.tools || [];
      const filteredTools = applyMcpToolFilter(tools, httpServer.toolFilter);
      this.serverHealth.recordSuccess(healthKey);

      const serverInfo: CachedMcpServer = {
        tools: filteredTools,
        instructions,
      };
      if (this.toolCache && (filteredTools.length > 0 || hasFilter)) {
        this.toolCache.setServerInfo(cacheMcpId, serverInfo, agentId);
      }
      emitJourneyEvent({
        event: "mcp.tools_list.completed",
        trace,
        module: "mcp-proxy",
        status: "ok",
        fields: {
          mcp_id: mcpId,
          cache_status: "miss",
          tool_count: filteredTools.length,
          duration_ms: Date.now() - startedAt,
          has_instructions: Boolean(instructions),
        },
      });
      emitToolsListCompleted("ok", {
        cache_status: "miss",
        tool_count: filteredTools.length,
        has_instructions: Boolean(instructions),
        upstream_host: safeHost(httpServer.upstreamUrl),
      });

      return serverInfo;
    } catch (error) {
      logger.warn("Failed to fetch tools for MCP, retrying once", {
        mcpId,
        error: error instanceof Error ? error.message : String(error),
      });

      // Retry once after a short delay (upstream may still be starting)
      await new Promise((r) => setTimeout(r, 2000));
      let recordedFailure = false;
      try {
        const retryBody = JSON.stringify({
          jsonrpc: "2.0",
          method: "tools/list",
          params: {},
          id: 1,
        });
        const retryResponse = await this.sendUpstreamRequest(
          httpServer,
          agentId,
          mcpId,
          "POST",
          retryBody,
          scopeKey,
          workerToken
        );
        if (retryResponse.status === 401) {
          const wwwAuth = retryResponse.headers.get("www-authenticate");
          await retryResponse.body?.cancel().catch(() => {
            /* noop */
          });
          await this.fireAuthCodeFlowFromDiscovery({
            mcpId,
            agentId,
            httpServer,
            wwwAuthenticate: wwwAuth,
            scopeKey,
            tokenData,
          });
          if (options?.surfaceErrors) {
            throw new McpDiscoveryAuthError("upstream_unauthorized");
          }
          emitDiscoveryAuthFailure(
            "upstream_unauthorized",
            safeHost(httpServer.upstreamUrl)
          );
          return { tools: [] };
        }
        if (retryResponse.status === 403) {
          await retryResponse.body?.cancel().catch(() => {
            /* noop */
          });
          if (options?.surfaceErrors) {
            throw new McpDiscoveryAuthError("upstream_forbidden");
          }
          emitDiscoveryAuthFailure(
            "upstream_forbidden",
            safeHost(httpServer.upstreamUrl)
          );
          return { tools: [] };
        }
        if (!retryResponse.ok) {
          throw new McpHttpStatusError(retryResponse.status);
        }
        const retryData = (await parseJsonRpcResponse(
          retryResponse
        )) as JsonRpcResponse;
        if (retryData?.error) {
          const errorMsg =
            retryData.error.message ||
            "MCP tools/list retry returned a JSON-RPC error";
          if (this.isAuthStyleToolError(errorMsg)) {
            if (options?.surfaceErrors) {
              throw new McpDiscoveryAuthError(
                this.authDiagnosticCodeFromMessage(errorMsg),
                errorMsg
              );
            }
            emitDiscoveryAuthFailure(
              this.authDiagnosticCodeFromMessage(errorMsg),
              safeHost(httpServer.upstreamUrl)
            );
            return { tools: [] };
          }
          throw new McpJsonRpcError(retryData.error.code, errorMsg);
        }
        const retryTools: McpTool[] = retryData?.result?.tools || [];
        const filteredRetryTools = applyMcpToolFilter(
          retryTools,
          httpServer.toolFilter
        );
        this.serverHealth.recordSuccess(healthKey);
        const serverInfo: CachedMcpServer = { tools: filteredRetryTools };
        if (filteredRetryTools.length > 0 || hasFilter) {
          if (this.toolCache) {
            this.toolCache.setServerInfo(cacheMcpId, serverInfo, agentId);
          }
        }
        logger.info("Retry succeeded for MCP tool fetch", {
          mcpId,
          toolCount: filteredRetryTools.length,
        });
        emitJourneyEvent({
          event: "mcp.tools_list.completed",
          trace,
          module: "mcp-proxy",
          status: "degraded",
          fields: {
            mcp_id: mcpId,
            cache_status: "miss",
            tool_count: filteredRetryTools.length,
            duration_ms: Date.now() - startedAt,
            retry_succeeded: true,
          },
        });
        emitToolsListCompleted("ok", {
          cache_status: "miss",
          tool_count: filteredRetryTools.length,
          retry_succeeded: true,
          upstream_host: safeHost(httpServer.upstreamUrl),
        });
        return serverInfo;
      } catch (retryError) {
        logger.error("Retry also failed for MCP tool fetch", {
          mcpId,
          error:
            retryError instanceof Error
              ? retryError.message
              : String(retryError),
        });
        this.recordDiscoveryFailure(
          healthKey,
          mcpId,
          retryError,
          this.statusFromError(retryError)
        );
        recordedFailure = true;
        // The curl-facing REST endpoint surfaces upstream failures as 502;
        // agent-boot discovery (the default) fails soft so one unreachable
        // MCP doesn't block the worker from starting.
        if (options?.surfaceErrors) {
          emitToolsListCompleted(
            "failed",
            {
              cache_status: "miss",
              tool_count: 0,
              upstream_host: safeHost(httpServer.upstreamUrl),
            },
            retryError
          );
          throw retryError;
        }
      }
      if (!recordedFailure) {
        this.recordDiscoveryFailure(
          healthKey,
          mcpId,
          error,
          this.statusFromError(error)
        );
      }
      if (options?.surfaceErrors) {
        emitToolsListCompleted(
          "failed",
          {
            cache_status: "miss",
            tool_count: 0,
            upstream_host: safeHost(httpServer.upstreamUrl),
          },
          error
        );
        throw error;
      }
      emitJourneyEvent({
        event: "mcp.tools_list.completed",
        trace,
        module: "mcp-proxy",
        status: "failed",
        fields: {
          mcp_id: mcpId,
          cache_status: "miss",
          tool_count: 0,
          duration_ms: Date.now() - startedAt,
          error_code: "tools_list_failed",
        },
      });
      emitToolsListCompleted(
        "failed",
        {
          cache_status: "miss",
          tool_count: 0,
          upstream_host: safeHost(httpServer.upstreamUrl),
        },
        error
      );
      return { tools: [] };
    }
  }

  private setupRoutes() {
    this.app.use("*", async (c, next) => {
      const sessionToken = extractSessionToken(c);
      if (!sessionToken) {
        return next();
      }

      const tokenData = verifyWorkerToken(sessionToken);
      if (!tokenData?.organizationId) {
        return next();
      }

      return orgContext.run({ organizationId: tokenData.organizationId }, () =>
        next()
      );
    });

    // REST API endpoints for curl-based tool access (registered BEFORE catch-all)
    this.app.get("/tools", (c) => this.handleListAllTools(c));
    this.app.get("/:mcpId/tools", (c) => this.handleListTools(c));
    this.app.post("/:mcpId/tools/:toolName", (c) => this.handleCallTool(c));

    // Path-based routes (catch-all for MCP streamable-HTTP transport)
    this.app.all("/:mcpId", (c) => this.handleProxyRequest(c));
    this.app.all("/:mcpId/*", (c) => this.handleProxyRequest(c));
  }

  private async handleListTools(c: Context): Promise<Response> {
    const trace = parseShifuTraceHeaders(c.req.raw.headers, "worker");
    const mcpId = c.req.param("mcpId");
    if (!mcpId) return c.json({ error: "Missing MCP server id" }, 400);
    const auth = await authenticateRequest(c);
    if (!auth) return c.json({ error: "Invalid authentication token" }, 401);

    const agentId = auth.tokenData.agentId || auth.tokenData.userId;
    const requesterUserId = auth.tokenData.userId;
    if (!agentId || !requesterUserId) {
      return c.json({ error: "Invalid authentication token" }, 401);
    }
    const httpServer = await this.configService.getHttpServer(mcpId, agentId);
    if (!httpServer) {
      return c.json({ error: `MCP server '${mcpId}' not found` }, 404);
    }

    // The curl-facing introspection endpoint must surface a hard SSRF block as
    // 403 — fetchToolsForMcp fails soft for agent-boot discovery and would
    // otherwise drain the blocked response and return an empty 200.
    const ssrfBlock = await this.ssrfBlockResponse(httpServer, mcpId, agentId);
    if (ssrfBlock) return ssrfBlock;

    try {
      const { tools, instructions } = await this.fetchToolsForMcp(
        mcpId,
        agentId,
        auth.tokenData,
        httpServer.internal === true ? auth.token : undefined,
        { surfaceErrors: true, trace }
      );
      return c.json({ tools, instructions });
    } catch (error) {
      logger.error("Failed to list tools", { mcpId, error });
      return c.json(
        {
          error: `Failed to connect to MCP '${mcpId}': ${error instanceof Error ? error.message : "Unknown error"}`,
        },
        502
      );
    }
  }

  private async handleCallTool(c: Context): Promise<Response> {
    const trace = parseShifuTraceHeaders(c.req.raw.headers, "worker");
    const mcpId = c.req.param("mcpId");
    const toolName = c.req.param("toolName");
    if (!mcpId || !toolName) {
      return c.json({ error: "Missing MCP server id or tool name" }, 400);
    }
    const auth = await authenticateRequest(c);
    if (!auth) return c.json({ error: "Invalid authentication token" }, 401);

    const agentId = auth.tokenData.agentId || auth.tokenData.userId;
    const requesterUserId = auth.tokenData.userId;
    if (!agentId || !requesterUserId) {
      return c.json({ error: "Invalid authentication token" }, 401);
    }
    const httpServer = await this.configService.getHttpServer(mcpId, agentId);
    if (!httpServer) {
      return c.json({ error: `MCP server '${mcpId}' not found` }, 404);
    }
    const channelId = auth.tokenData.channelId || "";
    const scopeKey = this.computeScopeKey(
      httpServer,
      requesterUserId,
      channelId
    );
    const healthKey = this.buildServerHealthKey(agentId, mcpId);

    // Parse body early so tool arguments are available for the approval message.
    let toolArguments: Record<string, unknown> = {};
    try {
      const body = await c.req.text();
      if (body) {
        if (body.length > MAX_BODY_SIZE) {
          return c.json({ error: "Request body too large" }, 413);
        }
        toolArguments = JSON.parse(body);
      }
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    // Pre-tool guardrails — same enforcement as the JSON-RPC path so this REST
    // entrypoint can't bypass the stage. Runs before approval and independently
    // of grantStore.
    if (
      await this.runPreToolGuardrails(
        agentId,
        auth.tokenData,
        toolName,
        toolArguments
      )
    ) {
      return c.json({
        content: [{ type: "text", text: "Tool call blocked by policy." }],
        isError: true,
      });
    }

    // Check tool approval based on annotations and grants.
    const approval = await this.evaluateToolApproval(
      mcpId,
      toolName,
      toolArguments,
      agentId,
      auth.tokenData,
      auth.token
    );
    emitJourneyEvent({
      event: "mcp.grant.checked",
      trace,
      module: "mcp-proxy",
      status: approval === "allow" ? "ok" : "blocked",
      fields: {
        mcp_id: mcpId,
        tool_name: toolName,
        grant_pattern: `/mcp/${mcpId}/tools/${toolName}`,
        approval_result: approval,
      },
    });
    if (approval === "blocked-notified") {
      return c.json(
        {
          content: [
            {
              type: "text",
              text: "Tool call requires approval. The user has been asked to approve. Your session will end. The result will arrive as your next message.",
            },
          ],
          isError: true,
        },
        403
      );
    }
    if (approval === "blocked-no-channel") {
      return c.json(
        {
          content: [
            {
              type: "text",
              text: `Tool call requires approval. Request access approval in chat for: ${mcpId} → ${toolName}`,
            },
          ],
          isError: true,
        },
        403
      );
    }

    const toolCallStartedAt = Date.now();
    const emitToolCallCompleted = (
      status: "ok" | "failed",
      metadata: Record<string, unknown>,
      resultOrError?: unknown
    ) => {
      const classification =
        status === "ok" ? "ok" : classifyMcpObsError(resultOrError);
      emitMcpObsEvent({
        trace,
        eventName: "lobu.mcp.tool_call.completed",
        status,
        stage: "lobu.mcp.tool_call",
        agentId,
        userId: requesterUserId,
        mcpId,
        toolName,
        durationMs: Date.now() - toolCallStartedAt,
        metadata: {
          classification,
          ...metadata,
        },
      });
    };

    const pause = this.serverHealth.getPause(healthKey);
    if (pause) {
      logger.warn("MCP tool call paused after repeated failures", {
        mcpId,
        agentId,
        toolName,
        pausedUntil: pause.pausedUntil,
        lastError: pause.lastError,
      });
      const result = {
        content: [
          {
            type: "text",
            text: `MCP server '${mcpId}' is temporarily paused after repeated failures.`,
          },
        ],
        isError: true,
        diagnosticCode: "connector_unavailable",
      };
      emitToolCallCompleted(
        "failed",
        {
          result_preview: resultPreviewFromValue(result),
          server_paused: true,
        },
        pause.lastError || "MCP server paused"
      );
      return c.json(
        {
          content: [
            {
              type: "text",
              text: `MCP server '${mcpId}' is temporarily paused after repeated failures.`,
            },
          ],
          isError: true,
          diagnosticCode: "connector_unavailable",
        },
        503
      );
    }

    let lastResponseStatus: number | undefined;
    try {
      emitJourneyEvent({
        event: "mcp.tool_call.requested",
        trace,
        module: "mcp-proxy",
        status: "started",
        fields: {
          mcp_id: mcpId,
          tool_name: toolName,
          argument_keys: safeObjectKeys(toolArguments),
        },
      });
      const jsonRpcBody = JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: toolName, arguments: toolArguments },
        id: 1,
      });

      // Forward the caller's `x-mcp-format` opt-in so internal MCPs (the
      // embedded lobu-memory server) can return raw JSON instead of formatted
      // markdown. The worker uses this for retrieval tools to surface
      // structured `result_summary` (event ids + snippet text) through the
      // `tool_use` SSE event.
      const callerFormat = c.req.header("x-mcp-format");
      const extraHeaders = callerFormat
        ? { "x-mcp-format": callerFormat }
        : undefined;

      let upstreamStartedAt = Date.now();
      emitJourneyEvent({
        event: "mcp.upstream.requested",
        trace,
        module: "mcp-proxy",
        status: "started",
        fields: {
          mcp_id: mcpId,
          tool_name: toolName,
          jsonrpc_method: "tools/call",
        },
      });
      let response = await this.sendUpstreamRequest(
        httpServer,
        agentId,
        mcpId,
        "POST",
        jsonRpcBody,
        scopeKey,
        auth.token,
        extraHeaders
      );
      lastResponseStatus = response.status;
      emitJourneyEvent({
        event: "mcp.upstream.responded",
        trace,
        module: "mcp-proxy",
        status: response.ok ? "ok" : "failed",
        fields: {
          mcp_id: mcpId,
          tool_name: toolName,
          jsonrpc_method: "tools/call",
          status_code: response.status,
          duration_ms: Date.now() - upstreamStartedAt,
        },
      });

      // Detect HTTP 401 + WWW-Authenticate → start MCP OAuth 2.1 auth-code flow.
      // This path runs before JSON-RPC parsing because most compliant MCP
      // servers (Sentry, etc.) return 401 at the transport layer, not a
      // JSON-RPC error body.
      if (response.status === 401) {
        const payload = await this.handleUpstream401({
          response,
          mcpId,
          agentId,
          userId: requesterUserId,
          scopeKey,
          httpServer,
          wwwAuthenticate: response.headers.get("www-authenticate"),
          platform: auth.tokenData.platform,
          channelId,
          conversationId: auth.tokenData.conversationId || "",
          teamId: auth.tokenData.teamId,
          connectionId: auth.tokenData.connectionId,
          deviceAuthFallback: true,
        });
        const result = {
          content: [
            {
              type: "text",
              text: payload
                ? JSON.stringify(payload)
                : `Authentication required for ${mcpId} but OAuth discovery failed.`,
            },
          ],
          isError: true,
        };
        emitToolCallCompleted(
          "failed",
          {
            http_status: response.status,
            result_preview: resultPreviewFromValue(result),
          },
          new McpHttpStatusError(response.status, "MCP OAuth token required")
        );
        return c.json(
          {
            content: [
              {
                type: "text",
                text: payload
                  ? JSON.stringify(payload)
                  : `Authentication required for ${mcpId} but OAuth discovery failed.`,
              },
            ],
            isError: true,
          },
          200
        );
      }

      let data = (await parseJsonRpcResponse(response)) as JsonRpcResponse;

      // Re-initialize session and retry on stale-session errors.
      //
      // Primary signal: MCP streamable-HTTP transport mandates HTTP 404 when
      // the `Mcp-Session-Id` header names a session the server no longer
      // knows (e.g. upstream restarted while we held the id cached).
      //
      // Fallback signal: some MCP servers return 200 with a JSON-RPC error
      // whose message is "Server not initialized" or "Session not found…".
      // We match both wordings rather than chase specific upstream phrasing.
      if (
        response.status === 404 ||
        (data?.error &&
          /not initialized|session not found/i.test(data.error.message || ""))
      ) {
        logger.info("MCP session expired, re-initializing before retry", {
          mcpId,
          toolName,
        });
        await this.reinitializeSession(httpServer, agentId, mcpId, scopeKey, auth.token);

        upstreamStartedAt = Date.now();
        emitJourneyEvent({
          event: "mcp.upstream.requested",
          trace,
          module: "mcp-proxy",
          status: "started",
          fields: {
            mcp_id: mcpId,
            tool_name: toolName,
            jsonrpc_method: "tools/call",
            retry: true,
          },
        });
        response = await this.sendUpstreamRequest(
          httpServer,
          agentId,
          mcpId,
          "POST",
          jsonRpcBody,
          scopeKey,
          auth.token
        );
        lastResponseStatus = response.status;
        emitJourneyEvent({
          event: "mcp.upstream.responded",
          trace,
          module: "mcp-proxy",
          status: response.ok ? "ok" : "failed",
          fields: {
            mcp_id: mcpId,
            tool_name: toolName,
            jsonrpc_method: "tools/call",
            status_code: response.status,
            duration_ms: Date.now() - upstreamStartedAt,
            retry: true,
          },
        });
        data = (await parseJsonRpcResponse(response)) as JsonRpcResponse;
      }

      if (!response.ok && !data?.error) {
        if (response.status >= 500) {
          this.recordServerFailure(
            healthKey,
            mcpId,
            new McpHttpStatusError(response.status),
            response.status,
            "tool call"
          );
        }
        const result = {
          content: [],
          isError: true,
          diagnosticCode: diagnosticCodeForHttpStatus(response.status),
        };
        emitToolCallCompleted(
          "failed",
          {
            http_status: response.status,
            result_preview: resultPreviewFromValue(result),
          },
          new McpHttpStatusError(response.status)
        );
        return c.json(
          {
            content: [],
            isError: true,
            error: `Upstream returned HTTP ${response.status}`,
          },
          502
        );
      }

      if (data?.error) {
        const errorMsg =
          data.error.message ||
          (typeof data.error === "string" ? data.error : "Upstream error");
        logger.error("Upstream returned JSON-RPC error on tool call", {
          mcpId,
          toolName,
          error: data.error,
        });

        // Detect auth errors — auto-start device-code auth flow
        if (/unauthorized|unauthenticated|forbidden/i.test(errorMsg)) {
          const autoAuthResult = await this.tryAutoDeviceAuth(
            mcpId,
            agentId,
            scopeKey
          );
          if (autoAuthResult) {
            await this.fireAuthRequired(
              agentId,
              requesterUserId,
              mcpId,
              autoAuthResult,
              auth.tokenData.channelId || "",
              auth.tokenData.conversationId || "",
              auth.tokenData.teamId,
              auth.tokenData.connectionId,
              auth.tokenData.platform
            );
          }
          const result = {
            content: [
              {
                type: "text",
                text: autoAuthResult
                  ? JSON.stringify(autoAuthResult)
                  : `Authentication required for ${mcpId}. Call ${mcpId}_login to authenticate.`,
              },
            ],
            isError: true,
          };
          emitToolCallCompleted(
            "failed",
            {
              jsonrpc_error_code: data.error.code,
              result_preview: resultPreviewFromValue(result),
            },
            new McpJsonRpcError(data.error.code, errorMsg)
          );
          return c.json(
            {
              content: [
                {
                  type: "text",
                  text: autoAuthResult
                    ? JSON.stringify(autoAuthResult)
                    : `Authentication required for ${mcpId}. Call ${mcpId}_login to authenticate.`,
                },
              ],
              isError: true,
            },
            200
          );
        }

        const result = {
          content: [],
          isError: true,
          diagnosticCode: diagnosticCodeForHttpStatus(lastResponseStatus ?? 502),
        };
        emitToolCallCompleted(
          "failed",
          {
            jsonrpc_error_code: data.error.code,
            result_preview: resultPreviewFromValue(result),
          },
          new McpJsonRpcError(data.error.code, errorMsg)
        );
        return c.json(
          {
            content: [],
            isError: true,
            error: errorMsg,
          },
          502
        );
      }

      const result = data?.result || {};
      this.serverHealth.recordSuccess(healthKey);
      emitJourneyEvent({
        event: "mcp.tool_call.completed",
        trace,
        module: "mcp-proxy",
        status: result.isError ? "failed" : "ok",
        fields: {
          mcp_id: mcpId,
          tool_name: toolName,
          is_error: Boolean(result.isError),
          content_count: Array.isArray(result.content) ? result.content.length : 0,
        },
      });
      emitToolCallCompleted(
        result.isError ? "failed" : "ok",
        {
          result_preview: resultPreviewFromValue(result),
        },
        result
      );
      return c.json({
        content: result.content || [],
        isError: result.isError || false,
      });
    } catch (error) {
      emitJourneyEvent({
        event: "mcp.tool_call.completed",
        trace,
        module: "mcp-proxy",
        status: "failed",
        fields: {
          mcp_id: mcpId,
          tool_name: toolName,
          error_code: "tool_call_failed",
        },
      });
      emitToolCallCompleted(
        "failed",
        {
          result_preview: resultPreviewFromValue({
            content: [],
            isError: true,
            diagnosticCode: "connector_unavailable",
          }),
        },
        error
      );
      this.recordServerFailure(
        healthKey,
        mcpId,
        error,
        this.statusFromError(error) ?? lastResponseStatus,
        "tool call"
      );
      logger.error("Failed to call tool", { mcpId, toolName, error });
      return c.json(
        {
          content: [],
          isError: true,
          error: `Failed to connect to MCP '${mcpId}': ${error instanceof Error ? error.message : "Unknown error"}`,
        },
        502
      );
    }
  }

  private async handleListAllTools(c: Context): Promise<Response> {
    const auth = await authenticateRequest(c);
    if (!auth) return c.json({ error: "Invalid authentication token" }, 401);

    const agentId = auth.tokenData.agentId || auth.tokenData.userId;

    const allHttpServers = await this.configService.getAllHttpServers(agentId);
    const allMcpIds = Array.from(allHttpServers.keys());

    const mcpServers: Record<string, { tools: McpTool[] }> = {};

    // Fetch tools in parallel, tolerate failures
    const results = await Promise.allSettled(
      allMcpIds.map(async (mcpId) => {
        const { tools } = await this.fetchToolsForMcp(
          mcpId,
          agentId,
          auth.tokenData,
          auth.token
        );
        return { mcpId, tools };
      })
    );

    for (const result of results) {
      if (result.status === "fulfilled" && result.value.tools.length > 0) {
        mcpServers[result.value.mcpId] = { tools: result.value.tools };
      }
    }

    return c.json({ mcpServers });
  }

  private async handleProxyRequest(c: Context): Promise<Response> {
    const mcpId = c.req.param("mcpId") || c.req.header("x-mcp-id");
    const sessionToken = extractSessionToken(c);

    logger.info("Handling MCP proxy request", {
      method: c.req.method,
      path: c.req.path,
      mcpId,
      hasSessionToken: !!sessionToken,
    });

    if (!mcpId) {
      return this.sendJsonRpcError(c, -32600, "Missing MCP ID");
    }

    if (!sessionToken) {
      return this.sendJsonRpcError(c, -32600, "Missing authentication token");
    }

    const tokenData = verifyWorkerToken(sessionToken);
    if (!tokenData) {
      return this.sendJsonRpcError(c, -32600, "Invalid authentication token");
    }

    const agentId = tokenData.agentId || tokenData.userId;
    const httpServer = await this.configService.getHttpServer(mcpId, agentId);

    if (!httpServer) {
      return this.sendJsonRpcError(
        c,
        -32601,
        `MCP server '${mcpId}' not found`
      );
    }

    // Pre-tool guardrails + tool approval for tools/call JSON-RPC requests.
    // Clone the request so the body can be read twice (once here, once in
    // forwardRequest). NOTE: this runs on any POST, NOT gated on grantStore —
    // guardrail enforcement must not depend on the approval subsystem being
    // configured (the approval check below is what's gated on grantStore).
    if (c.req.method === "POST") {
      try {
        const clonedReq = c.req.raw.clone();
        const bodyText = await clonedReq.text();
        if (bodyText) {
          const jsonRpc = JSON.parse(bodyText);
          if (Array.isArray(jsonRpc)) {
            if (jsonRpc.some((message) => message?.method === "tools/call")) {
              logger.warn(
                { mcpId, agentId },
                "Rejecting batched tools/call: guardrails and approval cannot be enforced on a JSON-RPC batch"
              );
              return this.sendJsonRpcError(
                c,
                -32600,
                "Batched tools/call is not permitted; send each tool call as a single JSON-RPC request."
              );
            }
          } else if (jsonRpc.method === "tools/call" && jsonRpc.params?.name) {
            const toolName = jsonRpc.params.name;
            const toolArgs = jsonRpc.params.arguments || {};

            // Pre-tool guardrails run before approval so a blocked tool never
            // enters the approval funnel, and independently of grantStore.
            if (
              await this.runPreToolGuardrails(
                agentId,
                tokenData,
                toolName,
                toolArgs
              )
            ) {
              return c.json({
                jsonrpc: "2.0",
                id: jsonRpc.id,
                result: {
                  content: [{ type: "text", text: "Tool call blocked by policy." }],
                  isError: true,
                },
              });
            }

            // Tool approval is gated on the approval subsystem (grantStore).
            if (this.grantStore) {
              const approval = await this.evaluateToolApproval(
                mcpId,
                toolName,
                toolArgs,
                agentId,
                tokenData,
                sessionToken
              );
              if (approval !== "allow") {
                return c.json({
                  jsonrpc: "2.0",
                  id: jsonRpc.id,
                  result: {
                    content: [
                      {
                        type: "text",
                        text: "Tool call requires approval. The user has been asked to approve. Your session will end. The result will arrive as your next message.",
                      },
                    ],
                    isError: true,
                  },
                });
              }
            }
          }
        }
      } catch {
        // If body parsing fails, just forward the request as-is
      }
    }

    const channelId = tokenData.channelId || "";
    const scopeKey = this.computeScopeKey(
      httpServer,
      tokenData.userId,
      channelId
    );

    try {
      return await this.forwardRequest(
        c,
        httpServer,
        agentId,
        mcpId,
        scopeKey,
        {
          userId: tokenData.userId,
          platform: tokenData.platform,
          channelId,
          conversationId: tokenData.conversationId || "",
          teamId: tokenData.teamId,
          connectionId: tokenData.connectionId,
          workerToken: sessionToken,
        }
      );
    } catch (error) {
      logger.error("Failed to proxy MCP request", { error, mcpId });
      return this.sendJsonRpcError(
        c,
        -32603,
        `Failed to connect to MCP '${mcpId}': ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  }

  /**
   * Run the agent's resolved pre-tool guardrails (built-in names + skill-
   * declared SKILL.md guardrails) for a `tools/call`. Returns true if a
   * guardrail tripped and the call must be blocked — the caller then returns a
   * generic, platform-shaped "blocked by policy" response (the specific reason
   * is never surfaced to the worker; that would be an evasion oracle).
   *
   * Shared by BOTH tool-call entrypoints — the JSON-RPC forward path
   * (`handleProxyRequest`) and the REST `handleCallTool` — so neither can
   * bypass the stage, and independent of `grantStore` so guardrails enforce
   * even when the approval subsystem isn't configured.
   *
   * Fails OPEN on store/registry-level errors (per-guardrail throws already
   * fail open in the runner); judge guardrails fail CLOSED by design.
   */
  private async runPreToolGuardrails(
    agentId: string,
    tokenData: {
      userId: string;
      conversationId?: string;
      organizationId?: string;
    },
    toolName: string,
    toolArgs: Record<string, unknown>
  ): Promise<boolean> {
    if (!this.guardrailRegistry || !this.agentSettingsStore) return false;
    try {
      const settings = await this.agentSettingsStore.getSettings(agentId);
      const resolved = resolveAgentGuardrails(
        settings ?? { guardrails: [] },
        (settings?.skillsConfig?.skills ?? []).filter((s) => s.enabled),
        this.guardrailRegistry
      );
      const list = resolved.byStage["pre-tool"];
      if (list.length === 0) return false;
      const outcome = await runGuardrailInstances("pre-tool", list, {
        agentId,
        userId: tokenData.userId,
        toolName,
        arguments: toolArgs,
        conversationId: tokenData.conversationId,
      });
      if (!outcome.tripped) return false;
      // Resolve org id with a metadata fallback — per-job tokens carry it, but
      // legacy deployment-lifetime tokens may not, and an unaudited trip is a
      // security log gap.
      let resolvedOrgId = tokenData.organizationId;
      if (!resolvedOrgId) {
        try {
          const md = await this.agentSettingsStore.getMetadata(agentId);
          resolvedOrgId = md?.organizationId;
        } catch (lookupErr) {
          logger.warn(
            {
              agentId,
              err:
                lookupErr instanceof Error
                  ? lookupErr.message
                  : String(lookupErr),
            },
            "Pre-tool guardrail trip: orgId metadata lookup failed (audit may be skipped)"
          );
        }
      }
      void recordGuardrailTrip({
        organizationId: resolvedOrgId,
        agentId,
        userId: tokenData.userId,
        conversationId: tokenData.conversationId,
        stage: "pre-tool",
        guardrail: outcome.tripped.guardrail,
        reason: outcome.tripped.reason,
        metadata: outcome.tripped.metadata,
      });
      logger.info(
        { agentId, toolName, guardrail: outcome.tripped.guardrail },
        "Pre-tool guardrail tripped — blocking tool call with generic policy message"
      );
      return true;
    } catch (err) {
      // Fail open on store/registry-level errors — the runner already
      // fail-opens on per-guardrail throws.
      logger.warn(
        {
          agentId,
          toolName,
          err: err instanceof Error ? err.message : String(err),
        },
        "Pre-tool guardrail check failed — proceeding without guardrails"
      );
      return false;
    }
  }

  /**
   * Shared tool-approval gate used by the REST (`handleCallTool`) and JSON-RPC
   * (`handleProxyRequest`) call paths. Resolves tool annotations, checks the
   * grant store, and — if blocked — stores the pending invocation and fires
   * `onToolBlocked`. Returns:
   * - `"allow"`: not blocked (no approval needed, or a grant exists);
   * - `"blocked-notified"`: blocked and the user was asked to approve;
   * - `"blocked-no-channel"`: blocked but no `onToolBlocked` handler is wired,
   *   so no approval card could be sent.
   */
  private async evaluateToolApproval(
    mcpId: string,
    toolName: string,
    toolArgs: Record<string, unknown>,
    agentId: string,
    tokenData: any,
    token: string
  ): Promise<"allow" | "blocked-notified" | "blocked-no-channel"> {
    if (!this.grantStore) return "allow";

    const { found, annotations } = await this.getToolAnnotations(
      mcpId,
      toolName,
      agentId,
      tokenData,
      token
    );
    // Fail closed: when tool annotations can't be fetched (upstream error,
    // SSRF block, timeout, etc.), `found` is false. The previous behaviour
    // returned "allow" here, which let destructive tools bypass approval
    // whenever discovery failed. Require approval unless we have annotations
    // that explicitly say the tool is safe.
    if (found && !requiresToolApproval(annotations)) return "allow";

    const pattern = `/mcp/${mcpId}/tools/${toolName}`;
    if (await this.grantStore.hasGrant(agentId, pattern)) return "allow";

    logger.info("Tool call blocked: requires approval", {
      agentId,
      mcpId,
      toolName,
      pattern,
    });

    if (!this.onToolBlocked) return "blocked-no-channel";

    const requestId = `ta_${randomUUID()}`;
    const originMessageId =
      typeof tokenData.messageId === "string" && tokenData.messageId.length > 0
        ? tokenData.messageId
        : undefined;
    const processedMessageIds = Array.isArray(tokenData.processedMessageIds)
      ? tokenData.processedMessageIds.filter(
          (id: unknown): id is string => typeof id === "string" && id.length > 0
        )
      : originMessageId
        ? [originMessageId]
        : undefined;
    await storePendingTool(
      requestId,
      {
        mcpId,
        toolName,
        args: toolArgs,
        agentId,
        userId: tokenData.userId,
        channelId: tokenData.channelId || "",
        conversationId: tokenData.conversationId || "",
        teamId: tokenData.teamId,
        connectionId: tokenData.connectionId,
        originMessageId,
        processedMessageIds,
      },
      this.PENDING_TOOL_TTL
    ).catch((err: unknown) =>
      logger.error(
        { requestId, error: String(err) },
        "Failed to store pending tool invocation"
      )
    );

    try {
      await this.onToolBlocked(
        requestId,
        agentId,
        tokenData.userId,
        mcpId,
        toolName,
        toolArgs,
        pattern,
        tokenData.channelId || "",
        tokenData.conversationId || "",
        tokenData.teamId,
        tokenData.connectionId,
        tokenData.platform,
        originMessageId,
        processedMessageIds
      );
    } catch (err) {
      logger.error(
        { requestId, error: String(err) },
        "onToolBlocked callback failed; approval notification was not delivered"
      );
      return "blocked-no-channel";
    }

    return "blocked-notified";
  }

  private async getToolAnnotations(
    mcpId: string,
    toolName: string,
    agentId: string,
    tokenData: any,
    workerToken?: string
  ): Promise<{ found: boolean; annotations?: McpTool["annotations"] }> {
    // Forward the worker JWT so internal MCPs (lobu-memory) can enumerate
    // tools — without it the discovery call goes unauthenticated and returns
    // an empty list, which would silently bypass the approval gate
    // (`found=false` means "no approval needed" at call sites). Tool discovery
    // performs its own filter-aware cache lookup after loading current config.
    const result = await this.fetchToolsForMcp(
      mcpId,
      agentId,
      tokenData,
      workerToken
    );
    const tools = result.tools;

    if (tools.length === 0) {
      return { found: false };
    }

    const tool = tools.find((t) => t.name === toolName);
    return { found: true, annotations: tool?.annotations };
  }

  private buildUpstreamHeaders(
    sessionId: string | null,
    configHeaders?: Record<string, string>,
    credentialToken?: string,
    internal?: boolean
  ): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      // MCP streamable-HTTP spec requires both — servers like DeepWiki reject
      // plain `application/json` with 406 Not Acceptable.
      Accept: "application/json, text/event-stream",
    };

    // Merge custom headers from server config (e.g. static auth tokens)
    if (configHeaders) {
      for (const [key, value] of Object.entries(configHeaders)) {
        headers[key] = value;
      }
    }

    // Per-user credential takes precedence over config headers for Authorization
    if (credentialToken) {
      headers.Authorization = `Bearer ${credentialToken}`;
    }

    // Stamp internal MCP requests so the embedded Lobu multi-tenant
    // middleware promotes the worker JWT to admin scope for this org.
    if (internal) {
      headers["X-Lobu-Memory-Direct-Auth"] = "1";
    }

    if (sessionId) {
      headers["Mcp-Session-Id"] = sessionId;
    }

    return headers;
  }

  private async resolveCredentialToken(
    agentId: string,
    userId: string,
    mcpId: string
  ): Promise<string | null> {
    const credential = await getStoredCredential(
      this.secretStore,
      agentId,
      userId,
      mcpId
    );
    if (!credential) {
      // No stored credential — check if there's a pending device-auth to complete
      return tryCompletePendingDeviceAuth(
        this.secretStore,
        agentId,
        userId,
        mcpId
      );
    }

    // Check if token is still valid (5 minute buffer)
    if (credential.expiresAt > Date.now() + 5 * 60 * 1000) {
      return credential.accessToken;
    }

    // Token expired or expiring soon — refresh
    const refreshed = await refreshCredential(
      this.secretStore,
      agentId,
      userId,
      mcpId,
      credential
    );
    return refreshed?.accessToken ?? null;
  }

  /**
   * Single egress point for non-streamed JSON-RPC calls to an MCP upstream.
   * Resolves the per-scope credential, runs the SSRF guard, and tracks the
   * upstream session id.
   */
  private async sendUpstreamRequest(
    httpServer: HttpMcpServerConfig,
    agentId: string,
    mcpId: string,
    method: string,
    body?: string,
    scopeKey?: string,
    directAuthToken?: string,
    extraHeaders?: Record<string, string>
  ): Promise<Response> {
    const sessionKey = this.buildSessionKey(agentId, mcpId, scopeKey);
    const sessionId = this.getSession(sessionKey);

    // Internal MCPs (lobu-memory) live in the same Lobu process and accept
    // the worker JWT directly; forcing a second OAuth login would block
    // unattended watcher runs. Non-internal MCPs use per-user credentials.
    let credentialToken: string | undefined;
    if (httpServer.internal) {
      credentialToken = directAuthToken;
    } else if (scopeKey) {
      const token = await this.resolveCredentialToken(agentId, scopeKey, mcpId);
      if (token) credentialToken = token;
    }

    const ssrfBlock = await this.ssrfBlockResponse(httpServer, mcpId, agentId);
    if (ssrfBlock) return ssrfBlock;

    const headers = this.buildUpstreamHeaders(
      sessionId,
      httpServer.headers,
      credentialToken,
      httpServer.internal === true
    );
    if (extraHeaders) {
      for (const [key, value] of Object.entries(extraHeaders)) {
        headers[key] = value;
      }
    }

    const response = await fetch(httpServer.upstreamUrl, {
      method,
      headers,
      body: body || undefined,
      signal: upstreamTimeoutSignal(method),
    });

    if (response.status === 401 && scopeKey && !httpServer.internal) {
      await response.body?.cancel().catch(() => {
        /* noop */
      });
      const refreshedToken = await this.refreshCredentialToken(
        agentId,
        scopeKey,
        mcpId
      );
      if (refreshedToken) {
        const retryHeaders = this.buildUpstreamHeaders(
          sessionId,
          httpServer.headers,
          refreshedToken,
          false
        );
        if (extraHeaders) {
          for (const [key, value] of Object.entries(extraHeaders)) {
            retryHeaders[key] = value;
          }
        }

        const retryResponse = await fetch(httpServer.upstreamUrl, {
          method,
          headers: retryHeaders,
          body: body || undefined,
          signal: upstreamTimeoutSignal(method),
        });
        const retrySessionId = retryResponse.headers.get("Mcp-Session-Id");
        if (retrySessionId) {
          this.setSession(sessionKey, retrySessionId);
        }
        return retryResponse;
      }
    }

    // Track session
    const newSessionId = response.headers.get("Mcp-Session-Id");
    if (newSessionId) {
      this.setSession(sessionKey, newSessionId);
    }

    return response;
  }

  private async refreshCredentialToken(
    agentId: string,
    scopeKey: string,
    mcpId: string
  ): Promise<string | null> {
    const credential = await getStoredCredential(
      this.secretStore,
      agentId,
      scopeKey,
      mcpId
    );
    if (!credential) return null;

    const refreshed = await refreshCredential(
      this.secretStore,
      agentId,
      scopeKey,
      mcpId,
      credential
    );
    return refreshed?.accessToken ?? null;
  }

  /**
   * SSRF guard: if the upstream URL resolves to an internal/reserved network
   * (and the server isn't an embedded internal MCP), log it and return a 403
   * JSON-RPC error response. Returns null when the request may proceed.
   */
  private async ssrfBlockResponse(
    httpServer: HttpMcpServerConfig,
    mcpId: string,
    agentId: string
  ): Promise<Response | null> {
    if (httpServer.internal || !(await isInternalUrl(httpServer.upstreamUrl))) {
      return null;
    }
    logger.warn("Blocked SSRF attempt to internal URL", {
      url: httpServer.upstreamUrl,
      mcpId,
      agentId,
    });
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32600,
          message: "Upstream URL resolves to a blocked internal network",
        },
      }),
      { status: 403, headers: { "Content-Type": "application/json" } }
    );
  }

  private async forwardRequest(
    c: Context,
    httpServer: HttpMcpServerConfig,
    agentId: string,
    mcpId: string,
    scopeKey?: string,
    authContext?: {
      userId: string;
      platform?: string;
      channelId: string;
      conversationId: string;
      teamId?: string;
      connectionId?: string;
      workerToken?: string;
    }
  ): Promise<Response> {
    const ssrfBlock = await this.ssrfBlockResponse(httpServer, mcpId, agentId);
    if (ssrfBlock) {
      return this.sendJsonRpcError(
        c,
        -32600,
        "Upstream URL resolves to a blocked internal network"
      );
    }

    const sessionKey = this.buildSessionKey(agentId, mcpId, scopeKey);
    let sessionId = this.getSession(sessionKey);
    const healthKey = this.buildServerHealthKey(agentId, mcpId);

    const bodyText = await this.getRequestBodyAsText(c);

    // Body size validation
    if (bodyText.length > MAX_BODY_SIZE) {
      logger.warn("Request body too large", {
        mcpId,
        agentId,
        size: bodyText.length,
      });
      return new Response("Request body too large", { status: 413 });
    }
    const forwardedToolName =
      c.req.method === "POST" ? toolNameFromJsonRpcToolCall(bodyText) : undefined;
    const toolCallStartedAt = Date.now();
    let forwardedToolCallObsCompleted = false;
    const emitForwardedToolCallCompleted = (
      status: "ok" | "failed",
      metadata: Record<string, unknown>,
      resultOrError?: unknown
    ) => {
      if (!forwardedToolName) return;
      if (forwardedToolCallObsCompleted) return;
      forwardedToolCallObsCompleted = true;
      const classification =
        status === "ok" ? "ok" : classifyMcpObsError(resultOrError);
      emitMcpObsEvent({
        trace: parseShifuTraceHeaders(c.req.raw.headers, "worker"),
        eventName: "lobu.mcp.tool_call.completed",
        status,
        stage: "lobu.mcp.tool_call",
        agentId,
        userId: authContext?.userId,
        mcpId,
        toolName: forwardedToolName,
        durationMs: Date.now() - toolCallStartedAt,
        metadata: {
          classification,
          ...metadata,
        },
      });
    };

    // Internal MCPs (lobu-memory) accept the worker JWT directly; forcing a
    // second OAuth login would block unattended watcher runs. Non-internal
    // MCPs use per-user credentials.
    let credentialToken: string | undefined;
    if (httpServer.internal) {
      credentialToken = authContext?.workerToken;
    } else if (scopeKey) {
      const token = await this.resolveCredentialToken(agentId, scopeKey, mcpId);
      if (token) credentialToken = token;
    }

    const pause = this.serverHealth.getPause(healthKey);
    if (pause) {
      logger.warn("MCP proxy request paused after repeated failures", {
        mcpId,
        agentId,
        pausedUntil: pause.pausedUntil,
        lastError: pause.lastError,
      });
      emitForwardedToolCallCompleted(
        "failed",
        {
          result_preview: resultPreviewFromValue({
            content: [],
            isError: true,
            diagnosticCode: "connector_unavailable",
          }),
          server_paused: true,
        },
        pause.lastError || "MCP server paused"
      );
      return this.sendJsonRpcError(
        c,
        -32000,
        `MCP server '${mcpId}' is temporarily paused after repeated failures.`
      );
    }

    // If no active session exists, re-initialize before forwarding
    if (!sessionId && c.req.method === "POST") {
      try {
        await this.reinitializeSession(httpServer, agentId, mcpId, scopeKey, credentialToken);
        sessionId = this.getSession(sessionKey);
      } catch (error) {
        logger.warn("Pre-emptive MCP re-initialization failed", {
          mcpId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    logger.info("Proxying MCP request", {
      mcpId,
      agentId,
      method: c.req.method,
      hasSession: !!sessionId,
      bodyLength: bodyText.length,
    });

    const headers = this.buildUpstreamHeaders(
      sessionId,
      httpServer.headers,
      credentialToken,
      httpServer.internal === true
    );

    let response: Response;
    try {
      response = await fetch(httpServer.upstreamUrl, {
        method: c.req.method,
        headers,
        body: bodyText || undefined,
        signal: upstreamTimeoutSignal(c.req.method),
      });
    } catch (error) {
      this.recordServerFailure(
        healthKey,
        mcpId,
        error,
        undefined,
        "proxy request"
      );
      emitForwardedToolCallCompleted(
        "failed",
        {
          result_preview: resultPreviewFromValue({
            content: [],
            isError: true,
            diagnosticCode: "connector_unavailable",
          }),
        },
        error
      );
      throw error;
    }

    // Detect HTTP 401 + WWW-Authenticate → start MCP OAuth 2.1 auth-code flow.
    if (response.status === 401 && authContext) {
      const payload = await this.handleUpstream401({
        response,
        mcpId,
        agentId,
        userId: authContext.userId,
        scopeKey: scopeKey ?? authContext.userId,
        httpServer,
        wwwAuthenticate: response.headers.get("www-authenticate"),
        platform: authContext.platform ?? "",
        channelId: authContext.channelId,
        conversationId: authContext.conversationId,
        teamId: authContext.teamId,
        connectionId: authContext.connectionId,
        deviceAuthFallback: false,
      });
      const finalPayload = payload ?? {
        status: "login_required" as const,
        message: `Authentication required for ${mcpId}.`,
      };
      emitForwardedToolCallCompleted(
        "failed",
        {
          http_status: response.status,
          result_preview: resultPreviewFromValue({
            content: [{ type: "text", text: JSON.stringify(finalPayload) }],
            isError: true,
          }),
        },
        new McpHttpStatusError(response.status, "MCP OAuth token required")
      );
      return c.json(
        {
          jsonrpc: "2.0",
          id: null,
          result: {
            content: [{ type: "text", text: JSON.stringify(finalPayload) }],
            isError: true,
          },
        },
        200
      );
    }

    // Stale-session recovery: if upstream returns 404 we sent a session id
    // it no longer recognizes (e.g. server restart). Drop the cached id,
    // re-init, and retry once with the same payload. Only meaningful for
    // POST — GET/DELETE on an unknown session should surface the 404 as-is.
    if (
      response.status === 404 &&
      sessionId &&
      c.req.method === "POST" &&
      bodyText
    ) {
      logger.info(
        "Upstream 404 on cached session id — re-initializing and retrying",
        { mcpId, agentId }
      );
      try {
        await this.reinitializeSession(httpServer, agentId, mcpId, scopeKey, credentialToken);
        sessionId = this.getSession(sessionKey);
        const retryHeaders = this.buildUpstreamHeaders(
          sessionId,
          httpServer.headers,
          credentialToken,
          httpServer.internal === true
        );
        try {
          response = await fetch(httpServer.upstreamUrl, {
            method: c.req.method,
            headers: retryHeaders,
            body: bodyText,
            // Retry path is POST-only (guarded above) — always bounded.
            signal: AbortSignal.timeout(UPSTREAM_FETCH_TIMEOUT_MS),
          });
        } catch (error) {
          this.recordServerFailure(
            healthKey,
            mcpId,
            error,
            undefined,
            "proxy request"
          );
          emitForwardedToolCallCompleted(
            "failed",
            {
              result_preview: resultPreviewFromValue({
                content: [],
                isError: true,
                diagnosticCode: "connector_unavailable",
              }),
              retry: true,
            },
            error
          );
          throw error;
        }
      } catch (error) {
        logger.warn("Stale-session recovery failed on forward", {
          mcpId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (response.ok) {
      this.serverHealth.recordSuccess(healthKey);
    } else if (!this.isAuthOrApprovalStatus(response.status)) {
      this.recordServerFailure(
        healthKey,
        mcpId,
        new McpHttpStatusError(response.status),
        response.status,
        "proxy request"
      );
    }

    const newSessionId = response.headers.get("Mcp-Session-Id");
    if (newSessionId) {
      this.setSession(sessionKey, newSessionId);
      logger.debug("Stored MCP session ID", {
        mcpId,
        agentId,
        sessionId: newSessionId,
      });
    }

    const responseHeaders = new Headers();
    const contentType = response.headers.get("content-type");
    if (contentType) {
      responseHeaders.set("Content-Type", contentType);
    }
    if (newSessionId) {
      responseHeaders.set("Mcp-Session-Id", newSessionId);
    }

    const forwardedToolCallInspection = forwardedToolName
      ? await inspectForwardedToolCallResponseForObs(response.clone())
      : null;
    const body = this.wrapStreamableResponseBody(
      response.body,
      mcpId,
      agentId
    );
    emitForwardedToolCallCompleted(
      forwardedToolCallInspection?.status ?? (response.ok ? "ok" : "failed"),
      forwardedToolCallInspection
        ? {
            http_status: response.status,
            ...forwardedToolCallInspection.metadata,
          }
        : {
            http_status: response.status,
            result_preview: {
              streamed_response: true,
              http_status: response.status,
            },
          },
      forwardedToolCallInspection?.resultOrError ??
        (response.ok ? undefined : new McpHttpStatusError(response.status))
    );

    return new Response(body, {
      status: response.status,
      headers: responseHeaders,
    });
  }

  private wrapStreamableResponseBody(
    body: ReadableStream<Uint8Array> | null,
    mcpId: string,
    agentId: string
  ): ReadableStream<Uint8Array> | null {
    if (!body || !this.toolCache) return body;

    const decoder = new TextDecoder();
    let rolling = "";
    let invalidated = false;
    const invalidate = () => {
      if (invalidated) return;
      invalidated = true;
      this.toolCache?.delete(mcpId, agentId);
      logger.info("Invalidated MCP tool cache after tools/list_changed", {
        mcpId,
        agentId,
      });
    };
    const inspect = (text: string) => {
      rolling = `${rolling}${text}`.slice(-8192);
      if (rolling.includes("notifications/tools/list_changed")) {
        invalidate();
      }
    };

    return body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          inspect(decoder.decode(chunk, { stream: true }));
          controller.enqueue(chunk);
        },
        flush() {
          inspect(decoder.decode());
        },
      })
    );
  }

  private async getRequestBodyAsText(c: Context): Promise<string> {
    if (c.req.method === "GET" || c.req.method === "HEAD") {
      return "";
    }

    try {
      return await c.req.text();
    } catch {
      return "";
    }
  }

  private buildServerHealthKey(agentId: string, mcpId: string): string {
    return `${agentId}:${mcpId}`;
  }

  private recordDiscoveryFailure(
    healthKey: string,
    mcpId: string,
    error: unknown,
    status?: number
  ): void {
    this.recordServerFailure(healthKey, mcpId, error, status, "discovery");
  }

  private recordServerFailure(
    healthKey: string,
    mcpId: string,
    error: unknown,
    status: number | undefined,
    operation: string
  ): void {
    if (status && this.isAuthOrApprovalStatus(status)) return;
    const snapshot = this.serverHealth.recordFailure(
      healthKey,
      error,
      Date.now(),
      status
    );
    if (snapshot.pausedUntil) {
      logger.warn("MCP server paused after repeated failures", {
        mcpId,
        operation,
        failures: snapshot.failures,
        pausedUntil: snapshot.pausedUntil,
        lastError: snapshot.lastError,
      });
    }
  }

  private statusFromError(error: unknown): number | undefined {
    if (error instanceof McpDiscoveryAuthError) {
      return error.diagnosticCode === "upstream_unauthorized" ? 401 : 403;
    }
    return error instanceof McpHttpStatusError ? error.status : undefined;
  }

  private isAuthOrApprovalStatus(status: number): boolean {
    return status === 401 || status === 403;
  }

  private isAuthStyleToolError(message: string): boolean {
    return /unauthorized|unauthenticated|forbidden/i.test(message);
  }

  private authDiagnosticCodeFromMessage(
    message: string
  ): "upstream_unauthorized" | "upstream_forbidden" {
    return /forbidden/i.test(message)
      ? "upstream_forbidden"
      : "upstream_unauthorized";
  }

  /** Send the MCP `initialize` request to an upstream and return the raw response. */
  private async sendInitialize(
    httpServer: HttpMcpServerConfig,
    agentId: string,
    mcpId: string,
    scopeKey?: string,
    directAuthToken?: string
  ): Promise<Response> {
    return this.sendUpstreamRequest(
      httpServer,
      agentId,
      mcpId,
      "POST",
      INITIALIZE_BODY,
      scopeKey,
      directAuthToken
    );
  }

  /** Send the MCP `notifications/initialized` notification (best-effort). */
  private async sendInitializedNotification(
    httpServer: HttpMcpServerConfig,
    agentId: string,
    mcpId: string,
    scopeKey?: string,
    directAuthToken?: string
  ): Promise<void> {
    await this.sendUpstreamRequest(
      httpServer,
      agentId,
      mcpId,
      "POST",
      INITIALIZED_NOTIFICATION_BODY,
      scopeKey,
      directAuthToken
    ).catch(() => {
      /* noop */
    });
  }

  /**
   * Re-initialize an MCP session by sending initialize + notifications/initialized.
   * Called when upstream returns "Server not initialized" (stale session).
   */
  private async reinitializeSession(
    httpServer: HttpMcpServerConfig,
    agentId: string,
    mcpId: string,
    scopeKey?: string,
    directAuthToken?: string
  ): Promise<void> {
    // Clear stale session
    this.deleteSession(this.buildSessionKey(agentId, mcpId, scopeKey));

    const initResponse = await this.sendInitialize(
      httpServer,
      agentId,
      mcpId,
      scopeKey,
      directAuthToken
    );
    await initResponse.text(); // consume response (may be JSON or SSE-framed)

    await this.sendInitializedNotification(
      httpServer,
      agentId,
      mcpId,
      scopeKey,
      directAuthToken
    );

    logger.info("Re-initialized MCP session", { mcpId, agentId });
  }

  /**
   * Handle an HTTP 401 from an MCP upstream: drain the response body, attempt
   * the OAuth 2.1 auth-code flow (RFC 9728 → 8414 → 7591 discovery), and —
   * when `deviceAuthFallback` is set — fall back to the legacy device-code
   * flow. Fires `onAuthRequired` with whichever payload succeeds and returns
   * it (or null when no flow could be started).
   */
  private async handleUpstream401(params: {
    response?: Response;
    mcpId: string;
    agentId: string;
    userId: string;
    scopeKey: string;
    httpServer: HttpMcpServerConfig;
    wwwAuthenticate: string | null;
    platform?: string;
    channelId: string;
    conversationId: string;
    teamId?: string;
    connectionId?: string;
    deviceAuthFallback: boolean;
  }): Promise<AuthRequiredPayload | null> {
    // Drain the body so the connection can be reused.
    await params.response?.body?.cancel().catch(() => {
      /* noop */
    });

    const fire = async (payload: AuthRequiredPayload) => {
      await this.fireAuthRequired(
        params.agentId,
        params.userId,
        params.mcpId,
        payload,
        params.channelId,
        params.conversationId,
        params.teamId,
        params.connectionId,
        params.platform
      );
      return payload;
    };

    const authCodeResult = await this.tryAutoAuthCodeFlow({
      mcpId: params.mcpId,
      agentId: params.agentId,
      userId: params.userId,
      scopeKey: params.scopeKey,
      httpServer: params.httpServer,
      wwwAuthenticate: params.wwwAuthenticate,
      platform: params.platform ?? "",
      channelId: params.channelId,
      conversationId: params.conversationId,
      teamId: params.teamId,
      connectionId: params.connectionId,
    });
    if (authCodeResult) return fire(authCodeResult);

    if (params.deviceAuthFallback) {
      const legacyAuth = await this.tryAutoDeviceAuth(
        params.mcpId,
        params.agentId,
        params.scopeKey
      );
      if (legacyAuth) return fire(legacyAuth);
    }

    return null;
  }

  /** Invoke `onAuthRequired` (if wired), swallowing/logging callback errors. */
  private async fireAuthRequired(
    agentId: string,
    userId: string,
    mcpId: string,
    payload: AuthRequiredPayload,
    channelId: string,
    conversationId: string,
    teamId: string | undefined,
    connectionId: string | undefined,
    platform: string | undefined
  ): Promise<void> {
    if (!this.onAuthRequired) return;
    await this.onAuthRequired(
      agentId,
      userId,
      mcpId,
      payload,
      channelId,
      conversationId,
      teamId,
      connectionId,
      platform
    ).catch((err) =>
      logger.error({ mcpId, error: String(err) }, "onAuthRequired callback failed")
    );
  }

  /**
   * Shared helper: on 401 during tool discovery, start the OAuth auth-code
   * flow and surface the "Connect X" link to the user via onAuthRequired.
   * Silently noops on failure — caller already degrades to `{ tools: [] }`.
   */
  private async fireAuthCodeFlowFromDiscovery(params: {
    mcpId: string;
    agentId: string;
    httpServer: HttpMcpServerConfig;
    wwwAuthenticate: string | null;
    scopeKey: string;
    tokenData: any;
  }): Promise<void> {
    const { mcpId, agentId, httpServer, wwwAuthenticate, scopeKey, tokenData } =
      params;
    await this.handleUpstream401({
      mcpId,
      agentId,
      userId: tokenData?.userId || scopeKey,
      scopeKey,
      httpServer,
      wwwAuthenticate,
      platform: tokenData?.platform,
      channelId: tokenData?.channelId || "",
      conversationId: tokenData?.conversationId || "",
      teamId: tokenData?.teamId,
      connectionId: tokenData?.connectionId,
      deviceAuthFallback: false,
    });
  }

  /**
   * Compute the credential scope key from the server config + request context.
   * Returns `channel-<channelId>` when `authScope === "channel"` (and channelId
   * is present), otherwise `userId` for per-user scope.
   */
  private computeScopeKey(
    httpServer: HttpMcpServerConfig,
    userId: string,
    channelId: string | undefined
  ): string {
    if (httpServer.authScope === "channel" && channelId) {
      return `channel-${channelId}`;
    }
    return userId;
  }

  /**
   * Build a session-store key for the upstream Mcp-Session-Id associated
   * with a specific (org, agent, mcp, scope) tuple. The session store is a
   * process-wide Map, and agentId is NOT globally unique, so the org scope
   * prevents two tenants with the same agentId+mcpId from sharing upstream
   * session handles. Scoping by scopeKey additionally prevents two users
   * (or user-vs-channel credentials) within an org from sharing a single
   * upstream session.
   */
  private buildSessionKey(
    agentId: string,
    mcpId: string,
    scopeKey?: string
  ): string {
    return buildMcpSessionKey(agentId, mcpId, scopeKey);
  }

  /**
   * Auto-start MCP OAuth 2.1 authorization-code + PKCE flow when an upstream
   * returns 401. Uses WWW-Authenticate header to walk the RFC 9728 → 8414 →
   * 7591 discovery chain. Returns a payload for `onAuthRequired`, or null on
   * failure (caller should fall back to device-auth).
   */
  private async tryAutoAuthCodeFlow(params: {
    mcpId: string;
    agentId: string;
    userId: string;
    scopeKey: string;
    httpServer: HttpMcpServerConfig;
    wwwAuthenticate: string | null;
    platform: string;
    channelId: string;
    conversationId: string;
    teamId?: string;
    connectionId?: string;
  }): Promise<{
    status: "login_required";
    url: string;
    message: string;
  } | null> {
    if (!this.publicGatewayUrl) {
      logger.warn("Auth-code flow skipped: publicGatewayUrl not configured", {
        mcpId: params.mcpId,
      });
      return null;
    }

    try {
      const redirectUri = `${this.publicGatewayUrl.replace(/\/+$/, "")}/mcp/oauth/callback`;
      const { authorizationUrl } = await startAuthCodeFlow({
        secretStore: this.secretStore,
        mcpId: params.mcpId,
        upstreamUrl: params.httpServer.upstreamUrl,
        agentId: params.agentId,
        userId: params.userId,
        scopeKey: params.scopeKey,
        wwwAuthenticate: params.wwwAuthenticate,
        redirectUri,
        staticOauth: params.httpServer.oauth,
        platform: params.platform,
        channelId: params.channelId,
        conversationId: params.conversationId,
        teamId: params.teamId,
        connectionId: params.connectionId,
      });
      return {
        status: "login_required",
        url: authorizationUrl,
        message:
          "Authentication is required. STOP calling tools and show the user this login link. Do NOT retry this tool call — wait for the user to complete login in their browser first.",
      };
    } catch (error) {
      logger.warn("Auto auth-code flow failed", {
        mcpId: params.mcpId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Auto-start device-code auth when an MCP upstream returns an auth error.
   * Returns a user-facing message with the verification URL, or null on failure.
   */
  private async tryAutoDeviceAuth(
    mcpId: string,
    agentId: string,
    scopeKey: string
  ): Promise<AuthRequiredPayload | null> {
    try {
      // Existing-flow detection now happens inside startDeviceAuth — it
      // reuses any non-expired pending flow already persisted in the secret
      // store and returns it instead of restarting.
      const result = await startDeviceAuth(
        this.secretStore,
        this.configService as any,
        mcpId,
        agentId,
        scopeKey
      );
      if (!result) return null;
      const url = result.verificationUriComplete || result.verificationUri;
      return {
        status: "login_required",
        url,
        userCode: result.userCode,
        message:
          "Authentication is required. STOP calling tools and show the user this login link and code. Do NOT retry this tool call — wait for the user to complete login first.",
        expiresInSeconds: result.expiresIn,
      };
    } catch (error) {
      logger.warn("Auto device-auth failed", {
        mcpId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private getSession(key: string): string | null {
    const entry = this.sessions.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.sessions.delete(key);
      return null;
    }
    // Refresh TTL on read.
    entry.expiresAt = Date.now() + this.SESSION_TTL_SECONDS * 1000;
    return entry.sessionId;
  }

  private setSession(key: string, sessionId: string): void {
    this.sessions.set(key, {
      sessionId,
      expiresAt: Date.now() + this.SESSION_TTL_SECONDS * 1000,
    });
  }

  private deleteSession(key: string): void {
    this.sessions.delete(key);
  }

  private sendJsonRpcError(
    c: Context,
    code: number,
    message: string,
    id: any = null
  ): Response {
    return c.json(
      {
        jsonrpc: "2.0",
        id,
        error: { code, message },
      },
      200
    );
  }
}
