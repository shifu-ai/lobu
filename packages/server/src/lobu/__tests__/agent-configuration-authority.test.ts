import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { getDb } from '../../db/client';
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
  seedAgentRow,
} from '../../gateway/__tests__/helpers/db-setup';
import {
  type AgentConfigurationError,
  createAgentConfigurationAuthority,
  createNativePatchCommand,
} from '../agent-configuration';

const AGENT_ID = 'native-authority-tracer';
const ORGANIZATION_ID = 'native-authority-org';

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
    const command = createNativePatchCommand({
      organizationId: ORGANIZATION_ID,
      agentId: AGENT_ID,
      commandId: 'native-command-1',
      expectedConfigurationRevision: '0',
      actor: { kind: 'admin_pat' },
      patch: { verboseLogging: true },
    });

    const result = await authority.apply(command);

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
          commandDigest: command.commandDigest,
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
        last_command_digest: command.commandDigest,
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
        command_digest: command.commandDigest,
        mutation_kind: 'native_patch',
        resulting_revision: 1,
        resulting_mode: 'native',
        resulting_settings_digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        result_status: 'applied',
      },
    ]);
  });

  test('replays the original result and rejects command id reuse with different content', async () => {
    const authority = createAgentConfigurationAuthority();
    const command = createNativePatchCommand({
      organizationId: ORGANIZATION_ID,
      agentId: AGENT_ID,
      commandId: 'native-command-replay',
      expectedConfigurationRevision: '0',
      actor: { kind: 'session' },
      patch: { verboseLogging: true },
    });

    expect((await authority.apply(command)).status).toBe('applied');
    await expect(authority.apply(command)).resolves.toMatchObject({
      status: 'already_applied',
      state: { configurationRevision: '1' },
    });

    const conflictingCommand = createNativePatchCommand({
      ...command,
      patch: { verboseLogging: false },
    });
    await expect(authority.apply(conflictingCommand)).rejects.toMatchObject({
      code: 'agent_configuration_command_conflict',
      currentRevision: '1',
    } satisfies Partial<AgentConfigurationError>);

    const receipts = await getDb()`
      SELECT result_status
      FROM agent_configuration_commands
      WHERE organization_id = ${ORGANIZATION_ID} AND agent_id = ${AGENT_ID}
    `;
    expect(receipts).toEqual([{ result_status: 'applied' }]);
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
    const command = createNativePatchCommand({
      organizationId: ORGANIZATION_ID,
      agentId: AGENT_ID,
      commandId: 'native-command-large-revision',
      expectedConfigurationRevision: '9007199254740993',
      actor: { kind: 'session' },
      patch: { verboseLogging: true },
    });

    await expect(authority.apply(command)).resolves.toMatchObject({
      status: 'applied',
      state: { configurationRevision: '9007199254740994' },
    });
  });
});
