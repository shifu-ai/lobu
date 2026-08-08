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
	pendingToolContinuationDigest,
	takePendingToolIfUnchanged,
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
      approvalReplayAuthorization?: {
        revalidate(): Promise<boolean>;
        onExecutionCompleted?(): Promise<void>;
      };
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
  // 刻意不看 binding.authorizationExpiresAt：它等於發卡當時那份 snapshot 的
  // expiresAt，最多是發卡時間 +60 秒（Toolbox SNAPSHOT_TTL_MS）。拿它當閘門等於
  // 要求使用者在 60 秒內讀完卡片並點按，而卡片本身送達就常吃掉 40 秒。
  // 人類的思考時限改由 pending 紀錄自己的 TTL 決定（oauth_states.expires_at，
  // 見 proxy.ts 的 PENDING_TOOL_TTL）；過期會走 "expired" 而不是 "stale"。
  //
  // 活性由「重新簽發的授權現在是否有效」把關，也就是下面這行。
  return Date.parse(current.claim.expiresAt) > now.getTime() &&
    current.claim.agentId === pending.agentId &&
    current.claim.toolboxUserId === pending.userId &&
    current.claim.releaseId === binding.releaseId &&
    current.claim.releaseSequence === binding.releaseSequence &&
    stableReleaseAuthorizationDigest(current.claim) ===
      binding.stableAuthorizationDigest;
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
  // 下面這串是對「存下來的 pending 紀錄」做完整性比對（欄位彼此自洽、沒被動過），
  // 不含到期判斷：`binding.authorizationExpiresAt` 與 `claim.expiresAt` 都是發卡當時
  // 那份 60 秒 snapshot 的到期時間，拿它們擋等於把人類的思考時間限成 60 秒。
  // 真正的活性由稍後 isPendingReleaseBindingCurrent 對「重新簽發的 claim」把關。
  if (
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
    }) !== binding.eligibilityBindingDigest
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
  if (!pending.releaseBinding) {
    return pending.releaseState?.status === "active"
      ? { valid: false, diagnosticCode: "approval_inventory_stale" }
      : { valid: true };
  }
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
      const candidateDigest = pendingToolContinuationDigest(candidate);

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
          await takePendingToolIfUnchanged(
            input.approvalId,
            candidate,
            candidateDigest,
          );
          return {
            status: "stale",
            diagnosticCode: "approval_inventory_stale",
          };
        }
      }

      const pending = await takePendingToolIfUnchanged(
        input.approvalId,
        candidate,
        candidateDigest,
      );
      if (
        !pending ||
        pending.agentId !== candidate.agentId ||
        pending.userId !== candidate.userId
      ) {
        return { status: "expired" };
      }

      // The atomic claim closes duplicate execution, but external authority can
      // change between the first validation and the side-effect boundary.
      if (pending.releaseBinding || pending.releaseState?.status === "active") {
        const claimOrganizationId = organizationIdFor(input, deps.organizationId);
        if (!claimOrganizationId) return { status: "forbidden" };
        const validation = await validatePendingToolContinuation(
          pending,
          claimOrganizationId,
          deps,
        );
        if (!validation.valid) {
          return { status: "stale", diagnosticCode: validation.diagnosticCode };
        }
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

      const requiresEgressAuthorization = Boolean(
        pending.releaseBinding || pending.releaseState?.status === "active",
      );
      if (input.action === "approve_all" && !requiresEgressAuthorization) {
        await deps.grantStore.grant(
          pending.agentId,
          GLOBAL_TOOL_AUTO_APPROVAL_PATTERN,
          null,
          undefined,
          organizationId,
        );
      }

      const execute = () => {
        const baseOptions = buildPendingToolExecutionOptions(pending);
        let grantStored = false;
        const approvalReplayAuthorization =
          requiresEgressAuthorization
            ? {
                revalidate: async () => (await validatePendingToolContinuation(
                  pending,
                  organizationId!,
                  deps,
                )).valid,
                onExecutionCompleted: input.action === "approve_all"
                  ? async () => {
                      if (grantStored) return;
                      await deps.grantStore.grant(
                        pending.agentId,
                        GLOBAL_TOOL_AUTO_APPROVAL_PATTERN,
                        null,
                        undefined,
                        organizationId,
                      );
                      grantStored = true;
                    }
                  : undefined,
              }
            : undefined;
        const options = baseOptions
          ? { ...baseOptions, ...(approvalReplayAuthorization
              ? { approvalReplayAuthorization }
              : {}) }
          : undefined;
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
      if (result.diagnosticCode === "approval_inventory_stale") {
        return { status: "stale", diagnosticCode: "approval_inventory_stale" };
      }
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
