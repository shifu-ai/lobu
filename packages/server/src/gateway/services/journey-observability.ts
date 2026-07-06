import { createLogger } from "@lobu/core";

const logger = createLogger("journey-observability");

const SCHEMA_VERSION = "journey.trace.v1";
const DEFAULT_TIMEOUT_MS = 500;
const DEFAULT_SOURCE = "lobu";
const REDACTED = "[REDACTED]";
const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_KEYS = 100;
const MAX_STRING_LENGTH = 2048;

export type JourneyEventStatus =
	| "started"
	| "ok"
	| "failed"
	| "timeout"
	| "blocked"
	| "degraded"
	| string;

export type JourneyEventPayload = {
	schema_version?: typeof SCHEMA_VERSION;
	timestamp?: string;
	trace_id: string;
	journey_id: string;
	event: string;
	service: "lobu" | string;
	module: string;
	status: JourneyEventStatus;
	agent?: Record<string, unknown>;
	toolbox?: Record<string, unknown>;
	session?: Record<string, unknown>;
	conversation?: Record<string, unknown>;
	mcp?: Record<string, unknown>;
	tool?: Record<string, unknown>;
	error?: Record<string, unknown>;
	duration_ms?: number;
	[key: string]: unknown;
};

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
	"agent_id",
	"agentid",
];

const SENSITIVE_VALUE_PATTERN =
	/\b(bearer|authorization|token|secret|password|api[_\-\s]?key)\b|sk-[a-z0-9_-]+|shifu-u-[a-z0-9_-]+/i;

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

function isSensitiveKey(key: string | undefined): boolean {
	if (!key) return false;
	const normalized = key.replace(/[^a-zA-Z0-9_]/g, "").toLowerCase();
	return SENSITIVE_KEY_FRAGMENTS.some((fragment) =>
		normalized.includes(fragment)
	);
}

function redactString(value: string): string {
	if (value.length > MAX_STRING_LENGTH) {
		return `${value.slice(0, MAX_STRING_LENGTH)}...[truncated ${
			value.length - MAX_STRING_LENGTH
		} chars]`;
	}
	if (SENSITIVE_VALUE_PATTERN.test(value)) return REDACTED;
	return value;
}

function redactValue(
	value: unknown,
	key: string | undefined,
	depth: number,
	seen: WeakSet<object>
): unknown {
	if (isSensitiveKey(key)) return undefined;
	if (typeof value === "string") return redactString(value);
	if (
		value === null ||
		typeof value === "number" ||
		typeof value === "boolean" ||
		typeof value === "undefined"
	) {
		return value;
	}
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "symbol" || typeof value === "function") return undefined;
	if (typeof value !== "object") return String(value);
	if (seen.has(value)) return "[Circular]";
	if (depth >= MAX_DEPTH) return "[MaxDepth]";

	seen.add(value);
	try {
		if (Array.isArray(value)) {
			const output = value
				.slice(0, MAX_ARRAY_ITEMS)
				.map((item) => redactValue(item, undefined, depth + 1, seen))
				.filter((item) => item !== undefined);
			if (value.length > MAX_ARRAY_ITEMS) {
				output.push(`[Truncated ${value.length - MAX_ARRAY_ITEMS} items]`);
			}
			return output;
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

function recordValue(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function promotableContext(payload: Record<string, unknown>) {
	const conversation = recordValue(payload.conversation);
	const session = recordValue(payload.session);
	const sessionId =
		nonEmptyString(payload.session_id) ??
		nonEmptyString(session?.id) ??
		nonEmptyString(session?.key);
	return {
		conversation_id:
			nonEmptyString(payload.conversation_id) ??
			(sessionId ? nonEmptyString(conversation?.id) : undefined),
		session_id: sessionId,
	};
}

export function buildJourneyEventBody(
	input: JourneyEventPayload,
	source?: string
) {
	const rawPayload = {
		...input,
		schema_version: SCHEMA_VERSION,
		timestamp: input.timestamp ?? new Date().toISOString(),
	};
	const context = promotableContext(rawPayload);
	const payload = redactValue(
		rawPayload,
		undefined,
		0,
		new WeakSet<object>()
	) as Record<string, unknown>;
	if (context.conversation_id) payload.conversation_id = context.conversation_id;
	if (context.session_id) payload.session_id = context.session_id;

	return {
		schemaVersion: SCHEMA_VERSION,
		...(source ? { source } : {}),
		payload,
	};
}

function resolveJourneyIngestConfig():
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
			source: trimOptional(process.env.SHIFU_AGENT_OBS_SOURCE) ?? DEFAULT_SOURCE,
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

export async function emitJourneyEvent(
	input: JourneyEventPayload
): Promise<void> {
	const config = resolveJourneyIngestConfig();
	if (!config) return;

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), getTimeoutMs());
	try {
		const response = await fetch(config.endpoint, {
			method: "POST",
			headers: config.headers,
			body: JSON.stringify(buildJourneyEventBody(input, config.source)),
			signal: controller.signal,
		});
		if (!response.ok) {
			logger.warn(
				{ status: response.status, event: input.event },
				"Journey observability ingest returned non-ok"
			);
		}
	} catch (error) {
		logger.warn(
			{ error, event: input.event },
			"Journey observability ingest failed"
		);
	} finally {
		clearTimeout(timeout);
	}
}
