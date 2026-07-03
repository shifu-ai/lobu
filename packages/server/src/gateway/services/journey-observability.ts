import { createLogger } from "@lobu/core";

const logger = createLogger("journey-observability");

const SCHEMA_VERSION = "journey.trace.v1";
const DEFAULT_TIMEOUT_MS = 500;
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

export function buildJourneyEventBody(input: JourneyEventPayload) {
	const payload = redactValue(
		{
			...input,
			schema_version: SCHEMA_VERSION,
			timestamp: input.timestamp ?? new Date().toISOString(),
		},
		undefined,
		0,
		new WeakSet<object>()
	);

	return {
		schemaVersion: SCHEMA_VERSION,
		payload,
	};
}

export async function emitJourneyEvent(
	input: JourneyEventPayload
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
			body: JSON.stringify(buildJourneyEventBody(input)),
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
