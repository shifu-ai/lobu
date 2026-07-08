import { describe, expect, test } from "bun:test";
import type { McpToolDef } from "@lobu/core";
import {
  buildRuntimeToolCatalog,
  resolveDynamicToolBudget,
  selectMcpToolsByMcpForTurn,
  selectMcpToolsForTurn,
} from "../openclaw/dynamic-tool-loader";

function tool(name: string): McpToolDef {
  return {
    name,
    description: `${name} description`,
    inputSchema: { type: "object", properties: {} },
  };
}

describe("selectMcpToolsForTurn", () => {
  test("keeps P0 battle report tools when the Toolbox catalog is crowded", () => {
    const cardStudioDistractors = Array.from({ length: 75 }, (_, index) =>
      tool(`card_studio_distractor_${String(index + 1).padStart(2, "0")}`)
    );
    const battleReportTools = [
      tool("sales_battle_report_schedule_list"),
      tool("sales_battle_report_schedule_create"),
      tool("sales_battle_report_schedule_pause"),
      tool("sales_battle_report_schedule_update"),
      tool("sales_battle_report_run_now"),
    ];

    const result = selectMcpToolsForTurn({
      tools: [...cardStudioDistractors, ...battleReportTools],
      message: "請立即發送 Irene 財務自由工程計畫今天的戰報",
      budget: 48,
    });

    const selectedNames = result.selected.map((toolDef) => toolDef.name);

    expect(selectedNames).toContain("sales_battle_report_schedule_list");
    expect(selectedNames).toContain("sales_battle_report_schedule_create");
    expect(selectedNames).toContain("sales_battle_report_schedule_pause");
    expect(selectedNames).toContain("sales_battle_report_schedule_update");
    expect(selectedNames).toContain("sales_battle_report_run_now");
    expect(result.selected).toHaveLength(48);
    expect(result.trace.primaryIntent).toBe("battle_report");
    expect(selectedNames).not.toContain("card_studio_distractor_75");
  });

  test("preserves original order for tools with equal ranking", () => {
    const result = selectMcpToolsForTurn({
      tools: [
        tool("unknown_alpha"),
        tool("unknown_beta"),
        tool("unknown_gamma"),
      ],
      message: "請幫我看看這些工具",
      budget: 3,
    });

    expect(result.selected.map((toolDef) => toolDef.name)).toEqual([
      "unknown_alpha",
      "unknown_beta",
      "unknown_gamma",
    ]);
  });

  test("builds a runtime catalog with availability for this turn", () => {
    const allTools = {
      toolbox: [
        tool("sales_battle_report_run_now"),
        tool("card_studio_template_list"),
      ],
      workspace: [tool("workspace_drive_search")],
    };
    const selectedTools = {
      toolbox: [allTools.toolbox[0]],
      workspace: [allTools.workspace[0]],
    };

    const catalog = buildRuntimeToolCatalog({ allTools, selectedTools });

    expect(
      catalog.map((entry) => ({
        name: entry.name,
        mcpId: entry.mcpId,
        availableThisTurn: entry.availableThisTurn,
      }))
    ).toEqual([
      {
        name: "sales_battle_report_run_now",
        mcpId: "toolbox",
        availableThisTurn: true,
      },
      {
        name: "card_studio_template_list",
        mcpId: "toolbox",
        availableThisTurn: false,
      },
      {
        name: "workspace_drive_search",
        mcpId: "workspace",
        availableThisTurn: true,
      },
    ]);
  });

  test("selects tools across MCP servers while preserving mcpId grouping", () => {
    const result = selectMcpToolsByMcpForTurn({
      toolsByMcp: {
        toolbox: [
          tool("sales_battle_report_run_now"),
          tool("card_studio_template_list"),
        ],
        workspace: [
          tool("workspace_drive_search"),
          tool("workspace_docs_create"),
        ],
      },
      message: "請立即發送今天的戰報",
      budget: 2,
    });

    expect(
      Object.fromEntries(
        Object.entries(result.selectedTools).map(([mcpId, tools]) => [
          mcpId,
          tools.map((toolDef) => toolDef.name),
        ])
      )
    ).toEqual({
      toolbox: ["sales_battle_report_run_now"],
      workspace: ["workspace_drive_search"],
    });
    expect(result.trace.selectedToolNames).toEqual([
      "toolbox/sales_battle_report_run_now",
      "workspace/workspace_drive_search",
    ]);
    expect(result.trace.omittedToolNames).toEqual([
      "toolbox/card_studio_template_list",
      "workspace/workspace_docs_create",
    ]);
  });

  test("resolves dynamic tool budget from positive integer strings only", () => {
    expect(resolveDynamicToolBudget(undefined)).toBe(48);
    expect(resolveDynamicToolBudget("")).toBe(48);
    expect(resolveDynamicToolBudget("   ")).toBe(48);
    expect(resolveDynamicToolBudget("not-a-number")).toBe(48);
    expect(resolveDynamicToolBudget("-2")).toBe(48);
    expect(resolveDynamicToolBudget("0")).toBe(48);
    expect(resolveDynamicToolBudget(" 12.9 ")).toBe(12);
  });
});
