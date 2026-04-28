/**
 * Manage Feeds Lifecycle Integration Tests
 *
 * Verifies feed CRUD/trigger behavior via the REST proxy at
 * `POST /api/{orgSlug}/manage_feeds`. The MCP `manage_feeds` tool was demoted
 * to `internal: true` in PR #432, so it's no longer reachable via MCP
 * `tools/call`; the REST proxy is now the canonical surface for these
 * actions and is what owletto-cli + owletto-web both call.
 *
 * MCP `tools/list` visibility for the demoted `manage_*` family is asserted
 * in `integration/mcp/auth.test.ts > tools/list Response` — this file is
 * exclusively about feed-action behavior.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestConnection,
  createTestConnectorDefinition,
  createTestEntity,
  createTestOAuthClient,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';
import { post } from '../../setup/test-helpers';

/**
 * Call `manage_feeds` over the REST proxy and parse the JSON body. Mirrors
 * how owletto-cli's `restToolCall` invokes it (POST raw JSON, Authorization
 * Bearer token, no MCP envelope).
 */
async function callManageFeeds<T = any>(
  orgSlug: string,
  args: Record<string, unknown>,
  token: string
): Promise<T> {
  const response = await post(`/api/${orgSlug}/manage_feeds`, {
    body: args,
    token,
  });
  const body = (await response.json()) as T;
  if (response.status >= 400) {
    // Surface the full response so test failures show what the server rejected
    // instead of a downstream "Cannot read property X of undefined".
    throw new Error(
      `manage_feeds REST call failed (${response.status}): ${JSON.stringify(body)}`
    );
  }
  return body;
}

describe('Manage Feeds - Feed Actions (REST proxy)', () => {
  let tokenA: string;
  let tokenB: string;
  let orgA: Awaited<ReturnType<typeof createTestOrganization>>;
  let orgB: Awaited<ReturnType<typeof createTestOrganization>>;
  let connectionA: Awaited<ReturnType<typeof createTestConnection>>;
  let connectionB: Awaited<ReturnType<typeof createTestConnection>>;
  let entityA: Awaited<ReturnType<typeof createTestEntity>>;

  beforeAll(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    orgA = await createTestOrganization({ name: 'Feeds Org A' });
    orgB = await createTestOrganization({ name: 'Feeds Org B' });

    const userA = await createTestUser({ email: 'feeds-org-a@test.com' });
    const userB = await createTestUser({ email: 'feeds-org-b@test.com' });

    await addUserToOrganization(userA.id, orgA.id, 'owner');
    await addUserToOrganization(userB.id, orgB.id, 'owner');

    const client = await createTestOAuthClient();
    // manage_feeds requires admin scope; default scopes are read/write only.
    tokenA = (
      await createTestAccessToken(userA.id, orgA.id, client.client_id, {
        scope: 'mcp:read mcp:write mcp:admin',
      })
    ).token;
    tokenB = (
      await createTestAccessToken(userB.id, orgB.id, client.client_id, {
        scope: 'mcp:read mcp:write mcp:admin',
      })
    ).token;

    await createTestConnectorDefinition({
      key: 'test.feed.connector',
      name: 'Test Feed Connector',
      version: '1.0.0',
      feeds_schema: {
        threads: { description: 'Thread feed' },
        mentions: { description: 'Mentions feed' },
      },
      organization_id: orgA.id,
    });

    entityA = await createTestEntity({ name: 'Feed Entity A', organization_id: orgA.id });
    const entityB = await createTestEntity({ name: 'Feed Entity B', organization_id: orgB.id });

    connectionA = await createTestConnection({
      organization_id: orgA.id,
      connector_key: 'test.feed.connector',
      entity_ids: [entityA.id],
      status: 'active',
    });

    connectionB = await createTestConnection({
      organization_id: orgB.id,
      connector_key: 'test.feed.connector',
      entity_ids: [entityB.id],
      status: 'active',
    });
  });

  it('supports create/list/update/get/trigger feed lifecycle', async () => {
    const created = await callManageFeeds<any>(
      orgA.slug,
      {
        action: 'create_feed',
        connection_id: connectionA.id,
        feed_key: 'threads',
        entity_ids: [entityA.id],
        config: { language: 'en' },
      },
      tokenA
    );

    expect(created.action).toBe('create_feed');
    expect(created.feed).toBeDefined();
    expect(created.feed.feed_key).toBe('threads');
    expect(Number(created.feed.connection_id)).toBe(connectionA.id);

    const feedId = Number(created.feed.id);

    const listed = await callManageFeeds<any>(
      orgA.slug,
      {
        action: 'list_feeds',
        connection_id: connectionA.id,
      },
      tokenA
    );

    expect(listed.action).toBe('list_feeds');
    expect(Array.isArray(listed.feeds)).toBe(true);
    expect(listed.feeds.some((f: any) => Number(f.id) === feedId)).toBe(true);

    const updated = await callManageFeeds<any>(
      orgA.slug,
      {
        action: 'update_feed',
        feed_id: feedId,
        status: 'active',
        schedule: '* * * * *',
        config: { language: 'tr' },
      },
      tokenA
    );

    expect(updated.action).toBe('update_feed');
    expect(updated.feed.schedule).toBe('* * * * *');
    expect(updated.feed.config).toBeDefined();

    const triggered = await callManageFeeds<any>(
      orgA.slug,
      {
        action: 'trigger_feed',
        feed_id: feedId,
      },
      tokenA
    );

    expect(triggered.action).toBe('trigger_feed');
    expect(triggered.triggered).toBe(true);
    expect(Number(triggered.feed_id)).toBe(feedId);
    expect(typeof triggered.run_id).toBe('number');

    const duplicateTrigger = await callManageFeeds<any>(
      orgA.slug,
      {
        action: 'trigger_feed',
        feed_id: feedId,
      },
      tokenA
    );

    expect(duplicateTrigger.action).toBe('trigger_feed');
    expect(duplicateTrigger.message).toContain('already pending or running');

    const fetched = await callManageFeeds<any>(
      orgA.slug,
      {
        action: 'get_feed',
        feed_id: feedId,
      },
      tokenA
    );

    expect(fetched.action).toBe('get_feed');
    expect(Number(fetched.feed.id)).toBe(feedId);
    expect(Array.isArray(fetched.recent_runs)).toBe(true);
    expect(fetched.recent_runs.length).toBeGreaterThanOrEqual(1);
  });

  it('enforces organization scoping for feed actions', async () => {
    const createdA = await callManageFeeds<any>(
      orgA.slug,
      {
        action: 'create_feed',
        connection_id: connectionA.id,
        feed_key: 'mentions',
      },
      tokenA
    );

    const createdB = await callManageFeeds<any>(
      orgB.slug,
      {
        action: 'create_feed',
        connection_id: connectionB.id,
        feed_key: 'threads',
      },
      tokenB
    );

    const listA = await callManageFeeds<any>(
      orgA.slug,
      {
        action: 'list_feeds',
      },
      tokenA
    );

    const idsA = new Set(listA.feeds.map((f: any) => Number(f.id)));
    expect(idsA.has(Number(createdA.feed.id))).toBe(true);
    expect(idsA.has(Number(createdB.feed.id))).toBe(false);

    const getCrossOrg = await callManageFeeds<any>(
      orgA.slug,
      {
        action: 'get_feed',
        feed_id: Number(createdB.feed.id),
      },
      tokenA
    );
    expect(getCrossOrg.error).toBe('Feed not found');

    const triggerCrossOrg = await callManageFeeds<any>(
      orgA.slug,
      {
        action: 'trigger_feed',
        feed_id: Number(createdB.feed.id),
      },
      tokenA
    );
    expect(triggerCrossOrg.error).toBe('Feed not found');
  });

  it('prevents duplicate active sync runs under concurrent trigger_feed calls', async () => {
    const sql = getTestDb();

    const created = await callManageFeeds<any>(
      orgA.slug,
      {
        action: 'create_feed',
        connection_id: connectionA.id,
        feed_key: 'mentions',
      },
      tokenA
    );

    const feedId = Number(created.feed.id);

    const [a, b] = await Promise.all([
      callManageFeeds<any>(orgA.slug, { action: 'trigger_feed', feed_id: feedId }, tokenA),
      callManageFeeds<any>(orgA.slug, { action: 'trigger_feed', feed_id: feedId }, tokenA),
    ]);

    const triggeredCount = [a, b].filter((result) => result.triggered === true).length;
    expect(triggeredCount).toBe(1);

    const activeRuns = await sql`
      SELECT id
      FROM runs
      WHERE feed_id = ${feedId}
        AND run_type = 'sync'
        AND status IN ('pending', 'running')
    `;

    expect(activeRuns.length).toBe(1);
  });
});
