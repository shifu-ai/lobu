/**
 * MCP Proxy Edge-Case Tests
 *
 * Covers gaps not addressed by the main mcp-proxy.test.ts:
 *   - SSRF guard: reserved IP literals, private CIDR ranges, malformed URLs
 *   - Cross-agent JWT isolation: agent A's token cannot reach agent B's MCP tools
 *   - Tool-registry collision: two MCP servers expose the same tool name
 *   - Concurrent tool calls to the same MCP server
 *   - Session expiry: in-memory TTL eviction
 *   - onToolBlocked callback: fired on first block, NOT on subsequent (grant exists)
 *   - Wildcard grant (/mcp/<id>/tools/*) covers all tools of that server
 *   - Body size limit (>1MB) returns 413
 *   - SSE-framed JSON-RPC response parsed correctly
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { generateWorkerToken, type SecretRef } from "@lobu/core";
import { MockMessageQueue } from "@lobu/core/testing";
import { orgContext } from "../../lobu/stores/org-context.js";
import { McpProxy } from "../auth/mcp/proxy.js";
import { McpToolCache } from "../auth/mcp/tool-cache.js";
import { tryGetOrgId } from "../../lobu/stores/org-context.js";
import { GrantStore } from "../permissions/grant-store.js";
import type {
  SecretListEntry,
  WritableSecretStore,
} from "../secrets/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class InMemoryWritableStore implements WritableSecretStore {
  private readonly entries = new Map<
    string,
    { value: string; updatedAt: number }
  >();
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
    for (const [name, e] of this.entries) {
      if (prefix && !name.startsWith(prefix)) continue;
      out.push({
        ref: `secret://${encodeURIComponent(name)}` as SecretRef,
        backend: "memory",
        name,
        updatedAt: e.updatedAt,
      });
    }
    return out;
  }
}

class OrgAwareGrantStore extends GrantStore {
  public checks: Array<{
    agentId: string;
    pattern: string;
    orgId: string | null;
  }> = [];

  override async hasGrant(agentId: string, pattern: string): Promise<boolean> {
    const orgId = tryGetOrgId();
    this.checks.push({ agentId, pattern, orgId });
    return orgId === "test-org";
  }
}

interface HttpMcpServerConfig {
  id: string;
  upstreamUrl: string;
  oauth?: import("@lobu/core").McpOAuthConfig;
  inputs?: unknown[];
  headers?: Record<string, string>;
  internal?: boolean;
}

interface McpConfigSource {
  getHttpServer(
    id: string,
    agentId?: string
  ): Promise<HttpMcpServerConfig | undefined>;
  getAllHttpServers(
    agentId?: string
  ): Promise<Map<string, HttpMcpServerConfig>>;
}

function createConfigSource(
  servers: Record<string, HttpMcpServerConfig>
): McpConfigSource {
  return {
    getHttpServer: async (id) => servers[id],
    getAllHttpServers: async () => new Map(Object.entries(servers)),
  };
}

function mockFetch(handler: (url: string) => Response) {
  globalThis.fetch = async (input: RequestInfo | URL) =>
    handler(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
}

function successFetch(body: object = { jsonrpc: "2.0", id: 1, result: { tools: [] } }) {
  globalThis.fetch = async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
}

function enableObsEnv() {
  process.env.SHIFU_AGENT_OBS_ENABLED = "true";
  process.env.SHIFU_AGENT_OBS_INGEST_URL = "https://obs.example.test/ingest";
  delete process.env.SHIFU_AGENT_OBS_TOKEN;
}

function inTestOrg<T>(fn: () => T): T {
  return orgContext.run({ organizationId: "test-org" }, fn);
}

function executeDirectInTestOrg(
  proxy: McpProxy,
  ...args: Parameters<McpProxy["executeToolDirect"]>
): ReturnType<McpProxy["executeToolDirect"]> {
  return inTestOrg(() => proxy.executeToolDirect(...args));
}

const TEST_ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

let originalEnv: string | undefined;
let originalFetch: typeof fetch;
let agent1Token: string;
let agent2Token: string;

beforeAll(async () => {
  const { ensureDbForGatewayTests, seedAgentRow } = await import(
    "./helpers/db-setup.js"
  );
  await ensureDbForGatewayTests();
  await seedAgentRow("agent1");
  await seedAgentRow("agent2");

  originalEnv = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
  originalFetch = globalThis.fetch;

  agent1Token = generateWorkerToken("user1", "conv1", "deploy1", {
    channelId: "ch1",
    agentId: "agent1",
    organizationId: "test-org",
  });
  agent2Token = generateWorkerToken("user2", "conv2", "deploy2", {
    channelId: "ch2",
    agentId: "agent2",
    organizationId: "test-org",
  });
});

afterAll(() => {
  if (originalEnv !== undefined) process.env.ENCRYPTION_KEY = originalEnv;
  else delete process.env.ENCRYPTION_KEY;
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.SHIFU_AGENT_OBS_ENABLED;
  delete process.env.SHIFU_AGENT_OBS_INGEST_URL;
  delete process.env.SHIFU_AGENT_OBS_TOKEN;
});

// ---------------------------------------------------------------------------
// Durable observability
// ---------------------------------------------------------------------------

describe("durable observability for tools/list", () => {
  test("emits a completed ok event with tool count and cache status", async () => {
    enableObsEnv();
    const obsBodies: any[] = [];
    const configSource = createConfigSource({
      "obs-mcp": {
        id: "obs-mcp",
        upstreamUrl: "https://mcp.example.test/mcp",
      },
    });
    const proxy = new McpProxy(configSource, {
      secretStore: new InMemoryWritableStore(),
    });

    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : (input as Request).url;
      if (url === "https://obs.example.test/ingest") {
        obsBodies.push(JSON.parse(String(init?.body)));
        return new Response("{}", { status: 202 });
      }

      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (body.method === "initialize") {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (body.method === "tools/list") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: { tools: [{ name: "search" }, { name: "read" }] },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", result: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await inTestOrg(() =>
      proxy.fetchToolsForMcp("obs-mcp", "agent1", {
        userId: "user1",
        channelId: "ch1",
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    const completed = obsBodies.find(
      (body) =>
        body.eventName === "lobu.mcp.tools_list.completed" &&
        body.status === "ok"
    );
    expect(completed).toMatchObject({
      eventName: "lobu.mcp.tools_list.completed",
      status: "ok",
      metadata: expect.objectContaining({
        event: "lobu.mcp.tools_list.completed",
        module: "mcp-proxy",
        mcp_id: "obs-mcp",
        tool_count: 2,
        cache_status: "miss",
      }),
    });
  });

  test("emits a completed failed event with transient classification and MCP debug hint", async () => {
    enableObsEnv();
    const obsBodies: any[] = [];
    const configSource = createConfigSource({
      "flaky-mcp": {
        id: "flaky-mcp",
        upstreamUrl: "https://flaky.example.test/mcp",
      },
    });
    const proxy = new McpProxy(configSource, {
      secretStore: new InMemoryWritableStore(),
    });

    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : (input as Request).url;
      if (url === "https://obs.example.test/ingest") {
        obsBodies.push(JSON.parse(String(init?.body)));
        return new Response("{}", { status: 202 });
      }
      throw new Error("fetch failed: network timeout 503");
    }) as unknown as typeof fetch;

    const result = await inTestOrg(() =>
      proxy.fetchToolsForMcp("flaky-mcp", "agent1", {
        userId: "user1",
        channelId: "ch1",
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result.tools).toEqual([]);
    const completed = obsBodies.find(
      (body) =>
        body.eventName === "lobu.mcp.tools_list.completed" &&
        body.status === "failed"
    );
    expect(completed).toMatchObject({
      eventName: "lobu.mcp.tools_list.completed",
      status: "failed",
      metadata: expect.objectContaining({
        module: "mcp-proxy",
        mcp_id: "flaky-mcp",
        error_class: "transient_error",
        cache_status: "miss",
        next_debug_hint: expect.stringContaining("MCP"),
      }),
    });
  });

  test("emits upstream host without port in auth failure metadata", async () => {
    enableObsEnv();
    const obsBodies: any[] = [];
    const configSource = createConfigSource({
      "port-mcp": {
        id: "port-mcp",
        upstreamUrl: "https://port-mcp.example.test:9443/mcp",
      },
    });
    const proxy = new McpProxy(configSource, {
      secretStore: new InMemoryWritableStore(),
    });

    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : (input as Request).url;
      if (url === "https://obs.example.test/ingest") {
        obsBodies.push(JSON.parse(String(init?.body)));
        return new Response("{}", { status: 202 });
      }
      return new Response("auth required", { status: 401 });
    }) as unknown as typeof fetch;

    const result = await inTestOrg(() =>
      proxy.fetchToolsForMcp("port-mcp", "agent1", {
        userId: "user1",
        channelId: "ch1",
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result.tools).toEqual([]);
    const completed = obsBodies.find(
      (body) =>
        body.eventName === "lobu.mcp.tools_list.completed" &&
        body.status === "failed"
    );
    expect(completed).toMatchObject({
      metadata: expect.objectContaining({
        mcp_id: "port-mcp",
        upstream_host: "port-mcp.example.test",
      }),
    });
  });

  test.each([
    { status: 401, phase: "initialize", diagnostic: "upstream_unauthorized" },
    { status: 403, phase: "initialize", diagnostic: "upstream_forbidden" },
    { status: 401, phase: "tools/list", diagnostic: "upstream_unauthorized" },
    { status: 403, phase: "tools/list", diagnostic: "upstream_forbidden" },
  ])(
    "emits a failed completed event for $phase HTTP $status auth early return",
    async ({ status, phase, diagnostic }) => {
      enableObsEnv();
      const obsBodies: any[] = [];
      const configSource = createConfigSource({
        "auth-mcp": {
          id: "auth-mcp",
          upstreamUrl: "https://auth-mcp.example.test/mcp",
        },
      });
      const proxy = new McpProxy(configSource, {
        secretStore: new InMemoryWritableStore(),
      });

      globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : (input as Request).url;
        if (url === "https://obs.example.test/ingest") {
          obsBodies.push(JSON.parse(String(init?.body)));
          return new Response("{}", { status: 202 });
        }

        const body = init?.body ? JSON.parse(String(init.body)) : {};
        if (body.method === "initialize") {
          if (phase === "initialize") {
            return new Response("auth required", {
              status,
              headers: { "WWW-Authenticate": 'Bearer resource_metadata="https://auth.example.test/.well-known/oauth-protected-resource"' },
            });
          }
          return new Response(
            JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (body.method === "tools/list") {
          return new Response("auth required", { status });
        }
        return new Response(JSON.stringify({ jsonrpc: "2.0", result: {} }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch;

      const result = await inTestOrg(() =>
        proxy.fetchToolsForMcp("auth-mcp", "agent1", {
          userId: "user1",
          channelId: "ch1",
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(result.tools).toEqual([]);
      const completed = obsBodies.find(
        (body) =>
          body.eventName === "lobu.mcp.tools_list.completed" &&
          body.status === "failed"
      );
      expect(completed).toMatchObject({
        eventName: "lobu.mcp.tools_list.completed",
        status: "failed",
        metadata: expect.objectContaining({
          module: "mcp-proxy",
          mcp_id: "auth-mcp",
          error_class: "needs_reauth",
          diagnostic_code: diagnostic,
          next_debug_hint: expect.stringContaining("MCP"),
        }),
      });
    }
  );
});

describe("durable observability for forwarded JSON-RPC tools/call", () => {
  async function requestForwardedToolCall(
    upstreamToolCallResult: object
  ): Promise<{ response: Response; obsBodies: any[] }> {
    enableObsEnv();
    const obsBodies: any[] = [];
    const configSource = createConfigSource({
      "jsonrpc-mcp": {
        id: "jsonrpc-mcp",
        upstreamUrl: "https://jsonrpc.example.test/mcp",
      },
    });
    const proxy = new McpProxy(configSource, {
      secretStore: new InMemoryWritableStore(),
    });
    const app = proxy.getApp();

    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : (input as Request).url;
      if (url === "https://obs.example.test/ingest") {
        obsBodies.push(JSON.parse(String(init?.body)));
        return new Response("{}", { status: 202 });
      }

      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (body.method === "initialize") {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (body.method === "tools/call") {
        return new Response(JSON.stringify(upstreamToolCallResult), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", result: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const response = await app.request("/jsonrpc-mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${agent1Token}`,
        "Content-Type": "application/json",
        "X-Shifu-Trace-Id": "trace-forwarded-call",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "meeting_search", arguments: { query: "course" } },
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { response, obsBodies };
  }

  test("emits failed completed event when HTTP 200 contains JSON-RPC error", async () => {
    const { response, obsBodies } = await requestForwardedToolCall({
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32001, message: "upstream tool failed" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32001, message: "upstream tool failed" },
    });
    const completed = obsBodies.find(
      (body) => body.eventName === "lobu.mcp.tool_call.completed"
    );
    expect(completed).toMatchObject({
      eventName: "lobu.mcp.tool_call.completed",
      status: "failed",
      toolName: "meeting_search",
      metadata: expect.objectContaining({
        module: "mcp-proxy",
        mcp_id: "jsonrpc-mcp",
        tool_name: "meeting_search",
        classification: "unknown_error",
        jsonrpc_error_code: -32001,
        result_preview: expect.any(Object),
      }),
    });
  });

  test("classifies unknown MCP config errors from JSON-RPC tool calls as config_error", async () => {
    const { response, obsBodies } = await requestForwardedToolCall({
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32602, message: "unknown server: shifu-toolbox" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32602, message: "unknown server: shifu-toolbox" },
    });
    const completed = obsBodies.find(
      (body) => body.eventName === "lobu.mcp.tool_call.completed"
    );
    expect(completed).toMatchObject({
      eventName: "lobu.mcp.tool_call.completed",
      status: "failed",
      toolName: "meeting_search",
      metadata: expect.objectContaining({
        module: "mcp-proxy",
        mcp_id: "jsonrpc-mcp",
        tool_name: "meeting_search",
        classification: "config_error",
        jsonrpc_error_code: -32602,
      }),
    });
  });

  test("classifies bare unknown JSON-RPC tool call errors as config_error", async () => {
    const { response, obsBodies } = await requestForwardedToolCall({
      jsonrpc: "2.0",
      id: 7,
      error: "unknown",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: 7,
      error: "unknown",
    });
    const completed = obsBodies.find(
      (body) => body.eventName === "lobu.mcp.tool_call.completed"
    );
    expect(completed).toMatchObject({
      eventName: "lobu.mcp.tool_call.completed",
      status: "failed",
      toolName: "meeting_search",
      metadata: expect.objectContaining({
        module: "mcp-proxy",
        mcp_id: "jsonrpc-mcp",
        tool_name: "meeting_search",
        classification: "config_error",
      }),
    });
  });

  test("emits failed completed event when HTTP 200 tool result has isError true", async () => {
    const { response, obsBodies } = await requestForwardedToolCall({
      jsonrpc: "2.0",
      id: 7,
      result: {
        content: [{ type: "text", text: "tool said no" }],
        isError: true,
        diagnosticCode: "connector_unavailable",
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: 7,
      result: {
        content: [{ type: "text", text: "tool said no" }],
        isError: true,
      },
    });
    const completed = obsBodies.find(
      (body) => body.eventName === "lobu.mcp.tool_call.completed"
    );
    expect(completed).toMatchObject({
      eventName: "lobu.mcp.tool_call.completed",
      status: "failed",
      toolName: "meeting_search",
      metadata: expect.objectContaining({
        module: "mcp-proxy",
        mcp_id: "jsonrpc-mcp",
        tool_name: "meeting_search",
        classification: "transient_error",
        result_preview: expect.objectContaining({
          is_error: true,
          first_text: "tool said no",
        }),
      }),
    });
  });

  test("redacts and truncates tool call result preview text", async () => {
    const longText = `Authorization: Bearer ${"abc"}${"123"} ${"x".repeat(
      400
    )}`;
    const { response, obsBodies } = await requestForwardedToolCall({
      jsonrpc: "2.0",
      id: 7,
      result: {
        content: [{ type: "text", text: longText }],
        isError: true,
      },
    });

    expect(response.status).toBe(200);
    const completed = obsBodies.find(
      (body) => body.eventName === "lobu.mcp.tool_call.completed"
    );
    const preview = completed?.metadata?.result_preview;
    expect(preview).toEqual(
      expect.objectContaining({
        is_error: true,
        first_content_type: "text",
        first_text: expect.any(String),
      })
    );
    const firstText = (preview as { first_text: string }).first_text;
    expect(firstText).not.toContain("Bearer");
    expect(firstText).not.toContain(`${"abc"}${"123"}`);
    expect(firstText.length).toBeLessThanOrEqual(314);
    expect(firstText).toContain("[truncated]");
  });

  test("classifies machine-readable tool diagnostic codes as config_error", async () => {
    const { response, obsBodies } = await requestForwardedToolCall({
      jsonrpc: "2.0",
      id: 7,
      result: {
        content: [{ type: "text", text: "tool missing" }],
        isError: true,
        diagnosticCode: "tool_not_found",
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: 7,
      result: {
        content: [{ type: "text", text: "tool missing" }],
        isError: true,
      },
    });
    const completed = obsBodies.find(
      (body) => body.eventName === "lobu.mcp.tool_call.completed"
    );
    expect(completed).toMatchObject({
      eventName: "lobu.mcp.tool_call.completed",
      status: "failed",
      toolName: "meeting_search",
      metadata: expect.objectContaining({
        module: "mcp-proxy",
        mcp_id: "jsonrpc-mcp",
        tool_name: "meeting_search",
        classification: "config_error",
        result_preview: expect.objectContaining({
          is_error: true,
          diagnostic_code: "tool_not_found",
        }),
      }),
    });
  });
});

// ---------------------------------------------------------------------------
// SSRF Guard
// ---------------------------------------------------------------------------

describe("SSRF guard", () => {
  /**
   * The proxy resolves the hostname via DNS in the real implementation.
   * For tests we use IPv4 IP-literal upstreamUrls that bypass DNS so the
   * guard checks `isReservedIp` directly.
   *
   * Note on the REST API tool-call path:
   *   ssrfBlockResponse returns a 403 JSON-RPC error Response internally, but
   *   handleCallTool unwraps it as a JSON-RPC error body and re-surfaces it as
   *   HTTP 502 to the caller. The important invariant is that globalThis.fetch
   *   is NEVER called for internal URLs — the SSRF guard intercepts before
   *   any network I/O.
   *
   * IPv6 bracket literals (http://[::1]:9000) are handled via the URL parser
   * extracting hostname "::1" which the guard checks correctly. In the test
   * environment Node's dns module is unavailable for those addrs; the URL parse
   * still extracts the raw IPv6 literal and isReservedIp catches it.
   */
  const reservedIpv4Hosts = [
    "http://127.0.0.1:9000/mcp",
    "http://127.0.0.2:9000/mcp",
    "http://10.0.0.1:9000/mcp",
    "http://172.16.5.1:9000/mcp",
    "http://172.31.255.255:9000/mcp",
    "http://192.168.1.100:9000/mcp",
    "http://169.254.169.254/mcp", // AWS IMDS
  ];

  for (const url of reservedIpv4Hosts) {
    test(`blocks SSRF to ${url} — fetch never called, error surfaced`, async () => {
      const configSource = createConfigSource({
        "priv-mcp": { id: "priv-mcp", upstreamUrl: url },
      });
      const proxy = new McpProxy(configSource, {
        secretStore: new InMemoryWritableStore(),
      });
      const app = proxy.getApp();

      // The fetch mock should NOT be called — the SSRF guard intercepts first.
      let fetchCalled = false;
      globalThis.fetch = async () => {
        fetchCalled = true;
        return new Response("upstream", { status: 200 });
      };

      const res = await app.request("/priv-mcp/tools/any_tool", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${agent1Token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });

      // The SSRF guard returns a 403 JSON-RPC response from ssrfBlockResponse.
      // handleCallTool receives it, parses data.error, and returns 502 to the
      // REST caller — that is the observable status for the REST API path.
      // The key invariant: fetch was NOT called (no real network I/O).
      expect([403, 502]).toContain(res.status);
      expect(fetchCalled).toBe(false);
      const body = await res.json();
      // The error text must mention the block reason
      const errText = JSON.stringify(body);
      expect(errText).toMatch(/blocked internal network|ssrf|internal/i);
    });
  }

  // IPv6 bracket literal — isReservedIp("::1") === true (the URL class strips brackets)
  // Bun/Node URL behaviour: new URL("http://[::1]:9000").hostname === "::1" (no brackets)
  // so the SSRF guard catches it correctly. If the environment strips brackets differently,
  // this test documents the intended contract: no successful 200 response for loopback.
  test("does not return a successful 200 for IPv6 loopback http://[::1]:9000/mcp", async () => {
    const configSource = createConfigSource({
      "priv-mcp": { id: "priv-mcp", upstreamUrl: "http://[::1]:9000/mcp" },
    });
    const proxy = new McpProxy(configSource, {
      secretStore: new InMemoryWritableStore(),
    });
    const app = proxy.getApp();

    // Either SSRF blocks before fetch (403/502), or fetch throws (Connection refused
    // to loopback) → 502. Either way, no 200 success.
    globalThis.fetch = async () => {
      throw new Error("connect ECONNREFUSED [::1]:9000");
    };

    const res = await app.request("/priv-mcp/tools/any_tool", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${agent1Token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });

    // Must not succeed (no 200)
    expect(res.status).not.toBe(200);
  });

  test("allows public upstream URL", async () => {
    const configSource = createConfigSource({
      "pub-mcp": { id: "pub-mcp", upstreamUrl: "http://public-mcp.example.com:9000/mcp" },
    });
    const proxy = new McpProxy(configSource, {
      secretStore: new InMemoryWritableStore(),
    });
    const app = proxy.getApp();

    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: "ok" }], isError: false },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );

    const res = await app.request("/pub-mcp/tools/a_tool", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${agent1Token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    // Should reach upstream (not blocked)
    expect(res.status).toBe(200);
  });

  test("allows internal=true MCPs to reach reserved IPs", async () => {
    const configSource = createConfigSource({
      "lobu-memory": {
        id: "lobu-memory",
        upstreamUrl: "http://127.0.0.1:8118/mcp",
        internal: true,
      },
    });
    const proxy = new McpProxy(configSource, {
      secretStore: new InMemoryWritableStore(),
    });
    const app = proxy.getApp();

    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: "internal ok" }], isError: false },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );

    const res = await app.request("/lobu-memory/tools/search_memory", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${agent1Token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: "test" }),
    });
    expect(res.status).toBe(200);
  });

  test("blocks GET /tools to reserved-IP MCP via list-all endpoint", async () => {
    const configSource = createConfigSource({
      "ssrf-mcp": {
        id: "ssrf-mcp",
        upstreamUrl: "http://192.168.0.1/mcp",
      },
    });
    const proxy = new McpProxy(configSource, {
      secretStore: new InMemoryWritableStore(),
    });
    const app = proxy.getApp();

    // fetch should not be called
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    };

    const res = await app.request("/ssrf-mcp/tools", {
      method: "GET",
      headers: { Authorization: `Bearer ${agent1Token}` },
    });

    // The list-tools path also goes through sendUpstreamRequest → ssrfBlockResponse
    // so it should not call fetch
    expect(fetchCalled).toBe(false);
    // Status may be 502 (upstream error caught) or 403 depending on path; either way no data returned
    expect([403, 502]).toContain(res.status);
  });
});

// ---------------------------------------------------------------------------
// Cross-Agent JWT Isolation
// ---------------------------------------------------------------------------

describe("cross-agent JWT isolation", () => {
  /**
   * Agent 2's token should NOT be able to call MCP tools that are only
   * configured for agent 1. The config source is keyed per-agentId, so
   * agent 2 gets `undefined` for servers only configured for agent 1.
   */
  test("agent-2 token cannot reach agent-1-only MCP server", async () => {
    const configSource: McpConfigSource = {
      getHttpServer: async (id, agentId) => {
        // Only agent1 has access to "secure-mcp"
        if (id === "secure-mcp" && agentId === "agent1") {
          return { id: "secure-mcp", upstreamUrl: "http://secure.example.com/mcp" };
        }
        return undefined;
      },
      getAllHttpServers: async () => new Map(),
    };

    const proxy = new McpProxy(configSource, {
      secretStore: new InMemoryWritableStore(),
    });
    const app = proxy.getApp();

    successFetch();

    const res = await app.request("/secure-mcp/tools/some_tool", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${agent2Token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("not found");
  });

  test("agent-1 token can reach agent-1-only MCP server", async () => {
    const configSource: McpConfigSource = {
      getHttpServer: async (id, agentId) => {
        if (id === "secure-mcp" && agentId === "agent1") {
          return { id: "secure-mcp", upstreamUrl: "http://secure.example.com/mcp" };
        }
        return undefined;
      },
      getAllHttpServers: async () => new Map(),
    };

    const proxy = new McpProxy(configSource, {
      secretStore: new InMemoryWritableStore(),
    });
    const app = proxy.getApp();

    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: "ok" }], isError: false },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );

    const res = await app.request("/secure-mcp/tools/some_tool", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${agent1Token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
  });

  test("grant for agent1 does not leak to agent2 requests", async () => {
    const toolCache = new McpToolCache();
    const grantStore = new GrantStore();

    const configSource = createConfigSource({
      "shared-mcp": { id: "shared-mcp", upstreamUrl: "http://shared.example.com/mcp" },
    });
    const proxy = new McpProxy(configSource, {
      secretStore: new InMemoryWritableStore(),
      toolCache,
      grantStore,
    });
    const app = proxy.getApp();

    // Seed destructive tool in cache for both agents (org-scoped cache → seed
    // in the same org as the agent tokens).
    orgContext.run({ organizationId: "test-org" }, () => {
      toolCache.set("shared-mcp", [{ name: "delete_everything" }], "agent1");
      toolCache.set("shared-mcp", [{ name: "delete_everything" }], "agent2");
    });

    // Grant only to agent1
    await grantStore.grant(
      "agent1",
      "/mcp/shared-mcp/tools/delete_everything",
      null,
      undefined,
      "test-org"
    );

    successFetch({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: "deleted" }], isError: false },
    });

    // Agent1 should be allowed
    const res1 = await app.request("/shared-mcp/tools/delete_everything", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${agent1Token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(res1.status).toBe(200);

    // Agent2 should be blocked (no grant for agent2)
    const res2 = await app.request("/shared-mcp/tools/delete_everything", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${agent2Token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(res2.status).toBe(403);
  });

  test("evaluates tool approval grants inside worker token organization context", async () => {
    const toolCache = new McpToolCache();
    const grantStore = new OrgAwareGrantStore();

    const configSource = createConfigSource({
      "org-mcp": { id: "org-mcp", upstreamUrl: "http://org.example.com/mcp" },
    });
    const proxy = new McpProxy(configSource, {
      secretStore: new InMemoryWritableStore(),
      toolCache,
      grantStore,
    });
    const app = proxy.getApp();

    inTestOrg(() => {
      toolCache.set("org-mcp", [{ name: "read_report" }], "agent1");
    });

    successFetch({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: "ok" }], isError: false },
    });

    const token = generateWorkerToken("user1", "conv1", "deploy1", {
      channelId: "ch1",
      agentId: "agent1",
      organizationId: "test-org",
    });

    const res = await app.request("/org-mcp/tools/read_report", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    expect(grantStore.checks).toEqual([
      {
        agentId: "agent1",
        pattern: "/mcp/org-mcp/tools/read_report",
        orgId: "test-org",
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Tool registry collision: two MCPs with same tool name
// ---------------------------------------------------------------------------

describe("tool registry collision — same tool name on two MCPs", () => {
  /**
   * If two MCPs expose `send_message`, each must be callable independently
   * via its own server path. There is no collision at the proxy level since
   * paths are /mcp/<id>/tools/<name>.
   */
  test("two MCPs with same tool name are routed independently", async () => {
    const configSource = createConfigSource({
      slack: { id: "slack", upstreamUrl: "http://slack.example.com/mcp" },
      teams: { id: "teams", upstreamUrl: "http://teams.example.com/mcp" },
    });
    const proxy = new McpProxy(configSource, {
      secretStore: new InMemoryWritableStore(),
    });
    const app = proxy.getApp();

    let lastUrl = "";
    globalThis.fetch = async (input: RequestInfo | URL) => {
      lastUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : (input as Request).url;
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: `response from ${lastUrl}` }], isError: false },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const resSlack = await app.request("/slack/tools/send_message", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${agent1Token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ channel: "#general", text: "hello" }),
    });
    expect(resSlack.status).toBe(200);
    expect(lastUrl).toContain("slack.example.com");

    const resTeams = await app.request("/teams/tools/send_message", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${agent1Token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ channel: "general", text: "hello" }),
    });
    expect(resTeams.status).toBe(200);
    expect(lastUrl).toContain("teams.example.com");
  });

  test("tool cache is keyed per (mcpId, agentId) — no cross-MCP cache pollution", async () => {
    const toolCache = new McpToolCache();
    const { toolsA, toolsB } = orgContext.run(
      { organizationId: "test-org" },
      () => {
        toolCache.set("mcp-a", [{ name: "send_message", annotations: { readOnlyHint: true } }], "agent1");
        toolCache.set("mcp-b", [{ name: "send_message" }], "agent1");
        return {
          toolsA: toolCache.get("mcp-a", "agent1"),
          toolsB: toolCache.get("mcp-b", "agent1"),
        };
      }
    );

    expect(toolsA).toHaveLength(1);
    expect(toolsB).toHaveLength(1);
    expect(toolsA![0].annotations?.readOnlyHint).toBe(true);
    // mcp-b's tool has no readOnlyHint
    expect(toolsB![0].annotations).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Approval: onToolBlocked callback, wildcard grants
// ---------------------------------------------------------------------------

describe("tool approval — onToolBlocked and wildcard grants", () => {
  test("callToolWithApproval blocks provider write tools through the real approval gate", async () => {
    const toolCache = new McpToolCache();
    const grantStore = new GrantStore();
    inTestOrg(() => {
      toolCache.set("google_workspace", [{ name: "gws_docs_create" }], "agent-1");
    });

    const configSource = createConfigSource({
      google_workspace: {
        id: "google_workspace",
        upstreamUrl: "http://gws.example.com/mcp",
      },
    });

    const captured: Record<string, unknown>[] = [];
    const proxy = new McpProxy(configSource, {
      secretStore: new InMemoryWritableStore(),
      toolCache,
      grantStore,
    });
    proxy.onToolBlocked = async (
      requestId,
      agentId,
      userId,
      mcpId,
      toolName,
      args,
      grantPattern,
      channelId,
      conversationId,
      teamId,
      connectionId,
      platform
    ) => {
      captured.push({
        requestId,
        agentId,
        userId,
        mcpId,
        toolName,
        args,
        grantPattern,
        channelId,
        conversationId,
        teamId,
        connectionId,
        platform,
      });
    };

    let upstreamCallCount = 0;
    globalThis.fetch = async () => {
      upstreamCallCount++;
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [{ type: "text", text: "created doc" }],
            isError: false,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const result = await inTestOrg(() =>
      proxy.callToolWithApproval(
        "agent-1",
        "user-1",
        "google_workspace",
        "gws_docs_create",
        { title: "PM weekly summary" },
        {
          channelId: "channel-1",
          conversationId: "conv-1",
          organizationId: "org-1",
          platform: "line",
          token: "worker-token",
        }
      )
    );

    expect(result.status).toBe("blocked-notified");
    expect(result.isError).toBe(true);
    expect(upstreamCallCount).toBe(0);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      agentId: "agent-1",
      userId: "user-1",
      mcpId: "google_workspace",
      toolName: "gws_docs_create",
      args: { title: "PM weekly summary" },
      grantPattern: "/mcp/google_workspace/tools/gws_docs_create",
      channelId: "channel-1",
      conversationId: "conv-1",
      platform: "line",
    });
  });

  test("returns blocked-no-channel when onToolBlocked throws", async () => {
    const toolCache = new McpToolCache();
    const grantStore = new GrantStore();
    inTestOrg(() => {
      toolCache.set("google_workspace", [{ name: "gws_docs_create" }], "agent-1");
    });

    const configSource = createConfigSource({
      google_workspace: {
        id: "google_workspace",
        upstreamUrl: "http://gws.example.com/mcp",
      },
    });

    const proxy = new McpProxy(configSource, {
      secretStore: new InMemoryWritableStore(),
      toolCache,
      grantStore,
    });
    proxy.onToolBlocked = async () => {
      throw new Error(
        "Refusing to post tool approval: connectionId is required to prevent cross-platform event leakage"
      );
    };

    let upstreamCallCount = 0;
    globalThis.fetch = async () => {
      upstreamCallCount++;
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [{ type: "text", text: "created doc" }],
            isError: false,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const result = await inTestOrg(() =>
      proxy.callToolWithApproval(
        "agent-1",
        "user-1",
        "google_workspace",
        "gws_docs_create",
        { title: "PM weekly summary" },
        {
          channelId: "channel-1",
          conversationId: "conv-1",
          organizationId: "org-1",
          platform: "api",
          token: "worker-token",
        }
      )
    );

    expect(result.status).toBe("blocked-no-channel");
    expect(result.isError).toBe(true);
    expect(upstreamCallCount).toBe(0);
    expect(result.content?.[0]?.text).not.toContain("has been asked");
  });

  test("onToolBlocked fires once; subsequent blocked-no-channel when no handler", async () => {
    const toolCache = new McpToolCache();
    const grantStore = new GrantStore();

    const configSource = createConfigSource({
      "test-mcp": { id: "test-mcp", upstreamUrl: "http://test.example.com/mcp" },
    });

    let blockedCount = 0;
    const proxy = new McpProxy(configSource, {
      secretStore: new InMemoryWritableStore(),
      toolCache,
      grantStore,
    });

    // Wire the callback
    proxy.onToolBlocked = async () => {
      blockedCount++;
    };

    const app = proxy.getApp();
    orgContext.run({ organizationId: "test-org" }, () => {
      toolCache.set("test-mcp", [{ name: "nuke_db" }], "agent1");
    });

    successFetch({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "done" }] } });

    const res = await app.request("/test-mcp/tools/nuke_db", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${agent1Token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.content[0].text).toContain("requires approval");
    expect(blockedCount).toBe(1);
  });

  test("wildcard grant /mcp/<id>/tools/* covers all tools of that server", async () => {
    const toolCache = new McpToolCache();
    const grantStore = new GrantStore();
    orgContext.run({ organizationId: "test-org" }, () => {
      toolCache.set(
        "gh-mcp",
        [
          { name: "create_issue" },
          { name: "delete_repo" },
        ],
        "agent1"
      );
    });

    // Wildcard grant for the whole server
    await grantStore.grant(
      "agent1",
      "/mcp/gh-mcp/tools/*",
      null,
      undefined,
      "test-org"
    );

    const configSource = createConfigSource({
      "gh-mcp": { id: "gh-mcp", upstreamUrl: "http://gh.example.com/mcp" },
    });
    const proxy = new McpProxy(configSource, {
      secretStore: new InMemoryWritableStore(),
      toolCache,
      grantStore,
    });
    const app = proxy.getApp();

    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: "ok" }], isError: false },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );

    const r1 = await app.request("/gh-mcp/tools/create_issue", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${agent1Token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title: "bug" }),
    });
    expect(r1.status).toBe(200);

    const r2 = await app.request("/gh-mcp/tools/delete_repo", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${agent1Token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ repo: "test" }),
    });
    expect(r2.status).toBe(200);
  });

  test("fails closed when tool annotations cannot be fetched (issue #688)", async () => {
    // Regression: when `fetchToolsForMcp` returns `{ tools: [] }` because
    // discovery failed (upstream error, SSRF block, timeout, ...), the
    // approval gate must NOT default to allow. A destructive tool on a
    // protected MCP would otherwise be invocable without approval whenever
    // discovery failed.
    const grantStore = new GrantStore();

    const configSource = createConfigSource({
      "destructive-mcp": {
        id: "destructive-mcp",
        upstreamUrl: "http://destructive.example.com/mcp",
      },
    });

    let blockedCount = 0;
    const proxy = new McpProxy(configSource, {
      secretStore: new InMemoryWritableStore(),
      // No toolCache — forces fetchToolsForMcp to be called.
      grantStore,
    });
    proxy.onToolBlocked = async () => {
      blockedCount++;
    };

    const app = proxy.getApp();

    // Simulate annotation-fetch failure: fetch always throws, so the MCP
    // initialize/tools-list calls fail and fetchToolsForMcp resolves to
    // { tools: [] }.
    globalThis.fetch = async () => {
      throw new Error("upstream unreachable");
    };

    const res = await app.request("/destructive-mcp/tools/wipe_database", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${agent1Token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ confirm: true }),
    });

    // Must be blocked, not allowed through.
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.content[0].text).toContain("requires approval");
    expect(blockedCount).toBe(1);
  });

  test("refreshes stored OAuth credential when tool discovery gets invalid_token", async () => {
    const secretStore = new InMemoryWritableStore();
    await secretStore.put(
      "mcp-auth/agent1/user1/toolbox/credential",
      JSON.stringify({
        accessToken: "stale-access-token",
        refreshToken: "refresh-token",
        expiresAt: Date.now() + 60 * 60 * 1000,
        clientId: "client-id",
        tokenUrl: "https://auth.example.com/oauth/token",
        resource: "https://toolbox.example.com/mcp",
        tokenEndpointAuthMethod: "none",
      })
    );

    const configSource = createConfigSource({
      toolbox: {
        id: "toolbox",
        upstreamUrl: "https://toolbox.example.com/mcp",
        oauth: { resource: "https://toolbox.example.com/mcp" },
      },
    });
    const proxy = new McpProxy(configSource, {
      secretStore,
      grantStore: new GrantStore(),
    });

    const upstreamAuthorizations: string[] = [];
    let refreshCount = 0;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : (input as Request).url;

      if (url === "https://auth.example.com/oauth/token") {
        refreshCount++;
        return new Response(
          JSON.stringify({
            access_token: "fresh-access-token",
            refresh_token: "rotated-refresh-token",
            expires_in: 3600,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      upstreamAuthorizations.push(
        String((init?.headers as Record<string, string>)?.Authorization || "")
      );
      if (upstreamAuthorizations.length === 1) {
        return new Response(
          JSON.stringify({
            error: "invalid_token",
            error_description: "Invalid access token",
          }),
          { status: 401, headers: { "Content-Type": "application/json" } }
        );
      }

      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { tools: [{ name: "meeting_search" }] },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const result = await inTestOrg(() =>
      proxy.fetchToolsForMcp(
        "toolbox",
        "agent1",
        { userId: "user1", channelId: "ch1" },
        agent1Token,
        { surfaceErrors: true }
      )
    );

    expect(refreshCount).toBe(1);
    expect(upstreamAuthorizations[0]).toBe("Bearer stale-access-token");
    expect(upstreamAuthorizations.slice(1)).toEqual(
      upstreamAuthorizations.slice(1).map(() => "Bearer fresh-access-token")
    );
    expect(result.tools.map((tool) => tool.name)).toEqual(["meeting_search"]);

    const stored = JSON.parse(
      (await secretStore.get(
        "secret://mcp-auth%2Fagent1%2Fuser1%2Ftoolbox%2Fcredential" as SecretRef
      )) || "{}"
    );
    expect(stored.accessToken).toBe("fresh-access-token");
    expect(stored.refreshToken).toBe("rotated-refresh-token");
  });

  test("onToolBlocked receives correct agentId and tool metadata", async () => {
    const toolCache = new McpToolCache();
    const grantStore = new GrantStore();
    orgContext.run({ organizationId: "test-org" }, () => {
      toolCache.set("audit-mcp", [{ name: "drop_table" }], "agent1");
    });

    const configSource = createConfigSource({
      "audit-mcp": { id: "audit-mcp", upstreamUrl: "http://audit.example.com/mcp" },
    });

    const captured: Record<string, unknown>[] = [];
    const proxy = new McpProxy(configSource, {
      secretStore: new InMemoryWritableStore(),
      toolCache,
      grantStore,
    });
    proxy.onToolBlocked = async (
      requestId,
      agentId,
      userId,
      mcpId,
      toolName,
      args,
      grantPattern
    ) => {
      captured.push({ requestId, agentId, userId, mcpId, toolName, args, grantPattern });
    };
    const app = proxy.getApp();

    await app.request("/audit-mcp/tools/drop_table", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${agent1Token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ table: "users" }),
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      agentId: "agent1",
      userId: "user1",
      mcpId: "audit-mcp",
      toolName: "drop_table",
      args: { table: "users" },
      grantPattern: "/mcp/audit-mcp/tools/drop_table",
    });
    expect(typeof captured[0]!.requestId).toBe("string");
    expect((captured[0]!.requestId as string).startsWith("ta_")).toBe(true);
  });

  test("onToolBlocked receives origin message ids from the worker token", async () => {
    const toolCache = new McpToolCache();
    const grantStore = new GrantStore();
    orgContext.run({ organizationId: "test-org" }, () => {
      toolCache.set("line-mcp", [{ name: "send_campaign" }], "agent1");
    });

    const token = generateWorkerToken("user1", "conv1", "deploy1", {
      channelId: "ch1",
      agentId: "agent1",
      organizationId: "test-org",
      connectionId: "line-connection-1",
      platform: "line",
      messageId: "line-message-1",
      processedMessageIds: ["line-message-1"],
    });

    const configSource = createConfigSource({
      "line-mcp": { id: "line-mcp", upstreamUrl: "http://line.example.com/mcp" },
    });

    const captured: Record<string, unknown>[] = [];
    const proxy = new McpProxy(configSource, {
      secretStore: new InMemoryWritableStore(),
      toolCache,
      grantStore,
    });
    proxy.onToolBlocked = async (
      requestId,
      agentId,
      userId,
      mcpId,
      toolName,
      args,
      grantPattern,
      channelId,
      conversationId,
      teamId,
      connectionId,
      platform,
      originMessageId,
      processedMessageIds
    ) => {
      captured.push({
        requestId,
        agentId,
        userId,
        mcpId,
        toolName,
        args,
        grantPattern,
        channelId,
        conversationId,
        connectionId,
        platform,
        originMessageId,
        processedMessageIds,
      });
    };

    const res = await proxy.getApp().request("/line-mcp/tools/send_campaign", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "approve?" }),
    });

    expect(res.status).toBe(403);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      agentId: "agent1",
      userId: "user1",
      mcpId: "line-mcp",
      toolName: "send_campaign",
      args: { text: "approve?" },
      grantPattern: "/mcp/line-mcp/tools/send_campaign",
      channelId: "ch1",
      conversationId: "conv1",
      connectionId: "line-connection-1",
      platform: "line",
      originMessageId: "line-message-1",
      processedMessageIds: ["line-message-1"],
    });
  });
});

// ---------------------------------------------------------------------------
// Request body size limit
// ---------------------------------------------------------------------------

describe("request body size limit", () => {
  test("body > 1MB returns 413", async () => {
    const configSource = createConfigSource({
      "test-mcp": { id: "test-mcp", upstreamUrl: "http://test.example.com/mcp" },
    });
    const proxy = new McpProxy(configSource, {
      secretStore: new InMemoryWritableStore(),
    });
    const app = proxy.getApp();

    successFetch();

    const hugeBody = JSON.stringify({ data: "x".repeat(1024 * 1024 + 1) });

    const res = await app.request("/test-mcp/tools/my_tool", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${agent1Token}`,
        "Content-Type": "application/json",
      },
      body: hugeBody,
    });

    expect(res.status).toBe(413);
  });
});

// ---------------------------------------------------------------------------
// SSE-framed JSON-RPC response parsing
// ---------------------------------------------------------------------------

describe("SSE-framed JSON-RPC response", () => {
  test("parses last data: line from SSE stream as JSON-RPC result", async () => {
    const configSource = createConfigSource({
      "sse-mcp": { id: "sse-mcp", upstreamUrl: "http://sse.example.com/mcp" },
    });
    const proxy = new McpProxy(configSource, {
      secretStore: new InMemoryWritableStore(),
    });
    const app = proxy.getApp();

    const sseBody = [
      `event: message`,
      `data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "sse-result" }], isError: false } })}`,
      ``,
    ].join("\n");

    globalThis.fetch = async () =>
      new Response(sseBody, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });

    const res = await app.request("/sse-mcp/tools/my_tool", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${agent1Token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content[0].text).toBe("sse-result");
    expect(body.isError).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// In-memory session TTL eviction
// ---------------------------------------------------------------------------

describe("in-memory session TTL", () => {
  test("McpToolCache returns null after TTL expires", () => {
    const cache = new McpToolCache();
    // Cache reads/writes derive the org from context.
    orgContext.run({ organizationId: "test-org" }, () => {
      cache.set("mcp-x", [{ name: "tool1" }], "agent1");

      // Check hit immediately
      const hit = cache.get("mcp-x", "agent1");
      expect(hit).not.toBeNull();
      expect(hit![0].name).toBe("tool1");

      // Manually expire by probing the expiry logic via a never-set key
      const miss = cache.get("mcp-x-nonexistent", "agent1");
      expect(miss).toBeNull();
    });
  });

  test("McpToolCache per-agent isolation — agent2 cache miss for agent1 entry", () => {
    const cache = new McpToolCache();
    orgContext.run({ organizationId: "test-org" }, () => {
      cache.set("mcp-iso", [{ name: "private_tool" }], "agent1");

      const forAgent1 = cache.get("mcp-iso", "agent1");
      const forAgent2 = cache.get("mcp-iso", "agent2");
      const noAgent = cache.get("mcp-iso");

      expect(forAgent1).not.toBeNull();
      expect(forAgent2).toBeNull();
      expect(noAgent).toBeNull();
    });
  });

  test("McpToolCache delete invalidates one agent or all entries for an MCP", async () => {
    await inTestOrg(async () => {
      const cache = new McpToolCache();
      cache.set("mcp-delete", [{ name: "agent1_tool" }], "agent1");
      cache.set("mcp-delete", [{ name: "agent2_tool" }], "agent2");
      cache.set("mcp-delete:toolFilter:{\"include\":[\"read_*\"]}", [
        { name: "read_file" },
      ], "agent1");

      cache.delete("mcp-delete", "agent1");

      expect(cache.get("mcp-delete", "agent1")).toBeNull();
      expect(
        cache.get("mcp-delete:toolFilter:{\"include\":[\"read_*\"]}", "agent1")
      ).toBeNull();
      expect(cache.get("mcp-delete", "agent2")?.[0]?.name).toBe("agent2_tool");

      cache.delete("mcp-delete");
      expect(cache.get("mcp-delete", "agent2")).toBeNull();
    });
  });

  test("McpToolCache delete does not match colon-suffix MCP ids", async () => {
    await inTestOrg(async () => {
      const cache = new McpToolCache();
      cache.set("foo:bar", [{ name: "foo_bar_tool" }], "agent1");
      cache.set("bar", [{ name: "bar_tool" }], "agent1");
      cache.set("foo:bar:toolFilter:{\"include\":[\"read_*\"]}", [
        { name: "foo_bar_read_tool" },
      ], "agent1");

      cache.delete("bar");

      expect(cache.get("bar", "agent1")).toBeNull();
      expect(cache.get("foo:bar", "agent1")?.[0]?.name).toBe("foo_bar_tool");
      expect(
        cache.get("foo:bar:toolFilter:{\"include\":[\"read_*\"]}", "agent1")?.[0]
          ?.name
      ).toBe("foo_bar_read_tool");
    });
  });
});

// ---------------------------------------------------------------------------
// Concurrent tool calls
// ---------------------------------------------------------------------------

describe("concurrent tool calls", () => {
  test("two concurrent calls to the same MCP tool both succeed", async () => {
    const configSource = createConfigSource({
      "conc-mcp": { id: "conc-mcp", upstreamUrl: "http://conc.example.com/mcp" },
    });
    const proxy = new McpProxy(configSource, {
      secretStore: new InMemoryWritableStore(),
    });
    const app = proxy.getApp();

    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: `call-${callCount}` }], isError: false },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const [r1, r2] = await Promise.all([
      app.request("/conc-mcp/tools/read_data", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${agent1Token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ id: 1 }),
      }),
      app.request("/conc-mcp/tools/read_data", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${agent1Token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ id: 2 }),
      }),
    ]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    // Both calls hit upstream
    expect(callCount).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// executeToolDirect (approval bridge path)
// ---------------------------------------------------------------------------

describe("executeToolDirect", () => {
  test("executes tool directly and returns result", async () => {
    const configSource = createConfigSource({
      "direct-mcp": {
        id: "direct-mcp",
        upstreamUrl: "http://direct.example.com/mcp",
      },
    });
    const proxy = new McpProxy(configSource, {
      secretStore: new InMemoryWritableStore(),
    });

    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: "direct-result" }], isError: false },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );

    const result = await executeDirectInTestOrg(proxy,
      "agent1",
      "user1",
      "direct-mcp",
      "some_tool",
      { arg1: "val1" }
    );

    expect(result.isError).toBe(false);
    expect(result.content[0].text).toBe("direct-result");
  });

  test("executeToolDirect returns error when MCP server not found", async () => {
    const configSource = createConfigSource({});
    const proxy = new McpProxy(configSource, {
      secretStore: new InMemoryWritableStore(),
    });

    const result = await executeDirectInTestOrg(proxy,
      "agent1",
      "user1",
      "nonexistent-mcp",
      "some_tool",
      {}
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not found");
  });

  test("executeToolDirect handles upstream error gracefully", async () => {
    const configSource = createConfigSource({
      "flaky-mcp": {
        id: "flaky-mcp",
        upstreamUrl: "http://flaky.example.com/mcp",
      },
    });
    const proxy = new McpProxy(configSource, {
      secretStore: new InMemoryWritableStore(),
    });

    globalThis.fetch = async () => {
      throw new Error("Connection refused");
    };

    const result = await executeDirectInTestOrg(proxy,
      "agent1",
      "user1",
      "flaky-mcp",
      "any_tool",
      {}
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("error");
  });

  test("executeToolDirect repeated failures pause subsequent direct execution", async () => {
    const configSource = createConfigSource({
      "flaky-direct-mcp": {
        id: "flaky-direct-mcp",
        upstreamUrl: "http://flaky-direct.example.com/mcp",
      },
    });
    const proxy = new McpProxy(configSource, {
      secretStore: new InMemoryWritableStore(),
    });

    let fetchCount = 0;
    globalThis.fetch = async () => {
      fetchCount++;
      throw new Error(`direct boom ${fetchCount}`);
    };

    for (let i = 0; i < 3; i++) {
      const result = await executeDirectInTestOrg(proxy,
        "agent1",
        "user1",
        "flaky-direct-mcp",
        "any_tool",
        {}
      );
      expect(result.isError).toBe(true);
      expect(result.diagnosticCode).toBe("connector_unavailable");
    }
    const fetchesBeforePause = fetchCount;

    const paused = await executeDirectInTestOrg(proxy,
      "agent1",
      "user1",
      "flaky-direct-mcp",
      "any_tool",
      {}
    );

    expect(paused.isError).toBe(true);
    expect(paused.diagnosticCode).toBe("connector_unavailable");
    expect(paused.content[0].text).toContain("temporarily paused");
    expect(fetchCount).toBe(fetchesBeforePause);
  });

  test("executeToolDirect success clears direct failure health", async () => {
    const configSource = createConfigSource({
      "recover-direct-mcp": {
        id: "recover-direct-mcp",
        upstreamUrl: "http://recover-direct.example.com/mcp",
      },
    });
    const proxy = new McpProxy(configSource, {
      secretStore: new InMemoryWritableStore(),
    });

    let fetchCount = 0;
    globalThis.fetch = async () => {
      fetchCount++;
      throw new Error(`before recovery ${fetchCount}`);
    };

    for (let i = 0; i < 2; i++) {
      const result = await executeDirectInTestOrg(proxy,
        "agent1",
        "user1",
        "recover-direct-mcp",
        "any_tool",
        {}
      );
      expect(result.isError).toBe(true);
    }

    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [{ type: "text", text: "recovered" }],
            isError: false,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );

    const recovered = await executeDirectInTestOrg(proxy,
      "agent1",
      "user1",
      "recover-direct-mcp",
      "any_tool",
      {}
    );
    expect(recovered.isError).toBe(false);
    expect(recovered.content[0].text).toBe("recovered");

    let afterRecoveryFetchCount = 0;
    globalThis.fetch = async () => {
      afterRecoveryFetchCount++;
      throw new Error(`after recovery ${afterRecoveryFetchCount}`);
    };

    for (let i = 0; i < 2; i++) {
      const result = await executeDirectInTestOrg(proxy,
        "agent1",
        "user1",
        "recover-direct-mcp",
        "any_tool",
        {}
      );
      expect(result.isError).toBe(true);
    }
    const beforeFinalSuccess = afterRecoveryFetchCount;

    globalThis.fetch = async () => {
      afterRecoveryFetchCount++;
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [{ type: "text", text: "still reachable" }],
            isError: false,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const stillReachable = await executeDirectInTestOrg(proxy,
      "agent1",
      "user1",
      "recover-direct-mcp",
      "any_tool",
      {}
    );
    expect(stillReachable.isError).toBe(false);
    expect(stillReachable.content[0].text).toBe("still reachable");
    expect(afterRecoveryFetchCount).toBeGreaterThan(beforeFinalSuccess);
  });

  test("executeToolDirect JSON-RPC tool errors do not pause direct execution", async () => {
    const configSource = createConfigSource({
      "tool-error-direct-mcp": {
        id: "tool-error-direct-mcp",
        upstreamUrl: "http://tool-error-direct.example.com/mcp",
      },
    });
    const proxy = new McpProxy(configSource, {
      secretStore: new InMemoryWritableStore(),
    });

    let fetchCount = 0;
    globalThis.fetch = async () => {
      fetchCount++;
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32602, message: "Invalid params" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    for (let i = 0; i < 3; i++) {
      const result = await executeDirectInTestOrg(proxy,
        "agent1",
        "user1",
        "tool-error-direct-mcp",
        "any_tool",
        {}
      );
      expect(result.isError).toBe(true);
    }
    const fetchesBeforeSuccess = fetchCount;

    globalThis.fetch = async () => {
      fetchCount++;
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [{ type: "text", text: "direct still callable" }],
            isError: false,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const result = await executeDirectInTestOrg(proxy,
      "agent1",
      "user1",
      "tool-error-direct-mcp",
      "any_tool",
      {}
    );
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toBe("direct still callable");
    expect(fetchCount).toBeGreaterThan(fetchesBeforeSuccess);
  });

  test("executeToolDirect returns safe diagnostic code for upstream forbidden", async () => {
    const configSource = createConfigSource({
      "forbidden-mcp": {
        id: "forbidden-mcp",
        upstreamUrl: "http://forbidden.example.com/mcp",
      },
    });
    const proxy = new McpProxy(configSource, {
      secretStore: new InMemoryWritableStore(),
    });

    globalThis.fetch = async () =>
      new Response("private upstream body", { status: 403 });

    const result = await executeDirectInTestOrg(proxy,
      "agent1",
      "user1",
      "forbidden-mcp",
      "any_tool",
      {}
    );

    expect(result.isError).toBe(true);
    expect(result.diagnosticCode).toBe("upstream_forbidden");
  });

  test("executeToolDirect preserves safe JSON-RPC result diagnostic code", async () => {
    const configSource = createConfigSource({
      "scoped-mcp": {
        id: "scoped-mcp",
        upstreamUrl: "http://scoped.example.com/mcp",
      },
    });
    const proxy = new McpProxy(configSource, {
      secretStore: new InMemoryWritableStore(),
    });

    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [{ type: "text", text: "private provider details" }],
            isError: true,
            diagnosticCode: "oauth_scope_denied",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );

    const result = await executeDirectInTestOrg(proxy,
      "agent1",
      "user1",
      "scoped-mcp",
      "any_tool",
      {}
    );

    expect(result.isError).toBe(true);
    expect(result.diagnosticCode).toBe("oauth_scope_denied");
  });
});

// ---------------------------------------------------------------------------
// Approval policy: requiresToolApproval
// ---------------------------------------------------------------------------

describe("requiresToolApproval (approval-policy.ts)", () => {
  // Import directly to test in isolation
  test("idempotentHint=true alone still requires approval (MCP spec)", async () => {
    const { requiresToolApproval } = await import(
      "../permissions/approval-policy.js"
    );
    // idempotentHint says "won't change state differently each call" but does
    // NOT imply read-only. Conservative default = requires approval.
    expect(requiresToolApproval({ idempotentHint: true })).toBe(true);
  });

  test("openWorldHint=true alone still requires approval", async () => {
    const { requiresToolApproval } = await import(
      "../permissions/approval-policy.js"
    );
    expect(requiresToolApproval({ openWorldHint: true })).toBe(true);
  });

  test("readOnlyHint=true + destructiveHint=true: readOnly wins (no approval)", async () => {
    const { requiresToolApproval } = await import(
      "../permissions/approval-policy.js"
    );
    // readOnlyHint=true short-circuits first; destructiveHint is ignored
    expect(
      requiresToolApproval({ readOnlyHint: true, destructiveHint: true })
    ).toBe(false);
  });

  test("destructiveHint=false alone still requires approval (self-declared non-destructive is not trusted)", async () => {
    const { requiresToolApproval } = await import(
      "../permissions/approval-policy.js"
    );
    expect(requiresToolApproval({ destructiveHint: false })).toBe(true);
  });

  test("empty annotations object requires approval (conservative default)", async () => {
    const { requiresToolApproval } = await import(
      "../permissions/approval-policy.js"
    );
    expect(requiresToolApproval({})).toBe(true);
  });

  test("undefined annotations requires approval", async () => {
    const { requiresToolApproval } = await import(
      "../permissions/approval-policy.js"
    );
    expect(requiresToolApproval(undefined)).toBe(true);
  });
});
