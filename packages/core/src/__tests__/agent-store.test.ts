import { describe, expect, test } from "bun:test";
import {
  type AgentConfigStore,
  type AgentMetadata,
  type AgentSettings,
  findTemplateAgentId,
  inferGrantKind,
} from "../agent-store";

describe("inferGrantKind", () => {
  test("classifies leading-slash patterns as mcp_tool", () => {
    expect(inferGrantKind("/mcp/gmail/tools/send_email")).toBe("mcp_tool");
    expect(inferGrantKind("/mcp/linear/tools/*")).toBe("mcp_tool");
    expect(inferGrantKind("/")).toBe("mcp_tool");
  });

  test("classifies non-slash patterns as domain", () => {
    expect(inferGrantKind("api.github.com")).toBe("domain");
    expect(inferGrantKind("*.example.com")).toBe("domain");
    expect(inferGrantKind("")).toBe("domain");
  });
});

// Minimal in-memory stub of the subset of AgentConfigStore that
// findTemplateAgentId actually needs. Keeps tests filesystem/db-free.
function makeStub(
  agents: AgentMetadata[],
  settingsByAgent: Record<string, AgentSettings | null>
): Pick<AgentConfigStore, "listAgents" | "getSettings"> {
  return {
    async listAgents() {
      return agents;
    },
    async getSettings(agentId: string) {
      return settingsByAgent[agentId] ?? null;
    },
  };
}

function meta(overrides: Partial<AgentMetadata>): AgentMetadata {
  return {
    agentId: "agent-1",
    name: "Agent 1",
    owner: { platform: "local", userId: "u1" },
    createdAt: 0,
    ...overrides,
  };
}

describe("findTemplateAgentId", () => {
  test("returns null when there are no agents", async () => {
    const store = makeStub([], {});
    expect(await findTemplateAgentId(store)).toBeNull();
  });

  test("returns null when no agent has installed providers", async () => {
    const store = makeStub([meta({ agentId: "a" }), meta({ agentId: "b" })], {
      a: { updatedAt: 0 },
      b: { updatedAt: 0, installedProviders: [] },
    });
    expect(await findTemplateAgentId(store)).toBeNull();
  });

  test("returns the first agent that has installed providers", async () => {
    const store = makeStub(
      [meta({ agentId: "a" }), meta({ agentId: "b" }), meta({ agentId: "c" })],
      {
        a: { updatedAt: 0 },
        b: {
          updatedAt: 0,
          installedProviders: [{ id: "anthropic", config: {} } as any],
        },
        c: {
          updatedAt: 0,
          installedProviders: [{ id: "openai", config: {} } as any],
        },
      }
    );
    expect(await findTemplateAgentId(store)).toBe("b");
  });

  test("skips sandbox agents (those with parentConnectionId)", async () => {
    const store = makeStub(
      [
        meta({ agentId: "sandbox-1", parentConnectionId: "conn-1" }),
        meta({ agentId: "real" }),
      ],
      {
        "sandbox-1": {
          updatedAt: 0,
          installedProviders: [{ id: "anthropic", config: {} } as any],
        },
        real: {
          updatedAt: 0,
          installedProviders: [{ id: "openai", config: {} } as any],
        },
      }
    );
    expect(await findTemplateAgentId(store)).toBe("real");
  });

  test("handles agents whose settings are missing", async () => {
    const store = makeStub([meta({ agentId: "a" }), meta({ agentId: "b" })], {
      a: null,
      b: {
        updatedAt: 0,
        installedProviders: [{ id: "openai", config: {} } as any],
      },
    });
    expect(await findTemplateAgentId(store)).toBe("b");
  });
});
