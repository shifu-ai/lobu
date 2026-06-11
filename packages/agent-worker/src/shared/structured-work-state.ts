export interface StructuredDecisionOption {
  value: string;
  label: string;
  tradeoff: string;
  recommended?: boolean;
  recommendationReason?: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function assertRecoverableDecisionOptions(
  options: unknown
): asserts options is StructuredDecisionOption[] {
  if (!Array.isArray(options)) {
    throw new Error("Recoverable decision options must be an array");
  }
  if (options.length !== 3) {
    throw new Error(
      "Recoverable decision options must include exactly 3 options"
    );
  }

  const recommended = options.filter(
    (option) =>
      option &&
      typeof option === "object" &&
      (option as StructuredDecisionOption).recommended === true
  );
  if (recommended.length !== 1) {
    throw new Error(
      "Recoverable decision options must include exactly one recommended option"
    );
  }

  for (const [index, option] of options.entries()) {
    if (!option || typeof option !== "object" || Array.isArray(option)) {
      throw new Error(
        `Recoverable decision option ${index + 1} must be an object`
      );
    }
    const typed = option as StructuredDecisionOption;
    if (!isNonEmptyString(typed.value)) {
      throw new Error(`Recoverable decision option ${index + 1} needs a value`);
    }
    if (!isNonEmptyString(typed.label)) {
      throw new Error(`Recoverable decision option ${index + 1} needs a label`);
    }
    if (!isNonEmptyString(typed.tradeoff)) {
      throw new Error(
        `Recoverable decision option ${index + 1} needs a non-empty tradeoff`
      );
    }
    if (
      typed.recommended === true &&
      !isNonEmptyString(typed.recommendationReason)
    ) {
      throw new Error(
        "The recommended recoverable decision option needs a recommendation reason"
      );
    }
  }
}
