import type { McpToolDef } from "@lobu/core";
import { classifyToolIntent, type ToolIntent } from "./tool-intent";

export type ToolDomain =
  | "battle_report"
  | "community_verification"
  | "sales_performance"
  | "card_studio"
  | "media_editing"
  | "unknown";

export type ToolPriority = "P0" | "P1" | "P2" | "P3";

export interface ToolCatalogEntry {
  tool: McpToolDef;
  name: string;
  mcpId: string;
  domain: ToolDomain;
  intent: ToolIntent;
  priority: ToolPriority;
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

export function catalogEntryForTool(
  tool: McpToolDef,
  originalIndex = 0,
  mcpId = ""
): ToolCatalogEntry {
  const name = tool.name || "";

  if (BATTLE_REPORT_P0_TOOLS.has(name)) {
    return {
      tool,
      name,
      mcpId,
      domain: "battle_report",
      intent: "battle_report",
      priority: "P0",
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
    originalIndex,
  };
}
