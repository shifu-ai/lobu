import { describe, expect, test } from "bun:test";
import { guardDateOutput } from "../openclaw/date-output-guard";

describe("guardDateOutput", () => {
	test("corrects an explicit ISO date with the wrong Chinese weekday", () => {
		const result = guardDateOutput({
			userMessage: "2026-07-16 是星期幾？",
			finalText: "日期是 2026-07-16 (星期三)。",
			now: new Date("2026-07-13T10:15:00.000Z"),
		});
		expect(result.status).toBe("corrected");
		expect(result.text).toBe("日期是 2026-07-16 (星期四)。");
	});
});
