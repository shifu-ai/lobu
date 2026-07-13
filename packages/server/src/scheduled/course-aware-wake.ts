export const COURSE_WAKE_TASK_KINDS = [
	"opp_coach_rehearsal_prompt",
	"opp_coach_practice_prompt",
	"opp_coach_event_prompt",
] as const;

export type CourseWakeTaskKind = (typeof COURSE_WAKE_TASK_KINDS)[number];
export const COURSE_RESOLUTION_MATCHES = [
	"course_name",
	"course_alias",
	"instructor_name",
	"instructor_alias",
] as const;
export type CourseResolutionMatch = (typeof COURSE_RESOLUTION_MATCHES)[number];

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
		resolutionMatchedBy: CourseResolutionMatch[];
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

function boundedNonEmpty(value: unknown, maxLength: number): value is string {
	return nonEmpty(value) && value.length <= maxLength;
}

export class TrustedCourseWakeValidationError extends Error {}

export function parseStrictRfc3339(value: unknown, field: string): Date {
	if (!nonEmpty(value))
		throw new TrustedCourseWakeValidationError(`${field} is required`);
	const match =
		/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/u.exec(
			value,
		);
	if (!match)
		throw new TrustedCourseWakeValidationError(`${field} must be RFC3339`);
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const hour = Number(match[4]);
	const minute = Number(match[5]);
	const second = Number(match[6]);
	const millis = Number((match[7] ?? "").padEnd(3, "0").slice(0, 3));
	const offsetHour = match[8] === "Z" ? 0 : Number(match[10]);
	const offsetMinute = match[8] === "Z" ? 0 : Number(match[11]);
	const maxDay =
		month >= 1 && month <= 12
			? new Date(Date.UTC(year, month, 0)).getUTCDate()
			: 0;
	if (
		day < 1 ||
		day > maxDay ||
		hour > 23 ||
		minute > 59 ||
		second > 59 ||
		offsetHour > 23 ||
		offsetMinute > 59
	) {
		throw new TrustedCourseWakeValidationError(
			`${field} is not a real timestamp`,
		);
	}
	const offset =
		match[8] === "Z"
			? 0
			: (match[9] === "+" ? 1 : -1) * (offsetHour * 60 + offsetMinute) * 60_000;
	return new Date(
		Date.UTC(year, month - 1, day, hour, minute, second, millis) - offset,
	);
}

function isDeterministicResolutionMatches(
	value: unknown,
): value is CourseResolutionMatch[] {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.length <= COURSE_RESOLUTION_MATCHES.length &&
		new Set(value).size === value.length &&
		value.every(
			(item) =>
				typeof item === "string" &&
				COURSE_RESOLUTION_MATCHES.some((candidate) => candidate === item),
		)
	);
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
	if (!boundedNonEmpty(value.automationId, 256))
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
		!boundedNonEmpty(eventRef.accountRef, 256) ||
		!boundedNonEmpty(eventRef.eventId, 256) ||
		!boundedNonEmpty(eventRef.eventVersion, 256) ||
		!boundedNonEmpty(eventRef.eventTitle, 500) ||
		!boundedNonEmpty(eventRef.eventStartAt, 64)
	) {
		throw new Error("invalid calendarEventRef");
	}
	parseStrictRfc3339(eventRef.eventStartAt, "calendarEventRef.eventStartAt");
	if (!boundedNonEmpty(value.scheduledFor, 64))
		throw new Error("invalid scheduledFor");
	const scheduledFor = value.scheduledFor;
	parseStrictRfc3339(scheduledFor, "scheduledFor");
	if (
		scope.ownerUserId !== expected.ownerUserId ||
		scope.agentId !== expected.agentId
	) {
		throw new Error("trusted course scope owner or agent mismatch");
	}
	if (
		!boundedNonEmpty(scope.ownerUserId, 256) ||
		!boundedNonEmpty(scope.agentId, 256) ||
		!boundedNonEmpty(scope.courseEntityId, 200) ||
		!boundedNonEmpty(scope.courseKey, 200) ||
		!boundedNonEmpty(scope.courseDisplayName, 500) ||
		scope.resolutionSource !== "toolbox_calendar_course_resolver" ||
		!isDeterministicResolutionMatches(scope.resolutionMatchedBy) ||
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
		scheduledFor,
		taskKind: value.taskKind,
		delivery: "line",
	};
}

export function trustedCourseWakeMatchesFireProvenance(
	wake: TrustedCourseWakeV1,
	externalKey: string | null | undefined,
	scheduledTick: string | null | undefined,
): boolean {
	const expectedExternalKey = `google_calendar:${wake.calendarEventRef.accountRef}:${wake.calendarEventRef.eventId}:${wake.taskKind}`;
	if (externalKey !== expectedExternalKey) return false;
	try {
		return (
			parseStrictRfc3339(scheduledTick, "scheduled job tick").getTime() ===
			parseStrictRfc3339(wake.scheduledFor, "scheduledFor").getTime()
		);
	} catch {
		return false;
	}
}

export interface TrustedCourseFireInput {
	rawWake: unknown;
	reason: string | null | undefined;
	organizationId: string;
	createdByUser: string | null | undefined;
	createdByAgent: string | null | undefined;
	resolvedAgentId: string;
	scheduledJobId: string | undefined;
	scheduledTaskRunId: number | undefined;
	externalKey: string | null | undefined;
	scheduledTick: string | undefined;
}

export interface TrustedCourseFireDeps {
	verifyOwner(input: {
		organizationId: string;
		ownerUserId: string;
		agentId: string;
	}): Promise<boolean>;
	resolveContext(input: {
		trustedWake: TrustedCourseWakeV1;
		scheduledCourseContext: ScheduledCourseContext;
	}): Promise<ResolvedCourseExecutionContext | null>;
}

export interface TrustedCourseFireEligibility {
	trustedWake: TrustedCourseWakeV1;
	scheduledCourseContext: ScheduledCourseContext;
}

export async function validateTrustedCourseFireEligibility(
	input: TrustedCourseFireInput,
	deps: Pick<TrustedCourseFireDeps, "verifyOwner">,
): Promise<TrustedCourseFireEligibility | null> {
	const scheduledTaskRunId = input.scheduledTaskRunId;
	if (
		input.reason !== "trusted-course-calendar-wake" ||
		!input.createdByUser ||
		!input.createdByAgent ||
		!input.scheduledJobId ||
		!Number.isSafeInteger(scheduledTaskRunId) ||
		typeof scheduledTaskRunId !== "number" ||
		scheduledTaskRunId <= 0
	)
		return null;
	let trustedWake: TrustedCourseWakeV1;
	try {
		trustedWake = parseTrustedCourseWakeV1(input.rawWake, {
			ownerUserId: input.createdByUser,
			agentId: input.resolvedAgentId,
		});
	} catch {
		return null;
	}
	if (
		input.createdByAgent !== input.resolvedAgentId ||
		!trustedCourseWakeMatchesFireProvenance(
			trustedWake,
			input.externalKey,
			input.scheduledTick,
		)
	)
		return null;
	if (
		!(await deps.verifyOwner({
			organizationId: input.organizationId,
			ownerUserId: input.createdByUser,
			agentId: input.resolvedAgentId,
		}))
	)
		return null;
	return {
		trustedWake,
		scheduledCourseContext: {
			schemaVersion: 1,
			source: "calendar_scheduled_wake",
			automationId: trustedWake.automationId,
			jobId: input.scheduledJobId,
			runId: scheduledTaskRunId,
			taskKind: trustedWake.taskKind,
			course: {
				ownerUserId: trustedWake.trustedCourseScope.ownerUserId,
				agentId: trustedWake.trustedCourseScope.agentId,
				courseKey: trustedWake.trustedCourseScope.courseKey,
				courseEntityId: trustedWake.trustedCourseScope.courseEntityId,
				displayName: trustedWake.trustedCourseScope.courseDisplayName,
			},
			evidenceReadiness: "canonical_only",
		},
	};
}

export async function resolveTrustedCourseFireContext(
	eligibility: TrustedCourseFireEligibility,
	deps: Pick<TrustedCourseFireDeps, "resolveContext">,
): Promise<ResolvedCourseExecutionContext | null> {
	const resolvedCourseContext = await deps.resolveContext(eligibility);
	if (
		!resolvedCourseContext ||
		resolvedCourseContext.course.courseKey !==
			eligibility.scheduledCourseContext.course.courseKey ||
		resolvedCourseContext.course.courseEntityId !==
			eligibility.scheduledCourseContext.course.courseEntityId
	)
		return null;
	return resolvedCourseContext;
}

export async function buildTrustedCourseFireContext(
	input: TrustedCourseFireInput,
	deps: TrustedCourseFireDeps,
): Promise<{
	trustedWake: TrustedCourseWakeV1;
	scheduledCourseContext: ScheduledCourseContext;
	resolvedCourseContext: ResolvedCourseExecutionContext;
} | null> {
	const eligibility = await validateTrustedCourseFireEligibility(input, deps);
	if (!eligibility) return null;
	const resolvedCourseContext = await resolveTrustedCourseFireContext(
		eligibility,
		deps,
	);
	if (!resolvedCourseContext) return null;
	return { ...eligibility, resolvedCourseContext };
}

import type {
	ResolvedCourseExecutionContext,
	ScheduledCourseContext,
} from "@lobu/core";
