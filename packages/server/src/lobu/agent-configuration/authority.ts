import { createHash } from 'node:crypto';
import { canonicalize } from 'json-canonicalize';
import type { DbClient } from '../../db/client';
import { getDb } from '../../db/client';
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
    bootstrap: (input) => bootstrap.apply(input),
    apply(input) {
      const command = materializeNativePatchCommand(input);
      return (sql ?? getDb()).begin((tx) => applyNativePatchInTransaction(tx, command));
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
          last_command_digest: Sha256Digest | null;
        }>`
          SELECT management_mode, configuration_revision::text AS configuration_revision,
                 last_mutation_kind, last_command_id, last_command_digest
          FROM agent_configuration_controls
          WHERE organization_id=${input.organizationId} AND agent_id=${input.agentId}
        `;
        const control = controls[0];
        const settingsDigest = await readAgentConfigurationSettingsDigest(tx, input);
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
            control.last_command_digest
              ? {
                  kind: control.last_mutation_kind,
                  commandId: control.last_command_id,
                  commandDigest: control.last_command_digest,
                }
              : null,
        };
      });
    },
    enrollToolboxManaged(input) {
      const command = materializeManagedEnrollmentCommand(input);
      return (sql ?? getDb()).begin(async (tx) => {
        await options.transactionHooks?.beforeAgentLock?.();
        return enrollToolboxManagedInTransaction(tx, command);
      });
    },
    async applyManagedRelease(input) {
      const releaseService = options.agentReleaseService;
      if (!releaseService) {
        throw new AgentConfigurationError('invalid_native_settings_patch');
      }
      const prepared = releaseService.prepareAgentReleaseApply(input);
      assertManagedReleaseSettingsOwnership(prepared);
      const authorityCommand = materializeManagedReleaseCommand(input, prepared);
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
      return {
        evidence: releaseService.finalizeAgentReleaseApplyEvidence(
          prepared,
          transactionResult.releaseResult,
          input.responseVersion === AGENT_CONFIGURATION_RESPONSE_VERSION
            ? {
                configurationRevision: transactionResult.state.configurationRevision,
                managementMode: transactionResult.state.managementMode,
              }
            : undefined,
        ),
        state: transactionResult.state,
      };
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
  },
  settingsDigest: Sha256Digest,
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
      commandDigest: control.lastCommandDigest ?? command.commandDigest,
    },
  };
}
