import { describe, expect, mock, test } from "bun:test";
import type { McpToolDef } from "@lobu/core";
import { projectMcpToolsForProvider } from "../openclaw/mcp-tool-projection";
import {
  buildRuntimeToolCatalog,
  dispatchRuntimeToolCall,
  searchRuntimeToolCatalog,
  statusRuntimeToolCatalog,
} from "../openclaw/tool-catalog-dispatcher";
import {
  clearToolRetrievalIndexCacheForTests,
  toolRetrievalIndexCacheStats,
} from "../openclaw/tool-retrieval-index";
import {
  clearToolRouterRetainedMemoryForTests,
  toolRouterRetainedMemoryStats,
} from "../openclaw/tool-router-memory-budget";

function tool(name: string, description?: string): McpToolDef {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties: {
        format: { type: "string" },
      },
    },
  };
}

describe("tool catalog dispatcher", () => {
  test("prebuilds and reuses one semantic search context per runtime catalog", () => {
    clearToolRetrievalIndexCacheForTests();
    const catalog = buildRuntimeToolCatalog({
      allTools: {
        school: [tool("search_students", "Search student records")],
        secret: [tool("search_payroll", "Search payroll records")],
      },
      selectedTools: {},
      allowedToolNames: ["school/search_students"],
    });
    const afterBuild = toolRetrievalIndexCacheStats();

    expect(
      searchRuntimeToolCatalog(catalog, { query: "search records" })
    ).toHaveLength(1);
    expect(
      searchRuntimeToolCatalog(catalog, { query: "search records" })
    ).toHaveLength(1);
    expect(toolRetrievalIndexCacheStats().misses).toBe(afterBuild.misses);
    expect(toolRetrievalIndexCacheStats().hits).toBe(afterBuild.hits + 2);
    expect(
      searchRuntimeToolCatalog(catalog, { query: "payroll" }).map(
        ({ entry }) => entry.name
      )
    ).not.toContain("search_payroll");
  });

  test("live runtime catalogs do not retain evicted indexes outside the unified budget", () => {
    clearToolRouterRetainedMemoryForTests();
    clearToolRetrievalIndexCacheForTests();
    const catalogs = Array.from({ length: 32 }, (_, version) =>
      buildRuntimeToolCatalog({
        allTools: {
          allowed: [
            tool(
              `search_allowed_${version}`,
              `shared lookup ${version} ${"a".repeat(3_000)}`
            ),
          ],
          forbidden: [
            tool(
              `search_forbidden_${version}`,
              `shared lookup ${version} ${"b".repeat(3_000)}`
            ),
          ],
          bulk: Array.from({ length: 180 }, (_, index) =>
            tool(
              `bulk_${version}_${index}`,
              `bulk ${version} ${index} ${"x".repeat(3_000)}`
            )
          ),
        },
        selectedTools: {},
        allowedToolNames: [`allowed/search_allowed_${version}`],
      })
    );
    const beforeSearch = toolRetrievalIndexCacheStats();
    expect(toolRouterRetainedMemoryStats().estimatedBytes).toBeLessThanOrEqual(
      32 * 1024 * 1024
    );
    expect(toolRouterRetainedMemoryStats().evictions).toBeGreaterThan(0);

    const matches = searchRuntimeToolCatalog(catalogs[0]!, {
      query: "shared lookup",
    });
    expect(matches.map(({ entry }) => entry.name)).toEqual([
      "search_allowed_0",
    ]);
    expect(toolRetrievalIndexCacheStats().misses).toBeGreaterThan(
      beforeSearch.misses
    );
    expect(toolRouterRetainedMemoryStats().estimatedBytes).toBeLessThanOrEqual(
      32 * 1024 * 1024
    );
  });

  test("catalog-only allowed tools remain callable and searchable", () => {
    const catalog = buildRuntimeToolCatalog({
      allTools: {
        toolbox: [
          tool("sales_battle_report_run_now", "Send the latest sales report"),
          tool(
            "card_studio_heavy_export",
            "Export a large course promotion card deck"
          ),
        ],
      },
      selectedTools: {
        toolbox: [tool("sales_battle_report_run_now")],
      },
      allowedToolNames: [
        "toolbox/sales_battle_report_run_now",
        "toolbox/card_studio_heavy_export",
      ],
    });

    const omitted = catalog.find(
      (entry) => entry.name === "card_studio_heavy_export"
    );

    expect(omitted).toMatchObject({
      mcpId: "toolbox",
      directVisibleThisTurn: false,
      callableViaCatalog: true,
    });

    const matches = searchRuntimeToolCatalog(catalog, {
      query: "heavy export card",
    });

    expect(matches.map((match) => match.entry.name)).toContain(
      "card_studio_heavy_export"
    );
  });

  test("semantic catalog search finds personal reminder tools", () => {
    const catalog = buildRuntimeToolCatalog({
      allTools: {
        "lobu-memory": [
          tool("manage_schedules", "Manage delayed agent schedules"),
        ],
        google_workspace: [
          tool("gws_calendar_events_create", "Create a Google Calendar event"),
        ],
      },
      selectedTools: {},
    });

    expect(
      searchRuntimeToolCatalog(catalog, {
        query: "稍後提醒我回覆客戶",
        limit: 5,
      })[0]
    ).toMatchObject({
      entry: { mcpId: "lobu-memory", name: "manage_schedules" },
      totalScore: expect.any(Number),
      reasons: expect.any(Array),
    });
  });

  test("catalog search defaults to five results and caps requests at twenty", () => {
    const catalog = buildRuntimeToolCatalog({
      allTools: {
        toolbox: Array.from({ length: 25 }, (_, index) =>
          tool(`course_lookup_${index}`, "Search course records")
        ),
      },
      selectedTools: {},
    });

    expect(searchRuntimeToolCatalog(catalog, { query: "course" })).toHaveLength(
      5
    );
    expect(
      searchRuntimeToolCatalog(catalog, { query: "course", limit: 100 })
    ).toHaveLength(20);
  });

  test("tool_call cannot bypass clarification_required", async () => {
    const callTool = mock(async () => ({
      content: [{ type: "text" as const, text: "should not run" }],
    }));
    const catalog = buildRuntimeToolCatalog({
      allTools: {
        google_workspace: [tool("gws_calendar_events_create")],
      },
      selectedTools: {},
      clarificationBlockedToolKeys: [
        "google_workspace/gws_calendar_events_create",
      ],
    });

    expect(
      statusRuntimeToolCatalog(catalog, {
        mcpId: "google_workspace",
        toolName: "gws_calendar_events_create",
      })
    ).toMatchObject({
      callableViaCatalog: false,
      callBlockedReason: "clarification_required",
    });
    expect(
      searchRuntimeToolCatalog(catalog, { query: "Google Calendar" })[0]
    ).toMatchObject({
      entry: {
        name: "gws_calendar_events_create",
        callBlockedReason: "clarification_required",
      },
    });

    const result = await dispatchRuntimeToolCall({
      catalog,
      toolName: "gws_calendar_events_create",
      mcpId: "google_workspace",
      args: {},
      callTool,
    });
    expect(result).toMatchObject({
      ok: false,
      code: "clarification_required",
    });
    expect(callTool).not.toHaveBeenCalled();
  });

  test("not_allowed takes precedence over clarification_required", () => {
    const catalog = buildRuntimeToolCatalog({
      allTools: {
        google_workspace: [tool("gws_calendar_events_create")],
      },
      selectedTools: {},
      allowedToolNames: [],
      clarificationBlockedToolKeys: [
        "google_workspace/gws_calendar_events_create",
      ],
    });

    expect(catalog[0]).toMatchObject({
      callableViaCatalog: false,
      callBlockedReason: "not_allowed",
    });
    expect(
      searchRuntimeToolCatalog(catalog, { query: "Google Calendar" })
    ).toEqual([]);
  });

  test("tool_call rejects missing catalog entries with a stable error code", async () => {
    const result = await dispatchRuntimeToolCall({
      catalog: [],
      toolName: "missing_tool",
      args: {},
      callTool: mock(async () => ({
        content: [{ type: "text" as const, text: "should not run" }],
      })),
    });

    expect(result).toMatchObject({
      ok: false,
      code: "not_discovered",
    });
  });

  test("tool_call rejects catalog entries that are not allowed", async () => {
    const callTool = mock(async () => ({
      content: [{ type: "text" as const, text: "should not run" }],
    }));
    const catalog = buildRuntimeToolCatalog({
      allTools: {
        toolbox: [tool("card_studio_heavy_export")],
      },
      selectedTools: {},
      allowedToolNames: [],
    });

    const result = await dispatchRuntimeToolCall({
      catalog,
      toolName: "card_studio_heavy_export",
      args: {},
      callTool,
    });

    expect(result).toMatchObject({
      ok: false,
      code: "not_allowed",
    });
    expect(callTool).not.toHaveBeenCalled();
  });

  test("tool_call delegates successful calls to the injected MCP caller", async () => {
    const callTool = mock(async () => ({
      content: [{ type: "text" as const, text: "export queued" }],
    }));
    const catalog = buildRuntimeToolCatalog({
      allTools: {
        toolbox: [tool("card_studio_heavy_export")],
      },
      selectedTools: {},
      allowedToolNames: ["toolbox/card_studio_heavy_export"],
    });

    const result = await dispatchRuntimeToolCall({
      catalog,
      toolName: "card_studio_heavy_export",
      args: { format: "pdf" },
      callTool,
    });

    expect(result.ok).toBe(true);
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledWith(
      "toolbox",
      "card_studio_heavy_export",
      { format: "pdf" }
    );
  });

  test("tool_call rejects ambiguous duplicate raw tool names with candidates", async () => {
    const callTool = mock(async () => ({
      content: [{ type: "text" as const, text: "should not run" }],
    }));
    const catalog = buildRuntimeToolCatalog({
      allTools: {
        google_workspace: [tool("search", "Search Google Workspace")],
        notion: [tool("search", "Search Notion")],
      },
      selectedTools: {},
      allowedToolNames: ["google_workspace/search", "notion/search"],
    });

    const result = await dispatchRuntimeToolCall({
      catalog,
      toolName: "search",
      args: {},
      callTool,
    });

    expect(result).toMatchObject({
      ok: false,
      code: "ambiguous_tool",
      candidates: [
        { mcpId: "google_workspace", name: "search" },
        { mcpId: "notion", name: "search" },
      ],
    });
    expect(callTool).not.toHaveBeenCalled();
  });

  test("tool_status reports direct-visible and catalog-callable state", () => {
    const catalog = buildRuntimeToolCatalog({
      allTools: {
        toolbox: [
          tool("sales_battle_report_run_now"),
          tool("card_studio_heavy_export"),
        ],
      },
      selectedTools: {
        toolbox: [tool("sales_battle_report_run_now")],
      },
      allowedToolNames: ["toolbox/sales_battle_report_run_now"],
    });

    expect(
      statusRuntimeToolCatalog(catalog, {
        mcpId: "toolbox",
        toolName: "card_studio_heavy_export",
      })
    ).toMatchObject({
      mcpId: "toolbox",
      name: "card_studio_heavy_export",
      directVisibleThisTurn: false,
      callableViaCatalog: false,
      callBlockedReason: "not_allowed",
    });
  });

  test("direct visibility follows final provider-projected MCP tools after cap", () => {
    const allTools = {
      toolbox: [
        tool("sales_battle_report_run_now", "Send the latest sales report"),
        tool("card_studio_heavy_export", "Export a large card deck"),
      ],
    };
    const projected = projectMcpToolsForProvider(allTools, {
      provider: "openai",
      directToolLimit: 1,
      selectionHint: "sales report",
    });

    const catalog = buildRuntimeToolCatalog({
      allTools,
      selectedTools: allTools,
      providerVisibleTools: projected.tools,
      allowedToolNames: [
        "toolbox/sales_battle_report_run_now",
        "toolbox/card_studio_heavy_export",
      ],
    });

    expect(
      statusRuntimeToolCatalog(catalog, {
        mcpId: "toolbox",
        toolName: "sales_battle_report_run_now",
      })
    ).toMatchObject({
      directVisibleThisTurn: true,
      callableViaCatalog: true,
    });
    expect(
      statusRuntimeToolCatalog(catalog, {
        mcpId: "toolbox",
        toolName: "card_studio_heavy_export",
      })
    ).toMatchObject({
      directVisibleThisTurn: false,
      callableViaCatalog: true,
    });
  });

  test.each([
    ["auth_required", "Error: Authentication required for Google Workspace."],
    [
      "approval_required",
      "Error: Tool call requires approval. The user has been asked to approve.",
    ],
    ["tool_error", "Error: Upstream validation failed."],
    ["server_unavailable", "Error: MCP tool toolbox/export timed out"],
  ] as const)("tool_call surfaces delegated MCP %s failures as stable codes", async (code, text) => {
    const catalog = buildRuntimeToolCatalog({
      allTools: {
        toolbox: [tool("card_studio_heavy_export")],
      },
      selectedTools: {},
      allowedToolNames: ["toolbox/card_studio_heavy_export"],
    });

    const result = await dispatchRuntimeToolCall({
      catalog,
      toolName: "card_studio_heavy_export",
      args: {},
      callTool: mock(async () => ({
        content: [{ type: "text" as const, text }],
        isError: true,
        errorCode: code,
      })),
    });

    expect(result).toMatchObject({
      ok: false,
      code,
    });
  });
});
