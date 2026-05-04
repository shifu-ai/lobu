import { describe, expect, test } from "bun:test";
import type { InstructionContext, InstructionProvider } from "@lobu/core";
import { generateCustomInstructions } from "../instructions/builder";

function makeContext(
  overrides: Partial<InstructionContext> = {}
): InstructionContext {
  return {
    userId: "U-TEST",
    agentId: "agent-test",
    sessionKey: "session-test",
    workingDirectory: "/tmp/test-workdir",
    availableProjects: [],
    ...overrides,
  };
}

function makeProvider(
  name: string,
  priority: number,
  text: string | (() => Promise<string> | string)
): InstructionProvider {
  return {
    name,
    priority,
    getInstructions: typeof text === "function" ? text : () => text,
  };
}

describe("generateCustomInstructions", () => {
  test("returns empty string when no providers are given", async () => {
    const result = await generateCustomInstructions([], makeContext());
    expect(result).toBe("");
  });

  test("returns the single section when only one provider yields text", async () => {
    const result = await generateCustomInstructions(
      [makeProvider("only", 10, "hello")],
      makeContext()
    );
    expect(result).toBe("hello");
  });

  test("joins multiple sections with two newlines", async () => {
    const result = await generateCustomInstructions(
      [makeProvider("a", 10, "first"), makeProvider("b", 20, "second")],
      makeContext()
    );
    expect(result).toBe("first\n\nsecond");
  });

  test("orders sections by ascending priority regardless of input order", async () => {
    const result = await generateCustomInstructions(
      [
        makeProvider("late", 100, "LAST"),
        makeProvider("early", 1, "FIRST"),
        makeProvider("mid", 50, "MIDDLE"),
      ],
      makeContext()
    );
    expect(result).toBe("FIRST\n\nMIDDLE\n\nLAST");
  });

  test("trims whitespace and skips providers that return empty/whitespace", async () => {
    const result = await generateCustomInstructions(
      [
        makeProvider("blank", 10, "   "),
        makeProvider("padded", 20, "  hello world  "),
        makeProvider("empty", 30, ""),
      ],
      makeContext()
    );
    expect(result).toBe("hello world");
  });

  test("supports async providers", async () => {
    const result = await generateCustomInstructions(
      [
        makeProvider("async", 5, async () => "async-text"),
        makeProvider("sync", 10, "sync-text"),
      ],
      makeContext()
    );
    expect(result).toBe("async-text\n\nsync-text");
  });

  test("ignores a single throwing provider but keeps the others", async () => {
    const result = await generateCustomInstructions(
      [
        makeProvider("good-1", 1, "alpha"),
        makeProvider("bad", 2, () => {
          throw new Error("boom");
        }),
        makeProvider("good-2", 3, "beta"),
      ],
      makeContext()
    );
    expect(result).toBe("alpha\n\nbeta");
  });

  test("handles a provider returning null/undefined gracefully", async () => {
    const result = await generateCustomInstructions(
      [
        makeProvider("present", 1, "kept"),
        makeProvider("absent", 2, () => undefined as unknown as string),
      ],
      makeContext()
    );
    expect(result).toBe("kept");
  });

  test("does not mutate the caller's provider array order", async () => {
    const providers = [makeProvider("z", 99, "Z"), makeProvider("a", 1, "A")];
    const snapshot = providers.map((p) => p.name);
    await generateCustomInstructions(providers, makeContext());
    expect(providers.map((p) => p.name)).toEqual(snapshot);
  });
});
