import { describe, expect, test } from "bun:test";
import { assertRecoverableDecisionOptions } from "../shared/structured-work-state";

const validOptions = [
  {
    value: "retry",
    label: "Retry",
    tradeoff: "May take longer but keeps the same plan.",
    recommended: true,
    recommendationReason: "Most likely to preserve the user's goal.",
  },
  {
    value: "skip",
    label: "Skip",
    tradeoff: "Unblocks progress but leaves this item incomplete.",
  },
  {
    value: "manual",
    label: "Manual help",
    tradeoff: "Needs user effort but avoids guessing.",
  },
];

describe("assertRecoverableDecisionOptions", () => {
  test("accepts exactly three options with one recommendation and tradeoffs", () => {
    expect(() => assertRecoverableDecisionOptions(validOptions)).not.toThrow();
  });

  test("rejects non-arrays", () => {
    expect(() => assertRecoverableDecisionOptions(null)).toThrow(/options/i);
  });

  test("requires exactly three options", () => {
    expect(() =>
      assertRecoverableDecisionOptions(validOptions.slice(0, 2))
    ).toThrow(/exactly 3/i);
  });

  test("requires exactly one recommended option", () => {
    const options = validOptions.map((option) => ({
      ...option,
      recommended: false,
    }));
    expect(() => assertRecoverableDecisionOptions(options)).toThrow(
      /exactly one/i
    );
  });

  test("requires the recommended option to include a recommendation reason", () => {
    const [{ recommendationReason, ...recommended }, ...rest] = validOptions;
    void recommendationReason;
    expect(() =>
      assertRecoverableDecisionOptions([recommended, ...rest])
    ).toThrow(/recommendation reason/i);
  });

  test("requires every option to include a non-empty tradeoff", () => {
    const options = validOptions.map((option, index) =>
      index === 1 ? { ...option, tradeoff: " " } : option
    );
    expect(() => assertRecoverableDecisionOptions(options)).toThrow(
      /tradeoff/i
    );
  });
});
