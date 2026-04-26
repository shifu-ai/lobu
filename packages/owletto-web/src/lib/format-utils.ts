import { format, formatDistanceToNow } from 'date-fns';

/**
 * Format a date as a relative time string (e.g., "2 hours ago", "in 3 days")
 */
export function formatTimeAgo(date: Date | string | number): string {
  const dateObj = date instanceof Date ? date : new Date(date);
  return formatDistanceToNow(dateObj, { addSuffix: true });
}

/**
 * Format a date as a short absolute time (e.g., "Apr 7, 14:32")
 */
export function formatShortDate(date: Date | string | number): string {
  const dateObj = date instanceof Date ? date : new Date(date);
  return format(dateObj, 'MMM d, HH:mm');
}

/**
 * Format seconds into a human-friendly duration (e.g., "2m 15s", "1h 3m")
 */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}
