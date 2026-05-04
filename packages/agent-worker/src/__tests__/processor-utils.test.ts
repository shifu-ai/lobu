import { describe, expect, test } from "bun:test";
import { formatToolExecution } from "../shared/processor-utils";

describe("formatToolExecution", () => {
  test("returns null when verboseLogging is false", () => {
    expect(formatToolExecution("Read", { file_path: "/a" }, false)).toBeNull();
  });

  test("returns null with empty params and no verbose logging", () => {
    expect(formatToolExecution("Bash", {}, false)).toBeNull();
  });

  test("uses the configured emoji and original name for known tools", () => {
    const out = formatToolExecution(
      "Read",
      { file_path: "/tmp/foo.txt" },
      true
    );
    expect(out).toContain("📖");
    expect(out).toContain("**Read**");
    expect(out).toContain('"file_path": "/tmp/foo.txt"');
    expect(out?.startsWith("└ ")).toBe(true);
  });

  test("renders without a JSON block when params are empty", () => {
    const out = formatToolExecution("TodoWrite", {}, true);
    expect(out).toBe("└ 📝 **TodoWrite**");
    expect(out).not.toContain("```json");
  });

  test("falls back to the wrench emoji for unknown tool names", () => {
    const out = formatToolExecution(
      "totally_unknown_tool",
      { foo: "bar" },
      true
    );
    expect(out).toContain("🔧");
    expect(out).toContain("**totally_unknown_tool**");
  });

  test("formats MCP-style names (prefix__server__tool) with dot notation", () => {
    const out = formatToolExecution(
      "mcp__github__create_pull_request",
      { title: "x" },
      true
    );
    expect(out).toContain("**mcp.github.create_pull_request**");
    expect(out).toContain("🔧");
  });

  test("keeps the original name for an unknown tool that does not match the MCP shape", () => {
    const out = formatToolExecution("notmcp_one_two", { a: 1 }, true);
    // Only one underscore segment - regex requires three "__" delimited parts.
    expect(out).toContain("**notmcp_one_two**");
  });

  test("includes a fenced JSON block with the params when present", () => {
    const out = formatToolExecution("Bash", { command: "ls -la" }, true);
    expect(out).toContain("```json");
    expect(out).toContain('"command": "ls -la"');
    expect(out).toContain("```");
    expect(out).toContain("👾");
    expect(out).toContain("**Bash**");
  });
});
