import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { encrypt } from "@lobu/core";

const TEST_ENCRYPTION_KEY = Buffer.from(
  "12345678901234567890123456789012"
).toString("base64");

// Controls what the mocked org context and db return per-test.
let mockOrgId: string | null = null;
let orgSharedSecretRows: Array<{ ciphertext: string }> = [];

// Mock the org-context AsyncLocalStorage lookup so we can simulate a worker
// request that does (or doesn't) carry an org.
//
// IMPORTANT: bun's `mock.module` is process-global and permanent for the rest
// of the `bun test` process. Other modules (e.g. `gateway/routes/internal/
// middleware.ts`) import the `orgContext` named export from this same
// specifier; omitting it breaks their evaluation ("Export named 'orgContext'
// not found") for every test file loaded later in the same process — so
// mirror the full export surface of the real module.
mock.module("../../../lobu/stores/org-context.js", () => ({
  orgContext: {
    run: (_ctx: unknown, fn: () => unknown) => fn(),
    getStore: () => (mockOrgId ? { organizationId: mockOrgId } : undefined),
  },
  tryGetOrgId: () => mockOrgId,
  getOrgId: () => {
    if (!mockOrgId) throw new Error("no org");
    return mockOrgId;
  },
}));

// Mock the db client. `readOrgSharedProviderKey` uses the postgres tagged
// template (`sql\`SELECT ...\``); a tagged-template call invokes the function
// with (strings, ...values), so returning the rows array satisfies it.
mock.module("../../../db/client.js", () => ({
  getDb: () => () => Promise.resolve(orgSharedSecretRows),
}));

// Import AFTER mocks so the module graph picks them up.
const { ApiKeyProviderModule } = await import("../api-key-provider-module.js");

function makeModule(hasProfile: boolean) {
  return new ApiKeyProviderModule({
    providerId: "z-ai",
    providerDisplayName: "z.ai",
    providerIconUrl: "https://example.com/z.png",
    envVarName: "Z_AI_API_KEY",
    apiKeyInstructions: "Get a key",
    apiKeyPlaceholder: "zai-...",
    sdkCompat: "openai",
    authProfilesManager: {
      hasProviderProfiles: async () => hasProfile,
    } as any,
  });
}

describe("BaseProviderModule.hasCredentials org-shared key fallback", () => {
  const previousEncryptionKey = process.env.ENCRYPTION_KEY;
  const previousZKey = process.env.Z_AI_API_KEY;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    // Ensure no system key influences the result — we test the org-shared path.
    delete process.env.Z_AI_API_KEY;
    mockOrgId = null;
    orgSharedSecretRows = [];
  });

  afterEach(() => {
    if (previousEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = previousEncryptionKey;
    if (previousZKey === undefined) delete process.env.Z_AI_API_KEY;
    else process.env.Z_AI_API_KEY = previousZKey;
    // The db mock above hijacks `getDb()` process-wide for the rest of the
    // run. Any later suite that touches the DB through it (e.g. the
    // revoked-token store's `SELECT jti ...` in `authenticateWorker`) gets
    // whatever rows the last test left here — a non-empty leftover makes
    // every subsequent worker token look revoked (silent 401s). Reset so the
    // shared mock answers "no rows" once this file is done.
    mockOrgId = null;
    orgSharedSecretRows = [];
  });

  test("returns true when a per-user auth profile exists", async () => {
    const mod = makeModule(true);
    expect(await mod.hasCredentials("agent-1")).toBe(true);
  });

  test("returns true when only an org-shared API key exists (lobu apply path)", async () => {
    // No auth profile, but `lobu apply` wrote provider:z-ai:apiKey for the org.
    mockOrgId = "org-1";
    orgSharedSecretRows = [{ ciphertext: encrypt("zai-secret-value") }];

    const mod = makeModule(false);
    // Pass org explicitly (as the worker session-context path now does) and
    // also via the ALS fallback — both must resolve the org-shared key.
    expect(
      await mod.hasCredentials("agent-1", { organizationId: "org-1" })
    ).toBe(true);
    expect(await mod.hasCredentials("agent-1")).toBe(true);
  });

  test("returns false when neither profile nor org-shared key exists", async () => {
    mockOrgId = "org-1";
    orgSharedSecretRows = [];
    const mod = makeModule(false);
    expect(
      await mod.hasCredentials("agent-1", { organizationId: "org-1" })
    ).toBe(false);
  });

  test("returns false when there is no org context and no profile", async () => {
    // No org id anywhere → org-shared lookup short-circuits, no db hit.
    mockOrgId = null;
    orgSharedSecretRows = [{ ciphertext: encrypt("should-not-be-read") }];
    const mod = makeModule(false);
    expect(await mod.hasCredentials("agent-1")).toBe(false);
  });
});
