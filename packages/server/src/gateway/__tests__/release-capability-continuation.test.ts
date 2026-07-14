import { describe, expect, test, vi } from "bun:test";
import { validateApprovalReleaseCapability } from "../auth/mcp/proxy";
import { refreshPerRequestCapabilityContext } from "../../mcp-handler";

function claim(overrides: Record<string, unknown> = {}) {
  return {
    environment: "production" as const,
    toolboxUserId: "user-1",
    agentId: "agent-1",
    releaseId: "release-original",
    releaseSequence: 3,
    snapshotDigest: `sha256:${"a".repeat(64)}`,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    capabilityIds: ["personal_reminder_delivery.v1"],
    ...overrides,
  };
}

describe("release capability continuation", () => {
  test("MCP session reuse clears a missing per-request claim", () => {
    const current = { personalReminderDeliveryIntent: true, releaseCapability: claim() };
    refreshPerRequestCapabilityContext(current, {});
    expect(current).toEqual({ personalReminderDeliveryIntent: false, releaseCapability: undefined });
  });

  test("expired approval loses capability before consulting durable state", async () => {
    const readState = vi.fn(async () => ({ status: "active" as const, claim: claim() }));
    await expect(validateApprovalReleaseCapability({
      organizationId: "org-1",
      releaseCapability: claim({ expiresAt: new Date(Date.now() - 1).toISOString() }),
    }, readState as never)).resolves.toBe(false);
    expect(readState).not.toHaveBeenCalled();
  });

  test("revocation removes the original approval and cannot substitute a newer release", async () => {
    const original = claim();
    const readState = vi.fn(async (input: any) => {
      expect(input.snapshot.appliedReleaseId).toBe("release-original");
      expect(input.snapshot.appliedReleaseSequence).toBe(3);
      return { status: "enrolled_inactive" as const };
    });
    await expect(validateApprovalReleaseCapability({
      organizationId: "org-1", releaseCapability: original,
    }, readState as never)).resolves.toBe(false);
    expect(readState).toHaveBeenCalledTimes(1);
  });
});
