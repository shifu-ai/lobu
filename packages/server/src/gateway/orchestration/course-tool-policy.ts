export interface TrustedCourseToolScope {
  ownerUserId: string;
  agentId: string;
  courseEntityId: string;
}

export type CourseToolPolicyResult =
  | { ok: true; arguments: Record<string, unknown> }
  | { ok: false; code: "COURSE_SCOPE_MISMATCH"; message: string };

const MISMATCH: CourseToolPolicyResult = {
  ok: false,
  code: "COURSE_SCOPE_MISMATCH",
  message: "Memory search scope does not match the trusted course execution context.",
};

export function applyTrustedCourseToolPolicy(
  toolName: string,
  args: Record<string, unknown>,
  scope?: TrustedCourseToolScope
): CourseToolPolicyResult {
  if (toolName !== "search_memory" && toolName !== "lobu_search_memory" || !scope) {
    return { ok: true, arguments: args };
  }
  if (
    (Object.hasOwn(args, "owner_user_id") && args.owner_user_id !== scope.ownerUserId) ||
    (Object.hasOwn(args, "agent_id") && args.agent_id !== scope.agentId) ||
    (Object.hasOwn(args, "entity_ids") &&
      (!Array.isArray(args.entity_ids) || args.entity_ids.length !== 1 || args.entity_ids[0] !== scope.courseEntityId))
  ) return MISMATCH;
  return {
    ok: true,
    arguments: { ...args, owner_user_id: scope.ownerUserId, agent_id: scope.agentId, entity_ids: [scope.courseEntityId] },
  };
}
