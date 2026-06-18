import { afterEach, describe, expect, test } from "bun:test";
import { createAgentApi } from "../routes/public/agent.js";
import { setAuthProvider } from "../routes/public/settings-auth.js";

describe("POST /api/v1/agents/:agentId/messages platformMetadata", () => {
  afterEach(() => {
    setAuthProvider(null);
  });

  test("passes safe request platformMetadata into direct API queue payload", async () => {
    setAuthProvider(() => ({
      userId: "owner-user",
      oauthUserId: "owner-user",
      platform: "external",
      exp: Date.now() + 60_000,
    }));

    let enqueuedPayload: any;
    const app = createAgentApi({
      queueProducer: {
        async enqueueMessage(payload: any) {
          enqueuedPayload = payload;
          return "job-reset";
        },
      } as never,
      sessionManager: {
        async getSession(id: string) {
          if (id !== "agent-1_owner-user_org-1") return null;
          return {
            conversationId: id,
            userId: "owner-user",
            agentId: "agent-1",
            organizationId: "org-1",
            provider: "gemini",
            model: "gemini-2.5-flash",
            status: "created",
            createdAt: Date.now(),
            lastActivity: Date.now(),
          };
        },
        async touchSession() {},
      } as never,
      sseManager: {} as never,
      publicGatewayUrl: "http://localhost:8787",
      agentMetadataStore: {
        async getMetadata(agentId: string) {
          if (agentId !== "agent-1") return null;
          return {
            owner: { platform: "external", userId: "owner-user" },
            organizationId: "org-1",
          };
        },
      } as never,
      userAgentsStore: {
        async ownsAgent() {
          return true;
        },
        async findAgentOrganizations() {
          return ["org-1"];
        },
      } as never,
      agentSettingsStore: {
        async getSettings() {
          return {};
        },
      } as never,
    });

    const res = await app.request("/api/v1/agents/agent-1_owner-user_org-1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "Reset this LINE conversation context.",
        platformMetadata: {
          sessionReset: true,
          source: "line-command",
          lineCommand: "/clear",
          agentId: "malicious-agent-override",
          dryRun: true,
          traceparent: "malicious-traceparent",
          intent: { kind: "watcher_run", runId: 123, watcherId: 456 },
          connectionId: "malicious-connection",
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(enqueuedPayload.platformMetadata.sessionReset).toBe(true);
    expect(enqueuedPayload.platformMetadata.source).toBe("direct-api");
    expect(enqueuedPayload.platformMetadata.lineCommand).toBe("/clear");
    expect(enqueuedPayload.platformMetadata.agentId).toBe("agent-1");
    expect(enqueuedPayload.platformMetadata.dryRun).toBe(false);
    expect(enqueuedPayload.platformMetadata.traceparent).not.toBe(
      "malicious-traceparent"
    );
    expect(enqueuedPayload.platformMetadata.intent).toBeUndefined();
    expect(enqueuedPayload.platformMetadata.connectionId).toBeUndefined();
  });
});
