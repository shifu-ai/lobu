import { afterEach, describe, expect, test } from "bun:test";
import type { SecretRef } from "@lobu/core";
import { McpProxy } from "../auth/mcp/proxy.js";
import { orgContext } from "../../lobu/stores/org-context.js";
import type { SecretListEntry, WritableSecretStore } from "../secrets/index.js";

/**
 * An expired MCP grant used to reach the agent as a bare
 * `Tool execution error: ...` / `connector_unavailable`, and discovery returned
 * an empty tool list indistinguishable from "never connected". Neither told
 * anyone to reconnect, so colleagues went weeks without their tools. These
 * tests pin the two paths that now say so.
 */

class InMemoryWritableStore implements WritableSecretStore {
  private readonly entries = new Map<
    string,
    { value: string; updatedAt: number }
  >();

  async get(ref: SecretRef): Promise<string | null> {
    if (!ref.startsWith("secret://")) return null;
    return this.entries.get(decodeURIComponent(ref.slice("secret://".length)))?.value ?? null;
  }

  async put(name: string, value: string): Promise<SecretRef> {
    this.entries.set(name, { value, updatedAt: Date.now() });
    return `secret://${encodeURIComponent(name)}` as SecretRef;
  }

  async delete(nameOrRef: string): Promise<void> {
    const name = nameOrRef.startsWith("secret://")
      ? decodeURIComponent(nameOrRef.slice("secret://".length))
      : nameOrRef;
    this.entries.delete(name);
  }

  async list(prefix?: string): Promise<SecretListEntry[]> {
    const out: SecretListEntry[] = [];
    for (const [name, entry] of this.entries) {
      if (prefix && !name.startsWith(prefix)) continue;
      out.push({
        ref: `secret://${encodeURIComponent(name)}` as SecretRef,
        backend: "memory",
        name,
        updatedAt: entry.updatedAt,
      });
    }
    return out;
  }
}

function makeProxy(upstreamUrl = "http://connector.example.com/mcp") {
  return new McpProxy(
    {
      getHttpServer: async (id: string) => ({ id, upstreamUrl }),
      getAllHttpServers: async () => new Map(),
    },
    { secretStore: new InMemoryWritableStore() },
  );
}

/** Answers `initialize` / `initialized`, delegates the real call to `onCall`. */
function upstream(onCall: (method: string) => Response) {
  return async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      id?: number;
      method?: string;
    };
    if (body.method === "initialize") {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: { protocolVersion: "2025-03-26" },
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }
    if (body.method === "notifications/initialized") {
      return new Response("", { status: 202 });
    }
    return onCall(body.method ?? "");
  };
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function runTool(proxy: McpProxy, mcpId = "google_workspace") {
  return orgContext.run({ organizationId: "test-org" }, () =>
    proxy.executeToolDirect("agent1", "user1", mcpId, "some_tool", {}, {
      organizationId: "test-org",
    }),
  );
}

describe("tool call surfaces an expired authorization", () => {
  test("reports needs_reauth instead of connector_unavailable on a 401", async () => {
    const proxy = makeProxy();
    globalThis.fetch = upstream(() => new Response("no", { status: 401 }));

    const result = (await runTool(proxy)) as {
      isError: boolean;
      diagnosticCode?: string;
      content: { type: string; text: string }[];
    };

    expect(result.isError).toBe(true);
    expect(result.diagnosticCode).toBe("needs_reauth");
    const text = result.content.map((c) => c.text).join(" ");
    expect(text).toContain("google_workspace");
    expect(text.toLowerCase()).toContain("expired");
    // The agent must be told to route the user somewhere, not just that it broke.
    expect(text.toLowerCase()).toContain("reconnect");
  });

  test("reports upstream_forbidden instead of needs_reauth on a 403", async () => {
    const proxy = makeProxy();
    globalThis.fetch = upstream(() => new Response("forbidden", { status: 403 }));

    const result = (await runTool(proxy)) as {
      isError: boolean;
      diagnosticCode?: string;
      content: { type: string; text: string }[];
    };

    expect(result.isError).toBe(true);
    expect(result.diagnosticCode).toBe("upstream_forbidden");
    const text = result.content.map((c) => c.text).join(" ");
    expect(text).toContain("403");
    expect(text.toLowerCase()).not.toContain("reconnect");
  });

  test("a 401 body stays readable after a failed refresh", async () => {
    // Regression: the 401 branch cancelled the body then fell through, so the
    // caller's `.text()` threw `Body is unusable` and the authorization signal
    // was replaced by a generic TypeError.
    const proxy = makeProxy();
    globalThis.fetch = upstream(() => new Response("no", { status: 401 }));

    const result = (await runTool(proxy)) as {
      content: { text: string }[];
    };

    const text = result.content.map((c) => c.text).join(" ");
    expect(text).not.toContain("Body is unusable");
    expect(text).not.toContain("Tool execution error");
  });

  test("does not mislabel a 500 as an authorization problem", async () => {
    const proxy = makeProxy();
    globalThis.fetch = upstream(() => new Response("boom", { status: 500 }));

    const result = (await runTool(proxy)) as {
      diagnosticCode?: string;
      content: { text: string }[];
    };

    expect(result.diagnosticCode).not.toBe("needs_reauth");
    const text = result.content.map((c) => c.text).join(" ");
    expect(text.toLowerCase()).not.toContain("reconnect");
  });

  test("a JSON-RPC error no longer returns empty content", async () => {
    const proxy = makeProxy();
    globalThis.fetch = upstream(
      () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32000, message: "upstream exploded" },
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
    );

    const result = (await runTool(proxy)) as {
      isError: boolean;
      content: { text: string }[];
    };

    expect(result.isError).toBe(true);
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.content.map((c) => c.text).join(" ")).toContain(
      "upstream exploded",
    );
  });
});

describe("discovery distinguishes a broken connector from a missing one", () => {
  // The agent-boot path, not `listToolsDirect` — the latter passes
  // `surfaceErrors: true` and throws, which is what the API wants but not what
  // reaches a running agent.
  function discover(proxy: McpProxy, mcpId = "google_workspace") {
    return orgContext.run({ organizationId: "test-org" }, () =>
      proxy.fetchToolsForMcp(mcpId, "agent1", { userId: "user1", channelId: "" }),
    );
  }

  test("explains an expired authorization instead of returning a bare empty list", async () => {
    const proxy = makeProxy();
    globalThis.fetch = upstream(() => new Response("no", { status: 401 }));

    const result = (await discover(proxy)) as {
      tools: unknown[];
      instructions?: string;
    };

    expect(result.tools).toEqual([]);
    expect(result.instructions).toBeDefined();
    const instructions = result.instructions ?? "";
    expect(instructions).toContain("google_workspace");
    expect(instructions.toLowerCase()).toContain("expired");
    // The whole point: the agent must not report this as a missing capability.
    expect(instructions.toLowerCase()).toContain("not the same");
  });

  test("carries no connect link, whose token would outlive its 15 minute TTL", async () => {
    const proxy = makeProxy();
    globalThis.fetch = upstream(() => new Response("no", { status: 401 }));

    const result = (await discover(proxy)) as { instructions?: string };

    expect(result.instructions ?? "").not.toContain("/mcp/oauth/start");
  });

  test("leaves a healthy discovery untouched", async () => {
    const proxy = makeProxy();
    globalThis.fetch = upstream(
      () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { tools: [{ name: "calendar_events_list" }] },
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
    );

    const result = (await discover(proxy)) as {
      tools: { name: string }[];
      instructions?: string;
    };

    expect(result.tools.map((t) => t.name)).toEqual(["calendar_events_list"]);
    expect(result.instructions ?? "").not.toContain("expired");
  });
});
