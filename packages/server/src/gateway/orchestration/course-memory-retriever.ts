const MAX_HITS = 8;
const MAX_SEARCH_ROWS = 64;
const MAX_TASK_CHARS = 560;
const MAX_SKILL_TERMS = 8;
const MAX_SNIPPET_CHARS = 600;

interface SearchRow {
	id: number;
	payload_text: string;
	title: string | null;
	source_url: string | null;
	organization_id: string;
	metadata: Record<string, unknown>;
}

export interface CourseMemoryRetrieval {
	status: "loaded" | "partial" | "failed";
	crossCourseGuard: "passed" | "failed";
	eventIds: number[];
	evidenceRefs: string[];
	snippets: Array<{
		eventId: number;
		title: string | null;
		text: string;
		sourceUrl: string | null;
	}>;
}

export interface CourseMemoryRetrievalInput {
	organizationId: string;
	ownerUserId: string;
	agentId: string;
	courseEntityId: string;
	task: string;
	skillTerms?: string[];
}

export type CourseMemorySearch = (input: {
	organizationId: string;
	ownerUserId: string;
	agentId: string;
	entityIds: string[];
	query: string;
	limit: number;
}) => Promise<unknown>;

export function buildCourseMemoryQuery(
	task: string,
	skillTerms: string[] = [],
): string {
	const boundedTask = task.trim().slice(0, MAX_TASK_CHARS);
	const terms = [
		...new Set(skillTerms.map((term) => term.trim()).filter(Boolean)),
	].slice(0, MAX_SKILL_TERMS);
	return [boundedTask, ...terms].filter(Boolean).join(" ").slice(0, 700);
}

function parseRows(value: unknown): SearchRow[] | null {
	if (!Array.isArray(value) || value.length > MAX_SEARCH_ROWS) return null;
	const rows: SearchRow[] = [];
	for (const item of value) {
		if (!item || typeof item !== "object") return null;
		const row = item as Record<string, unknown>;
		if (
			!Number.isInteger(row.id) ||
			Number(row.id) <= 0 ||
			typeof row.payload_text !== "string" ||
			row.payload_text.length > 200_000 ||
			typeof row.organization_id !== "string" ||
			!row.metadata ||
			typeof row.metadata !== "object" ||
			Array.isArray(row.metadata)
		)
			return null;
		if (row.title !== null && typeof row.title !== "string") return null;
		if (row.source_url !== null && typeof row.source_url !== "string")
			return null;
		rows.push(row as unknown as SearchRow);
	}
	return rows;
}

function exactCourseIds(metadata: Record<string, unknown>): string[] {
	const value = metadata.course_entity_ids;
	return Array.isArray(value) && value.every((item) => typeof item === "string")
		? value
		: [];
}

export async function retrieveCourseMemory(
	input: CourseMemoryRetrievalInput,
	deps: { search: CourseMemorySearch },
): Promise<CourseMemoryRetrieval> {
	const empty = (
		crossCourseGuard: "passed" | "failed" = "passed",
	): CourseMemoryRetrieval => ({
		status: "failed",
		crossCourseGuard,
		eventIds: [],
		evidenceRefs: [],
		snippets: [],
	});
	try {
		const raw = await deps.search({
			organizationId: input.organizationId,
			ownerUserId: input.ownerUserId,
			agentId: input.agentId,
			entityIds: [input.courseEntityId],
			query: buildCourseMemoryQuery(input.task, input.skillTerms),
			limit: MAX_HITS,
		});
		const rows = parseRows(raw);
		if (!rows) return empty();
		let mismatch = false;
		const safe = rows
			.filter((row) => {
				const metadata = row.metadata;
				const valid =
					row.organization_id === input.organizationId &&
					metadata.owner_user_id === input.ownerUserId &&
					metadata.agent_id === input.agentId &&
					exactCourseIds(metadata).includes(input.courseEntityId);
				if (!valid) mismatch = true;
				return valid;
			})
			.slice(0, MAX_HITS);
		if (safe.length === 0)
			return mismatch
				? empty("failed")
				: { ...empty("passed"), status: "loaded" };
		return {
			status: mismatch ? "partial" : "loaded",
			crossCourseGuard: mismatch ? "failed" : "passed",
			eventIds: safe.map((row) => row.id),
			evidenceRefs: safe.map((row) => `lobu:event:${row.id}`),
			snippets: safe.map((row) => ({
				eventId: row.id,
				title: row.title,
				text: row.payload_text.slice(0, MAX_SNIPPET_CHARS),
				sourceUrl: row.source_url,
			})),
		};
	} catch {
		return empty();
	}
}
