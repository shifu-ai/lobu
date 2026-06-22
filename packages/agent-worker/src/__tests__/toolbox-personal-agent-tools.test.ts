import { describe, expect, mock, test } from "bun:test";
import { callToolboxPersonalAgentTool } from "../shared/tool-implementations";

describe("callToolboxPersonalAgentTool", () => {
  test("surfaces ok:false MCP execution errors instead of returning null", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () =>
      Response.json({
        ok: false,
        content: null,
        errorCode: "lobu_mcp_tool_error",
        errorMessage: "MCP tool execution failed",
        diagnosticCode: "tool_not_found",
      })
    ) as unknown as typeof fetch;

    try {
      const result = await callToolboxPersonalAgentTool(
        {
          gatewayUrl: "https://gateway.test",
          workerToken: "worker-token",
        } as any,
        {
          connectorKey: "google_workspace",
          connectionRef: "toolbox-mcp:test",
          connectorToolName: "gws_drive_search",
          toolArgs: { query: "x" },
        }
      );

      expect(result.content[0]?.text).toContain("lobu_mcp_tool_error");
      expect(result.content[0]?.text).toContain("tool_not_found");
      expect(result.content[0]?.text).not.toBe("null");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
