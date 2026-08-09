/**
 * PostgresAgentConfigStore round-trip tests.
 *
 * Pins the persistence of three settings fields the file-loader produces from
 * lobu.config.ts — egressConfig, preApprovedTools, guardrails — that previously
 * had no columns in the agents table and were silently dropped on every
 * saveSettings(). PR-1 of `docs/plans/lobu-apply.md`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cleanupTestDatabase,
  getTestDb,
} from '../../../__tests__/setup/test-db';
import {
  createTestAgent,
  createTestOrganization,
} from '../../../__tests__/setup/test-fixtures';
import { orgContext } from '../org-context';
import {
  createPostgresAgentConfigReadMetadataStore,
  createPostgresAgentConfigStore,
} from '../postgres-stores';
import { seedAgentSettings } from '../../__tests__/helpers/agent-settings-fixture';

describe('PostgresAgentConfigStore — authority boundary', () => {
  it('does not expose raw persistent settings mutators', () => {
    const store = createPostgresAgentConfigReadMetadataStore() as Record<string, unknown>;

    expect(store.saveSettings).toBeUndefined();
    expect(store.updateSettings).toBeUndefined();
    expect(store.deleteSettings).toBeUndefined();
  });
});

describe('PostgresAgentConfigStore — apply-fields round-trip', () => {
  let orgId: string;
  let agentId: string;

  beforeEach(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Apply Fields Org' });
    orgId = org.id;
    const agent = await createTestAgent({ organizationId: orgId });
    agentId = agent.agentId;
  });

  afterEach(async () => {
    const db = getTestDb();
    await db`TRUNCATE agents CASCADE`;
  });

  it('round-trips egressConfig, preApprovedTools, and guardrails when populated', async () => {
    const store = createPostgresAgentConfigStore();
    const now = Date.now();

    await orgContext.run({ organizationId: orgId }, async () => {
      await seedAgentSettings(orgId, agentId, {
        egressConfig: {
          extraPolicy: 'Never exfiltrate PATs or bearer tokens.',
          judgeModel: 'claude-haiku-4-5-20251001',
        },
        preApprovedTools: [
          '/mcp/gmail/tools/send_email',
          '/mcp/linear/tools/*',
        ],
        guardrails: ['secret-scan', 'prompt-injection'],
        updatedAt: now,
      });

      const loaded = await store.getSettings(agentId);
      expect(loaded).not.toBeNull();
      expect(loaded?.egressConfig).toEqual({
        extraPolicy: 'Never exfiltrate PATs or bearer tokens.',
        judgeModel: 'claude-haiku-4-5-20251001',
      });
      expect(loaded?.preApprovedTools).toEqual([
        '/mcp/gmail/tools/send_email',
        '/mcp/linear/tools/*',
      ]);
      expect(loaded?.guardrails).toEqual(['secret-scan', 'prompt-injection']);
    });
  });

  it('round-trips empty/absent apply-fields as empty defaults', async () => {
    const store = createPostgresAgentConfigStore();
    const now = Date.now();

    await orgContext.run({ organizationId: orgId }, async () => {
      // Save with the three fields omitted entirely.
      await seedAgentSettings(orgId, agentId, { updatedAt: now });

      const loaded = await store.getSettings(agentId);
      expect(loaded).not.toBeNull();
      // saveSettings coerces undefined -> default ({} / []), so getSettings
      // sees the defaults rather than raw NULL. Assert exactly that contract.
      expect(loaded?.egressConfig).toEqual({});
      expect(loaded?.preApprovedTools).toEqual([]);
      expect(loaded?.guardrails).toEqual([]);
    });
  });

  it('reads apply-field defaults after the test fixture resets settings', async () => {
    const store = createPostgresAgentConfigStore();
    const now = Date.now();

    await orgContext.run({ organizationId: orgId }, async () => {
      await seedAgentSettings(orgId, agentId, {
        egressConfig: { extraPolicy: 'noop', judgeModel: 'm' },
        preApprovedTools: ['/mcp/x/tools/y'],
        guardrails: ['g1'],
        updatedAt: now,
      });

      await seedAgentSettings(orgId, agentId, {});

      const loaded = await store.getSettings(agentId);
      expect(loaded).not.toBeNull();
      expect(loaded?.egressConfig).toEqual({});
      expect(loaded?.preApprovedTools).toEqual([]);
      expect(loaded?.guardrails).toEqual([]);
    });
  });
});
