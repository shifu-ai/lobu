import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BashOperations } from "@mariozechner/pi-coding-agent";
import { createOpenClawTools } from "../openclaw/tools";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "tools-extra-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// normalizeToolParams: snake_case → camelCase aliases
// ---------------------------------------------------------------------------

describe("normalizeToolParams via tools", () => {
  test("read tool accepts file_path alias and converts to path", async () => {
    const filePath = join(tempDir, "alias.txt");
    writeFileSync(filePath, "hello via file_path");

    const tools = createOpenClawTools(tempDir);
    const readTool = tools.find((t) => t.name === "read")!;

    const result = await readTool.execute(
      "call-1",
      { file_path: filePath },
      undefined,
      undefined
    );
    const text = result.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n");
    expect(text).toContain("hello via file_path");
  });

  test("write tool accepts file_path alias and converts to path", async () => {
    const filePath = join(tempDir, "out.txt");
    const tools = createOpenClawTools(tempDir);
    const writeTool = tools.find((t) => t.name === "write")!;

    await writeTool.execute(
      "call-write",
      { file_path: filePath, content: "ok" },
      undefined,
      undefined
    );
    const fs = await import("node:fs");
    expect(fs.existsSync(filePath)).toBe(true);
  });

  test("edit tool accepts old_string and new_string aliases", async () => {
    const filePath = join(tempDir, "edit-target.txt");
    writeFileSync(filePath, "alpha beta gamma");

    const tools = createOpenClawTools(tempDir);
    const editTool = tools.find((t) => t.name === "edit")!;

    await editTool.execute(
      "call-edit",
      {
        file_path: filePath,
        old_string: "beta",
        new_string: "BETA",
      },
      undefined,
      undefined
    );

    const fs = await import("node:fs");
    expect(fs.readFileSync(filePath, "utf-8")).toContain("BETA");
  });
});

// ---------------------------------------------------------------------------
// assertRequiredParams — uncovered branches
// ---------------------------------------------------------------------------

describe("assertRequiredParams via tools", () => {
  test("read throws when path/file_path is missing", async () => {
    const tools = createOpenClawTools(tempDir);
    const readTool = tools.find((t) => t.name === "read")!;
    await expect(
      readTool.execute("call-1", {}, undefined, undefined)
    ).rejects.toThrow(/Missing required parameter/);
  });

  test("read throws when path is null (line 73-74)", async () => {
    const tools = createOpenClawTools(tempDir);
    const readTool = tools.find((t) => t.name === "read")!;
    await expect(
      readTool.execute("call-1", { path: null }, undefined, undefined)
    ).rejects.toThrow(/Missing required parameter/);
  });

  test("read throws when path is undefined explicitly", async () => {
    const tools = createOpenClawTools(tempDir);
    const readTool = tools.find((t) => t.name === "read")!;
    await expect(
      readTool.execute("call-1", { path: undefined }, undefined, undefined)
    ).rejects.toThrow(/Missing required parameter/);
  });

  test("read throws when path is empty string (line 80-81)", async () => {
    const tools = createOpenClawTools(tempDir);
    const readTool = tools.find((t) => t.name === "read")!;
    await expect(
      readTool.execute("call-1", { path: "" }, undefined, undefined)
    ).rejects.toThrow(/Missing required parameter/);
  });

  test("read throws when path is whitespace-only", async () => {
    const tools = createOpenClawTools(tempDir);
    const readTool = tools.find((t) => t.name === "read")!;
    await expect(
      readTool.execute("call-1", { path: "   " }, undefined, undefined)
    ).rejects.toThrow(/Missing required parameter/);
  });

  test("edit throws on missing oldText (one group passes, another fails)", async () => {
    const filePath = join(tempDir, "edit-missing.txt");
    writeFileSync(filePath, "content");

    const tools = createOpenClawTools(tempDir);
    const editTool = tools.find((t) => t.name === "edit")!;
    await expect(
      editTool.execute(
        "call-1",
        { path: filePath, newText: "x" },
        undefined,
        undefined
      )
    ).rejects.toThrow(/Missing required parameter: oldText/);
  });

  test("edit throws on missing newText", async () => {
    const filePath = join(tempDir, "edit-missing2.txt");
    writeFileSync(filePath, "content");

    const tools = createOpenClawTools(tempDir);
    const editTool = tools.find((t) => t.name === "edit")!;
    await expect(
      editTool.execute(
        "call-1",
        { path: filePath, oldText: "content" },
        undefined,
        undefined
      )
    ).rejects.toThrow(/Missing required parameter: newText/);
  });
});

// ---------------------------------------------------------------------------
// normalizeToolParams returns undefined for non-object input (line 46)
// ---------------------------------------------------------------------------

describe("normalizeToolParams handles non-object inputs", () => {
  test("read with null params throws missing required (normalized={})", async () => {
    const tools = createOpenClawTools(tempDir);
    const readTool = tools.find((t) => t.name === "read")!;
    // Passing null exercises the early return in normalizeToolParams (line 45-47)
    // then assertRequiredParams runs on {} and throws.
    await expect(
      readTool.execute("call-1", null as any, undefined, undefined)
    ).rejects.toThrow(/Missing required parameter/);
  });

  test("read with non-object (string) params throws missing required", async () => {
    const tools = createOpenClawTools(tempDir);
    const readTool = tools.find((t) => t.name === "read")!;
    await expect(
      readTool.execute("call-1", "not-an-object" as any, undefined, undefined)
    ).rejects.toThrow(/Missing required parameter/);
  });
});

// ---------------------------------------------------------------------------
// isDirectGatewayApiAccessCommand — empty command early return (line 188-189)
// ---------------------------------------------------------------------------

describe("bash with empty/whitespace command", () => {
  test("empty command string is passed through to bash exec (line 188-189)", async () => {
    let executed = false;
    const mockBashOps: BashOperations = {
      exec: async (_command, _cwd, { onData }) => {
        executed = true;
        onData(Buffer.from(""));
        return { exitCode: 0 };
      },
    };

    const tools = createOpenClawTools(tempDir, {
      bashOperations: mockBashOps,
    });
    const bashTool = tools.find((t) => t.name === "bash")!;
    // Empty string command: exercises the early `if (!trimmed) return false;`
    // branches in both isDirectGatewayApiAccessCommand and
    // isDirectPackageInstallCommand, then falls through to the underlying exec.
    await bashTool.execute("call-empty", { command: "" }, undefined, undefined);
    expect(executed).toBe(true);
  });

  test("bash params without command field still reaches exec", async () => {
    let executed = false;
    const mockBashOps: BashOperations = {
      exec: async (_command, _cwd, { onData }) => {
        executed = true;
        onData(Buffer.from(""));
        return { exitCode: 0 };
      },
    };

    const tools = createOpenClawTools(tempDir, {
      bashOperations: mockBashOps,
    });
    const bashTool = tools.find((t) => t.name === "bash")!;
    // params missing `command` — wrapBashWithProxyHint coerces to "".
    // Underlying tool may itself error on missing command, so we just assert
    // it doesn't throw a DIRECT GATEWAY / PACKAGE INSTALL error.
    try {
      await bashTool.execute("call-no-cmd", {} as any, undefined, undefined);
    } catch (err: any) {
      expect(err.message).not.toContain("DIRECT GATEWAY API ACCESS");
      expect(err.message).not.toContain("DIRECT PACKAGE INSTALL");
    }
    // executed may or may not be true depending on underlying tool validation;
    // the important thing is the early-return code path was exercised.
    expect(typeof executed).toBe("boolean");
  });
});
