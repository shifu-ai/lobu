import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import {
  __resetEncryptionKeyCacheForTests,
  generateWorkerToken,
  type WorkerTokenData,
} from "@lobu/core";
import {
  getOpenClawSessionContext,
  invalidateSessionContextCache,
} from "../openclaw/session-context";

const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const CLAIM = {
  environment: "production" as const,
  toolboxUserId: "user-1",
  agentId: "agent-1",
  releaseId: "release-9",
  releaseSequence: 9,
  snapshotDigest: `sha256:${"c".repeat(64)}`,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  capabilityIds: ["semantic_tool_router.effective_inventory.v1"],
};

function contextResponse() {
  return new Response(
    JSON.stringify({
      userId: "user-1",
      agentId: "agent-1",
      agentInstructions: "",
      platformInstructions: "",
      networkInstructions: "",
      skillsInstructions: "",
      mcpStatus: [],
      mcpTools: {},
    })
  );
}

/**
 * Regression for the 2026-07-20 release-claim break: worker subprocesses are
 * spawned without ENCRYPTION_KEY (base-deployment-manager env allowlist), so
 * local verifyWorkerToken always returns null and every turn collapsed to
 * legacy_unenrolled even though the gateway minted an active claim. The SSE
 * client now stamps the gateway-verified claims onto the payload; the session
 * context must prefer them over local token decoding.
 */
describe("session context with gateway-verified claims (no local key)", () => {
  let runToken: string;
  let verifiedClaims: WorkerTokenData;

  beforeEach(() => {
    process.env.DISPATCHER_URL = "https://gateway.test";
    // Mint the token WITH the key (gateway side)…
    process.env.ENCRYPTION_KEY = KEY;
    __resetEncryptionKeyCacheForTests();
    runToken = generateWorkerToken("user-1", "conv-1", "deploy-1", {
      channelId: "line-user-1",
      agentId: "agent-1",
      runId: 9,
      tokenKind: "run",
      releaseState: { status: "active", claim: CLAIM },
    });
    verifiedClaims = {
      userId: "user-1",
      conversationId: "conv-1",
      channelId: "line-user-1",
      agentId: "agent-1",
      deploymentName: "deploy-1",
      timestamp: Date.now(),
      runId: 9,
      tokenKind: "run",
      releaseState: { status: "active", claim: CLAIM },
    } as WorkerTokenData;
    // …then drop the key to simulate the worker subprocess environment.
    delete process.env.ENCRYPTION_KEY;
    __resetEncryptionKeyCacheForTests();
    invalidateSessionContextCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.DISPATCHER_URL;
    delete process.env.ENCRYPTION_KEY;
    invalidateSessionContextCache();
    __resetEncryptionKeyCacheForTests();
  });

  test("without claims the keyless worker collapses to legacy_unenrolled", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      contextResponse()
    );
    const context = await getOpenClawSessionContext({ workerToken: runToken });
    expect(context.releaseState.status).toBe("legacy_unenrolled");
  });

  test("gateway-verified claims restore the active release claim", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      contextResponse()
    );
    const context = await getOpenClawSessionContext({
      workerToken: runToken,
      verifiedTokenClaims: verifiedClaims,
    });
    expect(context.releaseState.status).toBe("active");
    expect(
      context.releaseState.status === "active"
        ? context.releaseState.claim.releaseId
        : null
    ).toBe("release-9");
  });
});
