/**
 * SHIFU FORK: member-scope-internal-tools plan, Task 3 follow-up.
 *
 * Production bug (2026-07): a scheduled `wake_agent` row's `agent_id` was
 * stored as a full CONVERSATION id (`<agentId>_<userId>_<threadId>`) instead
 * of the bare agent id — the wake handler's exact-id existence check missed,
 * so the schedule fired but silently auto-paused instead of enqueueing a
 * message (job 63616d6c, 2026-07-07 03:07 UTC: zero scheduled-job chat
 * turns, zero send_daily_digest calls).
 *
 * These tests exercise `handleWakeAgentTask` (extracted from
 * `jobs.ts`'s `scheduler.register('wake_agent', ...)` closure) directly via
 * dependency injection — same rationale as manage_schedules.ts's
 * `ManageSchedulesDeps`: no `mock.module` needed, so no process-global
 * pollution risk for other test files in the same `bun test` run.
 */
import { describe, expect, mock, test } from "bun:test";
import { handleWakeAgentTask, type WakeAgentTaskDeps } from "../jobs";
import type { SqlLike } from "../scheduled-jobs-service";
import type { ResolvedCourseExecutionContext } from "@lobu/core";

const ORG = "org-1";
const BARE_AGENT_ID = "shifu-u-302b8bcc3af1";
const CONVERSATION_ID = `${BARE_AGENT_ID}_beaac6ef-917b-4bfd-b024-67555d19f0c1_org_peRVYvsqsWk`;

interface FakeAgentRow {
  id: string;
  organization_id: string;
}

/** Same fake-sql shape as resolve-wake-agent-id.test.ts, plus recording UPDATE (pause) calls. */
function makeSql(agents: FakeAgentRow[], pauseCalls: string[]): SqlLike {
  return (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.raw.join("");
    if (text.includes("UPDATE scheduled_jobs")) {
      pauseCalls.push(values[0] as string);
      return [];
    }
    if (text.includes("LIKE")) {
      const [organizationId, rawAgentId] = values as [string, string];
      const candidates = agents
        .filter(
          (a) => a.organization_id === organizationId && rawAgentId.startsWith(`${a.id}_`)
        )
        .sort((a, b) => b.id.length - a.id.length);
      return candidates.length > 0 ? [{ id: candidates[0].id }] : [];
    }
    const [rawAgentId, organizationId] = values as [string, string];
    const match = agents.find((a) => a.id === rawAgentId && a.organization_id === organizationId);
    return match ? [{ id: match.id }] : [];
  }) as unknown as SqlLike;
}

function makeDeps(agents: FakeAgentRow[], pauseCalls: string[] = []): {
  deps: WakeAgentTaskDeps;
  enqueueMessage: ReturnType<typeof mock>;
  getSession: ReturnType<typeof mock>;
  touchSession: ReturnType<typeof mock>;
} {
  const enqueueMessage = mock(async () => "job-1");
  const getSession = mock(async (key: string) => ({
    conversationId: key,
    channelId: `api_user-1`,
    userId: "user-1",
    agentId: BARE_AGENT_ID,
    organizationId: ORG,
  }));
  const touchSession = mock(async () => {});
  const sessionManager = { getSession, touchSession } as any;
  const queueProducer = { enqueueMessage } as any;
  const deps: WakeAgentTaskDeps = {
    sql: makeSql(agents, pauseCalls) as any,
    sessionManager,
    queueProducer,
  };
  return { deps, enqueueMessage, getSession, touchSession };
}

describe("handleWakeAgentTask — agent_id normalization (defense in depth)", () => {
  test("payload agent_id in CONVERSATION-id form → resolves to the bare agent, proceeds to enqueue", async () => {
    const pauseCalls: string[] = [];
    const { deps, enqueueMessage } = makeDeps(
      [{ id: BARE_AGENT_ID, organization_id: ORG }],
      pauseCalls
    );

    await handleWakeAgentTask(deps, {
      __organization_id: ORG,
      __scheduled_job_id: "job-abc",
      agent_id: CONVERSATION_ID,
      prompt: "提醒使用者喝水",
      thread_id: "existing-thread-1",
    });

    expect(enqueueMessage).toHaveBeenCalledTimes(1);
    const call = (enqueueMessage.mock.calls[0][0] as any);
    expect(call.messageText).toContain("提醒使用者喝水");
    // No pause update — the schedule fired successfully.
    expect(pauseCalls).toHaveLength(0);
  });

  test("payload agent_id already a bare id (fast path) → unchanged behavior, still enqueues", async () => {
    const pauseCalls: string[] = [];
    const { deps, enqueueMessage } = makeDeps(
      [{ id: BARE_AGENT_ID, organization_id: ORG }],
      pauseCalls
    );

    await handleWakeAgentTask(deps, {
      __organization_id: ORG,
      agent_id: BARE_AGENT_ID,
      prompt: "check X",
      thread_id: "existing-thread-2",
    });

    expect(enqueueMessage).toHaveBeenCalledTimes(1);
    expect(pauseCalls).toHaveLength(0);
  });

  test("truly unknown agent_id (no exact match, no prefix match) → auto-pauses, does not enqueue", async () => {
    const pauseCalls: string[] = [];
    const { deps, enqueueMessage } = makeDeps(
      [{ id: BARE_AGENT_ID, organization_id: ORG }],
      pauseCalls
    );

    await handleWakeAgentTask(deps, {
      __organization_id: ORG,
      __scheduled_job_id: "job-xyz",
      agent_id: "shifu-u-does-not-exist",
      prompt: "check X",
      thread_id: "existing-thread-3",
    });

    expect(enqueueMessage).not.toHaveBeenCalled();
    expect(pauseCalls).toEqual(["job-xyz"]);
  });

  test("conversation-id form whose bare agent belongs to a DIFFERENT org → treated as unknown, auto-pauses", async () => {
    const pauseCalls: string[] = [];
    const { deps, enqueueMessage } = makeDeps(
      [{ id: BARE_AGENT_ID, organization_id: "some-other-org" }],
      pauseCalls
    );

    await handleWakeAgentTask(deps, {
      __organization_id: ORG,
      __scheduled_job_id: "job-cross-org",
      agent_id: CONVERSATION_ID,
      prompt: "check X",
      thread_id: "existing-thread-4",
    });

    expect(enqueueMessage).not.toHaveBeenCalled();
    expect(pauseCalls).toEqual(["job-cross-org"]);
  });

  test("missing org/agent/prompt → returns without touching sql or enqueueing", async () => {
    const pauseCalls: string[] = [];
    const { deps, enqueueMessage } = makeDeps([], pauseCalls);

    await handleWakeAgentTask(deps, { agent_id: BARE_AGENT_ID, prompt: "x" }); // no org

    expect(enqueueMessage).not.toHaveBeenCalled();
    expect(pauseCalls).toHaveLength(0);
  });
});

describe("handleWakeAgentTask — trusted course fire gate",()=>{
  const trustedWake={schemaVersion:1 as const,source:'calendar_scheduled_wake' as const,automationId:'auto-1',trustedCourseScope:{ownerUserId:'user-1',agentId:BARE_AGENT_ID,courseEntityId:'course:a',courseKey:'a',courseDisplayName:'A 課',resolutionSource:'toolbox_calendar_course_resolver' as const,resolutionMatchedBy:['instructor_alias'] as const,scopeVersion:1 as const},taskKind:'opp_coach_rehearsal_prompt' as const,delivery:'line' as const,triggerSource:'google_calendar' as const,calendarEventRef:{accountRef:'acct',eventId:'event',eventVersion:'v1',eventTitle:'課程 A',eventStartAt:'2026-08-01T00:00:00Z'},scheduledFor:'2026-07-31T00:00:00Z'};
  const resolved={trust:{ownerUserId:'user-1',agentId:BARE_AGENT_ID,conversationId:'existing',courseKey:'a',courseEntityId:'course:a',contextPackId:'pack',contextVersion:1},course:{courseKey:'a',courseEntityId:'course:a',displayName:'A 課'},resolution:{confidence:'high' as const,matchedBy:['explicit_course_key'] as ['explicit_course_key']},context:{contextPackId:'pack',contextVersion:1,stale:false,confirmedSummary:'canonical'},retrieval:{status:'empty' as const,crossCourseGuard:'passed' as const,eventIds:[],evidenceRefs:[],snippets:[]}} satisfies ResolvedCourseExecutionContext;
  test('revalidates owner and canonical course before enqueueing structured scheduled scope',async()=>{
    const enqueueMessage=mock(async()=> 'job');
    const sql=mock(async(strings:TemplateStringsArray,...values:unknown[])=>{const text=strings.raw.join('');if(text.includes('owner_platform'))return [{id:BARE_AGENT_ID}];if(text.includes('SELECT id FROM agents'))return [{id:BARE_AGENT_ID}];return [];});
    const resolveScheduledCourseContext=mock(async()=>resolved);
    await handleWakeAgentTask({sql:sql as never,sessionManager:{getSession:mock(async()=>({conversationId:'existing',channelId:'api_user-1',userId:'user-1',agentId:BARE_AGENT_ID,organizationId:ORG})),touchSession:mock(async()=>{})} as never,queueProducer:{enqueueMessage} as never,resolveScheduledCourseContext},{__organization_id:ORG,__created_by_user:'user-1',__created_by_agent:BARE_AGENT_ID,__scheduled_job_id:'job-1',__scheduled_job_external_key:'google_calendar:acct:event:opp_coach_rehearsal_prompt',__scheduled_job_tick:'2026-07-31T00:00:00Z',__scheduled_task_run_id:42,agent_id:BARE_AGENT_ID,prompt:'coach',thread_id:'existing',reason:'trusted-course-calendar-wake',trustedCourseWake:trustedWake});
    expect(resolveScheduledCourseContext).toHaveBeenCalledTimes(1);
    expect(enqueueMessage).toHaveBeenCalledWith(expect.objectContaining({scheduledCourseContext:expect.objectContaining({source:'calendar_scheduled_wake',automationId:'auto-1',jobId:'job-1',runId:42,course:expect.objectContaining({courseEntityId:'course:a'})}),resolvedCourseContext:resolved}));
  });
  test.each([
    ['bad provenance',{reason:'scheduled-wake'}],
    ['bad schema',{trustedCourseWake:{...trustedWake,schemaVersion:2}}],
    ['owner changed',{__created_by_user:'user-2'}],
    ['agent changed',{__created_by_agent:'other'}],
    ['missing job id',{__scheduled_job_id:undefined}],
  ])('%s fails before canonical lookup or enqueue',async(_name,override)=>{
    const enqueueMessage=mock(async()=> 'job');const resolver=mock(async()=>resolved);
    await handleWakeAgentTask({sql:(async(strings:TemplateStringsArray)=>strings.raw.join('').includes('SELECT id FROM agents')?[{id:BARE_AGENT_ID}]:[]) as never,sessionManager:{} as never,queueProducer:{enqueueMessage} as never,resolveScheduledCourseContext:resolver},{__organization_id:ORG,__created_by_user:'user-1',__created_by_agent:BARE_AGENT_ID,__scheduled_job_id:'job-1',__scheduled_job_external_key:'google_calendar:acct:event:opp_coach_rehearsal_prompt',__scheduled_job_tick:'2026-07-31T00:00:00Z',__scheduled_task_run_id:42,agent_id:BARE_AGENT_ID,prompt:'coach',thread_id:'existing',reason:'trusted-course-calendar-wake',trustedCourseWake:trustedWake,...override} as any);
    expect(resolver).not.toHaveBeenCalled();expect(enqueueMessage).not.toHaveBeenCalled();
  });
});
