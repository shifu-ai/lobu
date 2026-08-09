import { createHash } from "node:crypto";
import { canonicalize } from "json-canonicalize";

export type RuntimeEnvironment = "staging" | "production";

export interface RuntimeCapabilitySnapshot {
  schemaVersion: 1;
  environment: RuntimeEnvironment;
  toolboxUserId: string;
  agentId: string;
  capabilities: string[];
  appliedReleaseId: string;
  appliedReleaseSequence: number;
  expiresAt: string;
  snapshotDigest: string;
}

export interface RuntimeCapabilitySnapshotRequest {
  environment: RuntimeEnvironment;
  toolboxUserId: string;
  agentId: string;
}

const RESPONSE_KEYS = [
  "agentId",
  "appliedReleaseId",
  "appliedReleaseSequence",
  "capabilities",
  "environment",
  "expiresAt",
  "schemaVersion",
  "snapshotDigest",
  "toolboxUserId",
] as const;

export function validateRuntimeCapabilitySnapshot(
  value: unknown,
  request: RuntimeCapabilitySnapshotRequest,
  now: Date,
): RuntimeCapabilitySnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("runtime capability snapshot response must be an object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== RESPONSE_KEYS.length ||
    keys.some((key, index) => key !== RESPONSE_KEYS[index])
  ) {
    throw new Error(
      "runtime capability snapshot response has an unknown or missing field",
    );
  }
  if (
    record.schemaVersion !== 1 ||
    record.environment !== request.environment ||
    record.toolboxUserId !== request.toolboxUserId ||
    record.agentId !== request.agentId ||
    typeof record.appliedReleaseId !== "string" ||
    !safeReleaseId(record.appliedReleaseId) ||
    !Number.isInteger(record.appliedReleaseSequence) ||
    (record.appliedReleaseSequence as number) <= 0 ||
    typeof record.expiresAt !== "string" ||
    record.expiresAt.length !== 24 ||
    !Number.isFinite(Date.parse(record.expiresAt)) ||
    new Date(Date.parse(record.expiresAt)).toISOString() !== record.expiresAt ||
    Date.parse(record.expiresAt) <= now.getTime() ||
    Date.parse(record.expiresAt) > now.getTime() + 60_000 ||
    typeof record.snapshotDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(record.snapshotDigest) ||
    !Array.isArray(record.capabilities) ||
    record.capabilities.length < 1 ||
    record.capabilities.length > 64 ||
    record.capabilities.some(
      (id) => typeof id !== "string" || !id || id.length > 200,
    )
  ) {
    throw new Error("runtime capability snapshot response is invalid or expired");
  }
  const { snapshotDigest, ...unsigned } = record;
  const expected = `sha256:${createHash("sha256").update(canonicalize(unsigned)).digest("hex")}`;
  if (snapshotDigest !== expected) {
    throw new Error("runtime capability snapshot digest mismatch");
  }
  return record as unknown as RuntimeCapabilitySnapshot;
}

function safeReleaseId(value: string): boolean {
  return value.length <= 200 && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value);
}
