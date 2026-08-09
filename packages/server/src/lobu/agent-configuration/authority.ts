import { createHash } from 'node:crypto';
import { canonicalize } from 'json-canonicalize';
import type { DbClient } from '../../db/client';
import { getDb } from '../../db/client';
import {
  AgentReleaseError,
  type createAgentReleaseService,
  type PreparedAgentReleaseApply,
} from '../agent-release-service';
import { AgentConfigurationError } from './errors';
import {
  normalizeNativeSettingsPatchForPersistence,
  parseNativeSettingsPatch,
} from './field-ownership';
import {
  applyNativePatchInTransaction,
  findConfigurationCommand,
  lockAgentAndConfigurationControl,
  readAgentConfigurationSettingsDigest,
  recordManagedReleaseConfigurationMutation,
} from './postgres-repository';
import type {
  AgentConfigurationMutationResult,
  AppliedAgentConfigurationState,
  ManagedReleaseCommandInput,
  ManagedReleaseConfigurationResult,
  NativePatchCommand,
  NativePatchCommandInput,
  Sha256Digest,
} from './types';

const DECIMAL_REVISION_PATTERN = /^(0|[1-9][0-9]*)$/;

export interface AgentConfigurationAuthority {
  apply(input: NativePatchCommandInput): Promise<AgentConfigurationMutationResult>;
  applyManagedRelease(
    input: ManagedReleaseCommandInput,
  ): Promise<ManagedReleaseConfigurationResult>;
  readConfigurationControl(input: { organizationId: string; agentId: string }): Promise<{
    managementMode: 'native' | 'toolbox_managed';
    configurationRevision: string;
  }>;
}

type AgentReleaseService = ReturnType<typeof createAgentReleaseService>;

const RELEASE_LEGACY_SETTING_KEYS = new Set([
  'identityMd',
  'soulMd',
  'userMd',
  'modelSelection',
  'toolsConfig',
]);
const RELEASE_BASELINE_SETTING_KEYS = new Set([
  ...RELEASE_LEGACY_SETTING_KEYS,
  'templateKey',
  'scope',
  'baselinePrompt',
  'runtimeConfig',
  'mcpServers',
  'skillsConfig',
  'preApprovedTools',
  'providerModelPreferences',
  'networkConfig',
  'egressConfig',
  'nixConfig',
  'pluginsConfig',
  'guardrails',
  'installedProviders',
]);

function materializeNativePatchCommand(input: NativePatchCommandInput): NativePatchCommand {
  if (
    input.expectedConfigurationRevision !== null &&
    !DECIMAL_REVISION_PATTERN.test(input.expectedConfigurationRevision)
  ) {
    throw new AgentConfigurationError('invalid_revision_precondition');
  }
  const parsedPatch = parseNativeSettingsPatch(input.patch);
  const patch = parseNativeSettingsPatch(JSON.parse(canonicalize(parsedPatch)));
  const canonicalCommand = {
    kind: 'native_patch',
    agentId: input.agentId,
    expectedRevision: input.expectedConfigurationRevision,
    patch: normalizeNativeSettingsPatchForPersistence(patch),
  };
  const commandDigest = `sha256:${createHash('sha256')
    .update(canonicalize(canonicalCommand))
    .digest('hex')}` as Sha256Digest;
  return {
    organizationId: input.organizationId,
    agentId: input.agentId,
    commandId: input.commandId,
    expectedConfigurationRevision: input.expectedConfigurationRevision,
    actor: input.actor,
    patch,
    kind: 'native_patch',
    commandDigest,
  };
}

export function createAgentConfigurationAuthority(
  sql?: DbClient,
  options: { agentReleaseService?: AgentReleaseService } = {},
): AgentConfigurationAuthority {
  return {
    apply(input) {
      const command = materializeNativePatchCommand(input);
      return (sql ?? getDb()).begin((tx) => applyNativePatchInTransaction(tx, command));
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
          !replay &&
          control.managementMode === 'toolbox_managed' &&
          prepared.command.expectedConfigurationRevision === undefined
        ) {
          throw new AgentConfigurationError(
            'agent_configuration_revision_required',
            control.configurationRevision,
          );
        }
        if (
          !replay &&
          prepared.command.expectedConfigurationRevision !== undefined &&
          prepared.command.expectedConfigurationRevision !== control.configurationRevision
        ) {
          throw new AgentConfigurationError(
            'agent_configuration_revision_mismatch',
            control.configurationRevision,
          );
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
  };
}

function materializeManagedReleaseCommand(
  input: ManagedReleaseCommandInput,
  prepared: PreparedAgentReleaseApply,
): { commandId: string; commandDigest: Sha256Digest } {
  const canonicalCommand = {
    kind: 'managed_release',
    agentId: input.agentId,
    expectedRevision: prepared.command.expectedConfigurationRevision ?? null,
    releaseCommandDigest: prepared.command.commandDigest,
  };
  return {
    commandId: `managed-release:${prepared.command.commandDigest}`,
    commandDigest: `sha256:${createHash('sha256')
      .update(canonicalize(canonicalCommand))
      .digest('hex')}`,
  };
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
