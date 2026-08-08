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
		routerMode: "legacy" | "shadow" | "semantic";
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

/**
 * Identity of a release authorization — deliberately excludes anything that
 * changes when the same authorization is re-minted.
 *
 * `expiresAt` and `snapshotDigest` are NOT hashed. Toolbox derives
 * `expiresAt = min(now + 60s, earliestCarrierExpiry)` and then computes
 * `snapshotDigest` over the whole snapshot *including* that expiry, so both
 * fields move on every mint. Hashing either of them made this digest a moving
 * target: a pending approval stored digest D(T1), and revalidation — which
 * re-mints with `bypassCache: true` — computed D(T2) ≠ D(T1). Every
 * release-bound tool approval therefore failed as `approval_inventory_stale`,
 * 100% of the time, until 2026-08-07.
 *
 * Liveness is a separate concern and is checked directly against the freshly
 * minted claim (`isPendingReleaseBindingCurrent`), not smuggled into an
 * identity hash. Nothing is lost by dropping `snapshotDigest`: Toolbox derives
 * it from the same release identity and capability set that are hashed here,
 * plus the expiry we intentionally ignore.
 */
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

export function pendingToolContinuationDigest(
	invocation: PendingToolInvocation,
): string {
	return createHash("sha256").update(canonicalize(invocation)).digest("hex");
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
	approvalReplayAuthorization?: {
		revalidate(): Promise<boolean>;
		onExecutionCompleted?(): Promise<void>;
	};
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

/** Atomically claims only the exact payload that was previously validated. */
export async function takePendingToolIfUnchanged(
	requestId: string,
	expected: PendingToolInvocation,
	expectedDigest: string,
): Promise<PendingToolInvocation | null> {
	if (pendingToolContinuationDigest(expected) !== expectedDigest) return null;
	const sql = getDb();
	const rows = await sql`
		DELETE FROM oauth_states
		WHERE id = ${requestId}
		  AND scope = ${SCOPE}
		  AND expires_at > now()
		  AND payload = ${sql.json(expected as object)}::jsonb
		RETURNING payload
	`;
	if (rows.length === 0) return null;
	const claimed = (rows[0] as { payload: PendingToolInvocation }).payload;
	return pendingToolContinuationDigest(claimed) === expectedDigest
		? claimed
		: null;
}
