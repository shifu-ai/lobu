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
        metadata: { memory_visibility: 'public', custom: 'kept' },
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
});
