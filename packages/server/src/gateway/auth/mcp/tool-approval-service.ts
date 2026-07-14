import { orgContext } from "../../../lobu/stores/org-context.js";
import type { TrustedCourseToolScope } from "../../orchestration/course-tool-policy.js";
import {
  GLOBAL_TOOL_AUTO_APPROVAL_PATTERN,
  type GrantStore,
} from "../../permissions/grant-store.js";
import type { UserAgentsStore } from "../user-agents-store.js";
import { readAgentReleaseCapabilityState } from "../../../lobu/agent-release-service.js";
import { resolveRuntimeCapabilitySnapshot } from "../../services/runtime-capability-snapshot.js";
import type { ReleaseCapabilityState } from "@lobu/core";
import {
	buildPendingToolExecutionOptions,
	getPendingTool,
	takePendingTool,
	stableReleaseAuthorizationDigest,
	stableToolEligibilityDigest,
} from "./pending-tool-store.js";

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
  | { status: "stale"; diagnosticCode: "approval_inventory_stale" }
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
  revalidatePendingToolEligibility?(
    pending: import("./pending-tool-store.js").PendingToolInvocation,
  ): Promise<boolean>;
  executeToolDirect(
    agentId: string,
    userId: string,
    mcpId: string,
    toolName: string,
    args: Record<string, unknown>,
    options?: {
      courseToolScope?: TrustedCourseToolScope;
      expectedMcpIdentity?: {
        upstreamOrigin: string;
        configSource: "global" | "agent" | "derived";
        configDigest: string;
      };
      channelId?: string;
      organizationId?: string;
			releaseState?: import("@lobu/core").ReleaseCapabilityState;
			approvalReplay?: true;
			originalRunIdentity?: { runId: number; deploymentName: string };
			conversationId?: string;
			personalReminderDeliveryIntent?: true;
    },
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
  resolveReleaseSnapshot?: typeof resolveRuntimeCapabilitySnapshot;
  readReleaseState?: typeof readAgentReleaseCapabilityState;
  revalidateEligibility?: (
    pending: import("./pending-tool-store.js").PendingToolInvocation,
  ) => Promise<boolean>;
}

export function isPendingReleaseBindingCurrent(
  pending: import("./pending-tool-store.js").PendingToolInvocation,
  current: ReleaseCapabilityState,
  now = new Date(),
): boolean {
  const binding = pending.releaseBinding;
  if (!binding || current.status !== "active") return false;
  return Date.parse(binding.authorizationExpiresAt) > now.getTime() &&
    Date.parse(current.claim.expiresAt) > now.getTime() &&
    current.claim.agentId === pending.agentId &&
    current.claim.toolboxUserId === pending.userId &&
    current.claim.releaseId === binding.releaseId &&
    current.claim.releaseSequence === binding.releaseSequence &&
    stableReleaseAuthorizationDigest(current.claim) ===
      binding.stableAuthorizationDigest &&
    current.claim.capabilityIds.includes(
      "semantic_tool_router.effective_inventory.v1",
    );
}

async function revalidateReleaseBinding(
  pending: import("./pending-tool-store.js").PendingToolInvocation,
  organizationId: string,
  deps: Pick<
    ToolApprovalServiceDeps,
    "resolveReleaseSnapshot" | "readReleaseState"
  > = {},
): Promise<boolean> {
  const binding = pending.releaseBinding;
  const state = pending.releaseState;
  if (!binding) return true;
  if (state?.status !== "active") return false;
  const claim = state.claim;
  if (
    Date.parse(binding.authorizationExpiresAt) <= Date.now() ||
    claim.agentId !== pending.agentId ||
    claim.toolboxUserId !== pending.userId ||
    claim.releaseId !== binding.releaseId ||
    claim.releaseSequence !== binding.releaseSequence ||
    claim.snapshotDigest !== binding.snapshotDigest ||
    claim.expiresAt !== binding.authorizationExpiresAt ||
    stableReleaseAuthorizationDigest(claim) !==
      binding.stableAuthorizationDigest ||
    stableToolEligibilityDigest({
      mcpId: pending.mcpId,
      toolName: pending.toolName,
      connectionId: pending.connectionId,
      expectedMcpIdentity: pending.expectedMcpIdentity,
      courseToolScope: pending.courseToolScope,
      effectiveInventoryFingerprint: binding.effectiveInventoryFingerprint,
      stableAuthorizationDigest: binding.stableAuthorizationDigest,
    }) !== binding.eligibilityBindingDigest ||
    !claim.capabilityIds.includes(
      "semantic_tool_router.effective_inventory.v1",
    )
  ) return false;
  const snapshot = await (
    deps.resolveReleaseSnapshot ?? resolveRuntimeCapabilitySnapshot
  )(
    {
      environment: claim.environment,
      toolboxUserId: claim.toolboxUserId,
      agentId: claim.agentId,
    },
    { bypassCache: true },
  );
  const current = await (
    deps.readReleaseState ?? readAgentReleaseCapabilityState
  )({
    organizationId,
    agentId: pending.agentId,
    environment: claim.environment,
    snapshot,
  });
  return isPendingReleaseBindingCurrent(
    pending,
    current as ReleaseCapabilityState,
  );
}

export async function validatePendingToolContinuation(
  pending: import("./pending-tool-store.js").PendingToolInvocation,
  organizationId: string,
  deps: Partial<Pick<
    ToolApprovalServiceDeps,
    "resolveReleaseSnapshot" | "readReleaseState" | "revalidateEligibility" | "mcpProxy"
  >> = {},
): Promise<{ valid: true } | { valid: false; diagnosticCode: "approval_inventory_stale" }> {
  if (!pending.releaseBinding) return { valid: true };
  const valid = await revalidateReleaseBinding(
    pending,
    organizationId,
    deps,
  ).catch(() => false);
  const eligible = valid
    ? await (
        deps.revalidateEligibility ??
        deps.mcpProxy?.revalidatePendingToolEligibility?.bind(deps.mcpProxy)
      )?.(pending).catch(() => false)
    : false;
  return valid && eligible === true
    ? { valid: true }
    : { valid: false, diagnosticCode: "approval_inventory_stale" };
}

function organizationIdFor(
  input: { organizationId?: string },
  fallback?: string,
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
      organizationIdFor(input, deps.organizationId),
    );
  };

  return {
    async submit(
      input: ToolApprovalSubmitInput,
    ): Promise<ToolApprovalSubmitResult> {
      const candidate = await getPendingTool(input.approvalId);
      if (!candidate) {
        return { status: "expired" };
      }

      if (
        candidate.agentId !== input.agentId ||
        candidate.userId !== input.toolboxUserId ||
        !(await ownsToolboxAgent(input))
      ) {
        return { status: "forbidden" };
      }

      if (candidate.releaseBinding) {
        const organizationId = organizationIdFor(input, deps.organizationId);
        if (!organizationId) return { status: "forbidden" };
        const validation = await validatePendingToolContinuation(
          candidate,
          organizationId,
          deps,
        );
        if (!validation.valid) {
          await takePendingTool(input.approvalId);
          return {
            status: "stale",
            diagnosticCode: "approval_inventory_stale",
          };
        }
      }

      const pending = await takePendingTool(input.approvalId);
      if (
        !pending ||
        pending.agentId !== candidate.agentId ||
        pending.userId !== candidate.userId
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
          organizationId,
        );
        return { status: "denied" };
      }

      if (input.action === "approve_all") {
        await deps.grantStore.grant(
          pending.agentId,
          GLOBAL_TOOL_AUTO_APPROVAL_PATTERN,
          null,
          undefined,
          organizationId,
        );
      }

      const execute = () => {
        const options = buildPendingToolExecutionOptions(pending);
        return options
          ? deps.mcpProxy.executeToolDirect(
              pending.agentId,
              pending.userId,
              pending.mcpId,
              pending.toolName,
              pending.args,
              options,
            )
          : deps.mcpProxy.executeToolDirect(
              pending.agentId,
              pending.userId,
              pending.mcpId,
              pending.toolName,
              pending.args,
            );
      };
      const result = organizationId
        ? await orgContext.run({ organizationId }, execute)
        : await execute();
      return { status: "executed", result };
    },

    async revokeGlobal(
      input: ToolApprovalRevokeGlobalInput,
    ): Promise<{ status: "revoked" } | { status: "forbidden" }> {
      if (!(await ownsToolboxAgent(input))) {
        return { status: "forbidden" };
      }

      await deps.grantStore.revoke(
        input.agentId,
        GLOBAL_TOOL_AUTO_APPROVAL_PATTERN,
        organizationIdFor(input, deps.organizationId),
      );
      return { status: "revoked" };
    },

    async getGlobalStatus(
      input: ToolApprovalGlobalStatusInput,
    ): Promise<{ enabled: boolean } | { status: "forbidden" }> {
      if (!(await ownsToolboxAgent(input))) {
        return { status: "forbidden" };
      }

      const enabled = await deps.grantStore.hasGrant(
        input.agentId,
        GLOBAL_TOOL_AUTO_APPROVAL_PATTERN,
        organizationIdFor(input, deps.organizationId),
      );
      return { enabled };
    },
  };
}
