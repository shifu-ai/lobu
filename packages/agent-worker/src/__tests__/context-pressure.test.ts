import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  estimateContextTokens,
  isProviderPromptTooLongError,
  normalizeToolTextForContext,
  prepareUserPromptForContext,
  readContextArtifactChunk,
  userFacingContextPressureMessage,
} from "../openclaw/context-pressure";

describe("context pressure", () => {
  test("spills oversized incoming text to an artifact descriptor", async () => {
    const workspaceDir = await mkdtemp(
      join(tmpdir(), "lobu-context-pressure-")
    );
    try {
      const hugePrompt = [
        "請比較下面兩版銷售草稿。",
        "A".repeat(120_000),
        "B".repeat(120_000),
      ].join("\n\n");

      const result = await prepareUserPromptForContext({
        workspaceDir,
        promptText: hugePrompt,
        source: "line",
        runId: "run-test-1",
        effectiveCapTokens: 24_000,
      });

      expect(result.classification).toBe("needs_spill");
      expect(result.promptText.length).toBeLessThan(4_000);
      expect(result.promptText).toContain("ctx_art_");
      expect(result.promptText).toContain("artifact_read");
      expect(result.artifacts).toHaveLength(1);
      const artifact = result.artifacts[0];
      expect(artifact?.source).toBe("line");
      expect(artifact?.estimatedTokens).toBeGreaterThan(24_000);
      if (!artifact) {
        throw new Error("Expected spilled artifact");
      }

      const stored = await readFile(artifact.path, "utf-8");
      expect(stored).toBe(hugePrompt);
      expect(estimateContextTokens(result.promptText, 0)).toBeLessThan(24_000);
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  test("keeps small prompts inline", async () => {
    const workspaceDir = await mkdtemp(
      join(tmpdir(), "lobu-context-pressure-")
    );
    try {
      const result = await prepareUserPromptForContext({
        workspaceDir,
        promptText: "請幫我整理今天的會議重點。",
        source: "line",
        runId: "run-test-2",
        effectiveCapTokens: 24_000,
      });

      expect(result.classification).toBe("fits");
      expect(result.promptText).toBe("請幫我整理今天的會議重點。");
      expect(result.artifacts).toEqual([]);
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  test("reads a selected artifact chunk without returning the whole artifact", async () => {
    const workspaceDir = await mkdtemp(
      join(tmpdir(), "lobu-context-pressure-")
    );
    try {
      const text = [
        "first".repeat(3000),
        "second".repeat(3000),
        "third".repeat(3000),
      ].join("\n");
      const prepared = await prepareUserPromptForContext({
        workspaceDir,
        promptText: text,
        source: "line",
        runId: "run-test-3",
        effectiveCapTokens: 2_000,
      });

      const artifact = prepared.artifacts[0];
      if (!artifact) {
        throw new Error("Expected spilled artifact");
      }

      const chunk = await readContextArtifactChunk({
        workspaceDir,
        artifactId: artifact.artifactId,
        chunkIndex: 1,
        chunkChars: 4_000,
      });

      expect(chunk.artifactId).toBe(artifact.artifactId);
      expect(chunk.chunkIndex).toBe(1);
      expect(chunk.totalChunks).toBeGreaterThan(1);
      expect(chunk.text.length).toBeLessThanOrEqual(4_000);
      expect(chunk.text).not.toBe(text);
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  test("returns the expected text for a selected artifact chunk", async () => {
    const workspaceDir = await mkdtemp(
      join(tmpdir(), "lobu-context-pressure-")
    );
    try {
      const text = "0123456789".repeat(4_000);
      const prepared = await prepareUserPromptForContext({
        workspaceDir,
        promptText: text,
        source: "line",
        runId: "run-test-4",
        effectiveCapTokens: 1,
      });

      const artifact = prepared.artifacts[0];
      if (!artifact) {
        throw new Error("Expected spilled artifact");
      }

      const chunk = await readContextArtifactChunk({
        workspaceDir,
        artifactId: artifact.artifactId,
        chunkIndex: 2,
        chunkChars: 6,
      });

      expect(chunk).toEqual({
        artifactId: artifact.artifactId,
        chunkIndex: 2,
        totalChunks: 6_667,
        text: "234567",
      });
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  test("spills oversized tool result to a readable artifact descriptor", async () => {
    const workspaceDir = await mkdtemp(
      join(tmpdir(), "lobu-context-pressure-tool-")
    );
    try {
      const toolResult = "X".repeat(120_000);
      const descriptor = await normalizeToolTextForContext({
        workspaceDir,
        text: toolResult,
        source: "mcp",
        runId: "run-tool-1",
        toolLabel: "docs/read_big_doc",
      });

      expect(descriptor.length).toBeLessThan(4_000);
      expect(descriptor).toContain("ctx_art_");
      expect(descriptor).toContain("artifact_read");
      expect(descriptor).toContain("Kind: tool_result");

      const artifactId = descriptor.match(/ctx_art_[a-f0-9]+/)?.[0];
      if (!artifactId) {
        throw new Error("Expected artifact id in descriptor");
      }

      const chunk = await readContextArtifactChunk({
        workspaceDir,
        artifactId,
        chunkIndex: 0,
      });
      expect(chunk.text).toBe(toolResult.slice(0, 12_000));
      expect(chunk.totalChunks).toBe(10);
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  test("keeps small tool results inline", async () => {
    const result = await normalizeToolTextForContext({
      workspaceDir: "/unused",
      text: "small result",
      source: "mcp",
      runId: "run-tool-2",
      toolLabel: "docs/read_small_doc",
    });

    expect(result).toBe("small result");
  });

  test("preserves error prefix when oversized tool error is spilled", async () => {
    const workspaceDir = await mkdtemp(
      join(tmpdir(), "lobu-context-pressure-tool-error-")
    );
    try {
      const descriptor = await normalizeToolTextForContext({
        workspaceDir,
        text: `Error: ${"upstream failure ".repeat(10_000)}`,
        source: "mcp",
        runId: "run-tool-3",
        toolLabel: "docs/read_big_doc",
        descriptorPrefix: "Error: Large MCP tool error output was stored as artifact.",
      });

      expect(descriptor).toStartWith("Error:");
      expect(descriptor.length).toBeLessThan(4_000);
      expect(descriptor).toContain("ctx_art_");
      expect(descriptor).toContain("artifact_read");
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  test("detects provider prompt-too-long errors without exposing raw provider payload", () => {
    const raw =
      '400 {"type":"error","message":"prompt is too long: 207585 tokens > 200000 maximum"}';

    expect(isProviderPromptTooLongError(raw)).toBe(true);

    const message = userFacingContextPressureMessage();
    expect(message).not.toContain("207585");
    expect(message).not.toContain("200000");
    expect(message).not.toContain("400");
    expect(message).not.toContain('{"type":"error"');
    expect(message).toContain("內容");
  });

  test("detects common provider context length variants", () => {
    expect(
      isProviderPromptTooLongError("BadRequestError: context length exceeded")
    ).toBe(true);
    expect(
      isProviderPromptTooLongError("input exceeds maximum context window")
    ).toBe(true);
  });

  test("does not classify unrelated provider errors as prompt-too-long", () => {
    expect(isProviderPromptTooLongError("401 invalid api key")).toBe(false);
    expect(isProviderPromptTooLongError("429 rate limit exceeded")).toBe(false);
    expect(isProviderPromptTooLongError("network connection reset")).toBe(false);
  });
});
