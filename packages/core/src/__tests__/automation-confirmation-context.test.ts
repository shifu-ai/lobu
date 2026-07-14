import { describe, expect, test } from "bun:test";
import {
  AUTOMATION_CONFIRMATION_CONTEXT_FIELDS,
  parseAutomationConfirmationContext,
} from "../automation-confirmation-context";

describe("automation confirmation context", () => {
  const validContext = {
    kind: "automation_create",
    planId: "plan-1",
    planVersion: 2,
    contentHash: "sha256:abc",
  } as const;

  test("parses the exact canonical context", () => {
    expect(AUTOMATION_CONFIRMATION_CONTEXT_FIELDS).toEqual([
      "kind",
      "planId",
      "planVersion",
      "contentHash",
    ]);
    expect(parseAutomationConfirmationContext(validContext)).toEqual(
      validContext
    );
  });

  test.each([
    ["unknown kind", { ...validContext, kind: "unknown" }],
    ["blank planId", { ...validContext, planId: " " }],
    ["string planVersion", { ...validContext, planVersion: "1" }],
    ["zero planVersion", { ...validContext, planVersion: 0 }],
    ["fractional planVersion", { ...validContext, planVersion: 1.5 }],
    ["blank contentHash", { ...validContext, contentHash: " " }],
    ["missing kind", withoutField(validContext, "kind")],
    ["missing planId", withoutField(validContext, "planId")],
    ["missing planVersion", withoutField(validContext, "planVersion")],
    ["missing contentHash", withoutField(validContext, "contentHash")],
    ["unknown field", { ...validContext, extra: true }],
  ])("rejects %s", (_label, input) => {
    expect(() => parseAutomationConfirmationContext(input)).toThrow();
  });
});

function withoutField<T extends Record<string, unknown>>(
  input: T,
  field: keyof T
): Partial<T> {
  return Object.fromEntries(
    Object.entries(input).filter(([key]) => key !== field)
  ) as Partial<T>;
}
