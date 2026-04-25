import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installManifestRoutes } from '../../../agents/install-manifest-routes';
import type { Env } from '../../../index';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestAgent, createTestOrganization } from '../../setup/test-fixtures';

const ORIGINAL_PHONE = process.env.PERSONAL_FINANCE_BOT_PHONE;

describe('GET /api/install/manifest/:slug', () => {
  let templateOrg: Awaited<ReturnType<typeof createTestOrganization>>;
  let templateAgent: Awaited<ReturnType<typeof createTestAgent>>;
  let app: Hono<{ Bindings: Env }>;

  beforeAll(async () => {
    await cleanupTestDatabase();

    templateOrg = await createTestOrganization({
      name: 'Personal Finance',
      slug: 'personal-finance',
    });
    templateAgent = await createTestAgent({
      organizationId: templateOrg.id,
      name: 'Personal Finance',
    });

    app = new Hono<{ Bindings: Env }>();
    app.route('/api', installManifestRoutes);
  });

  afterAll(() => {
    if (ORIGINAL_PHONE === undefined) delete process.env.PERSONAL_FINANCE_BOT_PHONE;
    else process.env.PERSONAL_FINANCE_BOT_PHONE = ORIGINAL_PHONE;
  });

  it('resolves slug → template agent, returns name + description + templateAgentId', async () => {
    const res = await app.request('/api/install/manifest/personal-finance');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      slug: string;
      name: string;
      templateAgentId: string;
      botPhone: string | null;
    };
    expect(body.slug).toBe('personal-finance');
    expect(body.name).toBe('Personal Finance');
    expect(body.templateAgentId).toBe(templateAgent.agentId);
  });

  it('returns botPhone as bare digits when env var is set', async () => {
    process.env.PERSONAL_FINANCE_BOT_PHONE = '+447123456789';
    const res = await app.request('/api/install/manifest/personal-finance');
    const body = (await res.json()) as { botPhone: string | null };
    expect(body.botPhone).toBe('447123456789');
  });

  it('returns botPhone: null when env var is unset', async () => {
    delete process.env.PERSONAL_FINANCE_BOT_PHONE;
    const res = await app.request('/api/install/manifest/personal-finance');
    const body = (await res.json()) as { botPhone: string | null };
    expect(body.botPhone).toBeNull();
  });

  it('returns 404 for an unknown slug', async () => {
    const res = await app.request('/api/install/manifest/no-such-template');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('not_found');
  });

  it('does not return a template-agent when only instance agents exist', async () => {
    const sql = getTestDb();
    const orphanOrg = await createTestOrganization({
      name: 'Orphan',
      slug: 'orphan-org',
    });
    // An agent that points at another template — i.e. it's an INSTANCE, not a template.
    const instanceId = `agent_${Math.random().toString(36).slice(2, 10).toLowerCase()}`;
    await sql`
      INSERT INTO agents (id, organization_id, name, owner_platform, template_agent_id, is_workspace_agent, created_at, updated_at)
      VALUES (${instanceId}, ${orphanOrg.id}, 'Instance', 'owletto', ${templateAgent.agentId}, false, NOW(), NOW())
    `;
    const res = await app.request('/api/install/manifest/orphan-org');
    expect(res.status).toBe(404);
  });
});
