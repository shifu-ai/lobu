import { createLogger } from "@lobu/core";
import { journeyEvent, type WorkerJourneyEventInput } from "./journey-trace";

const logger = createLogger("worker-journey-observability");
const SCHEMA_VERSION = "journey.trace.v1";
const DEFAULT_TIMEOUT_MS = 500;
const DEFAULT_SOURCE = "lobu";
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

function isShifuAgentObsEnabled(): boolean {
  const value = process.env.SHIFU_AGENT_OBS_ENABLED?.trim().toLowerCase();
  return value === "true" || value === "1" || value === "yes" || value === "on";
}

function getTimeoutMs(): number {
  const parsed = Number(process.env.SHIFU_AGENT_OBS_TIMEOUT_MS);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return DEFAULT_TIMEOUT_MS;
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

export function buildWorkerJourneyEventBody(
  input: WorkerJourneyEventInput,
  source?: string
) {
  return {
    schemaVersion: SCHEMA_VERSION,
    ...(source ? { source } : {}),
    payload: redactSensitiveValues(journeyEvent(input)),
  };
}

function resolveWorkerJourneyIngestConfig():
  | { endpoint: string; headers: Record<string, string>; source?: string }
  | undefined {
  const shifuEndpoint = trimOptional(process.env.SHIFU_AGENT_OBS_INGEST_URL);
  if (isShifuAgentObsEnabled() && shifuEndpoint) {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    const token = trimOptional(process.env.SHIFU_AGENT_OBS_TOKEN);
    if (token) headers.authorization = `Bearer ${token}`;
    return {
      endpoint: shifuEndpoint,
      headers,
      source:
        trimOptional(process.env.SHIFU_AGENT_OBS_SOURCE) ?? DEFAULT_SOURCE,
    };
  }

  const toolboxEndpoint = trimOptional(
    process.env.TOOLBOX_AGENT_OBSERVABILITY_URL
  );
  const toolboxSecret = trimOptional(process.env.TOOLBOX_INTERNAL_SECRET);
  if (toolboxEndpoint && toolboxSecret) {
    return {
      endpoint: toolboxEndpoint,
      headers: {
        "content-type": "application/json",
        "x-internal-secret": toolboxSecret,
      },
    };
  }
  return undefined;
}

export async function emitJourneyObservabilityEvent(
  input: WorkerJourneyEventInput
): Promise<void> {
  const config = resolveWorkerJourneyIngestConfig();
  if (!config) return;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), getTimeoutMs());
  try {
    const response = await fetch(config.endpoint, {
      method: "POST",
      headers: config.headers,
      body: JSON.stringify(buildWorkerJourneyEventBody(input, config.source)),
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
