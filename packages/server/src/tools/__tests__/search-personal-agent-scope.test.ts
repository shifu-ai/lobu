import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTestDatabase } from '../../__tests__/setup/test-db';
import {
  addUserToOrganization,
  createTestAgent,
  createTestEvent,
  createTestOrganization,
  createTestUser,
} from '../../__tests__/setup/test-fixtures';
import { getDb } from '../../db/client';
import { searchContentByText } from '../../utils/content-search';
import { initWorkspaceProvider } from '../../workspace';
import type { ToolContext } from '../registry';
import { search } from '../search';

describe('search_memory personal-agent scope', () => {
  beforeAll(initWorkspaceProvider);
  beforeEach(cleanupTestDatabase);

  async function seedScope() {
    const org = await createTestOrganization({
      name: 'Personal Scope Fixture',
    });
    const ownerA = await createTestUser({
      email: `owner-a-${crypto.randomUUID()}@example.com`,
    });
    const ownerB = await createTestUser({
      email: `owner-b-${crypto.randomUUID()}@example.com`,
    });
    await addUserToOrganization(ownerA.id, org.id, 'owner');
    await addUserToOrganization(ownerB.id, org.id, 'member');
    await getDb()`UPDATE organization SET metadata = ${JSON.stringify({ personal_org_for_user_id: ownerA.id })} WHERE id = ${org.id}`;
    const agentA = await createTestAgent({
      organizationId: org.id,
      agentId: 'fixture-agent-a',
      ownerUserId: ownerA.id,
    });
    const agentB = await createTestAgent({
      organizationId: org.id,
      agentId: 'fixture-agent-b',
      ownerUserId: ownerB.id,
    });
    const ctx: ToolContext = {
      organizationId: org.id,
      userId: ownerA.id,
      memberRole: 'owner',
      agentId: agentA.agentId,
      isAuthenticated: true,
      clientId: null,
      scopes: ['mcp:read'],
      tokenType: 'oauth',
      scopedToOrg: true,
      allowCrossOrg: false,
    };
    return { org, ownerA, ownerB, agentA, agentB, ctx };
  }

  it('uses authenticated Agent A scope when agent_id is omitted', async () => {
    const org = await createTestOrganization({
      name: 'Personal Memory Scope Org',
    });
    const ownerA = await createTestUser({
      email: 'memory-owner-a@example.com',
    });
    const ownerB = await createTestUser({
      email: 'memory-owner-b@example.com',
    });
    await addUserToOrganization(ownerA.id, org.id, 'owner');
    await addUserToOrganization(ownerB.id, org.id, 'member');
    await getDb()`UPDATE organization SET metadata = ${JSON.stringify({ personal_org_for_user_id: ownerA.id })} WHERE id = ${org.id}`;
    const agentA = await createTestAgent({
      organizationId: org.id,
      agentId: 'personal-agent-a',
      ownerUserId: ownerA.id,
    });
    const agentB = await createTestAgent({
      organizationId: org.id,
      agentId: 'personal-agent-b',
      ownerUserId: ownerB.id,
    });
    const eventA = await createTestEvent({
      organization_id: org.id,
      content: 'same-org incident memory A',
      metadata: { agent_id: agentA.agentId },
    });
    const eventB = await createTestEvent({
      organization_id: org.id,
      content: 'same-org incident memory B',
      metadata: { agent_id: agentB.agentId },
    });
    const ctx: ToolContext = {
      organizationId: org.id,
      userId: ownerA.id,
      memberRole: 'owner',
      agentId: agentA.agentId,
      isAuthenticated: true,
      clientId: null,
      scopes: ['mcp:read'],
      tokenType: 'oauth',
      scopedToOrg: true,
      allowCrossOrg: false,
    };

    const result = await search(
      {
        query: 'same-org incident memory',
        include_public_catalogs: false,
        content_limit: 20,
      },
      {} as Parameters<typeof search>[1],
      ctx,
    );
    const ids = new Set(result.content?.map((row) => row.id) ?? []);
    expect(ids).toContain(eventA.id);
    expect(ids).not.toContain(eventB.id);
  });

  it('rejects forged A-to-B args and an authenticated A user bound to B', async () => {
    const { agentB, ctx } = await seedScope();
    await expect(
      search(
        {
          query: 'incident',
          agent_id: agentB.agentId,
          include_public_catalogs: false,
        },
        {} as never,
        ctx,
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining('memory_scope_mismatch'),
    });
    await expect(
      search({ query: 'incident', include_public_catalogs: false }, {} as never, {
        ...ctx,
        agentId: agentB.agentId,
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('memory_scope_mismatch'),
    });
  });

  it('rejects model-requested cross-agent scope even for trusted owner OAuth/PAT', async () => {
    const { agentB, ctx } = await seedScope();
    for (const tokenType of ['oauth', 'pat'] as const) {
      await expect(
        search(
          {
            query: 'trusted admin sentinel',
            agent_id: agentB.agentId,
            include_public_catalogs: false,
          },
          {} as never,
          { ...ctx, tokenType, scopes: ['mcp:read', 'mcp:admin'] },
        ),
      ).rejects.toMatchObject({
        message: expect.stringContaining('memory_scope_mismatch'),
      });
    }
  });

  it('enforces owner+agent identity, includes exact-agent legacy rows, excludes missing identity, and keeps course filter conjunctive', async () => {
    const { agentA, agentB, ownerA, ownerB, ctx, org } = await seedScope();
    const courseA = 'course:fixture:a';
    const courseB = 'course:fixture:b';
    const included = await createTestEvent({
      organization_id: org.id,
      content: 'scope course sentinel',
      metadata: {
        agent_id: agentA.agentId,
        owner_user_id: ownerA.id,
        course_entity_ids: [courseA],
      },
    });
    const wrongAgent = await createTestEvent({
      organization_id: org.id,
      content: 'scope course sentinel',
      metadata: {
        agent_id: agentB.agentId,
        owner_user_id: ownerB.id,
        course_entity_ids: [courseA],
      },
    });
    const wrongOwner = await createTestEvent({
      organization_id: org.id,
      content: 'scope course sentinel',
      metadata: {
        agent_id: agentA.agentId,
        owner_user_id: ownerB.id,
        course_entity_ids: [courseA],
      },
    });
    const wrongCourse = await createTestEvent({
      organization_id: org.id,
      content: 'scope course sentinel',
      metadata: {
        agent_id: agentA.agentId,
        owner_user_id: ownerA.id,
        course_entity_ids: [courseB],
      },
    });
    const legacy = await createTestEvent({
      organization_id: org.id,
      content: 'scope course sentinel',
      metadata: { agent_id: agentA.agentId, course_entity_ids: [courseA] },
    });
    const missing = await createTestEvent({
      organization_id: org.id,
      content: 'scope course sentinel',
      metadata: { course_entity_ids: [courseA] },
    });
    const result = await search(
      {
        query: 'scope course sentinel',
        entity_ids: [courseA],
        include_public_catalogs: false,
        content_limit: 20,
      },
      {} as never,
      ctx,
    );
    const ids = result.content?.map((row) => row.id) ?? [];
    expect(ids).toContain(included.id);
    expect(ids).toContain(legacy.id);
    expect(ids).not.toContain(wrongAgent.id);
    expect(ids).not.toContain(wrongOwner.id);
    expect(ids).not.toContain(wrongCourse.id);
    expect(ids).not.toContain(missing.id);
  });

  it('keeps generic internal agent_id-only search compatible with owner-stamped rows', async () => {
    const { agentA, ownerA, org } = await seedScope();
    const event = await createTestEvent({
      organization_id: org.id,
      content: 'generic agent-only sentinel',
      metadata: {
        agent_id: agentA.agentId,
        owner_user_id: ownerA.id,
        memory_visibility: 'personal_private',
      },
    });
    const result = await searchContentByText(
      'generic agent-only sentinel',
      {
        organization_id: org.id,
        agent_id: agentA.agentId,
        min_similarity: 0,
        limit: 20,
      },
      {} as never,
    );
    expect(result.content.map((row) => row.id)).toContain(event.id);
  });

  it('preserves anonymous public recall without personal identity', async () => {
    const org = await createTestOrganization({
      name: 'Public Recall',
      visibility: 'public',
    });
    const event = await createTestEvent({
      organization_id: org.id,
      content: 'public recall sentinel',
    });
    const result = await search(
      { query: 'public recall sentinel', include_public_catalogs: false },
      {} as never,
      {
        organizationId: org.id,
        userId: null,
        memberRole: null,
        agentId: null,
        isAuthenticated: false,
        clientId: null,
        tokenType: 'anonymous',
        scopes: undefined,
        scopedToOrg: true,
        allowCrossOrg: false,
      },
    );
    expect(result.content?.map((row) => row.id)).toContain(event.id);
  });
});
