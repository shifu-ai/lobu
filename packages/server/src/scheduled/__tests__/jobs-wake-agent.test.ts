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
