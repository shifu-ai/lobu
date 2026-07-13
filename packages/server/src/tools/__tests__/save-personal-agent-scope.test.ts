import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTestDatabase } from '../../__tests__/setup/test-db';
import {
  addUserToOrganization,
  createTestAgent,
  createTestOrganization,
  createTestUser,
} from '../../__tests__/setup/test-fixtures';
import { getDb } from '../../db/client';
import { initWorkspaceProvider } from '../../workspace';
import type { ToolContext } from '../registry';
import { saveContent } from '../save_content';

describe('save_memory personal-agent scope', () => {
  beforeAll(initWorkspaceProvider);
  beforeEach(cleanupTestDatabase);

  it('overwrites forged identity metadata at the authoritative personal write boundary', async () => {
    const org = await createTestOrganization({ name: 'Personal Save Scope' });
    const owner = await createTestUser({ email: 'personal-save@example.com' });
    await addUserToOrganization(owner.id, org.id, 'owner');
    await getDb()`UPDATE organization SET metadata = ${JSON.stringify({ personal_org_for_user_id: owner.id })} WHERE id = ${org.id}`;
    const agent = await createTestAgent({
      organizationId: org.id,
      agentId: 'personal-save-agent',
      ownerUserId: owner.id,
    });
    const ctx: ToolContext = {
      organizationId: org.id,
      userId: owner.id,
      memberRole: 'owner',
      agentId: agent.agentId,
      isAuthenticated: true,
      tokenType: 'oauth',
      scopes: ['mcp:write'],
      scopedToOrg: true,
      allowCrossOrg: false,
    };
    const saved = await saveContent(
      {
        content: 'trusted write',
        semantic_type: 'content',
        metadata: {
          agent_id: 'forged',
          owner_user_id: 'forged',
          memory_visibility: 'public',
        },
      },
      {} as never,
      ctx,
    );
    const rows = await getDb()`SELECT metadata FROM events WHERE id = ${saved.id}`;
    expect(rows[0].metadata).toMatchObject({
      agent_id: agent.agentId,
      owner_user_id: owner.id,
      memory_visibility: 'personal_private',
    });
  });

  it('preserves caller metadata in an ordinary organization', async () => {
    const org = await createTestOrganization({ name: 'Ordinary Save Scope' });
    const owner = await createTestUser({ email: 'ordinary-save@example.com' });
    await addUserToOrganization(owner.id, org.id, 'owner');
    const ctx: ToolContext = {
      organizationId: org.id,
      userId: owner.id,
      memberRole: 'owner',
      agentId: null,
      isAuthenticated: true,
      tokenType: 'oauth',
      scopes: ['mcp:write'],
      scopedToOrg: true,
      allowCrossOrg: false,
    };
    const saved = await saveContent(
      {
        content: 'ordinary write',
        semantic_type: 'content',
        metadata: { memory_visibility: 'public', custom: 'kept', evidence_kind: 'meeting', source_kind: 'meeting_notes', source_type: 'transcript' },
      },
      {} as never,
      ctx,
    );
    const rows = await getDb()`SELECT metadata FROM events WHERE id = ${saved.id}`;
    expect(rows[0].metadata).toEqual({
      memory_visibility: 'public',
      custom: 'kept',
    });
  });

  it('stamps authenticated agent ownership in a shared organization and rejects a forged binding', async () => {
    const org = await createTestOrganization({
      name: 'Shared Agent Save Scope',
    });
    const ownerA = await createTestUser({ email: 'shared-save-a@example.com' });
    const ownerB = await createTestUser({ email: 'shared-save-b@example.com' });
    await addUserToOrganization(ownerA.id, org.id, 'owner');
    await addUserToOrganization(ownerB.id, org.id, 'member');
    const agentA = await createTestAgent({
      organizationId: org.id,
      agentId: 'shared-save-agent-a',
      ownerUserId: ownerA.id,
    });
    const agentB = await createTestAgent({
      organizationId: org.id,
      agentId: 'shared-save-agent-b',
      ownerUserId: ownerB.id,
    });
    const baseCtx: ToolContext = {
      organizationId: org.id,
      userId: ownerA.id,
      memberRole: 'owner',
      agentId: agentA.agentId,
      isAuthenticated: true,
      tokenType: 'oauth',
      scopes: ['mcp:write'],
      scopedToOrg: true,
      allowCrossOrg: false,
    };
    const saved = await saveContent(
      {
        content: 'shared trusted write',
        semantic_type: 'content',
        metadata: {
          agent_id: agentB.agentId,
          owner_user_id: ownerB.id,
          memory_visibility: 'public',
        },
      },
      {} as never,
      baseCtx,
    );
    const rows = await getDb()`SELECT metadata FROM events WHERE id = ${saved.id}`;
    expect(rows[0].metadata).toMatchObject({
      agent_id: agentA.agentId,
      owner_user_id: ownerA.id,
      memory_visibility: 'personal_private',
    });

    await expect(
      saveContent({ content: 'forged agent binding', semantic_type: 'content' }, {} as never, {
        ...baseCtx,
        userId: ownerB.id,
        memberRole: 'member',
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('memory_scope_mismatch'),
    });
  });

  it('preserves trusted admin ingestion bound to an owner-null shared agent', async () => {
    const org = await createTestOrganization({
      name: 'Shared Admin Ingestion Scope',
    });
    const admin = await createTestUser({
      email: 'shared-save-admin@example.com',
    });
    await addUserToOrganization(admin.id, org.id, 'owner');
    const agent = await createTestAgent({
      organizationId: org.id,
      agentId: 'shared-owner-null-agent',
    });
    await getDb()`UPDATE agents SET owner_user_id = NULL WHERE id = ${agent.agentId}`;
    const saved = await saveContent(
      {
        content: 'trusted shared ingestion',
        semantic_type: 'content',
        metadata: { agent_id: 'forged', owner_user_id: 'forged' },
      },
      {} as never,
      {
        organizationId: org.id,
        userId: admin.id,
        memberRole: 'owner',
        agentId: agent.agentId,
        isAuthenticated: true,
        tokenType: 'pat',
        scopes: ['mcp:write', 'mcp:admin'],
        scopedToOrg: true,
        allowCrossOrg: false,
      },
    );
    const rows = await getDb()`SELECT metadata FROM events WHERE id = ${saved.id}`;
    expect(rows[0].metadata).toMatchObject({
      agent_id: agent.agentId,
      owner_user_id: null,
      memory_visibility: 'personal_private',
    });
  });

  it('rejects trusted admin OAuth/PAT bound to another owner\'s non-null agent', async () => {
    const org = await createTestOrganization({ name: 'Owned Agent Admin Scope' });
    const admin = await createTestUser({ email: 'owned-save-admin@example.com' });
    const owner = await createTestUser({ email: 'owned-save-owner@example.com' });
    await addUserToOrganization(admin.id, org.id, 'owner');
    await addUserToOrganization(owner.id, org.id, 'member');
    const agent = await createTestAgent({
      organizationId: org.id,
      agentId: 'other-owner-agent',
      ownerUserId: owner.id,
    });
    for (const tokenType of ['oauth', 'pat'] as const) {
      await expect(
        saveContent(
          { content: 'cross-owner admin write', semantic_type: 'content' },
          {} as never,
          {
            organizationId: org.id,
            userId: admin.id,
            memberRole: 'owner',
            agentId: agent.agentId,
            isAuthenticated: true,
            tokenType,
            scopes: ['mcp:write', 'mcp:admin'],
            scopedToOrg: true,
            allowCrossOrg: false,
          },
        ),
      ).rejects.toMatchObject({
        message: expect.stringContaining('memory_scope_mismatch'),
      });
    }
  });

  it('rejects trusted admin OAuth/PAT bound to nonexistent or cross-org agents', async () => {
    const org = await createTestOrganization({ name: 'Missing Agent Admin Scope' });
    const otherOrg = await createTestOrganization({ name: 'Cross Org Agent Scope' });
    const admin = await createTestUser({ email: 'missing-save-admin@example.com' });
    await addUserToOrganization(admin.id, org.id, 'owner');
    const crossOrgAgent = await createTestAgent({
      organizationId: otherOrg.id,
      agentId: 'cross-org-owner-null-agent',
    });
    await getDb()`UPDATE agents SET owner_user_id = NULL WHERE id = ${crossOrgAgent.agentId}`;
    for (const tokenType of ['oauth', 'pat'] as const) {
      for (const agentId of ['nonexistent-agent', crossOrgAgent.agentId]) {
        await expect(
          saveContent(
            { content: 'invalid agent binding', semantic_type: 'content' },
            {} as never,
            {
              organizationId: org.id,
              userId: admin.id,
              memberRole: 'owner',
              agentId,
              isAuthenticated: true,
              tokenType,
              scopes: ['mcp:write', 'mcp:admin'],
              scopedToOrg: true,
              allowCrossOrg: false,
            },
          ),
        ).rejects.toMatchObject({
          message: expect.stringContaining('memory_scope_identity_mismatch'),
        });
      }
    }
  });
});
