import { describe, expect, test } from "bun:test";

import { maybeProposeCompanyWikiCapture } from "../openclaw/company-wiki-capture";

const launchChecklistMessages = [
  {
    role: "user",
    content:
      "以後每次課程 launch 都要固定確認 owner、LINE 公告、FAQ 和最後核准。",
  },
  {
    role: "assistant",
    content:
      "收到，這是一個可重複的 launch checklist 流程，我會整理成待審知識。",
  },
];

async function failIfCalled(): Promise<never> {
  throw new Error("tool should not be called");
}

describe("maybeProposeCompanyWikiCapture", () => {
  test("skips capture when release claim lacks company_llm_wiki.capture.v1", async () => {
    const result = await maybeProposeCompanyWikiCapture({
      capabilityIds: [],
      messages: launchChecklistMessages,
      callTool: failIfCalled,
    });

    expect(result.status).toBe("skipped_no_capability");
  });

  test("skips capture when the conversation lacks durable process language", async () => {
    const result = await maybeProposeCompanyWikiCapture({
      capabilityIds: ["company_llm_wiki.capture.v1"],
      messages: [{ role: "user", content: "今天午餐吃什麼？" }],
      callTool: failIfCalled,
    });

    expect(result.status).toBe("skipped_no_candidate");
  });

  test("submits proposal when durable SOP is detected and capability is present", async () => {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const result = await maybeProposeCompanyWikiCapture({
      capabilityIds: ["company_llm_wiki.capture.v1"],
      messages: launchChecklistMessages,
      conversationId: "conv_1",
      runId: "run_1",
      agentId: "shifu-u-1",
      callTool: async (tool, args) => {
        calls.push({ tool, args });
        return {
          status: "pending_review",
          reviewItemId: "review-1",
          sourceId: "source-1",
        };
      },
    });

    expect(result).toEqual({
      status: "submitted",
      reviewItemId: "review-1",
      sourceId: "source-1",
    });
    expect(calls[0]?.tool).toBe("wiki_propose_from_conversation");
    expect(calls[0]?.args).toMatchObject({
      sourceRef: "lobu:conversation:conv_1:run_1",
      pageType: "sop",
      createdByAgentId: "shifu-u-1",
      capturedByAgentId: "shifu-u-1",
      whyWorthSaving:
        "This conversation contains a repeatable course PM operating rule that should be reviewed for the shared Company Wiki.",
    });
    expect(String(calls[0]?.args.rawText)).toContain("launch");
    expect(String(calls[0]?.args.bodyMd)).toContain(
      "Confirmed conversation excerpt"
    );
    expect(calls[0]?.args).not.toHaveProperty("screenpipe");
  });

  test("unwraps Toolbox MCP text content response envelopes", async () => {
    const result = await maybeProposeCompanyWikiCapture({
      capabilityIds: ["company_llm_wiki.capture.v1"],
      messages: launchChecklistMessages,
      conversationId: "conv_1",
      runId: "run_1",
      callTool: async () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "pending_review",
              reviewItemId: "review-2",
              sourceId: "source-2",
            }),
          },
        ],
      }),
    });

    expect(result).toEqual({
      status: "submitted",
      reviewItemId: "review-2",
      sourceId: "source-2",
    });
  });

  test("treats Toolbox MCP text errors as failed capture attempts", async () => {
    const result = await maybeProposeCompanyWikiCapture({
      capabilityIds: ["company_llm_wiki.capture.v1"],
      messages: launchChecklistMessages,
      callTool: async () => ({
        content: [
          {
            type: "text",
            text: "Error: tool_error: duplicate proposal",
          },
        ],
      }),
    });

    expect(result).toEqual({
      status: "failed",
      reason: "Error: tool_error: duplicate proposal",
    });
  });

  test("returns failed when the MCP tool call rejects", async () => {
    const result = await maybeProposeCompanyWikiCapture({
      capabilityIds: ["company_llm_wiki.capture.v1"],
      messages: launchChecklistMessages,
      callTool: async () => {
        throw new Error("mcp unavailable");
      },
    });

    expect(result).toEqual({
      status: "failed",
      reason: "mcp unavailable",
    });
  });
});
