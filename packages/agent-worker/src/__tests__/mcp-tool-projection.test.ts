import { describe, expect, test } from "bun:test";
import type { McpToolDef } from "@lobu/core";
import { projectMcpToolsForProvider } from "../openclaw/mcp-tool-projection";

function countDefaultRegisteredDirectToolDefinitions(
  mcpTools: Record<string, McpToolDef[]>
): number {
  const registeredNames = new Set<string>();
  const toSafeAlias = (name: string): string =>
    name.replace(/[^A-Za-z0-9_]/g, "_").replace(/_+/g, "_");

  for (const defs of Object.values(mcpTools)) {
    for (const def of defs) {
      if (!def.name || typeof def.name !== "string" || !def.name.trim()) {
        continue;
      }
      const upstreamToolName = def.name.trim();
      registeredNames.add(upstreamToolName);
      const alias = toSafeAlias(upstreamToolName);
      if (alias !== upstreamToolName) {
        registeredNames.add(alias);
      }
    }
  }

  return registeredNames.size;
}

describe("projectMcpToolsForProvider", () => {
  test("keeps healthy object schemas and quarantines root array schemas", () => {
    const mcpTools: Record<string, McpToolDef[]> = {
      notion: [
        {
          name: "healthy",
          description: "Healthy schema",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string" },
            },
          },
        },
        {
          name: "bad_root",
          description: "Bad root schema",
          inputSchema: {
            type: "array",
            items: { type: "string" },
          },
        },
      ],
    };

    const projected = projectMcpToolsForProvider(mcpTools, {
      provider: "google",
      directToolLimit: 24,
    });

    expect(projected.tools).toEqual({
      notion: [mcpTools.notion[0]],
    });
    expect(projected.quarantined).toContainEqual({
      mcpId: "notion",
      toolName: "bad_root",
      reason: "root schema must be an object",
    });
  });

  test("projects nested anyOf schemas to strings and records a notice", () => {
    const mcpTools: Record<string, McpToolDef[]> = {
      google_workspace: [
        {
          name: "union_heavy",
          inputSchema: {
            type: "object",
            properties: {
              value: {
                anyOf: [{ type: "string" }, { type: "number" }],
              },
            },
          },
        },
      ],
    };

    const projected = projectMcpToolsForProvider(mcpTools, {
      provider: "google",
      directToolLimit: 24,
    });

    expect(projected.tools.google_workspace?.[0]?.inputSchema).toEqual({
      type: "object",
      properties: {
        value: {
          type: "string",
          description: "Projected from unsupported MCP schema union.",
        },
      },
    });
    expect(projected.projected).toContainEqual({
      mcpId: "google_workspace",
      toolName: "union_heavy",
      reason: "removed unsupported keyword anyOf",
    });
  });

  test("normalizes empty input schemas to object-shaped no-arg schemas", () => {
    const projected = projectMcpToolsForProvider(
      {
        notion: [
          { name: "empty_schema", inputSchema: {} },
          { name: "missing_schema" },
        ],
      },
      { provider: "gemini", directToolLimit: 24 }
    );

    expect(projected.tools.notion).toEqual([
      {
        name: "empty_schema",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "missing_schema",
        inputSchema: { type: "object", properties: {} },
      },
    ]);
    expect(projected.quarantined).toEqual([]);
  });

  test("quarantines root object schemas with unsupported combiners", () => {
    const mcpTools: Record<string, McpToolDef[]> = {
      google_workspace: [
        {
          name: "root_any_of",
          inputSchema: {
            type: "object",
            anyOf: [{ properties: { value: { type: "string" } } }],
          },
        },
        {
          name: "root_one_of",
          inputSchema: {
            type: "object",
            oneOf: [{ properties: { value: { type: "string" } } }],
          },
        },
        {
          name: "root_all_of",
          inputSchema: {
            type: "object",
            allOf: [{ properties: { value: { type: "string" } } }],
          },
        },
      ],
    };

    const projected = projectMcpToolsForProvider(mcpTools, {
      provider: "google",
      directToolLimit: 24,
    });

    expect(projected.tools).toEqual({});
    expect(projected.quarantined).toEqual([
      {
        mcpId: "google_workspace",
        toolName: "root_any_of",
        reason: "root schema uses unsupported keyword anyOf",
      },
      {
        mcpId: "google_workspace",
        toolName: "root_one_of",
        reason: "root schema uses unsupported keyword oneOf",
      },
      {
        mcpId: "google_workspace",
        toolName: "root_all_of",
        reason: "root schema uses unsupported keyword allOf",
      },
    ]);
  });

  test("applies the direct tool cap to the first sorted tools and reports omitted count", () => {
    const mcpTools: Record<string, McpToolDef[]> = {
      bulk: Array.from({ length: 30 }, (_, index) => ({
        name: `tool_${String(index).padStart(2, "0")}`,
        inputSchema: { type: "object" },
      })),
    };

    const projected = projectMcpToolsForProvider(mcpTools, {
      provider: "google",
      directToolLimit: 3,
    });

    expect(projected.tools).toEqual({
      bulk: [
        { name: "tool_00", inputSchema: { type: "object" } },
        { name: "tool_01", inputSchema: { type: "object" } },
        { name: "tool_02", inputSchema: { type: "object" } },
      ],
    });
    expect(projected.omittedForCap).toEqual([
      { mcpId: "bulk", omitted: 27, limit: 3 },
    ]);
  });

  test("applies the direct tool cap after unsafe-name alias expansion for raw-compatible providers", () => {
    const mcpTools: Record<string, McpToolDef[]> = {
      bulk: [
        { name: "tool-00", inputSchema: { type: "object" } },
        { name: "tool-01", inputSchema: { type: "object" } },
        { name: "tool-02", inputSchema: { type: "object" } },
      ],
    };

    const projected = projectMcpToolsForProvider(mcpTools, {
      provider: "openai",
      directToolLimit: 3,
    });

    expect(
      countDefaultRegisteredDirectToolDefinitions(projected.tools)
    ).toBeLessThanOrEqual(3);
    expect(projected.tools).toEqual({
      bulk: [{ name: "tool-00", inputSchema: { type: "object" } }],
    });
    expect(projected.omittedForCap).toEqual([
      { mcpId: "bulk", omitted: 2, limit: 3 },
    ]);
  });

  test("projects unsafe Gemini tool names to provider-safe direct names", () => {
    const projected = projectMcpToolsForProvider(
      {
        notion: [
          {
            name: "notion-search",
            description: "Search Notion",
            inputSchema: { type: "object" },
          },
        ],
      },
      { provider: "gemini", directToolLimit: 3 }
    );

    expect(projected.tools.notion?.[0]).toMatchObject({
      name: "notion_search",
      upstreamToolName: "notion-search",
      providerToolName: "notion_search",
      providerSafeNameOnly: true,
    });
    expect(projected.omittedForCap).toEqual([]);
  });

  test("prefixes Gemini tool names that do not start with a letter or underscore", () => {
    const projected = projectMcpToolsForProvider(
      {
        notion: [{ name: "123tool", inputSchema: { type: "object" } }],
      },
      { provider: "gemini", directToolLimit: 3 }
    );

    expect(projected.tools.notion?.[0]).toMatchObject({
      name: "mcp_123tool",
      upstreamToolName: "123tool",
      providerToolName: "mcp_123tool",
      providerSafeNameOnly: true,
    });
  });

  test("truncates long Gemini tool names and avoids sanitized collisions with stable suffixes", () => {
    const longName = `tool_${"a".repeat(80)}`;
    const collidingName = `tool_${"a".repeat(80)}!`;

    const projected = projectMcpToolsForProvider(
      {
        notion: [
          { name: longName, inputSchema: { type: "object" } },
          { name: collidingName, inputSchema: { type: "object" } },
        ],
      },
      { provider: "gemini", directToolLimit: 4 }
    );

    const names = projected.tools.notion?.map((tool) => tool.name) ?? [];
    expect(names).toHaveLength(2);
    expect(names[0].length).toBeLessThanOrEqual(64);
    expect(names[1].length).toBeLessThanOrEqual(64);
    expect(names[0]).not.toBe(names[1]);
    expect(names.every((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))).toBe(
      true
    );
    expect(projected.tools.notion?.[0]?.upstreamToolName).toBe(longName);
    expect(projected.tools.notion?.[1]?.upstreamToolName).toBe(collidingName);
  });
});
