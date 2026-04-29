/**
 * Org CRUD for the embedded Lobu gateway.
 *
 * Mounted at /api/orgs (top-level, NOT under /api/:orgSlug). Authenticated
 * via requireAuth (session/cookie); each handler resolves the user's
 * membership manually because there's no active-org context yet.
 *
 * Used by:
 *   - `lobu org list|create|delete|show` CLI verbs
 *   - `lobu seed --org <slug>` to create-if-missing before importing
 *
 * Org auto-provisioning (a personal org per user on signup) lives in
 * auth/personal-org-provisioning.ts and continues to handle that path.
 * These routes are for explicit user-driven org management.
 */

import { Hono } from 'hono';
import { requireAuth } from '../auth/middleware';
import { generateSecureToken } from '../auth/oauth/utils';
import { RESERVED_SLUGS, slugify } from '../auth/personal-org-provisioning';
import { getDb } from '../db/client';
import type { Env } from '../index';

const routes = new Hono<{ Bindings: Env }>();

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,47}$/;

function validateSlug(input: string): string | null {
  if (!SLUG_PATTERN.test(input)) {
    return 'slug must match [a-z0-9][a-z0-9-]{1,47}';
  }
  if (RESERVED_SLUGS.has(input)) {
    return `slug "${input}" is reserved`;
  }
  return null;
}

// ── List orgs the authenticated user belongs to ──────────────────────────────

routes.get('/', requireAuth, async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const sql = getDb();
  const rows = await sql`
    SELECT o.id, o.slug, o.name, o.description, o.visibility,
           o."createdAt" as created_at, m.role
    FROM "organization" o
    JOIN "member" m ON m."organizationId" = o.id
    WHERE m."userId" = ${user.id}
    ORDER BY o."createdAt" DESC
  `;

  return c.json({
    orgs: rows.map((r: any) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      description: r.description,
      visibility: r.visibility,
      role: r.role,
      createdAt:
        r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
    })),
  });
});

// ── Get one org ──────────────────────────────────────────────────────────────

routes.get('/:slug', requireAuth, async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const { slug } = c.req.param();
  const sql = getDb();
  const rows = await sql`
    SELECT o.id, o.slug, o.name, o.description, o.visibility,
           o."createdAt" as created_at, m.role
    FROM "organization" o
    JOIN "member" m ON m."organizationId" = o.id
    WHERE o.slug = ${slug} AND m."userId" = ${user.id}
    LIMIT 1
  `;
  if (rows.length === 0) return c.json({ error: 'Org not found' }, 404);

  const r = rows[0] as any;
  return c.json({
    org: {
      id: r.id,
      slug: r.slug,
      name: r.name,
      description: r.description,
      visibility: r.visibility,
      role: r.role,
      createdAt:
        r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
    },
  });
});

// ── Create org ───────────────────────────────────────────────────────────────

routes.post('/', requireAuth, async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const body = await c.req.json<{
    slug?: string;
    name?: string;
    description?: string;
    visibility?: 'public' | 'private';
  }>();

  const desiredSlug = body.slug?.trim() || (body.name ? slugify(body.name) : null);
  if (!desiredSlug) {
    return c.json({ error: 'slug or name is required' }, 400);
  }
  const validationError = validateSlug(desiredSlug);
  if (validationError) {
    return c.json({ error: validationError }, 400);
  }

  const sql = getDb();
  const collision = await sql`
    SELECT 1 FROM "organization" WHERE slug = ${desiredSlug} LIMIT 1
  `;
  if (collision.length > 0) {
    return c.json({ error: `slug "${desiredSlug}" already taken` }, 409);
  }

  const orgId = `org_${generateSecureToken(8)}`;
  const memberId = `member_${generateSecureToken(8)}`;
  const orgName = body.name?.trim() || desiredSlug;
  const visibility = body.visibility ?? 'private';

  await sql.begin(async (tx: any) => {
    await tx`
      INSERT INTO "organization" (id, name, slug, description, visibility, "createdAt")
      VALUES (${orgId}, ${orgName}, ${desiredSlug}, ${body.description ?? null}, ${visibility}, NOW())
    `;
    await tx`
      INSERT INTO "member" (id, "userId", "organizationId", role, "createdAt")
      VALUES (${memberId}, ${user.id}, ${orgId}, 'owner', NOW())
    `;
  });

  return c.json(
    {
      org: {
        id: orgId,
        slug: desiredSlug,
        name: orgName,
        description: body.description ?? null,
        visibility,
        role: 'owner',
      },
    },
    201
  );
});

// ── Delete org ───────────────────────────────────────────────────────────────

routes.delete('/:slug', requireAuth, async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const { slug } = c.req.param();
  const sql = getDb();
  const rows = await sql`
    SELECT o.id, m.role
    FROM "organization" o
    JOIN "member" m ON m."organizationId" = o.id
    WHERE o.slug = ${slug} AND m."userId" = ${user.id}
    LIMIT 1
  `;
  if (rows.length === 0) return c.json({ error: 'Org not found' }, 404);

  const { id: orgId, role } = rows[0] as { id: string; role: string };
  if (role !== 'owner') {
    return c.json({ error: 'Only owners can delete an org' }, 403);
  }

  // FK ON DELETE CASCADE handles agents, connections, events, etc.
  await sql`DELETE FROM "organization" WHERE id = ${orgId}`;

  return c.json({ success: true });
});

export { routes as orgRoutes };
