const WEEKDAYS_ZH = [
	"星期日",
	"星期一",
	"星期二",
	"星期三",
	"星期四",
	"星期五",
	"星期六",
] as const;

export type DateCorrection = {
	reason: "weekday_mismatch" | "relative_date_mismatch";
	original: string;
	replacement: string;
};

export type DateGuardResult =
	| { status: "unchanged"; text: string }
	| { status: "corrected"; text: string; corrections: DateCorrection[] }
	| { status: "blocked"; text: string; reason: string };

export type DateGuardInput = {
	userMessage: string;
	finalText: string;
	now: Date;
};

const EXPLICIT_DATE_WITH_WEEKDAY_RE =
	/(\d{4})-(\d{2})-(\d{2})(\s*[(（])(星期[日天一二三四五六])([)）])/g;

function validUtcDate(year: number, month: number, day: number): Date | null {
	const date = new Date(Date.UTC(year, month - 1, day));
	if (
		date.getUTCFullYear() !== year ||
		date.getUTCMonth() !== month - 1 ||
		date.getUTCDate() !== day
	) {
		return null;
	}
	return date;
}

export function guardDateOutput(input: DateGuardInput): DateGuardResult {
	const corrections: DateCorrection[] = [];
	const text = input.finalText.replace(
		EXPLICIT_DATE_WITH_WEEKDAY_RE,
		(match, yearText, monthText, dayText, beforeWeekday, weekday, closing) => {
			const date = validUtcDate(
				Number(yearText),
				Number(monthText),
				Number(dayText),
			);
			if (!date) return match;

			const expectedWeekday = WEEKDAYS_ZH[date.getUTCDay()] ?? weekday;
			if (weekday === expectedWeekday) return match;

			corrections.push({
				reason: "weekday_mismatch",
				original: weekday,
				replacement: expectedWeekday,
			});
			return `${yearText}-${monthText}-${dayText}${beforeWeekday}${expectedWeekday}${closing}`;
		},
	);

	return corrections.length > 0
		? { status: "corrected", text, corrections }
		: { status: "unchanged", text };
}
