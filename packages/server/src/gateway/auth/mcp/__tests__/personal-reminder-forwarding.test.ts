import { describe, expect, test } from "bun:test";
import { trustedPersonalReminderForwardHeaders } from "../proxy";

describe("personal reminder delivery forwarding", () => {
  test("forwards only the exact worker marker to the internal schedule tool", () => {
    expect(
      trustedPersonalReminderForwardHeaders({
        mcpId: "lobu-memory",
        toolName: "manage_schedules",
        internal: true,
        workerIntentHeader: "personal_reminder_delivery.v1",
      }),
    ).toEqual({
      "x-lobu-trusted-personal-reminder-delivery":
        "personal_reminder_delivery.v1",
    });
  });

  test("fails closed for external, wrong-tool, missing worker, and spoofed trusted headers", () => {
    expect(
      trustedPersonalReminderForwardHeaders({
        mcpId: "lobu-memory",
        toolName: "manage_schedules",
        internal: false,
        workerIntentHeader: "personal_reminder_delivery.v1",
      }),
    ).toEqual({});
    expect(
      trustedPersonalReminderForwardHeaders({
        mcpId: "lobu-memory",
        toolName: "search_memory",
        internal: true,
        workerIntentHeader: "personal_reminder_delivery.v1",
      }),
    ).toEqual({});
    const spoofedTrustedHeader = {
      mcpId: "lobu-memory",
      toolName: "manage_schedules",
      internal: true,
      trustedHeader: "personal_reminder_delivery.v1",
    };
    expect(
      trustedPersonalReminderForwardHeaders(spoofedTrustedHeader),
    ).toEqual({});
  });
});
