import { Hono } from 'hono';
import { hasRequiredMcpScope } from '../auth/tool-access';
import { getDb } from '../db/client';
import type { Env } from '../index';
import { getWorkspaceRole } from '../utils/organization-access';
import {
  ContextPackMemoryError,
  parseContextPackMemoryRequest,
  writeContextPackMemory,
} from './context-pack-memory-service';
import { createPostgresAgentConfigStore } from './stores/postgres-stores';

const memoryRoutes = new Hono<{ Bindings: Env }>();
const configStore = createPostgresAgentConfigStore();

function memoryError(
  errorCode: string,
  message: string
): { ok: false; errorCode: string; errorMessage: string } {
  return { ok: false, errorCode, errorMessage: message };
}

function memoryStatus(status: number): 400 | 401 | 403 | 422 | 500 {
  if (status === 401 || status === 403 || status === 422 || status === 500) {
    return status;
  }
  return 400;
}

function scopesFromContext(c: any): string[] | null {
  const authInfo = c.get('mcpAuthInfo');
  return Array.isArray(authInfo?.scopes) ? authInfo.scopes : null;
}

function hasAdminScope(scopes: string[] | null): boolean {
  return Array.isArray(scopes) && scopes.includes('mcp:admin');
}

function authSourceFromContext(c: any): 'session' | 'pat' | 'oauth' | null {
  const source = c.get('authSource');
  if (source === 'session' || source === 'pat' || source === 'oauth') return source;
  return null;
}

memoryRoutes.post('/context-packs', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      memoryError('lobu_memory_invalid_request', 'Invalid JSON body'),
      400
    );
  }

  let parsed: ReturnType<typeof parseContextPackMemoryRequest>;
  try {
    parsed = parseContextPackMemoryRequest(body);
  } catch (error) {
    if (error instanceof ContextPackMemoryError) {
      return c.json(memoryError(error.errorCode, error.message), memoryStatus(error.httpStatus));
    }
    return c.json(memoryError('lobu_memory_invalid_request', 'Invalid request body'), 400);
  }

  const organizationId = c.get('organizationId');
  if (!organizationId) {
    return c.json(
      memoryError('lobu_memory_unauthorized', 'Organization context is required'),
      401
    );
  }

  const authSource = authSourceFromContext(c);
  const user = c.get('user') as { id?: string } | null;
  const scopes = scopesFromContext(c);
  if (authSource === 'session') {
    if (user?.id !== parsed.ownerUserId) {
      return c.json(
        memoryError('lobu_memory_write_forbidden', 'This route requires an owner session'),
        403
      );
    }
  } else if (authSource === 'pat' || authSource === 'oauth') {
    if (!user?.id) {
      return c.json(memoryError('lobu_memory_unauthorized', 'Authentication required'), 401);
    }
    if (!hasRequiredMcpScope('write', scopes)) {
      return c.json(
        memoryError(
          'lobu_memory_write_forbidden',
          'Context pack memory writes require mcp:write or mcp:admin scope'
        ),
        403
      );
    }
    if (!hasAdminScope(scopes) && user.id !== parsed.ownerUserId) {
      return c.json(
        memoryError(
          'lobu_memory_write_forbidden',
          'This route requires mcp:admin scope or an owner-scoped write token'
        ),
        403
      );
    }
  } else {
    return c.json(memoryError('lobu_memory_unauthorized', 'Authentication required'), 401);
  }

  const agentMetadata = await configStore.getMetadata(parsed.agentId);
  if (!agentMetadata || agentMetadata.owner?.userId !== parsed.ownerUserId) {
    return c.json(
      memoryError('lobu_memory_write_forbidden', 'Agent is not owned by ownerUserId'),
      403
    );
  }
  const ownerMemberRole = await getWorkspaceRole(getDb(), organizationId, parsed.ownerUserId);
  if (!ownerMemberRole) {
    return c.json(
      memoryError('lobu_memory_write_forbidden', 'ownerUserId is not a member of this organization'),
      403
    );
  }

  try {
    const result = await writeContextPackMemory({
      organizationId,
      ownerMemberRole,
      authSource,
      scopes,
      requestUrl: c.req.url,
      env: c.env,
      body: parsed,
    });
    return c.json({
      ok: true,
      refs: result.refs,
      memory: {
        eventId: result.eventId,
        viewUrl: result.viewUrl ?? null,
        semanticType: result.semanticType,
        agentId: result.agentId,
      },
    });
  } catch (error) {
    if (error instanceof ContextPackMemoryError) {
      return c.json(memoryError(error.errorCode, error.message), memoryStatus(error.httpStatus));
    }
    return c.json(
      memoryError('lobu_memory_write_failed', 'Failed to write context pack memory'),
      500
    );
  }
});

export { memoryRoutes };
