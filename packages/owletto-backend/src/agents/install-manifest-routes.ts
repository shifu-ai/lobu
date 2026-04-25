/**
 * Public install-discovery endpoint.
 *
 *   GET /api/install/manifest/:slug
 *     → { slug, name, description, botPhone, templateAgentId }
 *
 * Lets a public landing page render itself + build a `wa.me/<botPhone>`
 * link without baking the agent ID or bot phone into a Vite build. The
 * frontend only ever knows the URL slug; everything else is server-resolved.
 *
 * Resolution rules:
 *   - The URL slug equals the template org's slug. We currently maintain
 *     one canonical template agent per template org (`agents.template_agent_id
 *     IS NULL` row in that org).
 *   - The bot's E.164 phone number (without `+`) is operator config. v1
 *     reads it from a per-slug env var (e.g.
 *     PERSONAL_FINANCE_BOT_PHONE=447123456789). When unset the manifest
 *     reports `botPhone: null` and the landing page falls back to a
 *     "message the bot to start" instruction.
 *
 * No auth — manifests are public marketing data.
 */

import { Hono } from 'hono';
import { getDb } from '../db/client';
import type { Env } from '../index';

const installManifestRoutes = new Hono<{ Bindings: Env }>();

interface ManifestRow {
  id: string;
  name: string;
  description: string | null;
}

async function loadCanonicalTemplate(slug: string): Promise<ManifestRow | null> {
  const sql = getDb();
  const rows = await sql`
    SELECT a.id, a.name, a.description
    FROM agents a
    JOIN "organization" o ON o.id = a.organization_id
    WHERE o.slug = ${slug}
      AND a.template_agent_id IS NULL
    ORDER BY a.created_at ASC
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  return rows[0] as ManifestRow;
}

function botPhoneForSlug(slug: string): string | null {
  // Map URL slug → server env var. Adding a new productized template means
  // adding one row here + setting the env. Avoids any frontend rebuild.
  const envByName: Record<string, string | undefined> = {
    'personal-finance': process.env.PERSONAL_FINANCE_BOT_PHONE,
  };
  const raw = envByName[slug];
  if (!raw) return null;
  // Accept "+447..." or "447..." in the env; surface to the wire as bare digits
  // so the landing page can plug it straight into wa.me/<phone>.
  return raw.replace(/^\+/, '').replace(/[^0-9]/g, '') || null;
}

installManifestRoutes.get('/install/manifest/:slug', async (c) => {
  const slug = c.req.param('slug');
  if (!slug) return c.json({ error: 'slug required' }, 400);

  const template = await loadCanonicalTemplate(slug);
  if (!template) {
    return c.json({ error: 'not_found', message: `No installable template at /${slug}` }, 404);
  }

  return c.json({
    slug,
    name: template.name,
    description: template.description,
    botPhone: botPhoneForSlug(slug),
    templateAgentId: template.id,
  });
});

export { installManifestRoutes };
