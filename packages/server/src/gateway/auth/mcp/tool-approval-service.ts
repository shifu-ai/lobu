import { getPendingTool, takePendingTool } from "./pending-tool-store.js";
import {
  GLOBAL_TOOL_AUTO_APPROVAL_PATTERN,
  type GrantStore,
} from "../../permissions/grant-store.js";
import { orgContext } from "../../../lobu/stores/org-context.js";
import type { UserAgentsStore } from "../user-agents-store.js";

export { GLOBAL_TOOL_AUTO_APPROVAL_PATTERN };

export type ToolApprovalAction = "approve_once" | "approve_all" | "deny";

export interface ToolApprovalSubmitInput {
  action: ToolApprovalAction;
  approvalId: string;
  toolboxUserId: string;
  lineUserId: string;
  agentId: string;
  organizationId?: string;
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

export interface ToolApprovalRevokeGlobalInput {
  toolboxUserId: string;
  lineUserId: string;
  agentId: string;
  organizationId?: string;
}

export interface ToolApprovalGlobalStatusInput {
  toolboxUserId: string;
  agentId: string;
  organizationId?: string;
}

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
  grantStore: Pick<GrantStore, "grant" | "hasGrant" | "revoke">;
  mcpProxy: McpProxyDirectExecution;
  userAgentsStore?: Pick<UserAgentsStore, "ownsAgent">;
  organizationId?: string;
}

function organizationIdFor(
  input: { organizationId?: string },
  fallback?: string
): string | undefined {
  return input.organizationId ?? fallback;
}

export function createToolApprovalService(deps: ToolApprovalServiceDeps) {
  const ownsToolboxAgent = async (input: {
    toolboxUserId: string;
    agentId: string;
    organizationId?: string;
  }): Promise<boolean> => {
    if (!deps.userAgentsStore) return false;
    return deps.userAgentsStore.ownsAgent(
      "toolbox",
      input.toolboxUserId,
      input.agentId,
      organizationIdFor(input, deps.organizationId)
    );
  };

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
      const organizationId = organizationIdFor(input, deps.organizationId);

      if (input.action === "deny") {
        await deps.grantStore.grant(
          pending.agentId,
          specificPattern,
          null,
          true,
          organizationId
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
        organizationId
      );

      const execute = () =>
        deps.mcpProxy.executeToolDirect(
          pending.agentId,
          pending.userId,
          pending.mcpId,
          pending.toolName,
          pending.args
        );
      const result = organizationId
        ? await orgContext.run({ organizationId }, execute)
        : await execute();
      return { status: "executed", result };
    },

    async revokeGlobal(
      input: ToolApprovalRevokeGlobalInput
    ): Promise<{ status: "revoked" } | { status: "forbidden" }> {
      if (!(await ownsToolboxAgent(input))) {
        return { status: "forbidden" };
      }

      await deps.grantStore.revoke(
        input.agentId,
        GLOBAL_TOOL_AUTO_APPROVAL_PATTERN,
        organizationIdFor(input, deps.organizationId)
      );
      return { status: "revoked" };
    },

    async getGlobalStatus(
      input: ToolApprovalGlobalStatusInput
    ): Promise<{ enabled: boolean } | { status: "forbidden" }> {
      if (!(await ownsToolboxAgent(input))) {
        return { status: "forbidden" };
      }

      const enabled = await deps.grantStore.hasGrant(
        input.agentId,
        GLOBAL_TOOL_AUTO_APPROVAL_PATTERN,
        organizationIdFor(input, deps.organizationId)
      );
      return { enabled };
    },
  };
}
