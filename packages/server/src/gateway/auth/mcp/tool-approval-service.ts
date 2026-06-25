import { getPendingTool, takePendingTool } from "./pending-tool-store.js";
import {
  GLOBAL_TOOL_AUTO_APPROVAL_PATTERN,
  type GrantStore,
} from "../../permissions/grant-store.js";
import { orgContext } from "../../../lobu/stores/org-context.js";

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
  | { status: "forbidden" }
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
      const candidate = await getPendingTool(input.approvalId);
      if (!candidate) {
        return { status: "expired" };
      }

      if (
        candidate.agentId !== input.agentId ||
        candidate.userId !== input.toolboxUserId ||
        !candidate.channelId ||
        candidate.channelId !== input.lineUserId
      ) {
        return { status: "forbidden" };
      }

      const pending = await takePendingTool(input.approvalId);
      if (
        !pending ||
        pending.agentId !== candidate.agentId ||
        pending.userId !== candidate.userId ||
        pending.channelId !== candidate.channelId
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

      const execute = () =>
        deps.mcpProxy.executeToolDirect(
          pending.agentId,
          pending.userId,
          pending.mcpId,
          pending.toolName,
          pending.args
        );
      const result = deps.organizationId
        ? await orgContext.run({ organizationId: deps.organizationId }, execute)
        : await execute();
      return { status: "executed", result };
    },
  };
}
