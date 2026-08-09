import { describe, expect, test } from "bun:test";

import { maybeRecallCompanyWiki } from "../openclaw/company-wiki-recall";

async function failIfCalled(): Promise<never> {
	throw new Error("tool should not be called");
}

describe("maybeRecallCompanyWiki", () => {
	test("skips recall without company_llm_wiki.recall.v1", async () => {
		const result = await maybeRecallCompanyWiki({
			capabilityIds: [],
			userMessage: "課程 launch checklist 是什麼？",
			callTool: failIfCalled,
		});

		expect(result.status).toBe("skipped_no_capability");
	});

	test("skips recall for non-course-PM turns", async () => {
		const result = await maybeRecallCompanyWiki({
			capabilityIds: ["company_llm_wiki.recall.v1"],
			userMessage: "今天午餐吃什麼？",
			callTool: failIfCalled,
		});

		expect(result.status).toBe("skipped_not_relevant");
	});

	test("calls wiki_recall_context for task-like course PM question", async () => {
		const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
		const result = await maybeRecallCompanyWiki({
			capabilityIds: ["company_llm_wiki.recall.v1"],
			userMessage: "課程 launch checklist 是什麼？",
			callTool: async (tool, args) => {
				calls.push({ tool, args });
				return {
					pages: [
						{
							title: "Course launch checklist",
							pageType: "sop",
							summary: "Reviewed launch checklist.",
							bodyMd: "# Course launch checklist\n\n1. Confirm owner.",
						},
					],
				};
			},
		});

		expect(result.status).toBe("recalled");
		expect(calls[0]?.tool).toBe("wiki_recall_context");
		expect(calls[0]?.args).toEqual({
			query: "課程 launch checklist 是什麼？",
			limit: 5,
		});
		if (result.status === "recalled") {
			expect(typeof result.contextText).toBe("string");
			expect(
				result.contextText.includes("Company Wiki approved context:"),
			).toBe(true);
			expect(result.contextText.includes("Course launch checklist")).toBe(true);
			expect(result.contextText.includes("company wiki approved page")).toBe(
				true,
			);
			expect(
				result.contextText.includes("Do not treat pending review items"),
			).toBe(true);
			expect(result.contextText.length).toBeLessThanOrEqual(4_000);
		}
	});

	test("unwraps Toolbox MCP text content response envelopes", async () => {
		const result = await maybeRecallCompanyWiki({
			capabilityIds: ["company_llm_wiki.recall.v1"],
			userMessage: "LINE 公告流程怎麼做？",
			callTool: async () => ({
				content: [
					{
						type: "text",
						text: JSON.stringify({
							pages: [
								{
									title: "LINE announcement SOP",
									type: "sop",
									summary: "Approved announcement flow.",
								},
							],
						}),
					},
				],
			}),
		});

		expect(result).toMatchObject({
			status: "recalled",
			contextText: expect.stringContaining("LINE announcement SOP"),
		});
	});

	test("returns failed when recall tool returns an error", async () => {
		const result = await maybeRecallCompanyWiki({
			capabilityIds: ["company_llm_wiki.recall.v1"],
			userMessage: "SOP 怎麼做？",
			callTool: async () => ({
				content: [{ type: "text", text: "Error: recall unavailable" }],
			}),
		});

		expect(result).toEqual({
			status: "failed",
			reason: "Error: recall unavailable",
		});
	});
});
