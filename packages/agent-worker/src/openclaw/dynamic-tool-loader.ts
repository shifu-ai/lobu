import type { McpToolDef } from "@lobu/core";
import {
  catalogEntryForTool,
  isTrustedShifuCalendarResolver,
  isReservedAutomationToolName,
  isTrustedShifuToolMetadataSource,
  TOOL_PRIORITY_WEIGHT,
  type McpCatalogProvenanceById,
  type ToolCatalogEntry,
} from "./tool-catalog";

export {
  type BuildRuntimeToolCatalogParams,
  buildRuntimeToolCatalog,
  type RuntimeToolCatalogEntry,
} from "./tool-catalog-dispatcher";

import {
  classifyToolIntent,
  hasCalendarDateIntent,
  type ToolIntent,
} from "./tool-intent";

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
  mcpProvenanceById?: McpCatalogProvenanceById;
  trustedShifuToolboxOrigins?: ReadonlySet<string>;
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
  mcpProvenanceById?: McpCatalogProvenanceById;
  trustedShifuToolboxOrigins?: ReadonlySet<string>;
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
  mcpProvenanceById?: McpCatalogProvenanceById;
  trustedShifuToolboxOrigins?: ReadonlySet<string>;
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

function isPinnedDirectTool(
  entry: ToolCatalogEntry,
  primaryIntent: ToolIntent,
  provenanceById: McpCatalogProvenanceById | undefined,
  trustedOrigins: ReadonlySet<string> | undefined,
  calendarAssist: boolean
): boolean {
  return (
    PINNED_DIRECT_TOOL_NAMES.has(entry.name) ||
    entry.name.startsWith("sales_battle_report_") ||
    ((primaryIntent === "calendar" || calendarAssist) &&
      isTrustedShifuCalendarResolver({
        tool: entry.tool,
        mcpId: entry.mcpId,
        provenance: provenanceById?.[entry.mcpId],
        trustedOrigins,
      })) ||
    (primaryIntent === "automation" &&
      entry.domain === "automation" &&
      isTrustedShifuToolMetadataSource({
        mcpId: entry.mcpId,
        provenance: provenanceById?.[entry.mcpId],
        trustedOrigins,
      }) &&
      PINNED_TOOLBOX_AUTOMATION_TOOL_NAMES.has(entry.name))
  );
}

function pinnedPreference(
  entry: ToolCatalogEntry,
  primaryIntent: ToolIntent,
  provenanceById: McpCatalogProvenanceById | undefined,
  trustedOrigins: ReadonlySet<string> | undefined,
  calendarAssist: boolean
): number {
  if (
    primaryIntent === "automation" &&
    entry.domain === "automation" &&
    PINNED_TOOLBOX_AUTOMATION_TOOL_NAMES.has(entry.name) &&
    isTrustedShifuToolMetadataSource({
      mcpId: entry.mcpId,
      provenance: provenanceById?.[entry.mcpId],
      trustedOrigins,
    })
  ) {
    return 0;
  }
  if (
    (primaryIntent === "calendar" || calendarAssist) &&
    isTrustedShifuCalendarResolver({
      tool: entry.tool,
      mcpId: entry.mcpId,
      provenance: provenanceById?.[entry.mcpId],
      trustedOrigins,
    })
  ) {
    return primaryIntent === "calendar" ? 0 : 1;
  }
  return 2;
}

function selectRankedEntries(
  entries: ToolCatalogEntry[],
  primaryIntent: ToolIntent,
  budget: number,
  provenanceById?: McpCatalogProvenanceById,
  trustedOrigins?: ReadonlySet<string>,
  calendarAssist = false
): {
  selectedEntries: ToolCatalogEntry[];
  pinnedBudgetOverflow: ToolCatalogEntry[];
} {
  const pinnedEntries = entries
    .filter((entry) =>
      isPinnedDirectTool(
        entry,
        primaryIntent,
        provenanceById,
        trustedOrigins,
        calendarAssist
      )
    )
    .sort((left, right) => {
      const preferenceDelta =
        pinnedPreference(
          left,
          primaryIntent,
          provenanceById,
          trustedOrigins,
          calendarAssist
        ) -
        pinnedPreference(
          right,
          primaryIntent,
          provenanceById,
          trustedOrigins,
          calendarAssist
        );
      return preferenceDelta || compareEntries(primaryIntent, left, right);
    });
  const nonPinnedEntries = entries
    .filter(
      (entry) =>
        !isPinnedDirectTool(
          entry,
          primaryIntent,
          provenanceById,
          trustedOrigins,
          calendarAssist
        )
    )
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
      mcpProvenanceById: params.mcpProvenanceById,
      trustedShifuToolboxOrigins: params.trustedShifuToolboxOrigins,
    });
    return {
      selected: result.selectedTools,
      trace: result.trace,
    };
  }

  const primaryIntent = classifyToolIntent(params.message);
  const calendarAssist =
    primaryIntent === "automation" &&
    hasCalendarDateIntent(params.message.toLowerCase());
  const budget = Math.max(0, Math.floor(params.budget));
  const entries = params.tools
    .map((tool, index) =>
      catalogEntryForTool(tool, index, params.mcpId, {
        provenance: params.mcpProvenanceById?.[params.mcpId || ""],
        trustedOrigins: params.trustedShifuToolboxOrigins,
      })
    )
    .filter(
      (entry) =>
        !params.isToolAllowed || params.isToolAllowed(entry.name, entry.mcpId)
    )
    .filter(
      (entry) =>
        !isReservedAutomationToolName(entry.name) ||
        isTrustedShifuToolMetadataSource({
          mcpId: entry.mcpId,
          provenance: params.mcpProvenanceById?.[entry.mcpId],
          trustedOrigins: params.trustedShifuToolboxOrigins,
        })
    )
    .filter(
      (entry) =>
        entry.name !== "resolve_calendar_date" ||
        isTrustedShifuCalendarResolver({
          tool: entry.tool,
          mcpId: entry.mcpId,
          provenance: params.mcpProvenanceById?.[entry.mcpId],
          trustedOrigins: params.trustedShifuToolboxOrigins,
        })
    )
    .filter(
      (entry) =>
        (primaryIntent === "automation" || entry.domain !== "automation") &&
        (primaryIntent === "calendar" ||
          calendarAssist ||
          entry.domain !== "calendar")
    );
  const { selectedEntries, pinnedBudgetOverflow } = selectRankedEntries(
    entries,
    primaryIntent,
    budget,
    params.mcpProvenanceById,
    params.trustedShifuToolboxOrigins,
    calendarAssist
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
  const calendarAssist =
    primaryIntent === "automation" &&
    hasCalendarDateIntent(params.message.toLowerCase());
  const budget = Math.max(0, Math.floor(params.budget));
  const entries: ToolCatalogEntry[] = [];
  let originalIndex = 0;

  for (const [mcpId, tools] of Object.entries(params.toolsByMcp)) {
    for (const tool of tools) {
      const entry = catalogEntryForTool(tool, originalIndex, mcpId, {
        provenance: params.mcpProvenanceById?.[mcpId],
        trustedOrigins: params.trustedShifuToolboxOrigins,
      });
      originalIndex++;
      if (
        params.isToolAllowed &&
        !params.isToolAllowed(entry.name, entry.mcpId)
      ) {
        continue;
      }
      if (
        isReservedAutomationToolName(entry.name) &&
        !isTrustedShifuToolMetadataSource({
          mcpId: entry.mcpId,
          provenance: params.mcpProvenanceById?.[entry.mcpId],
          trustedOrigins: params.trustedShifuToolboxOrigins,
        })
      ) {
        continue;
      }
      if (
        entry.name === "resolve_calendar_date" &&
        !isTrustedShifuCalendarResolver({
          tool: entry.tool,
          mcpId: entry.mcpId,
          provenance: params.mcpProvenanceById?.[entry.mcpId],
          trustedOrigins: params.trustedShifuToolboxOrigins,
        })
      ) {
        continue;
      }
      if (primaryIntent !== "automation" && entry.domain === "automation") {
        continue;
      }
      if (
        primaryIntent !== "calendar" &&
        !calendarAssist &&
        entry.domain === "calendar"
      ) {
        continue;
      }
      entries.push(entry);
    }
  }

  const { selectedEntries, pinnedBudgetOverflow } = selectRankedEntries(
    entries,
    primaryIntent,
    budget,
    params.mcpProvenanceById,
    params.trustedShifuToolboxOrigins,
    calendarAssist
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
