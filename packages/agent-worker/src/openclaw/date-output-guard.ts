import {
  buildRelativeWeekCalendar,
  resolveRelativeDay,
  resolveRelativeWeekday,
  type CalendarDate,
  type RelativeDayReference,
  type RelativeWeekReference,
} from "./date-context";

const WEEKDAYS_ZH = [
  "星期日",
  "星期一",
  "星期二",
  "星期三",
  "星期四",
  "星期五",
  "星期六",
] as const;

const WEEKDAY_INDEX_ZH: Record<string, number> = {
  星期日: 0,
  星期天: 0,
  星期一: 1,
  星期二: 2,
  星期三: 3,
  星期四: 4,
  星期五: 5,
  星期六: 6,
};

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

const CHINESE_DATE_SENSITIVE_RE =
  /(?:今天|昨天|明天|上[週周]|本[週周]|這[週周]|这[周週]|下[週周]|(?:星期|週|周)[幾几日天一二三四五六]|(?:上一場|下一場|最近一場))/;
const ENGLISH_DATE_SENSITIVE_RE =
  /\b(?:date|today|tomorrow|yesterday|weekday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|(?:this|last|next)\s+(?:week|mon|monday|tue|tues|tuesday|wed|wednesday|thu|thur|thurs|thursday|fri|friday|sat|saturday|sun|sunday))\b/i;
const ISO_DATE_RE =
  /(?:^|[^\d])\d{4}-(?:0?[1-9]|1[0-2])-(?:0?[1-9]|[12]\d|3[01])(?:$|[^\d])/;
const SHORT_DATE_RE =
  /(?:^|[^\d/])(?:0?[1-9]|1[0-2])\/(?:0?[1-9]|[12]\d|3[01])(?:$|[^\d/])/;

export function isDateSensitiveTurn(promptText: string): boolean {
  return (
    CHINESE_DATE_SENSITIVE_RE.test(promptText) ||
    ENGLISH_DATE_SENSITIVE_RE.test(promptText) ||
    ISO_DATE_RE.test(promptText) ||
    SHORT_DATE_RE.test(promptText)
  );
}

const EXPLICIT_DATE_WITH_WEEKDAY_RE =
  /(?<!\d)(\d{4})-(\d{2})-(\d{2})(\s*[(（])(星期[日天一二三四五六])([)）])/g;

const RELATIVE_WEEK_DATE_RE =
  /(?<![上下本這大小前後])((上週|本週|這週|下週)\s*(?:(星期)([日天一二三四五六])|([日天一二三四五六])))((?:(?!(?:上週|本週|這週|下週|今天|昨天|明天))[^。\n\r！？；])*?)(?<!\d)(\d{1,2})\/(\d{1,2})(\s*[(（])((?:星期)?[日天一二三四五六])([)）])/g;
const RELATIVE_DAY_DATE_RE =
  /((今天|昨天|明天))((?:(?!(?:上週|本週|這週|下週|今天|昨天|明天))[^。\n\r！？；])*?)(?<!\d)(\d{1,2})\/(\d{1,2})(\s*[(（])((?:星期)?[日天一二三四五六])([)）])/g;
const SHORT_DATE_WITH_WEEKDAY_RE =
  /(?<![\d/-])(\d{1,2})\/(\d{1,2})(\s*[(（])((?:星期)?[日天一二三四五六])([)）])/g;

const RELATIVE_WEEK_REFERENCE: Record<string, RelativeWeekReference> = {
  上週: "previous",
  本週: "current",
  這週: "current",
  下週: "next",
};

const RELATIVE_DAY_REFERENCE: Record<string, RelativeDayReference> = {
  昨天: "yesterday",
  今天: "today",
  明天: "tomorrow",
};

function shortDate(parts: CalendarDate, monthStyle: string, dayStyle: string) {
  const month = String(parts.month).padStart(monthStyle.length, "0");
  const day = String(parts.day).padStart(dayStyle.length, "0");
  return `${month}/${day}`;
}

function weekdayFor(parts: CalendarDate): number {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
}

function weekdayWithStyle(original: string, expectedIndex: number): string {
  const originalIndex =
    WEEKDAY_INDEX_ZH[
      original.startsWith("星期") ? original : `星期${original}`
    ];
  if (originalIndex === expectedIndex) return original;

  const expected = WEEKDAYS_ZH[expectedIndex] ?? original;
  if (original.startsWith("星期")) return expected;
  return expected.slice(2);
}

function sameShortDate(parts: CalendarDate, month: number, day: number) {
  return parts.month === month && parts.day === day;
}

function isSupportedRelativeDateConnector(continuation: string): boolean {
  const normalized = continuation.trim();
  if (normalized === "" || normalized === "是") return true;
  if (/^(?:的日期|，日期|預定日期)[為是]$/.test(normalized)) return true;

  return /^(?:期中考|期末考|考試|課程|會議|活動|銷講|講座|上課|開會)是$/.test(
    normalized
  );
}

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
  let text = input.finalText.replace(
    RELATIVE_WEEK_DATE_RE,
    (
      match,
      claim,
      weekText,
      explicitWeekdayMarker,
      explicitWeekdayText,
      bareWeekdayText,
      between,
      monthText,
      dayText,
      beforeWeekday,
      weekday,
      closing
    ) => {
      const weekdayText = explicitWeekdayText ?? bareWeekdayText;
      if (
        !explicitWeekdayMarker &&
        !isSupportedRelativeDateConnector(between)
      ) {
        return match;
      }

      const reference = RELATIVE_WEEK_REFERENCE[weekText];
      const weekdayIndex = WEEKDAY_INDEX_ZH[`星期${weekdayText}`];
      if (!reference || weekdayIndex === undefined) return match;

      const expected = resolveRelativeWeekday(
        reference,
        weekdayIndex,
        input.now
      );
      const expectedWeekday = weekdayWithStyle(weekday, weekdayFor(expected));
      const expectedDate = shortDate(expected, monthText, dayText);
      const originalDate = `${monthText}/${dayText}`;
      if (originalDate === expectedDate && weekday === expectedWeekday)
        return match;

      const replacement = `${claim}${between}${expectedDate}${beforeWeekday}${expectedWeekday}${closing}`;
      corrections.push({
        reason: "relative_date_mismatch",
        original: match,
        replacement,
      });
      return replacement;
    }
  );

  text = text.replace(
    RELATIVE_DAY_DATE_RE,
    (
      match,
      claim,
      dayTextReference,
      between,
      monthText,
      dayText,
      beforeWeekday,
      weekday,
      closing
    ) => {
      const reference = RELATIVE_DAY_REFERENCE[dayTextReference];
      if (!reference) return match;
      if (!isSupportedRelativeDateConnector(between)) return match;

      const expected = resolveRelativeDay(reference, input.now);
      const expectedWeekday = weekdayWithStyle(weekday, weekdayFor(expected));
      const expectedDate = shortDate(expected, monthText, dayText);
      const originalDate = `${monthText}/${dayText}`;
      if (originalDate === expectedDate && weekday === expectedWeekday)
        return match;

      const replacement = `${claim}${between}${expectedDate}${beforeWeekday}${expectedWeekday}${closing}`;
      corrections.push({
        reason: "relative_date_mismatch",
        original: match,
        replacement,
      });
      return replacement;
    }
  );

  const calendar = buildRelativeWeekCalendar(input.now);
  const datesInWindow = [
    ...calendar.previous,
    ...calendar.current,
    ...calendar.next,
  ];
  text = text.replace(
    SHORT_DATE_WITH_WEEKDAY_RE,
    (match, monthText, dayText, beforeWeekday, weekday, closing) => {
      const date = datesInWindow.find((candidate) =>
        sameShortDate(candidate, Number(monthText), Number(dayText))
      );
      if (!date) return match;
      const expectedWeekday = weekdayWithStyle(weekday, weekdayFor(date));
      if (weekday === expectedWeekday) return match;

      corrections.push({
        reason: "weekday_mismatch",
        original: weekday,
        replacement: expectedWeekday,
      });
      return `${monthText}/${dayText}${beforeWeekday}${expectedWeekday}${closing}`;
    }
  );

  text = text.replace(
    EXPLICIT_DATE_WITH_WEEKDAY_RE,
    (match, yearText, monthText, dayText, beforeWeekday, weekday, closing) => {
      const date = validUtcDate(
        Number(yearText),
        Number(monthText),
        Number(dayText)
      );
      if (!date) return match;

      const expectedWeekdayIndex = date.getUTCDay();
      if (WEEKDAY_INDEX_ZH[weekday] === expectedWeekdayIndex) return match;
      const expectedWeekday = WEEKDAYS_ZH[expectedWeekdayIndex] ?? weekday;

      corrections.push({
        reason: "weekday_mismatch",
        original: weekday,
        replacement: expectedWeekday,
      });
      return `${yearText}-${monthText}-${dayText}${beforeWeekday}${expectedWeekday}${closing}`;
    }
  );

  return corrections.length > 0
    ? { status: "corrected", text, corrections }
    : { status: "unchanged", text };
}
