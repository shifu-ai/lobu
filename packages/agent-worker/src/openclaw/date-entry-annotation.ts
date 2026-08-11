// packages/agent-worker/src/openclaw/date-entry-annotation.ts
//
// 入口標註：使用者訊息進模型前，把無歧義的相對日期詞標註成絕對日期，
// 讓模型不需要（也沒機會）自己心算日期。
// 契約：純函式、絕不 throw；任何解析失敗回傳原文（fail-open 到 prompt 日期表防線）。

const DAY_MS = 86_400_000;
const DEFAULT_TIME_ZONE = "Asia/Taipei";

// 相對日詞 → 相對今天的天數。負向環視排除「目前/聰明/以後/至今」等 CJK 複合詞碰撞。
const REL_DAY_OFFSETS: Record<string, number> = {
  前天: -2, 昨天: -1, 今天: 0, 明天: 1, 後天: 2, 后天: 2,
};
const REL_DAY_RE =
  /(?<![目之以])(前天)|(?<![至])(今天)|(?<![聰聪發发證证查表阐闡])(明天)|(?<![以之落前])([後后]天)|(昨天)/g;

// 相對週：週/周 只接 一~六和日（「下週天氣」的「天」是天氣不是星期天）；
// 禮拜/星期 額外接受「天」。weekday 後不可接 程/期（下週日程、本週日期）。
const WEEK_TERM_RE =
  /([上本這这下])(?:[個个])?(?:(?:[週周])([一二三四五六日])|(?:禮拜|礼拜|星期)([一二三四五六日天]))(?![程期])/g;

const WEEKDAY_MON0: Record<string, number> = {
  一: 0, 二: 1, 三: 2, 四: 3, 五: 4, 六: 5, 日: 6, 天: 6,
};

// 詞後已緊跟日期（含括號包裹）→ 不重複標
const ALREADY_DATED_RE =
  /^\s*[（(]?\s*(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\s*[\/月]\s*\d{1,2})/;

const WEEKDAY_SHORT_MON0: Record<string, number> = {
  Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6,
};

function zonedToday(now: Date, timeZone: string): { anchorUtcMs: number; weekdayMon0: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const y = Number(get("year"));
  const m = Number(get("month"));
  const d = Number(get("day"));
  const weekdayMon0 = WEEKDAY_SHORT_MON0[get("weekday")];
  if (!y || !m || !d || weekdayMon0 === undefined) {
    throw new Error("unparseable zoned date");
  }
  return { anchorUtcMs: Date.UTC(y, m - 1, d), weekdayMon0 };
}

export function annotateRelativeDates(
  text: string,
  now: Date = new Date(),
  timeZone?: string
): string {
  try {
    let today: ReturnType<typeof zonedToday>;
    try {
      today = zonedToday(now, timeZone || DEFAULT_TIME_ZONE);
    } catch {
      today = zonedToday(now, DEFAULT_TIME_ZONE);
    }
    const iso = (offsetDays: number) =>
      new Date(today.anchorUtcMs + offsetDays * DAY_MS).toISOString().slice(0, 10);
    const mondayOffset = -today.weekdayMon0;

    const alreadyDated = (whole: string, matchEnd: number) =>
      ALREADY_DATED_RE.test(whole.slice(matchEnd));

    let out = text.replace(
      WEEK_TERM_RE,
      (match, lead: string, wdWeek: string | undefined, wdOther: string | undefined,
       offset: number, whole: string) => {
        if (alreadyDated(whole, offset + match.length)) return match;
        const wd = wdWeek ?? wdOther;
        if (!wd || WEEKDAY_MON0[wd] === undefined) return match;
        const base = lead === "上" ? -7 : lead === "下" ? 7 : 0;
        return `${match}（${iso(mondayOffset + base + WEEKDAY_MON0[wd])}）`;
      }
    );

    out = out.replace(REL_DAY_RE, (match, ...rest) => {
      const whole = rest[rest.length - 1] as string;
      const offset = rest[rest.length - 2] as number;
      if (alreadyDated(whole, offset + match.length)) return match;
      const days = REL_DAY_OFFSETS[match];
      if (days === undefined) return match;
      return `${match}（${iso(days)}）`;
    });

    return out;
  } catch {
    return text;
  }
}
