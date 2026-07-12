import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  getPendingTool,
  storePendingTool,
  type PendingToolInvocation,
} from "../auth/mcp/pending-tool-store.js";
import { tryGetOrgId } from "../../lobu/stores/org-context.js";
import {
  createToolApprovalService,
  GLOBAL_TOOL_AUTO_APPROVAL_PATTERN,
} from "../auth/mcp/tool-approval-service.js";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
} from "./helpers/db-setup.js";
import { McpProxy } from "../auth/mcp/proxy.js";

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

async function seedLinePending(
  approvalId: string,
  overrides: Partial<PendingToolInvocation> = {}
): Promise<void> {
  await storePendingTool(
    approvalId,
    {
      ...LINE_PENDING,
      ...overrides,
    },
    60
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
  }> = {}
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
      "org-1"
    );
    expect(mcpProxy.executeToolDirect).toHaveBeenCalledWith(
      "shifu-u-1",
      "toolbox-user-1",
      "google_workspace",
      "gws_calendar_events_create",
      { summary: "Demo" }
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
      "org-1"
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
      { summary: "Demo" }
    );
  });

  test("durable legacy approval replay preserves course scope and denies meeting_search before execution upstream", async () => {
    const fetchCalls: string[] = [];
    globalThis.fetch = mock(async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      fetchCalls.push(body.method);
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: body.method === "tools/list"
          ? { tools: [{ name: "meeting_search", annotations: { destructiveHint: true } }] }
          : {},
      }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const grantStore = {
      grant: mock(async () => undefined),
      hasGrant: mock(async () => false),
      revoke: mock(async () => undefined),
    };
    let approvalId = "";
    const proxy = new McpProxy({
      getHttpServer: async () => ({ id: "shifu_toolbox", upstreamUrl: "https://toolbox.test/mcp", internal: true }),
      getAllHttpServers: async () => new Map(),
    }, {
      secretStore: {
        get: async () => null,
        put: async () => "secret://test" as const,
        delete: async () => undefined,
        list: async () => [],
      },
      grantStore,
      onToolBlocked: async (requestId) => { approvalId = requestId; },
    });
    const courseToolScope = { ownerUserId: "toolbox-user-1", agentId: "shifu-u-1", courseEntityId: "course:toolbox-user-1:a" };
    const blocked = await proxy.callToolWithApproval(
      "shifu-u-1", "toolbox-user-1", "shifu_toolbox", "meeting_search", { query: "weekly" },
      { token: "verified-run-token", channelId: "line-user-1", conversationId: "conv-1", organizationId: "org-1", courseToolScope },
    );
    expect(blocked).toMatchObject({ status: "executed", isError: true, diagnosticCode: "COURSE_MEETING_SCOPE_UNAVAILABLE" });
    expect(approvalId).toBe("");
    expect(fetchCalls).toHaveLength(0);

    approvalId = "ta-legacy-course-meeting";
    await storePendingTool(approvalId, {
      agentId: "shifu-u-1", userId: "toolbox-user-1", mcpId: "shifu_toolbox", toolName: "meeting_search",
      args: { query: "weekly" }, channelId: "line-user-1", conversationId: "conv-1", courseToolScope,
    }, 60);
    courseToolScope.courseEntityId = "mutated-after-persist";
    const serialized = await getPendingTool(approvalId);
    expect(serialized?.courseToolScope).toEqual({ ownerUserId: "toolbox-user-1", agentId: "shifu-u-1", courseEntityId: "course:toolbox-user-1:a" });
    expect(serialized?.courseToolScope).not.toBe(courseToolScope);

    fetchCalls.length = 0;
    const service = createToolApprovalService({
      grantStore,
      mcpProxy: proxy,
      userAgentsStore: { ownsAgent: mock(async () => true) },
      organizationId: "org-1",
    });
    const replay = await service.submit({
      action: "approve_once", approvalId, toolboxUserId: "toolbox-user-1", lineUserId: "line-user-1", agentId: "shifu-u-1",
    });
    expect(replay).toMatchObject({ status: "executed", result: { isError: true, diagnosticCode: "COURSE_MEETING_SCOPE_UNAVAILABLE" } });
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
      "org-1"
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
      "org-1"
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
      "org-1"
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
      "org-1"
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
      "org-1"
    );
    expect(grantStore.hasGrant).not.toHaveBeenCalled();
  });
});
