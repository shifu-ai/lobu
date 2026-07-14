import { describe, expect, test } from "vitest";
import {
	stripCallerEvidenceProvenance,
	verifiedEvidenceKind,
} from "../trusted-evidence-provenance.js";

describe("trusted evidence provenance boundary", () => {
	test("strips caller assertions while preserving unrelated note/context-pack metadata", () => {
		expect(
			stripCallerEvidenceProvenance({
				custom: "kept",
				contextPackId: "ctx-1",
				evidence_kind: "meeting",
				source_kind: "meeting_notes",
				source_type: "transcript",
			}),
		).toEqual({ custom: "kept", contextPackId: "ctx-1" });
	});

	test("ordinary caller records cannot self-assert trusted transcript provenance", () => {
		expect(
			verifiedEvidenceKind({
				connection_id: null,
				connector_key: null,
				origin_id: "uc_caller",
				origin_type: "transcript",
				semantic_type: "meeting_notes",
			}),
		).toBeUndefined();
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
	] as const)("derives %s from connector-backed system columns", (expected, record) => {
		expect(verifiedEvidenceKind(record)).toBe(expected);
	});
});
