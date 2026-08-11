// packages/agent-worker/src/openclaw/date-entry-annotation.ts
//
// 入口標註：使用者訊息進模型前，把無歧義的相對日期詞標註成絕對日期，
// 讓模型不需要（也沒機會）自己心算日期。
// 契約：純函式、絕不 throw；任何解析失敗回傳原文（fail-open 到 prompt 日期表防線）。
//
// 核心原則：寧可不標（fail-open 安全），絕不蓋錯章（fail-wrong 比不標毒）。
// 下面兩個 RE 的負向環視/lookahead 都是碰撞詞 deny-list，天生不完備——
// 抓到新的複合詞碰撞（「XX天/XX週」被截斷誤標）時，照這個模式補一個字元到
// 對應的 (?<![...]) 或 (?![...])，不要改動配對邏輯本身。寧可補漏後仍有極少數
// 正常句被誤壓（fail-open），也不要放寬環視讓錯誤日期蓋過去（fail-wrong）。

const DAY_MS = 86_400_000;
const DEFAULT_TIME_ZONE = "Asia/Taipei";

// 相對日詞 → 相對今天的天數。負向環視排除 CJK 複合詞碰撞：
// 前天：目/之/以/大（大前天）
// 今天：至/如/現/现/當/当
// 明天：聰/聪/發/发/證/证/查/表/阐/闡/說/说（說明天氣）
// 後天/后天：以/之/落/前/大（大後天）/然/最/午/稍（然後天氣）
const REL_DAY_OFFSETS: Record<string, number> = {
  前天: -2,
  昨天: -1,
  今天: 0,
  明天: 1,
  後天: 2,
  后天: 2,
};
const REL_DAY_RE =
  /(?<![目之以大])(前天)|(?<![至如現现當当])(今天)|(?<![聰聪發发證证查表阐闡說说])(明天)|(?<![以之落前大然最午稍])([後后]天)|(昨天)/g;

// 相對週：週/周 只接 一~六和日（「下週天氣」的「天」是天氣不是星期天）；
// 禮拜/星期 額外接受「天」。
// lead 前不可接 上/下/一/大/小（上上週、下下週、一下週五、大小週 等複合詞截斷）。
// weekday 後不可接 程/期（下週日程、本週日期）、氣/气（下週天氣、下禮拜天氣、
// 這星期天氣）、本（下週日本出差）、或另一個星期字（一二三四五六日天：
// 上週六日、下週三四 這種列舉寫法會把附掛的字孤立在括號後面，寧可整組不標）。
const WEEK_TERM_RE =
  /(?<![上下一大小])([上本這这下])(?:[個个])?(?:(?:[週周])([一二三四五六日])|(?:禮拜|礼拜|星期)([一二三四五六日天]))(?![程期氣气本一二三四五六日天])/g;

const WEEKDAY_MON0: Record<string, number> = {
  一: 0,
  二: 1,
  三: 2,
  四: 3,
  五: 4,
  六: 5,
  日: 6,
  天: 6,
};

// 詞後已緊跟日期（含括號包裹）→ 不重複標
const ALREADY_DATED_RE =
  /^\s*[（(]?\s*(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\s*[/月]\s*\d{1,2})/;

// weekdayMon0 用純算術從 y/m/d 換算，不依賴 Intl 的 weekday:"short" 輸出——
// 部分 ICU 版本對 en-CA 縮寫會帶句點或用不同大小寫，對照表查不到就會回
// undefined，一路連鎖 throw 到外層 catch，讓整個標註功能靜默熄火。
// getUTCDay() 回傳 0=Sun..6=Sat；(d+6)%7 轉成 0=Mon..6=Sun（Mon0）。
function zonedToday(
  now: Date,
  timeZone: string
): { anchorUtcMs: number; weekdayMon0: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const y = Number(get("year"));
  const m = Number(get("month"));
  const d = Number(get("day"));
  if (!y || !m || !d) {
    throw new Error("unparseable zoned date");
  }
  const anchorUtcMs = Date.UTC(y, m - 1, d);
  const weekdayMon0 = (new Date(anchorUtcMs).getUTCDay() + 6) % 7;
  return { anchorUtcMs, weekdayMon0 };
}

let hasWarnedAnnotateFailure = false;

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
      new Date(today.anchorUtcMs + offsetDays * DAY_MS)
        .toISOString()
        .slice(0, 10);
    const mondayOffset = -today.weekdayMon0;

    const alreadyDated = (whole: string, matchEnd: number) =>
      ALREADY_DATED_RE.test(whole.slice(matchEnd));

    let out = text.replace(
      WEEK_TERM_RE,
      (
        match,
        lead: string,
        wdWeek: string | undefined,
        wdOther: string | undefined,
        offset: number,
        whole: string
      ) => {
        if (alreadyDated(whole, offset + match.length)) return match;
        const wd = wdWeek ?? wdOther;
        if (!wd || WEEKDAY_MON0[wd] === undefined) return match;
        const base = lead === "上" ? -7 : lead === "下" ? 7 : 0;
        return `${match}（${iso(mondayOffset + base + WEEKDAY_MON0[wd])}）`;
      }
    );

    // 警示：REL_DAY_RE 目前只有 5 個「未命名」capture group。JS replace callback
    // 固定把 offset/whole 放在參數列表最後兩位，所以 rest[rest.length-1]/[-2]
    // 目前是安全的——但如果之後把任何一個 group 改成 named group（例如
    // (?<preday>前天)），JS 會在參數尾端多塞一個 groups 物件，這裡的位置假設
    // 就會靜默錯位（whole/offset 會拿到錯的值，alreadyDated 判斷失準）。
    // 改動前務必同步改這裡，改成從 groups 物件讀值。
    out = out.replace(REL_DAY_RE, (match, ...rest) => {
      const whole = rest[rest.length - 1] as string;
      const offset = rest[rest.length - 2] as number;
      if (alreadyDated(whole, offset + match.length)) return match;
      const days = REL_DAY_OFFSETS[match];
      if (days === undefined) return match;
      return `${match}（${iso(days)}）`;
    });

    return out;
  } catch (error) {
    if (!hasWarnedAnnotateFailure) {
      hasWarnedAnnotateFailure = true;
      console.warn(
        "[date-entry-annotation] annotateRelativeDates failed; falling back to raw text (fail-open). This warning only fires once per process.",
        error
      );
    }
    return text;
  }
}
