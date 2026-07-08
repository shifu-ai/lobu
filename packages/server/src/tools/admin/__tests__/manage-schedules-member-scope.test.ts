/**
 * SHIFU FORK: member-scope-internal-tools plan, Task 3.
 *
 * manage_schedules is reachable by member-owned direct-auth sessions (see
 * 1c52bc33's write-tier exception), but the handler itself must confine a
 * member to: their own agent (wake_agent), their own recipients
 * (send_notification), a bounded active-schedule quota, and their own rows
 * on list/pause/cancel. Owner/admin sessions are unrestricted.
 *
 * These tests call `manageSchedules` directly with an injected
 * `ManageSchedulesDeps` (see manage_schedules.ts) instead of `mock.module`,
 * following the deps-parameter option the task brief allowed — the neighbor
 * files in this directory don't exercise the handler's DB-touching path at
 * all (they test the pure schema/normalize helpers), so there's no existing
 * mock.module precedent in this file to follow, and wake-target.test.ts's
 * precedent is exactly this "inject a deps object" shape.
 */
import { describe, expect, mock, test } from "bun:test";
import { manageSchedules, type ManageSchedulesDeps } from "../manage_schedules";
import type { ToolContext } from "../../registry";
import type { ScheduledJobRow } from "../../../scheduled/scheduled-jobs-service";

const ORG = "org-1";
const MEMBER_USER = "user-me";
const MEMBER_AGENT = "shifu-u-me";

function memberCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    organizationId: ORG,
    userId: MEMBER_USER,
    memberRole: "member",
    agentId: MEMBER_AGENT,
    // Member sessions only reach manage_schedules' write actions via the
    // member-owned direct-auth exception (1c52bc33 / tool-access.ts's
    // isDirectAuthMemberScheduleWrite), which requires an explicit
    // `mcp:write` scope — not the `scopes: null`-means-privileged
    // convention plain web session-cookie members get.
    scopes: ["mcp:read", "mcp:write"],
    isAuthenticated: true,
    tokenType: "pat",
    scopedToOrg: true,
    allowCrossOrg: false,
    ...overrides,
  };
}

function adminCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    organizationId: ORG,
    userId: "user-admin",
    memberRole: "admin",
    agentId: null,
    isAuthenticated: true,
    tokenType: "oauth",
    scopedToOrg: false,
    allowCrossOrg: true,
    ...overrides,
  };
}

function fakeJobRow(overrides: Partial<ScheduledJobRow> = {}): ScheduledJobRow {
  return {
    id: "job-1",
    organization_id: ORG,
    action_type: "wake_agent",
    action_args: {},
    cron: null,
    next_run_at: "2026-08-01T00:00:00Z",
    last_fired_at: null,
    last_fired_run_id: null,
    paused: false,
    description: "test",
    created_by_user: MEMBER_USER,
    created_by_agent: MEMBER_AGENT,
    source_run_id: null,
    source_event_id: null,
    source_thread_id: null,
    created_at: "2026-07-08T00:00:00Z",
    updated_at: "2026-07-08T00:00:00Z",
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ManageSchedulesDeps> = {}): ManageSchedulesDeps {
  return {
    createScheduledJob: mock(async (params: any) =>
      fakeJobRow({
        action_type: params.actionType,
        action_args: params.actionArgs,
        created_by_user: params.createdByUser,
        created_by_agent: params.createdByAgent,
      })
    ) as any,
    listScheduledJobs: mock(async () => []) as any,
    getScheduledJob: mock(async () => null) as any,
    pauseScheduledJob: mock(async () => true) as any,
    deleteScheduledJob: mock(async () => true) as any,
    countActiveScheduledJobs: mock(async () => 0) as any,
    agentOwnedByUser: mock(async () => true) as any,
    // Default: identity resolution — the given agent_id is already the bare
    // form, matching every pre-existing test in this file. Tests exercising
    // the conversation-id normalization below override this.
    resolveWakeAgentId: mock(async (_organizationId: string, rawAgentId: string) => rawAgentId) as any,
    ...overrides,
  };
}

function wakeCreateArgs(agentId: string, overrides: Record<string, unknown> = {}) {
  return {
    action: "create" as const,
    description: "wake me up",
    run_at: "2026-08-01T00:00:00Z",
    payload: { type: "wake_agent" as const, agent_id: agentId, prompt: "check X" },
    ...overrides,
  };
}

function notifyCreateArgs(recipients: unknown, overrides: Record<string, unknown> = {}) {
  return {
    action: "create" as const,
    description: "notify",
    run_at: "2026-08-01T00:00:00Z",
    payload: { type: "send_notification" as const, title: "hi", recipients },
    ...overrides,
  };
}

describe("manage_schedules member self-scoping — create wake_agent", () => {
  test("member targeting an agent they do NOT own → error, nothing persisted", async () => {
    const deps = makeDeps({ agentOwnedByUser: mock(async () => false) as any });
    const result = await manageSchedules(
      wakeCreateArgs("shifu-u-other") as any,
      {} as any,
      memberCtx(),
      deps
    );
    expect(result.error).toMatch(/own/i);
    expect(deps.createScheduledJob).not.toHaveBeenCalled();
  });

  test("member targeting an agent they DO own → success; createdByAgent attributed", async () => {
    const deps = makeDeps({ agentOwnedByUser: mock(async () => true) as any });
    const result = await manageSchedules(
      wakeCreateArgs(MEMBER_AGENT) as any,
      {} as any,
      memberCtx(),
      deps
    );
    expect(result.error).toBeUndefined();
    expect(result.schedule).toBeDefined();
    expect(deps.createScheduledJob).toHaveBeenCalledTimes(1);
    const call = (deps.createScheduledJob as any).mock.calls[0][0];
    expect(call.createdByAgent).toBe(MEMBER_AGENT);
    expect(deps.agentOwnedByUser).toHaveBeenCalledWith(ORG, MEMBER_USER, MEMBER_AGENT);
  });
});

describe("manage_schedules — wake_agent conversation-id normalization", () => {
  // Production bug (2026-07): an agent scheduling its own wake via LINE
  // doesn't know its bare id and sends the full CONVERSATION id instead
  // (`<agentId>_<userId>_<threadId>`). The exact-id wake lookup then missed
  // and the schedule silently auto-paused. manage_schedules.ts now resolves
  // this to the bare id BEFORE the member ownership check and BEFORE
  // persisting — see the SHIFU FORK comment ahead of that block.
  const CONVERSATION_ID = `${MEMBER_AGENT}_${MEMBER_USER}_thread-abc`;

  test("member sends conversation-id form of their OWN agent → ownership check sees the resolved bare id; persisted agent_id is bare", async () => {
    const resolveWakeAgentId = mock(async (_organizationId: string, rawAgentId: string) =>
      rawAgentId === CONVERSATION_ID ? MEMBER_AGENT : null
    );
    const agentOwnedByUser = mock(async () => true);
    const deps = makeDeps({
      resolveWakeAgentId: resolveWakeAgentId as any,
      agentOwnedByUser: agentOwnedByUser as any,
    });
    const result = await manageSchedules(
      wakeCreateArgs(CONVERSATION_ID) as any,
      {} as any,
      memberCtx(),
      deps
    );
    expect(result.error).toBeUndefined();
    expect(resolveWakeAgentId).toHaveBeenCalledWith(ORG, CONVERSATION_ID);
    // The critical MS-3 guarantee: ownership is checked against the
    // RESOLVED bare id, not the raw conversation-id string.
    expect(agentOwnedByUser).toHaveBeenCalledWith(ORG, MEMBER_USER, MEMBER_AGENT);
    const call = (deps.createScheduledJob as any).mock.calls[0][0];
    expect(call.actionArgs.agent_id).toBe(MEMBER_AGENT);
  });

  test("member sends conversation-id form whose bare id is NOT owned by them → still rejected (no self-scoping bypass)", async () => {
    const OTHER_AGENT = "shifu-u-other";
    const otherConversationId = `${OTHER_AGENT}_someone-else_thread-xyz`;
    const resolveWakeAgentId = mock(async (_organizationId: string, rawAgentId: string) =>
      rawAgentId === otherConversationId ? OTHER_AGENT : null
    );
    const agentOwnedByUser = mock(async () => false);
    const deps = makeDeps({
      resolveWakeAgentId: resolveWakeAgentId as any,
      agentOwnedByUser: agentOwnedByUser as any,
    });
    const result = await manageSchedules(
      wakeCreateArgs(otherConversationId) as any,
      {} as any,
      memberCtx(),
      deps
    );
    expect(result.error).toMatch(/own/i);
    // A member cannot launder access to someone else's agent by wrapping its
    // bare id inside a conversation-id-shaped string.
    expect(agentOwnedByUser).toHaveBeenCalledWith(ORG, MEMBER_USER, OTHER_AGENT);
    expect(deps.createScheduledJob).not.toHaveBeenCalled();
  });

  test("resolution finds no match at all → raw value passed through unchanged (existing unknown-agent handling, no new UX)", async () => {
    const unknownId = "totally-unknown-string";
    const resolveWakeAgentId = mock(async () => null);
    const agentOwnedByUser = mock(async () => false);
    const deps = makeDeps({
      resolveWakeAgentId: resolveWakeAgentId as any,
      agentOwnedByUser: agentOwnedByUser as any,
    });
    const result = await manageSchedules(
      wakeCreateArgs(unknownId) as any,
      {} as any,
      memberCtx(),
      deps
    );
    expect(result.error).toMatch(/own/i);
    expect(agentOwnedByUser).toHaveBeenCalledWith(ORG, MEMBER_USER, unknownId);
  });

  test("admin (privileged, no ownership check) also gets agent_id normalized before persisting", async () => {
    const adminConversationId = "shifu-u-admin-agent_user-admin_thread-1";
    const resolveWakeAgentId = mock(async (_organizationId: string, rawAgentId: string) =>
      rawAgentId === adminConversationId ? "shifu-u-admin-agent" : null
    );
    const deps = makeDeps({
      resolveWakeAgentId: resolveWakeAgentId as any,
      agentOwnedByUser: mock(async () => {
        throw new Error("agentOwnedByUser must not be called for privileged roles");
      }) as any,
    });
    const result = await manageSchedules(
      wakeCreateArgs(adminConversationId) as any,
      {} as any,
      adminCtx(),
      deps
    );
    expect(result.error).toBeUndefined();
    const call = (deps.createScheduledJob as any).mock.calls[0][0];
    expect(call.actionArgs.agent_id).toBe("shifu-u-admin-agent");
  });
});

describe("manage_schedules member self-scoping — create send_notification", () => {
  test("recipients:'all' → error, nothing persisted", async () => {
    const deps = makeDeps();
    const result = await manageSchedules(
      notifyCreateArgs("all") as any,
      {} as any,
      memberCtx(),
      deps
    );
    expect(result.error).toBeDefined();
    expect(deps.createScheduledJob).not.toHaveBeenCalled();
  });

  test("recipients:'admins' → error, nothing persisted", async () => {
    const deps = makeDeps();
    const result = await manageSchedules(
      notifyCreateArgs("admins") as any,
      {} as any,
      memberCtx(),
      deps
    );
    expect(result.error).toBeDefined();
    expect(deps.createScheduledJob).not.toHaveBeenCalled();
  });

  test("recipients:[other-user] → forced-rewrite to [ctx.userId], impossible to target others", async () => {
    const deps = makeDeps();
    const result = await manageSchedules(
      notifyCreateArgs(["user-other"]) as any,
      {} as any,
      memberCtx(),
      deps
    );
    expect(result.error).toBeUndefined();
    expect(deps.createScheduledJob).toHaveBeenCalledTimes(1);
    const call = (deps.createScheduledJob as any).mock.calls[0][0];
    expect(call.actionArgs.recipients).toEqual([MEMBER_USER]);
  });
});

describe("manage_schedules member self-scoping — quota", () => {
  test("21st active schedule (count mock returns 20) → error mentioning quota, nothing persisted", async () => {
    const deps = makeDeps({ countActiveScheduledJobs: mock(async () => 20) as any });
    const result = await manageSchedules(
      wakeCreateArgs(MEMBER_AGENT) as any,
      {} as any,
      memberCtx(),
      deps
    );
    expect(result.error).toMatch(/quota/i);
    expect(deps.createScheduledJob).not.toHaveBeenCalled();
  });

  test("under quota (count mock returns 19) → success", async () => {
    const deps = makeDeps({ countActiveScheduledJobs: mock(async () => 19) as any });
    const result = await manageSchedules(
      wakeCreateArgs(MEMBER_AGENT) as any,
      {} as any,
      memberCtx(),
      deps
    );
    expect(result.error).toBeUndefined();
    expect(deps.createScheduledJob).toHaveBeenCalledTimes(1);
  });
});

describe("manage_schedules member self-scoping — list", () => {
  test("member list is forced to createdByUser=ctx.userId, ignoring caller-supplied user_id/agent_id", async () => {
    const deps = makeDeps();
    await manageSchedules(
      { action: "list", user_id: "someone-else", agent_id: "shifu-u-other" } as any,
      {} as any,
      memberCtx(),
      deps
    );
    expect(deps.listScheduledJobs).toHaveBeenCalledTimes(1);
    const call = (deps.listScheduledJobs as any).mock.calls[0][0];
    expect(call.createdByUser).toBe(MEMBER_USER);
    expect(call.createdByAgent).toBeNull();
  });
});

describe("manage_schedules member self-scoping — pause/cancel ownership", () => {
  test("pause a job not owned by the member → not-found error (no existence leak), pauseScheduledJob not called", async () => {
    const deps = makeDeps({
      getScheduledJob: mock(async () =>
        fakeJobRow({ created_by_user: "user-other", created_by_agent: "shifu-u-other" })
      ) as any,
    });
    const result = await manageSchedules(
      { action: "pause", id: "11111111-1111-1111-1111-111111111111" } as any,
      {} as any,
      memberCtx(),
      deps
    );
    expect(result.error).toMatch(/not found/i);
    expect(deps.pauseScheduledJob).not.toHaveBeenCalled();
  });

  test("pause a job owned by the member (created_by_user match) → succeeds", async () => {
    const deps = makeDeps({
      getScheduledJob: mock(async () =>
        fakeJobRow({ created_by_user: MEMBER_USER, created_by_agent: null })
      ) as any,
    });
    const result = await manageSchedules(
      { action: "pause", id: "11111111-1111-1111-1111-111111111111" } as any,
      {} as any,
      memberCtx(),
      deps
    );
    expect(result.error).toBeUndefined();
    expect(deps.pauseScheduledJob).toHaveBeenCalledTimes(1);
  });

  test("cancel a job not owned by the member → same not-found error as a nonexistent id", async () => {
    const deps = makeDeps({ getScheduledJob: mock(async () => null) as any });
    const notFoundMissing = await manageSchedules(
      { action: "cancel", id: "22222222-2222-2222-2222-222222222222" } as any,
      {} as any,
      memberCtx(),
      deps
    );

    const deps2 = makeDeps({
      getScheduledJob: mock(async () =>
        fakeJobRow({ created_by_user: "user-other", created_by_agent: "shifu-u-other" })
      ) as any,
    });
    const notFoundOthers = await manageSchedules(
      { action: "cancel", id: "22222222-2222-2222-2222-222222222222" } as any,
      {} as any,
      memberCtx(),
      deps2
    );

    expect(notFoundMissing.error).toBe(notFoundOthers.error);
    expect(deps2.deleteScheduledJob).not.toHaveBeenCalled();
  });
});

describe("manage_schedules admin/owner regression — unrestricted", () => {
  test("admin can wake an agent it doesn't own, without any DB ownership check", async () => {
    const deps = makeDeps({
      agentOwnedByUser: mock(async () => {
        throw new Error("agentOwnedByUser must not be called for privileged roles");
      }) as any,
    });
    const result = await manageSchedules(
      wakeCreateArgs("shifu-u-someone-elses-agent") as any,
      {} as any,
      adminCtx(),
      deps
    );
    expect(result.error).toBeUndefined();
    expect(deps.agentOwnedByUser).not.toHaveBeenCalled();
    expect(deps.createScheduledJob).toHaveBeenCalledTimes(1);
  });

  test("admin is not subject to the quota check", async () => {
    const deps = makeDeps({
      countActiveScheduledJobs: mock(async () => {
        throw new Error("countActiveScheduledJobs must not be called for privileged roles");
      }) as any,
    });
    const result = await manageSchedules(
      wakeCreateArgs("shifu-u-anything") as any,
      {} as any,
      adminCtx(),
      deps
    );
    expect(result.error).toBeUndefined();
    expect(deps.countActiveScheduledJobs).not.toHaveBeenCalled();
  });

  test("admin send_notification recipients 'all' passes through unmodified", async () => {
    const deps = makeDeps();
    const result = await manageSchedules(
      notifyCreateArgs("all") as any,
      {} as any,
      adminCtx(),
      deps
    );
    expect(result.error).toBeUndefined();
    const call = (deps.createScheduledJob as any).mock.calls[0][0];
    expect(call.actionArgs.recipients).toBe("all");
  });

  test("admin list is unfiltered by default (no forced createdByUser)", async () => {
    const deps = makeDeps();
    await manageSchedules({ action: "list" } as any, {} as any, adminCtx(), deps);
    const call = (deps.listScheduledJobs as any).mock.calls[0][0];
    expect(call.createdByUser).toBeNull();
    expect(call.createdByAgent).toBeNull();
  });

  test("admin can pause any org schedule regardless of created_by_user/agent", async () => {
    const deps = makeDeps({
      getScheduledJob: mock(async () =>
        fakeJobRow({ created_by_user: "user-other", created_by_agent: "shifu-u-other" })
      ) as any,
    });
    const result = await manageSchedules(
      { action: "pause", id: "33333333-3333-3333-3333-333333333333" } as any,
      {} as any,
      adminCtx(),
      deps
    );
    expect(result.error).toBeUndefined();
    expect(deps.pauseScheduledJob).toHaveBeenCalledTimes(1);
  });
});

describe("manage_schedules attribution regression — all roles stamp createdByAgent", () => {
  test("admin create also passes createdByAgent = ctx.agentId (resolves upstream TODO)", async () => {
    const deps = makeDeps();
    await manageSchedules(
      wakeCreateArgs("shifu-u-anything") as any,
      {} as any,
      adminCtx({ agentId: "shifu-u-admin-agent" }),
      deps
    );
    const call = (deps.createScheduledJob as any).mock.calls[0][0];
    expect(call.createdByAgent).toBe("shifu-u-admin-agent");
  });

  test("session with no agentId stamps createdByAgent = null (not undefined)", async () => {
    const deps = makeDeps();
    await manageSchedules(
      wakeCreateArgs("shifu-u-anything") as any,
      {} as any,
      adminCtx({ agentId: null }),
      deps
    );
    const call = (deps.createScheduledJob as any).mock.calls[0][0];
    expect(call.createdByAgent).toBeNull();
  });
});
