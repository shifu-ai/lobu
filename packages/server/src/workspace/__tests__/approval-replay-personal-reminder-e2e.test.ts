process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { createHash } from "node:crypto";
import type { ReleaseCapabilityState } from "@lobu/core";
import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { canonicalize } from "json-canonicalize";
import {
  addUserToOrganization,
  createTestAgent,
  createTestOrganization,
  createTestUser,
} from "../../__tests__/setup/test-fixtures.js";
import { getTestDb } from "../../__tests__/setup/test-db.js";
import { McpProxy } from "../../gateway/auth/mcp/proxy.js";
import { storePendingTool } from "../../gateway/auth/mcp/pending-tool-store.js";
import { createToolApprovalService } from "../../gateway/auth/mcp/tool-approval-service.js";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
} from "../../gateway/__tests__/helpers/db-setup.js";
import { clearInMemoryMcpSessionsForTests, handleMcp } from "../../mcp-handler.js";
import { MultiTenantProvider } from "../multi-tenant.js";

beforeAll(async () => ensureDbForGatewayTests(), 60_000);
beforeEach(async () => {
  await resetTestDatabase();
  clearInMemoryMcpSessionsForTests();
  process.env.SHIFU_MEMBER_AGENT_DIRECT_AUTH = "1";
});
afterEach(() => {
  delete process.env.SHIFU_MEMBER_AGENT_DIRECT_AUTH;
});

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
}

function internalMcpApp(): Hono {
  const app = new Hono();
  const provider = new MultiTenantProvider();
  app.use("/mcp/:orgSlug", async (c, next) =>
    provider.resolveAuth(c as never, next as never),
  );
  app.all("/mcp/:orgSlug", (c) => handleMcp(c as never));
  return app;
}

async function setupFixture(receiptStatus: "applied" | "failed" = "applied") {
  const org = await createTestOrganization({ name: "Approval Replay E2E" });
  const owner = await createTestUser({ name: "Approval Replay Owner" });
  await addUserToOrganization(owner.id, org.id, "member");
  const agent = await createTestAgent({ organizationId: org.id, ownerUserId: owner.id });
  const sql = getTestDb();
  await sql`UPDATE agents SET owner_platform = 'toolbox' WHERE id = ${agent.agentId}`;
  const settingsHash = digest({
    identityMd: "",
    soulMd: "",
    userMd: "",
    modelSelection: {},
    toolsConfig: {},
  });
  const sha = `sha256:${"b".repeat(64)}`;
  await sql`
    INSERT INTO agent_release_applies (
      organization_id, agent_id, environment,
      desired_release_id, desired_release_sequence, desired_feed_sequence,
      applied_release_id, applied_release_sequence, applied_feed_sequence,
      applied_channel, applied_feed_digest, manifest_digest, status,
      revision_ref, settings_hash
    ) VALUES (
      ${org.id}, ${agent.agentId}, 'production',
      'release-e2e', 1, 1, 'release-e2e', 1, 1,
      'stable', ${sha}, ${sha}, ${receiptStatus},
      'lobu:approval-replay:e2e', ${settingsHash}
    )
  `;
  return { org, owner, agent, sha };
}

function activeState(input: {
  ownerId: string;
  agentId: string;
  sha: string;
  expiresAt?: string;
}): ReleaseCapabilityState {
  return {
    status: "active",
    claim: {
      environment: "production",
      toolboxUserId: input.ownerId,
      agentId: input.agentId,
      releaseId: "release-e2e",
      releaseSequence: 1,
      snapshotDigest: input.sha,
      expiresAt: input.expiresAt ?? new Date(Date.now() + 30_000).toISOString(),
      capabilityIds: ["personal_reminder_delivery.v1"],
    },
  };
}

async function replay(input: {
  org: { id: string; slug: string };
  ownerId: string;
  agentId: string;
  releaseState: ReleaseCapabilityState;
  approvalId: string;
  identityAgentId?: string;
  omitOriginalRunIdentity?: boolean;
}) {
  const conversationId = `${input.agentId}_${input.ownerId}_line-e2e`;
  await storePendingTool(input.approvalId, {
    mcpId: "lobu-memory",
    toolName: "manage_schedules",
    args: {
      action: "create",
      description: "提醒回覆客戶",
      run_at: new Date(Date.now() + 60_000).toISOString(),
      delivery_intent: {
        contract: "personal_reminder_delivery.v1",
        destination: "personal_reminder",
      },
      payload: {
        type: "wake_agent",
        agent_id: input.agentId,
        prompt: "提醒我回覆客戶",
        thread_id: conversationId,
      },
    },
    agentId: input.agentId,
    userId: input.ownerId,
    organizationId: input.org.id,
    conversationId,
    channelId: "line-user-e2e",
    releaseState: input.releaseState,
    ...(input.omitOriginalRunIdentity
      ? {}
      : { originalRunIdentity: { runId: 91, deploymentName: "worker-e2e" } }),
    personalReminderDeliveryIntent: true,
    ...(input.identityAgentId
      ? {
          releaseState: {
            ...input.releaseState,
            ...(input.releaseState.status === "active"
              ? { claim: { ...input.releaseState.claim, agentId: input.identityAgentId } }
              : {}),
          } as ReleaseCapabilityState,
        }
      : {}),
  }, 60);

  const internal = internalMcpApp();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock(async (request, init) => {
    const url = typeof request === "string" ? request : request instanceof URL ? request.href : request.url;
    if (new URL(url).hostname !== "internal.test") return originalFetch(request, init);
    return internal.request(url, init);
  }) as typeof fetch;
  try {
    const proxy = new McpProxy(
      {
        getHttpServer: async () => ({
          id: "lobu-memory",
          upstreamUrl: `https://internal.test/mcp/${input.org.slug}`,
          internal: true,
        }),
        getAllHttpServers: async () => new Map(),
      },
      {
        secretStore: {
          get: async () => null,
          put: async () => "secret://test" as const,
          delete: async () => undefined,
          list: async () => [],
        },
      },
    );
    return await createToolApprovalService({
      grantStore: {
        grant: mock(async () => undefined),
        hasGrant: mock(async () => false),
        revoke: mock(async () => undefined),
      },
      mcpProxy: proxy,
      userAgentsStore: { ownsAgent: mock(async () => true) },
      organizationId: input.org.id,
    }).submit({
      action: "approve_once",
      approvalId: input.approvalId,
      toolboxUserId: input.ownerId,
      lineUserId: "line-user-e2e",
      agentId: input.agentId,
      organizationId: input.org.id,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe("personal reminder approval replay trust bridge E2E", () => {
  test("active original run traverses proxy, multi-tenant auth, and creates one reminder", async () => {
    const fixture = await setupFixture();
    const result = await replay({
      org: fixture.org,
      ownerId: fixture.owner.id,
      agentId: fixture.agent.agentId,
      releaseState: activeState({
        ownerId: fixture.owner.id,
        agentId: fixture.agent.agentId,
        sha: fixture.sha,
      }),
      approvalId: "approval-active-e2e",
    });
    expect(result).toMatchObject({ status: "executed", result: { isError: false } });
    const [{ count }] = await getTestDb()<{ count: number }>`SELECT count(*)::int AS count FROM scheduled_jobs`;
    expect(count).toBe(1);
  });

  test.each(["expired", "revoked", "identity_mismatch", "missing_identity"] as const)(
    "%s original run is rejected and writes zero reminders",
    async (failure) => {
      const fixture = await setupFixture(failure === "revoked" ? "failed" : "applied");
      const result = await replay({
        org: fixture.org,
        ownerId: fixture.owner.id,
        agentId: fixture.agent.agentId,
        releaseState: activeState({
          ownerId: fixture.owner.id,
          agentId: fixture.agent.agentId,
          sha: fixture.sha,
          ...(failure === "expired"
            ? { expiresAt: new Date(Date.now() - 1_000).toISOString() }
            : {}),
        }),
        approvalId: `approval-${failure}-e2e`,
        ...(failure === "identity_mismatch" ? { identityAgentId: "shifu-u-other" } : {}),
        ...(failure === "missing_identity" ? { omitOriginalRunIdentity: true } : {}),
      });
      expect(result.status).toBe("executed");
      if (failure === "identity_mismatch" || failure === "missing_identity") {
        expect(result).toMatchObject({ result: { isError: true } });
      } else {
        expect(JSON.stringify(result)).toContain("personal_reminder_release_inactive");
      }
      const [{ count }] = await getTestDb()<{ count: number }>`SELECT count(*)::int AS count FROM scheduled_jobs`;
      expect(count).toBe(0);
    },
  );
});
