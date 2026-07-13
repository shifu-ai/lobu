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
  if (!args.userId) return null;
  try {
    const rows = (await deps.sql`
      SELECT conversation_id FROM (
        SELECT DISTINCT ON (action_input->>'conversationId')
               action_input->>'conversationId' AS conversation_id,
               max(created_at) OVER (PARTITION BY action_input->>'conversationId') AS last_at
        FROM runs
        WHERE run_type = 'chat_message'
          AND status = 'completed'
          AND action_input->>'agentId' = ${args.agentId}
          AND action_input->>'userId' = ${args.userId}
          AND coalesce(action_input->'platformMetadata'->>'source', '') <> 'scheduled-job'
          AND created_at > now() - interval '30 days'
        ORDER BY action_input->>'conversationId', last_at DESC
      ) t
      ORDER BY last_at DESC
      LIMIT 5
    `) as Array<{ conversation_id: string | null }>;

    const candidates = rows.filter(
      (r): r is { conversation_id: string } => Boolean(r.conversation_id)
    );

    for (const row of candidates) {
      const session = await deps.sessionManager.getSession(row.conversation_id);
      if (session) return row.conversation_id;
    }
    return null;
  } catch (error) {
    logger.warn({ error, agentId: args.agentId }, "resolveWakeThreadId failed; falling back");
    return null;
  }
}

/** Prefix the machine marker. Mechanical completion delivery happens after the worker finishes. */
export function buildScheduledWakeMessage(prompt: string): string {
  return prompt.startsWith(WAKE_PREFIX) ? prompt : `${WAKE_PREFIX}${prompt}`;
}
