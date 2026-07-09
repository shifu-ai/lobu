import { describe, expect, mock, test } from "bun:test";
import type { McpToolDef } from "@lobu/core";
import {
  buildRuntimeToolCatalog,
  dispatchRuntimeToolCall,
  searchRuntimeToolCatalog,
  statusRuntimeToolCatalog,
} from "../openclaw/tool-catalog-dispatcher";

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

    expect(matches.map((entry) => entry.name)).toContain(
      "card_studio_heavy_export"
    );
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
});
