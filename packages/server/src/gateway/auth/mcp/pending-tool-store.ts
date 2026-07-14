/**
 * Postgres-backed `pending-tool:<requestId>` store. Backed by the
 * `oauth_states` table with a `pending-tool` scope so the MCP proxy
 * (writer) and the interaction bridge / CLI gateway (reader) can hand off
 * blocked-tool invocations through a single primitive.
 */

import { getDb } from "../../../db/client.js";
import type { TrustedCourseToolScope } from "../../orchestration/course-tool-policy.js";
import type { ReleaseCapabilityClaim } from "@lobu/core";

const SCOPE = "pending-tool";

export interface PendingToolInvocation {
  mcpId: string;
  toolName: string;
  args: Record<string, unknown>;
  agentId: string;
  userId: string;
  organizationId?: string;
  channelId?: string;
  conversationId?: string;
  teamId?: string;
  connectionId?: string;
  originMessageId?: string;
  processedMessageIds?: string[];
  courseToolScope?: TrustedCourseToolScope;
  expectedMcpIdentity?: {
    upstreamOrigin: string;
    configSource: "global" | "agent" | "derived";
    configDigest: string;
  };
  releaseCapability?: ReleaseCapabilityClaim;
}

export interface PendingToolExecutionOptions {
  courseToolScope?: TrustedCourseToolScope;
  expectedMcpIdentity?: NonNullable<
    PendingToolInvocation["expectedMcpIdentity"]
  >;
  channelId?: string;
  organizationId?: string;
  releaseCapability?: ReleaseCapabilityClaim;
}

/**
 * Preserve the security context captured at discovery time when an approved
 * invocation is replayed. Omit absent fields instead of writing undefined over
 * an execution path's existing scope, and omit the options argument entirely
 * for legacy pending rows that carry no scoped context.
 */
export function buildPendingToolExecutionOptions(
  pending: PendingToolInvocation
): PendingToolExecutionOptions | undefined {
  const options: PendingToolExecutionOptions = {
    ...(pending.courseToolScope
      ? { courseToolScope: pending.courseToolScope }
      : {}),
    ...(pending.expectedMcpIdentity
      ? { expectedMcpIdentity: pending.expectedMcpIdentity }
      : {}),
    ...(pending.channelId ? { channelId: pending.channelId } : {}),
    ...(pending.organizationId ? { organizationId: pending.organizationId } : {}),
    ...(pending.releaseCapability
      ? { releaseCapability: pending.releaseCapability }
      : {}),
  };
  return Object.keys(options).length > 0 ? options : undefined;
}

export async function storePendingTool(
  requestId: string,
  invocation: PendingToolInvocation,
  ttlSeconds: number
): Promise<void> {
  const sql = getDb();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  await sql`
    INSERT INTO oauth_states (id, scope, payload, expires_at)
    VALUES (${requestId}, ${SCOPE}, ${sql.json(invocation as object)}, ${expiresAt})
    ON CONFLICT (id) DO UPDATE SET
      scope = EXCLUDED.scope,
      payload = EXCLUDED.payload,
      expires_at = EXCLUDED.expires_at
  `;
}

/**
 * Fetch a pending tool invocation without claiming it. Approval services use
 * this to validate caller identity before the destructive `takePendingTool`.
 */
export async function getPendingTool(
  requestId: string
): Promise<PendingToolInvocation | null> {
  const sql = getDb();
  const rows = await sql`
    SELECT payload
    FROM oauth_states
    WHERE id = ${requestId}
      AND scope = ${SCOPE}
      AND expires_at > now()
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  return ((rows[0] as { payload: PendingToolInvocation }).payload) ?? null;
}

/**
 * Atomically fetch and delete a pending tool invocation. Used by the
 * interaction bridge / CLI approve handler to claim the row exactly
 * once — Slack/Telegram webhook retries that arrive after the first
 * click see null and no-op.
 */
export async function takePendingTool(
  requestId: string
): Promise<PendingToolInvocation | null> {
  const sql = getDb();
  const rows = await sql`
    DELETE FROM oauth_states
    WHERE id = ${requestId}
      AND scope = ${SCOPE}
      AND expires_at > now()
    RETURNING payload
  `;
  if (rows.length === 0) return null;
  return ((rows[0] as { payload: PendingToolInvocation }).payload) ?? null;
}
