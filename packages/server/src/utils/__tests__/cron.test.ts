import { afterEach, describe, expect, test } from "bun:test";
import { nextRunAt } from "../cron";

const originalTz = process.env.TZ;

afterEach(() => {
  if (originalTz === undefined) {
    delete process.env.TZ;
  } else {
    process.env.TZ = originalTz;
  }
});

describe("nextRunAt", () => {
  test("interprets cron expressions in UTC regardless of process timezone", () => {
    process.env.TZ = "Asia/Taipei";

    expect(nextRunAt("0 16 * * 2", new Date("2026-06-29T00:00:00.000Z"))).toBe(
      "2026-06-30T16:00:00.000Z",
    );
  });
});
