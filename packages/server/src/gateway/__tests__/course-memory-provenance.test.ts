import { describe, expect, test, vi } from "vitest";
import { retrieveCourseMemory } from "../orchestration/course-memory-retriever.js";

const input = {
	organizationId: "org",
	ownerUserId: "owner",
	agentId: "agent",
	courseEntityId: "course:a",
	task: "meeting",
	skillTerms: [],
};

function row(overrides: Record<string, unknown> = {}) {
	return {
		id: 1,
		payload_text: "evidence",
		title: "meeting",
		source_url: null,
		organization_id: "org",
		metadata: {
			owner_user_id: "owner",
			agent_id: "agent",
			course_entity_ids: ["course:a"],
			source_type: "transcript",
		},
		...overrides,
	};
}

describe("course memory authoritative provenance", () => {
	test("caller metadata cannot promote an ordinary note/context pack", async () => {
		const result = await retrieveCourseMemory(input, {
			search: vi.fn().mockResolvedValue([
				row({
					connection_id: null,
					connector_key: null,
					origin_id: "uc_caller",
					origin_type: null,
					semantic_type: "note",
				}),
			]),
		});
		expect(result.snippets[0]?.trustedEvidenceKind).toBeUndefined();
	});

	test.each([
		[
			"meeting",
			{
				connection_id: 41,
				connector_key: "google_workspace",
				origin_id: "gmeet-1",
				origin_type: "meeting",
				semantic_type: "meeting_notes",
			},
		],
		[
			"transcript",
			{
				connection_id: 41,
				connector_key: "google_workspace",
				origin_id: "gmeet-1#transcript",
				origin_type: "audio",
				semantic_type: "content",
			},
		],
	] as const)("promotes verified %s system evidence", async (expected, provenance) => {
		const result = await retrieveCourseMemory(input, {
			search: vi.fn().mockResolvedValue([row(provenance)]),
		});
		expect(result.snippets[0]?.trustedEvidenceKind).toBe(expected);
	});
});
