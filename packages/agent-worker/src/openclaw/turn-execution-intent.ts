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

export interface TurnExecutionIntent {
  readonly destination: TurnExecutionDestination;
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
