import { createHash } from 'node:crypto';
import { canonicalize } from 'json-canonicalize';
import type { DbClient } from '../../db/client';
import { AgentConfigurationError } from './errors';
import type {
  AgentConfigurationMutationResult,
  AppliedAgentConfigurationState,
  ConfigurationManagementMode,
  NativePatchCommand,
  Sha256Digest,
} from './types';

type AgentSettingsRow = {
  model: unknown;
  model_selection: unknown;
  provider_model_preferences: unknown;
  network_config: unknown;
  egress_config: unknown;
  nix_config: unknown;
  mcp_servers: unknown;
  soul_md: unknown;
  user_md: unknown;
  identity_md: unknown;
  skills_config: unknown;
  tools_config: unknown;
  plugins_config: unknown;
  installed_providers: unknown;
  verbose_logging: boolean | null;
  pre_approved_tools: unknown;
  guardrails: unknown;
};

type ControlRow = {
  management_mode: ConfigurationManagementMode;
  configuration_revision: string;
};

type CommandRow = {
  command_digest: Sha256Digest;
  mutation_kind: 'native_patch';
  resulting_revision: string;
  resulting_mode: ConfigurationManagementMode;
  resulting_settings_digest: Sha256Digest;
  result_status: 'applied' | 'no_change';
};

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

function sha256Canonical(value: unknown): Sha256Digest {
  return `sha256:${createHash('sha256').update(canonicalize(value)).digest('hex')}`;
}

function settingsProjection(row: AgentSettingsRow): Record<string, unknown> {
  return {
    model: row.model ?? null,
    modelSelection: row.model_selection ?? {},
    providerModelPreferences: row.provider_model_preferences ?? {},
    networkConfig: row.network_config ?? {},
    egressConfig: row.egress_config ?? {},
    nixConfig: row.nix_config ?? {},
    mcpServers: row.mcp_servers ?? {},
    soulMd: row.soul_md ?? '',
    userMd: row.user_md ?? '',
    identityMd: row.identity_md ?? '',
    skillsConfig: row.skills_config ?? { skills: [] },
    toolsConfig: row.tools_config ?? {},
    pluginsConfig: row.plugins_config ?? {},
    installedProviders: row.installed_providers ?? [],
    verboseLogging: row.verbose_logging ?? false,
    preApprovedTools: row.pre_approved_tools ?? [],
    guardrails: row.guardrails ?? [],
  };
}

function stateFromCommandRow(
  command: NativePatchCommand,
  row: CommandRow
): AppliedAgentConfigurationState {
  return {
    organizationId: command.organizationId,
    agentId: command.agentId,
    managementMode: row.resulting_mode,
    configurationRevision: String(row.resulting_revision),
    settingsDigest: row.resulting_settings_digest,
    lastMutation: {
      kind: row.mutation_kind,
      commandId: command.commandId,
      commandDigest: row.command_digest,
    },
  };
}

function assertTracerPatch(command: NativePatchCommand): void {
  const keys = Object.keys(command.patch);
  if (
    keys.length > 1 ||
    (keys.length === 1 &&
      (keys[0] !== 'verboseLogging' || typeof command.patch.verboseLogging !== 'boolean'))
  ) {
    throw new AgentConfigurationError('invalid_native_settings_patch');
  }
  if (!command.commandId.trim() || !SHA256_PATTERN.test(command.commandDigest)) {
    throw new AgentConfigurationError('invalid_native_settings_patch');
  }
}

export async function applyNativePatchInTransaction(
  tx: DbClient,
  command: NativePatchCommand
): Promise<AgentConfigurationMutationResult> {
  assertTracerPatch(command);

  const agents = await tx<AgentSettingsRow>`
    SELECT model, model_selection, provider_model_preferences,
           network_config, egress_config, nix_config, mcp_servers,
           soul_md, user_md, identity_md, skills_config, tools_config,
           plugins_config, installed_providers, verbose_logging,
           pre_approved_tools, guardrails
    FROM agents
    WHERE organization_id = ${command.organizationId} AND id = ${command.agentId}
    FOR UPDATE
  `;
  const agent = agents[0];
  if (!agent) {
    throw new AgentConfigurationError('agent_configuration_not_found');
  }

  await tx`
    INSERT INTO agent_configuration_controls (organization_id, agent_id)
    VALUES (${command.organizationId}, ${command.agentId})
    ON CONFLICT (organization_id, agent_id) DO NOTHING
  `;
  const controls = await tx<ControlRow>`
    SELECT management_mode, configuration_revision::text AS configuration_revision
    FROM agent_configuration_controls
    WHERE organization_id = ${command.organizationId} AND agent_id = ${command.agentId}
    FOR UPDATE
  `;
  const control = controls[0];
  if (!control) {
    throw new AgentConfigurationError('agent_configuration_not_found');
  }
  const currentRevision = String(control.configuration_revision);

  const priorCommands = await tx<CommandRow>`
    SELECT command_digest, mutation_kind,
           resulting_revision::text AS resulting_revision, resulting_mode,
           resulting_settings_digest, result_status
    FROM agent_configuration_commands
    WHERE organization_id = ${command.organizationId}
      AND agent_id = ${command.agentId}
      AND command_id = ${command.commandId}
  `;
  const priorCommand = priorCommands[0];
  if (priorCommand) {
    if (priorCommand.command_digest !== command.commandDigest) {
      throw new AgentConfigurationError('agent_configuration_command_conflict', currentRevision);
    }
    return {
      status: 'already_applied',
      state: stateFromCommandRow(command, priorCommand),
    };
  }

  if (command.expectedConfigurationRevision !== currentRevision) {
    throw new AgentConfigurationError('agent_configuration_revision_mismatch', currentRevision);
  }
  if (control.management_mode !== 'native') {
    return { status: 'rejected', reason: 'toolbox_managed' };
  }

  const resultingVerboseLogging =
    command.patch.verboseLogging ?? (agent.verbose_logging ?? false);
  const changed =
    command.patch.verboseLogging !== undefined &&
    (agent.verbose_logging ?? false) !== command.patch.verboseLogging;
  const resultingRevision = changed ? (BigInt(currentRevision) + 1n).toString() : currentRevision;
  const resultStatus = changed ? 'applied' : 'no_change';
  if (changed) {
    await tx`
      UPDATE agents
      SET verbose_logging = ${resultingVerboseLogging}, updated_at = NOW()
      WHERE organization_id = ${command.organizationId} AND id = ${command.agentId}
    `;
  }

  const resultingSettingsDigest = sha256Canonical({
    ...settingsProjection(agent),
    verboseLogging: resultingVerboseLogging,
  });
  await tx`
    UPDATE agent_configuration_controls
    SET configuration_revision = ${resultingRevision}::bigint,
        last_mutation_kind = 'native_patch',
        last_command_id = ${command.commandId},
        last_command_digest = ${command.commandDigest},
        updated_at = NOW()
    WHERE organization_id = ${command.organizationId} AND agent_id = ${command.agentId}
  `;
  await tx`
    INSERT INTO agent_configuration_commands (
      organization_id, agent_id, command_id, command_digest, mutation_kind,
      resulting_revision, resulting_mode, resulting_settings_digest, result_status
    ) VALUES (
      ${command.organizationId}, ${command.agentId}, ${command.commandId},
      ${command.commandDigest}, 'native_patch', ${resultingRevision}::bigint,
      'native', ${resultingSettingsDigest}, ${resultStatus}
    )
  `;

  return {
    status: resultStatus,
    state: {
      organizationId: command.organizationId,
      agentId: command.agentId,
      managementMode: 'native',
      configurationRevision: resultingRevision,
      settingsDigest: resultingSettingsDigest,
      lastMutation: {
        kind: 'native_patch',
        commandId: command.commandId,
        commandDigest: command.commandDigest,
      },
    },
  };
}
