import { createLogger } from "@lobu/core";
import { journeyEvent, type WorkerJourneyEventInput } from "./journey-trace";

const logger = createLogger("worker-journey-observability");
const SCHEMA_VERSION = "journey.trace.v1";
const DEFAULT_TIMEOUT_MS = 500;
const REDACTED = "[REDACTED]";
const SENSITIVE_VALUE_PATTERN =
  /\b(bearer|authorization|token|secret|password|api[_\-\s]?key)\b|sk-[a-z0-9_-]+|shifu-u-[a-z0-9_-]+/i;
const SENSITIVE_KEY_FRAGMENTS = [
  "authorization",
  "bearer",
  "secret",
  "token",
  "cookie",
  "password",
  "credential",
  "apikey",
  "api_key",
  "email",
  "phone",
  "contact",
  "userid",
  "user_id",
  "lineuserid",
  "line_user_id",
  "toolbox_user_id",
];
const SENSITIVE_ID_PARENTS = new Set(["agent", "conversation", "toolbox"]);

function trimOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_]/g, "").toLowerCase();
}

function isSensitiveKey(key: string | undefined, path: string[]): boolean {
  if (!key) return false;
  const normalized = normalizeKey(key);
  if (
    normalized === "id" &&
    path.some((segment) => SENSITIVE_ID_PARENTS.has(segment))
  ) {
    return true;
  }
  return SENSITIVE_KEY_FRAGMENTS.some((fragment) =>
    normalized.includes(fragment)
  );
}

function redactSensitiveValues(
  value: unknown,
  key?: string,
  path: string[] = []
): unknown {
  if (isSensitiveKey(key, path)) return REDACTED;
  if (typeof value === "string") {
    return SENSITIVE_VALUE_PATTERN.test(value) ? REDACTED : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveValues(item, undefined, path));
  }
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = redactSensitiveValues(entry, key, [
        ...path,
        normalizeKey(key),
      ]);
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
