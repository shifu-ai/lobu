/**
 * Integration tests for `auth/default-provisioning.ts`.
 *
 * Pins the sentinel behavior pi flagged: deletion stickiness (a removed
 * agent / watcher is NOT auto-recreated on the next run), provisioning
 * timing (watcher creation requires a device row), and idempotency.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateSecureToken } from '../../../auth/oauth/utils';
import {
  DEFAULT_AGENT_ID,
  DEFAULT_AGENT_IDENTITY,
  DEFAULT_AGENT_SENTINEL,
  DEFAULT_WATCHER_SENTINEL,
  DEFAULT_WATCHER_SLUG,
  ensureDefaultAgent,
  ensureDefaultWatcher,
  hasOrgSentinel,
} from '../../../auth/default-provisioning';
import * as moduleSystem from '../../../gateway/modules/module-system';
import { createAgentConfigurationAuthority } from '../../../lobu/agent-configuration';
import logger from '../../../utils/logger';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';

async function seedOrg(orgId: string): Promise<void> {
  const sql = getTestDb();
  const slug = orgId.replace(/[^a-z0-9]/gi, '-').toLowerCase();
  await sql`
    INSERT INTO "organization" (id, name, slug, visibility, "createdAt")
    VALUES (${orgId}, ${orgId}, ${slug}, 'private', NOW())
    ON CONFLICT (id) DO NOTHING
  `;
}

async function readMetadata(orgId: string): Promise<Record<string, unknown>> {
  const sql = getTestDb();
  const rows = await sql`
    SELECT metadata FROM "organization" WHERE id = ${orgId} LIMIT 1
  `;
  const raw = rows[0]?.metadata as string | null | undefined;
  if (!raw) return {};
  return JSON.parse(raw);
}

describe('ensureDefaultAgent', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('creates the default agent and writes the sentinel', async () => {
    const orgId = `org-provision-${generateSecureToken(4)}`;
    await seedOrg(orgId);

    const result = await ensureDefaultAgent(orgId);
    expect(result.created).toBe(true);
    expect(result.reason).toBe('inserted');

    const sql = getTestDb();
    const agents = await sql`
      SELECT id, name, identity_md FROM agents WHERE organization_id = ${orgId}
    `;
    expect(agents).toHaveLength(1);
    expect(String(agents[0].id)).toBe(DEFAULT_AGENT_ID);
    expect(String(agents[0].name)).toBe('Owletto Personal');
    expect(String(agents[0].identity_md)).toBeTruthy();

    const authorityRows = await sql`
      SELECT c.configuration_revision::text AS configuration_revision,
             command_row.mutation_kind
      FROM agent_configuration_controls c
      JOIN agent_configuration_commands command_row
        ON command_row.organization_id = c.organization_id
       AND command_row.agent_id = c.agent_id
      WHERE c.organization_id = ${orgId} AND c.agent_id = ${DEFAULT_AGENT_ID}
    `;
    expect(authorityRows).toEqual([{
      configuration_revision: '1',
      mutation_kind: 'bootstrap',
    }]);

    const metadata = await readMetadata(orgId);
    expect(metadata[DEFAULT_AGENT_SENTINEL]).toBeDefined();
  });

  it('is idempotent — second call is a no-op', async () => {
    const orgId = `org-provision-${generateSecureToken(4)}`;
    await seedOrg(orgId);

    const first = await ensureDefaultAgent(orgId);
    expect(first.created).toBe(true);

    const second = await ensureDefaultAgent(orgId);
    expect(second.created).toBe(false);
    expect(second.reason).toBe('sentinel');
  });

  it('serializes parallel boots into one complete authority bootstrap', async () => {
    const orgId = `org-parallel-${generateSecureToken(4)}`;
    await seedOrg(orgId);

    const results = await Promise.all([
      ensureDefaultAgent(orgId),
      ensureDefaultAgent(orgId),
    ]);
    expect(results.filter((result) => result.created)).toHaveLength(1);

    const sql = getTestDb();
    const aggregate = await sql`
      SELECT a.identity_md,
             c.configuration_revision::text AS configuration_revision,
             count(command_row.command_id)::int AS command_count
      FROM agents a
      JOIN agent_configuration_controls c
        ON c.organization_id = a.organization_id AND c.agent_id = a.id
      JOIN agent_configuration_commands command_row
        ON command_row.organization_id = a.organization_id
       AND command_row.agent_id = a.id
      WHERE a.organization_id = ${orgId} AND a.id = ${DEFAULT_AGENT_ID}
      GROUP BY a.identity_md, c.configuration_revision
    `;
    expect(aggregate).toEqual([{
      identity_md: expect.any(String),
      configuration_revision: '1',
      command_count: 1,
    }]);
  });

  it('is sticky against deletion — recreate refused after sentinel set', async () => {
    const orgId = `org-provision-${generateSecureToken(4)}`;
    await seedOrg(orgId);

    await ensureDefaultAgent(orgId);

    // User deletes the agent via the web UI.
    const sql = getTestDb();
    await sql`
      DELETE FROM agents WHERE organization_id = ${orgId} AND id = ${DEFAULT_AGENT_ID}
    `;

    const again = await ensureDefaultAgent(orgId);
    expect(again.created).toBe(false);
    expect(again.reason).toBe('sentinel');

    const agents = await sql`
      SELECT id FROM agents WHERE organization_id = ${orgId}
    `;
    expect(agents).toHaveLength(0);
  });

  it('stamps owner_user_id + installed_providers + agent_users on insert', async () => {
    const orgId = `org-owner-${generateSecureToken(4)}`;
    await seedOrg(orgId);

    // Mark the org as personal_org_for_user_id = <ownerUserId> — this is the
    // marker ensureDefaultAgent reads to figure out who the agent belongs to.
    const ownerUserId = `user_${generateSecureToken(4)}`;
    const sql = getTestDb();
    await sql`
      INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
      VALUES (${ownerUserId}, 'Owner', ${`${ownerUserId}@test.local`}, true, NOW(), NOW())
      ON CONFLICT (id) DO NOTHING
    `;
    await sql`
      UPDATE "organization"
         SET metadata = ${JSON.stringify({ personal_org_for_user_id: ownerUserId })}
       WHERE id = ${orgId}
    `;

    await ensureDefaultAgent(orgId);

    const rows = await sql`
      SELECT owner_platform, owner_user_id, installed_providers
        FROM agents
       WHERE organization_id = ${orgId} AND id = ${DEFAULT_AGENT_ID}
    `;
    expect(rows).toHaveLength(1);
    expect(String(rows[0].owner_platform)).toBe('external');
    expect(String(rows[0].owner_user_id)).toBe(ownerUserId);
    // installed_providers shape: array of { providerId, installedAt }.
    // We don't pin a count because system keys depend on test env vars;
    // we just assert the column is now a JSON array (object/array, never
    // null/empty-string).
    expect(Array.isArray(rows[0].installed_providers)).toBe(true);

    const userAgents = await sql`
      SELECT platform, user_id
        FROM agent_users
       WHERE organization_id = ${orgId} AND agent_id = ${DEFAULT_AGENT_ID}
    `;
    expect(userAgents).toHaveLength(1);
    expect(String(userAgents[0].platform)).toBe('external');
    expect(String(userAgents[0].user_id)).toBe(ownerUserId);
  });

  it('backfills owner + agent_users on a legacy row past the sentinel', async () => {
    // Simulate a legacy install: the row exists with the old
    // owner_platform='lobu', owner_user_id=NULL, installed_providers='[]'
    // shape, and the sentinel is already set so the fast-path would skip.
    const orgId = `org-backfill-${generateSecureToken(4)}`;
    await seedOrg(orgId);

    const ownerUserId = `user_${generateSecureToken(4)}`;
    const sql = getTestDb();
    await sql`
      INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
      VALUES (${ownerUserId}, 'Legacy Owner', ${`${ownerUserId}@test.local`}, true, NOW(), NOW())
      ON CONFLICT (id) DO NOTHING
    `;
    await sql`
      UPDATE "organization"
         SET metadata = ${JSON.stringify({
           personal_org_for_user_id: ownerUserId,
           [DEFAULT_AGENT_SENTINEL]: new Date().toISOString(),
         })}
       WHERE id = ${orgId}
    `;
    await sql`
      INSERT INTO agents (
        id, organization_id, name, owner_platform, owner_user_id,
        installed_providers, created_at, updated_at
      ) VALUES (
        ${DEFAULT_AGENT_ID}, ${orgId}, 'Owletto Personal',
        'lobu', NULL,
        '[]'::jsonb,
        NOW(), NOW()
      )
    `;

    // Sentinel is set, so the create path is short-circuited, but backfill
    // still runs.
    const result = await ensureDefaultAgent(orgId);
    expect(result.created).toBe(false);
    expect(result.reason).toBe('sentinel');

    const rows = await sql`
      SELECT owner_platform, owner_user_id
        FROM agents
       WHERE organization_id = ${orgId} AND id = ${DEFAULT_AGENT_ID}
    `;
    expect(String(rows[0].owner_platform)).toBe('external');
    expect(String(rows[0].owner_user_id)).toBe(ownerUserId);

    const userAgents = await sql`
      SELECT user_id FROM agent_users
       WHERE organization_id = ${orgId} AND agent_id = ${DEFAULT_AGENT_ID}
    `;
    expect(userAgents).toHaveLength(1);
    expect(String(userAgents[0].user_id)).toBe(ownerUserId);
  });

  it('repairs a blank legacy identity through one revisioned authority patch', async () => {
    const providerSpy = vi
      .spyOn(moduleSystem, 'getModelProviderModules')
      .mockReturnValue([]);
    try {
      const orgId = `org-identity-backfill-${generateSecureToken(4)}`;
      await seedOrg(orgId);
      const sql = getTestDb();
      await sql`
        UPDATE "organization"
           SET metadata = ${JSON.stringify({
             [DEFAULT_AGENT_SENTINEL]: new Date().toISOString(),
           })}
         WHERE id = ${orgId}
      `;
      await sql`
        INSERT INTO agents (
          id, organization_id, name, identity_md, installed_providers,
          created_at, updated_at
        ) VALUES (
          ${DEFAULT_AGENT_ID}, ${orgId}, 'Owletto Personal', '',
          ${sql.json([{ providerId: 'curated-provider', installedAt: 1 }])},
          NOW(), NOW()
        )
      `;

      await ensureDefaultAgent(orgId);

      const rows = await sql`
        SELECT a.identity_md, a.installed_providers,
               c.configuration_revision::text AS configuration_revision,
               count(command_row.command_id)::int AS command_count
        FROM agents a
        JOIN agent_configuration_controls c
          ON c.organization_id = a.organization_id AND c.agent_id = a.id
        JOIN agent_configuration_commands command_row
          ON command_row.organization_id = a.organization_id
         AND command_row.agent_id = a.id
        WHERE a.organization_id = ${orgId} AND a.id = ${DEFAULT_AGENT_ID}
        GROUP BY a.identity_md, a.installed_providers, c.configuration_revision
      `;
      expect(rows).toEqual([{
        identity_md: DEFAULT_AGENT_IDENTITY,
        installed_providers: [{ providerId: 'curated-provider', installedAt: 1 }],
        configuration_revision: '1',
        command_count: 1,
      }]);
    } finally {
      providerSpy.mockRestore();
    }
  });

  it('repairs provider drift independently without rewriting a healthy identity', async () => {
    const providerSpy = vi
      .spyOn(moduleSystem, 'getModelProviderModules')
      .mockReturnValue([{
        providerId: 'system-provider',
        hasSystemKey: () => true,
      } as never]);
    try {
      const orgId = `org-provider-backfill-${generateSecureToken(4)}`;
      await seedOrg(orgId);
      const sql = getTestDb();
      await sql`
        UPDATE "organization"
           SET metadata = ${JSON.stringify({
             [DEFAULT_AGENT_SENTINEL]: new Date().toISOString(),
           })}
         WHERE id = ${orgId}
      `;
      await sql`
        INSERT INTO agents (
          id, organization_id, name, identity_md, installed_providers,
          created_at, updated_at
        ) VALUES (
          ${DEFAULT_AGENT_ID}, ${orgId}, 'Owletto Personal',
          ${DEFAULT_AGENT_IDENTITY}, '[]'::jsonb, NOW(), NOW()
        )
      `;

      await ensureDefaultAgent(orgId);

      const rows = await sql`
        SELECT identity_md, installed_providers
        FROM agents
        WHERE organization_id = ${orgId} AND id = ${DEFAULT_AGENT_ID}
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0].identity_md).toBe(DEFAULT_AGENT_IDENTITY);
      expect(rows[0].installed_providers).toEqual([
        { providerId: 'system-provider', installedAt: expect.any(Number) },
      ]);
    } finally {
      providerSpy.mockRestore();
    }
  });

  it('warns and preserves a managed blank identity as last-known-good state', async () => {
    const providerSpy = vi
      .spyOn(moduleSystem, 'getModelProviderModules')
      .mockReturnValue([]);
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      const orgId = `org-managed-identity-${generateSecureToken(4)}`;
      await seedOrg(orgId);
      const sql = getTestDb();
      await sql`
        INSERT INTO agents (id, organization_id, name, identity_md)
        VALUES (${DEFAULT_AGENT_ID}, ${orgId}, 'Managed Owletto', '')
      `;
      await sql`
        INSERT INTO agent_configuration_controls (
          organization_id, agent_id, management_mode, configuration_revision
        ) VALUES (${orgId}, ${DEFAULT_AGENT_ID}, 'toolbox_managed', 3)
      `;

      await ensureDefaultAgent(orgId);

      const rows = await sql`
        SELECT identity_md FROM agents
        WHERE organization_id = ${orgId} AND id = ${DEFAULT_AGENT_ID}
      `;
      expect(rows).toEqual([{ identity_md: '' }]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: orgId,
          agentId: DEFAULT_AGENT_ID,
          reason: 'field_owned_by_managed_release',
        }),
        expect.stringContaining('backfill deferred')
      );
    } finally {
      warnSpy.mockRestore();
      providerSpy.mockRestore();
    }
  });

  it('does not overwrite a concurrent identity repair after its observed revision goes stale', async () => {
    const providerSpy = vi
      .spyOn(moduleSystem, 'getModelProviderModules')
      .mockReturnValue([]);
    try {
      const orgId = `org-conflicting-identity-${generateSecureToken(4)}`;
      await seedOrg(orgId);
      const sql = getTestDb();
      await sql`
        UPDATE "organization"
           SET metadata = ${JSON.stringify({
             [DEFAULT_AGENT_SENTINEL]: new Date().toISOString(),
           })}
         WHERE id = ${orgId}
      `;
      await sql`
        INSERT INTO agents (id, organization_id, name, identity_md)
        VALUES (${DEFAULT_AGENT_ID}, ${orgId}, 'Owletto Personal', '')
      `;

      let injectedWinner = false;
      const racingClient = new Proxy(sql, {
        get(target, property, receiver) {
          if (property === 'begin') {
            return async (callback: (tx: never) => Promise<unknown>) => {
              if (!injectedWinner) {
                injectedWinner = true;
                await createAgentConfigurationAuthority(sql as never).apply({
                  organizationId: orgId,
                  agentId: DEFAULT_AGENT_ID,
                  commandId: 'concurrent-default-identity-winner',
                  expectedConfigurationRevision: '0',
                  actor: { kind: 'session' },
                  patch: { identityMd: 'concurrent winner identity' },
                });
              }
              return target.begin(callback as never);
            };
          }
          return Reflect.get(target, property, receiver);
        },
      });

      await ensureDefaultAgent(orgId, racingClient as never);

      const rows = await sql`
        SELECT a.identity_md, c.configuration_revision::text AS configuration_revision,
               count(command_row.command_id)::int AS command_count
        FROM agents a
        JOIN agent_configuration_controls c
          ON c.organization_id = a.organization_id AND c.agent_id = a.id
        JOIN agent_configuration_commands command_row
          ON command_row.organization_id = a.organization_id
         AND command_row.agent_id = a.id
        WHERE a.organization_id = ${orgId} AND a.id = ${DEFAULT_AGENT_ID}
        GROUP BY a.identity_md, c.configuration_revision
      `;
      expect(rows).toEqual([{
        identity_md: 'concurrent winner identity',
        configuration_revision: '1',
        command_count: 1,
      }]);
    } finally {
      providerSpy.mockRestore();
    }
  });

  it('skips creation (but stamps sentinel) when other agents already exist', async () => {
    const orgId = `org-provision-${generateSecureToken(4)}`;
    await seedOrg(orgId);

    // The user already curated their own agent before Owletto ever provisioned.
    const sql = getTestDb();
    await sql`
      INSERT INTO agents (id, organization_id, name)
      VALUES ('user-curated', ${orgId}, 'User-Curated Agent')
    `;

    const result = await ensureDefaultAgent(orgId);
    expect(result.created).toBe(false);
    expect(result.reason).toBe('has_agents');

    const agents = await sql`
      SELECT id FROM agents WHERE organization_id = ${orgId}
    `;
    expect(agents).toHaveLength(1);
    expect(String(agents[0].id)).toBe('user-curated');

    // Sentinel still set so the next boot doesn't keep re-checking.
    expect(await hasOrgSentinel(orgId, DEFAULT_AGENT_SENTINEL)).toBe(true);
  });
});

describe('ensureDefaultWatcher', () => {
  async function setupOrgWithDeviceAndAgent(): Promise<{
    orgId: string;
    deviceWorkerId: string;
    userId: string;
  }> {
    const orgId = `org-watcher-${generateSecureToken(4)}`;
    await seedOrg(orgId);
    const sql = getTestDb();

    const userId = `user_${generateSecureToken(4)}`;
    await sql`
      INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
      VALUES (${userId}, 'Watcher User', ${`${userId}@test.local`}, true, NOW(), NOW())
      ON CONFLICT (id) DO NOTHING
    `;
    // Add the user as the org owner so `watchers.created_by` has a valid FK target.
    await sql`
      INSERT INTO "member" (id, "userId", "organizationId", role, "createdAt")
      VALUES (${`member_${generateSecureToken(4)}`}, ${userId}, ${orgId}, 'owner', NOW())
    `;
    const inserted = (await sql`
      INSERT INTO device_workers (user_id, worker_id, platform, capabilities, label, organization_id)
      VALUES (${userId}, ${`worker-${userId}`}, 'macos', ${sql.json({})}, 'Mac', ${orgId})
      RETURNING id
    `) as unknown as Array<{ id: string }>;
    const deviceWorkerId = String(inserted[0].id);

    // Pre-provision the default agent (the order ensureDefaultAgent enforces).
    await ensureDefaultAgent(orgId);

    return { orgId, deviceWorkerId, userId };
  }

  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('creates the daily-checkin watcher pinned to the device', async () => {
    const { orgId, deviceWorkerId } = await setupOrgWithDeviceAndAgent();

    const result = await ensureDefaultWatcher({
      organizationId: orgId,
      agentId: DEFAULT_AGENT_ID,
      deviceWorkerId,
    });
    expect(result.created).toBe(true);
    expect(result.reason).toBe('inserted');

    const sql = getTestDb();
    const watchers = await sql`
      SELECT id, slug, agent_id, device_worker_id::text AS device_worker_id, schedule, status
      FROM watchers
      WHERE organization_id = ${orgId}
    `;
    expect(watchers).toHaveLength(1);
    const w = watchers[0];
    expect(String(w.slug)).toBe(DEFAULT_WATCHER_SLUG);
    expect(String(w.agent_id)).toBe(DEFAULT_AGENT_ID);
    expect(String(w.device_worker_id)).toBe(deviceWorkerId);
    expect(String(w.schedule)).toBe('0 9 * * *');
    expect(String(w.status)).toBe('active');

    const versions = await sql`
      SELECT prompt FROM watcher_versions WHERE watcher_id = ${w.id}
    `;
    expect(versions).toHaveLength(1);
    expect(String(versions[0].prompt)).toMatch(/yesterday/i);

    expect(await hasOrgSentinel(orgId, DEFAULT_WATCHER_SENTINEL)).toBe(true);
  });

  it('is idempotent — second call is a no-op', async () => {
    const { orgId, deviceWorkerId } = await setupOrgWithDeviceAndAgent();

    const first = await ensureDefaultWatcher({
      organizationId: orgId,
      agentId: DEFAULT_AGENT_ID,
      deviceWorkerId,
    });
    expect(first.created).toBe(true);

    const second = await ensureDefaultWatcher({
      organizationId: orgId,
      agentId: DEFAULT_AGENT_ID,
      deviceWorkerId,
    });
    expect(second.created).toBe(false);
    expect(second.reason).toBe('sentinel');

    const sql = getTestDb();
    const watchers = await sql`SELECT id FROM watchers WHERE organization_id = ${orgId}`;
    expect(watchers).toHaveLength(1);
  });

  it('is sticky against deletion — recreate refused after sentinel set', async () => {
    const { orgId, deviceWorkerId } = await setupOrgWithDeviceAndAgent();

    await ensureDefaultWatcher({
      organizationId: orgId,
      agentId: DEFAULT_AGENT_ID,
      deviceWorkerId,
    });

    const sql = getTestDb();
    await sql`DELETE FROM watchers WHERE organization_id = ${orgId} AND slug = ${DEFAULT_WATCHER_SLUG}`;

    const again = await ensureDefaultWatcher({
      organizationId: orgId,
      agentId: DEFAULT_AGENT_ID,
      deviceWorkerId,
    });
    expect(again.created).toBe(false);
    expect(again.reason).toBe('sentinel');

    const watchers = await sql`SELECT id FROM watchers WHERE organization_id = ${orgId}`;
    expect(watchers).toHaveLength(0);
  });

  it('falls back to another agent when the default has been deleted', async () => {
    const { orgId, deviceWorkerId } = await setupOrgWithDeviceAndAgent();
    const sql = getTestDb();

    // User deleted the default agent before the device first registered.
    await sql`DELETE FROM agents WHERE organization_id = ${orgId} AND id = ${DEFAULT_AGENT_ID}`;
    await sql`
      INSERT INTO agents (id, organization_id, name)
      VALUES ('fallback-agent', ${orgId}, 'Fallback')
    `;

    const result = await ensureDefaultWatcher({
      organizationId: orgId,
      agentId: DEFAULT_AGENT_ID,
      deviceWorkerId,
    });
    expect(result.created).toBe(true);

    const watchers = await sql`
      SELECT agent_id FROM watchers WHERE organization_id = ${orgId}
    `;
    expect(watchers).toHaveLength(1);
    expect(String(watchers[0].agent_id)).toBe('fallback-agent');
  });

  it('skips silently when the org has no agents at all', async () => {
    const orgId = `org-watcher-noagent-${generateSecureToken(4)}`;
    await seedOrg(orgId);
    const sql = getTestDb();
    const userId = `user_${generateSecureToken(4)}`;
    await sql`
      INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
      VALUES (${userId}, 'No Agent User', ${`${userId}@test.local`}, true, NOW(), NOW())
      ON CONFLICT (id) DO NOTHING
    `;
    await sql`
      INSERT INTO "member" (id, "userId", "organizationId", role, "createdAt")
      VALUES (${`member_${generateSecureToken(4)}`}, ${userId}, ${orgId}, 'owner', NOW())
    `;
    const inserted = (await sql`
      INSERT INTO device_workers (user_id, worker_id, platform, capabilities, label, organization_id)
      VALUES (${userId}, ${`worker-${userId}`}, 'macos', ${sql.json({})}, 'Mac', ${orgId})
      RETURNING id
    `) as unknown as Array<{ id: string }>;
    const deviceWorkerId = String(inserted[0].id);

    const result = await ensureDefaultWatcher({
      organizationId: orgId,
      agentId: DEFAULT_AGENT_ID,
      deviceWorkerId,
    });
    expect(result.created).toBe(false);
    expect(result.reason).toBe('no_agent');

    // Sentinel still set so we don't keep retrying on every poll.
    expect(await hasOrgSentinel(orgId, DEFAULT_WATCHER_SENTINEL)).toBe(true);
  });
});
