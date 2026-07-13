import { describe, expect, test } from "bun:test";
import {
  formatCalendarDate,
  resolveRelativeDay,
  resolveRelativeWeekday,
} from "../openclaw/date-context";
import {
  extractTrustedTemporalCandidates,
  extractTrustedTemporalEvidence,
  guardDateOutput,
  isDateSensitiveTurn,
} from "../openclaw/date-output-guard";

const NOW = new Date("2026-07-13T10:15:00.000Z");

describe("isDateSensitiveTurn", () => {
  test("detects Chinese relative and explicit date requests", () => {
    for (const prompt of [
      "今天是 7/13",
      "昨天和明天分別是哪天？",
      "上週、本週、這週和下週的日期",
      "本週三是哪天？",
      "星期五有空嗎？",
      "銷講是星期幾？",
      "上一場和最近一場是何時？",
      "請查下一場銷講",
      "2026-07-16 是星期幾？",
      "2026-7-6 有活動嗎？",
      "核對這兩天",
      "活動日期是哪天？",
      "開課是幾號？",
    ]) {
      expect(isDateSensitiveTurn(prompt)).toBe(true);
    }
  });

  test("detects English relative date requests", () => {
    for (const prompt of [
      "Is next Wednesday available?",
      "What date is the session?",
      "Can we meet this Mon?",
      "Can we meet next Tue?",
      "Can we meet next Wed?",
      "Can we meet this Wed?",
      "Was it last Tues?",
      "Was it last Thu?",
      "Was it last Thur?",
      "Try next Thurs",
      "Try this Fri",
      "Try last Sat",
      "Try next Sun",
      "Compare today, tomorrow, and yesterday",
      "Show this week, last week, and next week",
      "Is Monday a weekday?",
      "When is the next session?",
      "When will it happen?",
    ]) {
      expect(isDateSensitiveTurn(prompt)).toBe(true);
    }
  });

  test("does not classify ordinary non-date prompts", () => {
    for (const prompt of [
      "請整理會議摘要",
      "課程報名人數有多少？",
      "hello",
      "this wedding summary",
      "the next sunset photo",
      "the latest update",
      "What happens when I click save?",
    ]) {
      expect(isDateSensitiveTurn(prompt)).toBe(false);
    }
  });
});

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
  test("blocks an impossible date instead of normalizing it", () => {
    expect(
      guardDateOutput({
        userMessage: "2026-02-30 是星期幾？",
        finalText: "2026-02-30 (星期一)",
        now: new Date("2026-02-20T04:00:00.000Z"),
      })
    ).toEqual({
      status: "blocked",
      text: "我偵測到無效或無法可靠判定的日期，因此沒有送出猜測結果。請確認日期後再試一次。",
      reason: "invalid_calendar_date",
    });
  });

  test("does not treat an invalid ISO-shaped code token as a date claim", () => {
    const finalText = "const version_2026-02-30 = false;";

    expect(
      guardDateOutput({
        userMessage: "請核對這個日期格式 token",
        finalText,
        now: NOW,
      })
    ).toEqual({ status: "unchanged", text: finalText });
  });

  test("blocks an impossible date inside an ISO datetime claim", () => {
    expect(
      guardDateOutput({
        userMessage: "這個排程日期有效嗎？",
        finalText: "排程是 2026-02-30T10:00:00+08:00。",
        now: NOW,
      })
    ).toEqual({
      status: "blocked",
      text: "我偵測到無效或無法可靠判定的日期，因此沒有送出猜測結果。請確認日期後再試一次。",
      reason: "invalid_calendar_date",
    });
  });

  test("blocks impossible ISO dates before sentence-final ASCII punctuation", () => {
    for (const finalText of [
      "The date is 2026-02-30.",
      "The schedule is 2026-02-30T10:00:00+08:00.",
    ]) {
      expect(
        guardDateOutput({
          userMessage: "Please check the date.",
          finalText,
          now: NOW,
        })
      ).toEqual({
        status: "blocked",
        text: "我偵測到無效或無法可靠判定的日期，因此沒有送出猜測結果。請確認日期後再試一次。",
        reason: "invalid_calendar_date",
      });
    }
  });

  test("does not treat slug or path tokens as date claims", () => {
    for (const finalText of [
      "release-2026-02-30",
      "/2026-02-30/report",
      "version_2026-02-30",
    ]) {
      expect(
        guardDateOutput({
          userMessage: "請核對這些日期格式 token",
          finalText,
          now: NOW,
        })
      ).toEqual({ status: "unchanged", text: finalText });
    }
  });

  test("does not treat dotted filenames as invalid date claims", () => {
    for (const finalText of [
      "report.2026-02-30.txt",
      "report.2026-02-30",
      "2026-02-30.txt",
    ]) {
      expect(
        guardDateOutput({
          userMessage: "請核對這些日期格式 token",
          finalText,
          now: NOW,
        })
      ).toEqual({ status: "unchanged", text: finalText });
    }
  });

  test("does not mutate an already-streamed answer for a non-date turn", () => {
    const finalText = "資料列內容為 2026-02-30 (星期一)";

    expect(
      guardDateOutput({
        userMessage: "請整理這份資料",
        finalText,
        now: NOW,
      })
    ).toEqual({ status: "unchanged", text: finalText });

    expect(
      guardDateOutput({
        userMessage: "請核對資料中的日期",
        finalText,
        now: NOW,
      })
    ).toEqual({
      status: "blocked",
      text: "我偵測到無效或無法可靠判定的日期，因此沒有送出猜測結果。請確認日期後再試一次。",
      reason: "invalid_calendar_date",
    });
  });

  test("does not correct a weekday in an already-streamed non-date turn", () => {
    const finalText = "資料列內容為 2026-07-16 (星期三)";

    expect(
      guardDateOutput({
        userMessage: "請整理這份資料",
        finalText,
        now: NOW,
      })
    ).toEqual({ status: "unchanged", text: finalText });
  });

  test("blocks an unsupported next-occurrence date claim", () => {
    expect(
      guardDateOutput({
        userMessage: "下一場銷講是什麼時候？",
        finalText: "下一場是 7/16（四）。",
        now: NOW,
      })
    ).toEqual({
      status: "blocked",
      text: "我目前沒有取得可驗證的場次日期，因此不能猜下一場。請讓我先查詢實際排程，或提供固定週期與時間。",
      reason: "next_occurrence_without_temporal_evidence",
    });
  });

  test("uses the earliest future trusted candidate for a next occurrence", () => {
    const result = guardDateOutput({
      userMessage: "請查下一場銷講",
      finalText: "下一場是 7/22（三）。",
      now: NOW,
      trustedTemporalCandidates: ["2026-07-22", "2026-07-16", "2026-07-12"],
    });

    expect(result.status).toBe("corrected");
    expect(result.text).toBe("下一場是 7/16（四）。");
  });

  test("preserves padded short-date style when correcting a next occurrence", () => {
    const result = guardDateOutput({
      userMessage: "請查下一場銷講",
      finalText: "下一場是 07/22（星期三）。",
      now: NOW,
      trustedTemporalCandidates: ["2026-07-16"],
    });

    expect(result.text).toBe("下一場是 07/16（星期四）。");
  });

  test("corrects the date attached to the next occurrence, not an earlier date", () => {
    const result = guardDateOutput({
      userMessage: "請查下一場銷講",
      finalText: "今天是 7/13（一）；下一場是 7/22（三）。",
      now: NOW,
      trustedTemporalCandidates: ["2026-07-16"],
    });

    expect(result.status).toBe("corrected");
    expect(result.text).toBe("今天是 7/13（一）；下一場是 7/16（四）。");
  });

  test("corrects a next-occurrence date written before its label", () => {
    const result = guardDateOutput({
      userMessage: "請查下一場銷講",
      finalText: "7/22（三）是下一場。",
      now: NOW,
      trustedTemporalCandidates: ["2026-07-16"],
    });

    expect(result.status).toBe("corrected");
    expect(result.text).toBe("7/16（四）是下一場。");
  });

  test("compares timestamp candidates by instant and renders the Taipei date", () => {
    const result = guardDateOutput({
      userMessage: "When is the next session?",
      finalText: "The next session is 7/22 (星期三).",
      now: NOW,
      trustedTemporalCandidates: [
        "2026-07-16T01:00:00Z",
        "2026-07-15T16:30:00Z",
        "2026-07-13",
      ],
    });

    expect(result.status).toBe("corrected");
    expect(result.text).toBe("The next session is 7/16 (星期四).");
  });

  test("does not block a next-occurrence response that makes no date claim", () => {
    const finalText = "我先查詢實際排程再回覆你。";
    expect(
      guardDateOutput({
        userMessage: "下一場銷講是什麼時候？",
        finalText,
        now: NOW,
      })
    ).toEqual({ status: "unchanged", text: finalText });
  });

  test("ignores an unrelated date before an unresolved next occurrence", () => {
    const finalText = "今天是 7/13（一）；下一場尚未查到。";

    for (const trustedTemporalCandidates of [undefined, ["2026-07-16"]]) {
      expect(
        guardDateOutput({
          userMessage: "下一場銷講是什麼時候？",
          finalText,
          now: NOW,
          trustedTemporalCandidates,
        })
      ).toEqual({ status: "unchanged", text: finalText });
    }
  });

  test("does not associate a next occurrence with a date across a line boundary", () => {
    const finalText = "下一場尚未查到。\n參考日期是 7/22（三）。";
    expect(
      guardDateOutput({
        userMessage: "下一場銷講是什麼時候？",
        finalText,
        now: NOW,
      })
    ).toEqual({ status: "unchanged", text: finalText });
  });

  test("does not associate a reference-date clause with an unresolved next occurrence", () => {
    const finalText = "下一場尚未查到，但參考日期是 7/13（一）。";

    for (const trustedTemporalCandidates of [undefined, ["2026-07-16"]]) {
      expect(
        guardDateOutput({
          userMessage: "下一場銷講是什麼時候？",
          finalText,
          now: NOW,
          trustedTemporalCandidates,
        })
      ).toEqual({ status: "unchanged", text: finalText });
    }
  });

  test("rejects reference, source, and range descriptors as date links", () => {
    for (const finalText of [
      "下一場參考日期是 7/13（一）。",
      "下一場來源日期為 7/13（一）。",
      "下一場日期範圍是 7/13（一）。",
      "The next session reference date is 7/13 (星期一).",
      "The next session source date is 7/13 (星期一).",
      "The next session date range is 7/13 (星期一).",
    ]) {
      expect(
        guardDateOutput({
          userMessage: "下一場銷講是什麼時候？",
          finalText,
          now: NOW,
          trustedTemporalCandidates: ["2026-07-16"],
        })
      ).toEqual({ status: "unchanged", text: finalText });
    }
  });

  test("associates an explicit next-occurrence date connector", () => {
    const result = guardDateOutput({
      userMessage: "請查下一場銷講",
      finalText: "下一場日期為 7/22（三）。",
      now: NOW,
      trustedTemporalCandidates: ["2026-07-16"],
    });

    expect(result.status).toBe("corrected");
    expect(result.text).toBe("下一場日期為 7/16（四）。");
  });

  test("associates a short event descriptor before the next-occurrence date", () => {
    const finalText = "下一場銷講是 7/22（三）。";

    expect(
      guardDateOutput({
        userMessage: "請查下一場銷講",
        finalText,
        now: NOW,
      })
    ).toEqual({
      status: "blocked",
      text: "我目前沒有取得可驗證的場次日期，因此不能猜下一場。請讓我先查詢實際排程，或提供固定週期與時間。",
      reason: "next_occurrence_without_temporal_evidence",
    });

    const corrected = guardDateOutput({
      userMessage: "請查下一場銷講",
      finalText,
      now: NOW,
      trustedTemporalCandidates: ["2026-07-16"],
    });
    expect(corrected.status).toBe("corrected");
    expect(corrected.text).toBe("下一場銷講是 7/16（四）。");
  });

  test("supports explicit next-occurrence bridge variants", () => {
    for (const [finalText, expected] of [
      ["下一場銷講：7/22（三）。", "下一場銷講：7/16（四）。"],
      ["下一場將在 7/22（三）舉行。", "下一場將在 7/16（四）舉行。"],
      [
        "The next session date: 7/22 (星期三).",
        "The next session date: 7/16 (星期四).",
      ],
    ] as const) {
      expect(
        guardDateOutput({
          userMessage: "請查下一場銷講",
          finalText,
          now: NOW,
          trustedTemporalCandidates: ["2026-07-16"],
        }).text
      ).toBe(expected);
    }
  });

  test("supports direct scheduling bridges with and without evidence", () => {
    for (const [finalText, expected] of [
      [
        "The next session will take place on 7/22 (星期三).",
        "The next session will take place on 7/16 (星期四).",
      ],
      ["下一場預計 7/22（三）舉行。", "下一場預計 7/16（四）舉行。"],
      ["下一場定於 7/22（三）舉行。", "下一場定於 7/16（四）舉行。"],
    ] as const) {
      expect(
        guardDateOutput({
          userMessage: "請查下一場銷講",
          finalText,
          now: NOW,
        })
      ).toEqual({
        status: "blocked",
        text: "我目前沒有取得可驗證的場次日期，因此不能猜下一場。請讓我先查詢實際排程，或提供固定週期與時間。",
        reason: "next_occurrence_without_temporal_evidence",
      });

      expect(
        guardDateOutput({
          userMessage: "請查下一場銷講",
          finalText,
          now: NOW,
          trustedTemporalCandidates: ["2026-07-16"],
        }).text
      ).toBe(expected);
    }
  });

  test("supports conservative clause-level scheduling associations", () => {
    for (const [finalText, expected] of [
      ["下一場預計在 7/22（三）舉行。", "下一場預計在 7/16（四）舉行。"],
      ["下一場會在 7/22（三）舉行。", "下一場會在 7/16（四）舉行。"],
      [
        "The next session will be held on 7/22 (星期三).",
        "The next session will be held on 7/16 (星期四).",
      ],
    ] as const) {
      expect(
        guardDateOutput({
          userMessage: "請查下一場銷講",
          finalText,
          now: NOW,
        })
      ).toEqual({
        status: "blocked",
        text: "我目前沒有取得可驗證的場次日期，因此不能猜下一場。請讓我先查詢實際排程，或提供固定週期與時間。",
        reason: "next_occurrence_without_temporal_evidence",
      });
      expect(
        guardDateOutput({
          userMessage: "請查下一場銷講",
          finalText,
          now: NOW,
          trustedTemporalCandidates: ["2026-07-16"],
        }).text
      ).toBe(expected);
    }
  });

  test("supports affirmative Chinese scheduling predicates", () => {
    for (const [finalText, expected] of [
      ["下一場銷講辦在 7/22（三）。", "下一場銷講辦在 7/16（四）。"],
      ["下一場銷講訂在 7/22（三）。", "下一場銷講訂在 7/16（四）。"],
      ["下一場銷講安排在 7/22（三）。", "下一場銷講安排在 7/16（四）。"],
    ] as const) {
      expect(
        guardDateOutput({
          userMessage: "幫我查下一場銷講",
          finalText,
          now: NOW,
        })
      ).toEqual({
        status: "blocked",
        text: "我目前沒有取得可驗證的場次日期，因此不能猜下一場。請讓我先查詢實際排程，或提供固定週期與時間。",
        reason: "next_occurrence_without_temporal_evidence",
      });
      expect(
        guardDateOutput({
          userMessage: "幫我查下一場銷講",
          finalText,
          now: NOW,
          trustedTemporalCandidates: ["2026-07-16"],
        }).text
      ).toBe(expected);
    }
  });

  test("rejects negated affirmative scheduling predicates", () => {
    for (const finalText of [
      "下一場不辦在 7/22（三）。",
      "下一場不办在 7/22（三）。",
      "下一場不訂在 7/22（三）。",
      "下一場不订在 7/22（三）。",
      "下一場不安排在 7/22（三）。",
      "下一場未安排在 7/22（三）。",
      "下一場沒有安排在 7/22（三）。",
      "下一場没有安排在 7/22（三）。",
      "下一場不會安排在 7/22（三）。",
      "下一場不會辦在 7/22（三）。",
      "下一場未能訂在 7/22（三）。",
      "下一場無法辦在 7/22（三）。",
      "下一場不能安排在 7/22（三）。",
      "下一場尚未安排在 7/22（三）。",
      "下一場沒有訂在 7/22（三）。",
      "下一場不會再安排在 7/22（三）。",
      "下一場不會被安排在 7/22（三）。",
      "下一場不會被重新安排在 7/22（三）。",
      "下一場未能另行訂在 7/22（三）。",
    ]) {
      expect(
        guardDateOutput({
          userMessage: "幫我查下一場活動",
          finalText,
          now: NOW,
          trustedTemporalCandidates: ["2026-07-16"],
        })
      ).toEqual({ status: "unchanged", text: finalText });
    }
  });

  test("corrects a later positive scheduling predicate after a negated one", () => {
    for (const [finalText, expected] of [
      [
        "下一場不安排在 7/22（三）；下次安排在 7/23（四）。",
        "下一場不安排在 7/22（三）；下次安排在 7/16（四）。",
      ],
      [
        "下一場不會再安排在 7/22（三）；下次安排在 7/23（四）。",
        "下一場不會再安排在 7/22（三）；下次安排在 7/16（四）。",
      ],
      [
        "下一場不會被安排在 7/22（三）；下次安排在 7/23（四）。",
        "下一場不會被安排在 7/22（三）；下次安排在 7/16（四）。",
      ],
    ] as const) {
      const result = guardDateOutput({
        userMessage: "幫我查下一場活動",
        finalText,
        now: NOW,
        trustedTemporalCandidates: ["2026-07-16"],
      });
      expect(result.status).toBe("corrected");
      expect(result.text).toBe(expected);
    }
  });

  test("does not rewrite negated next-occurrence date clauses", () => {
    for (const finalText of [
      "The next session is not 7/22 (星期三); it is 7/16 (星期四).",
      "The next session will not be on 7/22 (星期三).",
      "The next session isn't on 7/22 (星期三).",
      "The next session isn’t on 7/22 (星期三).",
      "The next session won't be on 7/22 (星期三).",
      "The next session won’t be on 7/22 (星期三).",
      "The next session can't be on 7/22 (星期三).",
      "The next session can’t be on 7/22 (星期三).",
      "The next session cannot be on 7/22 (星期三).",
      "The next session is never on 7/22 (星期三).",
      "下一場不會在 7/22（三）；而是在 7/16（四）。",
      "下一場無法在 7/22（三）。",
      "下一場不在 7/22（三）。",
      "下一場不於 7/22（三）。",
      "下一場不是 7/22（三）。",
      "下一場並非 7/22（三）。",
      "下一場不能在 7/22（三）。",
      "下一場不可在 7/22（三）。",
      "下一場不應在 7/22（三）。",
      "下一場不可能在 7/22（三）。",
      "下一場未能在 7/22（三）。",
      "下一場未在 7/22（三）。",
      "下一場未於 7/22（三）。",
      "下一場沒有在 7/22（三）。",
      "下一場没有在 7/22（三）。",
      "下一場并非 7/22（三）。",
    ]) {
      expect(
        guardDateOutput({
          userMessage: "請查下一場銷講",
          finalText,
          now: NOW,
          trustedTemporalCandidates: ["2026-07-16"],
        })
      ).toEqual({ status: "unchanged", text: finalText });
    }
  });

  test("does not confuse Chinese event-name characters with negation", () => {
    for (const [finalText, expected] of [
      ["下一場不動產講座是 7/22（三）。", "下一場不動產講座是 7/16（四）。"],
      ["下一場非營利課程是 7/22（三）。", "下一場非營利課程是 7/16（四）。"],
      ["下一場未來論壇是 7/22（三）。", "下一場未來論壇是 7/16（四）。"],
    ] as const) {
      expect(
        guardDateOutput({
          userMessage: "請查下一場活動",
          finalText,
          now: NOW,
        })
      ).toEqual({
        status: "blocked",
        text: "我目前沒有取得可驗證的場次日期，因此不能猜下一場。請讓我先查詢實際排程，或提供固定週期與時間。",
        reason: "next_occurrence_without_temporal_evidence",
      });
      expect(
        guardDateOutput({
          userMessage: "請查下一場活動",
          finalText,
          now: NOW,
          trustedTemporalCandidates: ["2026-07-16"],
        }).text
      ).toBe(expected);
    }
  });

  test("applies negation checks to scheduling predicates, not event titles", () => {
    for (const [finalText, expected] of [
      [
        "下一場不能錯過的講座是 7/22（三）。",
        "下一場不能錯過的講座是 7/16（四）。",
      ],
      [
        "下一場不可思議體驗是 7/22（三）。",
        "下一場不可思議體驗是 7/16（四）。",
      ],
      [
        "The next session No Code Workshop is 7/22 (星期三).",
        "The next session No Code Workshop is 7/16 (星期四).",
      ],
    ] as const) {
      expect(
        guardDateOutput({
          userMessage: "請查下一場活動",
          finalText,
          now: NOW,
        })
      ).toEqual({
        status: "blocked",
        text: "我目前沒有取得可驗證的場次日期，因此不能猜下一場。請讓我先查詢實際排程，或提供固定週期與時間。",
        reason: "next_occurrence_without_temporal_evidence",
      });
      expect(
        guardDateOutput({
          userMessage: "請查下一場活動",
          finalText,
          now: NOW,
          trustedTemporalCandidates: ["2026-07-16"],
        }).text
      ).toBe(expected);
    }
  });

  test("can correct a later independently labeled positive clause", () => {
    const result = guardDateOutput({
      userMessage: "請查下一場銷講",
      finalText: "下一場不會在 7/22（三）；下次是在 7/23（四）。",
      now: NOW,
      trustedTemporalCandidates: ["2026-07-16"],
    });

    expect(result.status).toBe("corrected");
    expect(result.text).toBe("下一場不會在 7/22（三）；下次是在 7/16（四）。");
  });

  test("uses an unpassed same-day recurrence time and rolls a passed time forward", () => {
    const wednesdayNow = new Date("2026-07-15T10:15:00.000Z");
    for (const [userMessage, expected] of [
      ["銷講每週三 20:00 舉行，下一場是哪一天？", "下一場是 7/15（三）。"],
      ["銷講每週三 17:00 舉行，下一場是哪一天？", "下一場是 7/22（三）。"],
      ["銷講每週三晚上 8 點舉行，下一場是哪一天？", "下一場是 7/15（三）。"],
    ] as const) {
      expect(
        guardDateOutput({
          userMessage,
          finalText: "下一場是 7/22（三）。",
          now: wednesdayNow,
        }).text
      ).toBe(expected);
    }
  });

  test("fails closed for a same-day recurrence without an explicit time", () => {
    for (const userMessage of [
      "銷講每週三舉行，下一場是哪一天？",
      "銷講每週三 8 點舉行，下一場是哪一天？",
    ]) {
      expect(
        guardDateOutput({
          userMessage,
          finalText: "下一場是 7/15（三）。",
          now: new Date("2026-07-15T10:15:00.000Z"),
        })
      ).toEqual({
        status: "blocked",
        text: "我目前沒有取得可驗證的場次日期，因此不能猜下一場。請讓我先查詢實際排程，或提供固定週期與時間。",
        reason: "next_occurrence_without_temporal_evidence",
      });
    }
  });

  test("fails closed for multiple distinct recurrence clauses", () => {
    expect(
      guardDateOutput({
        userMessage: "原本每週三 17:00，已改成每週三 20:00，下一場是哪天？",
        finalText: "下一場是 7/15（三）。",
        now: new Date("2026-07-15T10:15:00.000Z"),
      })
    ).toEqual({
      status: "blocked",
      text: "我目前沒有取得可驗證的場次日期，因此不能猜下一場。請讓我先查詢實際排程，或提供固定週期與時間。",
      reason: "next_occurrence_without_temporal_evidence",
    });
  });

  test("fails closed for multiple distinct times in one recurrence clause", () => {
    expect(
      guardDateOutput({
        userMessage: "原本每週三 17:00 已改成 20:00，下一場是哪天？",
        finalText: "下一場是 7/15（三）。",
        now: new Date("2026-07-15T10:15:00.000Z"),
      })
    ).toEqual({
      status: "blocked",
      text: "我目前沒有取得可驗證的場次日期，因此不能猜下一場。請讓我先查詢實際排程，或提供固定週期與時間。",
      reason: "next_occurrence_without_temporal_evidence",
    });
  });

  test("chooses the earliest occurrence across enumerated recurrence weekdays", () => {
    for (const userMessage of [
      "銷講每週三、週日 19:00 舉行，下一場是哪天？",
      "銷講每周三、周日 19:00 舉行，下一場是哪天？",
    ]) {
      const result = guardDateOutput({
        userMessage,
        finalText: "下一場是 7/22（三）。",
        now: new Date("2026-07-16T04:00:00.000Z"),
      });
      expect(result.status).toBe("corrected");
      expect(result.text).toBe("下一場是 7/19（日）。");
    }
  });

  test("supports conventional Chinese and English weekday enumerations", () => {
    for (const userMessage of [
      "銷講每週三、日 19:00 舉行，下一場是哪天？",
      "銷講每周三、日 19:00 舉行，下一場是哪天？",
      "The session is every Wednesday and Sunday at 19:00; when is the next session?",
      "The session is weekly on Wednesday, Sunday at 19:00; when is the next session?",
    ]) {
      const result = guardDateOutput({
        userMessage,
        finalText: "下一場是 7/22（三）。",
        now: new Date("2026-07-16T04:00:00.000Z"),
      });
      expect(result.status).toBe("corrected");
      expect(result.text).toBe("下一場是 7/19（日）。");
    }
  });

  test("fails closed for recurrence weekday exclusions", () => {
    for (const userMessage of [
      "The session runs every day except Sunday at 19:00; when is the next session?",
      "The session runs every Wednesday except Sunday at 19:00; when is the next session?",
      "The session runs every Wednesday excluding Sunday at 19:00; when is the next session?",
      "The session runs every Wednesday but not Sunday at 19:00; when is the next session?",
      "The session runs every Wednesday, not including Sunday, at 19:00; when is the next session?",
      "銷講每週三但不含週日 19:00 舉行，下一場是哪天？",
      "銷講每週三排除週日 19:00 舉行，下一場是哪天？",
      "銷講每週三但不週日 19:00 舉行，下一場是哪天？",
      "銷講每週三，除了週日以外，19:00 舉行，下一場是哪天？",
    ]) {
      expect(
        guardDateOutput({
          userMessage,
          finalText: "下一場是 7/19（日）。",
          now: new Date("2026-07-16T04:00:00.000Z"),
        })
      ).toEqual({
        status: "blocked",
        text: "我目前沒有取得可驗證的場次日期，因此不能猜下一場。請讓我先查詢實際排程，或提供固定週期與時間。",
        reason: "next_occurrence_without_temporal_evidence",
      });
    }
  });

  test("keeps distinct English recurrence clauses ambiguous", () => {
    expect(
      guardDateOutput({
        userMessage:
          "Originally weekly on Wednesday at 19:00, changed to weekly on Sunday at 19:00; when is the next session?",
        finalText: "下一場是 7/19（日）。",
        now: new Date("2026-07-16T04:00:00.000Z"),
      })
    ).toEqual({
      status: "blocked",
      text: "我目前沒有取得可驗證的場次日期，因此不能猜下一場。請讓我先查詢實際排程，或提供固定週期與時間。",
      reason: "next_occurrence_without_temporal_evidence",
    });
  });

  test("corrects every explicitly linked next-occurrence claim", () => {
    const result = guardDateOutput({
      userMessage: "請查下一場銷講",
      finalText: "下一場是 7/22（三）；換句話說，下次是 7/23（四）。",
      now: NOW,
      trustedTemporalCandidates: ["2026-07-16"],
    });

    expect(result.status).toBe("corrected");
    expect(result.text).toBe(
      "下一場是 7/16（四）；換句話說，下次是 7/16（四）。"
    );
  });

  test("resolves an explicit current-turn weekly recurrence", () => {
    const result = guardDateOutput({
      userMessage: "銷講每週三舉行，下一場是哪一天？",
      finalText: "下一場是 7/22（三）。",
      now: NOW,
    });

    expect(result.status).toBe("corrected");
    expect(result.text).toBe("下一場是 7/15（三）。");
  });

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
    for (const finalText of ["下下週三 7/29（三）", "上上週日 7/5（日）"]) {
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
      "這週三天有課，日期是 7/16（四）",
      "本週四個活動，日期是 7/17（五）",
      "本週日曆標示 7/16（四）",
      "這週一共有三場課，日期是 7/16（四）",
      "本週日常安排：7/16（四）",
      "這週六人參加，日期是 7/17（五）",
      "本週五門課，下一堂是 7/16（四）",
    ]) {
      expect(
        guardDateOutput({ userMessage: finalText, finalText, now: NOW })
      ).toEqual({ status: "unchanged", text: finalText });
    }
  });

  test("recognizes explicit and bare weekday claims before event nouns", () => {
    for (const finalText of [
      "這週星期三期末考是 7/9（三）",
      "這週三期末考是 7/9（三）",
    ]) {
      const result = guardDateOutput({
        userMessage: finalText,
        finalText,
        now: NOW,
      });

      expect(result.status).toBe("corrected");
      expect(result.text).toBe(finalText.replace("7/9", "7/15"));
    }
  });

  test("recognizes a bare weekday linked by an explicit date connector", () => {
    for (const finalText of [
      "這週三的日期為 7/9（三）",
      "這週三的日期是 7/9（三）",
      "這週三，日期是 7/9（三）",
      "這週三預定日期為 7/9（三）",
    ]) {
      const result = guardDateOutput({
        userMessage: finalText,
        finalText,
        now: NOW,
      });

      expect(result.status).toBe("corrected");
      expect(result.text).toBe(finalText.replace("7/9", "7/15"));
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

  test("supports only explicit connectors for relative day claims", () => {
    for (const [finalText, expected] of [
      ["今天 7/9（三）", "今天 7/13（一）"],
      ["今天的日期為 7/9（三）", "今天的日期為 7/13（一）"],
    ] as const) {
      expect(
        guardDateOutput({ userMessage: finalText, finalText, now: NOW }).text
      ).toBe(expected);
    }

    for (const finalText of [
      "今天氣溫資料來自 7/12（日）",
      "昨天的報表涵蓋到 7/9（四）",
    ]) {
      expect(
        guardDateOutput({ userMessage: finalText, finalText, now: NOW })
      ).toEqual({ status: "unchanged", text: finalText });
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

  test("does not correct explicit ISO dates embedded in identifier or path tokens", () => {
    for (const finalText of [
      "version_2026-07-16 (星期三)",
      "release-2026-07-16 (星期三)",
      "/2026-07-16 (星期三)",
      "report.2026-07-16 (星期三)",
    ]) {
      expect(
        guardDateOutput({
          userMessage: "請核對這些日期格式 token",
          finalText,
          now: NOW,
        })
      ).toEqual({ status: "unchanged", text: finalText });
    }
  });

  test("still corrects a punctuated natural-language ISO date claim", () => {
    expect(
      guardDateOutput({
        userMessage: "請核對日期",
        finalText: "日期：（2026-07-16 (星期三)）",
        now: NOW,
      }).text
    ).toBe("日期：（2026-07-16 (星期四)）");
  });

  test("does not correct short dates embedded in identifier or path tokens", () => {
    for (const finalText of [
      "version_7/16（三）",
      "release-7/16（三）",
      "/7/16（三）",
      "report.7/16（三）",
    ]) {
      expect(
        guardDateOutput({
          userMessage: "請核對這些日期格式 token",
          finalText,
          now: NOW,
        })
      ).toEqual({ status: "unchanged", text: finalText });
    }
  });

  test("still corrects a punctuated natural-language short date claim", () => {
    expect(
      guardDateOutput({
        userMessage: "請核對日期",
        finalText: "日期：（7/16（三））",
        now: NOW,
      }).text
    ).toBe("日期：（7/16（四））");
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

describe("extractTrustedTemporalCandidates", () => {
  test("associates production MCP candidates with sanitized same-record labels", () => {
    const envelope = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            events: [
              { title: "內部會議", startTime: "2026-07-14T19:00:00+08:00" },
              { title: "銷講", startTime: "2026-07-16T19:00:00+08:00" },
            ],
          }),
        },
      ],
      details: {},
    };

    expect(extractTrustedTemporalEvidence(envelope)).toEqual([
      {
        candidate: "2026-07-14T19:00:00+08:00",
        label: "內部會議",
      },
      { candidate: "2026-07-16T19:00:00+08:00", label: "銷講" },
    ]);

    const result = guardDateOutput({
      userMessage: "幫我查下一場銷講",
      finalText: "下一場銷講是 7/16（四）。",
      now: NOW,
      trustedTemporalCandidates: extractTrustedTemporalCandidates(envelope),
      trustedTemporalEvidence: extractTrustedTemporalEvidence(envelope),
    });
    expect(result).toEqual({
      status: "unchanged",
      text: "下一場銷講是 7/16（四）。",
    });

    expect(
      guardDateOutput({
        userMessage: "幫我查下一場",
        finalText: "下一場銷講是 7/16（四）。",
        now: NOW,
        trustedTemporalCandidates: extractTrustedTemporalCandidates(envelope),
        trustedTemporalEvidence: extractTrustedTemporalEvidence(envelope),
      })
    ).toEqual({
      status: "unchanged",
      text: "下一場銷講是 7/16（四）。",
    });
  });

  test("fails closed when labeled evidence has zero or multiple label matches", () => {
    const candidates = [
      "2026-07-14T19:00:00+08:00",
      "2026-07-16T19:00:00+08:00",
    ];
    const evidence = [
      { candidate: candidates[0]!, label: "內部會議" },
      { candidate: candidates[1]!, label: "銷講" },
    ];

    for (const [userMessage, finalText] of [
      ["幫我查下一場銷售講座", "下一場銷售講座是 7/20（一）。"],
      ["幫我比較下一場內部會議和銷講", "下一場內部會議和銷講是 7/20（一）。"],
    ] as const) {
      expect(
        guardDateOutput({
          userMessage,
          finalText,
          now: NOW,
          trustedTemporalCandidates: candidates,
          trustedTemporalEvidence: evidence,
        })
      ).toEqual({
        status: "blocked",
        text: "我目前沒有取得可驗證的場次日期，因此不能猜下一場。請讓我先查詢實際排程，或提供固定週期與時間。",
        reason: "next_occurrence_without_temporal_evidence",
      });
    }
  });

  test("prioritizes a non-generic final claim descriptor over the user target", () => {
    const salesEvidence = [
      {
        candidate: "2026-07-16T19:00:00+08:00",
        label: "銷講",
      },
    ];

    expect(
      guardDateOutput({
        userMessage: "銷講每週四 19:00 舉行，幫我查下一場銷講",
        finalText: "下一場內部會議是 7/14（二）。",
        now: NOW,
        trustedTemporalCandidates: salesEvidence.map(
          (item) => item.candidate
        ),
        trustedTemporalEvidence: salesEvidence,
      })
    ).toEqual({
      status: "blocked",
      text: "我目前沒有取得可驗證的場次日期，因此不能猜下一場。請讓我先查詢實際排程，或提供固定週期與時間。",
      reason: "next_occurrence_without_temporal_evidence",
    });
  });

  test("uses a unique matching final claim descriptor", () => {
    expect(
      guardDateOutput({
        userMessage: "幫我查下一場銷講",
        finalText: "下一場內部會議是 7/20（一）。",
        now: NOW,
        trustedTemporalEvidence: [
          {
            candidate: "2026-07-14T19:00:00+08:00",
            label: "內部會議",
          },
          {
            candidate: "2026-07-16T19:00:00+08:00",
            label: "銷講",
          },
        ],
      })
    ).toEqual({
      status: "corrected",
      text: "下一場內部會議是 7/14（二）。",
      corrections: [
        {
          reason: "relative_date_mismatch",
          original: "7/20（一）",
          replacement: "7/14（二）",
        },
      ],
    });
  });

  test("falls back to the user target for a generic final claim descriptor", () => {
    expect(
      guardDateOutput({
        userMessage: "幫我查下一場銷講",
        finalText: "下一場是 7/20（一）。",
        now: NOW,
        trustedTemporalEvidence: [
          {
            candidate: "2026-07-14T19:00:00+08:00",
            label: "內部會議",
          },
          {
            candidate: "2026-07-16T19:00:00+08:00",
            label: "銷講",
          },
        ],
      })
    ).toEqual({
      status: "corrected",
      text: "下一場是 7/16（四）。",
      corrections: [
        {
          reason: "relative_date_mismatch",
          original: "7/20（一）",
          replacement: "7/16（四）",
        },
      ],
    });
  });

  test("matches generic claims to the adjacent requested event target", () => {
    const evidence = [
      {
        candidate: "2026-07-14T19:00:00+08:00",
        label: "內部會議",
      },
      {
        candidate: "2026-07-16T19:00:00+08:00",
        label: "銷講",
      },
    ];
    for (const userMessage of [
      "不要管內部會議，幫我查下一場銷講",
      "內部會議已取消，幫我查下一場銷講",
      "幫我查銷講的下一場",
      "幫我查下一場銷講的日期",
      "幫我查下一場銷講的時間",
      "幫我查下一場銷講的目前報名狀況",
      "幫我查下一場銷講的目前報名狀況嗎？",
      "幫我查下一場銷講的目前報名狀況如何？",
      "帮我查下一場銷講的当前报名状况",
      "幫我查下一場銷講報名人數",
      "幫我查下一場銷講的报名数",
      "不要查下一場內部會議，幫我查下一場銷講",
    ]) {
      expect(
        guardDateOutput({
          userMessage,
          finalText: "下一場是 7/20（一）。",
          now: NOW,
          trustedTemporalEvidence: evidence,
        })
      ).toEqual({
        status: "corrected",
        text: "下一場是 7/16（四）。",
        corrections: [
          {
            reason: "relative_date_mismatch",
            original: "7/20（一）",
            replacement: "7/16（四）",
          },
        ],
      });
    }
  });

  test("does not substring-match a requested target to an evidence label", () => {
    expect(
      guardDateOutput({
        userMessage: "幫我查下一場進階銷講",
        finalText: "下一場是 7/20（一）。",
        now: NOW,
        trustedTemporalEvidence: [
          {
            candidate: "2026-07-16T19:00:00+08:00",
            label: "銷講",
          },
        ],
      })
    ).toEqual({
      status: "blocked",
      text: "我目前沒有取得可驗證的場次日期，因此不能猜下一場。請讓我先查詢實際排程，或提供固定週期與時間。",
      reason: "next_occurrence_without_temporal_evidence",
    });
  });

  test("fails closed for absent, ambiguous, or negated requested targets", () => {
    for (const userMessage of [
      "幫我查下一場",
      "幫我查下一場銷講和內部會議",
      "不要查下一場銷講",
      "幫我查下一場內部會議，也查下一場銷講",
    ]) {
      expect(
        guardDateOutput({
          userMessage,
          finalText: "下一場是 7/20（一）。",
          now: NOW,
          trustedTemporalEvidence: [
            {
              candidate: "2026-07-16T19:00:00+08:00",
              label: "銷講",
            },
          ],
        })
      ).toEqual({
        status: "blocked",
        text: "我目前沒有取得可驗證的場次日期，因此不能猜下一場。請讓我先查詢實際排程，或提供固定週期與時間。",
        reason: "next_occurrence_without_temporal_evidence",
      });
    }
  });

  test("uses an explicit recurrence for a generic claim despite unrelated labeled evidence", () => {
    expect(
      guardDateOutput({
        userMessage: "銷講每週三舉行，下一場是哪一天？",
        finalText: "下一場是 7/22（三）。",
        now: NOW,
        trustedTemporalEvidence: [
          {
            candidate: "2026-07-14T19:00:00+08:00",
            label: "內部會議",
          },
        ],
      })
    ).toEqual({
      status: "corrected",
      text: "下一場是 7/15（三）。",
      corrections: [
        {
          reason: "relative_date_mismatch",
          original: "7/22（三）",
          replacement: "7/15（三）",
        },
      ],
    });
  });

  test("uses recurrence when a named claim matches the recurrence subject", () => {
    for (const userMessage of [
      "銷講每週三舉行，下一場銷講是哪一天？",
      "請記得銷講每週三舉行，下一場銷講是哪一天？",
      "目前銷講每週三舉行，下一場銷講是哪一天？",
      "現在銷講每週三舉行，下一場銷講是哪一天？",
      "請注意銷講每週三舉行，下一場銷講是哪一天？",
      "幫我查銷講每週三舉行，下一場銷講是哪一天？",
      "请帮我查 銷講每週三舉行，下一場銷講是哪一天？",
      "請問銷講每週三舉行，下一場銷講是哪一天？",
      "我想知道銷講每週三舉行，下一場銷講是哪一天？",
      "麻煩查 銷講每週三舉行，下一場銷講是哪一天？",
    ]) {
      expect(
        guardDateOutput({
          userMessage,
          finalText: "下一場銷講是 7/22（三）。",
          now: NOW,
          trustedTemporalEvidence: [
            {
              candidate: "2026-07-14T19:00:00+08:00",
              label: "內部會議",
            },
          ],
        })
      ).toEqual({
        status: "corrected",
        text: "下一場銷講是 7/15（三）。",
        corrections: [
          {
            reason: "relative_date_mismatch",
            original: "7/22（三）",
            replacement: "7/15（三）",
          },
        ],
      });
    }
  });

  test("fails closed when a named claim conflicts with the recurrence subject", () => {
    for (const [userMessage, finalText] of [
      [
        "銷講固定每週三舉行，下一場銷講是哪一天？",
        "下一場內部會議是 7/22（三）。",
      ],
      [
        "目前內部會議每週三舉行，下一場銷講是哪一天？",
        "下一場銷講是 7/22（三）。",
      ],
      [
        "A班銷講每週三舉行，下一場銷講是哪一天？",
        "下一場銷講是 7/22（三）。",
      ],
      [
        "進階銷講每週三舉行，下一場銷講是哪一天？",
        "下一場銷講是 7/22（三）。",
      ],
    ]) {
      expect(
        guardDateOutput({
          userMessage,
          finalText,
          now: NOW,
          trustedTemporalEvidence: [
            {
              candidate: "2026-07-14T19:00:00+08:00",
              label: "內部會議",
            },
          ],
        })
      ).toEqual({
        status: "blocked",
        text: "我目前沒有取得可驗證的場次日期，因此不能猜下一場。請讓我先查詢實際排程，或提供固定週期與時間。",
        reason: "next_occurrence_without_temporal_evidence",
      });
    }
  });

  test("fails closed for conflicting non-generic final claim descriptors", () => {
    expect(
      guardDateOutput({
        userMessage: "活動每週四 19:00 舉行，幫我查下一場活動",
        finalText:
          "下一場內部會議是 7/20（一）；下一場銷講是 7/21（二）。",
        now: NOW,
        trustedTemporalEvidence: [
          {
            candidate: "2026-07-14T19:00:00+08:00",
            label: "內部會議",
          },
          {
            candidate: "2026-07-16T19:00:00+08:00",
            label: "銷講",
          },
        ],
      })
    ).toEqual({
      status: "blocked",
      text: "我目前沒有取得可驗證的場次日期，因此不能猜下一場。請讓我先查詢實際排程，或提供固定週期與時間。",
      reason: "next_occurrence_without_temporal_evidence",
    });
  });

  test("does not use an unsafe one-character evidence label as a match", () => {
    expect(
      guardDateOutput({
        userMessage: "幫我查下一場會議",
        finalText: "下一場會議是 7/20（一）。",
        now: NOW,
        trustedTemporalCandidates: ["2026-07-14T19:00:00+08:00"],
        trustedTemporalEvidence: [
          { candidate: "2026-07-14T19:00:00+08:00", label: "會" },
        ],
      })
    ).toEqual({
      status: "blocked",
      text: "我目前沒有取得可驗證的場次日期，因此不能猜下一場。請讓我先查詢實際排程，或提供固定週期與時間。",
      reason: "next_occurrence_without_temporal_evidence",
    });
  });

  test("extracts dates from the production structured MCP text envelope", () => {
    const result = extractTrustedTemporalCandidates({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            events: [{ startTime: "2026-07-16T20:00:00+08:00" }],
          }),
        },
      ],
      details: {},
    });

    expect(result).toEqual(["2026-07-16T20:00:00+08:00"]);
  });

  test("does not parse natural-language MCP text as trusted dates", () => {
    expect(
      extractTrustedTemporalCandidates({
        content: [{ type: "text", text: "The next session is 2026-07-16." }],
      })
    ).toEqual([]);
  });

  test("does not parse oversized structured MCP text", () => {
    const text = JSON.stringify({
      padding: "x".repeat(64_000),
      date: "2026-07-16",
    });
    expect(
      extractTrustedTemporalCandidates({
        content: [{ type: "text", text }],
      })
    ).toEqual([]);
  });

  test("extracts only strict ISO strings under temporal keys and deduplicates", () => {
    const result = extractTrustedTemporalCandidates({
      events: [
        { startDate: "2026-07-16", title: "2026-07-15" },
        { scheduledAt: "2026-07-22T09:00:00+08:00" },
        { timestamp: "2026-07-22T01:00:00Z" },
        { date: "2026-02-30" },
        { occursAt: "2026-07-16" },
        { start_date: "2026-07-17" },
      ],
    });

    expect(result).toEqual([
      "2026-07-16",
      "2026-07-22T09:00:00+08:00",
      "2026-07-22T01:00:00Z",
    ]);
  });

  test("bounds traversal by depth and number of visited values", () => {
    const tooDeep = {
      one: { two: { three: { four: { five: { date: "2026-07-16" } } } } },
    };
    const many = Array.from({ length: 250 }, (_, index) => ({
      date: `2026-08-${String((index % 28) + 1).padStart(2, "0")}`,
    }));

    expect(extractTrustedTemporalCandidates(tooDeep)).toEqual([]);
    expect(extractTrustedTemporalCandidates(many).length).toBeLessThanOrEqual(
      100
    );
  });

  test("handles cyclic and invalid values without retaining them", () => {
    const cyclic: Record<string, unknown> = {
      date: "not-an-iso-date",
      time: "2026-07-16T09:00:00",
    };
    cyclic.self = cyclic;

    expect(extractTrustedTemporalCandidates(cyclic)).toEqual([]);
  });

  test("does not invoke accessors and survives hostile proxies", () => {
    const withGetter = {} as Record<string, unknown>;
    Object.defineProperty(withGetter, "date", {
      enumerable: true,
      get() {
        throw new Error("getter must not run");
      },
    });
    const hostileProxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("proxy trap");
        },
      }
    );

    expect(extractTrustedTemporalCandidates(withGetter)).toEqual([]);
    expect(extractTrustedTemporalCandidates(hostileProxy)).toEqual([]);
  });

  test("caps descriptor inspection for huge direct arrays and objects", () => {
    let objectDescriptorVisits = 0;
    const hugeObjectTarget = Object.fromEntries(
      Array.from({ length: 1_000 }, (_, index) => [
        `field${index}`,
        { date: "2026-07-16" },
      ])
    );
    const hugeObject = new Proxy(hugeObjectTarget, {
      getOwnPropertyDescriptor(target, key) {
        objectDescriptorVisits += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });

    let arrayDescriptorVisits = 0;
    const hugeArray = new Proxy(
      Array.from({ length: 1_000 }, () => ({ date: "2026-07-16" })),
      {
        getOwnPropertyDescriptor(target, key) {
          arrayDescriptorVisits += 1;
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      }
    );

    extractTrustedTemporalCandidates(hugeObject);
    extractTrustedTemporalCandidates(hugeArray);
    expect(objectDescriptorVisits).toBeLessThanOrEqual(200);
    expect(arrayDescriptorVisits).toBeLessThanOrEqual(201);
  });
});
