import { describe, expect, test } from "vitest";
import {
	parseCourseSkillContextMetadata,
	resolveCourseSkillContextMetadata,
	selectActiveCourseSkill,
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
	test.each([
		["case-folded config name", { name: "Opp-Coach", enabled: true, content: TOOLBOX_OPP_SKILL_FRONTMATTER }],
		["noncanonical config name", { name: "sales-helper", enabled: true, content: TOOLBOX_OPP_SKILL_FRONTMATTER }],
		["frontmatter-only alias", { enabled: true, content: TOOLBOX_OPP_SKILL_FRONTMATTER }],
	] as const)("rejects %s because it would sync outside .skills/opp-coach", (_label, skill) => {
		const available = resolveCourseSkillContextMetadata([skill]);
		expect(available.oppCoachAvailable).toBe(false);
		expect(selectActiveCourseSkill({ available, message: "幫我修改銷講" }).activeSpecializedSkill).toBeNull();
	});

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
		`---\nmetadata:\n  course-context-contract: 1\n  scope: course\n  retrieval-terms: [Offer]\n  retrieval-limit: 8\n---`,
		`---\nmetadata:\n  course-context-contract: 1\n  scope: course\n  context-fields: [audience]\n  retrieval-limit: 8\n---`,
		`---\nmetadata:\n  course-context-contract: 1\n  scope: course\n  context-fields: []\n  retrieval-terms: [Offer]\n  retrieval-limit: 8\n---`,
		`---\nmetadata:\n  course-context-contract: 1\n  scope: course\n  context-fields: [audience]\n  retrieval-terms: []\n  retrieval-limit: 8\n---`,
		`---\nmetadata:\n  course-context-contract: 1\n  scope: course\n  context-fields: [audience]\n  retrieval-terms: [Offer]\n---`,
	])("requires nonempty fields, terms, and an explicit limit %#", (content) => {
		expect(parseCourseSkillContextMetadata(content)).toBeNull();
	});

	test("supports CRLF and confines keys to the metadata block", () => {
		const crlf = TOOLBOX_OPP_SKILL_FRONTMATTER.replace(/\n/gu, "\r\n");
		expect(parseCourseSkillContextMetadata(crlf)?.retrievalTerms).toEqual(["Key Learning", "Offer"]);
		const escaped = `---\nmetadata:\n  course-context-contract: 1\nother:\n  scope: course\n  context-fields: [audience]\n  retrieval-terms: [Offer]\n  retrieval-limit: 8\n---`;
		expect(parseCourseSkillContextMetadata(escaped)).toBeNull();
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
			{ name: "opp-coach", enabled: false, content: TOOLBOX_OPP_SKILL_FRONTMATTER },
			{ name: "opp-coach", enabled: true, content: TOOLBOX_OPP_SKILL_FRONTMATTER },
			{
				name: "opp-coach",
				enabled: true,
				instructions: `---\nmetadata:\n  course-context-contract: 1\n  scope: course\n  retrieval-terms: [第二詞]\n  retrieval-limit: 4\n---`,
			},
		]);
		expect(resolved).toMatchObject({ enabled: true, retrievalLimit: 8 });
		expect(resolved.retrievalTerms).toEqual(["Key Learning", "Offer"]);
	});

	test("falls back to instructions only when content is invalid", () => {
		const validInstructions = TOOLBOX_OPP_SKILL_FRONTMATTER;
		expect(resolveCourseSkillContextMetadata([{ name: "opp-coach", enabled: true, content: "", instructions: validInstructions }]).enabled).toBe(true);
		expect(resolveCourseSkillContextMetadata([{ name: "opp-coach", enabled: true, content: "---\nmetadata:\n  scope: course\n---", instructions: validInstructions }]).enabled).toBe(true);
		expect(resolveCourseSkillContextMetadata([{ name: "opp-coach", enabled: true, content: validInstructions, instructions: "invalid" }]).retrievalTerms).toEqual(["Key Learning", "Offer"]);
	});

	test.each([
		["這堂課的三個秘密幫我想一下", "opp-coach"],
		["這堂課的三個相信怎麼鋪陳", "opp-coach"],
		["這段錯誤信念不夠有力", "opp-coach"],
		["幫我打破學員的信念", "opp-coach"],
		["價值公式這段怎麼講", "opp-coach"],
		["第二個關鍵秘密要怎麼改", "opp-coach"],
		["幫我看這段銷講彩排哪裡要改", "opp-coach"],
		["幫我寫信跟老師確認下週錄課時間", null],
		["整理今天的課程會議待辦", null],
		["提醒我繳電話費", null],
		["你好", null],
	] as const)("selects an installed opp-coach only for deterministic sales talk intent: %s", (message, expected) => {
		const available=resolveCourseSkillContextMetadata([{name:"opp-coach",enabled:true,content:TOOLBOX_OPP_SKILL_FRONTMATTER}]);
		expect(selectActiveCourseSkill({available,message}).activeSpecializedSkill).toBe(expected);
	});

	test("selects opp-coach from a trusted scheduled task kind even when the prompt is generic", () => {
		const available = resolveCourseSkillContextMetadata([
			{
				name: "opp-coach",
				enabled: true,
				content: TOOLBOX_OPP_SKILL_FRONTMATTER,
			},
		]);
		expect(
			selectActiveCourseSkill({
				available,
				message: "請主動問候 PM 並提供今天的準備提示",
				trustedScheduledTaskKind: "opp_coach_rehearsal_prompt",
			}),
		).toMatchObject({
			activeSpecializedSkill: "opp-coach",
			retrievalTerms: ["Key Learning", "Offer"],
		});
	});

});
