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
const OPERATION_PATTERNS: ReadonlyArray<
	readonly [Exclude<ToolOperation, "unknown">, RegExp]
> = [
	["read", /讀取|读取|閱讀|阅读|\b(?:read|get|list)\b/],
	["search", /搜尋|搜索|查找|幫我查|帮我查|\b(?:search|find|lookup)\b/],
	["create", /建立|新增|創建|创建|\b(?:create|add)\b/],
	["update", /更新|修改|編輯|编辑|\b(?:update|edit)\b/],
	["delete", /刪除|删除|移除|封存|\b(?:delete|remove|archive)\b/],
	["send", /傳送|发送|寄出|\b(?:send|post|publish)\b/],
	["schedule", /提醒我|叫我|排程|定時|定时|\bschedule\b|\bremind\s+me\b/],
];
const MEETING_SCHEDULE_PATTERN =
	/幫我排|帮我排|安排.*(?:會議|会议)|\bschedule\b.*\bmeeting\b/;

export function buildToolRouteQuery(message: string): ToolRouteQuery {
	const normalizedText = message.normalize("NFKC").trim().toLowerCase();
	const explicitDestinations: ToolDestination[] = [];
	const operations = new Set<ToolOperation>();
	const isPersonalReminder = PERSONAL_REMINDER_PATTERN.test(normalizedText);

	if (isPersonalReminder) explicitDestinations.push("personal_reminder");
	if (GOOGLE_CALENDAR_PATTERN.test(normalizedText)) {
		explicitDestinations.push("google_calendar");
	}

	for (const [operation, pattern] of OPERATION_PATTERNS) {
		if (pattern.test(normalizedText)) operations.add(operation);
	}
	if (MEETING_SCHEDULE_PATTERN.test(normalizedText)) {
		operations.add("schedule");
		operations.add("create");
	}
	if (operations.size === 0) operations.add("unknown");

	return {
		normalizedText,
		operations: [...operations],
		explicitDestinations,
	};
}
