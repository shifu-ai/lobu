/**
 * Authentication & Account Routes
 *
 * REST endpoints for account and token management:
 * - GET /api/accounts - List user's linked OAuth accounts
 * - GET /api/agents - List OAuth agents (clients) for an organization
 * - CRUD /api/tokens - Personal access token management
 */

import { type Context, Hono } from 'hono';
import { createDbClientFromEnv } from '../db/client';
import type { Env } from '../index';
import { errorMessage } from '../utils/errors';
import { requireAuth } from './middleware';
import { OAuthClientsStore } from './oauth/clients';
import { PersonalAccessTokenService } from './tokens';

const credentialRoutes = new Hono<{ Bindings: Env }>();

function getAuthenticatedUser(c: Context<{ Bindings: Env }>) {
  const user = c.get('user');
  if (!user) {
    throw new Error('Authenticated user missing from context');
  }
  return user;
}

/**
 * List user's linked OAuth accounts
 */
credentialRoutes.get('/accounts', requireAuth, async (c) => {
  const user = getAuthenticatedUser(c);
  const sql = createDbClientFromEnv(c.env);

  const result = await sql`
    SELECT
      id,
      "accountId",
      "providerId",
      "accessToken" IS NOT NULL as "hasAccessToken",
      "refreshToken" IS NOT NULL as "hasRefreshToken",
      "accessTokenExpiresAt",
      scope,
      "createdAt"
    FROM "account"
    WHERE "userId" = ${user.id}
    ORDER BY "createdAt" DESC
  `;
  return c.json({ accounts: result });
});

// ============================================
// OAuth Agents Routes
// ============================================

/**
 * List OAuth agents (clients) for an organization
 */
credentialRoutes.get('/agents', requireAuth, async (c) => {
  const user = getAuthenticatedUser(c);
  const orgSlug = c.req.query('org_slug');

  const sql = createDbClientFromEnv(c.env);

  let organizationId: string;

  if (orgSlug) {
    const membership = await sql`
      SELECT m."organizationId" as organization_id
      FROM "member" m
      JOIN "organization" o ON o.id = m."organizationId"
      WHERE m."userId" = ${user.id}
        AND o.slug = ${orgSlug}
      LIMIT 1
    `;
    if (membership.length === 0) {
      return c.json({ error: `Not a member of organization '${orgSlug}'` }, 403);
    }
    organizationId = membership[0].organization_id as string;
  } else {
    // Fall back to user's first org membership
    const defaultOrg = await sql`
      SELECT m."organizationId" as organization_id
      FROM "member" m
      WHERE m."userId" = ${user.id}
      ORDER BY m."createdAt" ASC
      LIMIT 1
    `;
    if (defaultOrg.length === 0) {
      return c.json({ error: 'No organization membership found' }, 404);
    }
    organizationId = defaultOrg[0].organization_id as string;
  }
  const clientsStore = new OAuthClientsStore(sql);
  const agents = await clientsStore.listClientsByOrganization(organizationId);

  return c.json({ agents });
});

// ============================================
// Personal Access Token Routes
// ============================================

/**
 * List user's tokens
 */
credentialRoutes.get('/tokens', requireAuth, async (c) => {
  const user = getAuthenticatedUser(c);
  const sql = createDbClientFromEnv(c.env);
  const patService = new PersonalAccessTokenService(sql);

  const tokens = await patService.list(user.id);
  return c.json({ tokens });
});

/**
 * Create new token
 */
credentialRoutes.post('/tokens', requireAuth, async (c) => {
  const user = getAuthenticatedUser(c);
  const body = await c.req.json<{
    name: string;
    org_slug: string;
    description?: string;
    scope?: string;
    expiresInDays?: number;
  }>();

  if (!body.name) {
    return c.json({ error: 'name is required' }, 400);
  }
  if (!body.org_slug) {
    return c.json({ error: 'org_slug is required' }, 400);
  }

  const sql = createDbClientFromEnv(c.env);
  const patService = new PersonalAccessTokenService(sql);

  try {
    const membership = await sql`
      SELECT m."organizationId" as organization_id
      FROM "member" m
      JOIN "organization" o ON o.id = m."organizationId"
      WHERE m."userId" = ${user.id}
        AND o.slug = ${body.org_slug}
      LIMIT 1
    `;

    if (membership.length === 0) {
      return c.json({ error: `Not a member of organization '${body.org_slug}'` }, 403);
    }

    const organizationId = membership[0].organization_id as string;

    const token = await patService.create(user.id, organizationId, body.name, {
      description: body.description,
      scope: body.scope,
      expiresInDays: body.expiresInDays,
    });
    return c.json({ token }, 201);
  } catch (error) {
    return c.json({ error: errorMessage(error) }, 400);
  }
});

/**
 * Get a specific token
 */
credentialRoutes.get('/tokens/:id', requireAuth, async (c) => {
  const user = getAuthenticatedUser(c);
  const tokenId = parseInt(c.req.param('id') ?? '', 10);
  if (Number.isNaN(tokenId)) {
    return c.json({ error: 'Invalid token ID' }, 400);
  }

  const sql = createDbClientFromEnv(c.env);
  const patService = new PersonalAccessTokenService(sql);

  const token = await patService.get(tokenId, user.id);
  if (!token) {
    return c.json({ error: 'Token not found' }, 404);
  }

  return c.json({ token });
});

/**
 * Update token metadata
 */
credentialRoutes.patch('/tokens/:id', requireAuth, async (c) => {
  const user = getAuthenticatedUser(c);
  const tokenId = parseInt(c.req.param('id') ?? '', 10);
  if (Number.isNaN(tokenId)) {
    return c.json({ error: 'Invalid token ID' }, 400);
  }
  const body = await c.req.json<{
    name?: string;
    description?: string;
  }>();

  const sql = createDbClientFromEnv(c.env);
  const patService = new PersonalAccessTokenService(sql);

  try {
    const success = await patService.update(tokenId, user.id, body);
    if (!success) {
      return c.json({ error: 'Token not found or no changes made' }, 404);
    }

    const token = await patService.get(tokenId, user.id);
    return c.json({ token });
  } catch (error) {
    return c.json({ error: errorMessage(error) }, 400);
  }
});

/**
 * Revoke token
 */
credentialRoutes.delete('/tokens/:id', requireAuth, async (c) => {
  const user = getAuthenticatedUser(c);
  const tokenId = parseInt(c.req.param('id') ?? '', 10);
  if (Number.isNaN(tokenId)) {
    return c.json({ error: 'Invalid token ID' }, 400);
  }

  const sql = createDbClientFromEnv(c.env);
  const patService = new PersonalAccessTokenService(sql);

  const success = await patService.revoke(tokenId, user.id);
  if (!success) {
    return c.json({ error: 'Token not found' }, 404);
  }

  return c.json({ success: true });
});

/**
 * Revoke all tokens
 */
credentialRoutes.delete('/tokens', requireAuth, async (c) => {
  const user = getAuthenticatedUser(c);

  const sql = createDbClientFromEnv(c.env);
  const patService = new PersonalAccessTokenService(sql);

  const count = await patService.revokeAll(user.id);
  return c.json({ success: true, revoked_count: count });
});

export { credentialRoutes };
