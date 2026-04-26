/**
 * Shared filter utilities used by event-filters.ts and watchers-filters.ts
 */

/**
 * Classification filters: map of classifier slug to array of selected values.
 * All keys and values MUST be strings to match backend SQL queries.
 */
export type ClassificationFilters = Record<string, string[]>;

/**
 * Get a parameter value from URLSearchParams or a Record.
 */
export function getParam(
  searchParams: URLSearchParams | Record<string, string | undefined>,
  key: string
): string | null {
  if (searchParams instanceof URLSearchParams) {
    return searchParams.get(key);
  }
  return searchParams[key] ?? null;
}

/**
 * Parses a comma-separated list of integers.
 */
export function parseIntArray(str: string | null | undefined): number[] {
  if (!str) return [];
  return str
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !Number.isNaN(n));
}

/**
 * Parses a comma-separated list of strings.
 */
export function parseStringArray(str: string | null | undefined): string[] {
  if (!str) return [];
  return str
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Validates and normalizes a classification filters object.
 * Ensures all keys and values are strings.
 */
export function normalizeClassificationFilters(raw: unknown): ClassificationFilters {
  if (typeof raw !== 'object' || raw === null) {
    return {};
  }

  const normalized: ClassificationFilters = {};
  for (const [key, value] of Object.entries(raw)) {
    const keyStr = String(key);
    if (Array.isArray(value)) {
      const valueStrs = value.filter((v) => v !== null && v !== undefined).map((v) => String(v));
      if (valueStrs.length > 0) {
        normalized[keyStr] = valueStrs;
      }
    }
  }

  return normalized;
}

/**
 * Parse clf_* parameters from a search params source into ClassificationFilters.
 */
export function parseClassificationParams(
  searchParams: URLSearchParams | Record<string, string | undefined>
): ClassificationFilters {
  const classificationFilters: ClassificationFilters = {};

  const entries =
    searchParams instanceof URLSearchParams
      ? Array.from(searchParams.entries())
      : Object.entries(searchParams);

  for (const [key, value] of entries) {
    if (key.startsWith('clf_') && value) {
      const slug = key.slice(4);
      const values = value
        .split(',')
        .map((v) => v.trim())
        .filter((v) => v.length > 0);
      if (values.length > 0) {
        classificationFilters[slug] = values;
      }
    }
  }

  return classificationFilters;
}

/**
 * Parse a date string into a Date object; returns null if invalid.
 * For YYYY-MM-DD format, parses as local date to avoid timezone offset issues.
 */
export function parseDateToObject(dateStr: string | null): Date | null {
  if (!dateStr) return null;

  const dateOnlyMatch = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnlyMatch) {
    const year = parseInt(dateOnlyMatch[1], 10);
    const month = parseInt(dateOnlyMatch[2], 10) - 1;
    const day = parseInt(dateOnlyMatch[3], 10);
    const date = new Date(year, month, day);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const date = new Date(dateStr);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Validate a YYYY-MM-DD date string; returns the string if valid, undefined otherwise.
 */
export function validateDateString(dateStr: string | null): string | undefined {
  if (!dateStr) return undefined;

  const dateMatch = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateMatch) {
    const year = parseInt(dateMatch[1], 10);
    const month = parseInt(dateMatch[2], 10);
    const day = parseInt(dateMatch[3], 10);
    const date = new Date(year, month - 1, day);
    if (!Number.isNaN(date.getTime())) {
      return dateStr;
    }
  }

  return undefined;
}

/**
 * Parse a string as a base-10 integer; returns undefined if invalid.
 */
export function parseInt10(str: string | null): number | undefined {
  if (!str) return undefined;
  const num = parseInt(str, 10);
  return Number.isNaN(num) ? undefined : num;
}

/**
 * Serialize ClassificationFilters into clf_* URL parameters.
 */
export function serializeClassificationParams(
  classificationFilters: ClassificationFilters | undefined
): Record<string, string> {
  const params: Record<string, string> = {};
  if (!classificationFilters) return params;

  for (const [slug, values] of Object.entries(classificationFilters)) {
    if (values.length > 0) {
      params[`clf_${slug}`] = values.join(',');
    }
  }

  return params;
}
