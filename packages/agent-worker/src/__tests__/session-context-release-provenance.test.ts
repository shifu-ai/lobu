import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import {
  __resetEncryptionKeyCacheForTests,
  generateWorkerToken,
} from "@lobu/core";
import {
  getOpenClawSessionContext,
  invalidateSessionContextCache,
} from "../openclaw/session-context";

const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function token(releaseId: string) {
  return generateWorkerToken("user-1", "conv-1", "deploy-1", {
    channelId: "line-user-1",
    agentId: "agent-1",
    runId: releaseId === "r1" ? 1 : 2,
    tokenKind: "run",
    releaseCapability: {
      environment: "production",
      toolboxUserId: "user-1",
      agentId: "agent-1",
      releaseId,
      releaseSequence: releaseId === "r1" ? 1 : 2,
      snapshotDigest: `sha256:${(releaseId === "r1" ? "a" : "b").repeat(64)}`,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      capabilityIds: ["personal_reminder_delivery.v1"],
    },
  });
}

describe("session context release provenance", () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = KEY;
    process.env.DISPATCHER_URL = "https://gateway.test";
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

  test("uses the per-run token and never reuses context across release provenance", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(
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
        )
    );
    const first = token("r1");
    await getOpenClawSessionContext({ workerToken: first });
    await getOpenClawSessionContext({ workerToken: first });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(
      (fetchSpy.mock.calls[0]?.[1]?.headers as Record<string, string>)
        .Authorization
    ).toBe(`Bearer ${first}`);
    await getOpenClawSessionContext({ workerToken: token("r2") });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
