import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  buildPendingToolExecutionOptions,
  getPendingTool,
  stableReleaseAuthorizationDigest,
  stableToolEligibilityDigest,
  storePendingTool,
  type PendingToolInvocation,
} from "../auth/mcp/pending-tool-store.js";
import { createGatewayApp } from "../cli/gateway.js";
import {
	ensureDbForGatewayTests,
	resetTestDatabase,
} from "./helpers/db-setup.js";

const AUTH_TOKEN = "gateway-approval-test-token";

function makeApp(
  executeToolDirect: ReturnType<typeof mock>,
  grant = mock(async () => undefined),
  caller = { userId: "user-1", organizationId: "org-1" },
  continuationResults?: boolean[],
) {
  const empty = () => undefined;
  const coreServices = {
    getPublicGatewayUrl: () => "https://lobu.example",
    getQueueProducer: () => ({ enqueueMessage: mock(async () => "job-1") }),
    getSessionManager: () => ({
      getSession: mock(async () => null),
      touchSession: mock(async () => undefined),
    }),
    getInteractionService: () => ({}),
    getSseManager: () => ({}),
    getAgentMetadataStore: empty,
    getTranscriptionService: empty,
    getBedrockOpenAIService: empty,
    getSecretStore: empty,
    getMcpConfigService: empty,
    getImageGenerationService: empty,
    getGrantStore: () => ({ grant }),
    getMcpProxy: () => ({
      executeToolDirect: async (...args: any[]) => {
        const authorization = args[5]?.approvalReplayAuthorization;
        if (authorization) {
          if (!(await authorization.revalidate())) {
            return {
              content: [{ type: "text", text: "stale" }],
              isError: true,
              diagnosticCode: "approval_inventory_stale",
            };
          }
          await authorization.onAuthorized?.();
        }
        return executeToolDirect(...args);
      },
      revalidatePendingToolEligibility: mock(async () => true),
    }),
    getExternalAuthClient: empty,
    getAgentSettingsStore: empty,
    getConfigStore: empty,
    getUserAgentsStore: empty,
    getAuthProfilesManager: empty,
    getOAuthStateStore: empty,
    getProviderRegistryService: empty,
    getWorkerGateway: empty,
    getQueue: empty,
    getProviderCatalogService: empty,
    getChannelBindingService: empty,
  };
  return createGatewayApp({
    secretProxy: null,
    workerGateway: null,
    mcpProxy: null,
    coreServices,
    authProvider: (c) =>
      c.req.header("authorization") === `Bearer ${AUTH_TOKEN}`
        ? {
            userId: caller.userId,
            organizationId: caller.organizationId,
            platform: "api",
            exp: Date.now() + 60_000,
          }
        : null,
    ...(continuationResults
      ? {
          approvalContinuationValidator: mock(async () =>
            continuationResults.shift()
              ? ({ valid: true } as const)
              : ({ valid: false, diagnosticCode: "approval_inventory_stale" } as const)
          ),
        }
      : {}),
  });
}

async function approve(app: ReturnType<typeof makeApp>, requestId: string) {
  return app.request("/api/v1/agents/approve", {
    method: "POST",
    headers: {
      authorization: `Bearer ${AUTH_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ requestId, decision: "1h" }),
  });
}

describe("CLI gateway pending-tool approval replay", () => {
  beforeAll(async () => ensureDbForGatewayTests());
  beforeEach(async () => resetTestDatabase());

  test("wrong authenticated caller cannot consume another user's approval", async () => {
    await storePendingTool("cli-wrong-caller", {
      mcpId: "github",
      toolName: "create_issue",
      args: {},
      agentId: "agent-1",
      userId: "user-1",
      organizationId: "org-1",
    }, 60);
    const execute = mock(async () => ({ content: [], isError: false }));
    const grant = mock(async () => undefined);
    const response = await approve(
      makeApp(execute, grant, { userId: "user-2", organizationId: "org-1" }),
      "cli-wrong-caller",
    );
    expect(response.status).toBe(403);
    expect(await getPendingTool("cli-wrong-caller")).not.toBeNull();
    expect(grant).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  test.each([
    ["missing", undefined],
    ["mismatched", "org-2"],
  ])("%s caller organization fails closed and retains the approval", async (_label, organizationId) => {
    await storePendingTool("cli-org-bound", {
      mcpId: "github",
      toolName: "create_issue",
      args: {},
      agentId: "agent-1",
      userId: "user-1",
      organizationId: "org-1",
    }, 60);
    const execute = mock(async () => ({ content: [], isError: false }));
    const grant = mock(async () => undefined);
    const response = await approve(
      makeApp(execute, grant, { userId: "user-1", organizationId }),
      "cli-org-bound",
    );
    expect(response.status).toBe(403);
    expect(await getPendingTool("cli-org-bound")).not.toBeNull();
    expect(grant).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  test("stale semantic approval cannot grant or execute", async () => {
    const claim = {
      environment: "production" as const,
      toolboxUserId: "user-1",
      agentId: "agent-1",
      releaseId: "release-1",
      releaseSequence: 1,
      snapshotDigest: `sha256:${"a".repeat(64)}`,
      expiresAt: "2000-01-01T00:00:00.000Z",
      capabilityIds: ["semantic_tool_router.effective_inventory.v1"],
    };
    const stableAuthorizationDigest = stableReleaseAuthorizationDigest(claim);
    await storePendingTool("cli-stale", {
      mcpId: "github",
      toolName: "create_issue",
      args: {},
      agentId: "agent-1",
      userId: "user-1",
      organizationId: "org-1",
      releaseState: { status: "active", claim },
      releaseBinding: {
        routerMode: "semantic",
        effectiveInventoryFingerprint: "b".repeat(64),
        releaseId: claim.releaseId,
        releaseSequence: claim.releaseSequence,
        snapshotDigest: claim.snapshotDigest,
        authorizationExpiresAt: claim.expiresAt,
        stableAuthorizationDigest,
        eligibilityBindingDigest: stableToolEligibilityDigest({
          mcpId: "github",
          toolName: "create_issue",
          effectiveInventoryFingerprint: "b".repeat(64),
          stableAuthorizationDigest,
        }),
      },
    }, 60);
    const execute = mock(async () => ({ content: [], isError: false }));
    const grant = mock(async () => undefined);
    const response = await approve(makeApp(execute, grant), "cli-stale");
    expect(await response.json()).toMatchObject({
      error: "approval_inventory_stale",
    });
    expect(grant).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  test("active CLI continuation without a release binding fails closed", async () => {
    await storePendingTool("cli-missing-binding", {
      mcpId: "github",
      toolName: "create_issue",
      args: {},
      agentId: "agent-1",
      userId: "user-1",
      organizationId: "org-1",
      releaseState: {
        status: "active",
        claim: {
          environment: "production",
          toolboxUserId: "user-1",
          agentId: "agent-1",
          releaseId: "release-1",
          releaseSequence: 1,
          snapshotDigest: `sha256:${"a".repeat(64)}`,
          expiresAt: "2099-01-01T00:00:00.000Z",
          capabilityIds: [],
        },
      },
    }, 60);
    const execute = mock(async () => ({ content: [], isError: false }));
    const grant = mock(async () => undefined);
    const response = await approve(makeApp(execute, grant), "cli-missing-binding");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "approval_inventory_stale" });
    expect(grant).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  test("CLI egress revocation after two validations leaves no grant or upstream execution", async () => {
    const claim = {
      environment: "production" as const,
      toolboxUserId: "user-1",
      agentId: "agent-1",
      releaseId: "release-egress",
      releaseSequence: 1,
      snapshotDigest: `sha256:${"a".repeat(64)}`,
      expiresAt: "2099-01-01T00:00:00.000Z",
      capabilityIds: [],
    };
    const stableAuthorizationDigest = stableReleaseAuthorizationDigest(claim);
    await storePendingTool("cli-egress-revoke", {
      mcpId: "github",
      toolName: "create_issue",
      args: {},
      agentId: "agent-1",
      userId: "user-1",
      organizationId: "org-1",
      releaseState: { status: "active", claim },
      releaseBinding: {
        routerMode: "legacy",
        effectiveInventoryFingerprint: "b".repeat(64),
        releaseId: claim.releaseId,
        releaseSequence: claim.releaseSequence,
        snapshotDigest: claim.snapshotDigest,
        authorizationExpiresAt: claim.expiresAt,
        stableAuthorizationDigest,
        eligibilityBindingDigest: stableToolEligibilityDigest({
          mcpId: "github",
          toolName: "create_issue",
          effectiveInventoryFingerprint: "b".repeat(64),
          stableAuthorizationDigest,
        }),
      },
    }, 60);
    const execute = mock(async () => ({ content: [], isError: false }));
    const grant = mock(async () => undefined);
    const response = await approve(
      makeApp(execute, grant, undefined, [true, true, false]),
      "cli-egress-revoke",
    );
    expect(response.status).toBe(200);
    expect(grant).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  test("reserved automation approval forwards identity, channel, and existing course scope", async () => {
    const expectedMcpIdentity = {
      upstreamOrigin: "https://mcp.shifu-ai.org",
      configSource: "agent" as const,
      configDigest: "digest-at-discovery",
    };
    const courseToolScope = {
      ownerUserId: "user-1",
      agentId: "agent-1",
      courseEntityId: "course:user-1:a",
    };
    const releaseCapability = {
      environment: "production" as const,
      toolboxUserId: "user-1",
      agentId: "agent-1",
      releaseId: "release-original",
      releaseSequence: 3,
      snapshotDigest: `sha256:${"a".repeat(64)}`,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      capabilityIds: ["personal_reminder_delivery.v1"],
    };
    await storePendingTool(
      "cli-reserved-success",
      {
        mcpId: "shifu-toolbox",
        toolName: "create_automation",
        args: { prompt: "提醒 Irene" },
        agentId: "agent-1",
        userId: "user-1",
        channelId: "line-user-1",
        courseToolScope,
        expectedMcpIdentity,
        organizationId: "org-1",
        releaseState: { status: "legacy_unenrolled" },
      },
			60,
    );
    const executeToolDirect = mock(async () => ({
      content: [{ type: "text", text: "created" }],
      isError: false,
    }));

		const response = await approve(
			makeApp(executeToolDirect),
			"cli-reserved-success",
		);

    expect(response.status).toBe(200);
    expect(executeToolDirect).toHaveBeenCalledWith(
      "agent-1",
      "user-1",
      "shifu-toolbox",
      "create_automation",
      { prompt: "提醒 Irene" },
			{
				approvalReplay: true,
				courseToolScope,
				expectedMcpIdentity,
				channelId: "line-user-1",
				organizationId: "org-1",
				releaseState: { status: "legacy_unenrolled" },
			},
    );
  });

  test("returns the reserved-tool config mismatch without retrying or dropping channel scope", async () => {
    const expectedMcpIdentity = {
      upstreamOrigin: "https://mcp.shifu-ai.org",
      configSource: "agent" as const,
      configDigest: "stale-digest",
    };
    await storePendingTool(
      "cli-reserved-stale",
			{
        mcpId: "shifu-toolbox",
        toolName: "list_automations",
        args: {},
        agentId: "agent-1",
        userId: "user-1",
        channelId: "line-user-1",
        expectedMcpIdentity,
        organizationId: "org-1",
      },
			60,
    );
    const mismatch = {
      content: [
        {
          type: "text",
          text: "MCP configuration changed after tool discovery.",
        },
      ],
      isError: true,
      diagnosticCode: "MCP_CONFIG_IDENTITY_MISMATCH",
    };
    const executeToolDirect = mock(async () => mismatch);

		const response = await approve(
			makeApp(executeToolDirect),
			"cli-reserved-stale",
		);

    expect(response.status).toBe(200);
    expect(executeToolDirect).toHaveBeenCalledTimes(1);
    expect(executeToolDirect).toHaveBeenCalledWith(
      "agent-1",
      "user-1",
      "shifu-toolbox",
      "list_automations",
      {},
			{
        approvalReplay: true,
        expectedMcpIdentity,
        channelId: "line-user-1",
        organizationId: "org-1",
      },
    );
  });

  test("legacy pending rows carry only the replay marker and no invented identity", () => {
    const legacy: PendingToolInvocation = {
      mcpId: "github",
      toolName: "read_issue",
      args: {},
      agentId: "agent-1",
      userId: "user-1",
    };
    expect(buildPendingToolExecutionOptions(legacy)).toEqual({ approvalReplay: true });
  });
});
