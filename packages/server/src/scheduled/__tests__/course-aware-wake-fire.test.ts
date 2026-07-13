import { describe, expect, mock, test } from "bun:test";
import {
  parseTrustedCourseWakeV1,
  buildTrustedCourseFireContext,
  trustedCourseWakeMatchesFireProvenance,
} from "../course-aware-wake";

function wake(matchedBy: unknown = ["instructor_alias"], scheduledFor = "2026-07-31T08:00:00+08:00") {
  return {
    schemaVersion: 1, source: "calendar_scheduled_wake", automationId: "auto-1",
    trustedCourseScope: { ownerUserId: "u", agentId: "a", courseEntityId: "course:a", courseKey: "a", courseDisplayName: "A", resolutionSource: "toolbox_calendar_course_resolver", resolutionMatchedBy: matchedBy, scopeVersion: 1 },
    taskKind: "opp_coach_rehearsal_prompt", delivery: "line", triggerSource: "google_calendar",
    calendarEventRef: { accountRef: "acct", eventId: "event", eventVersion: "v1", eventTitle: "A", eventStartAt: "2026-08-01T00:00:00Z" },
    scheduledFor,
  };
}

describe("trusted course fire provenance", () => {
  test("accepts an equivalent +08 payload and Z database tick", () => {
    const parsed = parseTrustedCourseWakeV1(wake(), { ownerUserId: "u", agentId: "a" });
    expect(trustedCourseWakeMatchesFireProvenance(parsed, "google_calendar:acct:event:opp_coach_rehearsal_prompt", "2026-07-31T00:00:00.000Z")).toBe(true);
  });
  test("rejects a genuinely different fire instant", () => {
    const parsed = parseTrustedCourseWakeV1(wake(), { ownerUserId: "u", agentId: "a" });
    expect(trustedCourseWakeMatchesFireProvenance(parsed, "google_calendar:acct:event:opp_coach_rehearsal_prompt", "2026-07-31T00:00:01.000Z")).toBe(false);
  });
  test.each([[[]], [["unknown"]], [["course_name", "unknown"]]])("rejects non-deterministic resolutionMatchedBy %j", (matchedBy) => {
    expect(() => parseTrustedCourseWakeV1(wake(matchedBy), { ownerUserId: "u", agentId: "a" })).toThrow("invalid trusted course scope");
  });
  test.each(["course_name", "course_alias", "instructor_name", "instructor_alias"])("accepts deterministic match %s", (matchedBy) => {
    expect(parseTrustedCourseWakeV1(wake([matchedBy]), { ownerUserId: "u", agentId: "a" }).trustedCourseScope.resolutionMatchedBy).toEqual([matchedBy]);
  });
  test("dependency-injected fire gate verifies owner and canonical context before returning wire metadata",async()=>{
    const resolved:any={course:{courseKey:'a',courseEntityId:'course:a'}};
    const verifyOwner=mock(async()=>true);const resolveContext=mock(async()=>resolved);
    const result=await buildTrustedCourseFireContext({rawWake:wake(),reason:'trusted-course-calendar-wake',organizationId:'org',createdByUser:'u',createdByAgent:'a',resolvedAgentId:'a',scheduledJobId:'job',scheduledTaskRunId:9,externalKey:'google_calendar:acct:event:opp_coach_rehearsal_prompt',scheduledTick:'2026-07-31T00:00:00Z'},{verifyOwner,resolveContext});
    expect(verifyOwner).toHaveBeenCalledWith({organizationId:'org',ownerUserId:'u',agentId:'a'});
    expect(result).toMatchObject({scheduledCourseContext:{runId:9,evidenceReadiness:'canonical_only'},resolvedCourseContext:resolved});
  });
  test("dependency-injected fire gate fails closed when canonical context is unavailable",async()=>{
    const result=await buildTrustedCourseFireContext({rawWake:wake(),reason:'trusted-course-calendar-wake',organizationId:'org',createdByUser:'u',createdByAgent:'a',resolvedAgentId:'a',scheduledJobId:'job',scheduledTaskRunId:9,externalKey:'google_calendar:acct:event:opp_coach_rehearsal_prompt',scheduledTick:'2026-07-31T00:00:00Z'},{verifyOwner:async()=>true,resolveContext:async()=>null});
    expect(result).toBeNull();
  });
});
