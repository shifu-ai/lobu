import { describe, expect, test } from "bun:test";
import {
  createScheduledJobInDb,
  pauseScheduledJobInDb,
  runScheduledJobsTick,
  type ScheduledJobRow,
} from "../scheduled-jobs-service";

const baseJob: ScheduledJobRow = {
  id: "job-1",
  organization_id: "org-1",
  action_type: "wake_agent",
  action_args: { agent_id: "shifu-u-1", prompt: "check schedule" },
  cron: "* * * * *",
  next_run_at: "2026-07-01T00:00:00.000Z",
  schedule_metadata: null,
  timezone: null,
  until_at: null,
  completed_at: null,
  idempotency_key: null,
  last_fired_at: null,
  last_fired_run_id: null,
  paused: false,
  description: "test schedule",
  created_by_user: "user-1",
  created_by_agent: null,
  source_run_id: null,
  source_event_id: null,
  source_thread_id: null,
  created_at: "2026-07-01T00:00:00.000Z",
  updated_at: "2026-07-01T00:00:00.000Z",
};

interface UpdateCall {
  text: string;
  values: unknown[];
}

interface TickSqlOptions {
  revalidateRows?: ScheduledJobRow[];
  now?: Date;
}

function isDue(row: ScheduledJobRow, now: Date): boolean {
  return new Date(row.next_run_at).getTime() <= now.getTime();
}

function exceedsUntil(row: ScheduledJobRow): boolean {
  if (!row.until_at) return false;
  return new Date(row.next_run_at).getTime() > new Date(row.until_at).getTime();
}

function cloneRow(row: ScheduledJobRow): ScheduledJobRow {
  return {
    ...row,
    action_args: { ...row.action_args },
    schedule_metadata: row.schedule_metadata ? { ...row.schedule_metadata } : null,
  };
}

function makeTickSql(rows: ScheduledJobRow[], opts: TickSqlOptions = {}) {
  const now = opts.now ?? new Date("2026-07-01T00:00:30.000Z");
  const storedRows = rows.map(cloneRow);
  const revalidateRows = opts.revalidateRows?.map(cloneRow);
  const selects: Array<{ text: string; values: unknown[] }> = [];
  const updates: UpdateCall[] = [];
  const sql = Object.assign(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.raw.join("");
      if (text.includes("SELECT *") && text.includes("FROM scheduled_jobs")) {
        selects.push({ text, values });
        if (text.includes("WHERE id =")) {
          const candidateRows = revalidateRows ?? storedRows;
          const id = values[0] as string;
          let selected = candidateRows.filter((row) => row.id === id && isDue(row, now));
          if (text.includes("NOT paused")) {
            selected = selected.filter((row) => !row.paused);
          }
          if (text.includes("completed_at IS NULL")) {
            selected = selected.filter((row) => row.completed_at == null);
          }
          if (text.includes("next_run_at <= until_at")) {
            selected = selected.filter((row) => !exceedsUntil(row));
          }
          return selected;
        }

        let selected = storedRows.filter((row) => isDue(row, now) && !row.paused);
        if (text.includes("completed_at IS NULL")) {
          selected = selected.filter((row) => row.completed_at == null);
        }
        return selected;
      }
      if (text.includes("UPDATE scheduled_jobs")) {
        updates.push({ text, values });
        const isPauseUpdate = text.includes("organization_id =");
        const isAdvanceUpdate = text.includes("next_run_at =") &&
          !text.includes("next_run_at > until_at");
        const id = isPauseUpdate
          ? values[2] as string
          : isAdvanceUpdate
            ? values[1] as string
            : values[0] as string;
        const row = storedRows.find((candidate) => candidate.id === id);
        if (!row || !isDue(row, now)) return [];
        if (text.includes("NOT paused") && row.paused) return [];
        if (text.includes("completed_at IS NULL") && row.completed_at != null) return [];
        if (text.includes("next_run_at > until_at") && !exceedsUntil(row)) return [];

        if (text.includes("paused = true")) row.paused = true;
        if (isPauseUpdate) {
          row.paused = values[0] as boolean;
        }
        if (text.includes("completed_at = COALESCE")) {
          row.completed_at ??= now.toISOString();
        }
        if (isAdvanceUpdate) {
          row.next_run_at = values[0] as string;
        }
        return [{ id }];
      }
      return [];
    },
    {
      begin: async (fn: (tx: typeof sql) => Promise<unknown>) => fn(sql),
    }
  );
  return { sql, selects, updates, rows: storedRows };
}

function makeTickScheduler() {
  const spawns: Array<{ name: string; payload: unknown; options: unknown }> = [];
  return {
    spawns,
    scheduler: {
      spawn: async (name: string, payload: unknown, options: unknown) => {
        spawns.push({ name, payload, options });
        return "run-1";
      },
    },
  };
}

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

describe("runScheduledJobsTick", () => {
  test("recurring cron with until_at advances when the next occurrence is still within the bound", async () => {
    const { sql, updates } = makeTickSql([
      {
        ...baseJob,
        cron: "* * * * *",
        next_run_at: "2026-07-01T00:00:00.000Z",
        until_at: "9999-01-01T00:00:00.000Z",
      },
    ]);
    const { scheduler, spawns } = makeTickScheduler();

    await runScheduledJobsTick(sql as any, scheduler as any);

    expect(spawns).toHaveLength(1);
    expect(updates).toHaveLength(1);
    const finalUpdate = updates.at(-1);
    expect(finalUpdate?.text).toContain("next_run_at =");
    expect(finalUpdate?.text).not.toContain("completed_at = COALESCE");
    expect(finalUpdate?.values[0]).toBeString();
  });

  test("recurring cron with until_at fires the due occurrence then pauses/completes when the next occurrence exceeds the bound", async () => {
    const { sql, updates } = makeTickSql([
      {
        ...baseJob,
        cron: "1 0 1 7 *",
        next_run_at: "2026-07-01T00:00:00.000Z",
        until_at: "2026-07-01T00:00:00.000Z",
      },
    ]);
    const { scheduler, spawns } = makeTickScheduler();

    await runScheduledJobsTick(sql as any, scheduler as any);

    expect(spawns).toHaveLength(1);
    expect(updates).toHaveLength(1);
    const finalUpdate = updates.at(-1);
    expect(finalUpdate?.text).toContain("paused = true");
    expect(finalUpdate?.text).toContain("completed_at = COALESCE(completed_at, now())");
    // scheduled_jobs.next_run_at is NOT NULL in the baseline schema, so completed
    // schedules preserve their due timestamp and rely on paused=true to stop repeats.
    expect(finalUpdate?.text).not.toContain("next_run_at =");
  });

  test("final due fire exactly at until_at still dispatches when the ticker wakes late", async () => {
    const { sql, updates } = makeTickSql([
      {
        ...baseJob,
        cron: "1 0 1 7 *",
        next_run_at: "2026-07-01T00:00:00.000Z",
        until_at: "2026-07-01T00:00:00.000Z",
      },
    ]);
    const { scheduler, spawns } = makeTickScheduler();

    await runScheduledJobsTick(sql as any, scheduler as any);

    expect(spawns).toHaveLength(1);
    expect(updates).toHaveLength(1);
    expect(updates[0].text).toContain("paused = true");
    expect(updates[0].text).toContain("completed_at = COALESCE(completed_at, now())");
  });

  test("job whose due instant is after until_at is paused/completed without dispatching the action", async () => {
    const { sql, updates } = makeTickSql([
      {
        ...baseJob,
        next_run_at: "2026-07-01T00:01:00.000Z",
        until_at: "2026-07-01T00:00:00.000Z",
      },
    ], { now: new Date("2026-07-01T00:01:30.000Z") });
    const { scheduler, spawns } = makeTickScheduler();

    await runScheduledJobsTick(sql as any, scheduler as any);

    expect(spawns).toHaveLength(0);
    expect(updates).toHaveLength(1);
    expect(updates[0].text).toContain("paused = true");
    expect(updates[0].text).toContain("completed_at = COALESCE(completed_at, now())");
    expect(updates[0].text).toContain("next_run_at > until_at");
  });

  test("completed schedule rows are not selected or fired", async () => {
    const completedRow = {
      ...baseJob,
      completed_at: "2026-07-01T00:00:10.000Z",
      paused: false,
    };
    const completed = makeTickSql([completedRow]);
    const { scheduler, spawns } = makeTickScheduler();

    await runScheduledJobsTick(completed.sql as any, scheduler as any);

    expect(spawns).toHaveLength(0);
    expect(completed.updates).toHaveLength(0);
    expect(completed.selects[0].text).toContain("completed_at IS NULL");
  });

  test("stale selected row is revalidated before dispatch", async () => {
    const { sql, updates } = makeTickSql([baseJob], { revalidateRows: [] });
    const { scheduler, spawns } = makeTickScheduler();

    await runScheduledJobsTick(sql as any, scheduler as any);

    expect(spawns).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  test("one-shot job sets completed_at and pauses after execution while preserving next_run_at", async () => {
    const { sql, updates } = makeTickSql([
      {
        ...baseJob,
        cron: null,
      },
    ]);
    const { scheduler, spawns } = makeTickScheduler();

    await runScheduledJobsTick(sql as any, scheduler as any);

    expect(spawns).toHaveLength(1);
    expect(updates).toHaveLength(1);
    expect(updates[0].text).toContain("paused = true");
    expect(updates[0].text).toContain("completed_at = COALESCE(completed_at, now())");
    expect(updates[0].text).not.toContain("next_run_at =");
  });

  test("cron-null metadata-only job does not crash or create unsafe recurrence", async () => {
    const { sql, updates } = makeTickSql([
      {
        ...baseJob,
        cron: null,
        schedule_metadata: {
          compiled: {
            cron: null,
            requiresExpansion: true,
          },
        },
      },
    ]);
    const { scheduler, spawns } = makeTickScheduler();

    await runScheduledJobsTick(sql as any, scheduler as any);

    expect(spawns).toHaveLength(1);
    expect(updates).toHaveLength(1);
    expect(updates[0].text).toContain("paused = true");
    expect(updates[0].text).not.toContain("next_run_at =");
  });
});

describe("pauseScheduledJobInDb", () => {
  test("does not unpause a completed schedule", async () => {
    const { sql, updates } = makeTickSql([
      {
        ...baseJob,
        paused: true,
        completed_at: "2026-07-01T00:00:10.000Z",
      },
    ]);

    const ok = await pauseScheduledJobInDb(sql as any, "org-1", "job-1", false);

    expect(ok).toBe(false);
    expect(updates).toHaveLength(1);
    expect(updates[0].text).toContain("completed_at IS NULL");
  });
});
