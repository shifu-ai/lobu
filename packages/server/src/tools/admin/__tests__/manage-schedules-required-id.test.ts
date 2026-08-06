/**
 * agent-stack #86: pause / cancel read `args.id` with no presence check, so
 * a caller that names the field anything else (the LINE agent sent
 * `schedule_id` four times) tunnels `undefined` into postgres.js and gets
 * `UNDEFINED_VALUE: Undefined values are not allowed` — a message that
 * tells the model nothing it can act on.
 */
import { describe, expect, mock, test } from "bun:test";
import { manageSchedules, type ManageSchedulesDeps } from "../manage_schedules";
import type { ToolContext } from "../../registry";

const ORG = "org-1";

function adminCtx(): ToolContext {
  return {
    organizationId: ORG,
    userId: "user-admin",
    memberRole: "admin",
    agentId: null,
    isAuthenticated: true,
    tokenType: "oauth",
    scopedToOrg: false,
    allowCrossOrg: true,
  } as ToolContext;
}

function makeDeps() {
  const deleteScheduledJob = mock(async () => true);
  const pauseScheduledJob = mock(async () => true);
  const getScheduledJob = mock(async () => null);
  return {
    deps: {
      deleteScheduledJob,
      pauseScheduledJob,
      getScheduledJob,
    } as unknown as ManageSchedulesDeps,
    deleteScheduledJob,
    pauseScheduledJob,
    getScheduledJob,
  };
}

describe("manage_schedules requires id before touching the database", () => {
  test("cancel without id reports the field name and never reaches the DB", async () => {
    const { deps, deleteScheduledJob, getScheduledJob } = makeDeps();

    await expect(
      manageSchedules(
        { action: "cancel", schedule_id: "3343ef85" } as never,
        {} as never,
        adminCtx(),
        deps
      )
    ).rejects.toThrow("id is required for cancel action");

    expect(deleteScheduledJob).not.toHaveBeenCalled();
    expect(getScheduledJob).not.toHaveBeenCalled();
  });

  test("pause without id reports the field name and never reaches the DB", async () => {
    const { deps, pauseScheduledJob, getScheduledJob } = makeDeps();

    await expect(
      manageSchedules(
        { action: "pause", schedule_id: "3343ef85", paused: true } as never,
        {} as never,
        adminCtx(),
        deps
      )
    ).rejects.toThrow("id is required for pause action");

    expect(pauseScheduledJob).not.toHaveBeenCalled();
    expect(getScheduledJob).not.toHaveBeenCalled();
  });
});
