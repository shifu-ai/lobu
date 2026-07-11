import { describe, expect, test } from "vitest";
import {
	parseCourseSkillContextMetadata,
	resolveCourseSkillContextMetadata,
} from "../orchestration/course-skill-context-metadata.js";

const TOOLBOX_OPP_SKILL_FRONTMATTER = `---
name: opp-coach
description: Use when a course PM asks about 銷講、彩排、Perfect Webinar、Key Learning、Key Secret、三個秘密、新舊答案、英雄之旅、試吃、Offer、價值堆疊、破價、成交、CTA，或提供銷講逐字稿、課程素材與不完整想法，需要即時回饋、共同創作、深度診斷或完整銷講稿。
metadata:
  course-context-contract: 1
  scope: course
  context-fields: audience,dream_result,course_promise,key_learning,delivery_mechanism,evidence,offer
  retrieval-terms: Key Learning,Offer
  retrieval-limit: 8
---`;

describe("course skill context metadata", () => {
	test("parses the exact Toolbox opp-coach metadata contract", () => {
		expect(
			parseCourseSkillContextMetadata(TOOLBOX_OPP_SKILL_FRONTMATTER),
		).toEqual({
			scope: "course",
			contextFields: [
				"audience",
				"dream_result",
				"course_promise",
				"key_learning",
				"delivery_mechanism",
				"evidence",
				"offer",
			],
			retrievalTerms: ["Key Learning", "Offer"],
			retrievalLimit: 8,
		});
	});

	test("accepts bounded inline lists and rejects malformed or out-of-bounds values", () => {
		expect(
			parseCourseSkillContextMetadata(
				`---\nmetadata:\n  course-context-contract: 1\n  scope: course\n  context-fields: [audience, offer]\n  retrieval-terms: [Offer, 案例]\n  retrieval-limit: 2\n---`,
			),
		).toMatchObject({
			contextFields: ["audience", "offer"],
			retrievalTerms: ["Offer", "案例"],
			retrievalLimit: 2,
		});
		expect(
			parseCourseSkillContextMetadata(
				`---\nmetadata:\n  scope: project\n  context-fields: audience,secret_field\n  retrieval-terms: ${"x".repeat(101)}\n  retrieval-limit: 99\n---`,
			),
		).toBeNull();
		expect(parseCourseSkillContextMetadata("scope: course")).toBeNull();
	});

	test.each([
		`---\nmetadata:\n  scope: course\n  retrieval-terms: [Offer]\n---`,
		`---\nmetadata:\n  course-context-contract: 0\n  scope: course\n  retrieval-terms: [Offer]\n---`,
		`---\nmetadata:\n  course-context-contract: 2\n  scope: course\n  retrieval-terms: [Offer]\n---`,
		`---\nmetadata:\n  course-context-contract: "1"\n  scope: course\n  retrieval-terms: [Offer]\n---`,
	])("rejects missing or unsupported contract version %#", (content) => {
		expect(parseCourseSkillContextMetadata(content)).toBeNull();
	});

	test("merges only enabled course skills within global bounds", () => {
		const resolved = resolveCourseSkillContextMetadata([
			{ enabled: false, content: TOOLBOX_OPP_SKILL_FRONTMATTER },
			{ enabled: true, content: TOOLBOX_OPP_SKILL_FRONTMATTER },
			{
				enabled: true,
				instructions: `---\nmetadata:\n  course-context-contract: 1\n  scope: course\n  retrieval-terms: [第二詞]\n  retrieval-limit: 4\n---`,
			},
		]);
		expect(resolved).toMatchObject({ enabled: true, retrievalLimit: 8 });
		expect(resolved.retrievalTerms).toEqual(["Key Learning", "Offer"]);
	});
});
