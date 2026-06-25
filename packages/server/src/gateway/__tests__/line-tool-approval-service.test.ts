import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { storePendingTool } from "../auth/mcp/pending-tool-store.js";
import {
  createToolApprovalService,
  GLOBAL_TOOL_AUTO_APPROVAL_PATTERN,
} from "../auth/mcp/tool-approval-service.js";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
} from "./helpers/db-setup.js";

describe("createToolApprovalService", () => {
  beforeAll(async () => {
    await ensureDbForGatewayTests();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  test("approve_all stores a global wildcard grant and executes one pending MCP tool", async () => {
    await storePendingTool(
      "ta-line-1",
      {
        agentId: "shifu-u-1",
        userId: "toolbox-user-1",
        mcpId: "google_workspace",
        toolName: "gws_calendar_events_create",
        args: { summary: "Demo" },
        conversationId: "conv-1",
        channelId: "line-user-1",
        connectionId: "line-connection",
      },
      60
    );

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
    const service = createToolApprovalService({
      grantStore,
      mcpProxy,
      organizationId: "org-1",
    });

    const result = await service.submit({
      action: "approve_all",
      approvalId: "ta-line-1",
      toolboxUserId: "toolbox-user-1",
      lineUserId: "line-user-1",
      agentId: "shifu-u-1",
    });

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
});
