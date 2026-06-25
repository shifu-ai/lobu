import { takePendingTool } from "./pending-tool-store.js";
import {
  GLOBAL_TOOL_AUTO_APPROVAL_PATTERN,
  type GrantStore,
} from "../../permissions/grant-store.js";

export { GLOBAL_TOOL_AUTO_APPROVAL_PATTERN };

export type ToolApprovalAction = "approve_once" | "approve_all" | "deny";

export interface ToolApprovalSubmitInput {
  action: ToolApprovalAction;
  approvalId: string;
  toolboxUserId: string;
  lineUserId: string;
  agentId: string;
}

export type ToolApprovalSubmitResult =
  | { status: "expired" }
  | { status: "denied" }
  | {
      status: "executed";
      result: {
        content: Array<{ type: string; text: string }>;
        isError: boolean;
        diagnosticCode?: string;
      };
    };

interface McpProxyDirectExecution {
  executeToolDirect(
    agentId: string,
    userId: string,
    mcpId: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<{
    content: Array<{ type: string; text: string }>;
    isError: boolean;
    diagnosticCode?: string;
  }>;
}

export interface ToolApprovalServiceDeps {
  grantStore: Pick<GrantStore, "grant" | "hasGrant">;
  mcpProxy: McpProxyDirectExecution;
  organizationId?: string;
}

export function createToolApprovalService(deps: ToolApprovalServiceDeps) {
  return {
    async submit(
      input: ToolApprovalSubmitInput
    ): Promise<ToolApprovalSubmitResult> {
      const pending = await takePendingTool(input.approvalId);
      if (
        !pending ||
        pending.agentId !== input.agentId ||
        pending.userId !== input.toolboxUserId
      ) {
        return { status: "expired" };
      }

      const specificPattern = `/mcp/${pending.mcpId}/tools/${pending.toolName}`;

      if (input.action === "deny") {
        await deps.grantStore.grant(
          pending.agentId,
          specificPattern,
          null,
          true,
          deps.organizationId
        );
        return { status: "denied" };
      }

      const pattern =
        input.action === "approve_all"
          ? GLOBAL_TOOL_AUTO_APPROVAL_PATTERN
          : specificPattern;
      await deps.grantStore.grant(
        pending.agentId,
        pattern,
        null,
        undefined,
        deps.organizationId
      );

      const result = await deps.mcpProxy.executeToolDirect(
        pending.agentId,
        pending.userId,
        pending.mcpId,
        pending.toolName,
        pending.args
      );
      return { status: "executed", result };
    },
  };
}
