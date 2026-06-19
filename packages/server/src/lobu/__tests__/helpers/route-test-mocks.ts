/**
 * Shared mutable mock state for the src/lobu route test files.
 *
 * bun:test's `mock.module` is process-global and module evaluation is cached:
 * the FIRST test file to import `../agent-routes.js` permanently binds it to
 * whatever mock factories are installed at that moment. When each test file
 * registered its own `mock.module('../../auth/middleware', …)` closing over
 * its OWN stash objects, the second file's re-mock never reached the
 * already-evaluated agent-routes module — its requests kept authenticating
 * against the first file's stash (wrong org) and hitting the first file's
 * manager stub, so every lookup 404'd whenever both files ran in one process
 * (`bun test src/lobu/__tests__`), while each file passed alone.
 *
 * Fix: install ONE process-wide mock per specifier, closing over these shared
 * mutable stashes. Each test file sets its per-test values on the stashes in
 * `beforeEach` — bun runs files sequentially in a single process, so there is
 * no cross-talk.
 */
import { mock } from 'bun:test';

export interface AuthStash {
  user: { id: string; name: string; email: string; emailVerified: boolean } | null;
  organizationId: string | null;
  // `authSource` mirrors the real middleware contract so admin-tier routes
  // gated by `requireSessionOrAdminPat` see a non-null value.
  authSource: 'session' | 'pat' | 'oauth' | null;
  mcpAuthInfo: { scopes: string[] } | null;
  memberRole: string | null;
  mcpAuthCalls: number;
  rejectMcpAuth: boolean;
}

/** Mutable holder the mocked `mcpAuth` middleware copies onto the Hono context. */
export const authStash: AuthStash = {
  user: { id: 'u1', name: 'Test', email: 'u1@test', emailVerified: true },
  organizationId: 'org-a',
  authSource: 'session',
  mcpAuthInfo: null,
  memberRole: 'owner',
  mcpAuthCalls: 0,
  rejectMcpAuth: false,
};

/**
 * Mutable holder for whatever `getChatInstanceManager()` should return —
 * a delegating stub (agent-routes-apply.test.ts) or the real
 * ChatInstanceManager (agent-routes-rest-platform.test.ts).
 */
export const chatManagerStash: { manager: any } = { manager: null };

/** Mutable holder for core services needed by focused route tests. */
export const coreServicesStash: { services: any } = { services: null };

export const fakeRouteAgents = new Map<string, any>();
export const fakeRouteSettings = new Map<string, any>();
export const fakeRouteConnections = new Map<string, any>();
export const routeStoreStash = {
  failSaveConnection: false,
};

async function readAgentMetadataFromDb(agentId: string): Promise<any | null> {
  const organizationId = authStash.organizationId;
  if (!organizationId) return null;
  if (!process.env.DATABASE_URL) return null;
  const { getDb } = await import('../../../db/client.js');
  const sql = getDb();
  const rows = await sql`
    SELECT
      id, organization_id, name, description, owner_platform, owner_user_id,
      is_workspace_agent, created_at, updated_at
    FROM agents
    WHERE organization_id = ${organizationId} AND id = ${agentId}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    agentId: row.id,
    name: row.name,
    description: row.description ?? undefined,
    owner:
      row.owner_platform || row.owner_user_id
        ? { platform: row.owner_platform, userId: row.owner_user_id }
        : undefined,
    organizationId: row.organization_id,
    isWorkspaceAgent: row.is_workspace_agent,
    createdAt: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
    updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : Date.now(),
  };
}

async function readAgentSettingsFromDb(agentId: string): Promise<any | null> {
  const organizationId = authStash.organizationId;
  if (!organizationId) return null;
  if (!process.env.DATABASE_URL) return null;
  const { getDb } = await import('../../../db/client.js');
  const sql = getDb();
  const rows = await sql`
    SELECT mcp_servers, pre_approved_tools
    FROM agents
    WHERE organization_id = ${organizationId} AND id = ${agentId}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    mcpServers: row.mcp_servers ?? {},
    preApprovedTools: row.pre_approved_tools ?? [],
  };
}

async function readConnectionFromDb(connectionId: string): Promise<any | null> {
  const organizationId = authStash.organizationId;
  if (!organizationId) return null;
  if (!process.env.DATABASE_URL) return null;
  const { getDb } = await import('../../../db/client.js');
  const sql = getDb();
  const rows = await sql`
    SELECT
      id, organization_id, agent_id, platform, config, settings, metadata,
      status, error_message, created_at, updated_at
    FROM agent_connections
    WHERE organization_id = ${organizationId} AND id = ${connectionId}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    organizationId: row.organization_id,
    agentId: row.agent_id,
    platform: row.platform,
    config: row.config ?? {},
    settings: row.settings ?? {},
    metadata: row.metadata ?? {},
    status: row.status ?? 'active',
    errorMessage: row.error_message ?? null,
    createdAt: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
    updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : Date.now(),
  };
}

let installed = false;

/**
 * Idempotent: the module mocks are installed once per process, bound to the
 * shared stashes above. Call at the top of every test file that imports
 * `../agent-routes.js` (directly or transitively), BEFORE that import runs.
 */
export function installRouteTestMocks(): void {
  if (installed) return;
  installed = true;

  // Resolves to src/auth/middleware — the specifier agent-routes.ts imports
  // as `../auth/middleware`.
  mock.module('../../../auth/middleware', () => ({
    mcpAuth: async (c: any, next: any) => {
      authStash.mcpAuthCalls += 1;
      if (authStash.rejectMcpAuth) {
        return c.json({ error: 'mcpAuth should not have handled this route' }, 418);
      }
      c.set('user', authStash.user);
      c.set('organizationId', authStash.organizationId);
      c.set('authSource', authStash.authSource);
      c.set('mcpAuthInfo', authStash.mcpAuthInfo);
      c.set('memberRole', authStash.memberRole);
      return next();
    },
    // requireAuth is referenced elsewhere in the module — provide a
    // passthrough so importing files that destructure it still get a function.
    requireAuth: async (_c: any, next: any) => next(),
  }));

  // Resolves to src/lobu/gateway — imported by agent-routes.ts as `./gateway`.
  mock.module('../../gateway', () => ({
    getChatInstanceManager: () => chatManagerStash.manager,
    getLobuCoreServices: () => coreServicesStash.services,
    initLobuGateway: async () => null,
    stopLobuGateway: async () => {},
    isLobuGatewayRunning: () => false,
    ensureEmbeddedGatewaySecrets: () => {},
  }));

  // Resolves to src/lobu/stores/postgres-stores — imported by
  // agent-routes.ts as `./stores/postgres-stores`. Keep route tests on one
  // shared fake store so whichever test file imports agent-routes first does
  // not strand later files behind a private set of maps.
  mock.module('../../stores/postgres-stores', () => ({
    AGENT_ID_PATTERN: /^[a-z][a-z0-9-]{2,59}$/,
    isValidAgentId: (agentId: string) => /^[a-z][a-z0-9-]{2,59}$/.test(agentId),
    agentExistsInOrganization: async (_organizationId: string, agentId: string) =>
      fakeRouteAgents.has(agentId),
    touchAgentLastUsed: async () => {},
    createPostgresAgentConfigStore: () => ({
      getMetadata: async (agentId: string) =>
        fakeRouteAgents.get(agentId) ?? (await readAgentMetadataFromDb(agentId)),
      saveMetadata: async (agentId: string, metadata: any) => {
        fakeRouteAgents.set(agentId, metadata);
        const { getDb } = await import('../../../db/client.js');
        const sql = getDb();
        await sql`
          INSERT INTO agents (
            id, organization_id, name, description, owner_platform, owner_user_id,
            is_workspace_agent, created_at, updated_at
          )
          VALUES (
            ${agentId},
            ${metadata.organizationId},
            ${metadata.name ?? 'Agent'},
            ${metadata.description ?? null},
            ${metadata.owner?.platform ?? null},
            ${metadata.owner?.userId ?? null},
            ${metadata.isWorkspaceAgent ?? false},
            NOW(),
            NOW()
          )
          ON CONFLICT (organization_id, id) DO UPDATE SET
            name = EXCLUDED.name,
            description = EXCLUDED.description,
            owner_platform = EXCLUDED.owner_platform,
            owner_user_id = EXCLUDED.owner_user_id,
            is_workspace_agent = EXCLUDED.is_workspace_agent,
            updated_at = NOW()
        `;
      },
      listAgents: async () => [...fakeRouteAgents.values()],
      hasAgent: async (agentId: string) =>
        fakeRouteAgents.has(agentId) || (await readAgentMetadataFromDb(agentId)) !== null,
      getSettings: async (agentId: string) =>
        fakeRouteSettings.get(agentId) ?? (await readAgentSettingsFromDb(agentId)),
      saveSettings: async (agentId: string, settings: any) => {
        fakeRouteSettings.set(agentId, settings);
        const { getDb } = await import('../../../db/client.js');
        const sql = getDb();
        await sql`
          UPDATE agents
          SET
            mcp_servers = COALESCE(${sql.json(settings.mcpServers ?? null)}::jsonb, mcp_servers),
            pre_approved_tools = COALESCE(${sql.json(settings.preApprovedTools ?? null)}::jsonb, pre_approved_tools),
            updated_at = NOW()
          WHERE organization_id = ${authStash.organizationId} AND id = ${agentId}
        `;
      },
      updateSettings: async (agentId: string, updates: any) => {
        const current = fakeRouteSettings.get(agentId) ?? {};
        const next = { ...current, ...updates };
        fakeRouteSettings.set(agentId, next);
      },
      updateMetadata: async (agentId: string, updates: any) => {
        const current = fakeRouteAgents.get(agentId);
        if (current) fakeRouteAgents.set(agentId, { ...current, ...updates });
      },
      deleteMetadata: async (agentId: string) => {
        fakeRouteAgents.delete(agentId);
      },
    }),
    createPostgresAgentConnectionStore: () => ({
      getConnection: async (connectionId: string) => {
        const connection =
          fakeRouteConnections.get(connectionId) ?? (await readConnectionFromDb(connectionId));
        if (!connection) return null;
        return connection.organizationId === authStash.organizationId ? connection : null;
      },
      listConnections: async (filter?: { agentId?: string; platform?: string }) =>
        [...fakeRouteConnections.values()].filter((connection) => {
          if (connection.organizationId !== authStash.organizationId) return false;
          if (filter?.agentId && connection.agentId !== filter.agentId) return false;
          if (filter?.platform && connection.platform !== filter.platform) return false;
          return true;
        }),
      saveConnection: async (connection: any) => {
        if (routeStoreStash.failSaveConnection) throw new Error('save failed');
        const normalizedConnection = {
          ...connection,
          organizationId: connection.organizationId ?? authStash.organizationId,
        };
        fakeRouteConnections.set(connection.id, normalizedConnection);
        try {
          const { getDb } = await import('../../../db/client.js');
          const sql = getDb();
          await sql`
            INSERT INTO agent_connections (
              id, organization_id, agent_id, platform, config, settings, metadata,
              status, error_message, created_at, updated_at
            )
            VALUES (
              ${normalizedConnection.id},
              ${normalizedConnection.organizationId},
              ${normalizedConnection.agentId},
              ${normalizedConnection.platform},
              ${sql.json(normalizedConnection.config ?? {})},
              ${sql.json(normalizedConnection.settings ?? {})},
              ${sql.json(normalizedConnection.metadata ?? {})},
              ${normalizedConnection.status ?? 'active'},
              ${normalizedConnection.errorMessage ?? null},
              NOW(),
              NOW()
            )
            ON CONFLICT (id) DO UPDATE SET
              platform = EXCLUDED.platform,
              config = EXCLUDED.config,
              settings = EXCLUDED.settings,
              metadata = EXCLUDED.metadata,
              status = EXCLUDED.status,
              error_message = EXCLUDED.error_message,
              updated_at = NOW()
          `;
        } catch {
          // Some route tests intentionally use fake agents that do not exist in
          // the SQL fixture. Keep the fake store authoritative for those tests.
        }
      },
      updateConnection: async (connectionId: string, updates: Record<string, unknown>) => {
        const existing = fakeRouteConnections.get(connectionId);
        if (existing) fakeRouteConnections.set(connectionId, { ...existing, ...updates });
      },
      deleteConnection: async (connectionId: string) => {
        fakeRouteConnections.delete(connectionId);
      },
    }),
  }));
}
