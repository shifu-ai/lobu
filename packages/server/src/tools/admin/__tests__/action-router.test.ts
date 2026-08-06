/**
 * agent-stack #86: the LINE agent tried `delete` and `update` on
 * manage_schedules and both times got only "Unknown action: x" — no hint
 * that `cancel` was the one it wanted.
 *
 * The valid-action list is disclosed before `enforceActionAccess` runs.
 * That is deliberate and safe: every manage_* tool already publishes its
 * action names in its own JSON Schema (manage_entity / manage_watchers /
 * manage_feeds via Type.Union of Type.Literal; manage_schedules in the
 * `action` field description), and only an authenticated caller that can
 * list the tool can reach routeAction at all. Moving the check after
 * authorization would make a typo'd action report "requires admin access"
 * instead of "no such action" — turning a self-correctable error into a
 * misleading one.
 */
import { describe, expect, test } from "bun:test";
import { routeAction } from "../action-router";
import type { ToolContext } from "../../registry";

function memberCtx(): ToolContext {
  return {
    organizationId: "org-1",
    userId: "user-me",
    memberRole: "member",
    agentId: "shifu-u-me",
    scopes: ["mcp:read"],
    isAuthenticated: true,
    tokenType: "pat",
    scopedToOrg: true,
    allowCrossOrg: false,
  } as ToolContext;
}

describe("routeAction unknown action", () => {
  test("names the valid actions, sorted", async () => {
    await expect(
      routeAction("manage_schedules", "delete", memberCtx(), {
        create: async () => "created",
        list: async () => "listed",
        cancel: async () => "cancelled",
        pause: async () => "paused",
      })
    ).rejects.toThrow(
      "Unknown action: delete. Valid actions: cancel, create, list, pause."
    );
  });

  test("discloses nothing beyond the handler action names", async () => {
    let message = "";
    try {
      await routeAction("manage_schedules", "update", memberCtx(), {
        cancel: async () => "cancelled",
        list: async () => "listed",
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toBe(
      "Unknown action: update. Valid actions: cancel, list."
    );
    expect(message).not.toContain("org-1");
    expect(message).not.toContain("shifu-u-me");
  });

  test("unknown action is reported before authorization, not after", async () => {
    // A member ctx with read-only scopes would fail enforceActionAccess for
    // an admin-tier action. It must still get the "no such action" message.
    await expect(
      routeAction("manage_entity", "nope", memberCtx(), {
        create: async () => "created",
      })
    ).rejects.toThrow("Unknown action: nope");
  });
});
