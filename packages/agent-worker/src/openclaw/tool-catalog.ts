import { isReservedAutomationToolName, type McpToolDef } from "@lobu/core";
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
  | "automation"
  | "calendar"
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

export interface McpCatalogProvenance {
  upstreamOrigin?: string;
  configSource?: "global" | "agent" | "derived";
  configDigest?: string;
}

export type McpCatalogProvenanceById = Record<
  string,
  McpCatalogProvenance | undefined
>;

const SHIFU_TOOLBOX_MCP_ID = "shifu-toolbox";
export const SHIFU_CALENDAR_RESOLVER_TOOL_NAME = "resolve_calendar_date";
const DEFAULT_TRUSTED_SHIFU_TOOLBOX_ORIGIN = "https://mcp.shifu-ai.org";
const MAX_TRUSTED_SHIFU_TOOLBOX_ORIGINS = 8;

function canonicalHttpsOrigin(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

export function resolveTrustedShifuToolboxOrigins(
  configuredValue: string | undefined
): ReadonlySet<string> {
  const rawOrigins = configuredValue?.trim()
    ? configuredValue.split(",")
    : [DEFAULT_TRUSTED_SHIFU_TOOLBOX_ORIGIN];
  const origins = new Set<string>();
  for (const rawOrigin of rawOrigins.slice(
    0,
    MAX_TRUSTED_SHIFU_TOOLBOX_ORIGINS
  )) {
    const configuredOrigin = rawOrigin.trim();
    const canonical = canonicalHttpsOrigin(configuredOrigin);
    if (!canonical) continue;
    let parsed: URL;
    try {
      parsed = new URL(configuredOrigin);
    } catch {
      continue;
    }
    if (
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash ||
      (configuredOrigin !== canonical && configuredOrigin !== `${canonical}/`)
    ) {
      continue;
    }
    origins.add(canonical);
  }
  return origins;
}

export function isTrustedShifuToolMetadataSource(params: {
  mcpId: string;
  provenance?: McpCatalogProvenance;
  trustedOrigins?: ReadonlySet<string>;
}): boolean {
  if (
    params.mcpId !== SHIFU_TOOLBOX_MCP_ID ||
    params.provenance?.configSource !== "agent" ||
    !params.provenance.configDigest
  ) {
    return false;
  }
  const assertedOrigin = params.provenance.upstreamOrigin?.trim();
  const upstreamOrigin = assertedOrigin
    ? canonicalHttpsOrigin(assertedOrigin)
    : null;
  return Boolean(
    upstreamOrigin === assertedOrigin &&
      params.trustedOrigins?.has(upstreamOrigin)
  );
}

export { isReservedAutomationToolName };

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
  "automation",
  "calendar",
  "unknown",
]);

const SHIFU_CALENDAR_RESOLVER_ALIASES = [
  "relative_date",
  "date",
  "weekday",
  "日期",
  "星期",
];

export function isTrustedShifuCalendarResolver(params: {
  tool: McpToolDef;
  mcpId: string;
  provenance?: McpCatalogProvenance;
  trustedOrigins?: ReadonlySet<string>;
}): boolean {
  if (
    params.tool.name !== SHIFU_CALENDAR_RESOLVER_TOOL_NAME ||
    !isTrustedShifuToolMetadataSource(params)
  ) {
    return false;
  }
  const metadata = (
    params.tool as unknown as {
      _meta?: { shifuTool?: Record<string, unknown> };
    }
  )._meta?.shifuTool;
  const aliases = Array.isArray(metadata?.aliases) ? metadata.aliases : [];
  return Boolean(
    metadata &&
      metadata.domain === "calendar" &&
      metadata.priority === "P0" &&
      SHIFU_CALENDAR_RESOLVER_ALIASES.every(
        (alias, index) => aliases[index] === alias
      ) &&
      aliases.length === SHIFU_CALENDAR_RESOLVER_ALIASES.length &&
      metadata.readOnly === true &&
      metadata.mutatesState === false &&
      metadata.requiresConfirmation === false &&
      metadata.freshness === "realtime"
  );
}

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

function parseShifuToolMetadata(
  tool: McpToolDef,
  trustedMetadata: boolean
): ShifuToolMetadata | null {
  if (!trustedMetadata) return null;

  const looseTool = tool as unknown as {
    _meta?: { shifuTool?: unknown };
    annotations?: { shifuTool?: unknown };
  };
  // Toolbox publishes stable selector metadata at `_meta.shifuTool`. Raw
  // `annotations.shifuTool` is tolerated only as a migration fallback.
  const rawMetadata =
    looseTool._meta?.shifuTool ?? looseTool.annotations?.shifuTool;

  if (!isRecord(rawMetadata)) return null;

  const domain =
    typeof rawMetadata.domain === "string" &&
    KNOWN_TOOL_DOMAINS.has(rawMetadata.domain as ToolDomain)
      ? (rawMetadata.domain as ToolDomain)
      : "unknown";
  const priority =
    typeof rawMetadata.priority === "string" &&
    KNOWN_TOOL_PRIORITIES.has(rawMetadata.priority as ToolPriority)
      ? (rawMetadata.priority as ToolPriority)
      : "P2";
  const freshness =
    typeof rawMetadata.freshness === "string" &&
    KNOWN_TOOL_FRESHNESS.has(rawMetadata.freshness as ToolFreshness)
      ? (rawMetadata.freshness as ToolFreshness)
      : undefined;

  return {
    domain,
    priority,
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
  mcpId = "",
  options: {
    provenance?: McpCatalogProvenance;
    trustedOrigins?: ReadonlySet<string>;
  } = {}
): ToolCatalogEntry {
  const name = tool.name || "";
  const trustedMetadata = isTrustedShifuToolMetadataSource({
    mcpId,
    provenance: options.provenance,
    trustedOrigins: options.trustedOrigins,
  });
  const shifuMetadata = parseShifuToolMetadata(tool, trustedMetadata);

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

  const looseTool = tool as unknown as {
    _meta?: { shifuTool?: unknown };
    annotations?: { shifuTool?: unknown };
  };
  if (looseTool._meta?.shifuTool || looseTool.annotations?.shifuTool) {
    return {
      tool,
      name,
      mcpId,
      domain: "unknown",
      intent: "unknown",
      priority: "P2",
      ...defaultCatalogMetadata(),
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
