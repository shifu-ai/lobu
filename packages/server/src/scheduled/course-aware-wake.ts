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
	triggerSource: "google_calendar";
	calendarEventRef: {
		accountRef: string;
		eventId: string;
		eventVersion: string;
		eventTitle: string;
		eventStartAt: string;
	};
	scheduledFor: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isValidTimestamp(value: unknown): value is string {
	return (
		nonEmpty(value) &&
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(
			value,
		) &&
		Number.isFinite(Date.parse(value))
	);
}

function isNonEmptyStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(nonEmpty);
}

function isCourseWakeTaskKind(value: unknown): value is CourseWakeTaskKind {
	return (
		typeof value === "string" &&
		COURSE_WAKE_TASK_KINDS.some((candidate) => candidate === value)
	);
}

export function parseTrustedCourseWakeV1(
	value: unknown,
	expected: { ownerUserId: string; agentId: string },
): TrustedCourseWakeV1 {
	if (!isRecord(value) || !isRecord(value.trustedCourseScope)) {
		throw new Error("payload must be a trusted course wake object");
	}
	const scope = value.trustedCourseScope;
	const eventRef = value.calendarEventRef;
	if (value.schemaVersion !== 1 || value.source !== "calendar_scheduled_wake") {
		throw new Error("unsupported trusted course wake schema");
	}
	if (!nonEmpty(value.automationId))
		throw new Error("automationId is required");
	if (!isCourseWakeTaskKind(value.taskKind)) {
		throw new Error("unsupported taskKind");
	}
	if (value.delivery !== "line") throw new Error("unsupported delivery");
	if (value.triggerSource !== "google_calendar") {
		throw new Error("unsupported triggerSource");
	}
	if (!isRecord(eventRef)) throw new Error("calendarEventRef is required");
	if (
		!nonEmpty(eventRef.accountRef) ||
		!nonEmpty(eventRef.eventId) ||
		!nonEmpty(eventRef.eventVersion) ||
		!nonEmpty(eventRef.eventTitle) ||
		!isValidTimestamp(eventRef.eventStartAt)
	) {
		throw new Error("invalid calendarEventRef");
	}
	if (
		!isValidTimestamp(value.scheduledFor)
	) {
		throw new Error("invalid scheduledFor");
	}
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
		!isNonEmptyStringArray(scope.resolutionMatchedBy) ||
		scope.scopeVersion !== 1
	) {
		throw new Error("invalid trusted course scope");
	}
	return {
		schemaVersion: 1,
		source: "calendar_scheduled_wake",
		automationId: value.automationId,
		triggerSource: "google_calendar",
		calendarEventRef: {
			accountRef: eventRef.accountRef,
			eventId: eventRef.eventId,
			eventVersion: eventRef.eventVersion,
			eventTitle: eventRef.eventTitle,
			eventStartAt: eventRef.eventStartAt,
		},
		trustedCourseScope: {
			ownerUserId: scope.ownerUserId,
			agentId: scope.agentId,
			courseEntityId: scope.courseEntityId,
			courseKey: scope.courseKey,
			courseDisplayName: scope.courseDisplayName,
			resolutionSource: "toolbox_calendar_course_resolver",
			resolutionMatchedBy: [...scope.resolutionMatchedBy],
			scopeVersion: 1,
		},
		scheduledFor: value.scheduledFor,
		taskKind: value.taskKind,
		delivery: "line",
	};
}
