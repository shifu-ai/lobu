import { describe, expect, test } from "bun:test";
import type { InstructionContext } from "@lobu/core";
import { ProjectsInstructionProvider } from "../instructions/providers";

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

describe("ProjectsInstructionProvider", () => {
  test("exposes the canonical name and priority", () => {
    const provider = new ProjectsInstructionProvider();
    expect(provider.name).toBe("projects");
    expect(provider.priority).toBe(30);
  });

  test('returns "none" when no projects are present', () => {
    const provider = new ProjectsInstructionProvider();
    const result = provider.getInstructions(makeContext());
    expect(result).toContain("**Available projects:**");
    expect(result).toContain("- none");
  });

  test("returns 'none' when availableProjects is missing entirely", () => {
    const provider = new ProjectsInstructionProvider();
    const ctx = makeContext();
    delete (ctx as { availableProjects?: string[] }).availableProjects;
    const result = provider.getInstructions(ctx);
    expect(result).toContain("- none");
  });

  test("renders a single project as a bullet item", () => {
    const provider = new ProjectsInstructionProvider();
    const result = provider.getInstructions(
      makeContext({ availableProjects: ["alpha"] })
    );
    expect(result).toBe("**Available projects:**\n  - alpha");
  });

  test("renders multiple projects on separate bullets in input order", () => {
    const provider = new ProjectsInstructionProvider();
    const result = provider.getInstructions(
      makeContext({ availableProjects: ["alpha", "beta", "gamma"] })
    );
    expect(result).toBe(
      "**Available projects:**\n  - alpha\n  - beta\n  - gamma"
    );
  });
});
