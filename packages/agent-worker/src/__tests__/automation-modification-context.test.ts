import { describe, expect, it } from "vitest";
import { buildTrustedAutomationModificationTurnContext } from "../openclaw/automation-modification-context";

const NOW = new Date("2026-07-13T12:00:00.000Z");
const userPrompt = "改成每小時";
const display = {
  title: "週一課程風險摘要",
  summary: "整理本週課程阻塞與待決策事項",
  schedule: "每週一上午 8:30",
  reason: "讓 PM 在週會前掌握風險",
};

function metadata(context: unknown) {
  return { source: "line", automationModificationContext: context };
}

describe("trusted automation modification context", () => {
  it("keeps the real user prompt unchanged and renders selected context as system instructions", () => {
    const result = buildTrustedAutomationModificationTurnContext({
      userPrompt,
      platformMetadata: metadata({
        decisionId: "decision-selected",
        planId: "plan-selected",
        display,
        expiresAt: "2026-07-13T12:15:00.000Z",
      }),
      now: NOW,
    });

    expect(result.userPrompt).toBe(userPrompt);
    expect(result.userPrompt).not.toContain(display.title);
    expect(result.systemInstructions).toContain(
      "平台脈絡：使用者正在回覆先前點選的修改設定",
    );
    expect(result.systemInstructions).toContain(display.title);
    expect(result.systemInstructions).toContain(display.summary);
    expect(result.systemInstructions).toContain(display.schedule);
    expect(result.systemInstructions).toContain("decision-selected");
    expect(result.systemInstructions).toContain("plan-selected");
    expect(result.systemInstructions).toContain("僅討論修改，不建立");
    expect(result.systemInstructions).toContain("產生新的 plan");
    expect(result.systemInstructions).toContain("不可向使用者顯示");
    expect(Object.keys(result).sort()).toEqual([
      "systemInstructions",
      "userPrompt",
    ]);
  });

  it.each([
    ["missing", undefined],
    ["non-object", "context"],
    [
      "extra field",
      {
        decisionId: "decision-selected",
        planId: "plan-selected",
        display,
        expiresAt: "2026-07-13T12:15:00.000Z",
        cron: "0 * * * *",
      },
    ],
    [
      "missing decision",
      {
        planId: "plan-selected",
        display,
        expiresAt: "2026-07-13T12:15:00.000Z",
      },
    ],
    [
      "long plan id",
      {
        decisionId: "decision-selected",
        planId: "p".repeat(201),
        display,
        expiresAt: "2026-07-13T12:15:00.000Z",
      },
    ],
    [
      "extra display field",
      {
        decisionId: "decision-selected",
        planId: "plan-selected",
        display: { ...display, engine: "internal" },
        expiresAt: "2026-07-13T12:15:00.000Z",
      },
    ],
    [
      "technical display copy",
      {
        decisionId: "decision-selected",
        planId: "plan-selected",
        display: { ...display, summary: "依 planId 執行 cron" },
        expiresAt: "2026-07-13T12:15:00.000Z",
      },
    ],
    [
      "long title",
      {
        decisionId: "decision-selected",
        planId: "plan-selected",
        display: { ...display, title: "標".repeat(201) },
        expiresAt: "2026-07-13T12:15:00.000Z",
      },
    ],
    [
      "invalid expiry",
      {
        decisionId: "decision-selected",
        planId: "plan-selected",
        display,
        expiresAt: "soon",
      },
    ],
    [
      "expired",
      {
        decisionId: "decision-selected",
        planId: "plan-selected",
        display,
        expiresAt: "2026-07-13T11:59:59.000Z",
      },
    ],
  ])("ignores %s metadata without changing the user prompt", (_name, context) => {
    expect(
      buildTrustedAutomationModificationTurnContext({
        userPrompt,
        platformMetadata: metadata(context),
        now: NOW,
      }),
    ).toEqual({ userPrompt, systemInstructions: "" });
  });
});
