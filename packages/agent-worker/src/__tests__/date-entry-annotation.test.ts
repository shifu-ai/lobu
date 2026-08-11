import { describe, expect, test } from "bun:test";
import { annotateRelativeDates } from "../openclaw/date-entry-annotation";

// 凍結時鐘：2026-08-11（二）12:00 台北時間 = 04:00 UTC
const NOW = new Date("2026-08-11T04:00:00Z");
const TZ = "Asia/Taipei";
const run = (s: string) => annotateRelativeDates(s, NOW, TZ);

describe("相對週", () => {
	test("上週二 → 2026-08-04", () => {
		expect(run("上週二的戰報")).toBe("上週二（2026-08-04）的戰報");
	});
	test("簡體/變體：上周五、上禮拜五、上星期五都認", () => {
		expect(run("上周五")).toBe("上周五（2026-08-07）");
		expect(run("上禮拜五")).toBe("上禮拜五（2026-08-07）");
		expect(run("上星期五")).toBe("上星期五（2026-08-07）");
	});
	test("本週/這週/下週", () => {
		expect(run("本週一")).toBe("本週一（2026-08-10）");
		expect(run("這週三")).toBe("這週三（2026-08-12）");
		expect(run("下週一")).toBe("下週一（2026-08-17）");
	});
	test("星期天/禮拜天認「天」；週天不存在所以不標", () => {
		expect(run("下星期天")).toBe("下星期天（2026-08-23）");
		expect(run("下週天氣如何")).toBe("下週天氣如何"); // 不可標成 下週天（…）氣
	});
	test("下週日程 不可誤標", () => {
		expect(run("確認下週日程")).toBe("確認下週日程");
	});
});

describe("相對日", () => {
	test("昨天/今天/明天/前天/後天", () => {
		expect(run("昨天")).toBe("昨天（2026-08-10）");
		expect(run("今天")).toBe("今天（2026-08-11）");
		expect(run("明天")).toBe("明天（2026-08-12）");
		expect(run("前天")).toBe("前天（2026-08-09）");
		expect(run("後天")).toBe("後天（2026-08-13）");
		expect(run("后天")).toBe("后天（2026-08-13）");
	});
	test("詞是別的詞的一部分時不標（CJK 碰撞集）", () => {
		expect(run("目前天氣不錯")).toBe("目前天氣不錯");
		expect(run("聰明天才")).toBe("聰明天才");
		expect(run("以後天天運動")).toBe("以後天天運動");
		expect(run("至今天天向上")).toBe("至今天天向上");
		expect(run("之前天冷")).toBe("之前天冷");
	});
});

describe("複合詞截斷誤標（C1）", () => {
	test("大後天/大前天 不可誤標成 後天/前天", () => {
		expect(run("大後天交報告")).toBe("大後天交報告");
		expect(run("大前天")).toBe("大前天");
	});
	test("上上週/下下週 不可誤標成 上週/下週", () => {
		expect(run("上上週三")).toBe("上上週三");
		expect(run("下下週一")).toBe("下下週一");
	});
	test("「一下週五」的「一下」不可誤標成「下週五」", () => {
		expect(run("幫我看一下週五的名單")).toBe("幫我看一下週五的名單");
	});
});

describe("天氣類碰撞（C2）", () => {
	test("這星期天氣如何 / 下禮拜天氣好嗎 不可誤標成 星期天/禮拜天", () => {
		expect(run("這星期天氣如何")).toBe("這星期天氣如何");
		expect(run("下禮拜天氣好嗎")).toBe("下禮拜天氣好嗎");
	});
});

describe("高頻碰撞詞 deny-list（I3）", () => {
	test("說明天氣 / 如今天氣 / 然後天氣 不可誤標", () => {
		expect(run("請說明天氣預報的資料來源")).toBe("請說明天氣預報的資料來源");
		expect(run("如今天氣越來越熱")).toBe("如今天氣越來越熱");
		expect(run("然後天氣好的話")).toBe("然後天氣好的話");
	});
	test("下週日本出差 不可誤標成 下週日", () => {
		expect(run("下週日本出差")).toBe("下週日本出差");
	});
});

describe("列舉寫法孤兒字（I4）", () => {
	test("上週六日 / 下週三四 整組抑制，不可把後接的星期字孤立", () => {
		expect(run("上週六日的營收")).toBe("上週六日的營收");
		expect(run("下週三四會出差")).toBe("下週三四會出差");
	});
});

describe("既有抑制迴歸（deferred b）", () => {
	test("下週日期未定 / 下禮拜三期中考 不可誤標", () => {
		expect(run("下週日期未定")).toBe("下週日期未定");
		expect(run("下禮拜三期中考")).toBe("下禮拜三期中考");
	});
});

describe("外層 catch fail-open（I2）", () => {
	test("zonedToday 對兩個時區都 throw 時，outer catch 仍回原文而非拋出", () => {
		const originalDateTimeFormat = Intl.DateTimeFormat;
		// @ts-expect-error 刻意打壞 Intl 讓 zonedToday 兩次嘗試都 throw，逼進外層 catch
		Intl.DateTimeFormat = function () {
			throw new Error("boom: Intl unavailable");
		} as unknown as typeof Intl.DateTimeFormat;
		try {
			expect(() => annotateRelativeDates("今天", NOW, TZ)).not.toThrow();
			expect(annotateRelativeDates("今天", NOW, TZ)).toBe("今天");
		} finally {
			Intl.DateTimeFormat = originalDateTimeFormat;
		}
	});
});

describe("防重標與冪等", () => {
	test("詞後已有日期 → 不標", () => {
		expect(run("上週二（2026-08-04）的戰報")).toBe(
			"上週二（2026-08-04）的戰報",
		);
		expect(run("上週二(8/4)的戰報")).toBe("上週二(8/4)的戰報");
		expect(run("上週二 2026-08-04 的戰報")).toBe("上週二 2026-08-04 的戰報");
	});
	test("跑兩次結果相同（冪等）", () => {
		const once = run("上週二和昨天");
		expect(run(once)).toBe(once);
	});
});

describe("時區與 fail-open", () => {
	test("跨日界：UTC 已是 8/11 但檀香山還是 8/10", () => {
		expect(annotateRelativeDates("今天", NOW, "Pacific/Honolulu")).toBe(
			"今天（2026-08-10）",
		);
	});
	test("無效時區 → 回退 Asia/Taipei 而非 throw", () => {
		expect(annotateRelativeDates("今天", NOW, "Not/AZone")).toBe(
			"今天（2026-08-11）",
		);
	});
	test("timeZone 未提供 → 預設台北", () => {
		expect(annotateRelativeDates("今天", NOW)).toBe("今天（2026-08-11）");
	});
	test("無相對詞 → 原文原樣", () => {
		expect(run("給我八月的營收")).toBe("給我八月的營收");
	});
});
