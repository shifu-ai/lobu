const TAIPEI_TIME_ZONE = "Asia/Taipei";
const WEEKDAY_LABELS_ZH_TW = [
  "星期日",
  "星期一",
  "星期二",
  "星期三",
  "星期四",
  "星期五",
  "星期六",
];

type DateParts = CalendarDate;

export type CalendarDate = {
  year: number;
  month: number;
  day: number;
};

export type RelativeWeekCalendar = {
  previous: CalendarDate[];
  current: CalendarDate[];
  next: CalendarDate[];
};

export type RelativeWeekReference = keyof RelativeWeekCalendar;
export type RelativeDayReference = "yesterday" | "today" | "tomorrow";

function getTaipeiDateParts(now: Date): DateParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TAIPEI_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);

  const valueFor = (type: string) => {
    const value = parts.find((part) => part.type === type)?.value;
    if (!value) throw new Error(`Missing ${type} from Taipei date formatter`);
    return Number(value);
  };

  return {
    year: valueFor("year"),
    month: valueFor("month"),
    day: valueFor("day"),
  };
}

export function formatCalendarDate(value: CalendarDate): string {
  return `${String(value.year).padStart(4, "0")}-${String(value.month).padStart(
    2,
    "0"
  )}-${String(value.day).padStart(2, "0")}`;
}

function calendarDateAsUtc(parts: DateParts, days = 0): Date {
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day + days);
  return date;
}

function addCalendarDays(parts: DateParts, days: number): DateParts {
  const date = calendarDateAsUtc(parts, days);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function weekdayLabel(parts: DateParts): string {
  const weekdayIndex = calendarDateAsUtc(parts).getUTCDay();
  return WEEKDAY_LABELS_ZH_TW[weekdayIndex] ?? "星期未知";
}

function formatDatedWeekday(parts: DateParts): string {
  return `${formatCalendarDate(parts)} (${weekdayLabel(parts)})`;
}

function formatTaipeiTime(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TAIPEI_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
    .format(now)
    .replace(", ", " ");
}

function buildSevenDaysFrom(start: CalendarDate): CalendarDate[] {
  return Array.from({ length: 7 }, (_, offset) =>
    addCalendarDays(start, offset)
  );
}

export function buildRelativeWeekCalendar(now: Date): RelativeWeekCalendar {
  const today = getTaipeiDateParts(now);
  const weekdayIndex = calendarDateAsUtc(today).getUTCDay();
  const daysSinceMonday = (weekdayIndex + 6) % 7;
  const currentMonday = addCalendarDays(today, -daysSinceMonday);

  return {
    previous: buildSevenDaysFrom(addCalendarDays(currentMonday, -7)),
    current: buildSevenDaysFrom(currentMonday),
    next: buildSevenDaysFrom(addCalendarDays(currentMonday, 7)),
  };
}

export function resolveRelativeWeekday(
  reference: RelativeWeekReference,
  weekday: number,
  now: Date
): CalendarDate {
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
    throw new RangeError(
      `Weekday must be an integer from 0 through 6: ${weekday}`
    );
  }

  const mondayBasedIndex = (weekday + 6) % 7;
  const resolved = buildRelativeWeekCalendar(now)[reference][mondayBasedIndex];
  if (!resolved) throw new Error("Relative week calendar is incomplete");
  return resolved;
}

export function resolveRelativeDay(
  reference: RelativeDayReference,
  now: Date
): CalendarDate {
  const offset = { yesterday: -1, today: 0, tomorrow: 1 }[reference];
  return addCalendarDays(getTaipeiDateParts(now), offset);
}

function formatWeek(dates: CalendarDate[]): string {
  return dates.map(formatDatedWeekday).join(", ");
}

export function buildCurrentDateContext(now: Date = new Date()): string {
  try {
    const today = getTaipeiDateParts(now);
    const yesterday = addCalendarDays(today, -1);
    const tomorrow = addCalendarDays(today, 1);
    const currentTime = formatTaipeiTime(now);
    const weeks = buildRelativeWeekCalendar(now);

    return [
      "## Current Date Context",
      "",
      "- Timezone: Asia/Taipei (UTC+08:00)",
      `- Current time / 現在時間: ${currentTime}`,
      `- Today / 今天: ${formatDatedWeekday(today)}`,
      `- Yesterday / 昨天: ${formatDatedWeekday(yesterday)}`,
      `- Tomorrow / 明天: ${formatDatedWeekday(tomorrow)}`,
      `- Previous week / 上週: ${formatWeek(weeks.previous)}`,
      `- Current week / 本週: ${formatWeek(weeks.current)}`,
      `- Next week / 下週: ${formatWeek(weeks.next)}`,
      "- Current Date Context overrides relative dates in old conversation history.",
      "- Old today/yesterday/tomorrow/this week references describe the old message time, not this turn.",
      "- Never guess a weekday. Use the deterministic date/weekday pairs above.",
      "- For dates outside this table, use trusted tool data or deterministic computation; otherwise say you cannot confirm.",
      "- For a next occurrence, choose the earliest candidate at or after the current Taipei time; without trusted candidates or an explicit recurrence, do not guess.",
    ].join("\n");
  } catch {
    return [
      "## Current Date Context",
      "",
      "- Current date computation is unavailable. Do not guess any date or weekday.",
    ].join("\n");
  }
}
