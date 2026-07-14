import type { McpToolDef } from "@lobu/core";
import {
  isTrustedShifuCalendarResolver,
  type McpCatalogProvenanceById,
} from "./tool-catalog";

export interface BuildCalendarResolverInstructionsParams {
  exposedTools: Record<string, McpToolDef[]>;
  mcpExposure: "tools" | "cli";
  mcpProvenanceById: McpCatalogProvenanceById;
  trustedShifuToolboxOrigins: ReadonlySet<string>;
  isToolAllowed: (toolName: string, mcpId: string) => boolean;
}

export function buildCalendarResolverInstructions(
  params: BuildCalendarResolverInstructionsParams
): string {
  const mcpId = "shifu-toolbox";
  const resolver = params.exposedTools[mcpId]?.find((tool) =>
    isTrustedShifuCalendarResolver({
      tool,
      mcpId,
      provenance: params.mcpProvenanceById[mcpId],
      trustedOrigins: params.trustedShifuToolboxOrigins,
    })
  );
  if (!resolver || !params.isToolAllowed(resolver.name, mcpId)) return "";

  const invocation =
    params.mcpExposure === "cli"
      ? "run `shifu-toolbox resolve_calendar_date` through Bash"
      : "call `resolve_calendar_date`";
  return `## Deterministic Calendar Dates

For every relative weekday or relative date calculation, you MUST ${invocation}; do not calculate it yourself. Use the \`absolute_date\` expression to validate an absolute ISO date or its claimed weekday. For a month/day without a year, use the current ISO year only when the user clearly means that year; otherwise ask for the year before calling the resolver. In the answer, always show the complete absolute ISO date, weekday, timezone, and resolver version returned by the resolver.`;
}
