import { createHash } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { canonicalize } from 'json-canonicalize';
import { type DbClient, getDb } from '../../db/client';
import logger from '../../utils/logger';
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
  seedAgentRow,
} from '../../gateway/__tests__/helpers/db-setup';
import { createAgentConfigurationAuthority } from '../agent-configuration';
import { parseNativeSettingsPatch } from '../agent-configuration/field-ownership';

const AGENT_ID = 'native-authority-tracer';
const ORGANIZATION_ID = 'native-authority-org';
const TOOLBOX_USER_ID = 'toolbox-user-managed-enrollment';
const ENROLLMENT_CAPABILITY_ID = 'agent_configuration_authority.v1';

function canonicalDigest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalize(value)).digest('hex')}`;
}

function enrollmentSnapshot(
  overrides: Partial<{
    environment: 'staging' | 'production';
    toolboxUserId: string;
    agentId: string;
    capabilities: string[];
    appliedReleaseId: string;
    appliedReleaseSequence: number;
    expiresAt: string;
  }> = {}
) {
  const unsigned = {
    schemaVersion: 1 as const,
    environment: overrides.environment ?? ('production' as const),
    toolboxUserId: overrides.toolboxUserId ?? TOOLBOX_USER_ID,
    agentId: overrides.agentId ?? AGENT_ID,
    capabilities: overrides.capabilities ?? [ENROLLMENT_CAPABILITY_ID],
    appliedReleaseId: overrides.appliedReleaseId ?? 'agent-release-enrollment-7',
    appliedReleaseSequence: overrides.appliedReleaseSequence ?? 7,
    expiresAt: overrides.expiresAt ?? new Date(Date.now() + 30_000).toISOString(),
  };
  return { ...unsigned, snapshotDigest: canonicalDigest(unsigned) };
}

async function seedAppliedEnrollmentRelease(
  input: { status?: 'applying' | 'applied' | 'failed' } = {}
): Promise<`sha256:${string}`> {
  const sql = getDb();
  const managedSettings = {
    identityMd: 'managed identity',
    soulMd: 'managed soul',
    userMd: 'managed user',
    modelSelection: { mode: 'auto' },
    toolsConfig: { strictMode: true },
  };
  const settingsHash = canonicalDigest(managedSettings);
  await sql`
    UPDATE agents SET
      owner_user_id = ${TOOLBOX_USER_ID},
      identity_md = ${managedSettings.identityMd},
      soul_md = ${managedSettings.soulMd},
      user_md = ${managedSettings.userMd},
      model_selection = ${sql.json(managedSettings.modelSelection)},
      tools_config = ${sql.json(managedSettings.toolsConfig)}
    WHERE organization_id = ${ORGANIZATION_ID} AND id = ${AGENT_ID}
  `;
  await sql`
    INSERT INTO agent_release_applies (
      organization_id, agent_id, environment,
      desired_release_id, desired_release_sequence, desired_feed_sequence,
      applied_release_id, applied_release_sequence, applied_feed_sequence,
      applied_channel, applied_feed_digest, manifest_digest, status,
      revision_ref, settings_hash
    ) VALUES (
      ${ORGANIZATION_ID}, ${AGENT_ID}, 'production',
      'agent-release-enrollment-7', 7, 11,
      'agent-release-enrollment-7', 7, 11,
      'candidate', ${canonicalDigest({ feed: 11 })}, ${canonicalDigest({ release: 7 })},
      ${input.status ?? 'applied'}, 'lobu:managed-enrollment:7', ${settingsHash}
    )
  `;
  return settingsHash;
}

function enrollmentCommand(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: ORGANIZATION_ID,
    agentId: AGENT_ID,
    commandId: 'managed-enrollment-command-1',
    expectedConfigurationRevision: '0',
    actor: { kind: 'admin_pat' as const },
    toolboxUserId: TOOLBOX_USER_ID,
    environment: 'production' as const,
    runtimeEnvironment: 'production' as const,
    snapshot: enrollmentSnapshot(),
    ...overrides,
  };
}

function createTransactionStartBarrier(participantCount: number) {
  let arrivals = 0;
  let releaseTransactions!: () => void;
  let reportAllArrived!: () => void;
  const released = new Promise<void>((resolve) => {
    releaseTransactions = resolve;
  });
  const allArrived = new Promise<void>((resolve) => {
    reportAllArrived = resolve;
  });

  return {
    async checkpoint() {
      arrivals += 1;
      if (arrivals === participantCount) reportAllArrived();
      await released;
    },
    allArrived,
    release: releaseTransactions,
    get arrivals() {
      return arrivals;
    },
  };
}

function withTransactionStartCheckpoint(
  sql: DbClient,
  checkpoint: () => Promise<void>
): DbClient {
  return new Proxy(sql, {
    get(target, property, receiver) {
      if (property === 'begin') {
        return <T>(fn: (tx: DbClient) => Promise<T>) =>
          target.begin(async (tx) => {
            await checkpoint();
            return fn(tx);
          });
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

describe('AgentConfigurationAuthority', () => {
  beforeAll(async () => {
    await ensureDbForGatewayTests();
  });

  beforeEach(async () => {
    await resetTestDatabase();
    await seedAgentRow(AGENT_ID, { organizationId: ORGANIZATION_ID });
  });

  test('rejects a stale initial bootstrap revision and rolls back the placeholder agent', async () => {
    const agentId = 'native-bootstrap-stale-create';

    await expect(
      createAgentConfigurationAuthority().bootstrap({
        kind: 'bootstrap',
        profile: 'native',
        organizationId: ORGANIZATION_ID,
        agentId,
        commandId: 'native-bootstrap-stale-create-command',
        expectedConfigurationRevision: '1',
        actor: { kind: 'admin_pat' },
        name: 'Stale bootstrap',
        settings: { identityMd: 'stale bootstrap identity' },
        requestDigest: canonicalDigest({ request: 'stale bootstrap create' }),
        ownerPlatform: 'lobu',
        ownerUserId: null,
      })
    ).rejects.toMatchObject({
      code: 'agent_configuration_revision_mismatch',
      currentRevision: '0',
    });

    const agents = await getDb()`
      SELECT id FROM agents
      WHERE organization_id = ${ORGANIZATION_ID} AND id = ${agentId}
    `;
    expect(agents).toEqual([]);
  });

  test('rejects exact fence replay when the command durable effects changed', async () => {
    const authority = createAgentConfigurationAuthority();
    const agentId = 'toolbox-fence-command-conflict';
    const command = {
      kind: 'bootstrap' as const,
      profile: 'toolbox_personal' as const,
      organizationId: ORGANIZATION_ID,
      agentId,
      commandId: 'toolbox-fence-command-conflict:1',
      expectedConfigurationRevision: '0',
      actor: { kind: 'provisioning' as const },
      name: 'Fenced bootstrap',
      ownerUserId: 'toolbox-fence-owner',
      patUserId: 'toolbox-fence-pat',
      membershipId: 'toolbox-fence-member',
      ownerEmail: 'toolbox-fence-owner@example.invalid',
      fence: {
        targetId: 'a49ef354-e14f-4b42-a030-bd5f9a78f17f',
        claimGeneration: 1,
        claimToken: '02a3b3ca-e30a-4c3f-8317-2a5da9b4a52a',
        baselineVersionId: `personal-agent-baseline-v1-${'a'.repeat(64)}`,
        effectiveSettingsDigest: canonicalDigest({ settings: 'generation-one' }),
      },
      requestDigest: canonicalDigest({ request: 'generation-one' }),
    };

    await authority.bootstrap({
      ...command,
      settings: { userMd: 'generation one' },
    });

    await expect(
      authority.bootstrap({
        ...command,
        settings: { userMd: 'altered behind the same fence identity' },
      })
    ).rejects.toMatchObject({
      code: 'agent_configuration_command_conflict',
      currentRevision: '1',
    });
  });

  test('enforces a supplied bootstrap revision after compatibility replay checks', async () => {
    const authority = createAgentConfigurationAuthority();
    const agentId = 'toolbox-bootstrap-stale-revision';
    const base = {
      kind: 'bootstrap' as const,
      profile: 'toolbox_personal' as const,
      organizationId: ORGANIZATION_ID,
      agentId,
      actor: { kind: 'provisioning' as const },
      name: 'Compatibility bootstrap',
      ownerUserId: 'toolbox-bootstrap-owner',
      patUserId: 'toolbox-bootstrap-pat',
      membershipId: 'toolbox-bootstrap-member',
      ownerEmail: 'toolbox-bootstrap-owner@example.invalid',
    };

    await authority.bootstrap({
      ...base,
      commandId: 'toolbox-bootstrap-compatible-first',
      settings: { userMd: 'revision one' },
      requestDigest: canonicalDigest({ request: 'compatible-first' }),
    });

    await expect(
      authority.bootstrap({
        ...base,
        commandId: 'toolbox-bootstrap-stale-second',
        expectedConfigurationRevision: '0',
        settings: { userMd: 'must not overwrite revision one' },
        requestDigest: canonicalDigest({ request: 'stale-second' }),
      })
    ).rejects.toMatchObject({
      code: 'agent_configuration_revision_mismatch',
      currentRevision: '1',
    });

    const rows = await getDb()`
      SELECT user_md FROM agents
      WHERE organization_id = ${ORGANIZATION_ID} AND id = ${agentId}
    `;
    expect(rows).toEqual([{ user_md: 'revision one' }]);
  });

  test('enrolls a fresh exact applied release claim and persists a monotonic command receipt', async () => {
    const settingsHash = await seedAppliedEnrollmentRelease();
    const result = await createAgentConfigurationAuthority().enrollToolboxManaged(
      enrollmentCommand()
    );

    expect(result).toMatchObject({
      status: 'applied',
      state: {
        managementMode: 'toolbox_managed',
        configurationRevision: '1',
        settingsDigest: settingsHash,
        lastMutation: {
          kind: 'managed_enrollment',
          commandId: 'managed-enrollment-command-1',
        },
      },
    });
    const rows = await getDb()`
      SELECT c.management_mode, c.configuration_revision, c.last_mutation_kind,
             command_row.mutation_kind, command_row.resulting_mode,
             command_row.resulting_revision, command_row.resulting_settings_digest
      FROM agent_configuration_controls c
      JOIN agent_configuration_commands command_row
        ON command_row.organization_id = c.organization_id
       AND command_row.agent_id = c.agent_id
      WHERE c.organization_id = ${ORGANIZATION_ID} AND c.agent_id = ${AGENT_ID}
    `;
    expect(rows).toEqual([{
      management_mode: 'toolbox_managed',
      configuration_revision: 1,
      last_mutation_kind: 'managed_enrollment',
      mutation_kind: 'managed_enrollment',
      resulting_mode: 'toolbox_managed',
      resulting_revision: 1,
      resulting_settings_digest: settingsHash,
    }]);
  });

  test('replays enrollment across claim renewal before freshness checks and rejects semantic command reuse', async () => {
    await seedAppliedEnrollmentRelease();
    const authority = createAgentConfigurationAuthority();
    const command = enrollmentCommand();
    expect((await authority.enrollToolboxManaged(command)).status).toBe('applied');
    await expect(authority.enrollToolboxManaged({
      ...command,
      expectedConfigurationRevision: '0',
      snapshot: { ...command.snapshot, expiresAt: '2000-01-01T00:00:00.000Z' },
    })).resolves.toMatchObject({
      status: 'already_applied',
      state: { managementMode: 'toolbox_managed', configurationRevision: '1' },
    });
    await expect(authority.enrollToolboxManaged({
      ...command,
      snapshot: enrollmentSnapshot({ appliedReleaseId: 'agent-release-enrollment-8' }),
    })).resolves.toMatchObject({
      status: 'conflict',
      conflict: 'command_conflict',
      currentRevision: '1',
    });
    await expect(authority.enrollToolboxManaged(command)).resolves.toMatchObject({
      status: 'already_applied',
      state: { managementMode: 'toolbox_managed', configurationRevision: '1' },
    });

    const commands = await getDb()`
      SELECT command_id FROM agent_configuration_commands
      WHERE organization_id = ${ORGANIZATION_ID} AND agent_id = ${AGENT_ID}
    `;
    expect(commands).toEqual([{ command_id: 'managed-enrollment-command-1' }]);
  });

  test('returns a semantic no-op for another command after enrollment without a new receipt', async () => {
    await seedAppliedEnrollmentRelease();
    const authority = createAgentConfigurationAuthority();
    await authority.enrollToolboxManaged(enrollmentCommand());

    await expect(authority.enrollToolboxManaged(enrollmentCommand({
      commandId: 'managed-enrollment-command-2',
      expectedConfigurationRevision: '1',
    }))).resolves.toEqual({
      status: 'already_managed',
      managementMode: 'toolbox_managed',
      configurationRevision: '1',
    });
    const controls = await getDb()`
      SELECT management_mode, configuration_revision, last_command_id
      FROM agent_configuration_controls
      WHERE organization_id = ${ORGANIZATION_ID} AND agent_id = ${AGENT_ID}
    `;
    expect(controls).toEqual([{
      management_mode: 'toolbox_managed',
      configuration_revision: 1,
      last_command_id: 'managed-enrollment-command-1',
    }]);
    expect((await getDb()`
      SELECT count(*)::int AS count FROM agent_configuration_commands
      WHERE organization_id = ${ORGANIZATION_ID} AND agent_id = ${AGENT_ID}
    `)[0]?.count).toBe(1);
  });

  test.each([
    ['capability absent', { snapshot: enrollmentSnapshot({ capabilities: ['other.v1'] }) }, 'capability_inactive'],
    ['release id mismatch', { snapshot: enrollmentSnapshot({ appliedReleaseId: 'agent-release-enrollment-8' }) }, 'stale_release'],
    ['release sequence mismatch', { snapshot: enrollmentSnapshot({ appliedReleaseSequence: 8 }) }, 'stale_release'],
    ['Toolbox user mismatch', { snapshot: enrollmentSnapshot({ toolboxUserId: 'another-toolbox-user' }) }, 'invalid_release'],
    ['agent mismatch', { snapshot: enrollmentSnapshot({ agentId: 'shifu-u-another-agent' }) }, 'invalid_release'],
    ['claim environment mismatch', { snapshot: enrollmentSnapshot({ environment: 'staging' }) }, 'environment_mismatch'],
    ['requested Toolbox owner mismatch', { toolboxUserId: 'another-toolbox-user' }, 'invalid_release'],
    ['runtime environment mismatch', { runtimeEnvironment: 'staging' }, 'environment_mismatch'],
  ])('rejects %s without mutating durable mode', async (_name, overrides, reason) => {
    await seedAppliedEnrollmentRelease();
    const result = await createAgentConfigurationAuthority().enrollToolboxManaged(
      enrollmentCommand(overrides as Record<string, unknown>)
    );
    expect(result).toEqual({ status: 'rejected', reason });
    expect((await getDb()`
      SELECT management_mode, configuration_revision
      FROM agent_configuration_controls
      WHERE organization_id = ${ORGANIZATION_ID} AND agent_id = ${AGENT_ID}
    `)[0]).toEqual({ management_mode: 'native', configuration_revision: 0 });
  });

  test('fails closed for a stale claim, a non-applied receipt, and live managed-settings drift', async () => {
    await seedAppliedEnrollmentRelease();
    const authority = createAgentConfigurationAuthority();
    await expect(authority.enrollToolboxManaged(enrollmentCommand({
      snapshot: enrollmentSnapshot({ expiresAt: '2000-01-01T00:00:00.000Z' }),
    }))).resolves.toEqual({ status: 'rejected', reason: 'stale_release' });

    await getDb()`
      UPDATE agent_release_applies SET status = 'applying'
      WHERE organization_id = ${ORGANIZATION_ID} AND agent_id = ${AGENT_ID}
    `;
    await expect(authority.enrollToolboxManaged(enrollmentCommand({
      commandId: 'managed-enrollment-non-applied',
    }))).resolves.toEqual({ status: 'rejected', reason: 'stale_release' });

    await getDb()`
      UPDATE agent_release_applies SET status = 'applied'
      WHERE organization_id = ${ORGANIZATION_ID} AND agent_id = ${AGENT_ID}
    `;
    await getDb()`
      UPDATE agents SET user_md = 'drifted after release apply'
      WHERE organization_id = ${ORGANIZATION_ID} AND id = ${AGENT_ID}
    `;
    await expect(authority.enrollToolboxManaged(enrollmentCommand({
      commandId: 'managed-enrollment-drifted',
    }))).resolves.toEqual({ status: 'rejected', reason: 'enrollment_drifted' });
    expect((await getDb()`
      SELECT management_mode, configuration_revision
      FROM agent_configuration_controls
      WHERE organization_id = ${ORGANIZATION_ID} AND agent_id = ${AGENT_ID}
    `)[0]).toEqual({ management_mode: 'native', configuration_revision: 0 });
  });

  test('rejects a receipt whose effective managed baseline digest disagrees with settings truth', async () => {
    await seedAppliedEnrollmentRelease();
    await getDb()`
      UPDATE agent_release_applies
      SET personal_baseline_effective_settings_digest = ${`sha256:${'e'.repeat(64)}`}
      WHERE organization_id = ${ORGANIZATION_ID} AND agent_id = ${AGENT_ID}
    `;

    await expect(
      createAgentConfigurationAuthority().enrollToolboxManaged(enrollmentCommand())
    ).resolves.toEqual({ status: 'rejected', reason: 'enrollment_drifted' });
    expect((await getDb()`
      SELECT management_mode, configuration_revision
      FROM agent_configuration_controls
      WHERE organization_id = ${ORGANIZATION_ID} AND agent_id = ${AGENT_ID}
    `)[0]).toEqual({ management_mode: 'native', configuration_revision: 0 });
  });

  test('serializes enrollment against a native release-owned patch across independent authorities', async () => {
    await seedAppliedEnrollmentRelease();
    const barrier = createTransactionStartBarrier(2);
    const sql = getDb();
    const enrollmentAuthority = createAgentConfigurationAuthority(
      withTransactionStartCheckpoint(sql, barrier.checkpoint)
    );
    const nativeAuthority = createAgentConfigurationAuthority(
      withTransactionStartCheckpoint(sql, barrier.checkpoint)
    );
    const participants = Promise.all([
      enrollmentAuthority.enrollToolboxManaged(enrollmentCommand()),
      nativeAuthority.apply({
        organizationId: ORGANIZATION_ID,
        agentId: AGENT_ID,
        commandId: 'native-user-md-racing-enrollment',
        expectedConfigurationRevision: '0',
        actor: { kind: 'session' },
        patch: { userMd: 'native write must not land after enrollment' },
      }),
    ]);
    const allTransactionsStarted = await Promise.race([
      barrier.allArrived.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
    ]);
    barrier.release();
    const [enrollment, nativePatch] = await participants;

    expect(allTransactionsStarted).toBe(true);
    expect(barrier.arrivals).toBe(2);
    const row = (await sql`
      SELECT a.user_md, c.management_mode, c.configuration_revision
      FROM agents a
      JOIN agent_configuration_controls c
        ON c.organization_id = a.organization_id AND c.agent_id = a.id
      WHERE a.organization_id = ${ORGANIZATION_ID} AND a.id = ${AGENT_ID}
    `)[0];
    if (nativePatch.status === 'applied') {
      expect(enrollment).toMatchObject({
        status: 'conflict',
        conflict: 'revision_mismatch',
      });
      expect(row).toEqual({
        user_md: 'native write must not land after enrollment',
        management_mode: 'native',
        configuration_revision: 1,
      });
    } else {
      expect(enrollment).toMatchObject({ status: 'applied' });
      expect(nativePatch.status === 'rejected' || nativePatch.status === 'conflict').toBe(true);
      expect(row).toEqual({
        user_md: 'managed user',
        management_mode: 'toolbox_managed',
        configuration_revision: 1,
      });
    }
  });

  test('persists one native patch, revision control, and command receipt atomically', async () => {
    const authority = createAgentConfigurationAuthority();
    expect(typeof authority.applyManagedRelease).toBe('function');
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

  test('digests explicit null resets as the exact repository default persisted', async () => {
    const sql = getDb();
    await sql`
      UPDATE agents SET identity_md = 'before reset'
      WHERE organization_id = ${ORGANIZATION_ID} AND id = ${AGENT_ID}
    `;
    const commandId = 'native-command-null-reset-digest';
    const expectedDigest = canonicalDigest({
      kind: 'native_patch',
      agentId: AGENT_ID,
      expectedRevision: '0',
      patch: { identityMd: '' },
    });

    const result = await createAgentConfigurationAuthority().apply({
      organizationId: ORGANIZATION_ID,
      agentId: AGENT_ID,
      commandId,
      expectedConfigurationRevision: '0',
      actor: { kind: 'session' },
      patch: { identityMd: null },
    });

    expect(result).toMatchObject({
      status: 'applied',
      state: { lastMutation: { commandDigest: expectedDigest } },
    });
    expect((await sql`
      SELECT identity_md FROM agents
      WHERE organization_id = ${ORGANIZATION_ID} AND id = ${AGENT_ID}
    `)[0]?.identity_md).toBe('');
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

  test.each([
    ['model', 'model', null, null],
    ['modelSelection', 'model_selection', { mode: 'auto' }, { mode: 'auto' }],
    ['providerModelPreferences', 'provider_model_preferences', {}, {}],
    ['networkConfig', 'network_config', {}, {}],
    ['egressConfig', 'egress_config', { extraPolicy: '' }, { extraPolicy: '' }],
    ['nixConfig', 'nix_config', { packages: [] }, { packages: [] }],
    ['mcpServers', 'mcp_servers', {}, {}],
    ['soulMd', 'soul_md', '', ''],
    ['userMd', 'user_md', 'updated user', 'updated user'],
    ['identityMd', 'identity_md', null, ''],
    ['skillsConfig', 'skills_config', { skills: [] }, { skills: [] }],
    ['toolsConfig', 'tools_config', {}, {}],
    ['pluginsConfig', 'plugins_config', { plugins: [] }, { plugins: [] }],
    ['installedProviders', 'installed_providers', [], []],
    ['verboseLogging', 'verbose_logging', false, false],
    ['preApprovedTools', 'pre_approved_tools', null, []],
    ['guardrails', 'guardrails', [], []],
  ])(
    'maps %s only to its persistent SQL column',
    async (field, column, patchValue, expectedValue) => {
      const sql = getDb();
      const sentinelRow = {
        model: 'sentinel-model',
        model_selection: { mode: 'pinned', pinnedModel: 'sentinel/model' },
        provider_model_preferences: { sentinel: 'model' },
        network_config: { allowedDomains: ['sentinel.example'] },
        egress_config: { extraPolicy: 'sentinel policy' },
        nix_config: { packages: ['sentinel-package'] },
        mcp_servers: { sentinel: { url: 'https://sentinel.example' } },
        soul_md: 'sentinel soul',
        user_md: 'sentinel user',
        identity_md: 'sentinel identity',
        skills_config: {
          skills: [{ repo: 'sentinel/repo', name: 'sentinel', enabled: true }],
        },
        tools_config: { strictMode: true },
        plugins_config: {
          plugins: [{ source: 'sentinel-plugin', slot: 'tool' }],
        },
        installed_providers: [{ providerId: 'sentinel', installedAt: 1 }],
        verbose_logging: true,
        pre_approved_tools: ['sentinel-tool'],
        guardrails: ['sentinel-guardrail'],
      };
      await sql`
        UPDATE agents SET
          model = ${sentinelRow.model},
          model_selection = ${sql.json(sentinelRow.model_selection)},
          provider_model_preferences = ${sql.json(sentinelRow.provider_model_preferences)},
          network_config = ${sql.json(sentinelRow.network_config)},
          egress_config = ${sql.json(sentinelRow.egress_config)},
          nix_config = ${sql.json(sentinelRow.nix_config)},
          mcp_servers = ${sql.json(sentinelRow.mcp_servers)},
          soul_md = ${sentinelRow.soul_md},
          user_md = ${sentinelRow.user_md},
          identity_md = ${sentinelRow.identity_md},
          skills_config = ${sql.json(sentinelRow.skills_config)},
          tools_config = ${sql.json(sentinelRow.tools_config)},
          plugins_config = ${sql.json(sentinelRow.plugins_config)},
          installed_providers = ${sql.json(sentinelRow.installed_providers)},
          verbose_logging = ${sentinelRow.verbose_logging},
          pre_approved_tools = ${sql.json(sentinelRow.pre_approved_tools)},
          guardrails = ${sql.json(sentinelRow.guardrails)}
        WHERE organization_id = ${ORGANIZATION_ID} AND id = ${AGENT_ID}
      `;

      const result = await createAgentConfigurationAuthority().apply({
        organizationId: ORGANIZATION_ID,
        agentId: AGENT_ID,
        commandId: `native-column-${field}`,
        expectedConfigurationRevision: '0',
        actor: { kind: 'session' },
        patch: parseNativeSettingsPatch({ [field]: patchValue }),
      });
      expect(result.status).toBe('applied');

      const rows = await sql`
        SELECT model, model_selection, provider_model_preferences,
               network_config, egress_config, nix_config, mcp_servers,
               soul_md, user_md, identity_md, skills_config, tools_config,
               plugins_config, installed_providers, verbose_logging,
               pre_approved_tools, guardrails
        FROM agents
        WHERE organization_id = ${ORGANIZATION_ID} AND id = ${AGENT_ID}
      `;
      expect(rows).toEqual([{ ...sentinelRow, [column]: expectedValue }]);
    }
  );

  test('rejects release-owned fields in toolbox_managed mode but permits operator fields', async () => {
    const sql = getDb();
    await sql`
      INSERT INTO agent_configuration_controls (
        organization_id, agent_id, management_mode
      ) VALUES (${ORGANIZATION_ID}, ${AGENT_ID}, 'toolbox_managed')
    `;
    const authority = createAgentConfigurationAuthority();
    const warnSpy = spyOn(logger, 'warn').mockImplementation(() => undefined);

    try {
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
      expect(warnSpy).toHaveBeenCalledWith(
        {
          organizationId: ORGANIZATION_ID,
          agentId: AGENT_ID,
          managementMode: 'toolbox_managed',
          legacyRejectedFields: [],
          policyRejectedFields: ['model', 'identityMd'],
        },
        'shadow_decision_mismatch'
      );
    } finally {
      warnSpy.mockRestore();
    }

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
    const transactionBarrier = createTransactionStartBarrier(3);
    const sql = getDb();
    const authorities = Array.from({ length: 3 }, () =>
      createAgentConfigurationAuthority(
        withTransactionStartCheckpoint(sql, transactionBarrier.checkpoint)
      )
    );
    const applying = Promise.all(
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
    const allTransactionsStarted = await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), 5_000);
      void transactionBarrier.allArrived.then(() => {
        clearTimeout(timeout);
        resolve(true);
      });
    });
    transactionBarrier.release();
    const results = await applying;

    expect(allTransactionsStarted).toBe(true);
    expect(transactionBarrier.arrivals).toBe(3);

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
