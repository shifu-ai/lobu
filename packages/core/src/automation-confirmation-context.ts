export interface AutomationConfirmationContext {
  kind: "automation_create";
  planId: string;
  planVersion: number;
  contentHash: string;
}

export const AUTOMATION_CONFIRMATION_CONTEXT_FIELDS = [
  "kind",
  "planId",
  "planVersion",
  "contentHash",
] as const satisfies readonly (keyof AutomationConfirmationContext)[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function parseAutomationConfirmationContext(
  input: unknown
): AutomationConfirmationContext {
  if (!isRecord(input)) {
    throw new Error("Automation confirmation context must be an object");
  }

  const allowedFields: ReadonlySet<string> = new Set(
    AUTOMATION_CONFIRMATION_CONTEXT_FIELDS
  );
  if (Object.keys(input).some((field) => !allowedFields.has(field))) {
    throw new Error("Automation confirmation context has unknown fields");
  }
  if (input.kind !== "automation_create") {
    throw new Error("Unsupported automation confirmation context kind");
  }
  if (!isNonBlankString(input.planId)) {
    throw new Error("Automation confirmation context requires planId");
  }
  if (
    typeof input.planVersion !== "number" ||
    !Number.isInteger(input.planVersion) ||
    input.planVersion <= 0
  ) {
    throw new Error(
      "Automation confirmation context requires a positive integer planVersion"
    );
  }
  if (!isNonBlankString(input.contentHash)) {
    throw new Error("Automation confirmation context requires contentHash");
  }

  return {
    kind: input.kind,
    planId: input.planId,
    planVersion: input.planVersion,
    contentHash: input.contentHash,
  };
}
