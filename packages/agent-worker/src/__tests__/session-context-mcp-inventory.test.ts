import { describe, expect, test } from "bun:test";
import type { McpStatus, McpToolDef } from "@lobu/core";
import { buildMcpToolInventoryInstructions } from "../openclaw/session-context";

function tool(name: string): McpToolDef {
  return { name, description: "", inputSchema: { type: "object" } };
}

const mcpStatus: McpStatus[] = [];

describe("buildMcpToolInventoryInstructions capability notes", () => {
  test("notion entry includes the delete/archive/trash capability limit", () => {
    const output = buildMcpToolInventoryInstructions(
      { notion: [tool("notion-update-page"), tool("notion-search")] },
      mcpStatus
    );

    expect(output).toContain("CANNOT delete, archive, or trash");
    expect(output).toContain("Capability limits:");
  });

  test("google_workspace entry includes its capability limit note", () => {
    const output = buildMcpToolInventoryInstructions(
      { google_workspace: [tool("gws-drive-search")] },
      mcpStatus
    );

    expect(output).toContain(
      "CANNOT delete or trash Docs/Sheets/Slides/Drive files"
    );
  });

  test("MCPs not in the capability notes map get no Capability limits line", () => {
    const output = buildMcpToolInventoryInstructions(
      { "shifu-toolbox": [tool("run_sql")] },
      mcpStatus
    );

    expect(output).toContain("shifu-toolbox");
    expect(output).not.toContain("Capability limits:");
  });
});
