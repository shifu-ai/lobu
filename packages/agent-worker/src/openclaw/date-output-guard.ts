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
  trustedTemporalCandidates?: string[];
};

const TEMPORAL_KEY_RE =
  /^(?:date|time|start(?:date|time|at)?|scheduled(?:date|time|at)?|occurs(?:at)?|timestamp)$/i;
const STRICT_ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const STRICT_ISO_DATETIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
const MAX_TEMPORAL_TRAVERSAL_DEPTH = 5;
const MAX_TEMPORAL_VISITED_VALUES = 200;
// `for...in` may ask a Proxy for one descriptor before the loop body can stop.
// Keeping the explicit inspection budget below 100 caps total descriptor work
// at 200 even in that adversarial case.
const MAX_TEMPORAL_INSPECTED_KEYS = 99;
const MAX_STRUCTURED_MCP_TEXT_LENGTH = 64_000;

function isStrictIsoTemporalString(value: string): boolean {
  const match =
    STRICT_ISO_DATE_RE.exec(value) ?? STRICT_ISO_DATETIME_RE.exec(value);
  if (!match) return false;
  if (!validUtcDate(Number(match[1]), Number(match[2]), Number(match[3]))) {
    return false;
  }
  return STRICT_ISO_DATE_RE.test(value) || Number.isFinite(Date.parse(value));
}

export function extractTrustedTemporalCandidates(value: unknown): string[] {
  const candidates = new Set<string>();
  const seen = new WeakSet<object>();
  let visited = 0;
  let inspectedKeys = 0;

  const visit = (
    current: unknown,
    depth: number,
    temporalValue: boolean,
    structuredMcpTextBlock = false
  ) => {
    if (visited >= MAX_TEMPORAL_VISITED_VALUES) return;
    visited += 1;
    if (depth > MAX_TEMPORAL_TRAVERSAL_DEPTH) return;

    if (typeof current === "string") {
      if (temporalValue && isStrictIsoTemporalString(current)) {
        candidates.add(current);
      }
      return;
    }
    if (current === null || typeof current !== "object") return;
    if (seen.has(current)) return;
    seen.add(current);

    if (Array.isArray(current)) {
      if (inspectedKeys >= MAX_TEMPORAL_INSPECTED_KEYS) return;
      inspectedKeys += 1;
      let length = 0;
      try {
        const descriptor = Object.getOwnPropertyDescriptor(current, "length");
        if (descriptor && "value" in descriptor) {
          length = Math.min(
            Number(descriptor.value) || 0,
            Number.MAX_SAFE_INTEGER
          );
        }
      } catch {
        return;
      }
      for (
        let index = 0;
        index < length && inspectedKeys < MAX_TEMPORAL_INSPECTED_KEYS;
        index += 1
      ) {
        inspectedKeys += 1;
        let descriptor: PropertyDescriptor | undefined;
        try {
          descriptor = Object.getOwnPropertyDescriptor(current, String(index));
        } catch {
          return;
        }
        if (!descriptor?.enumerable || !("value" in descriptor)) continue;
        visit(
          descriptor.value,
          depth + 1,
          temporalValue,
          structuredMcpTextBlock
        );
      }
      return;
    }

    const entries: [string, unknown][] = [];
    try {
      for (const key in current) {
        if (inspectedKeys >= MAX_TEMPORAL_INSPECTED_KEYS) break;
        inspectedKeys += 1;
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor?.enumerable || !("value" in descriptor)) continue;
        entries.push([key, descriptor.value]);
      }
    } catch {
      return;
    }
    if (structuredMcpTextBlock) {
      const block = new Map(entries);
      const type = block.get("type");
      const text = block.get("text");
      if (
        type === "text" &&
        typeof text === "string" &&
        text.length <= MAX_STRUCTURED_MCP_TEXT_LENGTH
      ) {
        const trimmed = text.trim();
        const looksStructured =
          (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
          (trimmed.startsWith("[") && trimmed.endsWith("]"));
        if (looksStructured) {
          try {
            visit(JSON.parse(trimmed), 0, false);
          } catch {
            // Malformed or hostile text is not trusted temporal evidence.
          }
        }
      }
    }

    for (const [key, child] of entries) {
      visit(
        child,
        depth + 1,
        TEMPORAL_KEY_RE.test(key),
        key === "content" && Array.isArray(child)
      );
    }
  };

  try {
    visit(value, 0, false);
  } catch {
    // Tool results are untrusted values. Extraction must never fail a turn.
  }
  return Array.from(candidates);
}

const CHINESE_DATE_SENSITIVE_RE =
  /(?:今天|昨天|明天|這兩天|这两天|日期|哪一天|哪天|幾號|几号|何時|何时|什麼時候|什么时候|上[週周]|本[週周]|這[週周]|这[周週]|下[週周]|(?:星期|週|周)[幾几日天一二三四五六]|(?:上一場|下一場|最近一場))/;
const ENGLISH_DATE_SENSITIVE_RE =
  /\b(?:date|when\s+(?:is|are|was|were|will|would|can|could|does|do|did|has|have|had)|today|tomorrow|yesterday|weekday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next\s+(?:event|session|occurrence)|(?:this|last|next)\s+(?:week|mon|monday|tue|tues|tuesday|wed|wednesday|thu|thur|thurs|thursday|fri|friday|sat|saturday|sun|sunday))\b/i;
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
  /(?<![A-Za-z0-9_./-])(\d{4})-(\d{2})-(\d{2})(\s*[(（])(星期[日天一二三四五六])([)）])/g;
const EXPLICIT_ISO_DATE_CLAIM_RE =
  /(?<![A-Za-z0-9_./-])(\d{4})-(\d{2})-(\d{2})(?:T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))?(?![A-Za-z0-9_/-]|\.[A-Za-z0-9_])/g;
const INVALID_CALENDAR_DATE_BLOCK_TEXT =
  "我偵測到無效或無法可靠判定的日期，因此沒有送出猜測結果。請確認日期後再試一次。";

const RELATIVE_WEEK_DATE_RE =
  /(?<![上下本這大小前後])((上週|本週|這週|下週)\s*(?:(星期)([日天一二三四五六])|([日天一二三四五六])))((?:(?!(?:上週|本週|這週|下週|今天|昨天|明天))[^。\n\r！？；])*?)(?<!\d)(\d{1,2})\/(\d{1,2})(\s*[(（])((?:星期)?[日天一二三四五六])([)）])/g;
const RELATIVE_DAY_DATE_RE =
  /((今天|昨天|明天))((?:(?!(?:上週|本週|這週|下週|今天|昨天|明天))[^。\n\r！？；])*?)(?<!\d)(\d{1,2})\/(\d{1,2})(\s*[(（])((?:星期)?[日天一二三四五六])([)）])/g;
const SHORT_DATE_WITH_WEEKDAY_RE =
  /(?<![A-Za-z0-9_./-])(\d{1,2})\/(\d{1,2})(\s*[(（])((?:星期)?[日天一二三四五六])([)）])/g;

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
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

const NEXT_OCCURRENCE_RE =
  /(?:下一場|下次|\bnext\s+(?:event|session|occurrence)\b)/i;
const FINAL_SHORT_DATE_CLAIM_RE =
  /(?<![\d/])(\d{1,2})\/(\d{1,2})(?:([\s]*[(（])((?:星期)?[日天一二三四五六])([)）]))?/;
const FINAL_ISO_DATE_CLAIM_RE =
  /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?:([\s]*[(（])(星期[日天一二三四五六])([)）]))?/;
const NEXT_OCCURRENCE_BLOCK_TEXT =
  "我目前沒有取得可驗證的場次日期，因此不能猜下一場。請讓我先查詢實際排程，或提供固定週期與時間。";
const NEXT_OCCURRENCE_ASSOCIATION_LIMIT = 120;
const SENTENCE_OR_LINE_BOUNDARY_RE = /[。\n\r！？；;.!?]/;

type LocatedDateClaim = {
  kind: "short" | "iso";
  match: RegExpExecArray;
  index: number;
};

function allDateClaimsIn(text: string, offset: number): LocatedDateClaim[] {
  const collect = (regex: RegExp, kind: LocatedDateClaim["kind"]) =>
    Array.from(text.matchAll(new RegExp(regex.source, "g")), (match) => ({
      kind,
      match,
      index: offset + (match.index ?? 0),
    }));
  return [
    ...collect(FINAL_SHORT_DATE_CLAIM_RE, "short"),
    ...collect(FINAL_ISO_DATE_CLAIM_RE, "iso"),
  ].sort((left, right) => left.index - right.index);
}

function isExplicitNextOccurrenceForwardBridge(
  bridge: string,
  suffix: string
): boolean {
  const normalized = bridge.trim();
  if (!normalized || normalized.length > 48) return false;
  if (/[，,。！？；;\n\r]/.test(normalized)) return false;
  const hasReferenceSourceRangeOrUnresolvedMarker =
    /(?:尚未|未查|查不到|參考|來源|範圍|歷史|舊資料|但|然而|不確定|未知|取消)|\b(?:unknown|unconfirmed|unavailable|reference|source|range|cancelled)\b/i.test(
      normalized
    );
  if (hasReferenceSourceRangeOrUnresolvedMarker) {
    return false;
  }

  const hasNegativeSchedulingPredicate =
    /(?:不會(?:在|於)?|不是|不在|不於|不能(?:在|於)?|不可(?:在|於)?|不應(?:在|於)?|不可能(?:在|於)?|未能(?:在|於)?|未在|未於|尚未(?:在|於)?|無法(?:在|於)?|无法(?:在|于)?|沒有(?:在|於)?|没有(?:在|于)?|沒辦法(?:在|於)?|没办法(?:在|于)?|並非|并非|是否|否定)\s*$/.test(
      normalized
    ) ||
    /(?:\b(?:is|are|was|were|will|would|can|could|should|do|does|did)\s+(?:not|never)(?:\s+(?:be|held|on|at|scheduled|for))*|\bcannot(?:\s+(?:be|held|on|at|scheduled|for))*|\bunable(?:\s+to)?(?:\s+(?:be|hold|schedule|occur|on|at|for))*|\b[a-z]+n['’]t(?:\s+(?:be|held|on|at|scheduled|for))*)$/i.test(
      normalized
    );
  if (hasNegativeSchedulingPredicate) return false;

  const terminalConnector =
    /(?:(?:的\s*)?(?:預定)?日期\s*(?:是|為|[:：])|預定\s*(?:是|為)|預計(?:\s*(?:在|於))?|定於|將\s*(?:在|於)|會\s*(?:在|於)|(?:是|為)\s*(?:在|於)?|[:：—-]|\b(?:date\s*(?:is|will\s+be|[:：])|is|will\s+be(?:\s+held\s+on)?|will\s+take\s+place\s+on|scheduled\s+(?:for|on)|occurs?\s+on|on|at))\s*$/i.exec(
      normalized
    );
  if (terminalConnector) {
    const descriptor = normalized.slice(0, terminalConnector.index).trim();
    return descriptor.length <= 32;
  }

  const hasSchedulingSuffix =
    /^\s*(?:舉行|進行|開始|開課|登場|will\s+be\s+held|takes?\s+place)/i.test(
      suffix
    );
  return hasSchedulingSuffix && /^[\p{L}\p{N}\s]{1,32}$/u.test(normalized);
}

function findNextOccurrenceDateClaims(text: string): LocatedDateClaim[] {
  const linkedClaims = new Map<number, LocatedDateClaim>();
  const occurrenceRegex = new RegExp(NEXT_OCCURRENCE_RE.source, "gi");
  for (const occurrence of text.matchAll(occurrenceRegex)) {
    const occurrenceIndex = occurrence.index ?? 0;
    const occurrenceEnd = occurrenceIndex + occurrence[0].length;
    const forwardRemainder = text.slice(
      occurrenceEnd,
      occurrenceEnd + NEXT_OCCURRENCE_ASSOCIATION_LIMIT
    );
    const forwardBoundary = forwardRemainder.search(
      SENTENCE_OR_LINE_BOUNDARY_RE
    );
    const forwardScope =
      forwardBoundary === -1
        ? forwardRemainder
        : forwardRemainder.slice(0, forwardBoundary);
    const forwardClaims = allDateClaimsIn(forwardScope, occurrenceEnd);
    for (const claim of forwardClaims) {
      const bridge = text.slice(occurrenceEnd, claim.index);
      const suffix = text.slice(
        claim.index + claim.match[0].length,
        occurrenceEnd + forwardScope.length
      );
      if (isExplicitNextOccurrenceForwardBridge(bridge, suffix)) {
        linkedClaims.set(claim.index, claim);
        break;
      }
    }

    let backwardStart = Math.max(
      0,
      occurrenceIndex - NEXT_OCCURRENCE_ASSOCIATION_LIMIT
    );
    const backwardWindow = text.slice(backwardStart, occurrenceIndex);
    for (let index = backwardWindow.length - 1; index >= 0; index -= 1) {
      if (SENTENCE_OR_LINE_BOUNDARY_RE.test(backwardWindow[index] ?? "")) {
        backwardStart += index + 1;
        break;
      }
    }
    const backwardScope = text.slice(backwardStart, occurrenceIndex);
    const backwardClaims = allDateClaimsIn(backwardScope, backwardStart);
    for (let index = backwardClaims.length - 1; index >= 0; index -= 1) {
      const claim = backwardClaims[index];
      if (!claim) continue;
      const bridge = text.slice(
        claim.index + claim.match[0].length,
        occurrenceIndex
      );
      if (/^\s*(?:(?:是|為|就是)|is\s+(?:the\s+)?)?\s*$/i.test(bridge)) {
        linkedClaims.set(claim.index, claim);
        break;
      }
    }
  }
  return Array.from(linkedClaims.values()).sort(
    (left, right) => left.index - right.index
  );
}

function taipeiStartOfDay(parts: CalendarDate): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day) - 8 * 60 * 60 * 1000;
}

function taipeiCalendarDate(date: Date): CalendarDate {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const read = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value);
  return { year: read("year"), month: read("month"), day: read("day") };
}

function parseTrustedTemporalCandidate(
  candidate: string
): { epoch: number; date: CalendarDate } | null {
  if (!isStrictIsoTemporalString(candidate)) return null;
  const dateOnly = STRICT_ISO_DATE_RE.exec(candidate);
  if (dateOnly) {
    const date = {
      year: Number(dateOnly[1]),
      month: Number(dateOnly[2]),
      day: Number(dateOnly[3]),
    };
    return { epoch: taipeiStartOfDay(date), date };
  }

  const epoch = Date.parse(candidate);
  if (!Number.isFinite(epoch)) return null;
  return { epoch, date: taipeiCalendarDate(new Date(epoch)) };
}

const ENGLISH_WEEKDAY_INDEX: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

type ExplicitRecurrence = {
  weekday: number;
  timeMinutes: number | null;
};

function explicitRecurrenceTimes(userMessage: string): number[] {
  const times = new Set<number>();
  for (const clock of userMessage.matchAll(
    /(?<!\d)([01]?\d|2[0-3]):([0-5]\d)(?!\d)/g
  )) {
    times.add(Number(clock[1]) * 60 + Number(clock[2]));
  }

  for (const chinese of userMessage.matchAll(
    /(上午|早上|下午|晚上)\s*(\d{1,2})\s*點(?:\s*(\d{1,2})\s*分?)?/g
  )) {
    let hour = Number(chinese[2]);
    const minute = chinese[3] ? Number(chinese[3]) : 0;
    if (hour < 1 || hour > 12 || minute > 59) continue;
    const period = chinese[1];
    if (period === "下午" || period === "晚上") {
      if (hour < 12) hour += 12;
    } else if (hour === 12 && (period === "上午" || period === "早上")) {
      hour = 0;
    }
    times.add(hour * 60 + minute);
  }
  return Array.from(times);
}

function recurrenceInClause(
  clause: string
): ExplicitRecurrence | "ambiguous" | null {
  const withClauseTime = (
    weekday: number
  ): ExplicitRecurrence | "ambiguous" => {
    const times = explicitRecurrenceTimes(clause);
    if (times.length > 1) return "ambiguous";
    return { weekday, timeMinutes: times[0] ?? null };
  };
  const chinese =
    /(?:每週|每星期)\s*(?:(?:星期|週|周)\s*)?([日天一二三四五六])/.exec(clause);
  if (chinese) {
    const weekday = WEEKDAY_INDEX_ZH[`星期${chinese[1]}`];
    return weekday === undefined ? null : withClauseTime(weekday);
  }

  const english =
    /\bweekly\b[^.\n\r]{0,24}\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b|\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b[^.\n\r]{0,24}\bweekly\b/i.exec(
      clause
    );
  const weekday = english?.[1] ?? english?.[2];
  return weekday
    ? withClauseTime(ENGLISH_WEEKDAY_INDEX[weekday.toLowerCase()]!)
    : null;
}

function explicitRecurrence(userMessage: string): ExplicitRecurrence | null {
  const distinct = new Map<string, ExplicitRecurrence>();
  for (const clause of userMessage.split(/[，,；;。！？\n\r]+/)) {
    const recurrence = recurrenceInClause(clause);
    if (!recurrence) continue;
    if (recurrence === "ambiguous") return null;
    distinct.set(
      `${recurrence.weekday}:${recurrence.timeMinutes ?? "ambiguous"}`,
      recurrence
    );
    if (distinct.size > 1) return null;
  }
  return distinct.values().next().value ?? null;
}

function resolveNextRecurrence(
  recurrence: ExplicitRecurrence,
  now: Date
): CalendarDate | null {
  const current = resolveRelativeWeekday("current", recurrence.weekday, now);
  const currentStart = taipeiStartOfDay(current);
  const today = taipeiCalendarDate(now);
  const isToday =
    current.year === today.year &&
    current.month === today.month &&
    current.day === today.day;

  if (currentStart > now.getTime()) return current;
  if (isToday) {
    if (recurrence.timeMinutes === null) return null;
    const occurrenceEpoch = currentStart + recurrence.timeMinutes * 60 * 1000;
    if (occurrenceEpoch >= now.getTime()) return current;
  }
  return resolveRelativeWeekday("next", recurrence.weekday, now);
}

function correctNextOccurrenceClaim(
  text: string,
  expected: CalendarDate,
  corrections: DateCorrection[],
  claim: LocatedDateClaim
): string {
  if (claim.kind === "short") {
    const shortMatch = claim.match;
    const original = shortMatch[0];
    const weekday = shortMatch[4];
    const replacementWeekday = weekday
      ? weekdayWithStyle(weekday, weekdayFor(expected))
      : undefined;
    const replacement = `${shortDate(
      expected,
      shortMatch[1]!,
      shortMatch[2]!
    )}${
      weekday
        ? `${shortMatch[3] ?? ""}${replacementWeekday}${shortMatch[5] ?? ""}`
        : ""
    }`;
    if (original !== replacement) {
      corrections.push({
        reason: "relative_date_mismatch",
        original,
        replacement,
      });
      return `${text.slice(0, claim.index)}${replacement}${text.slice(
        claim.index + original.length
      )}`;
    }
    return text;
  }

  const isoMatch = claim.match;
  const original = isoMatch[0];
  const weekday = isoMatch[5];
  const replacementWeekday = weekday
    ? weekdayWithStyle(weekday, weekdayFor(expected))
    : undefined;
  const replacement = `${expected.year}-${String(expected.month).padStart(
    2,
    "0"
  )}-${String(expected.day).padStart(2, "0")}${
    weekday
      ? `${isoMatch[4] ?? ""}${replacementWeekday}${isoMatch[6] ?? ""}`
      : ""
  }`;
  if (original !== replacement) {
    corrections.push({
      reason: "relative_date_mismatch",
      original,
      replacement,
    });
    return `${text.slice(0, claim.index)}${replacement}${text.slice(
      claim.index + original.length
    )}`;
  }
  return text;
}

export function guardDateOutput(input: DateGuardInput): DateGuardResult {
  if (!isDateSensitiveTurn(input.userMessage)) {
    return { status: "unchanged", text: input.finalText };
  }

  for (const match of input.finalText.matchAll(EXPLICIT_ISO_DATE_CLAIM_RE)) {
    if (!validUtcDate(Number(match[1]), Number(match[2]), Number(match[3]))) {
      return {
        status: "blocked",
        text: INVALID_CALENDAR_DATE_BLOCK_TEXT,
        reason: "invalid_calendar_date",
      };
    }
  }

  const corrections: DateCorrection[] = [];
  let text = input.finalText;
  const isNextOccurrence = NEXT_OCCURRENCE_RE.test(input.userMessage);
  const nextOccurrenceDateClaims = isNextOccurrence
    ? findNextOccurrenceDateClaims(text)
    : [];
  if (nextOccurrenceDateClaims.length > 0) {
    const recurrence = explicitRecurrence(input.userMessage);
    const recurrenceDate =
      recurrence === null ? null : resolveNextRecurrence(recurrence, input.now);
    const trustedCandidate = (input.trustedTemporalCandidates ?? [])
      .map(parseTrustedTemporalCandidate)
      .filter(
        (candidate): candidate is { epoch: number; date: CalendarDate } =>
          candidate !== null && candidate.epoch >= input.now.getTime()
      )
      .sort((left, right) => left.epoch - right.epoch)[0];
    const authoritativeDate = recurrenceDate ?? trustedCandidate?.date;

    if (!authoritativeDate) {
      return {
        status: "blocked",
        text: NEXT_OCCURRENCE_BLOCK_TEXT,
        reason: "next_occurrence_without_temporal_evidence",
      };
    }
    for (
      let index = nextOccurrenceDateClaims.length - 1;
      index >= 0;
      index -= 1
    ) {
      const claim = nextOccurrenceDateClaims[index];
      if (!claim) continue;
      text = correctNextOccurrenceClaim(
        text,
        authoritativeDate,
        corrections,
        claim
      );
    }
  }

  text = text.replace(
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
