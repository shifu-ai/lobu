import { describe, expect, test } from "bun:test";
import {
  formatCalendarDate,
  resolveRelativeDay,
  resolveRelativeWeekday,
} from "../openclaw/date-context";
import { guardDateOutput } from "../openclaw/date-output-guard";

const NOW = new Date("2026-07-13T10:15:00.000Z");

describe("relative date resolution", () => {
  test("resolves weekdays in the previous, current, and next Taipei weeks", () => {
    expect(formatCalendarDate(resolveRelativeWeekday("previous", 0, NOW))).toBe(
      "2026-07-12"
    );
    expect(formatCalendarDate(resolveRelativeWeekday("current", 3, NOW))).toBe(
      "2026-07-15"
    );
    expect(formatCalendarDate(resolveRelativeWeekday("next", 3, NOW))).toBe(
      "2026-07-22"
    );
  });

  test("rejects invalid weekday indexes", () => {
    expect(() => resolveRelativeWeekday("current", -1, NOW)).toThrow();
    expect(() => resolveRelativeWeekday("current", 7, NOW)).toThrow();
  });

  test("resolves yesterday, today, and tomorrow in Taipei", () => {
    expect(formatCalendarDate(resolveRelativeDay("yesterday", NOW))).toBe(
      "2026-07-12"
    );
    expect(formatCalendarDate(resolveRelativeDay("today", NOW))).toBe(
      "2026-07-13"
    );
    expect(formatCalendarDate(resolveRelativeDay("tomorrow", NOW))).toBe(
      "2026-07-14"
    );
  });
});

describe("guardDateOutput", () => {
  test("corrects stale dates attached to relative week claims", () => {
    const cases = [
      ["這週三是 7/9（三）", "這週三是 7/15（三）"],
      ["上週日 7/6（日）", "上週日 7/12（日）"],
    ] as const;

    for (const [finalText, expected] of cases) {
      const result = guardDateOutput({
        userMessage: finalText,
        finalText,
        now: NOW,
      });
      expect(result.status).toBe("corrected");
      expect(result.text).toBe(expected);
      if (result.status === "corrected") {
        expect(result.corrections[0]?.reason).toBe("relative_date_mismatch");
      }
    }
  });

  test("leaves a correct relative week date unchanged", () => {
    const finalText = "本週三 7/15（三）";
    expect(
      guardDateOutput({ userMessage: finalText, finalText, now: NOW })
    ).toEqual({ status: "unchanged", text: finalText });
  });

  test("preserves 星期天 on a correct relative Sunday", () => {
    const finalText = "上週日 7/12（星期天）";

    expect(
      guardDateOutput({ userMessage: finalText, finalText, now: NOW })
    ).toEqual({ status: "unchanged", text: finalText });
  });

  test("does not suffix-match unsupported multi-week expressions", () => {
    for (const finalText of [
      "下下週三 7/29（三）",
      "上上週日 7/5（日）",
    ]) {
      expect(
        guardDateOutput({ userMessage: finalText, finalText, now: NOW })
      ).toEqual({ status: "unchanged", text: finalText });
    }
  });

  test("does not treat ordinary words or quantities as relative weekday claims", () => {
    for (const finalText of [
      "上週日期是 7/9（四）",
      "本週日程：7/16（四）",
      "這週三場課，日期是 7/16（四）",
      "大上週三 7/1（三）",
    ]) {
      expect(
        guardDateOutput({ userMessage: finalText, finalText, now: NOW })
      ).toEqual({ status: "unchanged", text: finalText });
    }
  });

  test("corrects stale dates attached to relative day claims", () => {
    const finalText = "今天是 7/9（三）";
    const result = guardDateOutput({
      userMessage: finalText,
      finalText,
      now: NOW,
    });

    expect(result.status).toBe("corrected");
    expect(result.text).toBe("今天是 7/13（一）");
    if (result.status === "corrected") {
      expect(result.corrections[0]?.reason).toBe("relative_date_mismatch");
    }
  });

  test("corrects a short date weekday within the relative calendar window", () => {
    const finalText = "7/16（三）";
    const result = guardDateOutput({
      userMessage: finalText,
      finalText,
      now: NOW,
    });

    expect(result.status).toBe("corrected");
    expect(result.text).toBe("7/16（四）");
  });

  test("preserves 星期天 on a correct short Sunday date", () => {
    const finalText = "7/12（星期天）";

    expect(
      guardDateOutput({ userMessage: finalText, finalText, now: NOW })
    ).toEqual({ status: "unchanged", text: finalText });
  });

  test("supports 星期 labels and ASCII parentheses on short dates", () => {
    const finalText = "下週三是 7/22 (星期二)";
    const result = guardDateOutput({
      userMessage: finalText,
      finalText,
      now: NOW,
    });

    expect(result.status).toBe("corrected");
    expect(result.text).toBe("下週三是 7/22 (星期三)");
  });

  test("does not associate a relative phrase across a sentence boundary", () => {
    const finalText = "這週三再確認。7/9（三）是歷史資料";
    const result = guardDateOutput({
      userMessage: finalText,
      finalText,
      now: NOW,
    });

    // The standalone short date remains in-window and gets only its weekday fixed;
    // it must not be changed to this Wednesday's date.
    expect(result.text).toBe("這週三再確認。7/9（四）是歷史資料");
  });

  test("associates a date with the nearest relative claim", () => {
    const finalText = "這週三待定，下週三是 7/22（三）";

    expect(
      guardDateOutput({ userMessage: finalText, finalText, now: NOW })
    ).toEqual({ status: "unchanged", text: finalText });
  });

  test("leaves short date pairs outside the three-week window unchanged", () => {
    const finalText = "12/25（三）";
    expect(
      guardDateOutput({ userMessage: finalText, finalText, now: NOW })
    ).toEqual({ status: "unchanged", text: finalText });
  });

  test("corrects an explicit ISO date with the wrong Chinese weekday", () => {
    const result = guardDateOutput({
      userMessage: "2026-07-16 是星期幾？",
      finalText: "日期是 2026-07-16 (星期三)。",
      now: new Date("2026-07-13T10:15:00.000Z"),
    });
    expect(result.status).toBe("corrected");
    expect(result.text).toBe("日期是 2026-07-16 (星期四)。");
  });

  test("preserves the 星期天 spelling for a correct Sunday", () => {
    const finalText = "2026-07-19 (星期天)";
    const result = guardDateOutput({
      userMessage: "2026-07-19 是星期幾？",
      finalText,
      now: new Date("2026-07-13T10:15:00.000Z"),
    });

    expect(result).toEqual({ status: "unchanged", text: finalText });
  });

  test("does not match an ISO-shaped suffix inside a longer digit token", () => {
    const finalText = "12026-07-16 (星期三)";
    const result = guardDateOutput({
      userMessage: finalText,
      finalText,
      now: new Date("2026-07-13T10:15:00.000Z"),
    });

    expect(result).toEqual({ status: "unchanged", text: finalText });
  });

  test("leaves a correct explicit weekday unchanged", () => {
    const finalText = "2026-07-16 (星期四)";
    const result = guardDateOutput({
      userMessage: finalText,
      finalText,
      now: new Date("2026-07-13T10:15:00.000Z"),
    });

    expect(result).toEqual({ status: "unchanged", text: finalText });
  });

  test("leaves an impossible calendar date unchanged", () => {
    const finalText = "2026-02-30 (星期一)";
    const result = guardDateOutput({
      userMessage: finalText,
      finalText,
      now: new Date("2026-07-13T10:15:00.000Z"),
    });

    expect(result).toEqual({ status: "unchanged", text: finalText });
  });

  test("corrects multiple matches while preserving surrounding text", () => {
    const result = guardDateOutput({
      userMessage: "核對這兩天",
      finalText: "前 2026-07-16（星期三） 中 2026-07-17 (星期三) 後",
      now: new Date("2026-07-13T10:15:00.000Z"),
    });

    expect(result.status).toBe("corrected");
    expect(result.text).toBe(
      "前 2026-07-16（星期四） 中 2026-07-17 (星期五) 後"
    );
    if (result.status === "corrected") {
      expect(result.corrections).toHaveLength(2);
    }
  });
});
