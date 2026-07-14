import type { McpToolDef } from "@lobu/core";
import {
  catalogEntryForTool,
  isReservedAutomationToolName,
  isTrustedShifuCalendarResolver,
  isTrustedShifuToolMetadataSource,
  type McpCatalogProvenanceById,
  TOOL_PRIORITY_WEIGHT,
  type ToolCatalogEntry,
} from "./tool-catalog";

export {
  type BuildRuntimeToolCatalogParams,
  buildRuntimeToolCatalog,
  type RuntimeToolCatalogEntry,
} from "./tool-catalog-dispatcher";

import { qualifiedToolKey, toolIdentityKey } from "./tool-descriptor";
import { isExplicitPersonalReminderAttempt } from "./mcp-execution-contract";
import {
  classifyToolIntent,
  hasCalendarDateIntent,
  type ToolIntent,
} from "./tool-intent";
import {
  filterEligibleToolEntries,
  routeToolEntries,
  type ToolCandidateScore,
  type ToolRouteDecision,
} from "./tool-router";
import { deriveTurnExecutionIntent } from "./turn-execution-intent";
import type { ToolRouterCacheContext } from "./tool-router-memory-budget";

export type PersonalReminderDeliveryBlockedReason =
  | "capability_inactive"
  | "snapshot_missing"
  | "snapshot_expired";

export interface DynamicToolSelectionTrace {
  routerMode: ToolRouterMode;
  semanticSelectedToolNames: string[];
  selectionDiverged: boolean;
  semanticClarificationRequired: boolean;
  semanticComputed: boolean;
  semanticLookupSkippedReason?: "definite_non_tool";
  primaryIntent: ToolIntent;
  budget: number;
  totalTools: number;
  eligibleToolCount: number;
  selectedToolNames: string[];
  omittedToolNames: string[];
  pinnedBudgetOverflow: string[];
  selected: string[];
  omitted: string[];
  routerVersion: "semantic-v1";
  explicitDestinations: string[];
  clarificationRequired: boolean;
  blockedToolNames: string[];
  blockedToolKeys: string[];
  blockedToolIdentityKeys: string[];
  clarificationQuestion?: string;
  clarificationReason?: string;
  clarificationChoices?: string[];
  candidates: ToolCandidateScore[];
  fallback: ToolRouteDecision["fallback"];
  /** Descriptor/retrieval-index fingerprint, not the final eligibility set. */
  inventoryFingerprint?: string;
  /** Final turn-local eligibility/release fingerprint, when projected by the worker. */
  effectiveToolInventoryFingerprint?: string;
  effectiveReleaseStatus?: "legacy_unenrolled" | "enrolled_inactive" | "active";
  effectiveReleaseReason?: string;
  configuredRouterMode?: ToolRouterMode;
  routerGateReason?: string;
  releaseEnvironment?: string;
  releaseAgentId?: string;
  releaseId?: string;
  releaseSequence?: number;
  releaseSnapshotDigest?: string;
  releaseSnapshotExpiresAt?: string;
  releaseSnapshotExpired?: boolean;
  executionIntent?: string;
  effectiveAllowedToolCount?: number;
  effectiveBlockedToolCount?: number;
  effectiveBlockedReasons?: string[];
  cacheHit: boolean;
  estimatedIndexBytes: number;
  cacheEvictionCount: number;
  candidateCount: number;
  timingMs: ToolRouteDecision["timingMs"];
}

export interface SelectMcpToolsForTurnParams {
  tools: McpToolDef[];
  message: string;
  budget: number;
  mcpId?: string;
  allowedToolNames?: Iterable<string>;
  routerMode?: ToolRouterMode;
  isToolAllowed?: (toolName: string, mcpId: string) => boolean;
  mcpProvenanceById?: McpCatalogProvenanceById;
  trustedShifuToolboxOrigins?: ReadonlySet<string>;
  personalReminderDeliveryBlockedReason?: PersonalReminderDeliveryBlockedReason;
  cacheContext?: ToolRouterCacheContext;
}

export interface SelectMcpToolsForTurnResult {
  selected: McpToolDef[];
  trace: DynamicToolSelectionTrace;
}

export interface SelectGroupedMcpToolsForTurnParams {
  toolsByMcp: Record<string, McpToolDef[]>;
  userMessage: string;
  maxProviderVisibleTools: number;
  allowedToolNames?: Iterable<string>;
  routerMode?: ToolRouterMode;
  isToolAllowed?: (toolName: string, mcpId: string) => boolean;
  mcpProvenanceById?: McpCatalogProvenanceById;
  trustedShifuToolboxOrigins?: ReadonlySet<string>;
  personalReminderDeliveryBlockedReason?: PersonalReminderDeliveryBlockedReason;
  cacheContext?: ToolRouterCacheContext;
}

export interface SelectGroupedMcpToolsForTurnResult {
  selected: Record<string, McpToolDef[]>;
  trace: DynamicToolSelectionTrace;
}

export interface SelectMcpToolsByMcpForTurnParams {
  toolsByMcp: Record<string, McpToolDef[]>;
  message: string;
  budget: number;
  allowedToolNames?: Iterable<string>;
  routerMode?: ToolRouterMode;
  isToolAllowed?: (toolName: string, mcpId: string) => boolean;
  mcpProvenanceById?: McpCatalogProvenanceById;
  trustedShifuToolboxOrigins?: ReadonlySet<string>;
  personalReminderDeliveryBlockedReason?: PersonalReminderDeliveryBlockedReason;
  cacheContext?: ToolRouterCacheContext;
}

function blocksPersonalReminderTool(
  params: {
    message: string;
    personalReminderDeliveryBlockedReason?: PersonalReminderDeliveryBlockedReason;
  },
  mcpId: string,
  toolName: string
): boolean {
  return (
    params.personalReminderDeliveryBlockedReason !== undefined &&
    isExplicitPersonalReminderAttempt({
      intent: deriveTurnExecutionIntent(params.message),
      mcpId,
      toolName,
    })
  );
}

export interface SelectMcpToolsByMcpForTurnResult {
  selectedTools: Record<string, McpToolDef[]>;
  trace: DynamicToolSelectionTrace;
}

export interface CliMcpToolEligibilityParams {
  tool: McpToolDef;
  mcpId: string;
  isToolAllowed?: (toolName: string, mcpId: string) => boolean;
  mcpProvenanceById?: McpCatalogProvenanceById;
  trustedShifuToolboxOrigins?: ReadonlySet<string>;
}

export function isMcpToolEligibleForCliExposure(
  params: CliMcpToolEligibilityParams
): boolean {
  const toolName = params.tool.name?.trim();
  if (!toolName) return false;
  if (params.isToolAllowed && !params.isToolAllowed(toolName, params.mcpId)) {
    return false;
  }
  if (
    isReservedAutomationToolName(toolName) &&
    !isTrustedShifuToolMetadataSource({
      mcpId: params.mcpId,
      provenance: params.mcpProvenanceById?.[params.mcpId],
      trustedOrigins: params.trustedShifuToolboxOrigins,
    })
  )
    return false;
  if (
    toolName === "resolve_calendar_date" &&
    !isTrustedShifuCalendarResolver({
      tool: params.tool,
      mcpId: params.mcpId,
      provenance: params.mcpProvenanceById?.[params.mcpId],
      trustedOrigins: params.trustedShifuToolboxOrigins,
    })
  )
    return false;
  return true;
}

export function filterMcpToolsForCliExposure(
  params: Omit<CliMcpToolEligibilityParams, "tool" | "mcpId"> & {
    toolsByMcp: Record<string, McpToolDef[]>;
  }
): Record<string, McpToolDef[]> {
  const filtered: Record<string, McpToolDef[]> = {};
  for (const [mcpId, tools] of Object.entries(params.toolsByMcp)) {
    const eligible = tools.filter((tool) =>
      isMcpToolEligibleForCliExposure({ ...params, tool, mcpId })
    );
    if (eligible.length > 0) filtered[mcpId] = eligible;
  }
  return filtered;
}

export function resolveDynamicToolBudget(value: string | undefined): number {
  const trimmed = value?.trim();
  if (!trimmed) return 48;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) return 48;
  return Math.floor(parsed);
}

export type ToolRouterMode = "legacy" | "shadow" | "semantic";

export function resolveToolRouterMode(
  value: string | undefined
): ToolRouterMode {
  if (value === "legacy" || value === "shadow" || value === "semantic") {
    return value;
  }
  return "shadow";
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
  provenanceById?: McpCatalogProvenanceById,
  trustedOrigins?: ReadonlySet<string>,
  calendarAssist = false
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
      PINNED_TOOLBOX_AUTOMATION_TOOL_NAMES.has(entry.name) &&
      isTrustedShifuToolMetadataSource({
        mcpId: entry.mcpId,
        provenance: provenanceById?.[entry.mcpId],
        trustedOrigins,
      }))
  );
}

function pinnedPreference(
  entry: ToolCatalogEntry,
  primaryIntent: ToolIntent,
  provenanceById?: McpCatalogProvenanceById,
  trustedOrigins?: ReadonlySet<string>,
  calendarAssist = false
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
  )
    return 0;
  if (
    (primaryIntent === "calendar" || calendarAssist) &&
    isTrustedShifuCalendarResolver({
      tool: entry.tool,
      mcpId: entry.mcpId,
      provenance: provenanceById?.[entry.mcpId],
      trustedOrigins,
    })
  )
    return primaryIntent === "calendar" ? 0 : 1;
  return 2;
}

function selectLegacyRankedEntries(
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
    .sort(
      (left, right) =>
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
          ) || compareEntries(primaryIntent, left, right)
    );
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

interface SharedToolSelection {
  primaryIntent: ToolIntent;
  selectedEntries: ToolCatalogEntry[];
  eligibleEntries: ToolCatalogEntry[];
  pinnedBudgetOverflow: ToolCatalogEntry[];
  route: ToolRouteDecision;
  routerMode: ToolRouterMode;
}

/** Only skip retrieval for high-confidence non-tool turns; unknown prose routes. */
function isDefiniteNonToolTurn(message: string): boolean {
  const normalized = message.trim().toLocaleLowerCase();
  if (!normalized) return true;
  if (
    /^(?:(?:ok|okay|thanks|thank you|got it|收到|好的|好|謝謝|谢谢|感謝|感谢|了解です|ありがとう|ありがとうございます|확인|알겠습니다|감사합니다)[,.，、!！。 ]*)+$/.test(
      normalized
    )
  ) {
    return true;
  }
  const reaction = normalized.replace(/[\uFE0E\uFE0F\s]/gu, "");
  return /^(?:👍|🙏|❤|❤️|👏|🙌|👌|✅|🙂|😊|🎉)+$/u.test(reaction);
}

function selectEntriesForTurn(
  entries: ToolCatalogEntry[],
  message: string,
  budget: number,
  allowedToolNames?: Iterable<string>,
  routerMode: ToolRouterMode = "shadow",
  provenanceById?: McpCatalogProvenanceById,
  trustedOrigins?: ReadonlySet<string>,
  calendarAssist = false,
  cacheContext?: ToolRouterCacheContext
): SharedToolSelection {
  const normalizedAllowedToolNames =
    allowedToolNames === undefined ? undefined : [...allowedToolNames];
  const eligibleEntries = filterEligibleToolEntries(
    entries,
    normalizedAllowedToolNames
  );
  const primaryIntent = classifyToolIntent(message);
  const legacySelection = selectLegacyRankedEntries(
    eligibleEntries,
    primaryIntent,
    budget,
    provenanceById,
    trustedOrigins,
    calendarAssist
  );
  if (!message.trim()) {
    return {
      primaryIntent,
      selectedEntries: [],
      eligibleEntries,
      pinnedBudgetOverflow: [],
      routerMode,
      route: {
        routerVersion: "semantic-v1",
        inventoryFingerprint: "empty-query",
        cacheHit: false,
        estimatedIndexBytes: 0,
        cacheEvictionCount: 0,
        timingMs: { build: 0, retrieve: 0, rank: 0 },
        selectedEntries: [],
        candidates: [],
        explicitDestinations: [],
        fallback: "empty_query",
        semanticLookupSkippedReason: "definite_non_tool",
      },
    };
  }
  if (routerMode === "legacy") {
    return {
      primaryIntent,
      selectedEntries: legacySelection.selectedEntries,
      eligibleEntries,
      pinnedBudgetOverflow: legacySelection.pinnedBudgetOverflow,
      routerMode,
      route: {
        routerVersion: "semantic-v1",
        inventoryFingerprint: "legacy-bypass",
        cacheHit: false,
        estimatedIndexBytes: 0,
        cacheEvictionCount: 0,
        timingMs: { build: 0, retrieve: 0, rank: 0 },
        selectedEntries: legacySelection.selectedEntries,
        candidates: [],
        explicitDestinations: [],
        fallback: null,
      },
    };
  }
  if (isDefiniteNonToolTurn(message)) {
    return {
      primaryIntent,
      selectedEntries: legacySelection.selectedEntries,
      eligibleEntries,
      pinnedBudgetOverflow: legacySelection.pinnedBudgetOverflow,
      routerMode,
      route: {
        routerVersion: "semantic-v1",
        cacheHit: false,
        estimatedIndexBytes: 0,
        cacheEvictionCount: 0,
        timingMs: { build: 0, retrieve: 0, rank: 0 },
        selectedEntries: legacySelection.selectedEntries,
        candidates: [],
        explicitDestinations: [],
        fallback: "empty_query",
        semanticLookupSkippedReason: "definite_non_tool",
      },
    };
  }
  const { selectedEntries: rankedEntries } = selectLegacyRankedEntries(
    entries,
    primaryIntent,
    entries.length,
    provenanceById,
    trustedOrigins,
    calendarAssist
  );
  const pinnedEntries = rankedEntries.filter((entry) =>
    isPinnedDirectTool(
      entry,
      primaryIntent,
      provenanceById,
      trustedOrigins,
      calendarAssist
    )
  );
  const rankedForRouting = rankedEntries.map((entry, originalIndex) => ({
    ...entry,
    originalIndex,
  }));
  const pinnedKeys = new Set(
    pinnedEntries.map((entry) => catalogToolKey(entry.mcpId, entry.name))
  );
  const reservedEntries = rankedForRouting.filter((entry) =>
    pinnedKeys.has(catalogToolKey(entry.mcpId, entry.name))
  );
  const route = routeToolEntries({
    entries: rankedForRouting,
    message,
    budget,
    reservedEntries,
    allowedToolNames: normalizedAllowedToolNames,
    cacheContext,
  });
  return {
    primaryIntent,
    selectedEntries:
      routerMode === "semantic"
        ? route.selectedEntries
        : legacySelection.selectedEntries,
    eligibleEntries,
    pinnedBudgetOverflow: legacySelection.pinnedBudgetOverflow,
    route,
    routerMode,
  };
}

function routeTraceFields(
  route: ToolRouteDecision,
  routerMode: ToolRouterMode,
  selectedEntries: ToolCatalogEntry[]
): Pick<
  DynamicToolSelectionTrace,
  | "routerVersion"
  | "explicitDestinations"
  | "clarificationRequired"
  | "blockedToolNames"
  | "blockedToolKeys"
  | "blockedToolIdentityKeys"
  | "candidates"
  | "fallback"
  | "inventoryFingerprint"
  | "cacheHit"
  | "estimatedIndexBytes"
  | "cacheEvictionCount"
  | "candidateCount"
  | "timingMs"
  | "clarificationQuestion"
  | "clarificationReason"
  | "clarificationChoices"
  | "routerMode"
  | "semanticSelectedToolNames"
  | "selectionDiverged"
  | "semanticClarificationRequired"
  | "semanticComputed"
  | "semanticLookupSkippedReason"
> {
  const selectedToolNames = selectedEntries.map(displayToolName);
  const semanticSelectedToolNames = route.selectedEntries.map(displayToolName);
  const semanticEnforced = routerMode === "semantic";
  return {
    routerMode,
    semanticSelectedToolNames,
    selectionDiverged:
      selectedToolNames.length !== semanticSelectedToolNames.length ||
      selectedToolNames.some(
        (name, index) => name !== semanticSelectedToolNames[index]
      ),
    semanticClarificationRequired: route.clarification !== undefined,
    semanticComputed:
      routerMode !== "legacy" &&
      route.semanticLookupSkippedReason === undefined,
    semanticLookupSkippedReason: route.semanticLookupSkippedReason,
    routerVersion: route.routerVersion,
    explicitDestinations: route.explicitDestinations,
    clarificationRequired:
      semanticEnforced && route.clarification !== undefined,
    blockedToolNames: semanticEnforced
      ? (route.clarification?.blockedToolNames ?? [])
      : [],
    blockedToolKeys: semanticEnforced
      ? (route.clarification?.blockedToolKeys ?? [])
      : [],
    blockedToolIdentityKeys: semanticEnforced
      ? (route.clarification?.blockedToolIdentityKeys ?? [])
      : [],
    clarificationQuestion: semanticEnforced
      ? route.clarification?.question
      : undefined,
    clarificationReason: semanticEnforced
      ? route.clarification?.reason
      : undefined,
    clarificationChoices: semanticEnforced
      ? route.clarification?.blockedToolNames
      : undefined,
    candidates: route.candidates,
    fallback: route.fallback,
    inventoryFingerprint: route.inventoryFingerprint,
    cacheHit: route.cacheHit,
    estimatedIndexBytes: route.estimatedIndexBytes,
    cacheEvictionCount: route.cacheEvictionCount,
    candidateCount: route.candidates.length,
    timingMs: route.timingMs,
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
      allowedToolNames: params.allowedToolNames,
      routerMode: params.routerMode,
      isToolAllowed: params.isToolAllowed,
      mcpProvenanceById: params.mcpProvenanceById,
      trustedShifuToolboxOrigins: params.trustedShifuToolboxOrigins,
      personalReminderDeliveryBlockedReason:
        params.personalReminderDeliveryBlockedReason,
    });
    return {
      selected: result.selectedTools,
      trace: result.trace,
    };
  }

  const budget = Math.max(0, Math.floor(params.budget));
  const intentForEligibility = classifyToolIntent(params.message);
  const calendarAssist =
    intentForEligibility === "automation" &&
    hasCalendarDateIntent(params.message.toLowerCase());
  const mcpId = params.mcpId ?? "";
  const entries = params.tools
    .map((tool, index) =>
      catalogEntryForTool(tool, index, params.mcpId, {
        provenance: params.mcpProvenanceById?.[mcpId],
        trustedOrigins: params.trustedShifuToolboxOrigins,
      })
    )
    .filter((entry) =>
      isMcpToolEligibleForCliExposure({
        tool: entry.tool,
        mcpId: entry.mcpId,
        isToolAllowed: params.isToolAllowed,
        mcpProvenanceById: params.mcpProvenanceById,
        trustedShifuToolboxOrigins: params.trustedShifuToolboxOrigins,
      })
    )
    .filter(
      (entry) =>
        !blocksPersonalReminderTool(
          {
            message: params.message,
            personalReminderDeliveryBlockedReason:
              params.personalReminderDeliveryBlockedReason,
          },
          entry.mcpId,
          entry.name
        )
    )
    .filter(
      (entry) =>
        (intentForEligibility === "automation" ||
          entry.domain !== "automation") &&
        (intentForEligibility === "calendar" ||
          calendarAssist ||
          entry.domain !== "calendar")
    );
  const {
    primaryIntent,
    selectedEntries,
    eligibleEntries,
    pinnedBudgetOverflow,
    route,
    routerMode,
  } = selectEntriesForTurn(
    entries,
    params.message,
    budget,
    params.allowedToolNames,
    params.routerMode,
    params.mcpProvenanceById,
    params.trustedShifuToolboxOrigins,
    calendarAssist,
    params.cacheContext
  );
  const selectedKeys = new Set(
    selectedEntries.map((entry) => catalogToolKey(entry.mcpId, entry.name))
  );
  const omittedToolNames = eligibleEntries
    .filter(
      (entry) => !selectedKeys.has(catalogToolKey(entry.mcpId, entry.name))
    )
    .map((entry) => entry.name)
    .filter(Boolean);
  const selectedTraceNames = selectedEntries.map((entry) => entry.name);

  return {
    selected: selectedEntries.map((entry) => entry.tool),
    trace: {
      primaryIntent,
      budget,
      totalTools: entries.length,
      eligibleToolCount: eligibleEntries.length,
      selectedToolNames: selectedTraceNames,
      omittedToolNames,
      pinnedBudgetOverflow: pinnedBudgetOverflow.map(displayToolName),
      selected: selectedTraceNames,
      omitted: omittedToolNames,
      ...routeTraceFields(route, routerMode, selectedEntries),
    },
  };
}

function catalogToolKey(mcpId: string, toolName: string): string {
  return toolIdentityKey(mcpId, toolName);
}

function displayToolName(entry: ToolCatalogEntry): string {
  return entry.mcpId ? qualifiedToolKey(entry.mcpId, entry.name) : entry.name;
}

export function selectMcpToolsByMcpForTurn(
  params: SelectMcpToolsByMcpForTurnParams
): SelectMcpToolsByMcpForTurnResult {
  const budget = Math.max(0, Math.floor(params.budget));
  const intentForEligibility = classifyToolIntent(params.message);
  const calendarAssist =
    intentForEligibility === "automation" &&
    hasCalendarDateIntent(params.message.toLowerCase());
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
        !isMcpToolEligibleForCliExposure({
          tool: entry.tool,
          mcpId,
          isToolAllowed: params.isToolAllowed,
          mcpProvenanceById: params.mcpProvenanceById,
          trustedShifuToolboxOrigins: params.trustedShifuToolboxOrigins,
        })
      )
        continue;
      if (blocksPersonalReminderTool(params, mcpId, entry.name)) continue;
      if (
        intentForEligibility !== "automation" &&
        entry.domain === "automation"
      )
        continue;
      if (
        intentForEligibility !== "calendar" &&
        !calendarAssist &&
        entry.domain === "calendar"
      )
        continue;
      entries.push(entry);
    }
  }

  const {
    primaryIntent,
    selectedEntries,
    eligibleEntries,
    pinnedBudgetOverflow,
    route,
    routerMode,
  } = selectEntriesForTurn(
    entries,
    params.message,
    budget,
    params.allowedToolNames,
    params.routerMode,
    params.mcpProvenanceById,
    params.trustedShifuToolboxOrigins,
    calendarAssist,
    params.cacheContext
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
  const omittedTraceNames = eligibleEntries
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
      eligibleToolCount: eligibleEntries.length,
      selectedToolNames: selectedTraceNames,
      omittedToolNames: omittedTraceNames,
      pinnedBudgetOverflow: pinnedBudgetOverflow.map(displayToolName),
      selected: selectedTraceNames,
      omitted: omittedTraceNames,
      ...routeTraceFields(route, routerMode, selectedEntries),
    },
  };
}
