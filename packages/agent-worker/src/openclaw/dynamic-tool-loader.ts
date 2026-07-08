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
}

export interface SelectMcpToolsForTurnParams {
  tools: McpToolDef[];
  message: string;
  budget: number;
  mcpId?: string;
}

export interface SelectMcpToolsForTurnResult {
  selected: McpToolDef[];
  trace: DynamicToolSelectionTrace;
}

function intentBoost(entry: ToolCatalogEntry, primaryIntent: ToolIntent): number {
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
  params: SelectMcpToolsForTurnParams
): SelectMcpToolsForTurnResult {
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

  return {
    selected: selectedEntries.map((entry) => entry.tool),
    trace: {
      primaryIntent,
      budget,
      totalTools: params.tools.length,
      selectedToolNames: selectedEntries.map((entry) => entry.name),
      omittedToolNames,
    },
  };
}
