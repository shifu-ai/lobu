/**
 * Tests for SessionManager and StateAdapterSessionStore.
 * Session state now lives in the shared conversation state layer used by the
 * Chat SDK-backed history store.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import {
  ConversationStateStore,
  sessionKey as stateSessionKey,
  threadIndexKey,
} from "../connections/conversation-state-store.js";
import {
  SessionManager,
  StateAdapterSessionStore,
} from "../services/session-manager.js";
import { computeSessionKey, type ThreadSession } from "../session.js";
import { InMemoryStateAdapter } from "./fixtures/in-memory-state-adapter.js";

function createHarness() {
  const state = new InMemoryStateAdapter();
  const conversations = new ConversationStateStore(state);
  const store = new StateAdapterSessionStore(conversations);
  const manager = new SessionManager(store);
  return { state, conversations, store, manager };
}

describe("SessionManager", () => {
  let state: InMemoryStateAdapter;
  let manager: SessionManager;

  beforeEach(() => {
    const harness = createHarness();
    state = harness.state;
    manager = harness.manager;
  });

  test("creates and retrieves session", async () => {
    const session: ThreadSession = {
      channelId: "C123",
      userId: "U123",
      conversationId: "1234567890.123456",
      threadCreator: "U123",
      status: "pending",
      createdAt: Date.now(),
      lastActivity: Date.now(),
    };

    await manager.setSession(session);

    const sessionId = computeSessionKey(session);
    const retrieved = await manager.getSession(sessionId);
    expect(retrieved).toMatchObject({
      userId: "U123",
      channelId: "C123",
      conversationId: "1234567890.123456",
      threadCreator: "U123",
      status: "pending",
    });
  });

  test("course selection CAS permits one claimant and cannot clear a newer pending value", async () => {
    await manager.setSession({ channelId:"C",userId:"U",conversationId:"T",createdAt:1,lastActivity:1 });
    const key=computeSessionKey({channelId:"C",conversationId:"T"});
    const first=await manager.createPendingCourseSelection(key,{ownerUserId:"owner-a",agentId:"agent-a",candidates:[{courseKey:"a",displayName:"A"}],originalMessage:"task",createdAt:1});
    expect(first.status).toBe("persisted"); if(first.status!=="persisted")return;
    const claims=await Promise.all([manager.claimPendingCourseSelection(key,first.pending.pendingId,"owner-a","agent-a","a","m1"),manager.claimPendingCourseSelection(key,first.pending.pendingId,"owner-a","agent-a","a","m2")]);
    expect(claims.filter((value)=>value.status==="claimed")).toHaveLength(1);
    const newer=await manager.createPendingCourseSelection(key,{ownerUserId:"owner-a",agentId:"agent-a",candidates:[{courseKey:"b",displayName:"B"}],originalMessage:"new",createdAt:2});
    expect(newer.status).toBe("persisted");
    expect(await manager.clearPendingCourseSelection(key,first.pending.pendingId,"owner-a","agent-a","m1")).toEqual({status:"stale"});
    expect((await manager.getSessionStrict(key))?.pendingCourseSelection?.originalMessage).toBe("new");
  });

  test("course selection CAS rejects a different owner or agent", async () => {
    await manager.setSession({ channelId:"C",userId:"U",conversationId:"T",createdAt:1,lastActivity:1 });
    const key=computeSessionKey({channelId:"C",conversationId:"T"});
    const created=await manager.createPendingCourseSelection(key,{ownerUserId:"owner-a",agentId:"agent-a",candidates:[{courseKey:"a",displayName:"A"}],originalMessage:"private task",createdAt:1});
    expect(created.status).toBe("persisted"); if(created.status!=="persisted")return;
    expect(await manager.claimPendingCourseSelection(key,created.pending.pendingId,"owner-b","agent-a","a","m1")).toEqual({status:"conflict"});
    expect(await manager.claimPendingCourseSelection(key,created.pending.pendingId,"owner-a","agent-b","a","m1")).toEqual({status:"conflict"});
    expect(await manager.clearPendingCourseSelection(key,created.pending.pendingId,"owner-b","agent-a")).toEqual({status:"stale"});
    expect((await manager.getSessionStrict(key))?.pendingCourseSelection?.originalMessage).toBe("private task");
  });

  test("deletes both session and thread index", async () => {
    const session: ThreadSession = {
      channelId: "C123",
      userId: "U123",
      conversationId: "1234567890.123456",
      status: "completed",
      createdAt: Date.now(),
      lastActivity: Date.now(),
    };

    await manager.setSession(session);
    const sessionId = computeSessionKey(session);
    await manager.deleteSession(sessionId);

    expect(await manager.getSession(sessionId)).toBeNull();
    expect(
      await manager.findSessionByThread("C123", "1234567890.123456")
    ).toBeNull();
  });

  test("finds session by thread index", async () => {
    const session: ThreadSession = {
      channelId: "C789",
      userId: "U789",
      conversationId: "1111111111.111111",
      status: "running",
      createdAt: Date.now(),
      lastActivity: Date.now(),
    };

    await manager.setSession(session);

    const found = await manager.findSessionByThread(
      "C789",
      "1111111111.111111"
    );
    expect(found?.userId).toBe("U789");
  });

  test("updates thread ownership checks", async () => {
    const session: ThreadSession = {
      channelId: "C123",
      userId: "U123",
      conversationId: "1234567890.123456",
      threadCreator: "U123",
      status: "running",
      createdAt: Date.now(),
      lastActivity: Date.now(),
    };

    await manager.setSession(session);

    await expect(
      manager.validateThreadOwnership("C123", "1234567890.123456", "U123")
    ).resolves.toEqual({ allowed: true, owner: "U123" });

    await expect(
      manager.validateThreadOwnership("C123", "1234567890.123456", "U999")
    ).resolves.toEqual({ allowed: false, owner: "U123" });
  });

  test("touchSession updates lastActivity without dropping other fields", async () => {
    const session: ThreadSession = {
      channelId: "C123",
      userId: "U123",
      conversationId: "activity.123456",
      threadCreator: "U123",
      status: "running",
      createdAt: Date.now(),
      lastActivity: Date.now() - 1_000,
    };

    await manager.setSession(session);
    const sessionId = computeSessionKey(session);
    const before = await manager.getSession(sessionId);
    const beforeActivity = before!.lastActivity;

    await new Promise((resolve) => setTimeout(resolve, 10));
    await manager.touchSession(sessionId);

    const after = await manager.getSession(sessionId);
    expect(after?.lastActivity).toBeGreaterThan(beforeActivity);
    expect(after).toMatchObject({
      channelId: "C123",
      userId: "U123",
      conversationId: "activity.123456",
      status: "running",
    });
  });

  test("createSession stores a session using computed key", async () => {
    const created = await manager.createSession(
      "C123",
      "U123",
      "1234567890.123456",
      "U123"
    );

    const stored = await manager.getSession(computeSessionKey(created));
    expect(stored?.threadCreator).toBe("U123");
  });

  test("cleanupExpired returns 0 because TTL is adapter-managed", async () => {
    await expect(manager.cleanupExpired(3600)).resolves.toBe(0);
  });

  test("stores session and thread index in shared conversation state", async () => {
    const session: ThreadSession = {
      channelId: "C123",
      userId: "U123",
      conversationId: "state.123456",
      status: "pending",
      createdAt: Date.now(),
      lastActivity: Date.now(),
    };

    await manager.setSession(session);
    const sessionId = computeSessionKey(session);

    expect(await state.get(stateSessionKey(sessionId))).toEqual(session);
    expect(await state.get(threadIndexKey("C123", "state.123456"))).toEqual({
      sessionKey: sessionId,
    });
  });

  test("handles API sessions where channelId equals conversationId", async () => {
    const agentId = "agent-123";
    const session: ThreadSession = {
      channelId: agentId,
      userId: "U123",
      conversationId: agentId,
      status: "pending",
      createdAt: Date.now(),
      lastActivity: Date.now(),
    };

    await manager.setSession(session);

    const sessionId = computeSessionKey(session);
    expect(sessionId).toBe(agentId);
    expect(await manager.getSession(sessionId)).toMatchObject({
      conversationId: agentId,
      channelId: agentId,
    });
  });

  test("handles concurrent updates with last write winning semantics", async () => {
    const session: ThreadSession = {
      channelId: "C123",
      userId: "U123",
      conversationId: "concurrent.123456",
      status: "pending",
      createdAt: Date.now(),
      lastActivity: Date.now(),
    };

    const sessionId = computeSessionKey(session);

    await Promise.all([
      manager.setSession({ ...session, status: "running" }),
      manager.setSession({ ...session, status: "completed" }),
    ]);

    const retrieved = await manager.getSession(sessionId);
    expect(retrieved).not.toBeNull();
    expect(["running", "completed"]).toContain(retrieved?.status);
  });

  test("persists active course binding across manager replicas and preserves session fields", async () => {
    const session = await manager.createSession("C123", "U123", "course.123456", "U123");
    const key = computeSessionKey(session);
    await manager.updateSession(key, { status: "running", turnCount: 4 });
    await expect(manager.bindActiveCourse(key, {
      courseKey: "course-a", courseEntityId: "course:U123:a", source: "resolver",
      boundAt: "2026-07-11T01:00:00.000Z", contextPackId: "pack-a",
    })).resolves.toEqual({ status: "persisted" });

    const replica = new SessionManager(new StateAdapterSessionStore(new ConversationStateStore(state)));
    expect(await replica.getSession(key)).toMatchObject({ status: "running", turnCount: 4, shifuCourseContext: { courseKey: "course-a", contextPackId: "pack-a" } });
    await replica.bindActiveCourse(key, {
      courseKey: "course-b", courseEntityId: "course:U123:b", source: "user_confirmation",
      boundAt: "2026-07-11T02:00:00.000Z", contextPackId: null,
    });
    expect((await manager.getSession(key))?.shifuCourseContext?.courseKey).toBe("course-b");
  });

  test("deleting a session naturally clears its active course binding", async () => {
    const session = await manager.createSession("C123", "U123", "delete-course");
    const key = computeSessionKey(session);
    await manager.bindActiveCourse(key, {
      courseKey: "course-a", courseEntityId: "course:U123:a", source: "event",
      boundAt: "2026-07-11T01:00:00.000Z", contextPackId: null,
    });
    await manager.deleteSession(key);
    expect(await manager.getSession(key)).toBeNull();
  });

  test("serializes cross-replica partial updates so unrelated fields and binding both survive", async () => {
    let releaseWrite!: () => void;
    let writeStarted!: () => void;
    const writeStartedPromise = new Promise<void>((resolve) => { writeStarted = resolve; });
    const releasePromise = new Promise<void>((resolve) => { releaseWrite = resolve; });
    class PausingAdapter extends InMemoryStateAdapter {
      pause = false;
      override async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
        if (this.pause && key.startsWith("session:") && (value as ThreadSession).status === "running") {
          this.pause = false;
          writeStarted();
          await releasePromise;
        }
        await super.set(key, value, ttlMs);
      }
    }
    const adapter = new PausingAdapter();
    const first = new SessionManager(new StateAdapterSessionStore(new ConversationStateStore(adapter)));
    const second = new SessionManager(new StateAdapterSessionStore(new ConversationStateStore(adapter)));
    const session = await first.createSession("C123", "U123", "locked-update");
    const key = computeSessionKey(session);
    adapter.pause = true;
    const update = first.updateSession(key, { status: "running", model: "model-a" });
    await writeStartedPromise;
    const binding = second.bindActiveCourse(key, {
      courseKey: "course-a", courseEntityId: "course:U123:a", source: "resolver",
      boundAt: "2026-07-11T01:00:00.000Z", contextPackId: "pack-a",
    });
    releaseWrite();
    await Promise.all([update, binding]);
    expect(await first.getSession(key)).toMatchObject({
      status: "running", model: "model-a", shifuCourseContext: { courseKey: "course-a" },
    });
  });

  test("serializes delete against an in-flight update without resurrecting session or thread index", async () => {
    let releaseWrite!: () => void;
    let writeStarted!: () => void;
    const writeStartedPromise = new Promise<void>((resolve) => { writeStarted = resolve; });
    const releasePromise = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const releasedTokens: string[] = [];
    class PausingAdapter extends InMemoryStateAdapter {
      pause = false;
      override async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
        if (this.pause && key.startsWith("session:") && (value as ThreadSession).status === "running") {
          this.pause = false;
          writeStarted();
          await releasePromise;
        }
        await super.set(key, value, ttlMs);
      }
      override async releaseLock(lock: import("chat").Lock): Promise<void> {
        releasedTokens.push(lock.token);
        await super.releaseLock(lock);
      }
    }
    const adapter = new PausingAdapter();
    const first = new SessionManager(new StateAdapterSessionStore(new ConversationStateStore(adapter)));
    const second = new SessionManager(new StateAdapterSessionStore(new ConversationStateStore(adapter)));
    const session = await first.createSession("C123", "U123", "delete-race");
    const key = computeSessionKey(session);
    adapter.pause = true;
    const update = first.updateSession(key, { status: "running" });
    await writeStartedPromise;
    const deletion = second.deleteSession(key);
    await Promise.race([
      deletion,
      new Promise<void>((resolve) => setTimeout(resolve, 10)),
    ]);
    releaseWrite();
    await Promise.all([update, deletion]);

    expect(await first.getSession(key)).toBeNull();
    expect(await second.findSessionByThread("C123", "delete-race")).toBeNull();
    expect(await adapter.get(threadIndexKey("C123", "delete-race"))).toBeNull();
    expect(new Set(releasedTokens).size).toBe(releasedTokens.length);
    expect(releasedTokens).toHaveLength(2);
  });
});
