export const COURSE_WAKE_TASK_KINDS = [
	"opp_coach_rehearsal_prompt",
	"opp_coach_practice_prompt",
	"opp_coach_event_prompt",
] as const;

export type CourseWakeTaskKind = (typeof COURSE_WAKE_TASK_KINDS)[number];

export interface TrustedCourseWakeV1 {
	schemaVersion: 1;
	source: "calendar_scheduled_wake";
	automationId: string;
	trustedCourseScope: {
		ownerUserId: string;
		agentId: string;
		courseEntityId: string;
		courseKey: string;
		courseDisplayName: string;
		resolutionSource: "toolbox_calendar_course_resolver";
		resolutionMatchedBy: string[];
		scopeVersion: 1;
	};
	taskKind: CourseWakeTaskKind;
	delivery: "line";
	triggerSource?: "google_calendar";
	calendarEventRef?: {
		accountRef: string;
		eventId: string;
		eventVersion: string;
		eventTitle: string;
		eventStartAt: string;
	};
	scheduledFor?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

export function parseTrustedCourseWakeV1(
	value: unknown,
	expected: { ownerUserId: string; agentId: string },
): TrustedCourseWakeV1 {
	if (!isRecord(value) || !isRecord(value.trustedCourseScope)) {
		throw new Error("payload must be a trusted course wake object");
	}
	const scope = value.trustedCourseScope;
	if (value.schemaVersion !== 1 || value.source !== "calendar_scheduled_wake") {
		throw new Error("unsupported trusted course wake schema");
	}
	if (!nonEmpty(value.automationId))
		throw new Error("automationId is required");
	if (!COURSE_WAKE_TASK_KINDS.includes(value.taskKind as CourseWakeTaskKind)) {
		throw new Error("unsupported taskKind");
	}
	if (value.delivery !== "line") throw new Error("unsupported delivery");
	if (
		scope.ownerUserId !== expected.ownerUserId ||
		scope.agentId !== expected.agentId
	) {
		throw new Error("trusted course scope owner or agent mismatch");
	}
	if (
		!nonEmpty(scope.courseEntityId) ||
		!nonEmpty(scope.courseKey) ||
		!nonEmpty(scope.courseDisplayName) ||
		scope.resolutionSource !== "toolbox_calendar_course_resolver" ||
		!Array.isArray(scope.resolutionMatchedBy) ||
		scope.resolutionMatchedBy.some((item) => !nonEmpty(item)) ||
		scope.scopeVersion !== 1
	) {
		throw new Error("invalid trusted course scope");
	}
	return value as unknown as TrustedCourseWakeV1;
}
