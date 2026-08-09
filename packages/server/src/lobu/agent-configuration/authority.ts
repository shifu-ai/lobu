import { createHash } from 'node:crypto';
import { canonicalize } from 'json-canonicalize';
import type { DbClient } from '../../db/client';
import { getDb } from '../../db/client';
import logger from '../../utils/logger';
import {
  AgentReleaseError,
  type createAgentReleaseService,
  type PreparedAgentReleaseApply,
} from '../agent-release-service';
import {
  type AgentConfigurationBootstrapOptions,
  createAgentConfigurationBootstrap,
} from './bootstrap';
import { AgentConfigurationError } from './errors';
import {
  LEGACY_MANAGED_RELEASE_SETTING_KEYS,
  PERSONAL_BASELINE_RELEASE_SETTING_KEYS,
} from './field-ownership';
import { materializeNativePatchCommand } from './native-patch';
import {
  applyNativePatchInTransaction,
  enrollToolboxManagedInTransaction,
  findConfigurationCommand,
  lockAgentAndConfigurationControl,
  readAgentConfigurationSettingsDigest,
  recordManagedReleaseConfigurationMutation,
} from './postgres-repository';
import { AGENT_CONFIGURATION_RESPONSE_VERSION } from './types';
import type {
  AgentConfigurationBootstrapResult,
  AgentConfigurationMutationResult,
  ApplyBootstrapConfigurationInput,
  AgentConfigurationEnrollmentResult,
  AppliedAgentConfigurationState,
  BootstrapAgentConfigurationState,
  ManagedReleaseCommandInput,
  ManagedReleaseConfigurationResult,
  ManagedEnrollmentCommand,
  NativePatchCommandInput,
  EnrollToolboxManagedInput,
  Sha256Digest,
} from './types';

const DECIMAL_REVISION_PATTERN = /^(0|[1-9][0-9]*)$/;

export interface AgentConfigurationAuthority {
  bootstrap(input: ApplyBootstrapConfigurationInput): Promise<AgentConfigurationBootstrapResult>;
  apply(input: NativePatchCommandInput): Promise<AgentConfigurationMutationResult>;
  readAppliedState(input: {
    organizationId: string;
    agentId: string;
  }): Promise<BootstrapAgentConfigurationState | null>;
  enrollToolboxManaged(
    input: EnrollToolboxManagedInput,
  ): Promise<AgentConfigurationEnrollmentResult>;
  applyManagedRelease(
    input: ManagedReleaseCommandInput,
  ): Promise<ManagedReleaseConfigurationResult>;
  readConfigurationControl(input: { organizationId: string; agentId: string }): Promise<{
    managementMode: 'native' | 'toolbox_managed';
    configurationRevision: string;
  }>;
  readManagedRelease(input: { organizationId: string; agentId: string }): Promise<{
    evidence: Awaited<ReturnType<AgentReleaseService['getEvidence']>>;
    state: {
      managementMode: 'native' | 'toolbox_managed';
      configurationRevision: string;
    };
  }>;
}

type AgentReleaseService = ReturnType<typeof createAgentReleaseService>;

const RELEASE_LEGACY_SETTING_KEYS = new Set(LEGACY_MANAGED_RELEASE_SETTING_KEYS);
const RELEASE_BASELINE_SETTING_KEYS = new Set([
  ...PERSONAL_BASELINE_RELEASE_SETTING_KEYS,
  'templateKey',
  'scope',
  'baselinePrompt',
  'runtimeConfig',
]);
const SAFE_OBSERVABILITY_FIELD_NAMES = new Set([
  ...RELEASE_LEGACY_SETTING_KEYS,
  ...RELEASE_BASELINE_SETTING_KEYS,
  'providerModelPreferences',
  'networkConfig',
  'egressConfig',
  'nixConfig',
  'mcpServers',
  'skillsConfig',
  'pluginsConfig',
  'installedProviders',
  'verboseLogging',
  'preApprovedTools',
  'guardrails',
  'managementMode',
]);

function safeChangedFieldNames(value: object): string[] {
  return Object.keys(value)
    .filter((field) => SAFE_OBSERVABILITY_FIELD_NAMES.has(field))
    .sort();
}

function rejectedMutationStatus(error: unknown): 'rejected' | 'failed' {
  return error instanceof AgentConfigurationError || error instanceof AgentReleaseError
    ? 'rejected'
    : 'failed';
}

function configurationRevisionFromResult(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const record = result as Record<string, unknown>;
  const state = record.state;
  if (state && typeof state === 'object') {
    const revision = (state as Record<string, unknown>).configurationRevision;
    if (typeof revision === 'string') return revision;
  }
  if (typeof record.configurationRevision === 'string') return record.configurationRevision;
  if (typeof record.currentRevision === 'string') return record.currentRevision;
  return null;
}

function mutationStatus(result: unknown): string {
  if (!result || typeof result !== 'object') return 'failed';
  const status = (result as Record<string, unknown>).status;
  return typeof status === 'string' ? status : 'failed';
}

function logConfigurationMutation(input: {
  organizationId: string;
  agentId: string;
  mutationKind: string;
  status: string;
  previousRevision: string | null;
  resultingRevision: string | null;
  commandId: string;
  changedFieldNames: string[];
}): void {
  logger.info(input, 'agent configuration mutation');
}

function materializeManagedEnrollmentCommand(
  input: EnrollToolboxManagedInput,
): ManagedEnrollmentCommand {
  if (!DECIMAL_REVISION_PATTERN.test(input.expectedConfigurationRevision)) {
    throw new AgentConfigurationError('invalid_revision_precondition');
  }
  const snapshot = JSON.parse(canonicalize(input.snapshot)) as typeof input.snapshot;
  const canonicalCommand = {
    kind: 'managed_enrollment',
    agentId: input.agentId,
    toolboxUserId: input.toolboxUserId,
    environment: input.environment,
    runtimeEnvironment: input.runtimeEnvironment,
    expectedRevision: input.expectedConfigurationRevision,
    claim: {
      schemaVersion: snapshot.schemaVersion,
      environment: snapshot.environment,
      toolboxUserId: snapshot.toolboxUserId,
      agentId: snapshot.agentId,
      capabilities: [...snapshot.capabilities].sort(),
      appliedReleaseId: snapshot.appliedReleaseId,
      appliedReleaseSequence: snapshot.appliedReleaseSequence,
    },
  };
  return {
    organizationId: input.organizationId,
    agentId: input.agentId,
    commandId: input.commandId,
    commandDigest: sha256Canonical(canonicalCommand),
    expectedConfigurationRevision: input.expectedConfigurationRevision,
    actor: input.actor,
    toolboxUserId: input.toolboxUserId,
    environment: input.environment,
    runtimeEnvironment: input.runtimeEnvironment,
    snapshot,
    kind: 'managed_enrollment',
  };
}

export function createAgentConfigurationAuthority(
  sql?: DbClient,
  options: {
    agentReleaseService?: AgentReleaseService;
    readHooks?: { afterEvidenceRead?: () => Promise<void> };
    transactionHooks?: { beforeAgentLock?: () => Promise<void> };
    bootstrapTransactionHooks?: { afterAgentLock?: () => Promise<void> };
    lifecycleRecorder?: AgentConfigurationBootstrapOptions['lifecycleRecorder'];
  } = {},
): AgentConfigurationAuthority {
  const bootstrap = createAgentConfigurationBootstrap(sql, {
    transactionHooks: options.bootstrapTransactionHooks,
    lifecycleRecorder: options.lifecycleRecorder,
  });
  return {
    async bootstrap(input) {
      try {
        const result = await bootstrap.apply(input);
        logConfigurationMutation({
          organizationId: input.organizationId,
          agentId: input.agentId,
          mutationKind: 'bootstrap',
          status: mutationStatus(result),
          previousRevision: input.expectedConfigurationRevision ?? null,
          resultingRevision: configurationRevisionFromResult(result),
          commandId: input.commandId,
          changedFieldNames: safeChangedFieldNames(input.settings),
        });
        return result;
      } catch (error) {
        logConfigurationMutation({
          organizationId: input.organizationId,
          agentId: input.agentId,
          mutationKind: 'bootstrap',
          status: rejectedMutationStatus(error),
          previousRevision: input.expectedConfigurationRevision ?? null,
          resultingRevision:
            error instanceof AgentConfigurationError ? error.currentRevision ?? null : null,
          commandId: input.commandId,
          changedFieldNames: safeChangedFieldNames(input.settings),
        });
        throw error;
      }
    },
    async apply(input) {
      const changedFieldNames = safeChangedFieldNames(input.patch);
      try {
        const command = materializeNativePatchCommand(input);
        const result = await (sql ?? getDb()).begin((tx) =>
          applyNativePatchInTransaction(tx, command)
        );
        logConfigurationMutation({
          organizationId: input.organizationId,
          agentId: input.agentId,
          mutationKind: 'native_patch',
          status: mutationStatus(result),
          previousRevision: input.expectedConfigurationRevision,
          resultingRevision: configurationRevisionFromResult(result),
          commandId: input.commandId,
          changedFieldNames,
        });
        return result;
      } catch (error) {
        logConfigurationMutation({
          organizationId: input.organizationId,
          agentId: input.agentId,
          mutationKind: 'native_patch',
          status: rejectedMutationStatus(error),
          previousRevision: input.expectedConfigurationRevision,
          resultingRevision:
            error instanceof AgentConfigurationError ? error.currentRevision ?? null : null,
          commandId: input.commandId,
          changedFieldNames,
        });
        throw error;
      }
    },
    readAppliedState(input) {
      return (sql ?? getDb()).begin(async (tx) => {
        const agents = await tx`
          SELECT id FROM agents
          WHERE organization_id=${input.organizationId} AND id=${input.agentId}
          FOR SHARE
        `;
        if (!agents[0]) return null;
        const controls = await tx<{
          management_mode: 'native' | 'toolbox_managed';
          configuration_revision: string;
          last_mutation_kind: AppliedAgentConfigurationState['lastMutation']['kind'] | null;
          last_command_id: string | null;
          last_applied_at: Date | string | null;
        }>`
          SELECT control.management_mode,
                 control.configuration_revision::text AS configuration_revision,
                 control.last_mutation_kind, control.last_command_id,
                 command_row.applied_at AS last_applied_at
          FROM agent_configuration_controls control
          LEFT JOIN agent_configuration_commands command_row
            ON command_row.organization_id = control.organization_id
           AND command_row.agent_id = control.agent_id
           AND command_row.command_id = control.last_command_id
          WHERE control.organization_id=${input.organizationId}
            AND control.agent_id=${input.agentId}
        `;
        const control = controls[0];
        const settingsDigest = await readAgentConfigurationSettingsDigest(tx, input);
        const managedRelease = options.agentReleaseService
          ? await options.agentReleaseService.getEvidenceInTransaction(tx, input)
          : null;
        return {
          organizationId: input.organizationId,
          agentId: input.agentId,
          managementMode: control?.management_mode ?? 'native',
          configurationRevision: control
            ? String(control.configuration_revision)
            : '0',
          settingsDigest,
          lastMutation:
            control?.last_mutation_kind &&
            control.last_command_id &&
            control.last_applied_at
              ? {
                  kind: control.last_mutation_kind,
                  commandId: control.last_command_id,
                  appliedAt: new Date(control.last_applied_at).toISOString(),
                }
              : null,
          managedRelease,
        };
      });
    },
    async enrollToolboxManaged(input) {
      try {
        const command = materializeManagedEnrollmentCommand(input);
        const result = await (sql ?? getDb()).begin(async (tx) => {
          await options.transactionHooks?.beforeAgentLock?.();
          return enrollToolboxManagedInTransaction(tx, command);
        });
        logConfigurationMutation({
          organizationId: input.organizationId,
          agentId: input.agentId,
          mutationKind: 'managed_enrollment',
          status: mutationStatus(result),
          previousRevision: input.expectedConfigurationRevision,
          resultingRevision: configurationRevisionFromResult(result),
          commandId: input.commandId,
          changedFieldNames: ['managementMode'],
        });
        return result;
      } catch (error) {
        logConfigurationMutation({
          organizationId: input.organizationId,
          agentId: input.agentId,
          mutationKind: 'managed_enrollment',
          status: rejectedMutationStatus(error),
          previousRevision: input.expectedConfigurationRevision,
          resultingRevision:
            error instanceof AgentConfigurationError ? error.currentRevision ?? null : null,
          commandId: input.commandId,
          changedFieldNames: ['managementMode'],
        });
        throw error;
      }
    },
    async applyManagedRelease(input) {
      let observedCommandId = 'managed-release:unmaterialized';
      let previousRevision: string | null = null;
      let changedFieldNames: string[] = [];
      try {
      const releaseService = options.agentReleaseService;
      if (!releaseService) {
        throw new AgentConfigurationError('invalid_native_settings_patch');
      }
      const prepared = releaseService.prepareAgentReleaseApply(input);
      previousRevision = prepared.command.expectedConfigurationRevision ?? null;
      changedFieldNames = safeChangedFieldNames(
        prepared.command.settings ?? prepared.command.signedManifest.managedSettings
      );
      assertManagedReleaseSettingsOwnership(prepared);
      const authorityCommand = materializeManagedReleaseCommand(input, prepared);
      observedCommandId = authorityCommand.commandId;
      const transactionResult = await (sql ?? getDb()).begin(async (tx) => {
        await options.transactionHooks?.beforeAgentLock?.();
        let control: Awaited<ReturnType<typeof lockAgentAndConfigurationControl>>;
        try {
          control = await lockAgentAndConfigurationControl(tx, input);
        } catch (error) {
          if (
            error instanceof AgentConfigurationError &&
            error.code === 'agent_configuration_not_found'
          ) {
            throw new AgentReleaseError(
              'agent_release_agent_not_found',
              404,
              'Agent release target does not exist in the authenticated organization',
            );
          }
          throw error;
        }
        if (
          control.managementMode === 'toolbox_managed' &&
          prepared.command.expectedConfigurationRevision === undefined
        ) {
          throw new AgentConfigurationError(
            'agent_configuration_revision_required',
            control.configurationRevision,
          );
        }
        const replay = await findConfigurationCommand(tx, {
          organizationId: input.organizationId,
          agentId: input.agentId,
          commandId: authorityCommand.commandId,
        });
        if (replay && replay.commandDigest !== authorityCommand.commandDigest) {
          throw new AgentConfigurationError(
            'agent_configuration_command_conflict',
            control.configurationRevision,
          );
        }
        if (
          prepared.command.expectedConfigurationRevision !== undefined &&
          prepared.command.expectedConfigurationRevision !== control.configurationRevision
        ) {
          const staleReplayIsProvenNoChange =
            replay !== null &&
            !(await releaseService.preparedReleaseRequiresConfigurationMutationInTransaction(
              tx,
              {
                organizationId: input.organizationId,
                agentId: input.agentId,
                prepared,
              },
            ));
          if (!staleReplayIsProvenNoChange) {
            throw new AgentConfigurationError(
              'agent_configuration_revision_mismatch',
              control.configurationRevision,
            );
          }
        }

        const releaseResult = await releaseService.applyPreparedAgentReleaseInTransaction(tx, {
          organizationId: input.organizationId,
          agentId: input.agentId,
          prepared,
        });
        const settingsDigest = await readAgentConfigurationSettingsDigest(tx, input);
        const mutatesConfiguration = !releaseResult.idempotent || releaseResult.repaired;
        if (!mutatesConfiguration) {
          return {
            releaseResult,
            state: stateForUnchangedManagedRelease(
              input,
              authorityCommand,
              control,
              settingsDigest,
              releaseResult.appliedAt,
            ),
          };
        }
        const commandId = replay
          ? `${authorityCommand.commandId}:repair:${control.configurationRevision}`
          : authorityCommand.commandId;
        const state = await recordManagedReleaseConfigurationMutation(tx, {
          organizationId: input.organizationId,
          agentId: input.agentId,
          commandId,
          commandDigest: authorityCommand.commandDigest,
          currentRevision: control.configurationRevision,
          managementMode: control.managementMode,
          settingsDigest,
        });
        return { releaseResult, state };
      });
      const evidence = releaseService.finalizeAgentReleaseApplyEvidence(
          prepared,
          transactionResult.releaseResult,
          input.responseVersion === AGENT_CONFIGURATION_RESPONSE_VERSION
            ? {
                configurationRevision: transactionResult.state.configurationRevision,
                managementMode: transactionResult.state.managementMode,
              }
            : undefined,
        );
      const result = {
        evidence,
        state: {
          ...transactionResult.state,
          managedRelease: transactionResult.releaseResult,
        },
      };
      logConfigurationMutation({
        organizationId: input.organizationId,
        agentId: input.agentId,
        mutationKind: 'managed_release',
        status:
          transactionResult.releaseResult.idempotent && !transactionResult.releaseResult.repaired
            ? 'no_change'
            : 'applied',
        previousRevision,
        resultingRevision: transactionResult.state.configurationRevision,
        commandId: observedCommandId,
        changedFieldNames,
      });
      return result;
      } catch (error) {
        logConfigurationMutation({
          organizationId: input.organizationId,
          agentId: input.agentId,
          mutationKind: 'managed_release',
          status: rejectedMutationStatus(error),
          previousRevision,
          resultingRevision:
            error instanceof AgentConfigurationError ? error.currentRevision ?? null : null,
          commandId: observedCommandId,
          changedFieldNames,
        });
        throw error;
      }
    },
    async readConfigurationControl(input) {
      const rows = await (sql ?? getDb())<{
        management_mode: 'native' | 'toolbox_managed';
        configuration_revision: string;
      }>`
        SELECT management_mode, configuration_revision::text AS configuration_revision
        FROM agent_configuration_controls
        WHERE organization_id = ${input.organizationId} AND agent_id = ${input.agentId}
      `;
      const row = rows[0];
      return row
        ? {
            managementMode: row.management_mode,
            configurationRevision: String(row.configuration_revision),
          }
        : { managementMode: 'native', configurationRevision: '0' };
    },
    async readManagedRelease(input) {
      const releaseService = options.agentReleaseService;
      if (!releaseService) {
        throw new AgentConfigurationError('invalid_native_settings_patch');
      }
      return (sql ?? getDb()).begin(async (tx) => {
        const agents = await tx`
          SELECT id FROM agents
          WHERE organization_id=${input.organizationId} AND id=${input.agentId}
          FOR SHARE
        `;
        if (!agents[0]) {
          return {
            evidence: null,
            state: { managementMode: 'native' as const, configurationRevision: '0' },
          };
        }
        const evidence = await releaseService.getEvidenceInTransaction(tx, input);
        await options.readHooks?.afterEvidenceRead?.();
        const controls = await tx<{
          management_mode: 'native' | 'toolbox_managed';
          configuration_revision: string;
        }>`
          SELECT management_mode, configuration_revision::text AS configuration_revision
          FROM agent_configuration_controls
          WHERE organization_id=${input.organizationId} AND agent_id=${input.agentId}
        `;
        const control = controls[0];
        return {
          evidence,
          state: control
            ? {
                managementMode: control.management_mode,
                configurationRevision: String(control.configuration_revision),
              }
            : { managementMode: 'native' as const, configurationRevision: '0' },
        };
      });
    },
  };
}

function materializeManagedReleaseCommand(
  input: ManagedReleaseCommandInput,
  prepared: PreparedAgentReleaseApply,
): { commandId: string; commandDigest: Sha256Digest } {
  const publicationKind = prepared.publication.publicationKind ?? 'release';
  const stableIdentity = {
    kind: 'managed_release',
    environment: prepared.command.signedManifest.environment,
    agentId: input.agentId,
    releaseId: prepared.command.signedManifest.releaseId,
    releaseSequence: prepared.command.signedManifest.releaseSequence,
    publication: {
      kind: publicationKind,
      fromReleaseSequence: prepared.publication.fromReleaseSequence ?? null,
      toReleaseSequence: prepared.publication.toReleaseSequence ?? null,
      toReleaseId: prepared.publication.toReleaseId ?? null,
    },
  };
  const stableEffect = {
    ...stableIdentity,
    manifestDigest: sha256Canonical(prepared.command.signedManifest),
    settingsDigest: sha256Canonical(
      prepared.command.settings ?? prepared.command.signedManifest.managedSettings,
    ),
  };
  return {
    commandId: `managed-release:${sha256Canonical(stableIdentity)}`,
    commandDigest: sha256Canonical(stableEffect),
  };
}

function sha256Canonical(value: unknown): Sha256Digest {
  return `sha256:${createHash('sha256').update(canonicalize(value)).digest('hex')}`;
}

function assertManagedReleaseSettingsOwnership(prepared: PreparedAgentReleaseApply): void {
  const settings = prepared.command.settings;
  const keys = settings
    ? Object.keys(settings)
    : Object.keys(prepared.command.signedManifest.managedSettings);
  const allowed = settings ? RELEASE_BASELINE_SETTING_KEYS : RELEASE_LEGACY_SETTING_KEYS;
  if (keys.some((key) => !allowed.has(key))) {
    throw new AgentReleaseError(
      'agent_release_invalid_managed_settings',
      400,
      'Agent release settings contain a field outside release ownership',
    );
  }
}

function stateForUnchangedManagedRelease(
  input: ManagedReleaseCommandInput,
  command: { commandId: string; commandDigest: Sha256Digest },
  control: {
    managementMode: 'native' | 'toolbox_managed';
    configurationRevision: string;
    lastMutationKind: AppliedAgentConfigurationState['lastMutation']['kind'] | null;
    lastCommandId: string | null;
    lastCommandDigest: Sha256Digest | null;
    lastAppliedAt: string | null;
  },
  settingsDigest: Sha256Digest,
  managedReleaseAppliedAt: string,
): AppliedAgentConfigurationState {
  return {
    organizationId: input.organizationId,
    agentId: input.agentId,
    managementMode: control.managementMode,
    configurationRevision: control.configurationRevision,
    settingsDigest,
    lastMutation: {
      kind: control.lastMutationKind ?? 'managed_release',
      commandId: control.lastCommandId ?? command.commandId,
      appliedAt: control.lastAppliedAt ?? managedReleaseAppliedAt,
    },
    managedRelease: null,
  };
}
