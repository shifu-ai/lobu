import type { McpToolDef } from "@lobu/core";
import {
	catalogEntryForTool,
	TOOL_PRIORITY_WEIGHT,
	type ToolCatalogEntry,
} from "./tool-catalog";

export {
	type BuildRuntimeToolCatalogParams,
	buildRuntimeToolCatalog,
	type RuntimeToolCatalogEntry,
} from "./tool-catalog-dispatcher";

import { toolIdentityKey } from "./tool-descriptor";
import { classifyToolIntent, type ToolIntent } from "./tool-intent";
import {
	filterEligibleToolEntries,
	routeToolEntries,
	type ToolCandidateScore,
	type ToolRouteDecision,
} from "./tool-router";

export interface DynamicToolSelectionTrace {
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
	inventoryFingerprint: string;
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
	primaryIntent: ToolIntent,
): number {
	if (primaryIntent === "unknown") return 0;
	return entry.intent === primaryIntent ? -1 : 0;
}

function compareEntries(
	primaryIntent: ToolIntent,
	left: ToolCatalogEntry,
	right: ToolCatalogEntry,
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

function isPinnedDirectTool(entry: ToolCatalogEntry): boolean {
	return (
		PINNED_DIRECT_TOOL_NAMES.has(entry.name) ||
		entry.name.startsWith("sales_battle_report_")
	);
}

function selectRankedEntries(
	entries: ToolCatalogEntry[],
	primaryIntent: ToolIntent,
	budget: number,
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

interface SharedToolSelection {
	primaryIntent: ToolIntent;
	selectedEntries: ToolCatalogEntry[];
	eligibleEntries: ToolCatalogEntry[];
	pinnedBudgetOverflow: ToolCatalogEntry[];
	route: ToolRouteDecision;
}

function selectEntriesForTurn(
	entries: ToolCatalogEntry[],
	message: string,
	budget: number,
	allowedToolNames?: Iterable<string>,
): SharedToolSelection {
	const normalizedAllowedToolNames =
		allowedToolNames === undefined ? undefined : [...allowedToolNames];
	const eligibleEntries = filterEligibleToolEntries(
		entries,
		normalizedAllowedToolNames,
	);
	const primaryIntent = classifyToolIntent(message);
	const { selectedEntries: rankedEntries } = selectRankedEntries(
		entries,
		primaryIntent,
		entries.length,
	);
	const pinnedEntries = rankedEntries.filter(isPinnedDirectTool);
	const rankedForRouting = rankedEntries.map((entry, originalIndex) => ({
		...entry,
		originalIndex,
	}));
	const pinnedKeys = new Set(
		pinnedEntries.map((entry) => catalogToolKey(entry.mcpId, entry.name)),
	);
	const reservedEntries = rankedForRouting.filter((entry) =>
		pinnedKeys.has(catalogToolKey(entry.mcpId, entry.name)),
	);
	const route = routeToolEntries({
		entries: rankedForRouting,
		message,
		budget,
		reservedEntries,
		allowedToolNames: normalizedAllowedToolNames,
	});
	const eligibleKeys = new Set(
		eligibleEntries.map((entry) => catalogToolKey(entry.mcpId, entry.name)),
	);

	return {
		primaryIntent,
		selectedEntries: route.selectedEntries,
		eligibleEntries,
		pinnedBudgetOverflow: pinnedEntries
			.filter((entry) =>
				eligibleKeys.has(catalogToolKey(entry.mcpId, entry.name)),
			)
			.slice(budget),
		route,
	};
}

function routeTraceFields(
	route: ToolRouteDecision,
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
> {
	return {
		routerVersion: route.routerVersion,
		explicitDestinations: route.explicitDestinations,
		clarificationRequired: route.clarification !== undefined,
		blockedToolNames: route.clarification?.blockedToolNames ?? [],
		blockedToolKeys: route.clarification?.blockedToolKeys ?? [],
		blockedToolIdentityKeys: route.clarification?.blockedToolIdentityKeys ?? [],
		clarificationQuestion: route.clarification?.question,
		clarificationReason: route.clarification?.reason,
		clarificationChoices: route.clarification?.blockedToolNames,
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
	params: SelectMcpToolsForTurnParams,
): SelectMcpToolsForTurnResult;
export function selectMcpToolsForTurn(
	params: SelectGroupedMcpToolsForTurnParams,
): SelectGroupedMcpToolsForTurnResult;
export function selectMcpToolsForTurn(
	params: SelectMcpToolsForTurnParams | SelectGroupedMcpToolsForTurnParams,
): SelectMcpToolsForTurnResult | SelectGroupedMcpToolsForTurnResult {
	if ("toolsByMcp" in params) {
		const result = selectMcpToolsByMcpForTurn({
			toolsByMcp: params.toolsByMcp,
			message: params.userMessage,
			budget: params.maxProviderVisibleTools,
			allowedToolNames: params.allowedToolNames,
		});
		return {
			selected: result.selectedTools,
			trace: result.trace,
		};
	}

	const budget = Math.max(0, Math.floor(params.budget));
	const entries = params.tools.map((tool, index) =>
		catalogEntryForTool(tool, index, params.mcpId),
	);
	const {
		primaryIntent,
		selectedEntries,
		eligibleEntries,
		pinnedBudgetOverflow,
		route,
	} = selectEntriesForTurn(
		entries,
		params.message,
		budget,
		params.allowedToolNames,
	);
	const selectedKeys = new Set(
		selectedEntries.map((entry) => catalogToolKey(entry.mcpId, entry.name)),
	);
	const omittedToolNames = eligibleEntries
		.filter(
			(entry) => !selectedKeys.has(catalogToolKey(entry.mcpId, entry.name)),
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
			...routeTraceFields(route),
		},
	};
}

function catalogToolKey(mcpId: string, toolName: string): string {
	return toolIdentityKey(mcpId, toolName);
}

function displayToolName(entry: ToolCatalogEntry): string {
	return entry.mcpId ? `${entry.mcpId}/${entry.name}` : entry.name;
}

export function selectMcpToolsByMcpForTurn(
	params: SelectMcpToolsByMcpForTurnParams,
): SelectMcpToolsByMcpForTurnResult {
	const budget = Math.max(0, Math.floor(params.budget));
	const entries: ToolCatalogEntry[] = [];
	let originalIndex = 0;

	for (const [mcpId, tools] of Object.entries(params.toolsByMcp)) {
		for (const tool of tools) {
			entries.push(catalogEntryForTool(tool, originalIndex, mcpId));
			originalIndex++;
		}
	}

	const {
		primaryIntent,
		selectedEntries,
		eligibleEntries,
		pinnedBudgetOverflow,
		route,
	} = selectEntriesForTurn(
		entries,
		params.message,
		budget,
		params.allowedToolNames,
	);
	const selectedKeys = new Set(
		selectedEntries.map((entry) => catalogToolKey(entry.mcpId, entry.name)),
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
			(entry) => !selectedKeys.has(catalogToolKey(entry.mcpId, entry.name)),
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
			...routeTraceFields(route),
		},
	};
}
