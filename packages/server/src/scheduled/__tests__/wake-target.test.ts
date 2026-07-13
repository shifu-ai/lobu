import { describe, expect, mock, test } from "bun:test";
import {
  buildScheduledWakeMessage,
  resolveWakeThreadId,
} from "../wake-target";

function sqlReturning(rows: unknown[]) {
  return (async () => rows) as unknown as Parameters<typeof resolveWakeThreadId>[0]["sql"];
  // 簡化:測試裡 sql 不解析 template,直接回固定 rows
}

describe("resolveWakeThreadId", () => {
  const AGENT = "shifu-u-abc123";
  const USER = "toolbox-user-1";

  test("returns the most recent live conversation for the agent+user", async () => {
    const sql = sqlReturning([
      { conversation_id: `${AGENT}_${USER}_thread-new` },
      { conversation_id: `${AGENT}_${USER}_thread-old` },
    ]);
    const sessionManager = {
      getSession: mock(async (key: string) =>
        key === `${AGENT}_${USER}_thread-new` ? { conversationId: key } : null
      ),
    };
    const threadId = await resolveWakeThreadId({ sql, sessionManager }, {
      agentId: AGENT,
      userId: USER,
    });
    expect(threadId).toBe(`${AGENT}_${USER}_thread-new`);
  });

  test("skips conversations whose session no longer exists, falls through to older", async () => {
    const sql = sqlReturning([
      { conversation_id: "dead-thread" },
      { conversation_id: "live-thread" },
    ]);
    const sessionManager = {
      getSession: mock(async (key: string) =>
        key === "live-thread" ? { conversationId: key } : null
      ),
    };
    const threadId = await resolveWakeThreadId({ sql, sessionManager }, {
      agentId: AGENT,
      userId: USER,
    });
    expect(threadId).toBe("live-thread");
  });

  test("returns null when no candidate has a live session", async () => {
    const sql = sqlReturning([{ conversation_id: "dead-1" }]);
    const sessionManager = { getSession: mock(async () => null) };
    const threadId = await resolveWakeThreadId({ sql, sessionManager }, {
      agentId: AGENT,
      userId: USER,
    });
    expect(threadId).toBeNull();
  });

  test("returns null when the query yields no rows", async () => {
    const sql = sqlReturning([]);
    const sessionManager = { getSession: mock(async () => null) };
    const threadId = await resolveWakeThreadId({ sql, sessionManager }, {
      agentId: AGENT,
      userId: USER,
    });
    expect(threadId).toBeNull();
  });

  test("sql errors degrade to null (fallback to new thread), never throw", async () => {
    const sql = (async () => {
      throw new Error("db down");
    }) as unknown as Parameters<typeof resolveWakeThreadId>[0]["sql"];
    const sessionManager = { getSession: mock(async () => null) };
    const threadId = await resolveWakeThreadId({ sql, sessionManager }, {
      agentId: AGENT,
      userId: USER,
    });
    expect(threadId).toBeNull();
  });

  test("userId omitted/null returns null without ever calling sql", async () => {
    const sql = mock(async () => {
      throw new Error("sql should not be called when userId is missing");
    }) as unknown as Parameters<typeof resolveWakeThreadId>[0]["sql"];
    const sessionManager = { getSession: mock(async () => null) };

    const withoutUserId = await resolveWakeThreadId({ sql, sessionManager }, {
      agentId: AGENT,
    });
    expect(withoutUserId).toBeNull();

    const withNullUserId = await resolveWakeThreadId({ sql, sessionManager }, {
      agentId: AGENT,
      userId: null,
    });
    expect(withNullUserId).toBeNull();

    expect(sql).not.toHaveBeenCalled();
  });
});

describe("buildScheduledWakeMessage", () => {
  test("prefixes the machine marker without delegating delivery to an agent tool", () => {
    const msg = buildScheduledWakeMessage("提醒使用者該喝水了");
    expect(msg.startsWith("[排程任務自動觸發] 提醒使用者該喝水了")).toBe(true);
    expect(msg).not.toContain("send_daily_digest");
    expect(msg).not.toContain("推送");
  });

  test("does not double-prefix an already-marked prompt", () => {
    const once = buildScheduledWakeMessage("x");
    const twice = buildScheduledWakeMessage(once);
    expect(twice.split("[排程任務自動觸發]").length).toBe(2);
  });
});
