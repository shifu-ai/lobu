import { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import { installRoutes } from '../../../agents/install-routes';
import type { Env } from '../../../index';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAgent,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

/**
 * Mounts the install routes with a stubbed `user` context (bypassing the real
 * requireAuth middleware, which needs a full Better Auth session). This
 * exercises the route handler's behavior — personal-org lookup, delegation to
 * installAgentFromTemplate, error surfacing — without reimplementing auth in
 * the test harness.
 */
function buildApp(userId: string): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    c.set('user', {
      id: userId,
      name: 'Test',
      email: 'test@example.com',
      emailVerified: true,
    });
    await next();
  });
  app.route('/api', installRoutes);
  return app;
}

describe('POST /api/install', () => {
  let templateOrg: Awaited<ReturnType<typeof createTestOrganization>>;
  let templateAgent: Awaited<ReturnType<typeof createTestAgent>>;
  let user: Awaited<ReturnType<typeof createTestUser>>;
  let personalOrg: Awaited<ReturnType<typeof createTestOrganization>>;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const sql = getTestDb();

    templateOrg = await createTestOrganization({
      name: 'PF Template',
      slug: 'personal-finance-tpl',
      visibility: 'public',
    });
    templateAgent = await createTestAgent({
      organizationId: templateOrg.id,
      name: 'Personal Finance',
    });
    await sql`
      INSERT INTO entity_types (slug, name, description, metadata_schema, organization_id, created_by)
      VALUES ('transaction', 'Transaction', 'A debit/credit', '{"type":"object"}'::jsonb, ${templateOrg.id}, 'system')
    `;

    user = await createTestUser();
    personalOrg = await createTestOrganization({
      name: 'User Personal Org',
      slug: `personal-${user.id.slice(5, 13)}`,
    });
    // Mirrors what the user.create.after hook writes — the install endpoint
    // relies on this tag to resolve the caller's personal org.
    await sql`
      UPDATE "organization"
      SET metadata = ${JSON.stringify({ personal_org_for_user_id: user.id })}
      WHERE id = ${personalOrg.id}
    `;
    await addUserToOrganization(user.id, personalOrg.id, 'owner');
  });

  it('installs the template into the caller personal org and returns redirect info', async () => {
    const app = buildApp(user.id);
    const res = await app.request('/api/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ templateAgentId: templateAgent.agentId }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      agentId: string;
      organizationId: string;
      organizationSlug: string;
      created: boolean;
      mirrored: { entity_types: number };
      redirectTo: string;
    };
    expect(body.organizationId).toBe(personalOrg.id);
    expect(body.organizationSlug).toBe(personalOrg.slug);
    expect(body.created).toBe(true);
    expect(body.mirrored.entity_types).toBe(1);
    expect(body.redirectTo).toBe(`/${personalOrg.slug}/agents/${body.agentId}`);
  });

  it('rejects private template agents', async () => {
    const privateOrg = await createTestOrganization({ name: 'Private Template' });
    const privateAgent = await createTestAgent({
      organizationId: privateOrg.id,
      name: 'Private Agent',
    });
    const app = buildApp(user.id);
    const res = await app.request('/api/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ templateAgentId: privateAgent.agentId }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/organization is not public/);
  });

  it('rejects requests without templateAgentId', async () => {
    const app = buildApp(user.id);
    const res = await app.request('/api/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('returns 409 when the caller has no personal org', async () => {
    const sql = getTestDb();
    const userWithoutOrg = await createTestUser();
    // Intentionally no personal org provisioned for this user.
    const app = buildApp(userWithoutOrg.id);
    const res = await app.request('/api/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ templateAgentId: templateAgent.agentId }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('no_personal_org');

    // Don't leak the orphan user into subsequent tests.
    await sql`DELETE FROM "user" WHERE id = ${userWithoutOrg.id}`;
  });
});
