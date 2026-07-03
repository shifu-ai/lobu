import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import {
  __resetEncryptionKeyCacheForTests,
  generateWorkerToken,
} from "@lobu/core";

// NOTE: We deliberately do NOT `mock.module("../../routes/internal/middleware.js", ...)`
// here. `authenticateWorker` is shared by every internal route (work-state,
// device-auth, ...) and bun:test's `mock.module` is process-global — the FIRST
// registration wins for the lifetime of the process, so mocking it here would
// silently replace real auth for unrelated route test files that happen to run
// in the same `bun test` invocation (see
// `packages/server/src/lobu/__tests__/helpers/route-test-mocks.ts` for the
// documented incident). Minting a real worker token via `generateWorkerToken`
// exercises the real `authenticateWorker` middleware and stays isolated.

const CANONICAL_TEST_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

// secretStore.get 一律回 null：無 pending device auth、無 cached client
const fakeSecretStore = {
  get: async () => null,
  put: async () => undefined,
  delete: async () => undefined,
} as any;

// getHttpServer 回一個帶 oauth 的 server（觸發動態註冊路徑）
const fakeMcpConfigService = {
  getHttpServer: async () => ({
    upstreamUrl: "https://mcp.example.test/mcp",
    oauth: {},
  }),
} as any;

let originalFetch: typeof globalThis.fetch;
let originalKey: string | undefined;
let workerToken: string;

beforeEach(() => {
  // Pin ENCRYPTION_KEY per-test (not just at module load): earlier suites in a
  // full `bun test packages/server/src` run delete ENCRYPTION_KEY in their
  // teardown, which would break both worker-token verification (401) and
  // connect-link minting at test-execution time.
  originalKey = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = CANONICAL_TEST_KEY;
  __resetEncryptionKeyCacheForTests();

  workerToken = generateWorkerToken("user-1", "conv-1", "test", {
    channelId: "chan-1",
    agentId: "shifu-u-test",
    organizationId: "org_test",
  });

  originalFetch = globalThis.fetch;
  // 動態 client 註冊一律失敗（重現 Notion/GWS 不支援 device-code 註冊）
  globalThis.fetch = (async () =>
    new Response("registration rejected", { status: 400 })) as any;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey !== undefined) {
    process.env.ENCRYPTION_KEY = originalKey;
  } else {
    delete process.env.ENCRYPTION_KEY;
  }
  __resetEncryptionKeyCacheForTests();
});

async function makeRouter(publicGatewayUrl?: string) {
  // Import with a query-string cache-buster: `provisioning-routes.test.ts`
  // registers a process-global `mock.module("../../gateway/routes/internal/
  // device-auth.js", ...)` whose `createDeviceAuthRoutes` is an EMPTY router.
  // When that file runs earlier in the same `bun test` process, a plain
  // specifier here would resolve to the stub and every request would 404.
  // The query string gives this file its own registry entry bound to the
  // real implementation.
  const { createDeviceAuthRoutes } = await import(
    "../../routes/internal/device-auth.js?device-auth-start-fallback-real"
  );
  return createDeviceAuthRoutes({
    mcpConfigService: fakeMcpConfigService,
    secretStore: fakeSecretStore,
    publicGatewayUrl,
  } as any);
}

describe("POST /internal/device-auth/start auth-code fallback", () => {
  test("device flow unavailable -> returns auth_code connect link", async () => {
    const router = await makeRouter("https://gateway.example.com");
    const res = await router.request("/internal/device-auth/start", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${workerToken}`,
      },
      body: JSON.stringify({ mcpId: "notion" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.flow).toBe("auth_code");
    expect(body.userCode).toBe("");
    expect(body.verificationUri).toContain(
      "https://gateway.example.com/mcp/oauth/start?token="
    );
    expect(body.verificationUriComplete).toBe(body.verificationUri);
    expect(body.expiresIn).toBeGreaterThan(0);
  });

  test("fallback unavailable (no publicGatewayUrl) -> 404 with actionable error", async () => {
    const router = await makeRouter(undefined);
    const res = await router.request("/internal/device-auth/start", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${workerToken}`,
      },
      body: JSON.stringify({ mcpId: "notion" }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(String(body.error)).toContain("authorization link could not be generated");
    expect(String(body.error)).toContain("notion");
  });
});
