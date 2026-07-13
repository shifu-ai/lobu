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
			"前 2026-07-16（星期四） 中 2026-07-17 (星期五) 後",
		);
		if (result.status === "corrected") {
			expect(result.corrections).toHaveLength(2);
		}
	});
});
