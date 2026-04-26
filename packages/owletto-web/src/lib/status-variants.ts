export type StatusVariant = 'active' | 'paused' | 'error' | 'pending' | 'rejected' | 'default';

const ERROR_STATUSES = new Set(['error', 'failed', 'revoked']);

/**
 * Maps a status string to a badge variant.
 * Used by ConnectionsTab and similar table views.
 */
export function getStatusVariant(status: string): StatusVariant {
  if (status === 'active') return 'active';
  if (status === 'paused') return 'paused';
  if (status === 'pending' || status === 'pending_auth') return 'pending';
  if (ERROR_STATUSES.has(status)) return 'error';
  return 'default';
}
