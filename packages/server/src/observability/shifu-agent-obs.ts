const SCHEMA_VERSION = 'journey.trace.v1';
const DEFAULT_SOURCE = 'lobu';
const REDACTED = '[REDACTED]';
const CIRCULAR = '[Circular]';
const MAX_STRING_LENGTH = 2048;
const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_KEYS = 100;
const MAX_DEPTH = 6;
const DEFAULT_INGEST_TIMEOUT_MS = 2000;

const SENSITIVE_KEY_WORDS = new Set([
  'authorization',
  'bearer',
  'token',
  'secret',
  'password',
  'passphrase',
  'credential',
]);
const SENSITIVE_VALUE_PATTERN =
  /\b(bearer|token|secret|password|api[_\-\s]?key|authorization)\b|sk-[a-z0-9_-]+/i;

type AgentObsStatus = 'started' | 'success' | 'error' | string;

export type AgentObsEventInput = {
  traceId: string;
  turnId?: string;
  conversationId?: string;
  agentId?: string;
  userId?: string;
  toolboxUserId?: string;
  connectorKey?: string;
  toolName?: string;
  eventName: string;
  status: AgentObsStatus;
  stage: string;
  durationMs?: number;
  errorKind?: string;
  errorCode?: string;
  message?: string;
  metadata?: unknown;
  timestamp?: string;
};

type AgentObsEventPayload = {
  schemaVersion: typeof SCHEMA_VERSION;
  source: string;
  traceId: string;
  turnId?: string;
  conversationId?: string;
  agentId?: string;
  userId?: string;
  toolboxUserId?: string;
  connectorKey?: string;
  toolName?: string;
  eventName: string;
  status: AgentObsStatus;
  stage: string;
  durationMs?: number;
  errorKind?: string;
  errorCode?: string;
  message?: string;
  metadata?: unknown;
  timestamp: string;
};

function truncateString(value: string): string {
  if (value.length <= MAX_STRING_LENGTH) return value;
  return `${value.slice(0, MAX_STRING_LENGTH)}...[truncated ${value.length - MAX_STRING_LENGTH} chars]`;
}

function isSensitiveKey(key: string | undefined): boolean {
  if (!key) return false;
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());

  if (words.some((word) => SENSITIVE_KEY_WORDS.has(word))) return true;

  for (let index = 0; index < words.length - 1; index += 1) {
    const phrase = `${words[index]} ${words[index + 1]}`;
    if (phrase === 'api key' || phrase === 'private key') return true;
  }

  return false;
}

function isSensitiveString(value: string): boolean {
  return SENSITIVE_VALUE_PATTERN.test(value);
}

function redactValue(value: unknown, key: string | undefined, depth: number, seen: WeakSet<object>): unknown {
  if (isSensitiveKey(key)) return REDACTED;

  if (typeof value === 'string') {
    if (isSensitiveString(value)) return REDACTED;
    return truncateString(value);
  }

  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'undefined'
  ) {
    return value;
  }

  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'symbol' || typeof value === 'function') return undefined;

  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return CIRCULAR;
  if (depth >= MAX_DEPTH) return '[MaxDepth]';

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value
        .slice(0, MAX_ARRAY_ITEMS)
        .map((item) => redactValue(item, undefined, depth + 1, seen));
      if (value.length > MAX_ARRAY_ITEMS) {
        items.push(`[Truncated ${value.length - MAX_ARRAY_ITEMS} items]`);
      }
      return items;
    }

    const output: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, MAX_OBJECT_KEYS);
    for (const [entryKey, entryValue] of entries) {
      const redacted = redactValue(entryValue, entryKey, depth + 1, seen);
      if (redacted !== undefined) output[entryKey] = redacted;
    }
    const totalKeys = Object.keys(value as Record<string, unknown>).length;
    if (totalKeys > MAX_OBJECT_KEYS) {
      output.__truncatedKeys = totalKeys - MAX_OBJECT_KEYS;
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

export function redactAgentObsValue(value: unknown): unknown {
  return redactValue(value, undefined, 0, new WeakSet<object>());
}

function isEnabled(): boolean {
  const value = process.env.SHIFU_AGENT_OBS_ENABLED?.trim().toLowerCase();
  return value === 'true' || value === '1' || value === 'yes' || value === 'on';
}

function trimOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function getIngestTimeoutMs(): number {
  const parsed = Number(process.env.SHIFU_AGENT_OBS_TIMEOUT_MS);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return DEFAULT_INGEST_TIMEOUT_MS;
}

export async function emitAgentObsEvent(input: AgentObsEventInput): Promise<void> {
  try {
    const ingestUrl = trimOptional(process.env.SHIFU_AGENT_OBS_INGEST_URL);
    if (!isEnabled() || !ingestUrl) return;

    const payload: AgentObsEventPayload = {
      schemaVersion: SCHEMA_VERSION,
      source: trimOptional(process.env.SHIFU_AGENT_OBS_SOURCE) ?? DEFAULT_SOURCE,
      traceId: input.traceId,
      turnId: input.turnId,
      conversationId: input.conversationId,
      agentId: input.agentId,
      userId: input.userId,
      toolboxUserId: input.toolboxUserId,
      connectorKey: input.connectorKey,
      toolName: input.toolName,
      eventName: input.eventName,
      status: input.status,
      stage: input.stage,
      durationMs: input.durationMs,
      errorKind: input.errorKind,
      errorCode: input.errorCode,
      message: input.message,
      metadata: redactAgentObsValue(input.metadata ?? {}),
      timestamp: input.timestamp ?? new Date().toISOString(),
    };

    const token = trimOptional(process.env.SHIFU_AGENT_OBS_TOKEN);
    const body = JSON.stringify(redactAgentObsValue(payload));
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (token) headers.authorization = `Bearer ${token}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), getIngestTimeoutMs());
    try {
      const response = await fetch(ingestUrl, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
      if (!response.ok) return;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return;
  }
}
