const MAX_CONTEXT_FIELDS = 8;
const MAX_RETRIEVAL_TERMS = 2;
const MAX_TERM_CHARS = 100;
const ALLOWED_CONTEXT_FIELDS = new Set([
	"audience",
	"dream_result",
	"course_promise",
	"key_learning",
	"delivery_mechanism",
	"evidence",
	"offer",
]);

export interface CourseSkillContextMetadata {
	scope: "course";
	contextFields: string[];
	retrievalTerms: string[];
	retrievalLimit: number;
}
interface SkillLike {
	name?: string;
	enabled?: boolean;
	content?: string;
	instructions?: string;
}
export interface ResolvedCourseSkillContextMetadata {
	enabled: boolean;
	oppCoachAvailable: boolean;
	contextFields: string[];
	retrievalTerms: string[];
	retrievalLimit: number;
}

export interface ActiveCourseSkillSelection {
	activeSpecializedSkill: "opp-coach" | null;
	contextFields: string[];
	retrievalTerms: string[];
	retrievalLimit: number;
}

const SALES_TALK_INTENT = /(?:銷講|彩排|Perfect\s*Webinar|Key\s*(?:Learning|Secret)|三個秘密|新舊答案|英雄之旅|試吃|Offer|價值堆疊|破價|成交|CTA|逐字稿.{0,20}(?:feedback|回饋|修改))/iu;

export function isDeterministicSalesTalkIntent(message: string): boolean {
	return SALES_TALK_INTENT.test(message.trim());
}

export function parseCourseSkillContextMetadata(
	content: string,
): CourseSkillContextMetadata | null {
	const frontmatter = extractFrontmatter(content);
	if (!frontmatter) return null;
	const metadataStart = frontmatter.findIndex((line) =>
		/^metadata:\s*$/u.test(line),
	);
	if (metadataStart < 0) return null;
	const metadataLines: string[] = [];
	for (const line of frontmatter.slice(metadataStart + 1)) {
		if (line && !/^\s/u.test(line)) break;
		if (/^\s{2,}/u.test(line)) metadataLines.push(line);
	}
	if (scalar(metadataLines, "course-context-contract") !== "1") return null;
	if (scalar(metadataLines, "scope") !== "course") return null;
	const contextFields = list(metadataLines, "context-fields");
	const retrievalTerms = list(metadataLines, "retrieval-terms");
	const rawLimit = scalar(metadataLines, "retrieval-limit");
	if (rawLimit === null) return null;
	const retrievalLimit = Number(rawLimit);
	if (
		!contextFields ||
		contextFields.length === 0 ||
		contextFields.length > MAX_CONTEXT_FIELDS ||
		contextFields.some((field) => !ALLOWED_CONTEXT_FIELDS.has(field))
	)
		return null;
	if (
		!retrievalTerms ||
		retrievalTerms.length === 0 ||
		retrievalTerms.length > MAX_RETRIEVAL_TERMS ||
		retrievalTerms.some(
			(term) => term.length < 2 || term.length > MAX_TERM_CHARS,
		)
	)
		return null;
	if (
		!Number.isSafeInteger(retrievalLimit) ||
		retrievalLimit < 1 ||
		retrievalLimit > 8
	)
		return null;
	return { scope: "course", contextFields, retrievalTerms, retrievalLimit };
}

export function resolveCourseSkillContextMetadata(
	skills: SkillLike[],
): ResolvedCourseSkillContextMetadata {
	const parsed = skills
		.filter((skill) => skill.enabled)
		.filter((skill) => resolvedSkillName(skill) === "opp-coach")
		.map((skill) => parseCourseSkillContextMetadata(skill.content ?? "") ?? parseCourseSkillContextMetadata(skill.instructions ?? ""))
		.filter(
			(metadata): metadata is CourseSkillContextMetadata => metadata !== null,
		);
	return {
		enabled: parsed.length > 0,
		oppCoachAvailable: parsed.length > 0,
		contextFields: unique(
			parsed.flatMap((metadata) => metadata.contextFields),
		).slice(0, MAX_CONTEXT_FIELDS),
		retrievalTerms: unique(
			parsed.flatMap((metadata) => metadata.retrievalTerms),
		).slice(0, MAX_RETRIEVAL_TERMS),
		retrievalLimit:
			parsed.length === 0
				? 8
				: Math.max(...parsed.map((metadata) => metadata.retrievalLimit)),
	};
}

export function selectActiveCourseSkill(input: {
	available: ResolvedCourseSkillContextMetadata;
	message: string;
	trustedScheduledTaskKind?: string;
}): ActiveCourseSkillSelection {
	const active = input.available.oppCoachAvailable &&
		(isDeterministicSalesTalkIntent(input.message) || input.trustedScheduledTaskKind === "sales_rehearsal");
	return active ? {
		activeSpecializedSkill: "opp-coach",
		contextFields: input.available.contextFields,
		retrievalTerms: input.available.retrievalTerms,
		retrievalLimit: input.available.retrievalLimit,
	} : {
		activeSpecializedSkill: null,
		contextFields: [],
		retrievalTerms: [],
		retrievalLimit: 8,
	};
}

function resolvedSkillName(skill: SkillLike): string | null {
	if (skill.name) return skill.name.trim().toLowerCase();
	for (const content of [skill.content, skill.instructions]) {
		const frontmatter = content ? extractFrontmatter(content) : null;
		const name = frontmatter?.find((line) => /^name:\s*/u.test(line))?.replace(/^name:\s*/u, "").trim();
		if (name) return name.toLowerCase();
	}
	return null;
}

function extractFrontmatter(content: string): string[] | null {
	const normalized = content.replace(/\r\n?/gu, "\n");
	if (!normalized.startsWith("---\n")) return null;
	const end = normalized.indexOf("\n---", 4);
	return end < 0 ? null : normalized.slice(4, end).split("\n");
}
function scalar(lines: string[], key: string): string | null {
	const pattern = new RegExp(`^\\s{2}${key}:\\s*(.*?)\\s*$`, "u");
	for (const line of lines) {
		const match = line.match(pattern);
		if (match) return match[1] || null;
	}
	return null;
}
function list(lines: string[], key: string): string[] | null {
	const pattern = new RegExp(`^\\s{2}${key}:\\s*(.*?)\\s*$`, "u");
	const index = lines.findIndex((line) => pattern.test(line));
	if (index < 0) return [];
	const raw = lines[index]?.match(pattern)?.[1]?.trim() ?? "";
	if (raw)
		return unique(
			raw
				.replace(/^\[|\]$/gu, "")
				.split(",")
				.map((value) => value.trim())
				.filter(Boolean),
		);
	const values: string[] = [];
	for (const line of lines.slice(index + 1)) {
		const match = line.match(/^\s{4}-\s*(.*?)\s*$/u);
		if (!match) break;
		if (match[1]) values.push(match[1]);
	}
	return unique(values);
}
function unique(values: string[]): string[] {
	return [...new Set(values)];
}
