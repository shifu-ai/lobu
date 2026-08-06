import { describe, expect, test } from "bun:test";
import {
  buildCurrentDateContext,
  buildRelativeWeekCalendar,
  formatCalendarDate,
} from "../openclaw/date-context";

const NOW = new Date("2026-07-13T10:15:00.000Z");

describe("date context", () => {
  test("builds Monday-to-Sunday calendars for the previous, current, and next weeks", () => {
    const calendar = buildRelativeWeekCalendar(NOW);

    expect(calendar.previous.map(formatCalendarDate)).toEqual([
      "2026-07-06",
      "2026-07-07",
      "2026-07-08",
      "2026-07-09",
      "2026-07-10",
      "2026-07-11",
      "2026-07-12",
    ]);
    expect(calendar.current.map(formatCalendarDate)).toEqual([
      "2026-07-13",
      "2026-07-14",
      "2026-07-15",
      "2026-07-16",
      "2026-07-17",
      "2026-07-18",
      "2026-07-19",
    ]);
    expect(calendar.next.map(formatCalendarDate)).toEqual([
      "2026-07-20",
      "2026-07-21",
      "2026-07-22",
      "2026-07-23",
      "2026-07-24",
      "2026-07-25",
      "2026-07-26",
    ]);
  });

  test("renders deterministic week anchors and date precedence guidance", () => {
    const context = buildCurrentDateContext(NOW);

    expect(context).toContain(
      "Current time / 現在時間: 2026-07-13T18:15+08:00"
    );
    expect(context).toContain("Previous week / 上週");
    expect(context).toContain("Current week / 本週");
    expect(context).toContain("Next week / 下週");
    expect(context).toContain("2026-07-12 (星期日)");
    expect(context).toContain("2026-07-15 (星期三)");
    expect(context).toContain("2026-07-22 (星期三)");
    expect(context).toContain(
      "Current Date Context overrides relative dates in old conversation history"
    );
    expect(context).toContain("Never guess a weekday");
    expect(context).toContain(
      "- For dates outside this table, use trusted tool data or deterministic computation; otherwise say you cannot confirm."
    );
    expect(context).toContain(
      "- For a next occurrence, choose the earliest candidate at or after the current Taipei time; without trusted candidates or an explicit recurrence, do not guess."
    );
  });

  test("uses Taipei date while UTC is on the prior day", () => {
    expect(
      buildCurrentDateContext(new Date("2026-07-12T16:30:00.000Z"))
    ).toContain("Today / 今天: 2026-07-13 (星期一)");
  });

  test("crosses a month boundary", () => {
    const calendar = buildRelativeWeekCalendar(
      new Date("2026-08-02T16:30:00.000Z")
    );

    expect(calendar.previous.map(formatCalendarDate).at(-1)).toBe("2026-08-02");
    expect(calendar.current.map(formatCalendarDate).at(0)).toBe("2026-08-03");
  });

  test("crosses a year boundary", () => {
    const calendar = buildRelativeWeekCalendar(
      new Date("2026-12-31T16:30:00.000Z")
    );

    expect(calendar.current.map(formatCalendarDate)).toContain("2027-01-01");
  });

  test("handles leap day", () => {
    const calendar = buildRelativeWeekCalendar(
      new Date("2028-02-29T04:00:00.000Z")
    );

    expect(calendar.current.map(formatCalendarDate)).toContain("2028-02-29");
  });

  test("keeps years before 0100 instead of applying Date.UTC's 1900 offset", () => {
    const now = new Date(0);
    now.setUTCHours(12, 0, 0, 0);
    now.setUTCFullYear(99, 0, 1);

    const calendar = buildRelativeWeekCalendar(now);

    expect(calendar.current.map(formatCalendarDate)).toContain("0099-01-01");
    expect(calendar.current.map(formatCalendarDate).at(0)).toBe("0098-12-29");
  });

  test("renders a fail-closed prompt when the clock value is invalid", () => {
    expect(buildCurrentDateContext(new Date(Number.NaN))).toContain(
      "Current date computation is unavailable. Do not guess any date or weekday."
    );
  });

  // 鎖的是「日期區塊在同一分鐘內穩定」這個性質本身，而不是「字串裡沒有秒」。
  // 後者只鎖表象——有人把秒換成毫秒一樣會通過。之所以是「同一分鐘」而不是「同一天」，
  // 是因為時間行刻意保留到分鐘粒度（見下方「只保留一行現在時間」測試），
  // 分鐘粒度下同一天內不同分鐘的輸出並不相等。
  test("同一分鐘內不同秒數產生完全相同的輸出", () => {
    const early = buildCurrentDateContext(
      new Date("2026-08-06T06:49:03Z"),
      "Asia/Taipei"
    );
    const late = buildCurrentDateContext(
      new Date("2026-08-06T06:49:57Z"),
      "Asia/Taipei"
    );
    expect(early).toBe(late);
  });

  test("跨日時輸出必須不同", () => {
    const before = buildCurrentDateContext(
      new Date("2026-08-06T15:30:00Z"),
      "Asia/Taipei"
    );
    const after = buildCurrentDateContext(
      new Date("2026-08-06T16:30:00Z"),
      "Asia/Taipei"
    );
    expect(before).not.toBe(after);
  });

  test("只保留一行現在時間，且不含秒", () => {
    const output = buildCurrentDateContext(
      new Date("2026-08-06T06:49:13Z"),
      "Asia/Taipei"
    );
    const timeLines = output
      .split("\n")
      .filter((line) => line.includes("現在時間"));
    expect(timeLines).toHaveLength(1);
    expect(timeLines[0]).toContain("2026-08-06T14:49+08:00");
    expect(timeLines[0]).not.toMatch(/:\d{2}:\d{2}/);
  });

  test("逐日星期對照表不得回歸", () => {
    const output = buildCurrentDateContext(
      new Date("2026-08-06T06:49:13Z"),
      "Asia/Taipei"
    );
    expect(output).toContain("2026-07-30 (星期四)");
    expect(output).toContain("2026-07-31 (星期五)");
    expect(output).toContain("Never guess a weekday");
  });
});
