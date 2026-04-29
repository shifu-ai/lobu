/**
 * Integration test: connection-visibility folding in `getContent`.
 *
 * Stream B of the atlas-events-fix plan dropped the two-step "first query
 * private connections, then query visible connections" round trip. Visibility
 * now lives inline in the list/count WHERE clause of every query branch
 * (`chronological list`, `content_ids`, `include_superseded`, `score`) via
 * `buildConnectionVisibilityClause`. This file pins the semantics:
 *
 *   - Authed user sees connections with visibility='org' OR created_by=userId.
 *   - Unauthed sees only visibility='org'.
 *   - Soft-deleted connections (deleted_at IS NOT NULL) are hidden in both
 *     cases, even when they're the user's own.
 *   - Events with connection_id IS NULL (system / non-connection events) are
 *     visible to authed and unauthed callers.
 *   - Pagination count matches list cardinality.
 *   - The four query branches (chronological list, `content_ids`,
 *     `include_superseded`, `sort_by=score`) all enforce the same predicate.
 *   - `view_url` is populated for entity-scoped requests so LLM agents
 *     reading the response over MCP can include it in chat replies.
 *   - `classification_stats` only appears when the caller explicitly passes
 *     `include_classification: 'summary'`.
 *
 * NOTE: vitest is not yet wired into CI for this package. Stream C will fix
 * that. Until then, these tests run locally against the dev Postgres.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { getContent } from '../../../tools/get_content';
import type { ToolContext } from '../../../tools/registry';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestConnection,
  createTestConnectorDefinition,
  createTestEntity,
  createTestEvent,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

describe('getContent > connection visibility folded into WHERE', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let aliceUser: Awaited<ReturnType<typeof createTestUser>>;
  let bobUser: Awaited<ReturnType<typeof createTestUser>>;
  let entity: Awaited<ReturnType<typeof createTestEntity>>;

  let orgConnId: number;
  let alicePrivateConnId: number;
  let bobPrivateConnId: number;
  let deletedAlicePrivateConnId: number;

  let orgEventId: number;
  let alicePrivateEventId: number;
  let bobPrivateEventId: number;
  let deletedAlicePrivateEventId: number;
  let systemEventId: number;

  function authedCtx(userId: string): ToolContext {
    return {
      organizationId: org.id,
      userId,
      memberRole: 'owner',
      isAuthenticated: true,
      tokenType: 'oauth',
      scopedToOrg: false,
      allowCrossOrg: true,
      scopes: ['mcp:read'],
    };
  }

  function unauthedCtx(): ToolContext {
    return {
      organizationId: org.id,
      userId: null,
      memberRole: null,
      isAuthenticated: false,
      tokenType: 'anonymous',
      scopedToOrg: true,
      allowCrossOrg: false,
    };
  }

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    org = await createTestOrganization({ name: 'Visibility Org' });
    aliceUser = await createTestUser({ email: 'alice-vis@example.com' });
    bobUser = await createTestUser({ email: 'bob-vis@example.com' });
    await addUserToOrganization(aliceUser.id, org.id, 'owner');
    await addUserToOrganization(bobUser.id, org.id, 'owner');

    entity = await createTestEntity({
      name: 'Visibility Entity',
      organization_id: org.id,
    });

    await createTestConnectorDefinition({
      key: 'vis-test-connector',
      name: 'Vis Test',
      organization_id: org.id,
    });

    // Org-visible connection — anyone in the org may read its events.
    const orgConn = await createTestConnection({
      organization_id: org.id,
      connector_key: 'vis-test-connector',
      entity_ids: [entity.id],
      visibility: 'org',
      created_by: aliceUser.id,
      display_name: 'Org-visible',
    });
    orgConnId = orgConn.id;

    // Alice's private connection — only Alice (and presumably admins, but
    // memberRole isn't part of the fold) sees its events when authed; Bob
    // and unauthed callers do not.
    const alicePrivConn = await createTestConnection({
      organization_id: org.id,
      connector_key: 'vis-test-connector',
      entity_ids: [entity.id],
      visibility: 'private',
      created_by: aliceUser.id,
      display_name: 'Alice private',
    });
    alicePrivateConnId = alicePrivConn.id;

    // Bob's private connection — Alice and unauthed should not see its events.
    const bobPrivConn = await createTestConnection({
      organization_id: org.id,
      connector_key: 'vis-test-connector',
      entity_ids: [entity.id],
      visibility: 'private',
      created_by: bobUser.id,
      display_name: 'Bob private',
    });
    bobPrivateConnId = bobPrivConn.id;

    // Soft-deleted version of an Alice-private connection. The fold filters
    // on deleted_at IS NULL, so even Alice should not see its events.
    const deletedAlicePrivConn = await createTestConnection({
      organization_id: org.id,
      connector_key: 'vis-test-connector',
      entity_ids: [entity.id],
      visibility: 'private',
      created_by: aliceUser.id,
      display_name: 'Alice private (deleted)',
    });
    deletedAlicePrivateConnId = deletedAlicePrivConn.id;
    const sql = getTestDb();
    await sql`
      UPDATE connections SET deleted_at = NOW()
      WHERE id = ${deletedAlicePrivateConnId}
    `;

    orgEventId = (
      await createTestEvent({
        organization_id: org.id,
        entity_id: entity.id,
        connection_id: orgConnId,
        content: 'org-visible connection event',
      })
    ).id;

    alicePrivateEventId = (
      await createTestEvent({
        organization_id: org.id,
        entity_id: entity.id,
        connection_id: alicePrivateConnId,
        content: 'event from alice private connection',
      })
    ).id;

    bobPrivateEventId = (
      await createTestEvent({
        organization_id: org.id,
        entity_id: entity.id,
        connection_id: bobPrivateConnId,
        content: 'event from bob private connection',
      })
    ).id;

    deletedAlicePrivateEventId = (
      await createTestEvent({
        organization_id: org.id,
        entity_id: entity.id,
        connection_id: deletedAlicePrivateConnId,
        content: 'event from deleted alice private connection',
      })
    ).id;

    // System event: no connection at all. Must be visible to both authed
    // and unauthed callers under the new fold.
    systemEventId = (
      await createTestEvent({
        organization_id: org.id,
        entity_id: entity.id,
        connection_id: undefined,
        content: 'system event with no connection',
      })
    ).id;
  });

  it('authed user sees their own private connection events plus org events plus system events', async () => {
    const result = await getContent(
      { entity_id: entity.id, limit: 100, sort_by: 'date', sort_order: 'desc' } as never,
      {} as never,
      authedCtx(aliceUser.id)
    );
    const visibleIds = new Set(result.content.map((c) => c.id));

    expect(visibleIds.has(orgEventId)).toBe(true);
    expect(visibleIds.has(alicePrivateEventId)).toBe(true);
    expect(visibleIds.has(systemEventId)).toBe(true);

    // Other user's private connection: hidden.
    expect(visibleIds.has(bobPrivateEventId)).toBe(false);
    // Soft-deleted connection: hidden even though Alice owns it.
    expect(visibleIds.has(deletedAlicePrivateEventId)).toBe(false);
  });

  it('authed user does NOT see other users private connection events', async () => {
    const result = await getContent(
      { entity_id: entity.id, limit: 100, sort_by: 'date', sort_order: 'desc' } as never,
      {} as never,
      authedCtx(bobUser.id)
    );
    const visibleIds = new Set(result.content.map((c) => c.id));

    expect(visibleIds.has(bobPrivateEventId)).toBe(true);
    expect(visibleIds.has(orgEventId)).toBe(true);
    expect(visibleIds.has(systemEventId)).toBe(true);
    expect(visibleIds.has(alicePrivateEventId)).toBe(false);
  });

  it('unauthed caller sees only org-visible connection events plus system events', async () => {
    const result = await getContent(
      { entity_id: entity.id, limit: 100, sort_by: 'date', sort_order: 'desc' } as never,
      {} as never,
      unauthedCtx()
    );
    const visibleIds = new Set(result.content.map((c) => c.id));

    expect(visibleIds.has(orgEventId)).toBe(true);
    expect(visibleIds.has(systemEventId)).toBe(true);
    expect(visibleIds.has(alicePrivateEventId)).toBe(false);
    expect(visibleIds.has(bobPrivateEventId)).toBe(false);
    expect(visibleIds.has(deletedAlicePrivateEventId)).toBe(false);
  });

  it('total count matches list cardinality across cursor-driven pagination', async () => {
    const ctx = authedCtx(aliceUser.id);

    // The chronological feed (sort_by=date + sort_order=desc) uses cursor
    // pagination, not offset, so we walk it via before_occurred_at/before_id
    // the same way the events tab does in production.
    const page1 = await getContent(
      {
        entity_id: entity.id,
        limit: 2,
        sort_by: 'date',
        sort_order: 'desc',
      } as never,
      {} as never,
      ctx
    );
    expect(page1.total).toBe(3);
    expect(page1.content.length).toBe(2);
    expect(page1.page.has_older).toBe(true);

    const last = page1.content[page1.content.length - 1];
    const page2 = await getContent(
      {
        entity_id: entity.id,
        limit: 2,
        sort_by: 'date',
        sort_order: 'desc',
        before_occurred_at: last.occurred_at,
        before_id: last.id,
      } as never,
      {} as never,
      ctx
    );
    expect(page2.total).toBe(3);

    const collected = new Set([
      ...page1.content.map((c) => c.id),
      ...page2.content.map((c) => c.id),
    ]);
    expect(collected.size).toBe(3);
    expect(collected.has(orgEventId)).toBe(true);
    expect(collected.has(alicePrivateEventId)).toBe(true);
    expect(collected.has(systemEventId)).toBe(true);
  });
});

describe('getContent > response shape (view_url present, stats opt-in)', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let user: Awaited<ReturnType<typeof createTestUser>>;
  let emptyEntity: Awaited<ReturnType<typeof createTestEntity>>;

  function ctx(): ToolContext {
    return {
      organizationId: org.id,
      userId: user.id,
      memberRole: 'owner',
      isAuthenticated: true,
      tokenType: 'oauth',
      scopedToOrg: false,
      allowCrossOrg: true,
      scopes: ['mcp:read'],
    };
  }

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    org = await createTestOrganization({ name: 'Shape Org' });
    user = await createTestUser({ email: 'shape@example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');

    emptyEntity = await createTestEntity({
      name: 'Empty Entity',
      organization_id: org.id,
    });
  });

  it('empty entity returns content=[], total=0, view_url populated, no classification_stats by default', async () => {
    const result = await getContent(
      { entity_id: emptyEntity.id, limit: 50, sort_by: 'date', sort_order: 'desc' } as never,
      {} as never,
      ctx()
    );

    expect(result.content).toEqual([]);
    expect(result.total).toBe(0);
    // view_url is consumed by LLM agents reading read_knowledge over MCP.
    // It must always be populated when an entity is in scope.
    const viewUrl = (result as { view_url?: string }).view_url;
    expect(typeof viewUrl).toBe('string');
    expect(viewUrl).toMatch(/^https?:\/\//);
    expect(result.classification_stats).toBeUndefined();
  });

  it('classification_stats is populated only when include_classification=summary is set', async () => {
    const withStats = await getContent(
      {
        entity_id: emptyEntity.id,
        limit: 50,
        include_classification: 'summary',
        sort_by: 'date',
        sort_order: 'desc',
      } as never,
      {} as never,
      ctx()
    );
    expect(withStats.classification_stats).toBeDefined();

    const withoutStats = await getContent(
      { entity_id: emptyEntity.id, limit: 50, sort_by: 'date', sort_order: 'desc' } as never,
      {} as never,
      ctx()
    );
    expect(withoutStats.classification_stats).toBeUndefined();
  });
});

describe('getContent > visibility on sibling branches (content_ids/include_superseded/score)', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let aliceUser: Awaited<ReturnType<typeof createTestUser>>;
  let bobUser: Awaited<ReturnType<typeof createTestUser>>;
  let entity: Awaited<ReturnType<typeof createTestEntity>>;

  let orgEventId: number;
  let alicePrivateEventId: number;
  let bobPrivateEventId: number;

  function authedCtx(userId: string): ToolContext {
    return {
      organizationId: org.id,
      userId,
      memberRole: 'owner',
      isAuthenticated: true,
      tokenType: 'oauth',
      scopedToOrg: false,
      allowCrossOrg: true,
      scopes: ['mcp:read'],
    };
  }

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    org = await createTestOrganization({ name: 'Sibling Branch Org' });
    aliceUser = await createTestUser({ email: 'alice-branches@example.com' });
    bobUser = await createTestUser({ email: 'bob-branches@example.com' });
    await addUserToOrganization(aliceUser.id, org.id, 'owner');
    await addUserToOrganization(bobUser.id, org.id, 'owner');

    entity = await createTestEntity({
      name: 'Sibling Branch Entity',
      organization_id: org.id,
    });

    await createTestConnectorDefinition({
      key: 'branch-test-connector',
      name: 'Branch Test',
      organization_id: org.id,
    });

    const orgConn = await createTestConnection({
      organization_id: org.id,
      connector_key: 'branch-test-connector',
      entity_ids: [entity.id],
      visibility: 'org',
      created_by: aliceUser.id,
      display_name: 'Branch org-visible',
    });
    const alicePriv = await createTestConnection({
      organization_id: org.id,
      connector_key: 'branch-test-connector',
      entity_ids: [entity.id],
      visibility: 'private',
      created_by: aliceUser.id,
      display_name: 'Branch alice-private',
    });
    const bobPriv = await createTestConnection({
      organization_id: org.id,
      connector_key: 'branch-test-connector',
      entity_ids: [entity.id],
      visibility: 'private',
      created_by: bobUser.id,
      display_name: 'Branch bob-private',
    });

    orgEventId = (
      await createTestEvent({
        organization_id: org.id,
        entity_id: entity.id,
        connection_id: orgConn.id,
        content: 'branch org event',
      })
    ).id;
    alicePrivateEventId = (
      await createTestEvent({
        organization_id: org.id,
        entity_id: entity.id,
        connection_id: alicePriv.id,
        content: 'branch alice-private event',
      })
    ).id;
    bobPrivateEventId = (
      await createTestEvent({
        organization_id: org.id,
        entity_id: entity.id,
        connection_id: bobPriv.id,
        content: 'branch bob-private event',
      })
    ).id;
  });

  it('content_ids branch: requesting another user\'s private event by id returns nothing', async () => {
    const result = await getContent(
      {
        entity_id: entity.id,
        content_ids: [orgEventId, alicePrivateEventId, bobPrivateEventId],
        limit: 100,
      } as never,
      {} as never,
      authedCtx(aliceUser.id)
    );
    const visibleIds = new Set(result.content.map((c) => c.id));

    // Alice sees the org event and her own private event …
    expect(visibleIds.has(orgEventId)).toBe(true);
    expect(visibleIds.has(alicePrivateEventId)).toBe(true);
    // … but Bob's private event is filtered out even though Alice asked for it by ID.
    expect(visibleIds.has(bobPrivateEventId)).toBe(false);
    // total mirrors the visible set, not the requested set.
    expect(result.total).toBe(2);
  });

  it('include_superseded branch: another user\'s private events stay hidden in the historical listing', async () => {
    const result = await getContent(
      {
        entity_id: entity.id,
        include_superseded: true,
        limit: 100,
      } as never,
      {} as never,
      authedCtx(aliceUser.id)
    );
    const visibleIds = new Set(result.content.map((c) => c.id));

    expect(visibleIds.has(orgEventId)).toBe(true);
    expect(visibleIds.has(alicePrivateEventId)).toBe(true);
    expect(visibleIds.has(bobPrivateEventId)).toBe(false);
  });

  it('score branch: another user\'s private events stay hidden when sorting by score', async () => {
    const result = await getContent(
      {
        entity_id: entity.id,
        sort_by: 'score',
        limit: 100,
      } as never,
      {} as never,
      authedCtx(aliceUser.id)
    );
    const visibleIds = new Set(result.content.map((c) => c.id));

    expect(visibleIds.has(orgEventId)).toBe(true);
    expect(visibleIds.has(alicePrivateEventId)).toBe(true);
    expect(visibleIds.has(bobPrivateEventId)).toBe(false);
    // Count must match list cardinality on the score path too — the legacy
    // bug leaked Bob's private event into both list and count when the user
    // didn't pass connection_ids.
    expect(result.total).toBe(2);
  });
});
