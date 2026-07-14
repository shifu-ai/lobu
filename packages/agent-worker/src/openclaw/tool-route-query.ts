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
	readonly [Exclude<ToolOperation, "read" | "unknown">, RegExp]
> = [
	["search", /搜尋|搜索|查找|幫我查|帮我查|search|find|lookup/],
	["create", /建立|新增|創建|创建|create|add/],
	["update", /更新|修改|編輯|编辑|update|edit/],
	["delete", /刪除|删除|移除|delete|remove|archive|封存/],
	["send", /傳送|发送|寄出|send|post|publish/],
	["schedule", /提醒我|叫我|排程|定時|定时|schedule|remind\s+me/],
];
const MEETING_SCHEDULE_PATTERN =
	/幫我排|帮我排|安排.*(?:會議|会议)|schedule.*meeting/;

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
