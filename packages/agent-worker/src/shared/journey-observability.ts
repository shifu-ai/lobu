import { createLogger } from "@lobu/core";
import {
  journeyEvent,
  type WorkerJourneyEventInput,
} from "./journey-trace";

const logger = createLogger("worker-journey-observability");
const SCHEMA_VERSION = "journey.trace.v1";
const DEFAULT_TIMEOUT_MS = 500;
const REDACTED = "[REDACTED]";
const SENSITIVE_VALUE_PATTERN =
  /\b(bearer|authorization|token|secret|password|api[_\-\s]?key)\b|sk-[a-z0-9_-]+|shifu-u-[a-z0-9_-]+/i;

function trimOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function redactSensitiveValues(value: unknown): unknown {
  if (typeof value === "string") {
    return SENSITIVE_VALUE_PATTERN.test(value) ? REDACTED : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveValues(item));
  }
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = redactSensitiveValues(entry);
    }
    return output;
  }
  return value;
}

export function buildWorkerJourneyEventBody(input: WorkerJourneyEventInput) {
  return {
    schemaVersion: SCHEMA_VERSION,
    payload: redactSensitiveValues(journeyEvent(input)),
  };
}

export async function emitJourneyObservabilityEvent(
  input: WorkerJourneyEventInput
): Promise<void> {
  const endpoint = trimOptional(process.env.TOOLBOX_AGENT_OBSERVABILITY_URL);
  const secret = trimOptional(process.env.TOOLBOX_INTERNAL_SECRET);
  if (!endpoint || !secret) return;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-secret": secret,
      },
      body: JSON.stringify(buildWorkerJourneyEventBody(input)),
      signal: controller.signal,
    });
    if (!response.ok) {
      logger.warn(
        { status: response.status, event: input.event },
        "Worker journey observability ingest returned non-ok"
      );
    }
  } catch (error) {
    logger.warn(
      { error, event: input.event },
      "Worker journey observability ingest failed"
    );
  } finally {
    clearTimeout(timeout);
  }
}
