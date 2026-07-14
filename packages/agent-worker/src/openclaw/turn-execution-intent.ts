import {
  classifyToolIntent,
  hasCalendarEventWriteToolIntent,
  hasOrganizationNotificationToolIntent,
  hasPersonalReminderToolIntent,
  hasTemporalToolIntent,
  hasUnderspecifiedScheduledWriteToolIntent,
} from "./tool-intent";

export type TurnExecutionDestination =
  | "personal_reminder"
  | "calendar_event"
  | "org_notification"
  | "unspecified";

export type TurnExecutionConfidence = "explicit" | "inferred" | "ambiguous";
export type TurnExecutionOperation = "create" | "cancel" | "list";

export interface TurnExecutionIntent {
  readonly destination: TurnExecutionDestination;
  readonly operation?: TurnExecutionOperation;
  readonly confidence: TurnExecutionConfidence;
  readonly requiresClarification: boolean;
}

function freezeIntent(intent: TurnExecutionIntent): TurnExecutionIntent {
  return Object.freeze(intent);
}

/** Derive the turn contract from the external user's current message only. */
export function deriveTurnExecutionIntent(text: string): TurnExecutionIntent {
  const normalized = text.normalize("NFKC").trim().toLowerCase();
  const hasTime = hasTemporalToolIntent(normalized);
  const personalReminderOperation: TurnExecutionOperation =
    /(?:取消|刪除|停止|不要再|cancel|delete|stop)/u.test(normalized)
      ? "cancel"
      : /(?:列出|查看|有哪些|清單|list|show|view)/u.test(normalized)
        ? "list"
        : "create";

  if (hasCalendarEventWriteToolIntent(normalized)) {
    return freezeIntent({
      destination: "calendar_event",
      confidence: hasTime ? "explicit" : "ambiguous",
      requiresClarification: !hasTime,
    });
  }

  if (hasOrganizationNotificationToolIntent(normalized)) {
    return freezeIntent({
      destination: "org_notification",
      confidence: hasTime ? "explicit" : "ambiguous",
      requiresClarification: !hasTime,
    });
  }

  if (hasPersonalReminderToolIntent(normalized)) {
    return freezeIntent({
      destination: "personal_reminder",
      operation: personalReminderOperation,
      confidence: hasTime ? "explicit" : "ambiguous",
      requiresClarification: !hasTime,
    });
  }

  // Reuse the bounded tool classifier so an automation-like write with no
  // named destination is clarified instead of guessed.
  if (
    classifyToolIntent(normalized) === "automation" ||
    hasUnderspecifiedScheduledWriteToolIntent(normalized)
  ) {
    return freezeIntent({
      destination: "unspecified",
      confidence: "ambiguous",
      requiresClarification: true,
    });
  }

  return freezeIntent({
    destination: "unspecified",
    confidence: "inferred",
    requiresClarification: false,
  });
}
