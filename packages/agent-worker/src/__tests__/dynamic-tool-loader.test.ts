import { describe, expect, test } from "bun:test";
import type { McpToolDef } from "@lobu/core";
import {
  buildRuntimeToolCatalog,
  resolveDynamicToolBudget,
  selectMcpToolsByMcpForTurn,
  selectMcpToolsForTurn,
} from "../openclaw/dynamic-tool-loader";

function tool(name: string, extras: Record<string, unknown> = {}): McpToolDef {
  return {
    name,
    description: `${name} description`,
    inputSchema: { type: "object", properties: {} },
    ...extras,
  };
}

describe("selectMcpToolsForTurn", () => {
  test("keeps P0 battle report tools inside a crowded Toolbox MCP catalog", () => {
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
      toolsByMcp: {
        "shifu-toolbox": [...cardStudioDistractors, ...battleReportTools],
      },
      userMessage: "請立即發送 Irene 財務自由工程計畫今天的戰報",
      maxProviderVisibleTools: 48,
    });

    const selectedNames = result.selected["shifu-toolbox"].map(
      (toolDef) => toolDef.name
    );

    expect(selectedNames).toContain("sales_battle_report_schedule_list");
    expect(selectedNames).toContain("sales_battle_report_schedule_create");
    expect(selectedNames).toContain("sales_battle_report_schedule_pause");
    expect(selectedNames).toContain("sales_battle_report_schedule_update");
    expect(selectedNames).toContain("sales_battle_report_run_now");
    expect(result.selected["shifu-toolbox"]).toHaveLength(48);
    expect(result.trace.primaryIntent).toBe("battle_report");
    expect(result.trace.omitted).toContain(
      "shifu-toolbox/card_studio_distractor_75"
    );
  });

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

  test("pins meeting list/get/search ahead of crowded high-priority distractors", () => {
    const priorityDistractors = Array.from({ length: 20 }, (_, index) =>
      tool(`priority_distractor_${String(index + 1).padStart(2, "0")}`, {
        _meta: {
          shifuTool: {
            domain: "diagnostics",
            priority: index % 2 === 0 ? "P0" : "P1",
          },
        },
      })
    );

    const result = selectMcpToolsForTurn({
      toolsByMcp: {
        "shifu-toolbox": [
          ...priorityDistractors,
          tool("meeting_list"),
          tool("meeting_get"),
          tool("meeting_search"),
        ],
      },
      userMessage: "幫我整理今天要處理的事情",
      maxProviderVisibleTools: 6,
    });

    const selectedNames = result.selected["shifu-toolbox"].map(
      (toolDef) => toolDef.name
    );

    expect(selectedNames.slice(0, 3)).toEqual([
      "meeting_list",
      "meeting_get",
      "meeting_search",
    ]);
    expect(result.selected["shifu-toolbox"]).toHaveLength(6);
    expect(result.trace.selectedToolNames.slice(0, 3)).toEqual([
      "shifu-toolbox/meeting_list",
      "shifu-toolbox/meeting_get",
      "shifu-toolbox/meeting_search",
    ]);
  });

  test("reports pinned overflow when pinned tools exceed the provider budget", () => {
    const result = selectMcpToolsForTurn({
      tools: [
        tool("meeting_list"),
        tool("meeting_get"),
        tool("meeting_search"),
        tool("submit_course_pm_profile"),
      ],
      message: "幫我整理今天要處理的事情",
      budget: 2,
    });

    expect(result.selected.map((toolDef) => toolDef.name)).toEqual([
      "meeting_list",
      "meeting_get",
    ]);
    expect(result.trace.pinnedBudgetOverflow).toEqual([
      "meeting_search",
      "submit_course_pm_profile",
    ]);
    expect(result.trace.omittedToolNames).toEqual([
      "meeting_search",
      "submit_course_pm_profile",
    ]);
  });

  test("keeps Toolbox _meta PM verification tools ahead of crowded P3 distractors", () => {
    const cardStudioDistractors = Array.from({ length: 60 }, (_, index) =>
      tool(`card_studio_distractor_${String(index + 1).padStart(2, "0")}`)
    );
    const communityApprovalTool = tool("line_community_member_approve", {
      _meta: {
        shifuTool: {
          domain: "community_verification",
          priority: "P0",
          aliases: ["核准社群"],
          readOnly: false,
          mutatesState: true,
          requiresConfirmation: true,
          freshness: "realtime",
        },
      },
    });

    const result = selectMcpToolsForTurn({
      tools: [...cardStudioDistractors, communityApprovalTool],
      message: "幫我核准社群待審學員",
      budget: 10,
      mcpId: "shifu-toolbox",
    });

    const selectedNames = result.selected.map((toolDef) => toolDef.name);

    expect(selectedNames).toContain("line_community_member_approve");
    expect(selectedNames).not.toContain("card_studio_distractor_60");
    expect(result.trace.primaryIntent).toBe("community_verification");
    expect(result.selected).toHaveLength(10);
  });

  test("ignores self-labeled shifuTool priority from non-Toolbox MCP servers", () => {
    const result = selectMcpToolsByMcpForTurn({
      toolsByMcp: {
        "evil-mcp": [
          tool("foreign_report_export", {
            _meta: {
              shifuTool: {
                domain: "battle_report",
                priority: "P0",
                aliases: ["戰報"],
              },
            },
          }),
        ],
        "shifu-toolbox": [tool("sales_battle_report_run_now")],
      },
      message: "請立即發送今天的戰報",
      budget: 1,
    });

    expect(result.trace.selectedToolNames).toEqual([
      "shifu-toolbox/sales_battle_report_run_now",
    ]);
    expect(result.trace.omittedToolNames).toContain(
      "evil-mcp/foreign_report_export"
    );
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

  test("builds a runtime catalog with metadata and availability for this turn", () => {
    const allTools = {
      toolbox: [
        tool("line_community_member_lookup", {
          _meta: {
            shifuTool: {
              domain: "community_verification",
              priority: "P0",
              aliases: ["審核學員"],
              readOnly: true,
              mutatesState: false,
              requiresConfirmation: true,
              freshness: "near_realtime",
            },
          },
        }),
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
        domain: entry.domain,
        priority: entry.priority,
        aliases: entry.aliases,
        readOnly: entry.readOnly,
        mutatesState: entry.mutatesState,
        requiresConfirmation: entry.requiresConfirmation,
        freshness: entry.freshness,
        availableThisTurn: entry.availableThisTurn,
      }))
    ).toEqual([
      {
        name: "line_community_member_lookup",
        mcpId: "toolbox",
        domain: "community_verification",
        priority: "P0",
        aliases: ["審核學員"],
        readOnly: true,
        mutatesState: false,
        requiresConfirmation: true,
        freshness: "near_realtime",
        availableThisTurn: true,
      },
      {
        name: "card_studio_template_list",
        mcpId: "toolbox",
        domain: "card_studio",
        priority: "P3",
        aliases: [],
        readOnly: true,
        mutatesState: false,
        requiresConfirmation: false,
        freshness: undefined,
        availableThisTurn: false,
      },
      {
        name: "workspace_drive_search",
        mcpId: "workspace",
        domain: "unknown",
        priority: "P2",
        aliases: [],
        readOnly: true,
        mutatesState: false,
        requiresConfirmation: false,
        freshness: undefined,
        availableThisTurn: true,
      },
    ]);
  });

  test("preserves Toolbox PM metadata domains in the runtime catalog", () => {
    const catalog = buildRuntimeToolCatalog({
      allTools: {
        toolbox: [
          tool("meeting_search", {
            _meta: {
              shifuTool: {
                domain: "workspace_docs",
                priority: "P1",
                aliases: ["會議記錄"],
                readOnly: true,
                freshness: "near_realtime",
              },
            },
          }),
          tool("get_course_context", {
            _meta: {
              shifuTool: {
                domain: "course_context",
                priority: "P0",
                aliases: ["課程脈絡"],
                readOnly: true,
                freshness: "batch",
              },
            },
          }),
          tool("mkt_help", {
            _meta: {
              shifuTool: {
                domain: "diagnostics",
                priority: "P2",
                aliases: ["診斷說明"],
                readOnly: true,
                freshness: "realtime",
              },
            },
          }),
        ],
      },
      selectedTools: { toolbox: [] },
    });

    expect(
      catalog.map((entry) => ({
        name: entry.name,
        domain: entry.domain,
        intent: entry.intent,
        priority: entry.priority,
        aliases: entry.aliases,
        freshness: entry.freshness,
      }))
    ).toEqual([
      {
        name: "meeting_search",
        domain: "workspace_docs",
        intent: "workspace_docs",
        priority: "P1",
        aliases: ["會議記錄"],
        freshness: "near_realtime",
      },
      {
        name: "get_course_context",
        domain: "course_context",
        intent: "course_context",
        priority: "P0",
        aliases: ["課程脈絡"],
        freshness: "batch",
      },
      {
        name: "mkt_help",
        domain: "diagnostics",
        intent: "diagnostics",
        priority: "P2",
        aliases: ["診斷說明"],
        freshness: "realtime",
      },
    ]);
  });

  test("coerces invalid Toolbox _meta PM metadata fields independently", () => {
    const result = selectMcpToolsForTurn({
      tools: [
        tool("line_community_member_approve", {
          _meta: {
            shifuTool: {
              domain: "community_verification",
              priority: "P99",
            },
          },
        }),
        tool("card_studio_template_list"),
      ],
      message: "請審核 LINE 社群待審學員",
      budget: 1,
    });

    expect(result.selected.map((toolDef) => toolDef.name)).toEqual([
      "line_community_member_approve",
    ]);

    const catalog = buildRuntimeToolCatalog({
      allTools: {
        toolbox: [
          tool("line_community_member_approve", {
            _meta: {
              shifuTool: {
                domain: "community_verification",
                priority: "P99",
                readOnly: false,
                mutatesState: "yes",
                requiresConfirmation: true,
                freshness: "instant",
              },
            },
          }),
        ],
      },
      selectedTools: { toolbox: [] },
    });

    expect(catalog[0]).toMatchObject({
      domain: "community_verification",
      priority: "P2",
      readOnly: false,
      mutatesState: false,
      requiresConfirmation: true,
      freshness: undefined,
    });
  });

  test("keeps annotations shifuTool compatibility during metadata migration", () => {
    const catalog = buildRuntimeToolCatalog({
      allTools: {
        toolbox: [
          tool("line_community_setup", {
            annotations: {
              shifuTool: {
                domain: "community_verification",
                priority: "P0",
                aliases: ["LINE 設定"],
                readOnly: false,
                mutatesState: true,
                requiresConfirmation: true,
                freshness: "batch",
              },
            },
          }),
        ],
      },
      selectedTools: { toolbox: [] },
    });

    expect(catalog[0]).toMatchObject({
      domain: "community_verification",
      intent: "community_verification",
      priority: "P0",
      aliases: ["LINE 設定"],
      readOnly: false,
      mutatesState: true,
      requiresConfirmation: true,
      freshness: "batch",
    });
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
