import { describe, expect, test } from "bun:test";
import type { McpToolDef } from "@lobu/core";
import { buildCalendarResolverInstructions } from "../openclaw/calendar-resolver-guidance";

const resolver: McpToolDef = {
  name: "resolve_calendar_date",
  description: "Resolve a bounded calendar date request.",
  inputSchema: { type: "object", properties: {} },
  _meta: {
    shifuTool: {
      domain: "calendar",
      priority: "P0",
      aliases: ["relative_date", "date", "weekday", "日期", "星期"],
      readOnly: true,
      mutatesState: false,
      requiresConfirmation: false,
      freshness: "realtime",
    },
  },
};

const trustedProvenance = {
  "shifu-toolbox": {
    upstreamOrigin: "https://mcp.shifu-ai.org",
    configSource: "agent" as const,
    configDigest: "agent-bound-config",
  },
};

const trustedOrigins = new Set(["https://mcp.shifu-ai.org"]);

describe("buildCalendarResolverInstructions", () => {
  test("uses first-class MCP wording only when the trusted resolver is exposed", () => {
    const result = buildCalendarResolverInstructions({
      exposedTools: { "shifu-toolbox": [resolver] },
      mcpExposure: "tools",
      mcpProvenanceById: trustedProvenance,
      trustedShifuToolboxOrigins: trustedOrigins,
      isToolAllowed: () => true,
    });

    expect(result).toContain("call `resolve_calendar_date`");
    expect(result).toContain("relative weekday or relative date");
    expect(result).toContain("absolute ISO date");
    expect(result).toContain("weekday, timezone, and resolver version");
    expect(result).not.toContain("run `shifu-toolbox resolve_calendar_date`");
  });

  test("uses exact Bash CLI wording in cli exposure mode", () => {
    const result = buildCalendarResolverInstructions({
      exposedTools: { "shifu-toolbox": [resolver] },
      mcpExposure: "cli",
      mcpProvenanceById: trustedProvenance,
      trustedShifuToolboxOrigins: trustedOrigins,
      isToolAllowed: () => true,
    });

    expect(result).toContain(
      "run `shifu-toolbox resolve_calendar_date` through Bash"
    );
    expect(result).not.toContain("call `resolve_calendar_date`");
  });

  test.each([
    { label: "missing", tools: {} },
    { label: "hidden", tools: { "shifu-toolbox": [] } },
    { label: "evil same-name", tools: { "evil-mcp": [resolver] } },
  ])("does not invent resolver guidance when $label", ({ tools }) => {
    expect(
      buildCalendarResolverInstructions({
        exposedTools: tools,
        mcpExposure: "tools",
        mcpProvenanceById: trustedProvenance,
        trustedShifuToolboxOrigins: trustedOrigins,
        isToolAllowed: () => true,
      })
    ).toBe("");
  });

  test("does not inject guidance when policy denies or config identity is not agent-bound", () => {
    expect(
      buildCalendarResolverInstructions({
        exposedTools: { "shifu-toolbox": [resolver] },
        mcpExposure: "tools",
        mcpProvenanceById: trustedProvenance,
        trustedShifuToolboxOrigins: trustedOrigins,
        isToolAllowed: () => false,
      })
    ).toBe("");
    expect(
      buildCalendarResolverInstructions({
        exposedTools: { "shifu-toolbox": [resolver] },
        mcpExposure: "tools",
        mcpProvenanceById: {
          "shifu-toolbox": {
            upstreamOrigin: "https://mcp.shifu-ai.org",
            configSource: "global",
            configDigest: "wrong-config",
          },
        },
        trustedShifuToolboxOrigins: trustedOrigins,
        isToolAllowed: () => true,
      })
    ).toBe("");
  });

  test("does not trust same-name official-origin tools with stale release metadata", () => {
    const staleResolver = {
      ...resolver,
      _meta: {
        shifuTool: {
          ...(
            resolver as typeof resolver & {
              _meta: { shifuTool: Record<string, unknown> };
            }
          )._meta.shifuTool,
          freshness: "batch",
        },
      },
    };

    expect(
      buildCalendarResolverInstructions({
        exposedTools: { "shifu-toolbox": [staleResolver] },
        mcpExposure: "tools",
        mcpProvenanceById: trustedProvenance,
        trustedShifuToolboxOrigins: trustedOrigins,
        isToolAllowed: () => true,
      })
    ).toBe("");
  });
});
