import { describe, expect, test } from "bun:test";
import { createScheduledJobInDb } from "../scheduled-jobs-service";

describe("createScheduledJobInDb", () => {
  test("persists timezone metadata fields and uses org/idempotency key conflict dedup", async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const scheduleMetadata = {
      compiled: {
        cron: null,
        requiresExpansion: true,
        expansionReason: "single_utc_cron_would_overfire_boundary_minutes",
      },
      local: { timezone: "Asia/Taipei" },
    };
    const returnedRow = {
      id: "job-1",
      organization_id: "org-1",
      action_type: "wake_agent",
      action_args: { agent_id: "shifu-u-1", prompt: "check tomorrow" },
      cron: null,
      next_run_at: "2026-08-01T01:00:00.000Z",
      last_fired_at: null,
      last_fired_run_id: null,
      paused: false,
      description: "bounded local wake",
      created_by_user: "user-1",
      created_by_agent: null,
      source_run_id: null,
      source_event_id: null,
      source_thread_id: null,
      schedule_metadata: scheduleMetadata,
      timezone: "Asia/Taipei",
      until_at: "2026-08-05T01:00:00.000Z",
      completed_at: null,
      idempotency_key: "course-pm-schedule-1",
      created_at: "2026-07-08T00:00:00.000Z",
      updated_at: "2026-07-08T00:00:00.000Z",
    };
    const sql = Object.assign(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        calls.push({ text: strings.raw.join(""), values });
        return [returnedRow];
      },
      {
        json: (value: unknown) => value,
      }
    );

    const row = await createScheduledJobInDb(sql as any, {
      organizationId: "org-1",
      actionType: "wake_agent",
      actionArgs: { agent_id: "shifu-u-1", prompt: "check tomorrow" },
      description: "bounded local wake",
      cron: null,
      runAt: new Date("2026-08-01T01:00:00Z"),
      createdByUser: "user-1",
      scheduleMetadata,
      timezone: "Asia/Taipei",
      untilAt: new Date("2026-08-05T01:00:00Z"),
      idempotencyKey: "course-pm-schedule-1",
    });

    expect(row).toEqual(returnedRow);
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain("schedule_metadata");
    expect(calls[0].text).toContain("timezone");
    expect(calls[0].text).toContain("until_at");
    expect(calls[0].text).toContain("completed_at");
    expect(calls[0].text).toContain("idempotency_key");
    expect(calls[0].text).toContain("ON CONFLICT");
    expect(calls[0].text).toContain("organization_id, idempotency_key");
    expect(calls[0].values).toContain("Asia/Taipei");
    expect(calls[0].values).toContain("course-pm-schedule-1");
  });
});
