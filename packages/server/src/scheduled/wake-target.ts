/**
 * Scheduled-wake target resolution (shifu fork).
 *
 * Upstream wake_agent always mints a fresh thread on the synthetic "api"
 * platform; in the ShiFu headless deployment that thread has no consumer
 * (coworkers only see LINE) and fresh-thread turns have failed worker
 * startup in production. Instead, wake into the user's most recent live
 * conversation — the exact path interactive turns already use — and fall
 * back to the upstream behaviour only when no live conversation exists.
 */
import { createLogger } from "@lobu/core";
import type { ISessionManager } from "../gateway/session.js";

const logger = createLogger("wake-target");

export type SqlLike = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<unknown[]>;

const WAKE_PREFIX = "[排程任務自動觸發] ";

const DELIVERY_INSTRUCTION =
  "\n\n(系統指示:這是排程觸發的背景任務,使用者現在不在對話中。" +
  "完成任務後,請呼叫 shifu-toolbox 的 send_daily_digest 工具,把要告訴使用者的內容推送到他的 LINE。" +
  "如果推送失敗,把完整內容留在本對話即可,不要重試超過一次。)";

/**
 * Find the most recent conversation for (agentId, userId) that still has a
 * live session. Candidates come from completed chat_message runs, excluding
 * scheduled-job turns so wakes never chain onto other wakes. Any error
 * degrades to null — the caller falls back to minting a fresh thread.
 */
export async function resolveWakeThreadId(
  deps: { sql: SqlLike; sessionManager: Pick<ISessionManager, "getSession"> },
  args: { agentId: string; userId?: string | null }
): Promise<string | null> {
  try {
    const rows = (await deps.sql`
      SELECT DISTINCT ON (action_input->>'conversationId')
             action_input->>'conversationId' AS conversation_id,
             max(created_at) OVER (PARTITION BY action_input->>'conversationId') AS last_at
      FROM runs
      WHERE run_type = 'chat_message'
        AND status = 'completed'
        AND action_input->>'agentId' = ${args.agentId}
        AND (${args.userId ?? null}::text IS NULL OR action_input->>'userId' = ${args.userId ?? null})
        AND coalesce(action_input->'platformMetadata'->>'source', '') <> 'scheduled-job'
      ORDER BY action_input->>'conversationId', last_at DESC
    `) as Array<{ conversation_id: string | null; last_at?: string }>;

    const candidates = rows
      .filter((r): r is { conversation_id: string } => Boolean(r.conversation_id))
      .sort((a, b) =>
        String((b as { last_at?: string }).last_at ?? "").localeCompare(
          String((a as { last_at?: string }).last_at ?? "")
        )
      );

    for (const row of candidates.slice(0, 5)) {
      const session = await deps.sessionManager.getSession(row.conversation_id);
      if (session) return row.conversation_id;
    }
    return null;
  } catch (error) {
    logger.warn({ error, agentId: args.agentId }, "resolveWakeThreadId failed; falling back");
    return null;
  }
}

/** Prefix the machine marker and append the LINE delivery instruction. Idempotent on the prefix. */
export function buildScheduledWakeMessage(prompt: string): string {
  const body = prompt.startsWith(WAKE_PREFIX) ? prompt : `${WAKE_PREFIX}${prompt}`;
  return body.includes(DELIVERY_INSTRUCTION) ? body : `${body}${DELIVERY_INSTRUCTION}`;
}
