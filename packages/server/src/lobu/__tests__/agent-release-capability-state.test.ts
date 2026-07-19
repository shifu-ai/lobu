import { createHash } from "node:crypto";
import { canonicalize } from "json-canonicalize";
import { describe, expect, test } from "bun:test";
import { readAgentReleaseCapabilityState } from "../agent-release-service.js";

const snapshot = {
  schemaVersion: 1 as const,
  environment: "production" as const,
  toolboxUserId: "user-1",
  agentId: "agent-1",
  capabilities: ["personal_reminder_delivery.v1"],
  appliedReleaseId: "release-3",
  appliedReleaseSequence: 3,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  snapshotDigest: `sha256:${"a".repeat(64)}`,
};

function sqlReturning(row: unknown) {
  const sql = async () => row ? [row] : [];
  sql.json = (value: unknown) => JSON.stringify(value);
  return sql as never;
}

const validReceipt = {
  owner_user_id: "user-1",
  environment: "production",
  desired_release_id: "release-3",
  desired_release_sequence: 3,
  desired_feed_sequence: 9,
  applied_release_id: "release-3",
  applied_release_sequence: 3,
  applied_feed_sequence: 9,
  status: "applied",
  identity_md: null,
  soul_md: null,
  user_md: null,
  model_selection: {},
  tools_config: {},
  settings_hash: `sha256:${createHash("sha256").update(canonicalize({
    identityMd: "", soulMd: "", userMd: "", modelSelection: {}, toolsConfig: {},
  })).digest("hex")}`,
};

describe("agent release capability state", () => {
  test("classifies no durable receipt as legacy unenrolled", async () => {
    await expect(readAgentReleaseCapabilityState({ organizationId: "org-1", agentId: "agent-1", environment: "production", snapshot: null, sql: sqlReturning(null) })).resolves.toEqual({ status: "legacy_unenrolled" });
  });

  test("activates only an exact applied receipt and snapshot", async () => {
    const result = await readAgentReleaseCapabilityState({ organizationId: "org-1", agentId: "agent-1", environment: "production", snapshot, sql: sqlReturning(validReceipt) });
    expect(result).toMatchObject({ status: "active", claim: { releaseId: "release-3", releaseSequence: 3, capabilityIds: ["personal_reminder_delivery.v1"] } });
  });

  test.each([
    ["missing snapshot", validReceipt, null],
    ["drifted", { ...validReceipt, status: "drifted" }, snapshot],
    ["live settings drift", { ...validReceipt, identity_md: "changed" }, snapshot],
    ["desired/applied mismatch", { ...validReceipt, desired_release_id: "release-4" }, snapshot],
    ["feed mismatch", { ...validReceipt, desired_feed_sequence: 10 }, snapshot],
    ["snapshot mismatch", validReceipt, { ...snapshot, appliedReleaseSequence: 2 }],
  ])("keeps enrolled agent inactive for %s", async (_name, receipt, candidate) => {
    await expect(readAgentReleaseCapabilityState({ organizationId: "org-1", agentId: "agent-1", environment: "production", snapshot: candidate as never, sql: sqlReturning(receipt) })).resolves.toEqual({ status: "enrolled_inactive" });
  });
});
