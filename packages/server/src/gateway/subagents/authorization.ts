import { readAgentReleaseCapabilityState } from "../../lobu/agent-release-service";
import { SUBAGENT_CAPABILITY, type SubagentTask } from "./types";

/** Recheck the persisted, run-authenticated grant against the current applied release. */
export async function isSubagentAuthorizationActive(task: SubagentTask): Promise<boolean> {
  const claim = task.authorization;
  if (!claim || claim.agentId !== task.agentId || claim.toolboxUserId !== task.userId ||
      !(Date.parse(claim.expiresAt) > Date.now()) || !claim.capabilityIds.includes(SUBAGENT_CAPABILITY)) return false;
  const state = await readAgentReleaseCapabilityState({
    organizationId: task.organizationId, agentId: task.agentId, environment: claim.environment,
    snapshot: {
      schemaVersion: 1, environment: claim.environment, toolboxUserId: claim.toolboxUserId,
      agentId: claim.agentId, appliedReleaseId: claim.releaseId, appliedReleaseSequence: claim.releaseSequence,
      expiresAt: claim.expiresAt, snapshotDigest: claim.snapshotDigest, capabilities: claim.capabilityIds,
    },
  });
  return state.status === "active";
}
