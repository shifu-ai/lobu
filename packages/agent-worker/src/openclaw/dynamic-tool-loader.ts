import type { McpToolDef } from "@lobu/core";
import {
  catalogEntryForTool,
  TOOL_PRIORITY_WEIGHT,
  type ToolCatalogEntry,
} from "./tool-catalog";
import { classifyToolIntent, type ToolIntent } from "./tool-intent";

export interface DynamicToolSelectionTrace {
  primaryIntent: ToolIntent;
  budget: number;
  totalTools: number;
  selectedToolNames: string[];
  omittedToolNames: string[];
  selected: string[];
  omitted: string[];
}

export interface RuntimeToolCatalogEntry extends ToolCatalogEntry {
  availableThisTurn: boolean;
}

export interface SelectFlatMcpToolsForTurnParams {
  tools: McpToolDef[];
  message: string;
  budget: number;
  mcpId?: string;
}

export interface SelectFlatMcpToolsForTurnResult {
  selected: McpToolDef[];
  trace: DynamicToolSelectionTrace;
}

export interface SelectMcpToolsForTurnParams {
  toolsByMcp: Record<string, McpToolDef[]>;
  userMessage: string;
  maxProviderVisibleTools: number;
}

export interface SelectMcpToolsForTurnResult {
  selected: Record<string, McpToolDef[]>;
  trace: DynamicToolSelectionTrace;
}

export interface SelectMcpToolsByMcpForTurnParams {
  toolsByMcp: Record<string, McpToolDef[]>;
  message: string;
  budget: number;
}

export interface SelectMcpToolsByMcpForTurnResult {
  selectedTools: Record<string, McpToolDef[]>;
  trace: DynamicToolSelectionTrace;
}

export interface BuildRuntimeToolCatalogParams {
  allTools: Record<string, McpToolDef[]>;
  selectedTools: Record<string, McpToolDef[]>;
}

export function resolveDynamicToolBudget(value: string | undefined): number {
  const trimmed = value?.trim();
  if (!trimmed) return 48;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) return 48;
  return Math.floor(parsed);
}

function intentBoost(
  entry: ToolCatalogEntry,
  primaryIntent: ToolIntent
): number {
  if (primaryIntent === "unknown") return 0;
  return entry.intent === primaryIntent ? -1 : 0;
}

function compareEntries(
  primaryIntent: ToolIntent,
  left: ToolCatalogEntry,
  right: ToolCatalogEntry
): number {
  const priorityDelta =
    TOOL_PRIORITY_WEIGHT[left.priority] - TOOL_PRIORITY_WEIGHT[right.priority];
  if (priorityDelta !== 0) return priorityDelta;

  const intentDelta =
    intentBoost(left, primaryIntent) - intentBoost(right, primaryIntent);
  if (intentDelta !== 0) return intentDelta;

  const mcpDelta = left.mcpId.localeCompare(right.mcpId);
  if (mcpDelta !== 0) return mcpDelta;

  return left.originalIndex - right.originalIndex;
}

export function selectMcpToolsForTurn(
  params: SelectFlatMcpToolsForTurnParams
): SelectFlatMcpToolsForTurnResult;
export function selectMcpToolsForTurn(
  params: SelectMcpToolsForTurnParams
): SelectMcpToolsForTurnResult;
export function selectMcpToolsForTurn(
  params: SelectFlatMcpToolsForTurnParams | SelectMcpToolsForTurnParams
): SelectFlatMcpToolsForTurnResult | SelectMcpToolsForTurnResult {
  if ("toolsByMcp" in params) {
    const result = selectMcpToolsByMcpForTurn({
      toolsByMcp: params.toolsByMcp,
      message: params.userMessage,
      budget: params.maxProviderVisibleTools,
    });
    return {
      selected: result.selectedTools,
      trace: result.trace,
    };
  }

  const primaryIntent = classifyToolIntent(params.message);
  const budget = Math.max(0, Math.floor(params.budget));
  const entries = params.tools.map((tool, index) =>
    catalogEntryForTool(tool, index, params.mcpId)
  );
  const rankedEntries = [...entries].sort((left, right) =>
    compareEntries(primaryIntent, left, right)
  );
  const selectedEntries = rankedEntries.slice(0, budget);
  const selectedToolNames = new Set(
    selectedEntries.map((entry) => entry.name).filter(Boolean)
  );
  const omittedToolNames = entries
    .map((entry) => entry.name)
    .filter((name) => name && !selectedToolNames.has(name));
  const selectedTraceNames = selectedEntries.map((entry) => entry.name);

  return {
    selected: selectedEntries.map((entry) => entry.tool),
    trace: {
      primaryIntent,
      budget,
      totalTools: params.tools.length,
      selectedToolNames: selectedTraceNames,
      omittedToolNames,
      selected: selectedTraceNames,
      omitted: omittedToolNames,
    },
  };
}

function catalogToolKey(mcpId: string, toolName: string): string {
  return `${mcpId}\u0000${toolName}`;
}

function displayToolName(entry: ToolCatalogEntry): string {
  return entry.mcpId ? `${entry.mcpId}/${entry.name}` : entry.name;
}

export function selectMcpToolsByMcpForTurn(
  params: SelectMcpToolsByMcpForTurnParams
): SelectMcpToolsByMcpForTurnResult {
  const primaryIntent = classifyToolIntent(params.message);
  const budget = Math.max(0, Math.floor(params.budget));
  const entries: ToolCatalogEntry[] = [];
  let originalIndex = 0;

  for (const [mcpId, tools] of Object.entries(params.toolsByMcp)) {
    for (const tool of tools) {
      entries.push(catalogEntryForTool(tool, originalIndex, mcpId));
      originalIndex++;
    }
  }

  const rankedEntries = [...entries].sort((left, right) =>
    compareEntries(primaryIntent, left, right)
  );
  const selectedEntries = rankedEntries.slice(0, budget);
  const selectedKeys = new Set(
    selectedEntries.map((entry) => catalogToolKey(entry.mcpId, entry.name))
  );
  const selectedTools: Record<string, McpToolDef[]> = {};

  for (const entry of entries) {
    if (!selectedKeys.has(catalogToolKey(entry.mcpId, entry.name))) {
      continue;
    }
    const toolsForMcp = selectedTools[entry.mcpId] ?? [];
    toolsForMcp.push(entry.tool);
    selectedTools[entry.mcpId] = toolsForMcp;
  }

  const selectedTraceNames = selectedEntries.map(displayToolName);
  const omittedTraceNames = entries
    .filter(
      (entry) => !selectedKeys.has(catalogToolKey(entry.mcpId, entry.name))
    )
    .map(displayToolName);

  return {
    selectedTools,
    trace: {
      primaryIntent,
      budget,
      totalTools: entries.length,
      selectedToolNames: selectedTraceNames,
      omittedToolNames: omittedTraceNames,
      selected: selectedTraceNames,
      omitted: omittedTraceNames,
    },
  };
}

export function buildRuntimeToolCatalog(
  params: BuildRuntimeToolCatalogParams
): RuntimeToolCatalogEntry[] {
  const selectedToolKeys = new Set<string>();
  for (const [mcpId, tools] of Object.entries(params.selectedTools)) {
    for (const tool of tools) {
      selectedToolKeys.add(catalogToolKey(mcpId, tool.name || ""));
    }
  }

  const catalog: RuntimeToolCatalogEntry[] = [];
  for (const [mcpId, tools] of Object.entries(params.allTools)) {
    for (const [index, tool] of tools.entries()) {
      const entry = catalogEntryForTool(tool, index, mcpId);
      catalog.push({
        ...entry,
        availableThisTurn: selectedToolKeys.has(
          catalogToolKey(mcpId, entry.name)
        ),
      });
    }
  }
  return catalog;
}
