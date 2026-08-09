import { createHash } from 'node:crypto';
import { canonicalize } from 'json-canonicalize';
import type { DbClient } from '../../db/client';
import logger from '../../utils/logger';
import { AgentConfigurationError } from './errors';
import {
  decideNativeSettingsPatch,
  normalizeNativeSettingsPatchForPersistence,
} from './field-ownership';
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
const LEGACY_RELEASE_OWNED_SETTINGS = new Set([
  'identityMd',
  'soulMd',
  'userMd',
  'modelSelection',
  'toolsConfig',
]);
const PERSONAL_BASELINE_LOBU_OWNED_SETTINGS = new Set([
  ...LEGACY_RELEASE_OWNED_SETTINGS,
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

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.hasOwn(value, key);
}

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

function assertNativePatchCommand(command: NativePatchCommand): void {
  if (!command.commandId.trim() || !SHA256_PATTERN.test(command.commandDigest)) {
    throw new AgentConfigurationError('invalid_native_settings_patch');
  }
}

function projectedSettingsAfterPatch(
  agent: AgentSettingsRow,
  patch: NativePatchCommand['patch']
): Record<string, unknown> {
  const projected = settingsProjection(agent);
  for (const [key, value] of Object.entries(
    normalizeNativeSettingsPatchForPersistence(patch)
  )) {
    projected[key] = value;
  }
  return projected;
}

async function legacyReleasePredicateRejectedFields(
  tx: DbClient,
  command: NativePatchCommand
): Promise<string[]> {
  const fields = Object.keys(command.patch);
  if (fields.length === 0) return [];
  const receipts = await tx<{ personal_baseline_settings: unknown }>`
    SELECT personal_baseline_settings
    FROM agent_release_applies
    WHERE organization_id = ${command.organizationId}
      AND agent_id = ${command.agentId}
      AND status = 'applied'
      AND applied_at IS NOT NULL
    LIMIT 1
  `;
  if (receipts.length === 0) return [];
  const ownedFields =
    receipts[0]?.personal_baseline_settings != null
      ? PERSONAL_BASELINE_LOBU_OWNED_SETTINGS
      : LEGACY_RELEASE_OWNED_SETTINGS;
  return fields.filter((field) => ownedFields.has(field));
}

export async function applyNativePatchInTransaction(
  tx: DbClient,
  command: NativePatchCommand
): Promise<AgentConfigurationMutationResult> {
  assertNativePatchCommand(command);

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
      return {
        status: 'conflict',
        conflict: 'command_conflict',
        currentRevision,
      };
    }
    return {
      status: 'already_applied',
      state: stateFromCommandRow(command, priorCommand),
    };
  }

  const expectedConfigurationRevision =
    command.expectedConfigurationRevision ?? currentRevision;
  if (expectedConfigurationRevision !== currentRevision) {
    return {
      status: 'conflict',
      conflict: 'revision_mismatch',
      currentRevision,
    };
  }

  const legacyRejectedFields = await legacyReleasePredicateRejectedFields(tx, command);
  const policyDecision = decideNativeSettingsPatch(control.management_mode, command.patch);
  const legacyRejected = legacyRejectedFields.length > 0;
  const shadowDecisionMatches =
    canonicalize([...legacyRejectedFields].sort()) ===
    canonicalize([...policyDecision.rejectedFields].sort());
  if (!shadowDecisionMatches) {
    logger.warn(
      {
        organizationId: command.organizationId,
        agentId: command.agentId,
        managementMode: control.management_mode,
        legacyRejectedFields,
        policyRejectedFields: policyDecision.rejectedFields,
      },
      'shadow_decision_mismatch'
    );
  }
  if (control.management_mode === 'native' && legacyRejected) {
    return { status: 'rejected', reason: 'managed_configuration_sealed' };
  }
  if (policyDecision.reason) {
    return { status: 'rejected', reason: policyDecision.reason };
  }

  const currentSettings = settingsProjection(agent);
  const resultingSettings = projectedSettingsAfterPatch(agent, command.patch);
  const changed = canonicalize(currentSettings) !== canonicalize(resultingSettings);
  const resultingRevision = changed ? (BigInt(currentRevision) + 1n).toString() : currentRevision;
  const resultStatus = changed ? 'applied' : 'no_change';
  if (changed) {
    await tx`
      UPDATE agents
      SET model = CASE WHEN ${hasOwn(command.patch, 'model')}
            THEN ${command.patch.model ?? null} ELSE model END,
          model_selection = CASE WHEN ${hasOwn(command.patch, 'modelSelection')}
            THEN ${tx.json(command.patch.modelSelection ?? {})} ELSE model_selection END,
          provider_model_preferences = CASE WHEN ${hasOwn(command.patch, 'providerModelPreferences')}
            THEN ${tx.json(command.patch.providerModelPreferences ?? {})} ELSE provider_model_preferences END,
          network_config = CASE WHEN ${hasOwn(command.patch, 'networkConfig')}
            THEN ${tx.json(command.patch.networkConfig ?? {})} ELSE network_config END,
          egress_config = CASE WHEN ${hasOwn(command.patch, 'egressConfig')}
            THEN ${tx.json(command.patch.egressConfig ?? {})} ELSE egress_config END,
          nix_config = CASE WHEN ${hasOwn(command.patch, 'nixConfig')}
            THEN ${tx.json(command.patch.nixConfig ?? {})} ELSE nix_config END,
          mcp_servers = CASE WHEN ${hasOwn(command.patch, 'mcpServers')}
            THEN ${tx.json(command.patch.mcpServers ?? {})} ELSE mcp_servers END,
          soul_md = CASE WHEN ${hasOwn(command.patch, 'soulMd')}
            THEN ${command.patch.soulMd ?? ''} ELSE soul_md END,
          user_md = CASE WHEN ${hasOwn(command.patch, 'userMd')}
            THEN ${command.patch.userMd ?? ''} ELSE user_md END,
          identity_md = CASE WHEN ${hasOwn(command.patch, 'identityMd')}
            THEN ${command.patch.identityMd ?? ''} ELSE identity_md END,
          skills_config = CASE WHEN ${hasOwn(command.patch, 'skillsConfig')}
            THEN ${tx.json(command.patch.skillsConfig ?? { skills: [] })} ELSE skills_config END,
          tools_config = CASE WHEN ${hasOwn(command.patch, 'toolsConfig')}
            THEN ${tx.json(command.patch.toolsConfig ?? {})} ELSE tools_config END,
          plugins_config = CASE WHEN ${hasOwn(command.patch, 'pluginsConfig')}
            THEN ${tx.json(command.patch.pluginsConfig ?? {})} ELSE plugins_config END,
          installed_providers = CASE WHEN ${hasOwn(command.patch, 'installedProviders')}
            THEN ${tx.json(command.patch.installedProviders ?? [])} ELSE installed_providers END,
          verbose_logging = CASE WHEN ${hasOwn(command.patch, 'verboseLogging')}
            THEN ${command.patch.verboseLogging ?? false} ELSE verbose_logging END,
          pre_approved_tools = CASE WHEN ${hasOwn(command.patch, 'preApprovedTools')}
            THEN ${tx.json(command.patch.preApprovedTools ?? [])} ELSE pre_approved_tools END,
          guardrails = CASE WHEN ${hasOwn(command.patch, 'guardrails')}
            THEN ${tx.json(command.patch.guardrails ?? [])} ELSE guardrails END,
          updated_at = NOW()
      WHERE organization_id = ${command.organizationId} AND id = ${command.agentId}
    `;
  }

  const resultingSettingsDigest = sha256Canonical(resultingSettings);
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
      ${control.management_mode}, ${resultingSettingsDigest}, ${resultStatus}
    )
  `;

  return {
    status: resultStatus,
    state: {
      organizationId: command.organizationId,
      agentId: command.agentId,
      managementMode: control.management_mode,
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
