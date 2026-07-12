import { hasRequiredMcpScope } from '../auth/tool-access';
import { getDb } from '../db/client';
import { ToolUserError } from '../utils/errors';
import type { ToolContext } from './registry';

export interface PersonalMemoryReadScope {
  agentId: string;
  ownerUserId: string;
}

type MemoryAuthorizationContext = Pick<
  ToolContext,
  'isAuthenticated' | 'tokenType' | 'memberRole' | 'scopes' | 'userId'
> & { organizationId: string | null };

function scopeError(code: string, detail: string): ToolUserError {
  return new ToolUserError(`${code}: ${detail}`, 403);
}

export function isTrustedMemoryScopeOverride(ctx: MemoryAuthorizationContext): boolean {
  return (
    ctx.isAuthenticated === true &&
    (ctx.tokenType === 'oauth' || ctx.tokenType === 'pat') &&
    (ctx.memberRole === 'owner' || ctx.memberRole === 'admin') &&
    hasRequiredMcpScope('admin', ctx.scopes)
  );
}

export async function authorizeMemoryAgentOwner(
  ctx: MemoryAuthorizationContext,
  agentId: string,
): Promise<string | null> {
  const rows = await getDb()<{ owner_user_id: string | null }>`
    SELECT owner_user_id FROM agents
    WHERE id = ${agentId} AND organization_id = ${ctx.organizationId}
    LIMIT 1
  `;
  const ownerUserId = rows[0]?.owner_user_id;
  if (!ownerUserId && isTrustedMemoryScopeOverride(ctx)) return null;
  if (!ownerUserId) {
    throw scopeError(
      'memory_scope_identity_mismatch',
      'authenticated agent owner mapping is missing',
    );
  }
  if (!isTrustedMemoryScopeOverride(ctx) && (!ctx.userId || ownerUserId !== ctx.userId)) {
    throw scopeError(
      'memory_scope_mismatch',
      'authenticated user does not own the authenticated agent',
    );
  }
  return ownerUserId;
}

export async function resolvePersonalMemoryReadScope(
  ctx: ToolContext,
  requestedAgentId?: string,
): Promise<PersonalMemoryReadScope> {
  if (!ctx.organizationId || !ctx.agentId) {
    throw scopeError(
      'memory_scope_identity_missing',
      'organization and agent identity are required for personal memory recall',
    );
  }
  const trustedOverride = isTrustedMemoryScopeOverride(ctx);
  if (requestedAgentId && requestedAgentId !== ctx.agentId && !trustedOverride) {
    throw scopeError(
      'memory_scope_mismatch',
      'requested agent does not match the authenticated agent',
    );
  }
  const scopedAgentId = trustedOverride && requestedAgentId ? requestedAgentId : ctx.agentId;
  const ownerUserId = await authorizeMemoryAgentOwner(ctx, scopedAgentId);
  if (!ownerUserId) {
    throw scopeError(
      'memory_scope_identity_mismatch',
      'personal memory requires an agent owner mapping',
    );
  }
  return { agentId: scopedAgentId, ownerUserId };
}

export async function resolvePersonalOrganizationOwner(ctx: ToolContext): Promise<string | null> {
  const rows = await getDb()<{ owner_user_id: string | null }>`
    SELECT metadata::jsonb->>'personal_org_for_user_id' AS owner_user_id
    FROM organization WHERE id = ${ctx.organizationId} LIMIT 1
  `;
  return rows[0]?.owner_user_id ?? null;
}
