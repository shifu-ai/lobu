import type { McpToolDef } from "@lobu/core";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { ToolContentResult } from "../shared/tool-implementations";
import {
  catalogEntryForTool,
  isReservedAutomationToolName,
  isTrustedShifuCalendarResolver,
  isTrustedShifuToolMetadataSource,
  type McpCatalogProvenanceById,
  type ToolCatalogEntry,
} from "./tool-catalog";
import { getOrBuildToolDescriptor, toolIdentityKey } from "./tool-descriptor";
import {
  getOrBuildToolRetrievalIndex,
  searchToolRetrievalIndex,
  type ToolCandidateMatch,
  type ToolRetrievalIndex,
} from "./tool-retrieval-index";

export type RuntimeToolCallBlockedReason =
  | "not_discovered"
  | "not_allowed"
  | "auth_required"
  | "approval_required"
  | "clarification_required";

export type RuntimeToolCallErrorCode =
  | RuntimeToolCallBlockedReason
  | "ambiguous_tool"
  | "schema_invalid"
  | "tool_error"
  | "server_unavailable";

export interface RuntimeToolCatalogEntry extends ToolCatalogEntry {
  title?: string;
  description: string;
  directVisibleThisTurn: boolean;
  callableViaCatalog: boolean;
  callBlockedReason?: RuntimeToolCallBlockedReason;
  /**
   * Kept as a compatibility alias for the Task 1 dynamic tool loader tests.
   * New code should use directVisibleThisTurn.
   */
  availableThisTurn: boolean;
}

export interface BuildRuntimeToolCatalogParams {
  allTools: Record<string, McpToolDef[]>;
  selectedTools: Record<string, McpToolDef[]>;
  providerVisibleTools?: Record<string, McpToolDef[]>;
  allowedToolNames?: Iterable<string>;
  clarificationBlockedToolKeys?: Iterable<string>;
  mcpProvenanceById?: McpCatalogProvenanceById;
  trustedShifuToolboxOrigins?: ReadonlySet<string>;
}

export interface SearchRuntimeToolCatalogParams {
  query: string;
  limit?: number;
}

export interface RuntimeToolSearchMatch {
  entry: RuntimeToolCatalogEntry;
  totalScore: number;
  reasons: string[];
}

interface RuntimeToolSearchContext {
  fingerprint: string;
  entriesByIdentityKey: ReadonlyMap<string, RuntimeToolCatalogEntry>;
}

const runtimeToolSearchContexts = new WeakMap<
  RuntimeToolCatalogEntry[],
  RuntimeToolSearchContext
>();

function buildRuntimeToolSearchContext(
  catalog: RuntimeToolCatalogEntry[],
): RuntimeToolSearchContext {
  const descriptors = catalog.map((entry) =>
    getOrBuildToolDescriptor(entry.tool, entry.mcpId, entry.originalIndex),
  );
  const index = getOrBuildToolRetrievalIndex(descriptors).index;
  return {
    fingerprint: index.fingerprint,
    entriesByIdentityKey: new Map(
      catalog.map(
        (entry) => [toolIdentityKey(entry.mcpId, entry.name), entry] as const,
      ),
    ),
  };
}

function resolveRuntimeToolSearchIndex(
  catalog: RuntimeToolCatalogEntry[],
): ToolRetrievalIndex {
  const descriptors = catalog.map((entry) =>
    getOrBuildToolDescriptor(entry.tool, entry.mcpId, entry.originalIndex),
  );
  const index = getOrBuildToolRetrievalIndex(descriptors).index;
  // The context intentionally retains no complete retrieval index. A cache
  // eviction must rebuild through the shared, accounted coordinator instead
  // of reviving an evicted index (or its descriptors) from a weak seed.
  return index;
}

export type RuntimeToolCaller = (
  mcpId: string,
  toolName: string,
  args: Record<string, unknown>,
) => Promise<ToolContentResult>;

export type RuntimeToolCallResult =
  | {
      ok: true;
      entry: RuntimeToolCatalogEntry;
      result: ToolContentResult;
    }
  | {
      ok: false;
      code: RuntimeToolCallErrorCode;
      message: string;
      entry?: RuntimeToolCatalogEntry;
      candidates?: Array<{ mcpId: string; name: string }>;
    };

export interface DispatchRuntimeToolCallParams {
  catalog: RuntimeToolCatalogEntry[];
  toolName: string;
  mcpId?: string;
  args: Record<string, unknown>;
  callTool: RuntimeToolCaller;
}

type RuntimeMcpToolResultMetadata = {
  isError?: unknown;
  errorCode?: unknown;
};

export interface RuntimeToolStatusQuery {
  toolName?: string;
  mcpId?: string;
}

function catalogToolKey(mcpId: string, toolName: string): string {
  return `${mcpId}\u0000${toolName}`;
}

function externalToolKey(mcpId: string, toolName: string): string {
  return `${mcpId}/${toolName}`;
}

function normalizeAllowedToolName(name: string): string {
  return name.trim().toLowerCase();
}

function buildAllowedNameSet(
  allowedToolNames: Iterable<string> | undefined,
): Set<string> | null {
  if (!allowedToolNames) return null;
  const allowed = new Set<string>();
  for (const name of allowedToolNames) {
    const normalized = normalizeAllowedToolName(name);
    if (normalized) allowed.add(normalized);
  }
  return allowed;
}

function isEntryAllowed(
  entry: ToolCatalogEntry,
  allowedToolNames: Set<string> | null,
): boolean {
  if (!allowedToolNames) return true;
  const plainName = normalizeAllowedToolName(entry.name);
  const qualifiedName = normalizeAllowedToolName(
    externalToolKey(entry.mcpId, entry.name),
  );
  return allowedToolNames.has(plainName) || allowedToolNames.has(qualifiedName);
}

function readCatalogTitle(tool: McpToolDef): string | undefined {
  const looseTool = tool as unknown as {
    title?: unknown;
    _meta?: { title?: unknown; shifuTool?: { title?: unknown } };
    annotations?: { title?: unknown; shifuTool?: { title?: unknown } };
  };
  const title =
    looseTool.title ??
    looseTool._meta?.title ??
    looseTool.annotations?.title ??
    looseTool._meta?.shifuTool?.title ??
    looseTool.annotations?.shifuTool?.title;
  return typeof title === "string" && title.trim() ? title.trim() : undefined;
}

export function buildRuntimeToolCatalog(
  params: BuildRuntimeToolCatalogParams,
): RuntimeToolCatalogEntry[] {
  const selectedToolKeys = new Set<string>();
  const directVisibleTools =
    params.providerVisibleTools ?? params.selectedTools;
  for (const [mcpId, tools] of Object.entries(directVisibleTools)) {
    for (const tool of tools) {
      const projectedTool = tool as McpToolDef & {
        upstreamToolName?: string;
        providerToolName?: string;
      };
      selectedToolKeys.add(
        catalogToolKey(
          mcpId,
          projectedTool.upstreamToolName || tool.name || "",
        ),
      );
    }
  }

  const allowedToolNames = buildAllowedNameSet(params.allowedToolNames);
  const clarificationBlockedToolKeys = new Set(
    params.clarificationBlockedToolKeys ?? [],
  );
  const catalog: RuntimeToolCatalogEntry[] = [];
  let originalIndex = 0;
  for (const [mcpId, tools] of Object.entries(params.allTools)) {
    for (const tool of tools) {
      const entry = catalogEntryForTool(tool, originalIndex, mcpId, {
        provenance: params.mcpProvenanceById?.[mcpId],
        trustedOrigins: params.trustedShifuToolboxOrigins,
      });
      originalIndex++;
      if (!entry.name) continue;
      if (
        isReservedAutomationToolName(entry.name) &&
        !isTrustedShifuToolMetadataSource({
          mcpId,
          provenance: params.mcpProvenanceById?.[mcpId],
          trustedOrigins: params.trustedShifuToolboxOrigins,
        })
      )
        continue;
      if (
        entry.name === "resolve_calendar_date" &&
        !isTrustedShifuCalendarResolver({
          tool,
          mcpId,
          provenance: params.mcpProvenanceById?.[mcpId],
          trustedOrigins: params.trustedShifuToolboxOrigins,
        })
      )
        continue;
      const directVisibleThisTurn = selectedToolKeys.has(
        catalogToolKey(mcpId, entry.name),
      );
      const allowed = isEntryAllowed(entry, allowedToolNames);
      const clarificationBlocked =
        clarificationBlockedToolKeys.has(externalToolKey(mcpId, entry.name)) ||
        clarificationBlockedToolKeys.has(toolIdentityKey(mcpId, entry.name));
      const callBlockedReason: RuntimeToolCallBlockedReason | undefined =
        !allowed
          ? "not_allowed"
          : clarificationBlocked
            ? "clarification_required"
            : undefined;
      catalog.push({
        ...entry,
        title: readCatalogTitle(tool),
        description: tool.description || "",
        directVisibleThisTurn,
        availableThisTurn: directVisibleThisTurn,
        callableViaCatalog: !callBlockedReason,
        callBlockedReason,
      });
    }
  }
  try {
    runtimeToolSearchContexts.set(
      catalog,
      buildRuntimeToolSearchContext(catalog),
    );
  } catch {
    // Keep status/call enforcement available if semantic metadata is malformed.
    // Search will make one guarded lazy retry and otherwise return no matches.
  }
  return catalog;
}

function scoreReasons(match: ToolCandidateMatch): string[] {
  return Object.entries(match.scoreBreakdown)
    .filter(([, score]) => score > 0)
    .map(([field]) => field)
    .slice(0, 8);
}

export function searchRuntimeToolCatalog(
  catalog: RuntimeToolCatalogEntry[],
  params: SearchRuntimeToolCatalogParams,
): RuntimeToolSearchMatch[] {
  const limit = Math.min(20, Math.max(1, Math.floor(params.limit ?? 5)));
  let context = runtimeToolSearchContexts.get(catalog);
  if (!context) {
    try {
      context = buildRuntimeToolSearchContext(catalog);
      runtimeToolSearchContexts.set(catalog, context);
    } catch {
      return [];
    }
  }
  const eligibleKeys = new Set(
    catalog
      .filter(
        (entry) =>
          entry.callableViaCatalog ||
          entry.callBlockedReason === "clarification_required",
      )
      .map((entry) => toolIdentityKey(entry.mcpId, entry.name)),
  );
  const index = resolveRuntimeToolSearchIndex(catalog);
  return searchToolRetrievalIndex(index, params.query, limit, eligibleKeys)
    .map((match) => {
      const entry = context.entriesByIdentityKey.get(
        match.descriptor.identityKey,
      );
      return entry
        ? {
            entry,
            totalScore: match.totalScore,
            reasons: scoreReasons(match),
          }
        : undefined;
    })
    .filter((match): match is RuntimeToolSearchMatch => match !== undefined);
}

type RuntimeToolCatalogLookupResult =
  | { status: "found"; entry: RuntimeToolCatalogEntry }
  | {
      status: "ambiguous";
      candidates: RuntimeToolCatalogEntry[];
    }
  | { status: "missing" };

function findRuntimeToolCatalogEntry(
  catalog: RuntimeToolCatalogEntry[],
  toolName: string,
  mcpId?: string,
): RuntimeToolCatalogLookupResult {
  const normalizedToolName = toolName.trim();
  const normalizedMcpId = mcpId?.trim();
  const matches = catalog.filter((entry) => {
    if (normalizedMcpId) {
      return (
        entry.mcpId === normalizedMcpId && entry.name === normalizedToolName
      );
    }
    return (
      entry.name === normalizedToolName ||
      externalToolKey(entry.mcpId, entry.name) === normalizedToolName
    );
  });
  if (matches.length === 0) return { status: "missing" };
  if (
    !normalizedMcpId &&
    !normalizedToolName.includes("/") &&
    matches.length > 1
  ) {
    return { status: "ambiguous", candidates: matches };
  }
  const entry = matches[0];
  return entry ? { status: "found", entry } : { status: "missing" };
}

function validateToolArgs(
  entry: RuntimeToolCatalogEntry,
  args: Record<string, unknown>,
): RuntimeToolCallResult | null {
  if (!entry.tool.inputSchema) return null;
  try {
    const schema = Type.Unsafe(entry.tool.inputSchema);
    if (Value.Check(schema, args)) return null;
    return {
      ok: false,
      code: "schema_invalid",
      message: `Arguments failed schema validation for ${externalToolKey(
        entry.mcpId,
        entry.name,
      )}.`,
      entry,
    };
  } catch {
    return null;
  }
}

function textFromToolResult(result: ToolContentResult): string {
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function isStableErrorCode(value: unknown): value is RuntimeToolCallErrorCode {
  return (
    value === "not_discovered" ||
    value === "not_allowed" ||
    value === "clarification_required" ||
    value === "ambiguous_tool" ||
    value === "auth_required" ||
    value === "approval_required" ||
    value === "schema_invalid" ||
    value === "tool_error" ||
    value === "server_unavailable"
  );
}

function classifyDelegatedToolError(
  result: ToolContentResult,
): RuntimeToolCallErrorCode | null {
  const metadata = result as RuntimeMcpToolResultMetadata;
  if (isStableErrorCode(metadata.errorCode)) {
    return metadata.errorCode;
  }
  if (metadata.isError !== true) return null;

  const text = textFromToolResult(result).toLowerCase();
  if (
    text.includes("auth") ||
    text.includes("login") ||
    text.includes("credential")
  ) {
    return "auth_required";
  }
  if (text.includes("approval") || text.includes("approve")) {
    return "approval_required";
  }
  if (
    text.includes("timed out") ||
    text.includes("non-json response") ||
    text.includes("server unavailable")
  ) {
    return "server_unavailable";
  }
  return "tool_error";
}

export async function dispatchRuntimeToolCall(
  params: DispatchRuntimeToolCallParams,
): Promise<RuntimeToolCallResult> {
  const lookup = findRuntimeToolCatalogEntry(
    params.catalog,
    params.toolName,
    params.mcpId,
  );
  if (lookup.status === "missing") {
    return {
      ok: false,
      code: "not_discovered",
      message: `Tool ${params.mcpId ? `${params.mcpId}/` : ""}${
        params.toolName
      } is not in the discovered runtime MCP catalog.`,
    };
  }
  if (lookup.status === "ambiguous") {
    return {
      ok: false,
      code: "ambiguous_tool",
      message: `Tool ${params.toolName} exists on multiple MCP servers. Provide mcp_id to disambiguate.`,
      candidates: lookup.candidates.map((entry) => ({
        mcpId: entry.mcpId,
        name: entry.name,
      })),
    };
  }
  const entry = lookup.entry;
  if (!entry.callableViaCatalog) {
    return {
      ok: false,
      code: entry.callBlockedReason || "not_allowed",
      message: `Tool ${externalToolKey(entry.mcpId, entry.name)} is not callable via the runtime catalog.`,
      entry,
    };
  }

  const schemaError = validateToolArgs(entry, params.args);
  if (schemaError) return schemaError;

  try {
    const result = await params.callTool(entry.mcpId, entry.name, params.args);
    const delegatedErrorCode = classifyDelegatedToolError(result);
    if (delegatedErrorCode) {
      return {
        ok: false,
        code: delegatedErrorCode,
        message:
          textFromToolResult(result) ||
          `Tool ${externalToolKey(entry.mcpId, entry.name)} failed.`,
        entry,
      };
    }
    return {
      ok: true,
      entry,
      result,
    };
  } catch (error) {
    return {
      ok: false,
      code: "server_unavailable",
      message:
        error instanceof Error
          ? error.message
          : `Failed to call ${externalToolKey(entry.mcpId, entry.name)}.`,
      entry,
    };
  }
}

function summarizeEntry(entry: RuntimeToolCatalogEntry) {
  return {
    mcpId: entry.mcpId,
    name: entry.name,
    title: entry.title,
    description: entry.description,
    domain: entry.domain,
    priority: entry.priority,
    aliases: entry.aliases,
    readOnly: entry.readOnly,
    mutatesState: entry.mutatesState,
    requiresConfirmation: entry.requiresConfirmation,
    freshness: entry.freshness,
    directVisibleThisTurn: entry.directVisibleThisTurn,
    callableViaCatalog: entry.callableViaCatalog,
    callBlockedReason: entry.callBlockedReason,
  };
}

export function statusRuntimeToolCatalog(
  catalog: RuntimeToolCatalogEntry[],
  query: RuntimeToolStatusQuery,
) {
  if (query.toolName) {
    const lookup = findRuntimeToolCatalogEntry(
      catalog,
      query.toolName,
      query.mcpId,
    );
    if (lookup.status === "found") {
      return summarizeEntry(lookup.entry);
    }
    if (lookup.status === "ambiguous") {
      return {
        name: query.toolName,
        mcpId: query.mcpId,
        directVisibleThisTurn: false,
        callableViaCatalog: false,
        callBlockedReason: "ambiguous_tool" as const,
        candidates: lookup.candidates.map((entry) => ({
          mcpId: entry.mcpId,
          name: entry.name,
        })),
      };
    }
    return {
      name: query.toolName,
      mcpId: query.mcpId,
      directVisibleThisTurn: false,
      callableViaCatalog: false,
      callBlockedReason: "not_discovered" as const,
    };
  }

  const entries = query.mcpId
    ? catalog.filter((entry) => entry.mcpId === query.mcpId)
    : catalog;
  return {
    mcpId: query.mcpId,
    toolCount: entries.length,
    directVisibleToolCount: entries.filter(
      (entry) => entry.directVisibleThisTurn,
    ).length,
    catalogCallableToolCount: entries.filter(
      (entry) => entry.callableViaCatalog,
    ).length,
    tools: entries.map(summarizeEntry),
  };
}
