import { parseAutomationConfirmationContext, type MessagePayload } from "@lobu/core";
import type { DbClient } from "../../db/client";
import { lookupDurableMessageCompletion } from "../routes/public/agent";
import type { SubagentTask } from "./types";

/** Retrieve the parent's actual reply, even when its SSE client is no longer connected. */
export async function getSubagentParentCompletion(sql: DbClient, task: SubagentTask) {
  const [row] = await sql<{ action_input: MessagePayload }>`SELECT action_input FROM runs
    WHERE id::text=${task.parentRunId} LIMIT 1`;
  const parent = row?.action_input;
  if (!parent || parent.agentId !== task.agentId || parent.userId !== task.userId ||
      parent.organizationId !== task.organizationId || parent.conversationId !== task.parentConversationId || !parent.channelId) return null;
  const messageId = `subagent-completion:${task.id}`;
  const completion = await lookupDurableMessageCompletion({
    organizationId: task.organizationId, agentId: task.agentId, userId: task.userId,
    conversationId: task.parentConversationId, channelId: parent.channelId, messageId,
  }, sql);
  if (!completion) return null;
  let confirmationContext;
  if (completion.status === "completed" && completion.awaitingHumanDecision) {
    const [event] = await sql<{ context: unknown }>`SELECT event.action_input->'customEvent'->'data'->'confirmationContext' AS context
      FROM runs event JOIN runs source ON source.id::text=event.action_input->'platformMetadata'->>'sourceRunId'
      WHERE event.queue_name='thread_response' AND source.queue_name='messages'
        AND source.action_input->>'messageId'=${messageId}
        AND event.action_input->>'userId'=${task.userId} AND event.action_input->>'agentId'=${task.agentId}
        AND event.action_input->>'organizationId'=${task.organizationId}
        AND event.action_input->>'conversationId'=${task.parentConversationId}
        AND event.action_input->'customEvent'->>'name'='shifu.work_state'
      ORDER BY event.id DESC LIMIT 1`;
    if (event?.context) {
      try { confirmationContext = parseAutomationConfirmationContext(event.context); } catch { /* Not an automation confirmation. */ }
    }
  }
  return {
    messageId: completion.processedMessageIds.filter(id => id.startsWith("subagent-completion:")).sort()[0] ?? messageId,
    conversationId: task.parentConversationId, status: completion.status,
    ...(confirmationContext ? { confirmationContext } : {}),
    // Do not expose raw provider error strings to LINE.
    ...(completion.status === "completed" ? { text: completion.finalText,
      awaitingHumanDecision: completion.awaitingHumanDecision ?? false } : { errorCode: "parent_execution_failed" }),
  };
}
