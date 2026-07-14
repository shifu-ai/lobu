/**
 * Postgres-backed `pending-tool:<requestId>` store. Backed by the
 * `oauth_states` table with a `pending-tool` scope so the MCP proxy
 * (writer) and the interaction bridge / CLI gateway (reader) can hand off
 * blocked-tool invocations through a single primitive.
 */

import { getDb } from "../../../db/client.js";
import type { TrustedCourseToolScope } from "../../orchestration/course-tool-policy.js";
import type { ReleaseCapabilityState } from "@lobu/core";
import { createHash } from "node:crypto";
import { canonicalize } from "json-canonicalize";

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
	releaseState?: ReleaseCapabilityState;
	releaseBinding?: {
		routerMode: "semantic";
		effectiveInventoryFingerprint: string;
		releaseId: string;
		releaseSequence: number;
		snapshotDigest: string;
		authorizationExpiresAt: string;
		stableAuthorizationDigest: string;
		eligibilityBindingDigest: string;
	};
	/** Bounded non-secret identity used to re-sign an internal approval replay. */
	originalRunIdentity?: {
		runId: number;
		deploymentName: string;
	};
	personalReminderDeliveryIntent?: true;
}

export function stableToolEligibilityDigest(input: {
	mcpId: string;
	toolName: string;
	connectionId?: string;
	expectedMcpIdentity?: PendingToolInvocation["expectedMcpIdentity"];
	courseToolScope?: TrustedCourseToolScope;
	effectiveInventoryFingerprint: string;
	stableAuthorizationDigest: string;
}): string {
	return createHash("sha256")
		.update(canonicalize({
			mcpId: input.mcpId,
			toolName: input.toolName,
			connectionId: input.connectionId ?? null,
			expectedMcpIdentity: input.expectedMcpIdentity ?? null,
			courseToolScope: input.courseToolScope ?? null,
			effectiveInventoryFingerprint: input.effectiveInventoryFingerprint,
			stableAuthorizationDigest: input.stableAuthorizationDigest,
		}))
		.digest("hex");
}

export function stableReleaseAuthorizationDigest(
	claim: import("@lobu/core").ReleaseCapabilityClaim,
): string {
	return createHash("sha256")
		.update(canonicalize({
			environment: claim.environment,
			toolboxUserId: claim.toolboxUserId,
			agentId: claim.agentId,
			releaseId: claim.releaseId,
			releaseSequence: claim.releaseSequence,
			capabilityIds: [...claim.capabilityIds].sort(),
		}))
		.digest("hex");
}

export interface PendingToolExecutionOptions {
  courseToolScope?: TrustedCourseToolScope;
  expectedMcpIdentity?: NonNullable<
    PendingToolInvocation["expectedMcpIdentity"]
  >;
  channelId?: string;
  organizationId?: string;
	releaseState?: ReleaseCapabilityState;
	approvalReplay: true;
	originalRunIdentity?: NonNullable<PendingToolInvocation["originalRunIdentity"]>;
	conversationId?: string;
	personalReminderDeliveryIntent?: true;
}

/**
 * Preserve the security context captured at discovery time when an approved
 * invocation is replayed. Omit absent fields instead of writing undefined over
 * an execution path's existing scope. Every claimed row carries the replay
 * marker so internal MCPs can fail closed when legacy rows lack run identity;
 * external MCPs ignore the marker and remain backward compatible.
 */
export function buildPendingToolExecutionOptions(
	pending: PendingToolInvocation,
): PendingToolExecutionOptions | undefined {
  const options: PendingToolExecutionOptions = {
		approvalReplay: true,
    ...(pending.courseToolScope
      ? { courseToolScope: pending.courseToolScope }
      : {}),
    ...(pending.expectedMcpIdentity
      ? { expectedMcpIdentity: pending.expectedMcpIdentity }
      : {}),
    ...(pending.channelId ? { channelId: pending.channelId } : {}),
		...(pending.organizationId
			? { organizationId: pending.organizationId }
      : {}),
		...(pending.releaseState ? { releaseState: pending.releaseState } : {}),
		...(pending.originalRunIdentity
			? { originalRunIdentity: pending.originalRunIdentity }
			: {}),
		...(pending.conversationId ? { conversationId: pending.conversationId } : {}),
		...(pending.personalReminderDeliveryIntent
			? { personalReminderDeliveryIntent: true as const }
			: {}),
  };
	return options;
}

export async function storePendingTool(
  requestId: string,
  invocation: PendingToolInvocation,
	ttlSeconds: number,
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
	requestId: string,
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
	return (rows[0] as { payload: PendingToolInvocation }).payload ?? null;
}

/**
 * Atomically fetch and delete a pending tool invocation. Used by the
 * interaction bridge / CLI approve handler to claim the row exactly
 * once — Slack/Telegram webhook retries that arrive after the first
 * click see null and no-op.
 */
export async function takePendingTool(
	requestId: string,
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
	return (rows[0] as { payload: PendingToolInvocation }).payload ?? null;
}
