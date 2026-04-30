/**
 * JSON serialization utilities.
 *
 * Provides bigint-safe serialization for query results and REST API responses.
 */

/**
 * Stringify a value to JSON, converting bigint values to numbers (when safe)
 * or strings. Use this when serializing query results that may contain bigint columns.
 */
function stringifyBigIntSafe(value: unknown): string {
  return JSON.stringify(value, (_key, candidate) => {
    if (typeof candidate === 'bigint') {
      const numeric = Number(candidate);
      return Number.isSafeInteger(numeric) ? numeric : candidate.toString();
    }
    return candidate;
  });
}

/**
 * Round-trip a value through JSON serialization to convert bigint values
 * to plain numbers or strings. Useful for REST API responses where the value
 * must be a plain JSON-compatible object (not a string).
 */
export function toJsonSafe<T>(value: T): T {
  return JSON.parse(stringifyBigIntSafe(value)) as T;
}

/**
 * Parse a value that may be a JSON-encoded object (e.g. a jsonb column returned
 * as a string) into a plain object.  Returns `{}` when the input is falsy,
 * not valid JSON, or not a plain object.
 */
export function parseJsonValue<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

export function parseJsonObject(value: unknown): Record<string, unknown> {
  const parsed = parseJsonValue<unknown>(value, {});
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}
