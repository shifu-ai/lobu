import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { __resetEncryptionKeyCacheForTests } from "@lobu/core";
import type { SecretPutOptions, SecretRef } from "@lobu/core";
import {
  createDeviceAuthRoutes,
  refreshCredentialDetailed,
  type StoredCredential,
  storeCredentialForScope,
} from "../routes/internal/device-auth.js";
import type { SecretListEntry, WritableSecretStore } from "../secrets/index.js";

const TEST_ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

class InMemoryWritableStore implements WritableSecretStore {
  private readonly entries = new Map<
    string,
    { value: string; updatedAt: number }
  >();

  constructor(private readonly scheme: string = "secret") {}

  async get(ref: SecretRef): Promise<string | null> {
    if (!ref.startsWith(`${this.scheme}://`)) return null;
    const name = decodeURIComponent(ref.slice(`${this.scheme}://`.length));
    return this.entries.get(name)?.value ?? null;
  }

  async put(
    name: string,
    value: string,
    _options?: SecretPutOptions,
  ): Promise<SecretRef> {
    this.entries.set(name, { value, updatedAt: Date.now() });
    return `${this.scheme}://${encodeURIComponent(name)}` as SecretRef;
  }

  async delete(nameOrRef: string): Promise<void> {
    const name = nameOrRef.startsWith(`${this.scheme}://`)
      ? decodeURIComponent(nameOrRef.slice(`${this.scheme}://`.length))
      : nameOrRef;
    this.entries.delete(name);
  }

  async list(prefix?: string): Promise<SecretListEntry[]> {
    const entries: SecretListEntry[] = [];
    for (const [name, entry] of this.entries) {
      if (prefix && !name.startsWith(prefix)) continue;
      entries.push({
        ref: `${this.scheme}://${encodeURIComponent(name)}` as SecretRef,
        backend: this.scheme,
        name,
        updatedAt: entry.updatedAt,
      });
    }
    return entries;
  }
}

const AGENT = "agent-diag";
const MCP = "google_workspace";
const TOKEN_URL = "https://oauth.example.com/token";

/** A credential already inside the 5-minute refresh window. */
function staleCredential(
  overrides: Partial<StoredCredential> = {},
): StoredCredential {
  return {
    accessToken: "stale-access-token",
    refreshToken: "refresh-token-abc",
    expiresAt: Date.now() + 60_000,
    clientId: "client-123",
    clientSecret: "client-secret-xyz",
    tokenUrl: TOKEN_URL,
    ...overrides,
  };
}

let originalEncryptionKey: string | undefined;
let originalFetch: typeof fetch;
let userSeq = 0;

beforeAll(() => {
  originalEncryptionKey = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
  __resetEncryptionKeyCacheForTests();
  originalFetch = globalThis.fetch;
});

afterAll(() => {
  if (originalEncryptionKey !== undefined) {
    process.env.ENCRYPTION_KEY = originalEncryptionKey;
  } else {
    delete process.env.ENCRYPTION_KEY;
  }
  __resetEncryptionKeyCacheForTests();
  globalThis.fetch = originalFetch;
});

describe("refreshCredentialDetailed failure diagnosis", () => {
  let secretStore: InMemoryWritableStore;
  let user: string;

  beforeEach(() => {
    secretStore = new InMemoryWritableStore("secret");
    // The refresh lock is module-level and keyed by agent/user/mcp, so each
    // test needs its own user to avoid inheriting a lock from a prior test.
    userSeq += 1;
    user = `user-${userSeq}`;
  });

  test("reports a revoked grant as permanent, with the upstream error code", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          error: "invalid_grant",
          error_description: "Token has been expired or revoked.",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );

    const result = await refreshCredentialDetailed(
      secretStore,
      AGENT,
      user,
      MCP,
      staleCredential(),
    );

    expect(result.credential).toBeNull();
    expect(result.failure?.reason).toBe("upstream_rejected");
    expect(result.failure?.permanent).toBe(true);
    expect(result.failure?.upstreamError).toBe("invalid_grant");
    expect(result.failure?.status).toBe(400);
    expect(result.failure?.upstreamErrorDescription).toContain("revoked");
  });

  test("reports an upstream 5xx as transient, not as needing re-auth", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: "server_error" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });

    const result = await refreshCredentialDetailed(
      secretStore,
      AGENT,
      user,
      MCP,
      staleCredential(),
    );

    expect(result.credential).toBeNull();
    expect(result.failure?.reason).toBe("upstream_error");
    expect(result.failure?.permanent).toBe(false);
    expect(result.failure?.status).toBe(503);
  });

  test("reports a 429 rate limit as transient", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: "slow_down" }), { status: 429 });

    const result = await refreshCredentialDetailed(
      secretStore,
      AGENT,
      user,
      MCP,
      staleCredential(),
    );

    expect(result.failure?.reason).toBe("upstream_error");
    expect(result.failure?.permanent).toBe(false);
  });

  test("reports a network failure as transient", async () => {
    globalThis.fetch = async () => {
      throw new Error("fetch failed");
    };

    const result = await refreshCredentialDetailed(
      secretStore,
      AGENT,
      user,
      MCP,
      staleCredential(),
    );

    expect(result.credential).toBeNull();
    expect(result.failure?.reason).toBe("network_error");
    expect(result.failure?.permanent).toBe(false);
  });

  test("reports a missing refresh token as permanent", async () => {
    const result = await refreshCredentialDetailed(
      secretStore,
      AGENT,
      user,
      MCP,
      staleCredential({ refreshToken: undefined }),
    );

    expect(result.credential).toBeNull();
    expect(result.failure?.reason).toBe("no_refresh_token");
    expect(result.failure?.permanent).toBe(true);
  });

  test("records no failure on a successful refresh", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ access_token: "fresh-token", expires_in: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    const result = await refreshCredentialDetailed(
      secretStore,
      AGENT,
      user,
      MCP,
      staleCredential(),
    );

    expect(result.failure).toBeUndefined();
    expect(result.credential?.accessToken).toBe("fresh-token");
  });

  test("flags a lost refresh race distinctly from a revoked grant", async () => {
    // The holder takes longer than the waiter's bounded polling window. The
    // waiter must diagnose contention without handing the stale credential back.
    const stale = staleCredential();
    await storeCredentialForScope(secretStore, AGENT, user, MCP, stale);

    globalThis.fetch = async () => {
      await new Promise((r) => setTimeout(r, 1_300));
      return new Response(
        JSON.stringify({ access_token: "fresh-token", expires_in: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const holder = refreshCredentialDetailed(
      secretStore,
      AGENT,
      user,
      MCP,
      stale,
    );
    // Let the holder take the lock before the waiter arrives.
    await new Promise((r) => setTimeout(r, 10));
    const waiter = refreshCredentialDetailed(
      secretStore,
      AGENT,
      user,
      MCP,
      stale,
    );

    const [holderResult, waiterResult] = await Promise.all([holder, waiter]);

    expect(holderResult.credential?.accessToken).toBe("fresh-token");
    expect(holderResult.failure).toBeUndefined();

    // The waiter re-read before the holder finished, so it saw the same stale
    // credential. It must be reported as contention, never as needing re-auth,
    // and it must not return the token a caller would send upstream.
    expect(waiterResult.contended).toBe(true);
    expect(waiterResult.credential).toBeNull();
    expect(waiterResult.failure?.reason).toBe("lock_contended_stale");
    expect(waiterResult.failure?.permanent).toBe(false);
  });

  test("reports contention without failure when the holder finishes in time", async () => {
    const stale = staleCredential();
    await storeCredentialForScope(secretStore, AGENT, user, MCP, stale);

    // Holder finishes well inside the waiter's 150ms sleep, so the re-read
    // picks up the fresh credential.
    globalThis.fetch = async () => {
      await new Promise((r) => setTimeout(r, 50));
      return new Response(
        JSON.stringify({ access_token: "fresh-token", expires_in: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const holder = refreshCredentialDetailed(
      secretStore,
      AGENT,
      user,
      MCP,
      stale,
    );
    await new Promise((r) => setTimeout(r, 10));
    const waiter = refreshCredentialDetailed(
      secretStore,
      AGENT,
      user,
      MCP,
      stale,
    );

    const [, waiterResult] = await Promise.all([holder, waiter]);

    expect(waiterResult.contended).toBe(true);
    expect(waiterResult.failure).toBeUndefined();
    expect(waiterResult.credential?.accessToken).toBe("fresh-token");
  });

  test("uses a concurrently stored fresh credential instead of returning permanent reauth", async () => {
    const stale = staleCredential();
    globalThis.fetch = async () => {
      await storeCredentialForScope(
        secretStore,
        AGENT,
        user,
        MCP,
        staleCredential({
          accessToken: "fresh-from-another-replica",
          expiresAt: Date.now() + 3_600_000,
        }),
      );
      return new Response(
        JSON.stringify({
          error: "invalid_grant",
          error_description: "Token has been expired or revoked.",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    };

    const result = await refreshCredentialDetailed(
      secretStore,
      AGENT,
      user,
      MCP,
      stale,
    );

    expect(result.failure).toBeUndefined();
    expect(result.credential?.accessToken).toBe("fresh-from-another-replica");
  });
});

describe("device-auth status runtime auth truth", () => {
  let secretStore: InMemoryWritableStore;
  let user: string;

  beforeEach(() => {
    secretStore = new InMemoryWritableStore("secret");
    userSeq += 1;
    user = `user-${userSeq}`;
  });

  test("transient refresh failure reports degraded without a login payload", async () => {
    await storeCredentialForScope(
      secretStore,
      AGENT,
      user,
      MCP,
      staleCredential({ expiresAt: Date.now() - 60_000 }),
    );
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: "server_error" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });

    const routes = createDeviceAuthRoutes({
      secretStore,
      publicGatewayUrl: "https://gateway.example.com",
      mcpConfigService: {
        getHttpServer: async () => ({
          id: MCP,
          upstreamUrl: "https://mcp.example.com/mcp",
        }),
        getAllHttpServers: async () => new Map(),
      },
    });
    const workerToken = await import("@lobu/core").then(
      ({ generateWorkerToken }) =>
        generateWorkerToken(user, "conv-1", "test-deployment", {
          agentId: AGENT,
          channelId: "channel-1",
          organizationId: "org-1",
        }),
    );

    const response = await routes.request(
      `/internal/device-auth/status?mcpId=${encodeURIComponent(MCP)}`,
      { headers: { Authorization: `Bearer ${workerToken}` } },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      authenticated: false,
      status: "degraded",
      reason: "upstream_error",
      refreshStatus: 503,
    });
    expect(body).not.toHaveProperty("login");
    expect(body).not.toHaveProperty("connectUrl");
  });

  test("expired stored credential with invalid_grant refresh reports reauth needed, not authenticated", async () => {
    await storeCredentialForScope(
      secretStore,
      AGENT,
      user,
      MCP,
      staleCredential({ expiresAt: Date.now() - 60_000 }),
    );
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          error: "invalid_grant",
          error_description: "Token has been expired or revoked.",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );

    const routes = createDeviceAuthRoutes({
      secretStore,
      publicGatewayUrl: "https://gateway.example.com",
      mcpConfigService: {
        getHttpServer: async () => ({
          id: MCP,
          upstreamUrl: "https://mcp.example.com/mcp",
        }),
        getAllHttpServers: async () => new Map(),
      },
    });
    const workerToken = await import("@lobu/core").then(
      ({ generateWorkerToken }) =>
        generateWorkerToken(user, "conv-1", "test-deployment", {
          agentId: AGENT,
          channelId: "channel-1",
          organizationId: "org-1",
        }),
    );

    const response = await routes.request(
      `/internal/device-auth/status?mcpId=${encodeURIComponent(MCP)}`,
      { headers: { Authorization: `Bearer ${workerToken}` } },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      authenticated: false,
      status: "needs_reauth",
      reason: "upstream_rejected",
      upstreamError: "invalid_grant",
    });
    expect(body.login).toMatchObject({
      flow: "auth_code",
      verificationUri: expect.stringContaining("/mcp/oauth/start"),
      verificationUriComplete: expect.stringContaining("/mcp/oauth/start"),
    });
  });
});
