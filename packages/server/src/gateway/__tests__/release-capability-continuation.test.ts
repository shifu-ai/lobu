import { describe, expect, test } from "bun:test";
import { refreshPerRequestCapabilityContext } from "../../mcp-handler";
import { buildPendingToolExecutionOptions } from "../auth/mcp/pending-tool-store";

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
		const current = {
			personalReminderDeliveryIntent: true,
			releaseState: { status: "active" as const, claim: claim() },
		};
    refreshPerRequestCapabilityContext(current, {});
		expect(current).toEqual({
			personalReminderDeliveryIntent: false,
			releaseState: undefined,
		});
  });

  test("pending replay preserves the original inactive state for the action boundary", () => {
    const releaseState = {
      status: "enrolled_inactive" as const,
      environment: "production" as const,
      reason: "capability_expired" as const,
    };
    expect(buildPendingToolExecutionOptions({
      mcpId: "lobu-memory",
      toolName: "manage_schedules",
      args: {},
      agentId: "agent-1",
      userId: "user-1",
      organizationId: "org-1",
      releaseState,
    })).toEqual({ organizationId: "org-1", releaseState });
  });
});
