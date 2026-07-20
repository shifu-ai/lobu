import { createHash } from "node:crypto";
import type { McpToolDef, ReleaseCapabilityState } from "@lobu/core";
import { qualifiedToolKey, toolIdentityKey } from "./tool-descriptor";
import { snapshotToolsByMcp } from "./tool-inventory-snapshot";

export const PERSONAL_REMINDER_DELIVERY_CAPABILITY =
  "personal_reminder_delivery.v1";

const MAX_DISCOVERED_TOOLS = 4096;

export type EffectiveToolBlockedReason =
  | "not_discovered"
  | "capability_inactive"
  | "snapshot_missing"
  | "snapshot_expired"
  | "policy_denied"
  | "not_connected"
  | "untrusted_provenance"
  | "duplicate_identity"
  | "approval_required"
  | "clarification_required";

export interface EffectiveToolBlockedEntry {
  readonly toolKey: string;
  readonly reason: EffectiveToolBlockedReason;
}

export interface EffectiveToolReleaseProvenance {
  readonly status: ReleaseCapabilityState["status"];
  readonly environment?: "staging" | "production";
  readonly releaseId?: string;
  readonly releaseSequence?: number;
  readonly snapshotDigest?: string;
  readonly expiresAt?: string;
  readonly inactiveReason?:
    | "receipt_invalid"
    | "snapshot_unavailable"
    | "capability_expired";
}

export interface EffectiveToolBehavior {
  readonly capabilityId: string;
  readonly state:
    | "legacy_compatible"
    | "active"
    | "capability_inactive"
    | "snapshot_missing"
    | "snapshot_expired";
  /** Whether the Phase-1 execution contract may run this turn. */
  readonly executable: boolean;
  /** Whether the prompt may claim signed release readiness/delivery. */
  readonly mayPromiseDelivery: boolean;
}

export interface EffectiveToolInventory {
  /** Immutable scoped-discovery snapshot. Never synthesized from release data. */
  readonly scopedTools: Record<string, McpToolDef[]>;
  /** Base-callable tools after the complete eligibility intersection. */
  readonly toolsByMcp: Record<string, McpToolDef[]>;
  /** Sorted external keys (`mcpId/toolName`) used by every final dispatcher. */
  readonly allowedToolKeys: readonly string[];
  readonly blocked: readonly EffectiveToolBlockedEntry[];
  readonly releaseProvenance: EffectiveToolReleaseProvenance;
  readonly behaviors: {
    readonly personalReminderDelivery: EffectiveToolBehavior;
  };
  readonly fingerprint: string;
  /**
   * sha256 hex over the canonicalized sorted-unique tool names only. This is
   * the wire contract for the execution-events inventory snapshot: the
   * gateway recomputes exactly this from the reported names
   * (`canonicalToolInventory` in release-assurance-readback.ts) and rejects
   * the write on mismatch. `fingerprint` above hashes the full inventory
   * structure and must never be sent as the snapshot fingerprint.
   */
  readonly namesFingerprint: string;
}

export interface BuildEffectiveToolInventoryParams {
  scopedTools: Record<string, McpToolDef[]>;
  releaseState: ReleaseCapabilityState;
  connectedMcpIds?: Iterable<string>;
  grantedToolKeys?: Iterable<string>;
  isPolicyAllowed?: (
    toolKey: string,
    toolName: string,
    mcpId: string
  ) => boolean;
  /** Explicit whole-tool release gates. Behavior capabilities stay separate. */
  releaseCapabilityByToolKey?: Readonly<Record<string, string>>;
  untrustedProvenanceToolKeys?: Iterable<string>;
  approvalRequiredToolKeys?: Iterable<string>;
  clarificationRequiredToolKeys?: Iterable<string>;
  now?: Date;
}

function setFrom(values: Iterable<string> | undefined): Set<string> | null {
  return values === undefined ? null : new Set(values);
}

function identitySetFrom(
  values: Iterable<string> | undefined,
  discovered: ReadonlyMap<
    string,
    { mcpId: string; toolName: string; tool: McpToolDef }
  >
): Set<string> | null {
  if (values === undefined) return null;
  const input = new Set(values);
  return new Set(
    [...discovered.entries()]
      .filter(
        ([identityKey, entry]) =>
          input.has(identityKey) ||
          input.has(qualifiedToolKey(entry.mcpId, entry.toolName))
      )
      .map(([identityKey]) => identityKey)
  );
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

function releaseProvenance(
  state: ReleaseCapabilityState
): EffectiveToolReleaseProvenance {
  if (state.status === "legacy_unenrolled") {
    return Object.freeze({ status: state.status });
  }
  if (state.status === "enrolled_inactive") {
    return Object.freeze({
      status: state.status,
      environment: state.environment,
      inactiveReason: state.reason,
    });
  }
  return Object.freeze({
    status: state.status,
    environment: state.claim.environment,
    releaseId: state.claim.releaseId,
    releaseSequence: state.claim.releaseSequence,
    snapshotDigest: state.claim.snapshotDigest,
    expiresAt: state.claim.expiresAt,
  });
}

function inactiveReleaseReason(
  state: ReleaseCapabilityState,
  now: Date
): "snapshot_missing" | "snapshot_expired" | "capability_inactive" | null {
  if (state.status === "legacy_unenrolled") return null;
  if (state.status === "enrolled_inactive") {
    if (state.reason === "snapshot_unavailable") return "snapshot_missing";
    if (state.reason === "capability_expired") return "snapshot_expired";
    return "capability_inactive";
  }
  const expiresAt = Date.parse(state.claim.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= now.getTime()
    ? "snapshot_expired"
    : null;
}

function hasActiveCapability(
  state: ReleaseCapabilityState,
  capabilityId: string,
  now: Date
): boolean {
  return (
    state.status === "active" &&
    Date.parse(state.claim.expiresAt) > now.getTime() &&
    state.claim.capabilityIds.includes(capabilityId)
  );
}

function personalReminderBehavior(
  state: ReleaseCapabilityState,
  now: Date
): EffectiveToolBehavior {
  const base = { capabilityId: PERSONAL_REMINDER_DELIVERY_CAPABILITY } as const;
  if (state.status === "legacy_unenrolled") {
    return Object.freeze({
      ...base,
      state: "legacy_compatible",
      executable: true,
      mayPromiseDelivery: false,
    });
  }
  const inactive = inactiveReleaseReason(state, now);
  if (
    !inactive &&
    hasActiveCapability(state, PERSONAL_REMINDER_DELIVERY_CAPABILITY, now)
  ) {
    return Object.freeze({
      ...base,
      state: "active",
      executable: true,
      mayPromiseDelivery: true,
    });
  }
  return Object.freeze({
    ...base,
    state: inactive ?? "capability_inactive",
    executable: false,
    mayPromiseDelivery: false,
  });
}

function freezeToolsByMcp(
  entries: ReadonlyArray<readonly [string, McpToolDef]>
): Record<string, McpToolDef[]> {
  const grouped: Record<string, McpToolDef[]> = {};
  for (const [mcpId, tool] of entries) {
    const tools = grouped[mcpId] ?? [];
    tools.push(tool);
    grouped[mcpId] = tools;
  }
  return Object.freeze(
    Object.fromEntries(
      Object.entries(grouped).map(([mcpId, tools]) => [
        mcpId,
        Object.freeze(tools),
      ])
    )
  ) as Record<string, McpToolDef[]>;
}

/**
 * Builds the one turn-local eligibility boundary. This owns no descriptor or
 * retrieval cache: the raw immutable substrate is shared with the router via
 * `snapshotToolsByMcp`.
 */
export function buildEffectiveToolInventory(
  params: BuildEffectiveToolInventoryParams
): EffectiveToolInventory {
  const rawScopedTools = snapshotToolsByMcp(params.scopedTools);
  const discoveredGroups = new Map<
    string,
    Array<{
      mcpId: string;
      toolName: string;
      tool: McpToolDef;
      canonical: string;
    }>
  >();
  let rawDiscoveredCount = 0;
  for (const [mcpId, tools] of Object.entries(rawScopedTools)) {
    for (const tool of tools) {
      const toolName = tool.name?.trim();
      if (!toolName) continue;
      rawDiscoveredCount++;
      const identityKey = toolIdentityKey(mcpId, toolName);
      const normalizedTool =
        tool.name === toolName
          ? tool
          : Object.freeze({ ...tool, name: toolName });
      const group = discoveredGroups.get(identityKey) ?? [];
      group.push({
        mcpId,
        toolName,
        tool: normalizedTool,
        canonical: canonicalJson(normalizedTool),
      });
      discoveredGroups.set(identityKey, group);
    }
  }
  if (rawDiscoveredCount > MAX_DISCOVERED_TOOLS) {
    throw new Error(
      `effective tool inventory exceeds ${MAX_DISCOVERED_TOOLS} discovered tools`
    );
  }
  const duplicateEvidence: Array<readonly [string, readonly string[]]> = [];
  const discovered = new Map<
    string,
    { mcpId: string; toolName: string; tool: McpToolDef }
  >();
  for (const [identityKey, group] of [...discoveredGroups.entries()].sort(
    ([left], [right]) => left.localeCompare(right)
  )) {
    group.sort((left, right) => left.canonical.localeCompare(right.canonical));
    const representative = group[0];
    if (!representative) continue;
    discovered.set(identityKey, representative);
    if (group.length > 1) {
      duplicateEvidence.push(
        Object.freeze([
          identityKey,
          Object.freeze(group.map((entry) => entry.canonical)),
        ] as const)
      );
    }
  }
  const duplicateIdentityKeys = new Set(duplicateEvidence.map(([key]) => key));
  const scopedTools = freezeToolsByMcp(
    [...discovered.values()].map((entry) =>
      Object.freeze([entry.mcpId, entry.tool] as const)
    )
  );

  const now = params.now ?? new Date();
  const connected = setFrom(params.connectedMcpIds);
  const granted = identitySetFrom(params.grantedToolKeys, discovered);
  const untrusted = identitySetFrom(
    params.untrustedProvenanceToolKeys,
    discovered
  );
  const approvalRequired = identitySetFrom(
    params.approvalRequiredToolKeys,
    discovered
  );
  const clarificationRequired = identitySetFrom(
    params.clarificationRequiredToolKeys,
    discovered
  );
  const blocked: EffectiveToolBlockedEntry[] = [];
  const allowed: Array<readonly [string, McpToolDef]> = [];
  const releaseInactive = inactiveReleaseReason(params.releaseState, now);

  for (const [identityKey, entry] of [...discovered.entries()].sort(
    ([a], [b]) => a.localeCompare(b)
  )) {
    const toolKey = qualifiedToolKey(entry.mcpId, entry.toolName);
    let reason: EffectiveToolBlockedReason | undefined;
    if (duplicateIdentityKeys.has(identityKey)) reason = "duplicate_identity";
    else if (connected && !connected.has(entry.mcpId)) reason = "not_connected";
    else if (granted && !granted.has(identityKey)) reason = "policy_denied";
    else if (untrusted?.has(identityKey)) reason = "untrusted_provenance";
    else if (
      params.isPolicyAllowed &&
      !params.isPolicyAllowed(toolKey, entry.toolName, entry.mcpId)
    )
      reason = "policy_denied";
    else {
      const requiredCapability =
        params.releaseCapabilityByToolKey?.[identityKey] ??
        params.releaseCapabilityByToolKey?.[toolKey];
      if (requiredCapability) {
        if (releaseInactive) reason = releaseInactive;
        else if (
          params.releaseState.status !== "legacy_unenrolled" &&
          !hasActiveCapability(params.releaseState, requiredCapability, now)
        )
          reason = "capability_inactive";
      }
    }
    if (!reason && approvalRequired?.has(identityKey))
      reason = "approval_required";
    if (!reason && clarificationRequired?.has(identityKey))
      reason = "clarification_required";

    if (reason) blocked.push(Object.freeze({ toolKey, reason }));
    else allowed.push(Object.freeze([entry.mcpId, entry.tool] as const));
  }

  const discoveredExternalKeys = new Set(
    [...discovered.values()].map((entry) =>
      qualifiedToolKey(entry.mcpId, entry.toolName)
    )
  );
  for (const toolKey of Object.keys(
    params.releaseCapabilityByToolKey ?? {}
  ).sort()) {
    if (!discovered.has(toolKey) && !discoveredExternalKeys.has(toolKey)) {
      blocked.push(Object.freeze({ toolKey, reason: "not_discovered" }));
    }
  }
  blocked.sort((a, b) => a.toolKey.localeCompare(b.toolKey));

  const allowedToolKeys = Object.freeze(
    allowed.map(([mcpId, tool]) => qualifiedToolKey(mcpId, tool.name))
  );
  const provenance = releaseProvenance(params.releaseState);
  const behaviors = Object.freeze({
    personalReminderDelivery: personalReminderBehavior(
      params.releaseState,
      now
    ),
  });
  const fingerprintInput = {
    tools: [...discovered.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, entry.tool]),
    allowedToolKeys,
    blocked,
    releaseProvenance: provenance,
    behaviors,
    duplicateEvidence,
  };
  const fingerprint = createHash("sha256")
    .update(canonicalJson(fingerprintInput))
    .digest("hex");
  // Mirror of the server's canonicalToolInventory (sorted unique trimmed
  // names, canonical JSON, sha256) — the two must stay in lockstep or the
  // gateway rejects every inventory snapshot write.
  const namesFingerprint = createHash("sha256")
    .update(
      canonicalJson(
        [...new Set(allowedToolKeys.map((name) => name.trim()))].sort()
      )
    )
    .digest("hex");

  return Object.freeze({
    scopedTools,
    toolsByMcp: freezeToolsByMcp(allowed),
    allowedToolKeys,
    blocked: Object.freeze(blocked),
    releaseProvenance: provenance,
    behaviors,
    fingerprint,
    namesFingerprint,
  });
}

export function isEffectiveToolAllowed(
  inventory: EffectiveToolInventory,
  mcpId: string,
  toolName: string
): boolean {
  return inventory.allowedToolKeys.includes(qualifiedToolKey(mcpId, toolName));
}

export function buildPersonalReminderDeliveryInstructions(
  inventory: EffectiveToolInventory
): string {
  if (
    !inventory.behaviors.personalReminderDelivery.mayPromiseDelivery ||
    !isEffectiveToolAllowed(inventory, "lobu-memory", "manage_schedules")
  ) {
    return "";
  }
  return [
    "## Personal Reminder Delivery",
    "For an explicit conversational personal reminder, use `manage_schedules`; the reminder will return to this personal-agent conversation at the scheduled time.",
  ].join("\n");
}
