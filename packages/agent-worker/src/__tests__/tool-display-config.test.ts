import { describe, expect, test } from "bun:test";
import { getToolDisplayConfig } from "../shared/tool-display-config";

describe("getToolDisplayConfig", () => {
  test("returns the entry for a known PascalCase tool name", () => {
    const cfg = getToolDisplayConfig("Read");
    expect(cfg).toBeDefined();
    expect(cfg?.emoji).toBe("📖");
    expect(cfg?.action).toBe("Reading");
  });

  test("falls back via capitalization for lowercase tool names", () => {
    const cfg = getToolDisplayConfig("read");
    expect(cfg).toBeDefined();
    expect(cfg?.emoji).toBe("📖");
    expect(cfg?.action).toBe("Reading");
  });

  test("returns undefined for unknown tools", () => {
    expect(getToolDisplayConfig("definitely-not-a-tool")).toBeUndefined();
  });

  test("returns undefined for the empty string without crashing", () => {
    expect(getToolDisplayConfig("")).toBeUndefined();
  });

  test("Write entry produces a backtick-wrapped file path", () => {
    const cfg = getToolDisplayConfig("Write");
    expect(cfg?.emoji).toBe("✏️");
    expect(cfg?.action).toBe("Writing");
    expect(cfg?.getParam({ file_path: "/tmp/x.md" })).toBe("`/tmp/x.md`");
    expect(cfg?.getParam({})).toBe("``");
  });

  test("Edit entry produces a backtick-wrapped file path", () => {
    const cfg = getToolDisplayConfig("Edit");
    expect(cfg?.emoji).toBe("✏️");
    expect(cfg?.action).toBe("Editing");
    expect(cfg?.getParam({ file_path: "/tmp/y.md" })).toBe("`/tmp/y.md`");
  });

  test("Bash entry uses command, falls back to description, then 'command'", () => {
    const cfg = getToolDisplayConfig("Bash");
    expect(cfg?.emoji).toBe("👾");
    expect(cfg?.action).toBe("Running");
    expect(cfg?.getParam({ command: "ls" })).toBe("`ls`");
    expect(cfg?.getParam({ description: "described" })).toBe("`described`");
    expect(cfg?.getParam({})).toBe("`command`");
  });

  test("Bash entry truncates long commands at 50 chars with ellipsis", () => {
    const cfg = getToolDisplayConfig("Bash");
    const long = "a".repeat(80);
    const out = cfg?.getParam({ command: long });
    expect(out).toBeDefined();
    expect(out?.endsWith("...`")).toBe(true);
    // 50 chars + "..." inside the backticks
    expect(out).toBe(`\`${"a".repeat(50)}...\``);
  });

  test("Bash entry does not truncate exactly-50-char commands", () => {
    const cfg = getToolDisplayConfig("Bash");
    const fifty = "b".repeat(50);
    expect(cfg?.getParam({ command: fifty })).toBe(`\`${fifty}\``);
  });

  test("Read entry prefers file_path then path", () => {
    const cfg = getToolDisplayConfig("Read");
    expect(cfg?.getParam({ file_path: "/a" })).toBe("`/a`");
    expect(cfg?.getParam({ path: "/b" })).toBe("`/b`");
    expect(cfg?.getParam({})).toBe("``");
  });

  test("Grep entry surfaces pattern", () => {
    const cfg = getToolDisplayConfig("Grep");
    expect(cfg?.emoji).toBe("🔍");
    expect(cfg?.action).toBe("Searching");
    expect(cfg?.getParam({ pattern: "TODO" })).toBe("`TODO`");
    expect(cfg?.getParam({})).toBe("``");
  });

  test("Glob entry surfaces pattern", () => {
    const cfg = getToolDisplayConfig("Glob");
    expect(cfg?.emoji).toBe("🔍");
    expect(cfg?.action).toBe("Finding");
    expect(cfg?.getParam({ pattern: "**/*.ts" })).toBe("`**/*.ts`");
  });

  test("TodoWrite entry yields no params", () => {
    const cfg = getToolDisplayConfig("TodoWrite");
    expect(cfg?.emoji).toBe("📝");
    expect(cfg?.action).toBe("Updating task list");
    expect(cfg?.getParam({ todos: [1, 2, 3] })).toBe("");
    expect(cfg?.getParam({})).toBe("");
  });

  test("WebFetch entry surfaces url", () => {
    const cfg = getToolDisplayConfig("WebFetch");
    expect(cfg?.emoji).toBe("🌐");
    expect(cfg?.action).toBe("Fetching");
    expect(cfg?.getParam({ url: "https://example.com" })).toBe(
      "`https://example.com`"
    );
    expect(cfg?.getParam({})).toBe("``");
  });

  test("WebSearch entry surfaces query", () => {
    const cfg = getToolDisplayConfig("WebSearch");
    expect(cfg?.emoji).toBe("🔎");
    expect(cfg?.action).toBe("Searching web");
    expect(cfg?.getParam({ query: "openclaw" })).toBe("`openclaw`");
    expect(cfg?.getParam({})).toBe("``");
  });
});
