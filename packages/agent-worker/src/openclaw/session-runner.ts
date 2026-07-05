/**
 * session-runner.ts — extracted runAISession orchestration.
 *
 * This module contains the core AI session run logic, extracted from
 * OpenClawWorker to keep worker.ts focused on lifecycle (execute/cleanup/
 * transport). All behaviour, event handling, heartbeat, memory-flush, and
 * plugin-hook ordering is identical to the original implementation.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  createLogger,
  emitAgentObsEvent,
  getOptionalEnv,
  type McpStatus,
  type McpToolDef,
  type PluginsConfig,
  type ToolsConfig,
} from "@lobu/core";
import { getModel, type ImageContent } from "@mariozechner/pi-ai";
import {
  AuthStorage,
  DefaultResourceLoader,
  ModelRegistry,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import type { ProgressUpdate, SessionExecutionResult } from "../core/types";
import type { GatewayParams } from "../shared/tool-implementations";
import { createExecutionReporter } from "./execution-reporter";
import { getApiKeyEnvVarForProvider } from "../shared/provider-auth-hints";
import { emitJourneyObservabilityEvent } from "../shared/journey-observability";
import { isRecord } from "../shared/type-guards";
import {
  emitJourneyEvent,
  parseWorkerShifuTrace,
  type JourneyTraceStatus,
  type WorkerShifuTraceContext,
} from "../shared/journey-trace";
import {
  createMcpAuthToolDefinitions,
  createMcpToolDefinitions,
  createOpenClawCustomTools,
} from "./custom-tools";
import { TurnController, wrapToolsWithTurnGuard } from "./turn-controller";
import {
  buildDynamicOpenAIModel,
  buildProviderProxyAuthHeaders,
  DEFAULT_PROVIDER_BASE_URL_ENV,
  openOrCreateSessionManager,
  PROVIDER_REGISTRY_ALIASES,
  registerDynamicProvider,
  resolveModelRef,
} from "./model-resolver";
import {
  applyCapabilityLimitNotes,
  buildMcpAuthToolNames,
  type McpAuthToolNames,
  projectMcpToolsForProvider,
  projectToolParametersForProvider,
  requiresProviderSafeToolNames,
} from "./mcp-tool-projection";
import {
  loadPlugins,
  runPluginHooks,
  startPluginServices,
  stopPluginServices,
  wrapToolsWithPluginToolHooks,
} from "./plugin-loader";
import type { OpenClawProgressProcessor } from "./processor";
import { buildAgentSession } from "./session-builder";
import { getOpenClawSessionContext } from "./session-context";
import {
  buildToolPolicy,
  enforceBashCommandPolicy,
  isToolAllowedByPolicy,
} from "./tool-policy";
import { buildToolUseEventPayload } from "./tool-use-events";
import { createOpenClawTools } from "./tools";
import { clearSnapshots, hydrateFromSnapshot } from "./transcript-snapshot";
const logger = createLogger("worker");

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface ResolvedMemoryFlushConfig {
  enabled: boolean;
  softThresholdTokens: number;
  systemPrompt: string;
  prompt: string;
}

// ---------------------------------------------------------------------------
// Memory-flush / compaction utilities
// (also used by OpenClawWorker.maybeRunPreCompactionMemoryFlush in worker.ts)
// ---------------------------------------------------------------------------

export const MEMORY_FLUSH_STATE_CUSTOM_TYPE = "lobu.memory_flush_state";
const APPROX_IMAGE_TOKENS = 1200;

export function findDuplicateToolNames(
  tools: Array<{ name?: string }>
): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const tool of tools) {
    const name = typeof tool.name === "string" ? tool.name.trim() : "";
    if (!name) {
      continue;
    }
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .filter(([, count]) => count > 1)
    .map(([name, count]) => ({ name, count }));
}

const DEFAULT_MEMORY_FLUSH_CONFIG: ResolvedMemoryFlushConfig = {
  enabled: true,
  softThresholdTokens: 4000,
  systemPrompt: "Session nearing compaction. Store durable memories now.",
  prompt:
    "Write any lasting notes to memory using available memory tools. Reply with NO_REPLY if nothing to store.",
};
const GEMINI_DIRECT_MCP_TOOL_LIMIT = 24;
const DEFAULT_DIRECT_MCP_TOOL_LIMIT = 64;

function readStringOrFallback(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return fallback;
  }
  return trimmed;
}

function readNonNegativeNumberOrFallback(
  value: unknown,
  fallback: number
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return value;
}

function readOptionalNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.floor(value);
}

function readConfiguredDirectMcpToolLimit(
  rawOptions: Record<string, unknown>
): number | undefined {
  const toolsConfig = isRecord(rawOptions.toolsConfig)
    ? rawOptions.toolsConfig
    : undefined;
  return (
    readOptionalNonNegativeInteger(toolsConfig?.mcpDirectToolLimit) ??
    readOptionalNonNegativeInteger(toolsConfig?.directToolLimit) ??
    readOptionalNonNegativeInteger(rawOptions.mcpDirectToolLimit)
  );
}

function resolveProviderDirectMcpToolLimit(
  rawProvider: string,
  provider: string,
  configuredLimit: number | undefined
): number {
  const isGemini =
    rawProvider.toLowerCase() === "gemini" ||
    provider.toLowerCase() === "gemini" ||
    rawProvider.toLowerCase() === "google" ||
    provider.toLowerCase() === "google";
  if (isGemini) {
    return Math.min(
      configuredLimit ?? GEMINI_DIRECT_MCP_TOOL_LIMIT,
      GEMINI_DIRECT_MCP_TOOL_LIMIT
    );
  }
  return configuredLimit ?? DEFAULT_DIRECT_MCP_TOOL_LIMIT;
}

function toSafeMcpToolAlias(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, "_").replace(/_+/g, "_");
}

function removeInstructionSection(
  instructions: string,
  heading: string
): string {
  const lines = instructions.split("\n");
  const kept: string[] = [];
  let skippingSection = false;

  for (const line of lines) {
    if (line.trim() === heading) {
      skippingSection = true;
      continue;
    }
    if (skippingSection && line.startsWith("## ")) {
      skippingSection = false;
    }
    if (!skippingSection) {
      kept.push(line);
    }
  }

  return kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildProjectedMcpToolInventoryInstructions(
  mcpTools: Record<string, McpToolDef[]>,
  mcpStatus: McpStatus[]
): string {
  const entries = Object.entries(mcpTools)
    .map(([mcpId, tools]) => {
      const toolNames = tools
        .map((tool) => tool.name?.trim())
        .filter((name): name is string => Boolean(name));
      if (toolNames.length === 0) return null;
      const displayName = mcpStatus.find((mcp) => mcp.id === mcpId)?.name;
      const label = displayName ? `${displayName} (${mcpId})` : mcpId;
      const renderedTools = toolNames.map((name) => {
        const alias = toSafeMcpToolAlias(name);
        return alias === name
          ? `\`${name}\``
          : `\`${name}\` (alias \`${alias}\`)`;
      });
      return `- ${label}: ${renderedTools.join(", ")}`;
    })
    .filter((entry): entry is string => Boolean(entry));

  if (entries.length === 0) return "";

  return [
    "## Available MCP Tools",
    "These provider-safe MCP tools are registered as first-class tools. Use only the exact tool names below; omitted or quarantined MCP tools are not registered for this run.",
    ...entries,
  ].join("\n");
}

function replaceMcpToolInventoryInstructions(
  instructions: string,
  mcpTools: Record<string, McpToolDef[]>,
  mcpStatus: McpStatus[]
): string {
  return [
    removeInstructionSection(instructions, "## Available MCP Tools"),
    buildProjectedMcpToolInventoryInstructions(mcpTools, mcpStatus),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildMcpAuthToolNameMap(
  mcpStatus: McpStatus[],
  reservedNames: Set<string>,
  providerSafeNames: boolean
): Record<string, McpAuthToolNames> {
  const names: Record<string, McpAuthToolNames> = {};
  const reserved = new Set(reservedNames);
  for (const mcp of mcpStatus) {
    if (!mcp.requiresAuth) continue;
    names[mcp.id] = buildMcpAuthToolNames(mcp.id, {
      providerSafeNames,
      reservedNames: reserved,
    });
  }
  return names;
}

function buildProjectedMcpSetupInstructions(
  mcpStatus: McpStatus[],
  mcpTools: Record<string, McpToolDef[]>,
  authToolNames: Record<string, McpAuthToolNames>
): string {
  if (!mcpStatus || mcpStatus.length === 0) {
    return "";
  }

  const mcpToolIds = new Set(Object.keys(mcpTools));
  const needsAuthentication = mcpStatus.filter(
    (mcp) => mcp.requiresAuth && !mcp.authenticated
  );
  const needsConfiguration = mcpStatus.filter(
    (mcp) => mcp.requiresInput && !mcp.configured
  );
  const undiscoveredMcps = mcpStatus.filter((mcp) => !mcpToolIds.has(mcp.id));

  if (
    needsAuthentication.length === 0 &&
    needsConfiguration.length === 0 &&
    undiscoveredMcps.length === 0
  ) {
    return "";
  }

  const lines: string[] = ["## MCP Tools Requiring Setup"];

  for (const mcp of needsAuthentication) {
    const names = authToolNames[mcp.id] ?? buildMcpAuthToolNames(mcp.id);
    lines.push(
      `- ⚠️ **${mcp.name}** (id: ${mcp.id}): Authentication is required. To start login, call \`${names.login}\`. After the user completes login, call \`${names.loginCheck}\`. Newly available MCP tools will refresh on the next message.`
    );
  }

  for (const mcp of needsConfiguration) {
    lines.push(
      `- ⚠️ **${mcp.name}** (id: ${mcp.id}): Additional MCP input is required before this server can be used. Tell the user an admin must configure the MCP inputs in settings.`
    );
  }

  for (const mcp of undiscoveredMcps) {
    if (mcp.requiresAuth || mcp.requiresInput) continue;
    lines.push(
      `- ⚠️ **${mcp.name}** (id: ${mcp.id}): No tools were discovered for this MCP in the current session. Do not assume a login tool exists unless it is actually registered.`
    );
  }

  return lines.join("\n");
}

function replaceMcpSetupInstructions(
  instructions: string,
  mcpStatus: McpStatus[],
  mcpTools: Record<string, McpToolDef[]>,
  authToolNames: Record<string, McpAuthToolNames>
): string {
  return [
    removeInstructionSection(instructions, "## MCP Tools Requiring Setup"),
    buildProjectedMcpSetupInstructions(mcpStatus, mcpTools, authToolNames),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function resolveMemoryFlushConfig(
  rawOptions: Record<string, unknown>
): ResolvedMemoryFlushConfig {
  const compaction = isRecord(rawOptions.compaction)
    ? rawOptions.compaction
    : undefined;
  const memoryFlush =
    compaction && isRecord(compaction.memoryFlush)
      ? compaction.memoryFlush
      : undefined;

  return {
    enabled:
      typeof memoryFlush?.enabled === "boolean"
        ? memoryFlush.enabled
        : DEFAULT_MEMORY_FLUSH_CONFIG.enabled,
    softThresholdTokens: readNonNegativeNumberOrFallback(
      memoryFlush?.softThresholdTokens,
      DEFAULT_MEMORY_FLUSH_CONFIG.softThresholdTokens
    ),
    systemPrompt: readStringOrFallback(
      memoryFlush?.systemPrompt,
      DEFAULT_MEMORY_FLUSH_CONFIG.systemPrompt
    ),
    prompt: readStringOrFallback(
      memoryFlush?.prompt,
      DEFAULT_MEMORY_FLUSH_CONFIG.prompt
    ),
  };
}

export function estimatePromptTokenCost(
  promptText: string,
  imageCount: number
): number {
  const textTokens = Math.ceil(promptText.length / 4);
  const imageTokens = Math.max(0, imageCount) * APPROX_IMAGE_TOKENS;
  return textTokens + imageTokens;
}

export function countCompactionsOnCurrentBranch(
  sessionManager: Awaited<ReturnType<typeof openOrCreateSessionManager>>
): number {
  const branch = sessionManager.getBranch();
  return branch.reduce((count, entry) => {
    if (entry.type === "compaction") {
      return count + 1;
    }
    return count;
  }, 0);
}

export function readLastFlushedCompactionCount(
  sessionManager: Awaited<ReturnType<typeof openOrCreateSessionManager>>
): number | null {
  const branch = sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (!entry) continue;
    if (entry.type !== "custom") continue;
    if (entry.customType !== MEMORY_FLUSH_STATE_CUSTOM_TYPE) continue;
    if (!isRecord(entry.data)) continue;
    const compactionCount = entry.data.compactionCount;
    if (
      typeof compactionCount === "number" &&
      Number.isFinite(compactionCount) &&
      compactionCount >= 0
    ) {
      return compactionCount;
    }
  }
  return null;
}

export function getLatestAssistantText(
  messages: unknown[]
): { text: string; normalizedNoReply: boolean } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!isRecord(message) || message.role !== "assistant") continue;
    const content = message.content;

    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .flatMap((block) => {
          if (!isRecord(block)) return [];
          if (block.type !== "text") return [];
          return typeof block.text === "string" ? [block.text] : [];
        })
        .join("");
    }

    const normalized = text.trim().toUpperCase();
    return {
      text,
      normalizedNoReply: normalized === "NO_REPLY",
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// System-prompt identity replacement
// ---------------------------------------------------------------------------

/**
 * Pi-coding-agent's buildSystemPrompt() (in `@mariozechner/pi-coding-agent`)
 * always opens the system prompt with this exact sentence. Lobu agents can
 * override their identity via IDENTITY.md, but unless we strip out this
 * opener the model sees two competing role declarations and tends to favour
 * "expert coding assistant" because it appears first.
 *
 * This helper substitutes the opener with the agent's identity and keeps the
 * rest of the base prompt (tools list, guidelines, docs paths, cwd) intact.
 *
 * If the upstream package ever changes the opener wording, this becomes a
 * no-op and `replaced === original`. In that case we fall back to prepending
 * the identity with a small framing note so identity still wins ordering.
 */
const PI_CODING_AGENT_OPENER_RE =
  /^You are an expert coding assistant operating inside pi, a coding agent harness\.[^\n]*/;

export function replaceBasePromptIdentity(
  basePrompt: string,
  identity: string
): string {
  if (PI_CODING_AGENT_OPENER_RE.test(basePrompt)) {
    return basePrompt.replace(PI_CODING_AGENT_OPENER_RE, identity);
  }
  // Upstream wording drifted — prepend identity with a framing note rather
  // than silently letting the upstream opener win.
  return `${identity}\n\nThe section below describes the runtime tooling available to you. It does not change your role.\n\n${basePrompt}`;
}

export function buildLobuSystemPrompt(
  basePrompt: string | undefined,
  agentInstructions: string | undefined,
  finalInstructions: string | undefined
): string {
  const base = basePrompt || "";
  const identity = agentInstructions?.trim();
  const extra = finalInstructions?.trim();
  const promptWithIdentity = identity
    ? replaceBasePromptIdentity(base, identity)
    : base;

  return [promptWithIdentity, extra].filter(Boolean).join("\n\n---\n\n");
}

// ---------------------------------------------------------------------------
// LOBU memory plugin helper — inject agentId into config
// ---------------------------------------------------------------------------

const LOBU_MEMORY_PLUGIN_SOURCE = "@lobu/openclaw-plugin";

/**
 * Inject the bound agentId into the Lobu memory plugin's config so its
 * autoCapture path stamps `metadata.agent_id` on save_memory calls. Other
 * plugins are passed through unchanged. Returns a new PluginsConfig — does
 * not mutate input.
 */
function injectAgentIdIntoLobuPlugin(
  pluginsConfig: PluginsConfig | undefined,
  agentId: string | undefined
): PluginsConfig | undefined {
  if (!pluginsConfig?.plugins?.length || !agentId) return pluginsConfig;
  const plugins = pluginsConfig.plugins.map((plugin) => {
    if (plugin.source !== LOBU_MEMORY_PLUGIN_SOURCE) return plugin;
    return {
      ...plugin,
      config: {
        ...plugin.config,
        agentId,
      },
    };
  });
  return { ...pluginsConfig, plugins };
}

// ---------------------------------------------------------------------------
// URL helper (only needed inside runAISession)
// ---------------------------------------------------------------------------

/**
 * Returns true iff the given URL points at OpenAI's real API host.
 * Uses URL parsing + exact host match so spoofed hosts like
 * `https://api.openai.com.evil.example/v1` are not mistaken for real OpenAI.
 */
function isRealOpenAIBaseUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).host.toLowerCase() === "api.openai.com";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Params interface
// ---------------------------------------------------------------------------

export interface RunAISessionParams {
  // Inputs from the caller
  userPrompt: string;
  customInstructions: string;
  onProgress: (update: ProgressUpdate) => Promise<void>;

  // Worker config fields needed by the session
  agentOptions: string;
  sessionKey: string;
  channelId: string;
  conversationId: string;
  messageId?: string;
  platform: string;
  /** Arbitrary platform-level metadata (e.g. { sessionReset: true, files: [...] }). */
  platformMetadata: unknown;
  agentId: string | undefined;
  /**
   * Per-run worker JWT minted by the gateway for this message. Internal
   * gateway calls made by first-class tools must use this token instead of
   * the deployment-lifetime WORKER_TOKEN so worker-auth can resolve the
   * current agent/user/run context.
   */
  runJobToken?: string;

  // Resolved workspace directory (from WorkspaceManager)
  workspaceDir: string;

  // Progress processor (class-owned state; passed by reference)
  progressProcessor: OpenClawProgressProcessor;

  // Callbacks back into OpenClawWorker for class-level state mutations
  /**
   * Called once the session file path has been determined so the worker can
   * capture it for cleanup()/snapshot writing.
   */
  onSessionFilePathResolved: (sessionFilePath: string) => void;
  /**
   * Called as soon as the model ref is resolved to a (provider, modelId) pair
   * so the worker can tag Sentry captures with which provider/model a later
   * failure belongs to. Fires before any provider call can fail.
   */
  onModelResolved: (provider: string, modelId: string) => void;

  // Methods delegated from OpenClawWorker (kept on the class; passed here as
  // plain function references so the class can share them with tests without
  // also exposing the full worker instance to this module).
  loadImageAttachments: () => Promise<ImageContent[]>;
  maybeRunPreCompactionMemoryFlush: (params: {
    session: Awaited<ReturnType<typeof buildAgentSession>>["session"];
    sessionManager: Awaited<ReturnType<typeof openOrCreateSessionManager>>;
    settingsManager: SettingsManager;
    memoryFlushConfig: ReturnType<typeof resolveMemoryFlushConfig>;
    incomingPromptText: string;
    incomingImageCount: number;
    runSilentPrompt: (prompt: string) => Promise<void>;
  }) => Promise<void>;
  maybeBuildAuthHintMessage: (
    errorMessage: string,
    provider: string,
    modelId: string
  ) => string;
}

export function resolveGatewayWorkerToken(
  runJobToken: string | undefined,
  envWorkerToken: string
): string {
  return runJobToken && runJobToken.length > 0 ? runJobToken : envWorkerToken;
}

function obsTraceMetadata(trace: WorkerShifuTraceContext) {
  return {
    journey_id: trace.journeyId,
    parent_span_id: trace.parentSpanId,
    trace_source: trace.traceSource,
  };
}

function emitWorkerObsEvent(input: {
  trace: WorkerShifuTraceContext;
  conversationId?: string;
  agentId?: string;
  userId?: string;
  eventName: string;
  status: "started" | "ok" | "failed" | string;
  stage: string;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}): void {
  void emitAgentObsEvent({
    traceId: input.trace.traceId,
    turnId: input.trace.turnId,
    conversationId: input.conversationId,
    agentId: input.agentId,
    userId: input.userId,
    toolboxUserId: input.userId,
    eventName: input.eventName,
    status: input.status,
    stage: input.stage,
    durationMs: input.durationMs,
    metadata: {
      ...obsTraceMetadata(input.trace),
      module: "agent-worker",
      ...input.metadata,
    },
  });
}

function emitWorkerJourneyObsEvent(input: {
  trace: WorkerShifuTraceContext;
  conversationId?: string;
  agentId?: string;
  userId?: string;
  event: string;
  status: JourneyTraceStatus;
  durationMs?: number;
  fields?: Record<string, unknown>;
}): void {
  void emitJourneyObservabilityEvent({
    trace: input.trace,
    module: "agent-worker",
    event: input.event,
    status: normalizeJourneyTraceStatus(input.status),
    fields: {
      ...(input.conversationId
        ? { conversation: { id: input.conversationId } }
        : {}),
      ...(input.agentId ? { agent: { id: input.agentId } } : {}),
      ...(input.userId ? { toolbox: { user_id: input.userId } } : {}),
      ...(input.durationMs !== undefined
        ? { duration_ms: input.durationMs }
        : {}),
      ...input.fields,
    },
  });
}

function normalizeJourneyTraceStatus(status: string): JourneyTraceStatus {
  switch (status) {
    case "started":
    case "ok":
    case "skipped":
    case "failed":
    case "timeout":
    case "blocked":
    case "degraded":
      return status;
    case "completed":
      return "ok";
    case "running":
    case "waiting_for_tool":
      return "started";
    default:
      return "degraded";
  }
}

export function emitWorkerToolsRegisteredObsEvent(input: {
  trace: WorkerShifuTraceContext;
  conversationId?: string;
  agentId?: string;
  userId?: string;
  toolCount: number;
  mcpToolCount: number;
  authToolCount: number;
  pluginToolCount: number;
  mcpIds: string[];
}): void {
  const metadata = {
    tool_count: input.toolCount,
    mcp_tool_count: input.mcpToolCount,
    auth_tool_count: input.authToolCount,
    plugin_tool_count: input.pluginToolCount,
    mcp_ids: input.mcpIds.slice().sort(),
  };
  emitWorkerJourneyObsEvent({
    trace: input.trace,
    conversationId: input.conversationId,
    agentId: input.agentId,
    userId: input.userId,
    event: "lobu.worker.tools_registered",
    status: "ok",
    fields: metadata,
  });
  emitWorkerObsEvent({
    trace: input.trace,
    conversationId: input.conversationId,
    agentId: input.agentId,
    userId: input.userId,
    eventName: "lobu.worker.tools_registered",
    status: "ok",
    stage: "lobu.worker.tools_registered",
    metadata,
  });
}

export type ModelObsRunResult =
  | { success: true; outputChars?: number }
  | { success: false; error: string; outputChars?: number };

export async function runModelWithObs(
  input: {
    trace: WorkerShifuTraceContext;
    conversationId?: string;
    agentId?: string;
    userId?: string;
    provider: string;
    modelId: string;
    toolCount: number;
  },
  run: () => Promise<ModelObsRunResult>
): Promise<ModelObsRunResult> {
  const startedAt = Date.now();
  emitWorkerJourneyObsEvent({
    trace: input.trace,
    conversationId: input.conversationId,
    agentId: input.agentId,
    userId: input.userId,
    event: "provider.call.started",
    status: "started",
    fields: {
      provider: {
        name: input.provider,
        model: input.modelId,
      },
      tool: {
        count: input.toolCount,
      },
    },
  });
  emitWorkerObsEvent({
    trace: input.trace,
    conversationId: input.conversationId,
    agentId: input.agentId,
    userId: input.userId,
    eventName: "provider.call.started",
    status: "started",
    stage: "provider.call.started",
    metadata: {
      provider: input.provider,
      model: input.modelId,
      tool_count: input.toolCount,
    },
  });

  try {
    const result = await run();
    const durationMs = Math.max(0, Date.now() - startedAt);
    if (result.success) {
      emitWorkerJourneyObsEvent({
        trace: input.trace,
        conversationId: input.conversationId,
        agentId: input.agentId,
        userId: input.userId,
        event: "provider.call.completed",
        status: "ok",
        durationMs,
        fields: {
          provider: {
            name: input.provider,
            model: input.modelId,
          },
          output_chars: result.outputChars ?? 0,
        },
      });
      emitWorkerObsEvent({
        trace: input.trace,
        conversationId: input.conversationId,
        agentId: input.agentId,
        userId: input.userId,
        eventName: "provider.call.completed",
        status: "ok",
        stage: "provider.call.completed",
        durationMs,
        metadata: {
          provider: input.provider,
          model: input.modelId,
          output_chars: result.outputChars ?? 0,
        },
      });
    } else {
      emitWorkerJourneyObsEvent({
        trace: input.trace,
        conversationId: input.conversationId,
        agentId: input.agentId,
        userId: input.userId,
        event: "provider.call.completed",
        status: "failed",
        durationMs,
        fields: {
          provider: {
            name: input.provider,
            model: input.modelId,
          },
          error_class: "model_error",
          next_debug_hint: `Check the model run for ${input.provider}/${input.modelId}; inspect worker logs and provider configuration.`,
        },
      });
      emitWorkerObsEvent({
        trace: input.trace,
        conversationId: input.conversationId,
        agentId: input.agentId,
        userId: input.userId,
        eventName: "provider.call.completed",
        status: "failed",
        stage: "provider.call.completed",
        durationMs,
        metadata: {
          provider: input.provider,
          model: input.modelId,
          error_class: "model_error",
          next_debug_hint: `Check the model run for ${input.provider}/${input.modelId}; inspect worker logs and provider configuration.`,
        },
      });
    }
    return result;
  } catch (error) {
    const durationMs = Math.max(0, Date.now() - startedAt);
    emitWorkerJourneyObsEvent({
      trace: input.trace,
      conversationId: input.conversationId,
      agentId: input.agentId,
      userId: input.userId,
      event: "provider.call.completed",
      status: "failed",
      durationMs,
      fields: {
        provider: {
          name: input.provider,
          model: input.modelId,
        },
        error_class: "model_error",
        next_debug_hint: `Check the model run for ${input.provider}/${input.modelId}; inspect worker logs and provider configuration.`,
        error_name: error instanceof Error ? error.name : typeof error,
      },
    });
    emitWorkerObsEvent({
      trace: input.trace,
      conversationId: input.conversationId,
      agentId: input.agentId,
      userId: input.userId,
      eventName: "provider.call.completed",
      status: "failed",
      stage: "provider.call.completed",
      durationMs,
      metadata: {
        provider: input.provider,
        model: input.modelId,
        error_class: "model_error",
        next_debug_hint: `Check the model run for ${input.provider}/${input.modelId}; inspect worker logs and provider configuration.`,
        error_name: error instanceof Error ? error.name : typeof error,
      },
    });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

export async function runAISession(
  params: RunAISessionParams
): Promise<SessionExecutionResult> {
  const {
    userPrompt,
    customInstructions,
    onProgress,
    agentOptions,
    sessionKey,
    channelId,
    conversationId,
    messageId,
    platform,
    platformMetadata,
    agentId,
    runJobToken,
    workspaceDir,
    progressProcessor,
    onSessionFilePathResolved,
    onModelResolved,
    loadImageAttachments,
    maybeRunPreCompactionMemoryFlush,
    maybeBuildAuthHintMessage,
  } = params;

  let rawOptions: Record<string, unknown>;
  try {
    rawOptions = JSON.parse(agentOptions) as Record<string, unknown>;
  } catch (error) {
    logger.error(
      `Failed to parse agentOptions: ${error instanceof Error ? error.message : String(error)}`
    );
    rawOptions = {};
  }
  const verboseLogging = rawOptions.verboseLogging === true;
  const memoryFlushConfig = resolveMemoryFlushConfig(rawOptions);

  progressProcessor.setVerboseLogging(verboseLogging);

  // Resolve how MCP tools should be exposed to the agent. In embedded mode,
  // operators can swap the many first-class MCP tools for a small set of
  // per-server just-bash CLIs (keeps the tool list lean).
  const configuredMcpExposure = (
    rawOptions.toolsConfig as ToolsConfig | undefined
  )?.mcpExposure;
  const mcpExposure: "tools" | "cli" =
    configuredMcpExposure === "cli" ? "cli" : "tools";
  const shifuTrace = parseWorkerShifuTrace(platformMetadata, "worker");
  emitWorkerJourneyObsEvent({
    trace: shifuTrace,
    conversationId,
    agentId,
    event: "lobu.worker.started",
    status: "started",
    fields: {
      mcp_exposure: mcpExposure,
      has_platform_metadata: Boolean(platformMetadata),
    },
  });

  // Fetch session context BEFORE model resolution. Pass `mcpExposure` so
  // MCP setup instructions use the right call syntax.
  const context = await getOpenClawSessionContext({
    mcpExposure,
    shifuTrace,
  });

  // Sync enabled skills to workspace filesystem so the agent can `cat` them.
  // Remove stale skill directories to avoid serving removed/disabled skills.
  const skillsRoot = path.join(workspaceDir, ".skills");
  await fs.mkdir(skillsRoot, { recursive: true });

  const nextSkillNames = new Set(
    context.skillsConfig
      .map((skill) => path.basename((skill.name || "").trim()))
      .filter(Boolean)
  );

  const existingSkillEntries = await fs
    .readdir(skillsRoot, { withFileTypes: true })
    .catch(() => []);

  for (const entry of existingSkillEntries) {
    if (!entry.isDirectory()) continue;
    if (!nextSkillNames.has(entry.name)) {
      await fs.rm(path.join(skillsRoot, entry.name), {
        recursive: true,
        force: true,
      });
    }
  }

  for (const skill of context.skillsConfig) {
    const skillName = path.basename((skill.name || "").trim());
    if (!skillName) continue;
    if (!/^[a-zA-Z0-9._-]+$/.test(skillName)) {
      logger.warn(`Skipping skill with invalid name: ${skillName}`);
      continue;
    }
    const skillDir = path.join(skillsRoot, skillName);
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), skill.content, "utf-8");
  }

  logger.info(
    `Synced ${context.skillsConfig.length} skill(s) to .skills/ directory`
  );

  // Store credentials in a local map instead of mutating process.env
  // to prevent leaking secrets between sessions via persistent env vars.
  const credentialStore = new Map<string, string>();

  const pc = context.providerConfig;
  if (pc.credentialEnvVarName) {
    credentialStore.set("CREDENTIAL_ENV_VAR_NAME", pc.credentialEnvVarName);
  }
  if (pc.providerBaseUrlMappings) {
    for (const [envVar, url] of Object.entries(pc.providerBaseUrlMappings)) {
      credentialStore.set(envVar, url);
    }
  }
  if (pc.credentialPlaceholders) {
    for (const [envVar, placeholder] of Object.entries(
      pc.credentialPlaceholders
    )) {
      credentialStore.set(envVar, placeholder);
    }
  }

  // Register config-driven providers so resolveModelRef() can handle them
  if (pc.configProviders) {
    for (const [id, meta] of Object.entries(pc.configProviders)) {
      registerDynamicProvider(id, meta);
    }
  }

  const modelRef = typeof rawOptions.model === "string" ? rawOptions.model : "";

  const { provider: rawProvider, modelId } = resolveModelRef(modelRef, {
    defaultModel: pc.defaultModel,
    defaultProvider: pc.defaultProvider,
    defaultProviderSlug: pc.defaultProviderSlug,
  });
  // Map gateway slug to model-registry provider name (e.g. "z-ai" → "zai")
  const provider = PROVIDER_REGISTRY_ALIASES[rawProvider] || rawProvider;
  onModelResolved(provider, modelId);
  const providerDirectToolLimit = resolveProviderDirectMcpToolLimit(
    rawProvider,
    provider,
    readConfiguredDirectMcpToolLimit(rawOptions)
  );

  // Dynamic provider base URL from agentOptions.providerBaseUrlMappings
  let providerBaseUrl: string | undefined;
  const dynamicMappings = rawOptions.providerBaseUrlMappings as
    | Record<string, string>
    | undefined;
  if (dynamicMappings && typeof dynamicMappings === "object") {
    const fallbackEnvVar = DEFAULT_PROVIDER_BASE_URL_ENV[rawProvider];
    if (fallbackEnvVar && dynamicMappings[fallbackEnvVar]) {
      providerBaseUrl = dynamicMappings[fallbackEnvVar];
    }
    for (const [envVar, url] of Object.entries(dynamicMappings)) {
      if (!credentialStore.has(envVar)) {
        credentialStore.set(envVar, url);
      }
    }
  }
  if (!providerBaseUrl) {
    providerBaseUrl =
      typeof rawOptions.providerBaseUrl === "string"
        ? rawOptions.providerBaseUrl.trim() || undefined
        : undefined;
  }
  if (!providerBaseUrl) {
    const baseUrlEnvVar = DEFAULT_PROVIDER_BASE_URL_ENV[rawProvider];
    if (baseUrlEnvVar) {
      const baseUrlValue = credentialStore.get(baseUrlEnvVar);
      if (baseUrlValue) {
        providerBaseUrl = baseUrlValue;
      }
    }
  }

  let baseModel = getModel(provider as any, modelId as any) as any;
  if (!baseModel) {
    // For OpenAI-compatible providers (e.g. nvidia, together-ai), create a
    // dynamic model entry since these models aren't in the static registry.
    const registryProvider =
      PROVIDER_REGISTRY_ALIASES[rawProvider] || rawProvider;
    if (registryProvider === "openai" || rawProvider !== provider) {
      logger.info(
        `Creating dynamic model entry for ${rawProvider}/${modelId} (openai-compatible)`
      );
      // Throws if a non-OpenAI provider's base URL is unresolved, rather
      // than silently routing to OpenAI's public endpoint.
      baseModel = buildDynamicOpenAIModel({
        rawProvider,
        registryProvider,
        modelId,
        providerBaseUrl,
      });
    } else {
      throw new Error(
        `Model "${modelId}" not found for provider "${provider}". Check that the model ID is valid and registered in the model registry.`
      );
    }
  }
  const resolvedModel = providerBaseUrl
    ? { ...baseModel, baseUrl: providerBaseUrl }
    : baseModel;
  const providerProxyAuthHeaders = buildProviderProxyAuthHeaders(
    providerBaseUrl,
    process.env.WORKER_TOKEN
  );
  const providerModel = providerProxyAuthHeaders
    ? {
        ...resolvedModel,
        headers: {
          ...(resolvedModel.headers ?? {}),
          ...providerProxyAuthHeaders,
        },
      }
    : resolvedModel;

  // Defensive: any `openai-completions` model whose baseUrl is not real
  // OpenAI is a third-party compat endpoint (Gemini, Nvidia, Together, z.ai,
  // etc.). These reject unknown fields and 400 with "Unknown name 'store'"
  // if pi-ai sends `store: false`. Force it off regardless of whether the
  // model came from the static registry or the dynamic fallback above.
  //
  // Host comparison uses URL parsing (not `.startsWith`) so that a baseUrl
  // like `https://api.openai.com.evil.example/v1` doesn't get mistaken for
  // real OpenAI. Malformed URLs are treated as third-party (safer default).
  const isThirdPartyOpenAICompat =
    providerModel.api === "openai-completions" &&
    typeof providerModel.baseUrl === "string" &&
    !isRealOpenAIBaseUrl(providerModel.baseUrl);
  const model = isThirdPartyOpenAICompat
    ? {
        ...providerModel,
        compat: { ...(providerModel.compat ?? {}), supportsStore: false },
      }
    : providerModel;

  await fs.mkdir(path.join(workspaceDir, ".openclaw"), { recursive: true });

  const sessionFile = path.join(workspaceDir, ".openclaw", "session.jsonl");
  // Notify the worker so cleanup() can capture it for snapshot writing at
  // terminal time.
  onSessionFilePathResolved(sessionFile);
  const providerStateFile = path.join(
    workspaceDir,
    ".openclaw",
    "provider.json"
  );

  // Hydrate from the latest completed Postgres snapshot BEFORE the
  // provider-state check or SessionManager.open().
  //
  // Order matters: hydrate → provider check (may unlink) →
  // SessionManager.open(). The provider-change unlink at line ~925 still
  // does the right thing after hydrate: it drops the file we just wrote
  // and SessionManager creates a fresh one, exactly like a first-turn
  // boot. The next snapshot will have its own run_id, so the historical
  // PG rows remain readable without poisoning the new conversation
  // (hydrate would only resurrect them if a subsequent run completes
  // successfully and overwrites the latest pointer).
  {
    const gatewayUrl = process.env.DISPATCHER_URL;
    const workerToken = resolveGatewayWorkerToken(
      runJobToken,
      process.env.WORKER_TOKEN ?? ""
    );
    if (gatewayUrl && workerToken) {
      try {
        await hydrateFromSnapshot({
          sessionFile,
          gatewayUrl,
          workerToken,
        });
      } catch (err) {
        // Hydrate failure is non-fatal — fall back to whatever's on disk.
        // Worst case the worker boots without history and the user re-
        // grounds the conversation. Better than refusing to start.
        logger.warn(
          `Snapshot hydrate failed; continuing with local session file: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    } else {
      logger.warn(
        "Snapshot hydrate skipped: DISPATCHER_URL or WORKER_TOKEN missing"
      );
    }
  }

  // Detect provider change and reset session if needed
  let sessionSummary: string | undefined;
  try {
    const raw = await fs.readFile(providerStateFile, "utf-8");
    const prevState = JSON.parse(raw) as {
      provider: string;
      modelId: string;
    };
    if (prevState.provider && prevState.provider !== provider) {
      logger.info(
        `Provider changed from ${prevState.provider} to ${provider}, resetting session`
      );

      // Read old session content for summary context
      try {
        const sessionContent = await fs.readFile(sessionFile, "utf-8");
        const lineCount = sessionContent.split("\n").filter(Boolean).length;
        if (lineCount > 0) {
          // Provide a brief context note instead of a full summary
          // to avoid an expensive API call to the new model
          sessionSummary = `[System note: The AI provider was just changed from ${prevState.provider} to ${provider}. Previous conversation history (${lineCount} turns) has been cleared. Continue helping the user from this point forward.]`;
        }
      } catch {
        // No existing session file
      }

      // Delete old session file to start fresh
      try {
        await fs.unlink(sessionFile);
      } catch {
        // File may not exist
      }
    }
  } catch (error) {
    // Log a warning for parse failures (vs. missing file which is expected on first run)
    const isFileNotFound =
      error instanceof Error &&
      (error as NodeJS.ErrnoException).code === "ENOENT";
    if (!isFileNotFound) {
      logger.warn(
        `Failed to read provider state file: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // Persist current provider state
  await fs.writeFile(
    providerStateFile,
    JSON.stringify({ provider, modelId }),
    "utf-8"
  );

  const sessionManager = await openOrCreateSessionManager(
    sessionFile,
    workspaceDir
  );
  const settingsManager = SettingsManager.inMemory();

  const toolsPolicy = buildToolPolicy({
    toolsConfig: rawOptions.toolsConfig as ToolsConfig | undefined,
    allowedTools: rawOptions.allowedTools as string | string[] | undefined,
    disallowedTools: rawOptions.disallowedTools as
      | string
      | string[]
      | undefined,
  });

  // Build a mutable snapshot of MCP runtime state. The embedded CLI handlers
  // read through `mcpRuntimeRef.current` so that `auth check` / `logout` can
  // swap in refreshed tools/state without rebuilding Bash. `refresh()` re-
  // fetches session context — `checkMcpLogin`/`logoutMcp` already invalidate
  // the gateway cache, so the next fetch reaches the gateway.
  const mcpRuntimeRef = {
    current: {
      mcpTools: applyCapabilityLimitNotes(context.mcpTools),
      mcpStatus: context.mcpStatus,
      mcpContext: context.mcpContext,
    },
    ...(mcpExposure === "cli" && {
      refresh: async () => {
        try {
          const fresh = await getOpenClawSessionContext({
            mcpExposure,
            shifuTrace,
          });
          return {
            mcpTools: applyCapabilityLimitNotes(fresh.mcpTools),
            mcpStatus: fresh.mcpStatus,
            mcpContext: fresh.mcpContext,
          };
        } catch (err) {
          logger.warn(
            `Failed to refresh MCP session context after auth: ${err instanceof Error ? err.message : String(err)}`
          );
          return null;
        }
      },
    }),
  };

  const gwParams: GatewayParams = {
    gatewayUrl: getOptionalEnv("DISPATCHER_URL", ""),
    workerToken: resolveGatewayWorkerToken(
      runJobToken,
      getOptionalEnv("WORKER_TOKEN", "")
    ),
    agentId: agentId || "",
    channelId,
    conversationId,
    platform,
    workspaceDir,
  };
  const executionReporter = createExecutionReporter({
    gatewayUrl: gwParams.gatewayUrl,
    workerToken: gwParams.workerToken,
    agentId: agentId || "",
    sessionId: sessionKey,
    messageId,
    conversationId,
    userId: context.userId,
    source: platform,
  });
  await executionReporter.createTask({
    metadata: {
      provider: rawProvider,
      model: modelId,
      sessionKey,
      channelId,
      platform,
    },
  });
  await executionReporter.record({
    type: "agent.started",
    message: "Agent run started.",
    payload: {
      provider: rawProvider,
      model: modelId,
      taskId: executionReporter.taskId,
    },
    status: "running",
  });

  // Dynamic import is justified: just-bash-bootstrap transitively pulls in
  // the embedded MCP server and its heavy deps (child_process, fs watchers).
  // Deferring keeps the cold-start path lean and avoids loading the MCP
  // runtime before the workspace is ready. Static import would force
  // the module to initialise at worker process startup, wasting memory for
  // runs that never reach this point (e.g. early auth errors).
  const { createEmbeddedBashOps } = await import(
    "../embedded/just-bash-bootstrap"
  );
  const embeddedBashOps: import("@mariozechner/pi-coding-agent").BashOperations =
    await createEmbeddedBashOps({
      workspaceDir,
      mcpRuntimeRef,
      gw: gwParams,
      mcpExposure,
    });
  let tools = createOpenClawTools(workspaceDir, {
    bashOperations: embeddedBashOps,
  }).filter((tool) => isToolAllowedByPolicy(tool.name, toolsPolicy));

  if (
    toolsPolicy.bashPolicy.allowPrefixes.length > 0 ||
    toolsPolicy.bashPolicy.denyPrefixes.length > 0
  ) {
    tools = tools.map((tool) => {
      if (tool.name !== "bash") {
        return tool;
      }
      return {
        ...tool,
        execute: async (toolCallId, params, signal, onUpdate) => {
          const command =
            params && typeof params === "object" && "command" in params
              ? String((params as { command?: unknown }).command ?? "")
              : "";
          enforceBashCommandPolicy(command, toolsPolicy.bashPolicy);
          return tool.execute(toolCallId, params as any, signal, onUpdate);
        },
      };
    });
  }

  // Credential injection — resolve API key from the in-memory credential store,
  // falling back to process.env only for values that were present at startup.
  const authStorage = new AuthStorage();
  const credEnvVar = credentialStore.get("CREDENTIAL_ENV_VAR_NAME") || null;
  const credValue = credEnvVar
    ? credentialStore.get(credEnvVar) || process.env[credEnvVar]
    : null;
  if (credEnvVar && credValue) {
    authStorage.setRuntimeApiKey(provider, credValue);
    logger.info(`Set runtime API key for ${provider}`);
  } else {
    // Look up the env var by the canonical gateway slug (e.g. "z-ai" → Z_AI_API_KEY),
    // not the model-registry alias (e.g. "zai" → ZAI_API_KEY which nobody sets).
    const fallbackEnvVar = getApiKeyEnvVarForProvider(rawProvider);
    const fallbackValue =
      credentialStore.get(fallbackEnvVar) || process.env[fallbackEnvVar];
    if (fallbackValue) {
      authStorage.setRuntimeApiKey(provider, fallbackValue);
      logger.info(`Set runtime API key for ${provider}`);
    }
  }

  // Re-resolve provider base URL after session context may have updated mappings
  if (!providerBaseUrl) {
    const baseUrlEnvVar = DEFAULT_PROVIDER_BASE_URL_ENV[rawProvider];
    if (baseUrlEnvVar) {
      const baseUrlValue = credentialStore.get(baseUrlEnvVar);
      if (baseUrlValue) {
        providerBaseUrl = baseUrlValue;
      }
    }
  }

  // Merge gateway instructions into custom instructions
  const instructionParts = [context.gatewayInstructions, customInstructions];

  // CLI backends are delivered via session context from the gateway.
  const cliBackends = pc.cliBackends;
  if (cliBackends?.length) {
    const agentList = cliBackends
      .map((b) => {
        const cmd = `${b.command} ${(b.args || []).join(" ")}`;
        const aliases = [b.name, b.providerId].filter(
          (v, i, a) => v && a.indexOf(v) === i
        );
        return `### ${aliases.join(" / ")}
Run via Bash exactly as shown (do NOT modify the command):
\`\`\`bash
${cmd} "YOUR_PROMPT_HERE"
\`\`\``;
      })
      .join("\n\n");
    instructionParts.push(
      `## Available Coding Agents

You have access to the following AI coding agents. When the user mentions any of these by name (e.g. "use claude", "ask chatgpt"), you MUST run the exact command shown below via the Bash tool. Do NOT attempt to install or locate the CLI yourself — the command handles everything.

${agentList}

Replace "YOUR_PROMPT_HERE" with the user's request. These agents can read/write files, install packages, and run commands in the working directory.`
    );
  }

  instructionParts.push(`## Conversation History

You have access to get_channel_history to view previous messages in this thread.
Use it when the user references past discussions or you need context.`);

  // Owns the decision to force-end a turn so it never depends on the model
  // voluntarily stopping. AskUser calls `terminate("ask-user")` after posting
  // (via onAskUserPosted); the runaway guards (identical-tool loop + total
  // tool-call cap) trip inside the synchronous tool-execute wrapper applied
  // below. The abort function is attached once the session exists.
  const turnController = new TurnController({
    onTerminate: ({ message }) => {
      logger.warn(`Turn force-terminated: ${message}`);
    },
  });

  let customTools = createOpenClawCustomTools({
    ...gwParams,
    userId: context.userId,
    workspaceDir,
    onCustomEvent: async (name, data) => {
      await onProgress({
        type: "custom_event",
        data: { name, payload: data },
        timestamp: Date.now(),
      });
    },
    onAskUserPosted: () =>
      turnController.terminate(
        "ask-user",
        "ask_user posted — ending the turn so the model can't re-post."
      ),
    toolboxPersonalAgentTools: context.toolboxPersonalAgentTools,
  });

  // Register first-class MCP tools + auth tools. Skipped entirely in CLI
  // mode — MCP tools are instead reachable via the per-server just-bash CLI
  // wired in above, and `<server> auth login|check|logout` supersedes the
  // `<id>_login` / `<id>_login_check` / `<id>_logout` trio.
  let registeredDirectMcpTools: Record<string, McpToolDef[]> = context.mcpTools;
  let registeredMcpToolCount = 0;
  if (mcpExposure === "cli") {
    logger.info(
      "mcpExposure='cli' — skipping first-class MCP tool registration (tools reachable via <server> <tool> in Bash)."
    );
    emitJourneyEvent({
      event: "worker.tools_registered",
      trace: shifuTrace,
      module: "agent-worker",
      status: "skipped",
      fields: {
        mcp_exposure: mcpExposure,
        mcp_server_count: Object.keys(context.mcpTools).length,
        tool_count: 0,
      },
    });
  } else {
    const projectedMcp = projectMcpToolsForProvider(context.mcpTools, {
      provider: rawProvider,
      directToolLimit: providerDirectToolLimit,
      reservedProviderToolNames: new Set(customTools.map((tool) => tool.name)),
      selectionHint: userPrompt,
    });
    registeredDirectMcpTools = projectedMcp.tools;
    instructionParts[0] = replaceMcpToolInventoryInstructions(
      context.gatewayInstructions,
      projectedMcp.tools,
      context.mcpStatus
    );
    if (projectedMcp.quarantined.length > 0) {
      logger.warn(
        `Quarantined ${projectedMcp.quarantined.length} MCP tool(s) before direct registration: ${projectedMcp.quarantined
          .map(
            (notice) => `${notice.mcpId}/${notice.toolName} (${notice.reason})`
          )
          .join(", ")}`
      );
    }
    if (projectedMcp.projected.length > 0) {
      logger.warn(
        `Projected ${projectedMcp.projected.length} MCP schema node(s) before direct registration: ${projectedMcp.projected
          .map(
            (notice) => `${notice.mcpId}/${notice.toolName} (${notice.reason})`
          )
          .join(", ")}`
      );
    }
    if (projectedMcp.omittedForCap.length > 0) {
      logger.warn(
        `Applied ${rawProvider} direct MCP tool cap: ${projectedMcp.omittedForCap
          .map(
            (notice) =>
              `${notice.mcpId} omitted ${notice.omitted} over limit ${notice.limit}`
          )
          .join(", ")})`
      );
    }
    const mcpToolDefs = createMcpToolDefinitions(
      projectedMcp.tools,
      gwParams,
      context.mcpContext,
      { shifuTrace }
    );
    registeredMcpToolCount = mcpToolDefs.length;
    if (mcpToolDefs.length > 0) {
      customTools.push(...mcpToolDefs);
      logger.info(
        `Registered ${mcpToolDefs.length} MCP tool(s): ${mcpToolDefs.map((t) => t.name).join(", ")}`
      );
    }
  }

  // Load OpenClaw plugins. Inject the worker's bound agentId into the Lobu
  // memory plugin's config so its autoCapture path can stamp
  // `metadata.agent_id` on every save_memory call — that's the
  // memory-scope axis search_memory's `agent_id` filter reads.
  const pluginsConfig = injectAgentIdIntoLobuPlugin(
    rawOptions.pluginsConfig as PluginsConfig | undefined,
    agentId
  );
  const loadedPlugins = await loadPlugins(pluginsConfig, workspaceDir);
  const pluginTools = loadedPlugins.flatMap((p) => p.tools);
  const pluginToolCount = pluginTools.length;

  if (pluginToolCount > 0) {
    customTools.push(...pluginTools);
    logger.info(
      `Loaded ${pluginToolCount} tool(s) from ${loadedPlugins.length} plugin(s)`
    );
  }

  let authToolCount = 0;
  if (mcpExposure !== "cli") {
    const existingToolNames = new Set(customTools.map((tool) => tool.name));
    const providerSafeAuthToolNames =
      requiresProviderSafeToolNames(rawProvider);
    const authToolNames = buildMcpAuthToolNameMap(
      context.mcpStatus,
      existingToolNames,
      providerSafeAuthToolNames
    );
    instructionParts[0] = replaceMcpSetupInstructions(
      instructionParts[0] ?? context.gatewayInstructions,
      context.mcpStatus,
      registeredDirectMcpTools,
      authToolNames
    );
    const authToolDefs = createMcpAuthToolDefinitions(
      context.mcpStatus,
      gwParams,
      existingToolNames,
      {
        providerSafeNames: providerSafeAuthToolNames,
        authToolNames,
      }
    );
    authToolCount = authToolDefs.length;
    if (authToolCount > 0) {
      customTools.push(...authToolDefs);
      logger.info(
        `Registered ${authToolCount} MCP auth tool(s): ${authToolDefs.map((t) => t.name).join(", ")}`
      );
    }
    emitJourneyEvent({
      event: "worker.tools_registered",
      trace: shifuTrace,
      module: "agent-worker",
      status: "ok",
      fields: {
        mcp_exposure: mcpExposure,
        mcp_server_count: Object.keys(context.mcpTools).length,
        mcp_ids: Object.keys(context.mcpTools).sort(),
        tool_count: registeredMcpToolCount,
        auth_tool_count: authToolCount,
        mcp_status_count: context.mcpStatus.length,
      },
    });
  }

  emitWorkerToolsRegisteredObsEvent({
    trace: shifuTrace,
    conversationId,
    agentId: agentId || context.agentId,
    userId: context.userId,
    toolCount: tools.length + customTools.length,
    mcpToolCount: registeredMcpToolCount,
    authToolCount,
    pluginToolCount,
    mcpIds: Object.keys(registeredDirectMcpTools),
  });

  tools = projectToolParametersForProvider(tools, rawProvider);
  customTools = projectToolParametersForProvider(customTools, rawProvider);

  const duplicateToolNames = findDuplicateToolNames([...tools, ...customTools]);
  if (duplicateToolNames.length > 0) {
    const summary = duplicateToolNames
      .map((entry) => `${entry.name} x${entry.count}`)
      .join(", ");
    throw new Error(
      `Duplicate provider tool names after projection: ${summary}`
    );
  }

  // Apply plugin provider registrations to ModelRegistry
  const modelRegistry = new ModelRegistry(authStorage);
  const allProviders = loadedPlugins.flatMap((p) => p.providers);
  for (const reg of allProviders) {
    try {
      modelRegistry.registerProvider(reg.name, reg.config as any);
      logger.info(`Registered provider "${reg.name}" from plugin`);
    } catch (err) {
      logger.error(
        `Failed to register provider "${reg.name}": ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  await startPluginServices(loadedPlugins);

  // Rebuild final instructions after possible login link injection
  const finalInstructionsUpdated = instructionParts
    .filter(Boolean)
    .join("\n\n");

  const resourceLoader = new DefaultResourceLoader({
    cwd: workspaceDir,
    settingsManager,
    systemPromptOverride: (base) =>
      buildLobuSystemPrompt(
        base,
        context.agentInstructions,
        finalInstructionsUpdated
      ),
  });
  await resourceLoader.reload();

  logger.info(
    `Starting OpenClaw session: provider=${provider}, model=${modelId}, tools=${tools.length}, customTools=${customTools.length}`
  );

  // Heartbeat timer to keep connection alive during long API calls
  const HEARTBEAT_INTERVAL_MS = 20000;
  let heartbeatTimer: Timer | null = null;
  let deltaTimer: Timer | null = null;
  let session: Awaited<ReturnType<typeof buildAgentSession>>["session"] | null =
    null;
  const pluginHookContext: Record<string, unknown> = {
    cwd: workspaceDir,
    sessionKey,
    messageProvider: platform,
  };

  try {
    const createdSession = await buildAgentSession({
      cwd: workspaceDir,
      model,
      // pi's createAgentSession() uses `tools` only to derive active tool
      // names and rebuilds the base tools internally (bash via getShellEnv()
      // = {...process.env}, no env strip, no embedded BashOperations).
      // buildAgentSession() swaps those rebuilt built-ins back to these
      // Lobu instances after construction so the agent's bash actually runs
      // with the spawnHook that strips WORKER_TOKEN/DISPATCHER_URL and with
      // the embedded BashOperations + tool policy wired in above.
      // Wrap built-ins with the synchronous runaway guard so the per-turn
      // tool-call cap and identical-call guard bound bash/read/edit/write
      // too. The guard runs inside execute (before the tool body), so the
      // bound is tight — unlike the agent's async tool_execution_start event,
      // which lags several turns behind real execution.
      tools: wrapToolsWithTurnGuard(tools, turnController),
      // Wrap custom tools (plugin + MCP) so plugin before_tool_call/
      // after_tool_call hooks fire around in-process execution — these never
      // hit the gateway proxy, so this is the only place the hooks can run.
      // Then layer the runaway guard on top so AskUser/MCP/plugin tools are
      // bounded identically.
      customTools: wrapToolsWithTurnGuard(
        wrapToolsWithPluginToolHooks(
          customTools,
          loadedPlugins,
          pluginHookContext
        ),
        turnController
      ),
      sessionManager,
      settingsManager,
      resourceLoader,
      authStorage,
      modelRegistry,
    });
    session = createdSession.session;

    // Wire the turn controller's abort to the live agent. `agent.abort()`
    // fires the shared AbortController: the in-flight/next LLM stream sees the
    // aborted signal and the loop emits `agent_end` with NO further model
    // iteration. Tool results recorded before the abort are already persisted
    // to the session, so the resume path (next inbound message → new turn) is
    // unaffected.
    turnController.attachAbort(() => {
      createdSession.session.agent.abort();
    });

    let resolveTurnDone: (() => void) | null = null;
    let turnNonce = 0;
    let suppressProgressOutput = false;

    // Wire events through progress processor with delta batching
    let pendingDelta = "";
    const DELTA_BATCH_INTERVAL_MS = 150;

    const flushDelta = async () => {
      if (pendingDelta) {
        const toSend = pendingDelta;
        pendingDelta = "";
        await onProgress({
          type: "output",
          data: toSend,
          timestamp: Date.now(),
        });
      }
      if (deltaTimer) {
        clearTimeout(deltaTimer);
        deltaTimer = null;
      }
    };

    const scheduleDeltaFlush = () => {
      if (!deltaTimer) {
        deltaTimer = setTimeout(() => {
          flushDelta().catch((err) => {
            logger.error("Failed to flush delta:", err);
          });
        }, DELTA_BATCH_INTERVAL_MS);
      }
    };

    const runPromptTurn = async (
      promptText: string,
      options?: { images?: ImageContent[]; silent?: boolean }
    ): Promise<void> => {
      const currentSession = session;
      if (!currentSession) {
        throw new Error("OpenClaw session is not initialized");
      }

      turnNonce += 1;
      const currentTurnNonce = turnNonce;

      // Reset per-turn runaway guards so cap/identical-call tracking is scoped
      // to this turn only.
      turnController.startTurn();

      const turnDone = new Promise<void>((resolve) => {
        resolveTurnDone = () => {
          if (currentTurnNonce !== turnNonce) {
            return;
          }
          resolveTurnDone = null;
          resolve();
        };
      });

      suppressProgressOutput = options?.silent === true;

      try {
        if (options?.images) {
          await currentSession.prompt(promptText, { images: options.images });
        } else {
          await currentSession.prompt(promptText);
        }
        await turnDone;
      } finally {
        suppressProgressOutput = false;
        if (resolveTurnDone && currentTurnNonce === turnNonce) {
          resolveTurnDone = null;
        }
      }
    };

    // Track tool-call input args across tool_execution_start → _end. pi-agent
    // only includes `args` on the start event; the end event carries
    // `toolCallId`, `toolName`, `result`, `isError`. The worker emits one
    // SSE `tool_use` per finished call, so it needs to remember the input.
    const pendingToolArgs = new Map<string, unknown>();
    const pendingToolStartTimes = new Map<string, number>();
    // Tool-use SSE emits are awaited at agent_end so the `complete` event
    // can't race ahead of late tool_use events on slow networks.
    const inFlightToolUse: Set<Promise<void>> = new Set();

    session.subscribe((event) => {
      if (suppressProgressOutput) {
        if (event.type === "agent_end") {
          resolveTurnDone?.();
        }
        return;
      }

      const hasUpdate = progressProcessor.processEvent(event);
      if (hasUpdate) {
        const delta = progressProcessor.getDelta();
        if (delta) {
          pendingDelta += delta;
          scheduleDeltaFlush();
        }
      }

      // Capture the input args at tool start so we can attach them when the
      // matching end event fires. (The runaway guard runs synchronously in
      // the tool-execute wrapper, not here — this event stream lags several
      // turns behind real execution.)
      if (event.type === "tool_execution_start") {
        pendingToolArgs.set(event.toolCallId, event.args);
        pendingToolStartTimes.set(event.toolCallId, Date.now());
        emitWorkerJourneyObsEvent({
          trace: shifuTrace,
          conversationId,
          agentId: agentId || context.agentId,
          userId: context.userId,
          event: "mcp.tool_call.started",
          status: "started",
          fields: {
            tool_call_id: event.toolCallId,
            tool: { name: event.toolName },
          },
        });
        const promise = executionReporter.record({
          type: "tool.started",
          message: `Tool started: ${event.toolName}`,
          payload: {
            toolCallId: event.toolCallId,
            name: event.toolName,
            input: event.args ?? null,
          },
          status: "waiting_for_tool",
        });
        inFlightToolUse.add(promise);
        promise.finally(() => inFlightToolUse.delete(promise));
      }

      // Surface tool-use traces to SSE clients (promptfoo provider, CLI eval,
      // any client subscribed via `event: tool_use`). Worker emits one record
      // per tool call at `tool_execution_end` so the result is included.
      if (event.type === "tool_execution_end") {
        const args = pendingToolArgs.get(event.toolCallId);
        pendingToolArgs.delete(event.toolCallId);
        const toolStartedAt = pendingToolStartTimes.get(event.toolCallId);
        pendingToolStartTimes.delete(event.toolCallId);
        emitWorkerJourneyObsEvent({
          trace: shifuTrace,
          conversationId,
          agentId: agentId || context.agentId,
          userId: context.userId,
          event: "mcp.tool_call.completed",
          status: event.isError ? "failed" : "ok",
          durationMs:
            toolStartedAt === undefined
              ? undefined
              : Math.max(0, Date.now() - toolStartedAt),
          fields: {
            tool_call_id: event.toolCallId,
            tool: { name: event.toolName },
            is_error: event.isError,
          },
        });
        const payload = buildToolUseEventPayload({
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args,
          result: event.result,
          isError: event.isError,
        });
        const executionEventPromise = executionReporter.record({
          type: event.isError ? "tool.failed" : "tool.completed",
          message: `${event.isError ? "Tool failed" : "Tool completed"}: ${event.toolName}`,
          payload: payload as unknown as Record<string, unknown>,
          status: "running",
        });
        inFlightToolUse.add(executionEventPromise);
        executionEventPromise.finally(() =>
          inFlightToolUse.delete(executionEventPromise)
        );
        const promise = onProgress({
          type: "custom_event",
          data: {
            name: "tool_use",
            payload: payload as unknown as Record<string, unknown>,
          },
          timestamp: Date.now(),
        }).catch((err) => {
          logger.warn(
            `Failed to emit tool_use custom event for ${event.toolName}:`,
            err
          );
        });
        inFlightToolUse.add(promise);
        promise.finally(() => inFlightToolUse.delete(promise));
      }

      if (event.type === "agent_end") {
        flushDelta()
          .then(async () => {
            // Wait for any pending tool_use emits so clients don't see
            // `complete` arrive before all tool_use records (the provider
            // returns on `complete`, and a slow tool_use POST mid-flight
            // would otherwise be lost).
            if (inFlightToolUse.size > 0) {
              await Promise.allSettled(Array.from(inFlightToolUse));
            }
            resolveTurnDone?.();
          })
          .catch((err) => {
            logger.error("Failed to flush final delta:", err);
            resolveTurnDone?.();
          });
      }
    });

    let elapsedTime = 0;
    let lastHeartbeatTime = Date.now();
    const MAX_CONSECUTIVE_HEARTBEAT_FAILURES = 5;
    let consecutiveHeartbeatFailures = 0;

    const sendHeartbeat = async () => {
      const now = Date.now();
      elapsedTime += now - lastHeartbeatTime;
      lastHeartbeatTime = now;
      const seconds = Math.floor(elapsedTime / 1000);

      logger.warn(
        `⏳ Still running after ${seconds}s - no response from API yet`
      );

      await onProgress({
        type: "status_update",
        data: {
          elapsedSeconds: seconds,
          state: "is running..",
        },
        timestamp: Date.now(),
      });
      await executionReporter.record({
        type: "agent.heartbeat",
        message: `Agent still running after ${seconds}s.`,
        payload: { elapsedSeconds: seconds },
        status: "running",
      });
    };

    heartbeatTimer = setInterval(() => {
      sendHeartbeat()
        .then(() => {
          consecutiveHeartbeatFailures = 0;
        })
        .catch((err) => {
          consecutiveHeartbeatFailures += 1;
          logger.error(
            `Failed to send heartbeat (${consecutiveHeartbeatFailures}/${MAX_CONSECUTIVE_HEARTBEAT_FAILURES}):`,
            err
          );
          if (
            consecutiveHeartbeatFailures >= MAX_CONSECUTIVE_HEARTBEAT_FAILURES
          ) {
            logger.error(
              "Gateway unresponsive after consecutive heartbeat failures, aborting session"
            );
            if (heartbeatTimer) {
              clearInterval(heartbeatTimer);
              heartbeatTimer = null;
            }
            // Unblock any in-flight prompt turn FIRST — disposing the session
            // without resolving `turnDone` leaves `runPromptTurn` (and the
            // outer `runAISession`) wedged on `await turnDone` until the
            // deployment manager force-kills the worker.
            resolveTurnDone?.();
            if (session) {
              session.dispose();
            }
          }
        });
    }, HEARTBEAT_INTERVAL_MS);

    // Session reset: run unconditional memory flush, delete session file, and return early
    if ((platformMetadata as any)?.sessionReset === true) {
      logger.info(
        "Session reset requested — running unconditional memory flush"
      );

      const flushPrompt = `${memoryFlushConfig.systemPrompt}\n\n${memoryFlushConfig.prompt}`;
      try {
        await runPromptTurn(flushPrompt, { silent: true });
        logger.info("Memory flush completed for session reset");
      } catch (error) {
        logger.warn(
          `Memory flush failed during session reset: ${error instanceof Error ? error.message : String(error)}`
        );
      }

      // Delete session file so next run starts with a clean history
      try {
        await fs.unlink(sessionFile);
        logger.info("Deleted session file for session reset");
      } catch {
        // File may not exist
      }

      // Also purge the Postgres snapshots for this (org, agent, conv)
      // — the next worker boot would otherwise rehydrate from the
      // now-flushed conversation and the user-visible "Starting fresh"
      // would be a lie. Best-effort: a failure here is logged but
      // doesn't block the reset since the local unlink already
      // happened.
      {
        const gatewayUrl = process.env.DISPATCHER_URL;
        const workerToken = resolveGatewayWorkerToken(
          runJobToken,
          process.env.WORKER_TOKEN ?? ""
        );
        if (gatewayUrl && workerToken) {
          await clearSnapshots({ gatewayUrl, workerToken });
        }
      }

      // Send visible confirmation to user
      await onProgress({
        type: "output",
        data: "Context saved. Starting fresh.",
        timestamp: Date.now(),
      });
      await executionReporter.record({
        type: "agent.completed",
        message: "Session reset completed.",
        status: "completed",
        finalSummary: { reason: "session_reset" },
      });

      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (deltaTimer) clearTimeout(deltaTimer);
      await stopPluginServices(loadedPlugins);

      return {
        success: true,
        exitCode: 0,
        output: "",
        sessionKey,
      };
    }

    // Consume any pending config change notifications from SSE events.
    // Dynamic import is justified: sse-client runs a top-level singleton
    // EventSource connection and registers global process-level handlers.
    // A static import would start that connection at module load time (worker
    // startup), before the gateway URL / token env vars are validated.
    // Circular-dependency risk: sse-client imports gateway types that
    // transitively depend on worker internals; deferring the import breaks
    // the cycle without introducing a separate entry point.
    const { consumePendingConfigNotifications } = await import(
      "../gateway/sse-client"
    );
    const configNotifications = consumePendingConfigNotifications();

    let configNotice = "";
    if (configNotifications.length > 0) {
      const lines = configNotifications.map((n) => {
        let line = `- ${n.summary}`;
        if (n.details?.length) {
          line += `: ${n.details.join("; ")}`;
        }
        return line;
      });
      configNotice = `[System notice: Your configuration was updated since the last message]\n${lines.join("\n")}\n\n`;
    }

    const beforeAgentStartResults = await runPluginHooks({
      plugins: loadedPlugins,
      hook: "before_agent_start",
      event: {
        prompt: userPrompt,
        messages: session.messages as unknown as Record<string, unknown>[],
      },
      ctx: pluginHookContext,
    });
    const prependContexts = beforeAgentStartResults
      .flatMap((result) => {
        if (!result || typeof result !== "object") return [];
        const prepend = (result as Record<string, unknown>).prependContext;
        if (typeof prepend !== "string" || !prepend.trim()) return [];
        return [prepend.trim()];
      })
      .join("\n\n");

    const effectivePromptText = `${configNotice}${sessionSummary ? `${sessionSummary}\n\n` : ""}${prependContexts ? `${prependContexts}\n\n` : ""}${userPrompt}`;

    // Load image attachments for vision-capable models
    const images = await loadImageAttachments();
    if (images.length > 0) {
      logger.info(`Including ${images.length} image(s) in prompt for vision`);
    }

    await maybeRunPreCompactionMemoryFlush({
      session,
      sessionManager,
      settingsManager,
      memoryFlushConfig,
      incomingPromptText: effectivePromptText,
      incomingImageCount: images.length,
      runSilentPrompt: async (prompt) => {
        await runPromptTurn(prompt, { silent: true });
      },
    });

    const modelRunResult = await runModelWithObs(
      {
        trace: shifuTrace,
        conversationId,
        agentId: agentId || context.agentId,
        userId: context.userId,
        provider,
        modelId,
        toolCount: tools.length + customTools.length,
      },
      async () => {
        await runPromptTurn(effectivePromptText, { images });
        const outputChars = progressProcessor.getOutputSnapshot().length;
        const fatalError = progressProcessor.consumeFatalErrorMessage();
        if (fatalError) {
          return {
            success: false,
            error: fatalError,
            outputChars,
          };
        }
        return { success: true, outputChars };
      }
    );

    const sessionError = modelRunResult.success ? null : modelRunResult.error;
    if (sessionError) {
      await runPluginHooks({
        plugins: loadedPlugins,
        hook: "agent_end",
        event: {
          success: false,
          error: sessionError,
          messages: session.messages as unknown as Record<string, unknown>[],
        },
        ctx: pluginHookContext,
      });
      const errorWithHint = maybeBuildAuthHintMessage(
        sessionError,
        rawProvider,
        modelId
      );
      await executionReporter.record({
        type: "agent.failed",
        message: "Agent run failed.",
        status: "failed",
        error: { message: errorWithHint },
      });
      return {
        success: false,
        exitCode: 1,
        output: "",
        error: errorWithHint,
        sessionKey,
      };
    }

    await runPluginHooks({
      plugins: loadedPlugins,
      hook: "agent_end",
      event: {
        success: true,
        messages: session.messages as unknown as Record<string, unknown>[],
      },
      ctx: pluginHookContext,
    });

    // Hand the fully-streamed assistant output to the progress processor so
    // the success path's checkSandboxLeak() (worker.execute) actually runs
    // against user-facing text. Without this, getFinalResult() is always
    // null in production and the sandbox-leak redaction never fires.
    progressProcessor.setFinalResult({
      text: progressProcessor.getOutputSnapshot(),
      isFinal: true,
    });
    await executionReporter.record({
      type: "agent.completed",
      message: "Agent run completed.",
      status: "completed",
      finalSummary: {
        outputChars: progressProcessor.getOutputSnapshot().length,
        taskId: executionReporter.taskId,
      },
    });

    return {
      success: true,
      exitCode: 0,
      output: "",
      sessionKey,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (session) {
      await runPluginHooks({
        plugins: loadedPlugins,
        hook: "agent_end",
        event: {
          success: false,
          error: errorMsg,
          messages: session.messages as unknown as Record<string, unknown>[],
        },
        ctx: pluginHookContext,
      });
    }
    const errorWithHint = maybeBuildAuthHintMessage(
      errorMsg,
      provider,
      modelId
    );
    await executionReporter.record({
      type: "agent.failed",
      message: "Agent run failed.",
      status: "failed",
      error: { message: errorWithHint },
    });

    return {
      success: false,
      exitCode: 1,
      output: "",
      error: errorWithHint,
      sessionKey,
    };
  } finally {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      logger.debug("Heartbeat timer cleared");
    }
    if (deltaTimer) {
      clearTimeout(deltaTimer);
      deltaTimer = null;
      logger.debug("Delta batch timer cleared");
    }
    if (session) {
      session.dispose();
      session = null;
    }
    await stopPluginServices(loadedPlugins);
  }
}
