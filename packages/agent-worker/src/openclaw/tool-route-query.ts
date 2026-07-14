export type ToolOperation =
  | "read"
  | "search"
  | "create"
  | "update"
  | "delete"
  | "send"
  | "schedule"
  | "unknown";

export type ToolDestination = "personal_reminder" | "google_calendar";

export interface ToolRouteQuery {
  normalizedText: string;
  operations: ToolOperation[];
  explicitDestinations: ToolDestination[];
}

const PERSONAL_REMINDER_PATTERN = /提醒我|叫我|稍後提醒|稍后提醒|remind\s+me/;
const GOOGLE_CALENDAR_PATTERN = /google\s*calendar|行事曆|行事历|日曆|日历/;
const CREATE_PATTERN = /建立|新增|create/;

export function buildToolRouteQuery(message: string): ToolRouteQuery {
  const normalizedText = message.normalize("NFKC").trim().toLowerCase();
  const explicitDestinations: ToolDestination[] = [];
  const operations: ToolOperation[] = [];
  const isPersonalReminder = PERSONAL_REMINDER_PATTERN.test(normalizedText);

  if (isPersonalReminder) explicitDestinations.push("personal_reminder");
  if (GOOGLE_CALENDAR_PATTERN.test(normalizedText)) {
    explicitDestinations.push("google_calendar");
  }

  if (CREATE_PATTERN.test(normalizedText)) operations.push("create");
  if (isPersonalReminder) operations.push("schedule");
  if (operations.length === 0) operations.push("unknown");

  return { normalizedText, operations, explicitDestinations };
}
