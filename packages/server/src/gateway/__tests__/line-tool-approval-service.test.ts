import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { generateWorkerToken, verifyWorkerToken } from "@lobu/core";
import { orgContext, tryGetOrgId } from "../../lobu/stores/org-context.js";
import {
  getPendingTool,
  pendingToolContinuationDigest,
  stableReleaseAuthorizationDigest,
  stableToolEligibilityDigest,
  type PendingToolInvocation,
  storePendingTool,
  takePendingToolIfUnchanged,
} from "../auth/mcp/pending-tool-store.js";
import {
  isToolNameAllowedByToolsConfig,
  McpProxy,
} from "../auth/mcp/proxy.js";
import { McpToolCache } from "../auth/mcp/tool-cache.js";
import {
  createToolApprovalService,
  GLOBAL_TOOL_AUTO_APPROVAL_PATTERN,
  isPendingReleaseBindingCurrent,
} from "../auth/mcp/tool-approval-service.js";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
} from "./helpers/db-setup.js";

const LINE_PENDING: PendingToolInvocation = {
  agentId: "shifu-u-1",
  userId: "toolbox-user-1",
  mcpId: "google_workspace",
  toolName: "gws_calendar_events_create",
  args: { summary: "Demo" },
  conversationId: "conv-1",
  channelId: "line-user-1",
  connectionId: "line-connection",
};

const SEMANTIC_CLAIM = {
  environment: "production" as const,
  toolboxUserId: "toolbox-user-1",
  agentId: "shifu-u-1",
  releaseId: "release-1",
  releaseSequence: 1,
  snapshotDigest: `sha256:${"a".repeat(64)}`,
  expiresAt: "2099-01-01T00:00:00.000Z",
  capabilityIds: ["semantic_tool_router.effective_inventory.v1"],
};
const STABLE_SEMANTIC_DIGEST = stableReleaseAuthorizationDigest(SEMANTIC_CLAIM);
const STABLE_ELIGIBILITY_DIGEST = stableToolEligibilityDigest({
  mcpId: LINE_PENDING.mcpId,
  toolName: LINE_PENDING.toolName,
  connectionId: LINE_PENDING.connectionId,
  effectiveInventoryFingerprint: "b".repeat(64),
  stableAuthorizationDigest: STABLE_SEMANTIC_DIGEST,
});

async function seedLinePending(
  approvalId: string,
  overrides: Partial<PendingToolInvocation> = {},
): Promise<void> {
  await storePendingTool(
    approvalId,
    {
      ...LINE_PENDING,
      ...overrides,
    },
    60,
  );
}

function setupService() {
  const grantStore = {
    grant: mock(async () => undefined),
    hasGrant: mock(async () => false),
  };
  const mcpProxy = {
    executeToolDirect: mock(async () => ({
      content: [{ type: "text", text: "created" }],
      isError: false,
    })),
  };
  const userAgentsStore = {
    ownsAgent: mock(async () => true),
  };
  const service = createToolApprovalService({
    grantStore,
    mcpProxy,
    userAgentsStore,
    organizationId: "org-1",
  });

  return { grantStore, mcpProxy, userAgentsStore, service };
}

async function submitApproveAll(
  service: ReturnType<typeof createToolApprovalService>,
  overrides: Partial<{
    approvalId: string;
    toolboxUserId: string;
    lineUserId: string;
    agentId: string;
  }> = {},
) {
  return service.submit({
    action: "approve_all",
    approvalId: "ta-line-1",
    toolboxUserId: "toolbox-user-1",
    lineUserId: "line-user-1",
    agentId: "shifu-u-1",
    ...overrides,
  });
}

describe("createToolApprovalService", () => {
  beforeAll(async () => {
    await ensureDbForGatewayTests();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  test("semantic eligibility applies worker-compatible deny and strict allow policy to the tool name", () => {
    expect(isToolNameAllowedByToolsConfig("manage_schedules", {
      allowedTools: ["manage_*"],
      deniedTools: ["manage_schedules"],
      strictMode: true,
    })).toBe(false);
    expect(isToolNameAllowedByToolsConfig("manage_schedules", {
      allowedTools: ["manage_*"],
      strictMode: true,
    })).toBe(true);
    expect(isToolNameAllowedByToolsConfig("other_tool", {
      allowedTools: ["manage_*"],
      strictMode: true,
    })).toBe(false);
    expect(isToolNameAllowedByToolsConfig("manage_schedules", {
      deniedTools: [" manage_schedules "],
    })).toBe(false);
    expect(isToolNameAllowedByToolsConfig(
      "manage_schedules",
      { allowedTools: ["manage_schedules"] },
      { disallowedTools: [" manage_* "] },
    )).toBe(false);
    expect(isToolNameAllowedByToolsConfig(
      "manage_schedules",
      { strictMode: true },
      { allowedTools: [" manage_* "] },
    )).toBe(true);
    const currentGlobalPolicy: {
      allowedTools?: string[];
      disallowedTools?: string[];
    } = {};
    expect(isToolNameAllowedByToolsConfig(
      "manage_schedules",
      undefined,
      currentGlobalPolicy,
    )).toBe(true);
    currentGlobalPolicy.disallowedTools = [" manage_schedules "];
    expect(isToolNameAllowedByToolsConfig(
      "manage_schedules",
      undefined,
      currentGlobalPolicy,
    )).toBe(false);
    expect(isToolNameAllowedByToolsConfig(
      "manage_schedules",
      { strictMode: true, allowedTools: ["man*chedules"] },
    )).toBe(false);
  });

  test("semantic production revalidation rejects current deny and forces fresh discovery", async () => {
    const originalFetch = globalThis.fetch;
    let discoveredTools = [{ name: "manage_schedules" }];
    let toolListCalls = 0;
    let toolsConfig: { deniedTools?: string[] } = {};
    let globalPolicy: { disallowedTools?: string[] } = {};
    const grantStore = {
      grant: mock(async () => undefined),
      hasGrant: mock(async () => false),
      isDenied: mock(async () => false),
      revoke: mock(async () => undefined),
    };
    const proxy = new McpProxy(
      {
        getHttpServer: async () => ({
          id: "lobu-memory",
          upstreamUrl: "https://memory.test/mcp",
          configSource: "agent" as const,
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
        toolCache: new McpToolCache(),
        grantStore: grantStore as never,
        agentSettingsStore: {
          getSettings: mock(async () => ({ toolsConfig })),
        } as never,
        guardrailRegistry: {} as never,
        globalToolPolicyResolver: () => globalPolicy,
      },
    );
    (proxy as any).runPreToolGuardrails = mock(async () => false);
    globalThis.fetch = mock(async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (body.method === "notifications/initialized") {
        return new Response("", { status: 202 });
      }
      if (body.method === "tools/list") toolListCalls++;
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: body.method === "tools/list"
          ? { tools: discoveredTools }
          : { protocolVersion: "2025-03-26" },
      }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const pending = {
      ...LINE_PENDING,
      organizationId: "org-1",
      mcpId: "lobu-memory",
      toolName: "manage_schedules",
    };
    try {
      expect(await proxy.revalidatePendingToolEligibility({
        ...pending,
        organizationId: undefined,
      })).toBe(false);
      expect(await orgContext.run({ organizationId: "org-1" }, () =>
        proxy.revalidatePendingToolEligibility(pending)
      )).toBe(true);
      expect(toolListCalls).toBe(1);

      globalPolicy = { disallowedTools: ["manage_*"] };
      expect(await orgContext.run({ organizationId: "org-1" }, () =>
        proxy.revalidatePendingToolEligibility(pending)
      )).toBe(false);
      globalPolicy = {};

      toolsConfig = { deniedTools: ["manage_schedules"] };
      expect(await orgContext.run({ organizationId: "org-1" }, () =>
        proxy.revalidatePendingToolEligibility(pending)
      )).toBe(false);
      toolsConfig = {};

      grantStore.isDenied.mockImplementation(async () => true);
      expect(await orgContext.run({ organizationId: "org-1" }, () =>
        proxy.revalidatePendingToolEligibility(pending)
      )).toBe(false);
      expect(grantStore.isDenied).toHaveBeenCalledWith(
        "shifu-u-1",
        "/mcp/lobu-memory/tools/manage_schedules",
        "org-1",
      );
      grantStore.isDenied.mockImplementation(async () => false);

      expect(await orgContext.run({ organizationId: "org-1" }, () =>
        proxy.revalidatePendingToolEligibility({
          ...pending,
          expectedMcpIdentity: {
            upstreamOrigin: "https://changed.example",
            configSource: "agent",
            configDigest: "changed",
          },
        })
      )).toBe(false);

      discoveredTools = [];
      expect(await orgContext.run({ organizationId: "org-1" }, () =>
        proxy.revalidatePendingToolEligibility(pending)
      )).toBe(false);
      expect(toolListCalls).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("conditional claim cannot consume an upserted replacement", async () => {
    await seedLinePending("ta-race");
    const candidate = await getPendingTool("ta-race");
    expect(candidate).not.toBeNull();
    await seedLinePending("ta-race", { args: { summary: "replacement" } });
    expect(await takePendingToolIfUnchanged(
      "ta-race",
      candidate!,
      pendingToolContinuationDigest(candidate!),
    )).toBeNull();
    expect((await getPendingTool("ta-race"))?.args).toEqual({
      summary: "replacement",
    });
  });

  test.each([
    ["capability removed", { capabilityIds: [] }],
    ["release advanced", { releaseId: "release-2", releaseSequence: 2 }],
    ["authorization expired", { expiresAt: "2000-01-01T00:00:00.000Z" }],
  ])("semantic continuation is stale when %s", (_label, claimOverride) => {
    const pending: PendingToolInvocation = {
      ...LINE_PENDING,
      releaseBinding: {
        routerMode: "semantic",
        effectiveInventoryFingerprint: "b".repeat(64),
        releaseId: "release-1",
        releaseSequence: 1,
        snapshotDigest: `sha256:${"a".repeat(64)}`,
        authorizationExpiresAt: "2099-01-01T00:00:00.000Z",
        stableAuthorizationDigest: STABLE_SEMANTIC_DIGEST,
        eligibilityBindingDigest: STABLE_ELIGIBILITY_DIGEST,
      },
    };
    const claim = {
      environment: "production" as const,
      toolboxUserId: "toolbox-user-1",
      agentId: "shifu-u-1",
      releaseId: "release-1",
      releaseSequence: 1,
      snapshotDigest: `sha256:${"a".repeat(64)}`,
      expiresAt: "2099-01-01T00:00:00.000Z",
      capabilityIds: ["semantic_tool_router.effective_inventory.v1"],
      ...claimOverride,
    };
    expect(isPendingReleaseBindingCurrent(
      pending,
      { status: "active", claim },
      new Date("2026-07-15T00:00:00.000Z"),
    )).toBe(false);
  });

  test("semantic continuation accepts only its exact current release identity", () => {
    const pending: PendingToolInvocation = {
      ...LINE_PENDING,
      releaseBinding: {
        routerMode: "semantic",
        effectiveInventoryFingerprint: "b".repeat(64),
        releaseId: "release-1",
        releaseSequence: 1,
        snapshotDigest: `sha256:${"a".repeat(64)}`,
        authorizationExpiresAt: "2099-01-01T00:00:00.000Z",
        stableAuthorizationDigest: STABLE_SEMANTIC_DIGEST,
        eligibilityBindingDigest: STABLE_ELIGIBILITY_DIGEST,
      },
    };
    expect(isPendingReleaseBindingCurrent(pending, {
      status: "active",
      claim: {
        environment: "production",
        toolboxUserId: "toolbox-user-1",
        agentId: "shifu-u-1",
        releaseId: "release-1",
        releaseSequence: 1,
        snapshotDigest: `sha256:${"a".repeat(64)}`,
        expiresAt: "2099-01-01T00:00:00.000Z",
        capabilityIds: ["semantic_tool_router.effective_inventory.v1"],
      },
    }, new Date("2026-07-15T00:00:00.000Z"))).toBe(true);
  });

  test("expired original carrier cannot be blessed by a fresh same-release renewal", () => {
    const pending: PendingToolInvocation = {
      ...LINE_PENDING,
      releaseBinding: {
        routerMode: "semantic",
        effectiveInventoryFingerprint: "b".repeat(64),
        releaseId: "release-1",
        releaseSequence: 1,
        snapshotDigest: `sha256:${"a".repeat(64)}`,
        authorizationExpiresAt: "2026-07-14T23:59:00.000Z",
        stableAuthorizationDigest: STABLE_SEMANTIC_DIGEST,
        eligibilityBindingDigest: STABLE_ELIGIBILITY_DIGEST,
      },
    };
    expect(isPendingReleaseBindingCurrent(pending, {
      status: "active",
      claim: {
        ...SEMANTIC_CLAIM,
        snapshotDigest: `sha256:${"f".repeat(64)}`,
        expiresAt: "2099-01-01T00:01:00.000Z",
      },
    }, new Date("2026-07-15T00:00:00.000Z"))).toBe(false);
  });

  test("rejects a stale semantic release before approve_all can grant or execute", async () => {
    await seedLinePending("ta-line-1", {
      releaseState: {
        status: "active",
        claim: {
          environment: "production",
          toolboxUserId: "toolbox-user-1",
          agentId: "shifu-u-1",
          releaseId: "release-1",
          releaseSequence: 1,
          snapshotDigest: `sha256:${"a".repeat(64)}`,
          expiresAt: "2099-01-01T00:00:00.000Z",
          capabilityIds: ["semantic_tool_router.effective_inventory.v1"],
        },
      },
      releaseBinding: {
        routerMode: "semantic",
        effectiveInventoryFingerprint: "b".repeat(64),
        releaseId: "release-1",
        releaseSequence: 1,
        snapshotDigest: `sha256:${"a".repeat(64)}`,
        authorizationExpiresAt: "2099-01-01T00:00:00.000Z",
        stableAuthorizationDigest: STABLE_SEMANTIC_DIGEST,
        eligibilityBindingDigest: STABLE_ELIGIBILITY_DIGEST,
      },
    });
    const grantStore = {
      grant: mock(async () => undefined),
      hasGrant: mock(async () => false),
      revoke: mock(async () => undefined),
    };
    const mcpProxy = {
      executeToolDirect: mock(async () => ({ content: [], isError: false })),
      revalidatePendingToolEligibility: mock(async () => true),
    };
    const service = createToolApprovalService({
      grantStore,
      mcpProxy,
      userAgentsStore: { ownsAgent: mock(async () => true) },
      organizationId: "org-1",
      resolveReleaseSnapshot: mock(async () => ({
        schemaVersion: 1 as const,
        environment: "production" as const,
        toolboxUserId: "toolbox-user-1",
        agentId: "shifu-u-1",
        capabilities: [],
        appliedReleaseId: "release-1",
        appliedReleaseSequence: 1,
        snapshotDigest: `sha256:${"c".repeat(64)}`,
        expiresAt: "2099-01-01T00:00:00.000Z",
      })),
      readReleaseState: mock(async () => ({
        status: "enrolled_inactive" as const,
        environment: "production" as const,
        reason: "receipt_invalid" as const,
      })),
    });

    expect(await submitApproveAll(service)).toEqual({
      status: "stale",
      diagnosticCode: "approval_inventory_stale",
    });
    expect(grantStore.grant).not.toHaveBeenCalled();
    expect(mcpProxy.executeToolDirect).not.toHaveBeenCalled();
    expect(await getPendingTool("ta-line-1")).toBeNull();
  });

  test("fresh snapshot resolver failure fails closed before grant or execute", async () => {
    await seedLinePending("ta-fresh-unavailable", {
      releaseState: { status: "active", claim: SEMANTIC_CLAIM },
      releaseBinding: {
        routerMode: "semantic",
        effectiveInventoryFingerprint: "b".repeat(64),
        releaseId: SEMANTIC_CLAIM.releaseId,
        releaseSequence: SEMANTIC_CLAIM.releaseSequence,
        snapshotDigest: SEMANTIC_CLAIM.snapshotDigest,
        authorizationExpiresAt: SEMANTIC_CLAIM.expiresAt,
        stableAuthorizationDigest: STABLE_SEMANTIC_DIGEST,
        eligibilityBindingDigest: STABLE_ELIGIBILITY_DIGEST,
      },
    });
    const grant = mock(async () => undefined);
    const executeToolDirect = mock(async () => ({ content: [], isError: false }));
    const service = createToolApprovalService({
      grantStore: {
        grant,
        hasGrant: mock(async () => false),
        revoke: mock(async () => undefined),
      },
      mcpProxy: {
        executeToolDirect,
        revalidatePendingToolEligibility: mock(async () => true),
      },
      userAgentsStore: { ownsAgent: mock(async () => true) },
      organizationId: "org-1",
      resolveReleaseSnapshot: mock(async () => {
        throw new Error("snapshot unavailable");
      }),
    });
    expect(await service.submit({
      action: "approve_all",
      approvalId: "ta-fresh-unavailable",
      toolboxUserId: "toolbox-user-1",
      lineUserId: "line-user-1",
      agentId: "shifu-u-1",
    })).toEqual({
      status: "stale",
      diagnosticCode: "approval_inventory_stale",
    });
    expect(grant).not.toHaveBeenCalled();
    expect(executeToolDirect).not.toHaveBeenCalled();
  });

  test("active LINE continuation without a release binding fails closed", async () => {
    await seedLinePending("ta-missing-binding", {
      releaseState: { status: "active", claim: SEMANTIC_CLAIM },
    });
    const { grantStore, mcpProxy, service } = setupService();
    expect(await service.submit({
      action: "approve_once",
      approvalId: "ta-missing-binding",
      toolboxUserId: "toolbox-user-1",
      lineUserId: "line-user-1",
      agentId: "shifu-u-1",
    })).toEqual({
      status: "stale",
      diagnosticCode: "approval_inventory_stale",
    });
    expect(grantStore.grant).not.toHaveBeenCalled();
    expect(mcpProxy.executeToolDirect).not.toHaveBeenCalled();
  });

  test("deny introduced after claim is revalidated at the side-effect boundary", async () => {
    await seedLinePending("ta-toctou", {
      releaseState: { status: "active", claim: SEMANTIC_CLAIM },
      releaseBinding: {
        routerMode: "shadow",
        effectiveInventoryFingerprint: "b".repeat(64),
        releaseId: SEMANTIC_CLAIM.releaseId,
        releaseSequence: SEMANTIC_CLAIM.releaseSequence,
        snapshotDigest: SEMANTIC_CLAIM.snapshotDigest,
        authorizationExpiresAt: SEMANTIC_CLAIM.expiresAt,
        stableAuthorizationDigest: STABLE_SEMANTIC_DIGEST,
        eligibilityBindingDigest: STABLE_ELIGIBILITY_DIGEST,
      },
    });
    const eligibility = [true, false];
    const grant = mock(async () => undefined);
    const executeToolDirect = mock(async () => ({ content: [], isError: false }));
    const service = createToolApprovalService({
      grantStore: { grant, hasGrant: mock(async () => false), revoke: mock(async () => undefined) },
      mcpProxy: { executeToolDirect },
      userAgentsStore: { ownsAgent: mock(async () => true) },
      organizationId: "org-1",
      resolveReleaseSnapshot: mock(async () => ({
        schemaVersion: 1 as const,
        environment: "production" as const,
        toolboxUserId: SEMANTIC_CLAIM.toolboxUserId,
        agentId: SEMANTIC_CLAIM.agentId,
        capabilities: [...SEMANTIC_CLAIM.capabilityIds],
        appliedReleaseId: SEMANTIC_CLAIM.releaseId,
        appliedReleaseSequence: SEMANTIC_CLAIM.releaseSequence,
        snapshotDigest: SEMANTIC_CLAIM.snapshotDigest,
        expiresAt: SEMANTIC_CLAIM.expiresAt,
      })),
      readReleaseState: mock(async () => ({ status: "active" as const, claim: SEMANTIC_CLAIM })),
      revalidateEligibility: mock(async () => eligibility.shift() ?? false),
    });
    expect(await service.submit({
      action: "approve_all",
      approvalId: "ta-toctou",
      toolboxUserId: "toolbox-user-1",
      lineUserId: "line-user-1",
      agentId: "shifu-u-1",
    })).toEqual({ status: "stale", diagnosticCode: "approval_inventory_stale" });
    expect(grant).not.toHaveBeenCalled();
    expect(executeToolDirect).not.toHaveBeenCalled();
  });

  test("rejects semantic approve_all after an expired original carrier is freshly renewed", async () => {
    const releaseState = {
      status: "active" as const,
      claim: {
        environment: "production" as const,
        toolboxUserId: "toolbox-user-1",
        agentId: "shifu-u-1",
        releaseId: "release-1",
        releaseSequence: 1,
        snapshotDigest: `sha256:${"a".repeat(64)}`,
        expiresAt: "2000-01-01T00:00:00.000Z",
        capabilityIds: ["semantic_tool_router.effective_inventory.v1"],
      },
    };
    await seedLinePending("ta-line-1", {
      releaseState,
      releaseBinding: {
        routerMode: "semantic",
        effectiveInventoryFingerprint: "b".repeat(64),
        releaseId: "release-1",
        releaseSequence: 1,
        snapshotDigest: releaseState.claim.snapshotDigest,
        authorizationExpiresAt: releaseState.claim.expiresAt,
        stableAuthorizationDigest: stableReleaseAuthorizationDigest(
          releaseState.claim
        ),
        eligibilityBindingDigest: stableToolEligibilityDigest({
          mcpId: LINE_PENDING.mcpId,
          toolName: LINE_PENDING.toolName,
          connectionId: LINE_PENDING.connectionId,
          effectiveInventoryFingerprint: "b".repeat(64),
          stableAuthorizationDigest: stableReleaseAuthorizationDigest(
            releaseState.claim
          ),
        }),
      },
    });
    const grantStore = {
      grant: mock(async () => undefined),
      hasGrant: mock(async () => false),
      revoke: mock(async () => undefined),
    };
    const mcpProxy = {
      executeToolDirect: mock(async () => ({ content: [], isError: false })),
      revalidatePendingToolEligibility: mock(async () => true),
    };
    const service = createToolApprovalService({
      grantStore,
      mcpProxy,
      userAgentsStore: { ownsAgent: mock(async () => true) },
      organizationId: "org-1",
      resolveReleaseSnapshot: mock(async () => ({
        schemaVersion: 1 as const,
        environment: "production" as const,
        toolboxUserId: "toolbox-user-1",
        agentId: "shifu-u-1",
        capabilities: [...releaseState.claim.capabilityIds],
        appliedReleaseId: "release-1",
        appliedReleaseSequence: 1,
        snapshotDigest: `sha256:${"c".repeat(64)}`,
        expiresAt: "2099-01-01T00:01:00.000Z",
      })),
      readReleaseState: mock(async () => ({
        status: "active" as const,
        claim: {
          ...releaseState.claim,
          snapshotDigest: `sha256:${"d".repeat(64)}`,
          expiresAt: "2099-01-01T00:00:30.000Z",
        },
      })),
    });

    expect(await submitApproveAll(service)).toEqual({
      status: "stale",
      diagnosticCode: "approval_inventory_stale",
    });
    expect(grantStore.grant).not.toHaveBeenCalled();
    expect(mcpProxy.executeToolDirect).not.toHaveBeenCalled();
  });

  test("approve_all stores a global wildcard grant and executes one pending MCP tool", async () => {
    await seedLinePending("ta-line-1");
    const { grantStore, mcpProxy, service } = setupService();

    const result = await submitApproveAll(service);

    expect(result.status).toBe("executed");
    expect(grantStore.grant).toHaveBeenCalledWith(
      "shifu-u-1",
      GLOBAL_TOOL_AUTO_APPROVAL_PATTERN,
      null,
      undefined,
      "org-1",
    );
    expect(mcpProxy.executeToolDirect).toHaveBeenCalledWith(
      "shifu-u-1",
      "toolbox-user-1",
      "google_workspace",
      "gws_calendar_events_create",
      { summary: "Demo" },
      { approvalReplay: true, channelId: "line-user-1", conversationId: "conv-1" },
    );
  });

  test("carries the discovery config identity through pending approval execution", async () => {
    const expectedMcpIdentity = {
      upstreamOrigin: "https://mcp.shifu-ai.org",
      configSource: "agent" as const,
      configDigest: "discovery-digest",
    };
    await seedLinePending("ta-line-1", { expectedMcpIdentity });
    const { mcpProxy, service } = setupService();

    const result = await submitApproveAll(service);

    expect(result.status).toBe("executed");
    expect(mcpProxy.executeToolDirect).toHaveBeenCalledWith(
      "shifu-u-1",
      "toolbox-user-1",
      "google_workspace",
      "gws_calendar_events_create",
      { summary: "Demo" },
      { approvalReplay: true, channelId: "line-user-1", conversationId: "conv-1", expectedMcpIdentity },
    );
  });

  test("mismatched agent does not consume the pending approval", async () => {
    await seedLinePending("ta-line-1");
    const { grantStore, mcpProxy, service } = setupService();

    const rejected = await submitApproveAll(service, {
      agentId: "shifu-u-wrong",
    });
    expect(rejected.status).toBe("forbidden");
    expect(grantStore.grant).not.toHaveBeenCalled();
    expect(mcpProxy.executeToolDirect).not.toHaveBeenCalled();

    const approved = await submitApproveAll(service);
    expect(approved.status).toBe("executed");
    expect(mcpProxy.executeToolDirect).toHaveBeenCalledTimes(1);
  });

  test("mismatched toolbox user does not consume the pending approval", async () => {
    await seedLinePending("ta-line-1");
    const { grantStore, mcpProxy, service } = setupService();

    const rejected = await submitApproveAll(service, {
      toolboxUserId: "toolbox-user-wrong",
    });
    expect(rejected.status).toBe("forbidden");
    expect(grantStore.grant).not.toHaveBeenCalled();
    expect(mcpProxy.executeToolDirect).not.toHaveBeenCalled();

    const approved = await submitApproveAll(service);
    expect(approved.status).toBe("executed");
    expect(mcpProxy.executeToolDirect).toHaveBeenCalledTimes(1);
  });

  test("non-owner toolbox user cannot consume the pending approval", async () => {
    const { service, userAgentsStore, mcpProxy } = setupService();
    userAgentsStore.ownsAgent = mock(async () => false);
    await seedLinePending("appr-owner-1");

    const result = await service.submit({
      approvalId: "appr-owner-1",
      action: "approve_once",
      toolboxUserId: "toolbox-user-1",
      lineUserId: "line-user-1",
      agentId: "shifu-u-1",
    });

    expect(result.status).toBe("forbidden");
    expect(mcpProxy.executeToolDirect).not.toHaveBeenCalled();
  });

  test("submit checks ownership through the toolbox platform", async () => {
    const { service, userAgentsStore } = setupService();
    await seedLinePending("appr-owner-2");

    await service.submit({
      approvalId: "appr-owner-2",
      action: "approve_once",
      toolboxUserId: "toolbox-user-1",
      lineUserId: "line-user-1",
      agentId: "shifu-u-1",
    });

    expect(userAgentsStore.ownsAgent).toHaveBeenCalledWith(
      "toolbox",
      "toolbox-user-1",
      "shifu-u-1",
      "org-1",
    );
  });

  test("approve_once executes the pending tool without writing any grant", async () => {
    await seedLinePending("ta-line-once-1");
    const { grantStore, mcpProxy, service } = setupService();

    const result = await service.submit({
      action: "approve_once",
      approvalId: "ta-line-once-1",
      toolboxUserId: "toolbox-user-1",
      lineUserId: "line-user-1",
      agentId: "shifu-u-1",
    });

    expect(result.status).toBe("executed");
    expect(grantStore.grant).not.toHaveBeenCalled();
    expect(mcpProxy.executeToolDirect).toHaveBeenCalledTimes(1);
    expect(mcpProxy.executeToolDirect).toHaveBeenCalledWith(
      "shifu-u-1",
      "toolbox-user-1",
      "google_workspace",
      "gws_calendar_events_create",
      { summary: "Demo" },
      { approvalReplay: true, channelId: "line-user-1", conversationId: "conv-1" },
    );
  });

  test.each([
    { status: "legacy_unenrolled" as const },
    {
      status: "enrolled_inactive" as const,
      environment: "production" as const,
      reason: "capability_expired" as const,
    },
  ])("ordinary approval replay remains available for release state %#", async (releaseState) => {
    const originalFetch = globalThis.fetch;
    const approvalId = `ordinary-release-${releaseState.status}`;
    await seedLinePending(approvalId, {
      organizationId: "org-1",
      releaseState,
      mcpId: "ordinary_mcp",
      toolName: "read_ordinary_data",
      args: {},
    });
    const proxy = new McpProxy(
      {
        getHttpServer: async () => ({
          id: "ordinary_mcp",
          upstreamUrl: "https://ordinary.test/mcp",
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
    globalThis.fetch = mock(async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (body.method === "initialize") {
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: { protocolVersion: "2025-03-26" },
        }), { headers: { "content-type": "application/json", "mcp-session-id": "replay-session" } });
      }
      if (body.method === "notifications/initialized") return new Response("", { status: 202 });
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: { content: [{ type: "text", text: "ordinary-replayed" }], isError: false },
      }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const service = createToolApprovalService({
        grantStore: {
          grant: mock(async () => undefined),
          hasGrant: mock(async () => false),
          revoke: mock(async () => undefined),
        },
        mcpProxy: proxy,
        userAgentsStore: { ownsAgent: mock(async () => true) },
        organizationId: "org-1",
      });
      const replay = await service.submit({
        action: "approve_once",
        approvalId,
        toolboxUserId: "toolbox-user-1",
        lineUserId: "line-user-1",
        agentId: "shifu-u-1",
      });
      expect(replay).toMatchObject({
        status: "executed",
        result: {
          content: [{ type: "text", text: "ordinary-replayed" }],
          isError: false,
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("internal approval replay re-signs a bounded RUN token without persisting a bearer", async () => {
    const originalRunIdentity = { runId: 73, deploymentName: "worker-original" };
    const releaseState = {
      status: "active" as const,
      claim: {
        environment: "production" as const,
        toolboxUserId: "toolbox-user-1",
        agentId: "shifu-u-1",
        releaseId: "release-original",
        releaseSequence: 3,
        snapshotDigest: `sha256:${"a".repeat(64)}`,
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
        capabilityIds: [
          "personal_reminder_delivery.v1",
          "semantic_tool_router.effective_inventory.v1",
        ],
      },
    };
    const stableAuthorizationDigest = stableReleaseAuthorizationDigest(releaseState.claim);
    await seedLinePending("ta-resign-run", {
      organizationId: "org-1",
      conversationId: "conv-1",
      channelId: "line-user-1",
      mcpId: "lobu-memory",
      toolName: "manage_schedules",
      args: { action: "list" },
      releaseState,
      releaseBinding: {
        routerMode: "legacy",
        effectiveInventoryFingerprint: "b".repeat(64),
        releaseId: releaseState.claim.releaseId,
        releaseSequence: releaseState.claim.releaseSequence,
        snapshotDigest: releaseState.claim.snapshotDigest,
        authorizationExpiresAt: releaseState.claim.expiresAt,
        stableAuthorizationDigest,
        eligibilityBindingDigest: stableToolEligibilityDigest({
          mcpId: "lobu-memory",
          toolName: "manage_schedules",
          connectionId: LINE_PENDING.connectionId,
          effectiveInventoryFingerprint: "b".repeat(64),
          stableAuthorizationDigest,
        }),
      },
      originalRunIdentity,
    });
    const stored = await getPendingTool("ta-resign-run");
    expect(JSON.stringify(stored)).not.toContain("Bearer");
    expect(JSON.stringify(stored)).not.toContain(process.env.ENCRYPTION_KEY ?? "never");

    let replayToken: string | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (_input, init) => {
      const headers = new Headers(init?.headers);
      replayToken = headers.get("authorization")?.replace(/^Bearer /, "");
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (body.method === "initialize") {
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: { protocolVersion: "2025-03-26" },
        }), { headers: { "content-type": "application/json", "mcp-session-id": "internal-replay" } });
      }
      if (body.method === "notifications/initialized") return new Response("", { status: 202 });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [], isError: false } }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const proxy = new McpProxy(
        {
          getHttpServer: async () => ({
            id: "lobu-memory",
            upstreamUrl: "https://internal.test/mcp/org-1",
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
      const service = createToolApprovalService({
        grantStore: {
          grant: mock(async () => undefined),
          hasGrant: mock(async () => false),
          revoke: mock(async () => undefined),
        },
        mcpProxy: proxy,
        userAgentsStore: { ownsAgent: mock(async () => true) },
        organizationId: "org-1",
        resolveReleaseSnapshot: mock(async () => ({
          schemaVersion: 1 as const,
          environment: "production" as const,
          toolboxUserId: "toolbox-user-1",
          agentId: "shifu-u-1",
          capabilities: [...releaseState.claim.capabilityIds],
          appliedReleaseId: releaseState.claim.releaseId,
          appliedReleaseSequence: releaseState.claim.releaseSequence,
          snapshotDigest: releaseState.claim.snapshotDigest,
          expiresAt: releaseState.claim.expiresAt,
        })),
        readReleaseState: mock(async () => releaseState),
        revalidateEligibility: mock(async () => true),
      });
      expect(await service.submit({
        action: "approve_once",
        approvalId: "ta-resign-run",
        toolboxUserId: "toolbox-user-1",
        lineUserId: "line-user-1",
        agentId: "shifu-u-1",
      })).toMatchObject({ status: "executed", result: { isError: false } });
      expect(replayToken).toBeTruthy();
      expect(verifyWorkerToken(replayToken!)).toMatchObject({
        tokenKind: "run",
        runId: 73,
        userId: "toolbox-user-1",
        agentId: "shifu-u-1",
        organizationId: "org-1",
        conversationId: "conv-1",
        releaseState,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("approval blocking stores bounded original RUN identity but never the bearer", async () => {
    const releaseState = {
      status: "active" as const,
      claim: {
        environment: "production" as const,
        toolboxUserId: "toolbox-user-1",
        agentId: "shifu-u-1",
        releaseId: "release-original",
        releaseSequence: 3,
        snapshotDigest: `sha256:${"a".repeat(64)}`,
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
        capabilityIds: ["personal_reminder_delivery.v1"],
      },
    };
    const workerToken = generateWorkerToken(
      "toolbox-user-1",
      "conv-1",
      "worker-original",
      {
        channelId: "line-user-1",
        agentId: "shifu-u-1",
        organizationId: "org-1",
        runId: 73,
        tokenKind: "run",
        releaseState,
      },
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (body.method === "initialize") {
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: { protocolVersion: "2025-03-26" },
        }), { headers: { "content-type": "application/json", "mcp-session-id": "block-session" } });
      }
      if (body.method === "notifications/initialized") return new Response("", { status: 202 });
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          tools: [{ name: "manage_schedules", annotations: { destructiveHint: true } }],
        },
      }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    let approvalId = "";
    try {
      const proxy = new McpProxy(
        {
          getHttpServer: async () => ({
            id: "lobu-memory",
            upstreamUrl: "https://internal.test/mcp/org-1",
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
          grantStore: {
            grant: mock(async () => undefined),
            hasGrant: mock(async () => false),
            revoke: mock(async () => undefined),
          },
        },
      );
      proxy.onToolBlocked = async (requestId) => {
        approvalId = requestId;
      };
      expect(await orgContext.run({ organizationId: "org-1" }, () =>
        proxy.callToolWithApproval(
          "shifu-u-1",
          "toolbox-user-1",
          "lobu-memory",
          "manage_schedules",
          { action: "list" },
          {
            token: workerToken,
            channelId: "line-user-1",
            conversationId: "conv-1",
            organizationId: "org-1",
            personalReminderDeliveryIntent: true,
            effectiveToolRouterMode: "shadow",
            effectiveToolInventoryFingerprint: "b".repeat(64),
          },
        ),
      )).toMatchObject({ status: "blocked-notified" });
      const pending = await getPendingTool(approvalId);
      expect(pending).toMatchObject({
        originalRunIdentity: { runId: 73, deploymentName: "worker-original" },
        releaseState,
        releaseBinding: {
          routerMode: "shadow",
          effectiveInventoryFingerprint: "b".repeat(64),
        },
        personalReminderDeliveryIntent: true,
      });
      expect(JSON.stringify(pending)).not.toContain(workerToken);
      expect(JSON.stringify(pending)).not.toContain("Bearer");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("durable legacy approval replay preserves course scope and denies meeting_search before execution upstream", async () => {
    const fetchCalls: string[] = [];
    globalThis.fetch = mock(async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      fetchCalls.push(body.method);
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result:
            body.method === "tools/list"
              ? {
                  tools: [
                    {
                      name: "meeting_search",
                      annotations: { destructiveHint: true },
                    },
                  ],
                }
              : {},
        }),
        { headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const grantStore = {
      grant: mock(async () => undefined),
      hasGrant: mock(async () => false),
      revoke: mock(async () => undefined),
    };
    let approvalId = "";
    const proxy = new McpProxy(
      {
        getHttpServer: async () => ({
          id: "shifu_toolbox",
          upstreamUrl: "https://toolbox.test/mcp",
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
        grantStore,
        onToolBlocked: async (requestId) => {
          approvalId = requestId;
        },
      },
    );
    const courseToolScope = {
      ownerUserId: "toolbox-user-1",
      agentId: "shifu-u-1",
      courseEntityId: "course:toolbox-user-1:a",
    };
    const blocked = await proxy.callToolWithApproval(
      "shifu-u-1",
      "toolbox-user-1",
      "shifu_toolbox",
      "meeting_search",
      { query: "weekly" },
      {
        token: "verified-run-token",
        channelId: "line-user-1",
        conversationId: "conv-1",
        organizationId: "org-1",
        courseToolScope,
      },
    );
    expect(blocked).toMatchObject({
      status: "executed",
      isError: true,
      diagnosticCode: "COURSE_MEETING_SCOPE_UNAVAILABLE",
    });
    expect(approvalId).toBe("");
    expect(fetchCalls).toHaveLength(0);

    approvalId = "ta-legacy-course-meeting";
    await storePendingTool(
      approvalId,
      {
        agentId: "shifu-u-1",
        userId: "toolbox-user-1",
        mcpId: "shifu_toolbox",
        toolName: "meeting_search",
        args: { query: "weekly" },
        channelId: "line-user-1",
        conversationId: "conv-1",
        courseToolScope,
      },
      60,
    );
    courseToolScope.courseEntityId = "mutated-after-persist";
    const serialized = await getPendingTool(approvalId);
    expect(serialized?.courseToolScope).toEqual({
      ownerUserId: "toolbox-user-1",
      agentId: "shifu-u-1",
      courseEntityId: "course:toolbox-user-1:a",
    });
    expect(serialized?.courseToolScope).not.toBe(courseToolScope);

    fetchCalls.length = 0;
    const service = createToolApprovalService({
      grantStore,
      mcpProxy: proxy,
      userAgentsStore: { ownsAgent: mock(async () => true) },
      organizationId: "org-1",
    });
    const replay = await service.submit({
      action: "approve_once",
      approvalId,
      toolboxUserId: "toolbox-user-1",
      lineUserId: "line-user-1",
      agentId: "shifu-u-1",
    });
    expect(replay).toMatchObject({
      status: "executed",
      result: {
        isError: true,
        diagnosticCode: "COURSE_MEETING_SCOPE_UNAVAILABLE",
      },
    });
    expect(fetchCalls).toHaveLength(0);
  });

  test("executes the approved tool inside the organization context", async () => {
    await seedLinePending("ta-line-1");
    const grantStore = {
      grant: mock(async () => undefined),
      hasGrant: mock(async () => false),
    };
    const mcpProxy = {
      executeToolDirect: mock(async () => ({
        content: [{ type: "text", text: tryGetOrgId() ?? "missing-org" }],
        isError: false,
      })),
    };
    const service = createToolApprovalService({
      grantStore,
      mcpProxy,
      userAgentsStore: {
        ownsAgent: mock(async () => true),
      },
      organizationId: "org-1",
    });

    const result = await submitApproveAll(service);

    expect(result.status).toBe("executed");
    expect(result.status === "executed" && result.result.content[0]?.text).toBe(
      "org-1",
    );
  });

  test("revokes the global auto-approval grant inside the organization", async () => {
    const grantStore = {
      grant: mock(async () => undefined),
      hasGrant: mock(async () => true),
      revoke: mock(async () => undefined),
    };
    const mcpProxy = {
      executeToolDirect: mock(async () => ({
        content: [{ type: "text", text: "created" }],
        isError: false,
      })),
    };
    const service = createToolApprovalService({
      grantStore,
      mcpProxy,
      userAgentsStore: {
        ownsAgent: mock(async () => true),
      },
      organizationId: "org-1",
    });

    const result = await service.revokeGlobal({
      toolboxUserId: "toolbox-user-1",
      lineUserId: "line-user-1",
      agentId: "shifu-u-1",
    });

    expect(result).toEqual({ status: "revoked" });
    expect(grantStore.revoke).toHaveBeenCalledWith(
      "shifu-u-1",
      GLOBAL_TOOL_AUTO_APPROVAL_PATTERN,
      "org-1",
    );
  });

  test("wrong toolbox user cannot revoke global auto-approval", async () => {
    const grantStore = {
      grant: mock(async () => undefined),
      hasGrant: mock(async () => true),
      revoke: mock(async () => undefined),
    };
    const mcpProxy = {
      executeToolDirect: mock(async () => ({
        content: [{ type: "text", text: "created" }],
        isError: false,
      })),
    };
    const userAgentsStore = {
      ownsAgent: mock(async () => false),
    };
    const service = createToolApprovalService({
      grantStore,
      mcpProxy,
      userAgentsStore,
      organizationId: "org-1",
    });

    const result = await service.revokeGlobal({
      toolboxUserId: "toolbox-user-wrong",
      lineUserId: "line-user-1",
      agentId: "shifu-u-1",
    });

    expect(result).toEqual({ status: "forbidden" });
    expect(userAgentsStore.ownsAgent).toHaveBeenCalledWith(
      "toolbox",
      "toolbox-user-wrong",
      "shifu-u-1",
      "org-1",
    );
    expect(grantStore.revoke).not.toHaveBeenCalled();
  });

  test("returns whether global auto-approval is enabled", async () => {
    const grantStore = {
      grant: mock(async () => undefined),
      hasGrant: mock(async () => true),
      revoke: mock(async () => undefined),
    };
    const mcpProxy = {
      executeToolDirect: mock(async () => ({
        content: [{ type: "text", text: "created" }],
        isError: false,
      })),
    };
    const service = createToolApprovalService({
      grantStore,
      mcpProxy,
      userAgentsStore: {
        ownsAgent: mock(async () => true),
      },
      organizationId: "org-1",
    });

    const result = await service.getGlobalStatus({
      toolboxUserId: "toolbox-user-1",
      agentId: "shifu-u-1",
    });

    expect(result).toEqual({ enabled: true });
    expect(grantStore.hasGrant).toHaveBeenCalledWith(
      "shifu-u-1",
      GLOBAL_TOOL_AUTO_APPROVAL_PATTERN,
      "org-1",
    );
  });

  test("wrong toolbox user cannot read global auto-approval status", async () => {
    const grantStore = {
      grant: mock(async () => undefined),
      hasGrant: mock(async () => true),
      revoke: mock(async () => undefined),
    };
    const mcpProxy = {
      executeToolDirect: mock(async () => ({
        content: [{ type: "text", text: "created" }],
        isError: false,
      })),
    };
    const userAgentsStore = {
      ownsAgent: mock(async () => false),
    };
    const service = createToolApprovalService({
      grantStore,
      mcpProxy,
      userAgentsStore,
      organizationId: "org-1",
    });

    const result = await service.getGlobalStatus({
      toolboxUserId: "toolbox-user-wrong",
      agentId: "shifu-u-1",
    });

    expect(result).toEqual({ status: "forbidden" });
    expect(userAgentsStore.ownsAgent).toHaveBeenCalledWith(
      "toolbox",
      "toolbox-user-wrong",
      "shifu-u-1",
      "org-1",
    );
    expect(grantStore.hasGrant).not.toHaveBeenCalled();
  });
});
