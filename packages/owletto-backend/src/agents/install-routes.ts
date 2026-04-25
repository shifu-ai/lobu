/**
 * Public install endpoints backing the /install/:slug landing pages.
 *
 * A signed-in user POSTs { templateAgentId } and we mirror that template into
 * the user's personal org (looked up via the personal_org_for_user_id tag we
 * set in the user.create.after hook). Returns the new agent id so the landing
 * page can redirect to /$org/agents/$id.
 */

import { type Context, Hono } from 'hono';
import { requireAuth } from '../auth/middleware';
import { getDb } from '../db/client';
import type { Env } from '../index';
import { errorMessage } from '../utils/errors';
import { getRateLimiter, RateLimitPresets } from '../utils/rate-limiter';
import { installAgentFromTemplate } from './install';

const installRoutes = new Hono<{ Bindings: Env }>();

function getAuthenticatedUser(c: Context<{ Bindings: Env }>) {
  const user = c.get('user');
  if (!user) throw new Error('Authenticated user missing from context');
  return user;
}

async function resolvePersonalOrg(
  userId: string
): Promise<{ id: string; slug: string } | null> {
  const sql = getDb();
  // organization.metadata is `text` storing JSON; cast to jsonb and use the
  // ->> operator instead of LIKE so a userId containing % or _ can't match
  // unintended rows.
  const rows = await sql`
    SELECT id, slug FROM "organization"
    WHERE metadata IS NOT NULL
      AND (metadata::jsonb)->>'personal_org_for_user_id' = ${userId}
    ORDER BY "createdAt" ASC, id ASC
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  return { id: rows[0].id as string, slug: rows[0].slug as string };
}

installRoutes.post('/install', requireAuth, async (c) => {
  const user = getAuthenticatedUser(c);

  const rateLimiter = getRateLimiter();
  const rateLimit = rateLimiter.checkLimit(
    `rate:install-agent:${user.id}`,
    RateLimitPresets.INSTALL_AGENT_PER_USER_HOUR
  );
  if (!rateLimit.allowed) {
    return c.json({ error: rateLimit.errorMessage }, 429);
  }

  let body: { templateAgentId?: string; name?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  if (!body.templateAgentId || typeof body.templateAgentId !== 'string') {
    return c.json({ error: 'templateAgentId is required' }, 400);
  }

  const personalOrg = await resolvePersonalOrg(user.id);
  if (!personalOrg) {
    return c.json(
      {
        error: 'no_personal_org',
        message:
          'No personal organization found for this user. Sign out and back in, or create one manually, then retry.',
      },
      409
    );
  }

  try {
    const result = await installAgentFromTemplate({
      templateAgentId: body.templateAgentId,
      targetOrganizationId: personalOrg.id,
      userId: user.id,
      name: body.name,
    });
    return c.json({
      agentId: result.agentId,
      organizationId: result.organizationId,
      organizationSlug: personalOrg.slug,
      created: result.created,
      mirrored: result.mirrored,
      redirectTo: `/${personalOrg.slug}/agents/${result.agentId}`,
    });
  } catch (error) {
    return c.json({ error: errorMessage(error) }, 400);
  }
});

export { installRoutes };
