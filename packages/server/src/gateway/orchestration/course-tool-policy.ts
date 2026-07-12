export interface TrustedCourseToolScope {
  ownerUserId: string;
  agentId: string;
  courseEntityId: string;
}

export type CourseToolPolicyResult =
  | { ok: true; arguments: Record<string, unknown> }
  | { ok: false; code: "COURSE_SCOPE_MISMATCH" | "COURSE_MEETING_SCOPE_UNAVAILABLE"; message: string };

const MISMATCH: CourseToolPolicyResult = {
  ok: false,
  code: "COURSE_SCOPE_MISMATCH",
  message: "Memory search scope does not match the trusted course execution context.",
};

const MEETING_SCOPE_UNAVAILABLE: CourseToolPolicyResult = {
  ok: false,
  code: "COURSE_MEETING_SCOPE_UNAVAILABLE",
  message: "Course meeting ownership is not verified yet. Provide a specific meeting or link, or use canonical course evidence instead.",
};

// Canonical name registered by the personal-agent and MCP catalogs. Remove
// once trusted Toolbox scope + Meeting-Course Binding enforce ownership at the
// upstream meeting_search boundary.
const COURSE_MEETING_TOOL_NAME = "meeting_search";

export function isPlainToolArguments(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function applyTrustedCourseToolPolicy(
  toolName: string,
  args: Record<string, unknown>,
  scope?: TrustedCourseToolScope
): CourseToolPolicyResult {
  if (scope && toolName === COURSE_MEETING_TOOL_NAME) return MEETING_SCOPE_UNAVAILABLE;
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
