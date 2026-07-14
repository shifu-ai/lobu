import { afterEach, describe, expect, mock, test } from "bun:test";
import type { McpToolDef } from "@lobu/core";
import {
  buildMcpCliCommands,
  buildMcpServerHandler,
  isMcpIdReserved,
  type McpRuntimeRef,
  type McpRuntimeState,
  parsePayload,
  summariseAuthCheck,
  summariseAuthStart,
} from "../embedded/mcp-cli-commands";
import { applyCapabilityLimitNotes } from "../openclaw/mcp-tool-projection";
import type { GatewayParams } from "../shared/tool-implementations";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const gw: GatewayParams = {
  gatewayUrl: "http://gateway",
  workerToken: "worker-token",
  agentId: "agent-1",
  channelId: "channel-1",
  conversationId: "conversation-1",
  platform: "telegram",
};

function makeRef(overrides: Partial<McpRuntimeState> = {}): McpRuntimeRef {
  return {
    current: {
      mcpTools: overrides.mcpTools ?? {},
      mcpStatus: overrides.mcpStatus ?? [],
      mcpContext: overrides.mcpContext ?? {},
    },
  };
}

const lobuTool: McpToolDef = {
  name: "search_memory",
  description: "Search the memory store",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
};

const planAutomationTool: McpToolDef = {
  name: "plan_automation",
  description: "Plan an automation",
  inputSchema: { type: "object", properties: {} },
};

const calendarResolverTool: McpToolDef = {
  name: "resolve_calendar_date",
  description: "Resolve a calendar date",
  inputSchema: { type: "object", properties: {} },
};

function trustedToolboxStatus(configDigest: string) {
  return {
    id: "shifu-toolbox",
    name: "ShiFu Toolbox",
    requiresAuth: false,
    requiresInput: false,
    authenticated: true,
    configured: true,
    upstreamOrigin: "https://mcp.shifu-ai.org",
    configSource: "agent" as const,
    configDigest,
  };
}

describe("parsePayload", () => {
  test("empty stdin and no inline arg yields empty object", () => {
    expect(parsePayload(undefined, undefined)).toEqual({
      ok: true,
      payload: {},
    });
  });

  test("whitespace stdin yields empty object", () => {
    expect(parsePayload("   \n", undefined)).toEqual({
      ok: true,
      payload: {},
    });
  });

  test("parses JSON from stdin", () => {
    expect(parsePayload('{"q":"hello"}', undefined)).toEqual({
      ok: true,
      payload: { q: "hello" },
    });
  });

  test("falls back to inline arg when stdin empty", () => {
    expect(parsePayload("", '{"q":"x"}')).toEqual({
      ok: true,
      payload: { q: "x" },
    });
  });

  test("rejects non-object JSON (array)", () => {
    const result = parsePayload("[1, 2, 3]", undefined);
    expect(result.ok).toBe(false);
  });

  test("rejects malformed JSON", () => {
    const result = parsePayload("{not json", undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("invalid JSON");
    }
  });
});

describe("isMcpIdReserved", () => {
  test("rejects bash builtins", () => {
    expect(isMcpIdReserved("cd")).toContain("reserved");
    expect(isMcpIdReserved("echo")).toContain("reserved");
  });

  test("rejects package-manager ids", () => {
    expect(isMcpIdReserved("npm")).toContain("package-install");
    expect(isMcpIdReserved("pip")).toContain("package-install");
  });

  test("allows normal MCP ids", () => {
    expect(isMcpIdReserved("lobu")).toBeNull();
    expect(isMcpIdReserved("gmail")).toBeNull();
  });
});

describe("buildMcpServerHandler", () => {
  test("passes the exact discovered identity for trusted reserved automation calls", async () => {
    const ref = makeRef({
      mcpTools: { "shifu-toolbox": [planAutomationTool] },
      mcpStatus: [trustedToolboxStatus("digest-v1")],
    });
    const identities: unknown[] = [];
    const handler = buildMcpServerHandler("shifu-toolbox", ref, gw, {
      callTool: async (_gw, _mcpId, _toolName, _payload, options) => {
        identities.push(options?.expectedMcpIdentity);
        return { content: [] };
      },
    });

    expect((await handler(["plan_automation"], { stdin: "{}" })).exitCode).toBe(
      0
    );
    expect(identities).toEqual([
      {
        upstreamOrigin: "https://mcp.shifu-ai.org",
        configSource: "agent",
        configDigest: "digest-v1",
      },
    ]);
  });

  test("uses the refreshed discovery identity on the next CLI call", async () => {
    const ref = makeRef({
      mcpTools: { "shifu-toolbox": [planAutomationTool] },
      mcpStatus: [trustedToolboxStatus("digest-v1")],
    });
    const digests: Array<string | undefined> = [];
    const handler = buildMcpServerHandler("shifu-toolbox", ref, gw, {
      callTool: async (_gw, _mcpId, _toolName, _payload, options) => {
        digests.push(options?.expectedMcpIdentity?.configDigest);
        return { content: [] };
      },
    });

    await handler(["plan_automation"], { stdin: "{}" });
    ref.current = {
      ...ref.current,
      mcpStatus: [trustedToolboxStatus("digest-v2")],
    };
    await handler(["plan_automation"], { stdin: "{}" });

    expect(digests).toEqual(["digest-v1", "digest-v2"]);
  });

  test("fails closed when the calendar gateway identity changed after CLI discovery", async () => {
    const ref = makeRef({
      mcpTools: { "shifu-toolbox": [calendarResolverTool] },
      mcpStatus: [trustedToolboxStatus("stale-discovery-digest")],
    });
    let capturedDigest: string | null = null;
    globalThis.fetch = mock(async (_input, init) => {
      capturedDigest = new Headers(init?.headers).get(
        "x-lobu-mcp-expected-config-digest"
      );
      return Response.json(
        {
          error: "MCP configuration identity changed after discovery",
          diagnosticCode: "MCP_CONFIG_IDENTITY_MISMATCH",
        },
        { status: 409 }
      );
    }) as unknown as typeof fetch;
    const handler = buildMcpServerHandler("shifu-toolbox", ref, gw);

    const result = await handler(["resolve_calendar_date"], { stdin: "{}" });

    expect(capturedDigest).toBe("stale-discovery-digest");
    expect(result.stdout).toContain("Error:");
    expect(result.stdout).toContain("identity changed after discovery");
    expect(result.stdout).not.toContain("completed");
  });

  test("revalidates the CLI exposure policy for help, schema, and call", async () => {
    let allowed = false;
    const ref = makeRef({ mcpTools: { lobu: [lobuTool] } });
    ref.isToolInvocationAllowed = (mcpId, tool) =>
      allowed && mcpId === "lobu" && tool.name === "search_memory";
    let calls = 0;
    const handler = buildMcpServerHandler("lobu", ref, gw, {
      callTool: async () => {
        calls++;
        return { content: [] };
      },
    });

    const deniedHelp = await handler(["--help"], {});
    expect(deniedHelp.stdout).not.toContain("search_memory");
    expect((await handler(["search_memory", "--schema"], {})).exitCode).toBe(2);
    expect((await handler(["search_memory"], { stdin: "{}" })).exitCode).toBe(
      2
    );
    expect(calls).toBe(0);

    allowed = true;
    expect((await handler(["--help"], {})).stdout).toContain("search_memory");
    expect((await handler(["search_memory", "--schema"], {})).exitCode).toBe(0);
    expect((await handler(["search_memory"], { stdin: "{}" })).exitCode).toBe(
      0
    );
    expect(calls).toBe(1);
  });

  test("--help lists tools and usage", async () => {
    const ref = makeRef({
      mcpTools: { lobu: [lobuTool] },
      mcpStatus: [
        {
          id: "lobu",
          name: "Lobu",
          requiresAuth: true,
          requiresInput: false,
          authenticated: true,
          configured: true,
        },
      ],
    });
    const handler = buildMcpServerHandler("lobu", ref, gw, {
      callTool: async () => ({ content: [] }),
    });

    const result = await handler(["--help"], {});
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("lobu — MCP server CLI");
    expect(result.stdout).toContain("search_memory");
    expect(result.stdout).toContain("auth login|check|logout");
  });

  test("--help prints the capability-limit note for a notion tool on the cli-exposure path", async () => {
    // Mirrors session-runner's cli-exposure wiring: mcpTools flow through
    // applyCapabilityLimitNotes before landing in mcpRuntimeRef.current,
    // since this path bypasses projectMcpToolsForProvider entirely.
    const notionUpdatePage: McpToolDef = {
      name: "notion-update-page",
      description: "Update a Notion page.",
      inputSchema: { type: "object", properties: {} },
    };
    const ref = makeRef({
      mcpTools: applyCapabilityLimitNotes({ notion: [notionUpdatePage] }),
    });
    const handler = buildMcpServerHandler("notion", ref, gw, {
      callTool: async () => ({ content: [] }),
    });

    const result = await handler(["--help"], {});
    expect(result.exitCode).toBe(0);
    // The help renderer truncates descriptions to 80 chars, so only the
    // start of the note survives — that's enough to prove it was applied.
    expect(result.stdout).toContain(
      "Update a Notion page. IMPORTANT: This tool CANNOT delete"
    );
  });

  test("--schema prints JSON schema for a known tool", async () => {
    const ref = makeRef({ mcpTools: { lobu: [lobuTool] } });
    const handler = buildMcpServerHandler("lobu", ref, gw, {
      callTool: async () => ({ content: [] }),
    });

    const result = await handler(["search_memory", "--schema"], {});
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toEqual(lobuTool.inputSchema);
  });

  test("--schema on unknown tool exits 2", async () => {
    const ref = makeRef({ mcpTools: { lobu: [] } });
    const handler = buildMcpServerHandler("lobu", ref, gw, {
      callTool: async () => ({ content: [] }),
    });

    const result = await handler(["nope", "--schema"], {});
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("unknown tool");
  });

  test("tool invocation parses JSON from stdin and routes to callTool", async () => {
    const ref = makeRef({ mcpTools: { lobu: [lobuTool] } });
    const calls: Array<{
      mcpId: string;
      toolName: string;
      payload: Record<string, unknown>;
    }> = [];
    const handler = buildMcpServerHandler("lobu", ref, gw, {
      callTool: async (_gw, mcpId, toolName, payload) => {
        calls.push({ mcpId, toolName, payload });
        return { content: [{ type: "text", text: "search ok" }] };
      },
    });

    const result = await handler(["search_memory"], {
      stdin: '{"query":"architecture"}',
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("search ok");
    expect(calls).toEqual([
      {
        mcpId: "lobu",
        toolName: "search_memory",
        payload: { query: "architecture" },
      },
    ]);
  });

  test("tool invocation falls back to args[1] when stdin is empty", async () => {
    const ref = makeRef({ mcpTools: { lobu: [lobuTool] } });
    const captured: Record<string, unknown>[] = [];
    const handler = buildMcpServerHandler("lobu", ref, gw, {
      callTool: async (_gw, _mcpId, _toolName, payload) => {
        captured.push(payload);
        return { content: [] };
      },
    });

    const result = await handler(["search_memory", '{"query":"inline"}'], {});
    expect(result.exitCode).toBe(0);
    expect(captured).toEqual([{ query: "inline" }]);
  });

  test("tool invocation defaults to empty object when no payload given", async () => {
    const ref = makeRef({ mcpTools: { lobu: [lobuTool] } });
    const captured: Record<string, unknown>[] = [];
    const handler = buildMcpServerHandler("lobu", ref, gw, {
      callTool: async (_gw, _mcpId, _toolName, payload) => {
        captured.push(payload);
        return { content: [] };
      },
    });

    const result = await handler(["search_memory"], {});
    expect(result.exitCode).toBe(0);
    expect(captured).toEqual([{}]);
  });

  test("invalid JSON payload exits 2", async () => {
    const ref = makeRef({ mcpTools: { lobu: [lobuTool] } });
    const handler = buildMcpServerHandler("lobu", ref, gw, {
      callTool: async () => {
        throw new Error("should not be called");
      },
    });

    const result = await handler(["search_memory"], { stdin: "{not json" });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("invalid JSON");
  });

  test("unknown tool exits 2", async () => {
    const ref = makeRef({ mcpTools: { lobu: [] } });
    const handler = buildMcpServerHandler("lobu", ref, gw, {
      callTool: async () => ({ content: [] }),
    });

    const result = await handler(["mystery"], {});
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("unknown tool");
  });

  test("callTool throwing surfaces as exitCode 1", async () => {
    const ref = makeRef({ mcpTools: { lobu: [lobuTool] } });
    const handler = buildMcpServerHandler("lobu", ref, gw, {
      callTool: async () => {
        throw new Error("network down");
      },
    });

    const result = await handler(["search_memory"], { stdin: "{}" });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("network down");
  });

  test("reads mcpTools through ref.current on each invocation", async () => {
    // Start empty, then mutate the ref and confirm the handler picks up new tools.
    const ref = makeRef({ mcpTools: { lobu: [] } });
    const handler = buildMcpServerHandler("lobu", ref, gw, {
      callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
    });

    const r1 = await handler(["search_memory"], {});
    expect(r1.exitCode).toBe(2);

    ref.current = {
      ...ref.current,
      mcpTools: { lobu: [lobuTool] },
    };

    const r2 = await handler(["search_memory"], { stdin: "{}" });
    expect(r2.exitCode).toBe(0);
  });
});

describe("buildMcpCliCommands", () => {
  test("builds one command per MCP server", () => {
    const ref = makeRef({
      mcpTools: { lobu: [lobuTool] },
      mcpStatus: [
        {
          id: "gmail",
          name: "Gmail",
          requiresAuth: true,
          requiresInput: false,
          authenticated: false,
          configured: true,
        },
      ],
    });
    const commands = buildMcpCliCommands(ref, gw);
    expect(commands.map((c) => c.name).sort()).toEqual(["gmail", "lobu"]);
  });

  test("skips MCP ids that collide with bash builtins", () => {
    const ref = makeRef({
      mcpStatus: [
        {
          id: "echo",
          name: "Echo",
          requiresAuth: false,
          requiresInput: false,
          authenticated: true,
          configured: true,
        },
        {
          id: "lobu",
          name: "Lobu",
          requiresAuth: false,
          requiresInput: false,
          authenticated: true,
          configured: true,
        },
      ],
    });
    const commands = buildMcpCliCommands(ref, gw);
    expect(commands.map((c) => c.name)).toEqual(["lobu"]);
  });

  test("skips MCP ids that collide with package-install denylist", () => {
    const ref = makeRef({
      mcpStatus: [
        {
          id: "npm",
          name: "Not npm",
          requiresAuth: false,
          requiresInput: false,
          authenticated: true,
          configured: true,
        },
      ],
    });
    const commands = buildMcpCliCommands(ref, gw);
    expect(commands).toEqual([]);
  });
});

describe("summariseAuthStart / summariseAuthCheck", () => {
  test("summariseAuthStart collapses login_started to a short status without URL", () => {
    const out = summariseAuthStart(
      JSON.stringify({
        status: "login_started",
        verification_url: "https://example.com/verify",
        interaction_posted: true,
      }),
      "lobu"
    );
    const parsed = JSON.parse(out);
    expect(parsed.status).toBe("login_started");
    expect(parsed.mcp_id).toBe("lobu");
    expect(parsed.interaction_posted).toBe(true);
    expect(out).not.toContain("https://example.com/verify");
  });

  test("summariseAuthStart passes through already_authenticated", () => {
    const out = summariseAuthStart(
      JSON.stringify({ status: "already_authenticated" }),
      "lobu"
    );
    expect(JSON.parse(out).status).toBe("already_authenticated");
  });

  test("summariseAuthStart falls through to raw when interaction_posted=false so URL stays reachable", () => {
    const raw = JSON.stringify({
      status: "login_started",
      verification_url: "https://example.com/verify",
      user_code: "ABCD-1234",
      interaction_posted: false,
    });
    const out = summariseAuthStart(raw, "lobu");
    expect(out).toBe(raw);
    expect(out).toContain("https://example.com/verify");
    expect(out).toContain("ABCD-1234");
  });

  test("summariseAuthCheck emits authenticated=true on success", () => {
    const out = summariseAuthCheck(
      { status: "authenticated", authenticated: true },
      "lobu",
      "raw"
    );
    expect(JSON.parse(out)).toEqual({
      status: "authenticated",
      mcp_id: "lobu",
      authenticated: true,
    });
  });

  test("summariseAuthCheck falls back to raw text when parse fails", () => {
    expect(summariseAuthCheck(null, "lobu", "raw text")).toBe("raw text");
  });
});
