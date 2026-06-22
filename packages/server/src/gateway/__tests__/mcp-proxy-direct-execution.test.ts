import { describe, expect, test } from "bun:test";
import type { SecretRef } from "@lobu/core";
import { McpProxy } from "../auth/mcp/proxy.js";
import type { SecretListEntry, WritableSecretStore } from "../secrets/index.js";

class InMemoryWritableStore implements WritableSecretStore {
  private readonly entries = new Map<string, { value: string; updatedAt: number }>();

  async get(ref: SecretRef): Promise<string | null> {
    if (!ref.startsWith("secret://")) return null;
    const name = decodeURIComponent(ref.slice("secret://".length));
    return this.entries.get(name)?.value ?? null;
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

describe("McpProxy executeToolDirect", () => {
  test("initializes a session before calling sessionful MCP tools", async () => {
    const originalFetch = globalThis.fetch;
    const proxy = new McpProxy({
      getHttpServer: async (id: string) => ({
        id,
        upstreamUrl: "http://sessionful.example.com/mcp",
      }),
      getAllHttpServers: async () => new Map(),
    }, {
      secretStore: new InMemoryWritableStore(),
    });
    const methods: string[] = [];

    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
      methods.push(body.method ?? "");
      if (body.method === "initialize") {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26" } }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "Mcp-Session-Id": "session-123",
            },
          }
        );
      }
      if (body.method === "notifications/initialized") {
        return new Response("", { status: 202 });
      }
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: "sessionful-result" }], isError: false },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    try {
      const result = await proxy.executeToolDirect(
        "agent1",
        "user1",
        "sessionful-mcp",
        "some_tool",
        { arg1: "val1" }
      );

      expect(result.isError).toBe(false);
      expect(result.content[0].text).toBe("sessionful-result");
      expect(methods).toEqual(["initialize", "notifications/initialized", "tools/call"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
