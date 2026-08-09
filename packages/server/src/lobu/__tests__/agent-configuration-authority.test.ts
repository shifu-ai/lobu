import { createHash } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { canonicalize } from 'json-canonicalize';
import { getDb } from '../../db/client';
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
  seedAgentRow,
} from '../../gateway/__tests__/helpers/db-setup';
import { createAgentConfigurationAuthority } from '../agent-configuration';

const AGENT_ID = 'native-authority-tracer';
const ORGANIZATION_ID = 'native-authority-org';

function canonicalDigest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalize(value)).digest('hex')}`;
}

describe('AgentConfigurationAuthority', () => {
  beforeAll(async () => {
    await ensureDbForGatewayTests();
  });

  beforeEach(async () => {
    await resetTestDatabase();
    await seedAgentRow(AGENT_ID, { organizationId: ORGANIZATION_ID });
  });

  test('persists one native patch, revision control, and command receipt atomically', async () => {
    const authority = createAgentConfigurationAuthority();
    const command = {
      organizationId: ORGANIZATION_ID,
      agentId: AGENT_ID,
      commandId: 'native-command-1',
      expectedConfigurationRevision: '0',
      actor: { kind: 'admin_pat' as const },
      patch: { verboseLogging: true },
    };

    const result = await authority.apply(command);
    if (result.status !== 'applied') throw new Error('Expected applied result');
    const commandDigest = result.state.lastMutation.commandDigest;

    expect(result).toMatchObject({
      status: 'applied',
      state: {
        organizationId: ORGANIZATION_ID,
        agentId: AGENT_ID,
        managementMode: 'native',
        configurationRevision: '1',
        lastMutation: {
          kind: 'native_patch',
          commandId: 'native-command-1',
          commandDigest,
        },
      },
    });

    const sql = getDb();
    const agents = await sql`
      SELECT verbose_logging
      FROM agents
      WHERE organization_id = ${ORGANIZATION_ID} AND id = ${AGENT_ID}
    `;
    expect(agents).toEqual([{ verbose_logging: true }]);

    const controls = await sql`
      SELECT management_mode, configuration_revision, last_mutation_kind,
             last_command_id, last_command_digest
      FROM agent_configuration_controls
      WHERE organization_id = ${ORGANIZATION_ID} AND agent_id = ${AGENT_ID}
    `;
    expect(controls).toEqual([
      {
        management_mode: 'native',
        configuration_revision: 1,
        last_mutation_kind: 'native_patch',
        last_command_id: 'native-command-1',
        last_command_digest: commandDigest,
      },
    ]);

    const commands = await sql`
      SELECT command_id, command_digest, mutation_kind, resulting_revision,
             resulting_mode, resulting_settings_digest, result_status
      FROM agent_configuration_commands
      WHERE organization_id = ${ORGANIZATION_ID} AND agent_id = ${AGENT_ID}
    `;
    expect(commands).toEqual([
      {
        command_id: 'native-command-1',
        command_digest: commandDigest,
        mutation_kind: 'native_patch',
        resulting_revision: 1,
        resulting_mode: 'native',
        resulting_settings_digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        result_status: 'applied',
      },
    ]);
  });

  test('replays the original result and returns conflict for command id reuse', async () => {
    const authority = createAgentConfigurationAuthority();
    const command = {
      organizationId: ORGANIZATION_ID,
      agentId: AGENT_ID,
      commandId: 'native-command-replay',
      expectedConfigurationRevision: '0',
      actor: { kind: 'session' as const },
      patch: { verboseLogging: true },
    };

    expect((await authority.apply(command)).status).toBe('applied');
    await expect(authority.apply(command)).resolves.toMatchObject({
      status: 'already_applied',
      state: { configurationRevision: '1' },
    });

    const conflictingCommand = {
      ...command,
      patch: { verboseLogging: false },
    };
    await expect(authority.apply(conflictingCommand)).resolves.toEqual({
      status: 'conflict',
      conflict: 'command_conflict',
      currentRevision: '1',
    });

    const receipts = await getDb()`
      SELECT result_status
      FROM agent_configuration_commands
      WHERE organization_id = ${ORGANIZATION_ID} AND agent_id = ${AGENT_ID}
    `;
    expect(receipts).toEqual([{ result_status: 'applied' }]);
  });

  test('applies a complete native partial patch without resetting omitted fields', async () => {
    const sql = getDb();
    await sql`
      UPDATE agents
      SET user_md = 'keep this user prompt',
          mcp_servers = ${sql.json({ old: { url: 'https://old.example' } })}
      WHERE organization_id = ${ORGANIZATION_ID} AND id = ${AGENT_ID}
    `;

    const result = await createAgentConfigurationAuthority().apply({
      organizationId: ORGANIZATION_ID,
      agentId: AGENT_ID,
      commandId: 'native-command-mcp-partial',
      expectedConfigurationRevision: '0',
      actor: { kind: 'session' },
      patch: { mcpServers: { current: { url: 'https://current.example' } } },
    });

    expect(result.status).toBe('applied');
    const rows = await sql`
      SELECT user_md, mcp_servers
      FROM agents
      WHERE organization_id = ${ORGANIZATION_ID} AND id = ${AGENT_ID}
    `;
    expect(rows).toEqual([
      {
        user_md: 'keep this user prompt',
        mcp_servers: { current: { url: 'https://current.example' } },
      },
    ]);
  });

  test('rejects release-owned fields in toolbox_managed mode but permits operator fields', async () => {
    const sql = getDb();
    await sql`
      INSERT INTO agent_configuration_controls (
        organization_id, agent_id, management_mode
      ) VALUES (${ORGANIZATION_ID}, ${AGENT_ID}, 'toolbox_managed')
    `;
    const authority = createAgentConfigurationAuthority();

    await expect(
      authority.apply({
        organizationId: ORGANIZATION_ID,
        agentId: AGENT_ID,
        commandId: 'managed-release-owned-command',
        expectedConfigurationRevision: '0',
        actor: { kind: 'session' },
        patch: { model: 'legacy-model', identityMd: 'managed identity' },
      })
    ).resolves.toEqual({
      status: 'rejected',
      reason: 'field_owned_by_managed_release',
    });

    await expect(
      authority.apply({
        organizationId: ORGANIZATION_ID,
        agentId: AGENT_ID,
        commandId: 'managed-operator-command',
        expectedConfigurationRevision: '0',
        actor: { kind: 'session' },
        patch: { verboseLogging: true },
      })
    ).resolves.toMatchObject({
      status: 'applied',
      state: { managementMode: 'toolbox_managed', configurationRevision: '1' },
    });
  });

  test('advances decimal revisions without JavaScript number precision loss', async () => {
    const sql = getDb();
    await sql`
      INSERT INTO agent_configuration_controls (
        organization_id, agent_id, configuration_revision
      ) VALUES (
        ${ORGANIZATION_ID}, ${AGENT_ID}, 9007199254740993
      )
    `;
    const authority = createAgentConfigurationAuthority();
    const command = {
      organizationId: ORGANIZATION_ID,
      agentId: AGENT_ID,
      commandId: 'native-command-large-revision',
      expectedConfigurationRevision: '9007199254740993',
      actor: { kind: 'session' as const },
      patch: { verboseLogging: true },
    };

    await expect(authority.apply(command)).resolves.toMatchObject({
      status: 'applied',
      state: { configurationRevision: '9007199254740994' },
    });
  });

  test('snapshots undigested input before the transaction and ignores a claimed digest', async () => {
    const authority = createAgentConfigurationAuthority();
    const patch = { verboseLogging: true };
    const input = {
      organizationId: ORGANIZATION_ID,
      agentId: AGENT_ID,
      commandId: 'native-command-mutable-input',
      expectedConfigurationRevision: '0',
      actor: { kind: 'session' as const },
      patch,
      kind: 'native_patch' as const,
      commandDigest: `sha256:${'0'.repeat(64)}` as const,
    };
    const expectedDigest = canonicalDigest({
      kind: 'native_patch',
      agentId: AGENT_ID,
      expectedRevision: '0',
      patch: { verboseLogging: true },
    });

    const applying = authority.apply(input);
    patch.verboseLogging = false;
    const result = await applying;

    expect(result).toMatchObject({
      status: 'applied',
      state: {
        configurationRevision: '1',
        lastMutation: { commandDigest: expectedDigest },
      },
    });
    await expect(
      authority.apply({
        ...input,
        patch: { verboseLogging: true },
        commandDigest: `sha256:${'f'.repeat(64)}`,
      })
    ).resolves.toMatchObject({
      status: 'already_applied',
      state: { lastMutation: { commandDigest: expectedDigest } },
    });
    const rows = await getDb()`
      SELECT agent.verbose_logging, command_row.command_digest
      FROM agents agent
      JOIN agent_configuration_commands command_row
        ON command_row.organization_id = agent.organization_id
       AND command_row.agent_id = agent.id
      WHERE agent.organization_id = ${ORGANIZATION_ID} AND agent.id = ${AGENT_ID}
    `;
    expect(rows).toEqual([
      {
        verbose_logging: true,
        command_digest: expectedDigest,
      },
    ]);
  });

  test('serializes three distinct native patches from independent authorities to one CAS winner', async () => {
    const authorities = [
      createAgentConfigurationAuthority(),
      createAgentConfigurationAuthority(),
      createAgentConfigurationAuthority(),
    ];
    const results = await Promise.all(
      authorities.map((authority, index) =>
        authority.apply({
          organizationId: ORGANIZATION_ID,
          agentId: AGENT_ID,
          commandId: `native-command-race-${index + 1}`,
          expectedConfigurationRevision: '0',
          actor: { kind: 'session' },
          patch: [
            { verboseLogging: true },
            { userMd: 'race user winner' },
            { mcpServers: { race: { url: 'https://race.example' } } },
          ][index],
        })
      )
    );

    const winners = results.filter((result) => result.status === 'applied');
    expect(winners).toHaveLength(1);
    expect(results.filter((result) => result.status === 'conflict')).toEqual([
      {
        status: 'conflict',
        conflict: 'revision_mismatch',
        currentRevision: '1',
      },
      {
        status: 'conflict',
        conflict: 'revision_mismatch',
        currentRevision: '1',
      },
    ]);

    const sql = getDb();
    const agents = await sql`
      SELECT verbose_logging, user_md, mcp_servers
      FROM agents
      WHERE organization_id = ${ORGANIZATION_ID} AND id = ${AGENT_ID}
    `;
    const changedFields = [
      agents[0]?.verbose_logging === true,
      agents[0]?.user_md === 'race user winner',
      Object.hasOwn(agents[0]?.mcp_servers ?? {}, 'race'),
    ];
    expect(changedFields.filter(Boolean)).toHaveLength(1);
    const controls = await sql`
      SELECT configuration_revision
      FROM agent_configuration_controls
      WHERE organization_id = ${ORGANIZATION_ID} AND agent_id = ${AGENT_ID}
    `;
    expect(controls).toEqual([{ configuration_revision: 1 }]);
    const commands = await sql`
      SELECT command_id, resulting_revision, result_status
      FROM agent_configuration_commands
      WHERE organization_id = ${ORGANIZATION_ID} AND agent_id = ${AGENT_ID}
    `;
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ resulting_revision: 1, result_status: 'applied' });
    const winner = winners[0];
    if (winner?.status !== 'applied') throw new Error('Expected one applied winner');
    expect(commands[0]?.command_id).toBe(winner.state.lastMutation.commandId);
  });

  test('rolls back settings, control, and ledger when the transaction fails after settings update', async () => {
    const sql = getDb();
    await sql`
      INSERT INTO agent_configuration_controls (organization_id, agent_id)
      VALUES (${ORGANIZATION_ID}, ${AGENT_ID})
    `;
    await sql.unsafe(`
      CREATE OR REPLACE FUNCTION fail_agent_configuration_control_update_for_test()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'injected failure after agent settings update';
      END;
      $$
    `);
    await sql.unsafe(`
      CREATE TRIGGER fail_agent_configuration_control_update_for_test
      BEFORE UPDATE ON agent_configuration_controls
      FOR EACH ROW EXECUTE FUNCTION fail_agent_configuration_control_update_for_test()
    `);

    try {
      const authority = createAgentConfigurationAuthority();
      await expect(
        authority.apply({
          organizationId: ORGANIZATION_ID,
          agentId: AGENT_ID,
          commandId: 'native-command-rollback',
          expectedConfigurationRevision: '0',
          actor: { kind: 'session' },
          patch: { verboseLogging: true },
        })
      ).rejects.toThrow('injected failure after agent settings update');
    } finally {
      await sql.unsafe(`
        DROP TRIGGER IF EXISTS fail_agent_configuration_control_update_for_test
        ON agent_configuration_controls
      `);
      await sql.unsafe(`DROP FUNCTION IF EXISTS fail_agent_configuration_control_update_for_test()`);
    }

    const agents = await sql`
      SELECT verbose_logging
      FROM agents
      WHERE organization_id = ${ORGANIZATION_ID} AND id = ${AGENT_ID}
    `;
    expect(agents).toEqual([{ verbose_logging: false }]);
    const controls = await sql`
      SELECT configuration_revision, last_mutation_kind,
             last_command_id, last_command_digest
      FROM agent_configuration_controls
      WHERE organization_id = ${ORGANIZATION_ID} AND agent_id = ${AGENT_ID}
    `;
    expect(controls).toEqual([
      {
        configuration_revision: 0,
        last_mutation_kind: null,
        last_command_id: null,
        last_command_digest: null,
      },
    ]);
    const commands = await sql`
      SELECT command_id
      FROM agent_configuration_commands
      WHERE organization_id = ${ORGANIZATION_ID} AND agent_id = ${AGENT_ID}
    `;
    expect(commands).toEqual([]);
  });

  test('hashes the exact 17-field persistent projection and excludes credentials and runtime fields', async () => {
    const sql = getDb();
    const secondAgentId = 'native-authority-digest-peer';
    await seedAgentRow(secondAgentId, { organizationId: ORGANIZATION_ID });
    const modelSelection = { mode: 'pinned', pinnedModel: 'provider/model-alpha' };
    const providerModelPreferences = { provider: 'model-beta' };
    const networkConfig = { allowedDomains: ['digest.example'] };
    const nixConfig = { packages: ['jq'] };
    const mcpServers = { digest: { url: 'https://mcp.digest.example' } };
    const skillsConfig = { skills: [{ name: 'digest-skill', enabled: true }] };
    const toolsConfig = { allow: ['digest_tool'] };
    const pluginsConfig = { digestPlugin: { enabled: true } };
    const installedProviders = [{ providerId: 'digest-provider', authType: 'api-key' }];
    const preApprovedTools = ['/mcp/digest/tools/read'];
    const guardrails = ['secret-scan', 'pii-scan'];

    for (const [agentId, marker] of [
      [AGENT_ID, 'runtime-a'],
      [secondAgentId, 'runtime-b'],
    ] as const) {
      await sql`
        UPDATE agents SET
          model = NULL,
          model_selection = ${sql.json(modelSelection)},
          provider_model_preferences = ${sql.json(providerModelPreferences)},
          network_config = ${sql.json(networkConfig)},
          egress_config = NULL,
          nix_config = ${sql.json(nixConfig)},
          mcp_servers = ${sql.json(mcpServers)},
          soul_md = '',
          user_md = 'digest user instructions',
          identity_md = 'digest identity instructions',
          skills_config = ${sql.json(skillsConfig)},
          tools_config = ${sql.json(toolsConfig)},
          plugins_config = ${sql.json(pluginsConfig)},
          installed_providers = ${sql.json(installedProviders)},
          verbose_logging = false,
          pre_approved_tools = ${sql.json(preApprovedTools)},
          guardrails = ${sql.json(guardrails)},
          owner_user_id = ${marker},
          agent_integrations = ${sql.json({ runtimeMarker: marker })},
          skill_registries = ${sql.json([marker])},
          updated_at = ${marker === 'runtime-a' ? new Date('2001-01-01') : new Date('2002-02-02')}
        WHERE organization_id = ${ORGANIZATION_ID} AND id = ${agentId}
      `;
      await sql`
        INSERT INTO user_auth_profiles (user_id, agent_id, profiles)
        VALUES (
          ${`credential-user-${marker}`}, ${agentId},
          ${sql.json([{ provider: 'openai', credential: `credential-${marker}` }])}
        )
      `;
    }

    const expectedSettingsDigest = canonicalDigest({
      model: null,
      modelSelection,
      providerModelPreferences,
      networkConfig,
      egressConfig: {},
      nixConfig,
      mcpServers,
      soulMd: '',
      userMd: 'digest user instructions',
      identityMd: 'digest identity instructions',
      skillsConfig,
      toolsConfig,
      pluginsConfig,
      installedProviders,
      verboseLogging: true,
      preApprovedTools,
      guardrails,
    });
    const authority = createAgentConfigurationAuthority();
    const results = await Promise.all(
      [AGENT_ID, secondAgentId].map((agentId) =>
        authority.apply({
          organizationId: ORGANIZATION_ID,
          agentId,
          commandId: `native-command-digest-${agentId}`,
          expectedConfigurationRevision: '0',
          actor: { kind: 'session' },
          patch: { verboseLogging: true },
        })
      )
    );

    for (const result of results) {
      expect(result).toMatchObject({
        status: 'applied',
        state: { settingsDigest: expectedSettingsDigest },
      });
    }
    const commands = await sql`
      SELECT agent_id, resulting_settings_digest
      FROM agent_configuration_commands
      WHERE organization_id = ${ORGANIZATION_ID}
        AND agent_id IN (${AGENT_ID}, ${secondAgentId})
      ORDER BY agent_id
    `;
    expect(commands).toEqual([
      { agent_id: secondAgentId, resulting_settings_digest: expectedSettingsDigest },
      { agent_id: AGENT_ID, resulting_settings_digest: expectedSettingsDigest },
    ]);
    const ledgerRows = await sql`
      SELECT *
      FROM agent_configuration_commands
      WHERE organization_id = ${ORGANIZATION_ID}
        AND agent_id IN (${AGENT_ID}, ${secondAgentId})
    `;
    const serializedLedger = JSON.stringify(ledgerRows);
    expect(serializedLedger).not.toContain('credential-runtime-a');
    expect(serializedLedger).not.toContain('credential-runtime-b');
    expect(serializedLedger).not.toContain('runtimeMarker');
    expect(serializedLedger).not.toContain('runtime-a');
    expect(serializedLedger).not.toContain('runtime-b');
  });
});
