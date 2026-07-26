export type CourseContextFailureClass =
	| "timeout"
	| "network"
	| "upstream_5xx"
	| "upstream_4xx"
	| "invalid_contract";

export interface CourseContextRequestPolicy {
	operationDeadlineMs: 5000;
	attemptTimeoutMs: 2250;
	maxAttempts: 2;
	retryJitterMinMs: 100;
	retryJitterMaxMs: 200;
}

export const DEFAULT_COURSE_CONTEXT_REQUEST_POLICY: CourseContextRequestPolicy =
	{
		operationDeadlineMs: 5000,
		attemptTimeoutMs: 2250,
		maxAttempts: 2,
		retryJitterMinMs: 100,
		retryJitterMaxMs: 200,
	};

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

export function retryableCourseContextFailure(
	failureClass: CourseContextFailureClass,
	status?: number,
): boolean {
	return (
		failureClass === "timeout" ||
		failureClass === "network" ||
		(failureClass === "upstream_5xx" && [502, 503, 504].includes(status ?? 0))
	);
}
