import type { McpToolDef } from "@lobu/core";
import { classifyToolIntent, type ToolIntent } from "./tool-intent";

export type ToolDomain =
  | "battle_report"
  | "community_verification"
  | "course_context"
  | "sales_performance"
  | "workspace_docs"
  | "diagnostics"
  | "card_studio"
  | "media_editing"
  | "unknown";

export type ToolPriority = "P0" | "P1" | "P2" | "P3";
export type ToolFreshness = "realtime" | "near_realtime" | "batch";

export interface ToolCatalogEntry {
  tool: McpToolDef;
  name: string;
  mcpId: string;
  domain: ToolDomain;
  intent: ToolIntent;
  priority: ToolPriority;
  aliases: string[];
  readOnly: boolean;
  mutatesState: boolean;
  requiresConfirmation: boolean;
  freshness?: ToolFreshness;
  originalIndex: number;
}

export const TOOL_PRIORITY_WEIGHT: Record<ToolPriority, number> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
};

const BATTLE_REPORT_P0_TOOLS = new Set([
  "sales_battle_report_schedule_list",
  "sales_battle_report_schedule_create",
  "sales_battle_report_schedule_pause",
  "sales_battle_report_schedule_update",
  "sales_battle_report_run_now",
]);

const KNOWN_TOOL_DOMAINS = new Set<ToolDomain>([
  "battle_report",
  "community_verification",
  "course_context",
  "sales_performance",
  "workspace_docs",
  "diagnostics",
  "card_studio",
  "media_editing",
  "unknown",
]);

const KNOWN_TOOL_PRIORITIES = new Set<ToolPriority>(["P0", "P1", "P2", "P3"]);

const KNOWN_TOOL_FRESHNESS = new Set<ToolFreshness>([
  "realtime",
  "near_realtime",
  "batch",
]);

interface ShifuToolMetadata {
  domain: ToolDomain;
  priority: ToolPriority;
  aliases: string[];
  readOnly: boolean;
  mutatesState: boolean;
  requiresConfirmation: boolean;
  freshness?: ToolFreshness;
}

function defaultCatalogMetadata(): Pick<
  ToolCatalogEntry,
  "aliases" | "readOnly" | "mutatesState" | "requiresConfirmation" | "freshness"
> {
  return {
    aliases: [],
    readOnly: true,
    mutatesState: false,
    requiresConfirmation: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseShifuToolMetadata(tool: McpToolDef): ShifuToolMetadata | null {
  const looseTool = tool as unknown as {
    _meta?: { shifuTool?: unknown };
    annotations?: { shifuTool?: unknown };
  };
  const rawMetadata =
    looseTool._meta?.shifuTool ?? looseTool.annotations?.shifuTool;

  if (!isRecord(rawMetadata)) return null;
  if (
    typeof rawMetadata.priority !== "string" ||
    !KNOWN_TOOL_PRIORITIES.has(rawMetadata.priority as ToolPriority)
  ) {
    return null;
  }

  const domain =
    typeof rawMetadata.domain === "string" &&
    KNOWN_TOOL_DOMAINS.has(rawMetadata.domain as ToolDomain)
      ? (rawMetadata.domain as ToolDomain)
      : "unknown";
  const freshness =
    typeof rawMetadata.freshness === "string" &&
    KNOWN_TOOL_FRESHNESS.has(rawMetadata.freshness as ToolFreshness)
      ? (rawMetadata.freshness as ToolFreshness)
      : undefined;

  return {
    domain,
    priority: rawMetadata.priority as ToolPriority,
    aliases: Array.isArray(rawMetadata.aliases)
      ? rawMetadata.aliases.filter((alias) => typeof alias === "string")
      : [],
    readOnly:
      typeof rawMetadata.readOnly === "boolean" ? rawMetadata.readOnly : true,
    mutatesState:
      typeof rawMetadata.mutatesState === "boolean"
        ? rawMetadata.mutatesState
        : false,
    requiresConfirmation:
      typeof rawMetadata.requiresConfirmation === "boolean"
        ? rawMetadata.requiresConfirmation
        : false,
    freshness,
  };
}

export function catalogEntryForTool(
  tool: McpToolDef,
  originalIndex = 0,
  mcpId = ""
): ToolCatalogEntry {
  const name = tool.name || "";
  const shifuMetadata = parseShifuToolMetadata(tool);

  if (shifuMetadata) {
    return {
      tool,
      name,
      mcpId,
      domain: shifuMetadata.domain,
      intent: shifuMetadata.domain,
      priority: shifuMetadata.priority,
      aliases: shifuMetadata.aliases,
      readOnly: shifuMetadata.readOnly,
      mutatesState: shifuMetadata.mutatesState,
      requiresConfirmation: shifuMetadata.requiresConfirmation,
      freshness: shifuMetadata.freshness,
      originalIndex,
    };
  }

  if (BATTLE_REPORT_P0_TOOLS.has(name)) {
    return {
      tool,
      name,
      mcpId,
      domain: "battle_report",
      intent: "battle_report",
      priority: "P0",
      ...defaultCatalogMetadata(),
      originalIndex,
    };
  }

  if (name.startsWith("card_studio_")) {
    return {
      tool,
      name,
      mcpId,
      domain: "card_studio",
      intent: "card_studio",
      priority: "P3",
      ...defaultCatalogMetadata(),
      originalIndex,
    };
  }

  const intent = classifyToolIntent(
    [name, tool.description || ""].filter(Boolean).join(" ")
  );

  return {
    tool,
    name,
    mcpId,
    domain: intent,
    intent,
    priority: "P2",
    ...defaultCatalogMetadata(),
    originalIndex,
  };
}
