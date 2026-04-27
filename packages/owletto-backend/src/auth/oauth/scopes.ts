/**
 * OAuth Scope Constants
 *
 * Single source of truth for all OAuth scope definitions.
 */

/** All available scopes */
export const AVAILABLE_SCOPES = ['mcp:read', 'mcp:write', 'mcp:admin', 'profile:read'] as const;

/** Default scopes for MCP access */
export const DEFAULT_SCOPES = ['mcp:read', 'mcp:write'] as const;

/** Default scopes as a space-separated string (for OAuth params) */
export const DEFAULT_SCOPES_STRING = DEFAULT_SCOPES.join(' ');

/**
 * Strip `mcp:admin` from a requested scope string when the user is not an
 * owner/admin of the target org. The runtime tool-access checks reject
 * admin-tier actions for non-admins anyway, so filtering at consent makes
 * the stored token scope match the user's actual privileges and avoids
 * a confusing "reconnect with admin access" error after grant.
 */
export function filterScopeByRole(
  scope: string | undefined | null,
  memberRole: string | null
): string {
  const requested = (scope || '')
    .split(' ')
    .map((value) => value.trim())
    .filter(Boolean);
  const isAdmin = memberRole === 'owner' || memberRole === 'admin';
  if (isAdmin) {
    return requested.join(' ');
  }
  return requested.filter((s) => s !== 'mcp:admin').join(' ');
}
