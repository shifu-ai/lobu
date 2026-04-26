/**
 * Shared string/date utility functions used across the frontend.
 */

/** Convert a slug or underscore/hyphen-separated string to Title Case. */
export function titleCaseWords(value: string): string {
  return value
    .replace(/[-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

/** Compare two nullable date strings for descending sort order. */
export function byDateDesc(a: string | null | undefined, b: string | null | undefined): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return new Date(b).getTime() - new Date(a).getTime();
}
