export type CourseContextFailureClass =
	| "timeout"
	| "network"
	| "upstream_5xx"
	| "upstream_4xx"
	| "invalid_contract";

export interface CourseContextRequestPolicy {
	operationDeadlineMs: number;
	attemptTimeoutMs: number;
	maxAttempts: number;
	retryJitterMinMs: number;
	retryJitterMaxMs: number;
}

export type EffectiveCourseContextRequestPolicy = Readonly<CourseContextRequestPolicy>;

export const DEFAULT_COURSE_CONTEXT_REQUEST_POLICY = {
	operationDeadlineMs: 5000,
	attemptTimeoutMs: 2250,
	maxAttempts: 2,
	retryJitterMinMs: 100,
	retryJitterMaxMs: 200,
} as const satisfies EffectiveCourseContextRequestPolicy;

function bounded(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, value));
}

export function normalizeCourseContextRequestPolicy(
	overrides: Partial<CourseContextRequestPolicy> = {},
): EffectiveCourseContextRequestPolicy {
	const retryJitterMinMs = bounded(
		overrides.retryJitterMinMs,
		DEFAULT_COURSE_CONTEXT_REQUEST_POLICY.retryJitterMinMs,
		100,
		200,
	);
	const retryJitterMaxMs = Math.max(
		retryJitterMinMs,
		bounded(
			overrides.retryJitterMaxMs,
			DEFAULT_COURSE_CONTEXT_REQUEST_POLICY.retryJitterMaxMs,
			100,
			200,
		),
	);
	return {
		operationDeadlineMs: bounded(
			overrides.operationDeadlineMs,
			DEFAULT_COURSE_CONTEXT_REQUEST_POLICY.operationDeadlineMs,
			0,
			5000,
		),
		attemptTimeoutMs: bounded(
			overrides.attemptTimeoutMs,
			DEFAULT_COURSE_CONTEXT_REQUEST_POLICY.attemptTimeoutMs,
			0,
			2250,
		),
		maxAttempts: Math.floor(
			bounded(
				overrides.maxAttempts,
				DEFAULT_COURSE_CONTEXT_REQUEST_POLICY.maxAttempts,
				1,
				2,
			),
		),
		retryJitterMinMs,
		retryJitterMaxMs,
	};
}

export class ToolboxCourseContextRequestError extends Error {
	constructor(
		readonly failureClass: CourseContextFailureClass,
		readonly attempt: number,
		readonly totalDurationMs: number,
		readonly upstreamStatus?: number,
		options?: { cause?: unknown },
	) {
		super(`Toolbox course context request failed: ${failureClass}`, options);
		this.name = "ToolboxCourseContextRequestError";
	}
}

export class ToolboxCourseContextHttpError extends Error {
	constructor(readonly status: number) {
		super(`Toolbox course context request failed (${status})`);
		this.name = "ToolboxCourseContextHttpError";
	}
}

export class ToolboxCourseContextInvalidContractError extends Error {
	constructor(options?: { cause?: unknown }) {
		super("Toolbox course context response violated its contract", options);
		this.name = "ToolboxCourseContextInvalidContractError";
	}
}

export function classifyCourseContextRequestFailure(error: unknown): {
	failureClass: CourseContextFailureClass;
	upstreamStatus?: number;
} | undefined {
	if (error instanceof ToolboxCourseContextHttpError) {
		return {
			failureClass: error.status >= 500 ? "upstream_5xx" : "upstream_4xx",
			upstreamStatus: error.status,
		};
	}
	if (error instanceof DOMException && error.name === "AbortError")
		return { failureClass: "timeout" };
	if (error instanceof TypeError) return { failureClass: "network" };
	if (error instanceof ToolboxCourseContextInvalidContractError)
		return { failureClass: "invalid_contract" };
	return undefined;
}

export function retryableCourseContextFailure(
	failureClass: CourseContextFailureClass,
	status?: number,
): boolean {
	return failureClass === "timeout" ||
		failureClass === "network" ||
		(failureClass === "upstream_5xx" && [502, 503, 504].includes(status ?? 0));
}
