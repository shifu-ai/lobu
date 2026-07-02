import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import {
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
