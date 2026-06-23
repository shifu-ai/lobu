import { describe, expect, test } from "bun:test";
import { applyMcpToolFilter } from "@lobu/core";

const TOOLS = [
  { name: "read_page" },
  { name: "read_secret" },
  { name: "write_page" },
  { name: "resources_list" },
  { name: "resources_read" },
  { name: "admin_panel" },
];

describe("applyMcpToolFilter", () => {
  test("empty filter includes all tools", () => {
    expect(applyMcpToolFilter(TOOLS, {}).map((tool) => tool.name)).toEqual([
      "read_page",
      "read_secret",
      "write_page",
      "resources_list",
      "resources_read",
      "admin_panel",
    ]);
  });

  test("include before exclude with exact and star globs returns plan sample", () => {
    const filtered = applyMcpToolFilter(TOOLS, {
      include: ["read_*", "resources_list", "resources_read", "write_page"],
      exclude: ["read_secret", "resources_r*", "write_*"],
    });

    expect(filtered.map((tool) => tool.name)).toEqual([
      "read_page",
      "resources_list",
    ]);
  });
});
