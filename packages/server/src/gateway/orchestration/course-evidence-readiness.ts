import type {
	CourseReadinessAssessment,
	CourseReadinessField,
} from "@lobu/core";

export type CourseEvidenceReadinessInput = Partial<
	Record<CourseReadinessField, unknown>
> & { conflictedFields?: CourseReadinessField[] };

const FIELD_ORDER: CourseReadinessField[] = [
	"audience",
	"key_learning",
	"course_promise",
	"existing_sales_talk",
];

const QUESTIONS: Record<CourseReadinessField, string> = {
	audience: "這門課最優先服務哪一類學員？",
	key_learning: "學員完成課程後最重要的學習成果是什麼？",
	course_promise: "這門課對學員承諾的具體改變是什麼？",
	existing_sales_talk: "目前是否已有招生文案、銷講或常用說法可參考？",
};

function isPresent(value: unknown): boolean {
	if (typeof value === "string") return value.trim().length > 0;
	return Array.isArray(value)
		? value.length > 0
		: value !== null && value !== undefined;
}

export function gradeCourseEvidenceReadiness(
	input: CourseEvidenceReadinessInput,
): CourseReadinessAssessment {
	const conflicted = new Set(input.conflictedFields ?? []);
	const availableFields = FIELD_ORDER.filter(
		(field) => !conflicted.has(field) && isPresent(input[field]),
	);
	const missingFields = FIELD_ORDER.filter(
		(field) => !availableFields.includes(field),
	);
	const level =
		conflicted.size > 0
			? "conflicted"
			: availableFields.length === FIELD_ORDER.length
				? "ready"
				: availableFields.length >= 2
					? "partial"
					: "minimal";
	const answerPolicy =
		level === "ready"
			? "answer"
			: level === "partial"
				? "answer_with_assumptions"
				: "answer_conservatively";

	return {
		level,
		answerPolicy,
		availableFields,
		missingFields,
		suggestedQuestions: missingFields
			.slice(0, 3)
			.map((field) => QUESTIONS[field]),
	};
}
