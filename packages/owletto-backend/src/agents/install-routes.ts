/**
 * Public install endpoints backing the /install/:slug landing pages.
 *
 * A signed-in user POSTs { slug, whatsapp_phone? } (or the equivalent
 * { templateAgentId } form) and we:
 *   1. Look up their personal org (created by the user.create.after hook).
 *   2. Resolve the slug to its canonical template agent (or accept an
 *      explicit templateAgentId from internal callers).
 *   3. Mirror the template's schema into that org via installAgentFromTemplate.
 *   4. Optionally write a WhatsApp identity (`wa_jid` + `phone`) on their
 *      $member entity so the gateway can later route inbound WhatsApp
 *      messages from that number back to this user's org.
 *
 * Returns the new agent id, the target org slug, and a redirectTo path.
 */

import { type Context, Hono } from 'hono';
import { requireAuth } from '../auth/middleware';
import { linkWhatsAppToMember } from '../auth/subject-identities';
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

async function resolveTemplateAgentBySlug(slug: string): Promise<string | null> {
  const sql = getDb();
  const rows = await sql`
    SELECT a.id
    FROM agents a
    JOIN "organization" o ON o.id = a.organization_id
    WHERE o.slug = ${slug}
      AND a.template_agent_id IS NULL
    ORDER BY a.created_at ASC
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  return rows[0].id as string;
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

  let body: {
    slug?: string;
    templateAgentId?: string;
    name?: string;
    whatsapp_phone?: string;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  let templateAgentId: string;
  if (typeof body.slug === 'string' && body.slug.trim()) {
    const resolved = await resolveTemplateAgentBySlug(body.slug.trim());
    if (!resolved) {
      return c.json(
        { error: 'unknown_slug', message: `No installable template at /${body.slug}` },
        404
      );
    }
    templateAgentId = resolved;
  } else if (typeof body.templateAgentId === 'string' && body.templateAgentId.trim()) {
    templateAgentId = body.templateAgentId.trim();
  } else {
    return c.json({ error: '`slug` or `templateAgentId` is required' }, 400);
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

  let installResult: Awaited<ReturnType<typeof installAgentFromTemplate>>;
  try {
    installResult = await installAgentFromTemplate({
      templateAgentId,
      targetOrganizationId: personalOrg.id,
      userId: user.id,
      name: body.name,
    });
  } catch (error) {
    return c.json({ error: errorMessage(error) }, 400);
  }

  // Optional: link the user's WhatsApp number to their $member so inbound
  // WA messages can be routed back here. Failure is non-fatal — agent is
  // already installed; user can re-link later.
  let whatsapp: { phone: string; waJid: string } | undefined;
  let whatsappError: 'invalid_phone' | 'no_member' | undefined;
  if (body.whatsapp_phone && typeof body.whatsapp_phone === 'string') {
    const result = await linkWhatsAppToMember({
      organizationId: personalOrg.id,
      email: user.email,
      rawPhone: body.whatsapp_phone,
    });
    if ('error' in result) {
      whatsappError = result.error;
    } else {
      whatsapp = result;
    }
  }

  return c.json({
    agentId: installResult.agentId,
    organizationId: installResult.organizationId,
    organizationSlug: personalOrg.slug,
    created: installResult.created,
    mirrored: installResult.mirrored,
    redirectTo: `/${personalOrg.slug}/agents/${installResult.agentId}`,
    ...(whatsapp ? { whatsapp } : {}),
    ...(whatsappError ? { whatsappError } : {}),
  });
});

export { installRoutes };
