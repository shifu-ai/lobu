import type { McpToolDef } from "@lobu/core";
import {
  catalogEntryForTool,
  isTrustedShifuToolMetadataMcpId,
  TOOL_PRIORITY_WEIGHT,
  type ToolCatalogEntry,
} from "./tool-catalog";

export {
  type BuildRuntimeToolCatalogParams,
  buildRuntimeToolCatalog,
  type RuntimeToolCatalogEntry,
} from "./tool-catalog-dispatcher";

import { classifyToolIntent, type ToolIntent } from "./tool-intent";

export interface DynamicToolSelectionTrace {
  primaryIntent: ToolIntent;
  budget: number;
  totalTools: number;
  selectedToolNames: string[];
  omittedToolNames: string[];
  pinnedBudgetOverflow: string[];
  selected: string[];
  omitted: string[];
}

export interface SelectMcpToolsForTurnParams {
  tools: McpToolDef[];
  message: string;
  budget: number;
  mcpId?: string;
  isToolAllowed?: (toolName: string, mcpId: string) => boolean;
}

export interface SelectMcpToolsForTurnResult {
  selected: McpToolDef[];
  trace: DynamicToolSelectionTrace;
}

export interface SelectGroupedMcpToolsForTurnParams {
  toolsByMcp: Record<string, McpToolDef[]>;
  userMessage: string;
  maxProviderVisibleTools: number;
  isToolAllowed?: (toolName: string, mcpId: string) => boolean;
}

export interface SelectGroupedMcpToolsForTurnResult {
  selected: Record<string, McpToolDef[]>;
  trace: DynamicToolSelectionTrace;
}

export interface SelectMcpToolsByMcpForTurnParams {
  toolsByMcp: Record<string, McpToolDef[]>;
  message: string;
  budget: number;
  isToolAllowed?: (toolName: string, mcpId: string) => boolean;
}

export interface SelectMcpToolsByMcpForTurnResult {
  selectedTools: Record<string, McpToolDef[]>;
  trace: DynamicToolSelectionTrace;
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

const PINNED_DIRECT_TOOL_NAMES = new Set([
  "tool_search",
  "tool_call",
  "tool_status",
  "meeting_list",
  "meeting_get",
  "meeting_search",
  "submit_course_pm_profile",
  "search_memory",
  "save_memory",
  "sales_battle_report_schedule_list",
  "sales_battle_report_schedule_create",
  "sales_battle_report_schedule_pause",
  "sales_battle_report_schedule_update",
  "sales_battle_report_run_now",
]);

const PINNED_TOOLBOX_AUTOMATION_TOOL_NAMES = new Set([
  "plan_automation",
  "create_automation",
]);

function isPinnedDirectTool(entry: ToolCatalogEntry): boolean {
  return (
    PINNED_DIRECT_TOOL_NAMES.has(entry.name) ||
    entry.name.startsWith("sales_battle_report_") ||
    (isTrustedShifuToolMetadataMcpId(entry.mcpId) &&
      PINNED_TOOLBOX_AUTOMATION_TOOL_NAMES.has(entry.name))
  );
}

function selectRankedEntries(
  entries: ToolCatalogEntry[],
  primaryIntent: ToolIntent,
  budget: number
): {
  selectedEntries: ToolCatalogEntry[];
  pinnedBudgetOverflow: ToolCatalogEntry[];
} {
  const pinnedEntries = entries
    .filter(isPinnedDirectTool)
    .sort((left, right) => compareEntries(primaryIntent, left, right));
  const nonPinnedEntries = entries
    .filter((entry) => !isPinnedDirectTool(entry))
    .sort((left, right) => compareEntries(primaryIntent, left, right));
  const rankedEntries = [...pinnedEntries, ...nonPinnedEntries];

  return {
    selectedEntries: rankedEntries.slice(0, budget),
    pinnedBudgetOverflow: pinnedEntries.slice(budget),
  };
}

export function selectMcpToolsForTurn(
  params: SelectMcpToolsForTurnParams
): SelectMcpToolsForTurnResult;
export function selectMcpToolsForTurn(
  params: SelectGroupedMcpToolsForTurnParams
): SelectGroupedMcpToolsForTurnResult;
export function selectMcpToolsForTurn(
  params: SelectMcpToolsForTurnParams | SelectGroupedMcpToolsForTurnParams
): SelectMcpToolsForTurnResult | SelectGroupedMcpToolsForTurnResult {
  if ("toolsByMcp" in params) {
    const result = selectMcpToolsByMcpForTurn({
      toolsByMcp: params.toolsByMcp,
      message: params.userMessage,
      budget: params.maxProviderVisibleTools,
      isToolAllowed: params.isToolAllowed,
    });
    return {
      selected: result.selectedTools,
      trace: result.trace,
    };
  }

  const primaryIntent = classifyToolIntent(params.message);
  const budget = Math.max(0, Math.floor(params.budget));
  const entries = params.tools
    .map((tool, index) => catalogEntryForTool(tool, index, params.mcpId))
    .filter(
      (entry) =>
        !params.isToolAllowed || params.isToolAllowed(entry.name, entry.mcpId)
    );
  const { selectedEntries, pinnedBudgetOverflow } = selectRankedEntries(
    entries,
    primaryIntent,
    budget
  );
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
      totalTools: entries.length,
      selectedToolNames: selectedTraceNames,
      omittedToolNames,
      pinnedBudgetOverflow: pinnedBudgetOverflow.map(displayToolName),
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
      const entry = catalogEntryForTool(tool, originalIndex, mcpId);
      originalIndex++;
      if (
        params.isToolAllowed &&
        !params.isToolAllowed(entry.name, entry.mcpId)
      ) {
        continue;
      }
      entries.push(entry);
    }
  }

  const { selectedEntries, pinnedBudgetOverflow } = selectRankedEntries(
    entries,
    primaryIntent,
    budget
  );
  const selectedKeys = new Set(
    selectedEntries.map((entry) => catalogToolKey(entry.mcpId, entry.name))
  );
  const selectedTools: Record<string, McpToolDef[]> = {};

  for (const entry of selectedEntries) {
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
      pinnedBudgetOverflow: pinnedBudgetOverflow.map(displayToolName),
      selected: selectedTraceNames,
      omitted: omittedTraceNames,
    },
  };
}
