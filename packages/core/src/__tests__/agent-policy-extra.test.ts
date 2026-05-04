import { describe, expect, test } from "bun:test";
import {
  buildUnconfiguredAgentNotice,
  detectToolIntentRules,
  renderAlwaysOnToolPolicyRules,
  renderBaselineAgentPolicy,
  renderDetectedToolIntentRules,
} from "../agent-policy";

describe("detectToolIntentRules empty-prompt guard", () => {
  test("returns [] for an empty string", () => {
    expect(detectToolIntentRules("")).toEqual([]);
  });

  test("returns [] for whitespace-only input", () => {
    expect(detectToolIntentRules("   \n\t  ")).toEqual([]);
  });

  test("renderDetectedToolIntentRules returns empty string for empty prompt", () => {
    expect(renderDetectedToolIntentRules("")).toBe("");
    expect(renderDetectedToolIntentRules("   ")).toBe("");
  });

  test("renderDetectedToolIntentRules returns empty string when no patterns match", () => {
    // A benign prompt that should not trip any pattern-based rule.
    expect(renderDetectedToolIntentRules("hello there friend")).toBe("");
  });
});

describe("renderAlwaysOnToolPolicyRules", () => {
  test("renders the always-on header with each always-include rule sorted by priority", () => {
    const out = renderAlwaysOnToolPolicyRules();
    expect(out).toContain("## Built-In Tool Policies");
    // alwaysInclude=true rules are AskUserQuestion (10), UploadUserFile (20), GetChannelHistory (35)
    expect(out).toContain("Structured User Choices");
    expect(out).toContain("Share Created Files");
    expect(out).toContain("Thread History");
    // priority ordering: 10 < 20 < 35
    const idxAsk = out.indexOf("Structured User Choices");
    const idxShare = out.indexOf("Share Created Files");
    const idxHistory = out.indexOf("Thread History");
    expect(idxAsk).toBeLessThan(idxShare);
    expect(idxShare).toBeLessThan(idxHistory);
  });
});

describe("renderBaselineAgentPolicy", () => {
  test("includes the baseline policy header", () => {
    const out = renderBaselineAgentPolicy();
    expect(out).toContain("## Baseline Policy");
    expect(out).toContain("Use tools to verify remote state");
  });
});

describe("buildUnconfiguredAgentNotice", () => {
  test("renders the notice without a settings link when no URL is provided", () => {
    const out = buildUnconfiguredAgentNotice();
    expect(out).toContain("## Agent Configuration Notice");
    expect(out).toContain("IDENTITY.md, SOUL.md, USER.md");
    expect(out).toContain("behave as a helpful, concise AI assistant");
    expect(out).not.toContain("[Open Agent Settings]");
  });

  test("appends a markdown settings link when a URL is provided", () => {
    const url = "https://example.com/settings";
    const out = buildUnconfiguredAgentNotice(url);
    expect(out).toContain(`[Open Agent Settings](${url})`);
    expect(out).toContain("## Agent Configuration Notice");
  });

  test("treats an empty string URL the same as no URL (falsy)", () => {
    const out = buildUnconfiguredAgentNotice("");
    expect(out).not.toContain("[Open Agent Settings]");
  });
});
