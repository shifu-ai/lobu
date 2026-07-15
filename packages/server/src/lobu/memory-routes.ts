import { Hono, type Context } from 'hono';
import { hasRequiredMcpScope } from '../auth/tool-access';
import { getDb } from '../db/client';
import type { Env } from '../index';
import logger from '../utils/logger';
import { getWorkspaceRole } from '../utils/organization-access';
import {
  ContextPackMemoryError,
  parseContextPackMemoryRequest,
  writeContextPackMemory,
} from './context-pack-memory-service';
import { createPostgresAgentConfigStore } from './stores/postgres-stores';

const memoryRoutes = new Hono<{ Bindings: Env }>();
const configStore = createPostgresAgentConfigStore();
type MemoryContext = Context<{ Bindings: Env }>;
const LOG_SAFE_METADATA_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/;

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

function scopesFromContext(c: MemoryContext): string[] | null {
  const authInfo = c.get('mcpAuthInfo');
  return Array.isArray(authInfo?.scopes) ? authInfo.scopes : null;
}

function hasAdminScope(scopes: string[] | null): boolean {
  return Array.isArray(scopes) && scopes.includes('mcp:admin');
}

function authSourceFromContext(c: MemoryContext): 'session' | 'pat' | 'oauth' | null {
  const source = c.get('authSource');
  if (source === 'session' || source === 'pat' || source === 'oauth') return source;
  return null;
}

function safeMetadataId(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === 'string' && LOG_SAFE_METADATA_ID_PATTERN.test(value) ? value : undefined;
}

function safeMetadataLogIds(metadata: Record<string, unknown>): {
  contextPackId?: string;
  discoveryRunId?: string;
} {
  const contextPackId = safeMetadataId(metadata, 'contextPackId');
  const discoveryRunId = safeMetadataId(metadata, 'discoveryRunId');
  return {
    ...(contextPackId !== undefined ? { contextPackId } : {}),
    ...(discoveryRunId !== undefined ? { discoveryRunId } : {}),
  };
}

function routeLogContext(
  startedAt: number,
  input: {
    organizationId?: string | null;
    ownerUserId?: string | null;
    agentId?: string | null;
    metadata?: Record<string, unknown> | null;
    errorCode?: string;
  }
) {
  const metadata = input.metadata ?? {};
  return {
    organizationId: input.organizationId ?? null,
    ownerUserId: input.ownerUserId ?? null,
    agentId: input.agentId ?? null,
    ...safeMetadataLogIds(metadata),
    durationMs: Date.now() - startedAt,
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
  };
}

memoryRoutes.post('/context-packs', async (c) => {
  const startedAt = Date.now();
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    logger.warn(
      routeLogContext(startedAt, { errorCode: 'lobu_memory_invalid_request' }),
      '[MemoryRoutes] context pack memory write failed'
    );
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
      logger.warn(
        routeLogContext(startedAt, { errorCode: error.errorCode }),
        '[MemoryRoutes] context pack memory write failed'
      );
      return c.json(memoryError(error.errorCode, error.message), memoryStatus(error.httpStatus));
    }
    logger.warn(
      routeLogContext(startedAt, { errorCode: 'lobu_memory_invalid_request' }),
      '[MemoryRoutes] context pack memory write failed'
    );
    return c.json(memoryError('lobu_memory_invalid_request', 'Invalid request body'), 400);
  }

  const organizationId = c.get('organizationId');
  const logParsedFailure = (errorCode: string) => {
    logger.warn(
      routeLogContext(startedAt, {
        organizationId,
        ownerUserId: parsed.ownerUserId,
        agentId: parsed.agentId,
        metadata: parsed.metadata,
        errorCode,
      }),
      '[MemoryRoutes] context pack memory write failed'
    );
  };
  logger.info(
    routeLogContext(startedAt, {
      organizationId,
      ownerUserId: parsed.ownerUserId,
      agentId: parsed.agentId,
      metadata: parsed.metadata,
    }),
    '[MemoryRoutes] context pack memory write started'
  );
  if (!organizationId) {
    logParsedFailure('lobu_memory_unauthorized');
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
      logParsedFailure('lobu_memory_write_forbidden');
      return c.json(
        memoryError('lobu_memory_write_forbidden', 'This route requires an owner session'),
        403
      );
    }
  } else if (authSource === 'pat' || authSource === 'oauth') {
    if (!user?.id) {
      logParsedFailure('lobu_memory_unauthorized');
      return c.json(memoryError('lobu_memory_unauthorized', 'Authentication required'), 401);
    }
    if (!hasRequiredMcpScope('write', scopes)) {
      logParsedFailure('lobu_memory_write_forbidden');
      return c.json(
        memoryError(
          'lobu_memory_write_forbidden',
          'Context pack memory writes require mcp:write or mcp:admin scope'
        ),
        403
      );
    }
    if (!hasAdminScope(scopes) && user.id !== parsed.ownerUserId) {
      logParsedFailure('lobu_memory_write_forbidden');
      return c.json(
        memoryError(
          'lobu_memory_write_forbidden',
          'This route requires mcp:admin scope or an owner-scoped write token'
        ),
        403
      );
    }
  } else {
    logParsedFailure('lobu_memory_unauthorized');
    return c.json(memoryError('lobu_memory_unauthorized', 'Authentication required'), 401);
  }

  const agentMetadata = await configStore.getMetadata(parsed.agentId);
  logger.info(
    routeLogContext(startedAt, {
      organizationId,
      ownerUserId: parsed.ownerUserId,
      agentId: parsed.agentId,
      metadata: parsed.metadata,
    }),
    '[MemoryRoutes] context pack memory agent metadata checked'
  );
  if (!agentMetadata || agentMetadata.owner?.userId !== parsed.ownerUserId) {
    logParsedFailure('lobu_memory_write_forbidden');
    return c.json(
      memoryError('lobu_memory_write_forbidden', 'Agent is not owned by ownerUserId'),
      403
    );
  }
  const ownerMemberRole = await getWorkspaceRole(getDb(), organizationId, parsed.ownerUserId);
  logger.info(
    routeLogContext(startedAt, {
      organizationId,
      ownerUserId: parsed.ownerUserId,
      agentId: parsed.agentId,
      metadata: parsed.metadata,
    }),
    '[MemoryRoutes] context pack memory owner role checked'
  );
  if (!ownerMemberRole) {
    logParsedFailure('lobu_memory_write_forbidden');
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
    logger.info(
      routeLogContext(startedAt, {
        organizationId,
        ownerUserId: parsed.ownerUserId,
        agentId: parsed.agentId,
        metadata: parsed.metadata,
      }),
      '[MemoryRoutes] context pack memory write done'
    );
    return c.json({
      ok: true,
      refs: result.refs,
      memory: {
        eventId: result.eventId,
        viewUrl: result.viewUrl ?? null,
        semanticType: result.semanticType,
        agentId: result.agentId,
        courseEntityIds: result.courseEntityIds,
      },
    });
  } catch (error) {
    if (error instanceof ContextPackMemoryError) {
      logParsedFailure(error.errorCode);
      return c.json(memoryError(error.errorCode, error.message), memoryStatus(error.httpStatus));
    }
    logParsedFailure('lobu_memory_write_failed');
    return c.json(
      memoryError('lobu_memory_write_failed', 'Failed to write context pack memory'),
      500
    );
  }
});

export { memoryRoutes };
