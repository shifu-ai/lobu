import { createHash } from 'node:crypto';
import { inferGrantKind, normalizeDomainPattern, type AgentSettings } from '@lobu/core';
import { canonicalize } from 'json-canonicalize';
import type { DbClient } from '../../db/client';
import { validateRuntimeCapabilitySnapshot } from '../runtime-capability-snapshot-contract';
import logger from '../../utils/logger';
import {
  classifyAgentReleaseCapabilityState,
  type ReleaseCapabilityReceiptRow,
} from '../agent-release-service';
import { AgentConfigurationError } from './errors';
import { projectAgentConfigurationSettings } from './native-patch';
import {
  LEGACY_MANAGED_RELEASE_SETTING_KEYS,
  PERSONAL_BASELINE_RELEASE_SETTING_KEYS,
  decideNativeSettingsPatch,
  normalizeNativeSettingsPatchForPersistence,
} from './field-ownership';
import type {
  AgentConfigurationMutationResult,
  AgentConfigurationEnrollmentResult,
  AppliedAgentConfigurationState,
  ConfigurationManagementMode,
  ManagedEnrollmentCommand,
  NativePatchCommand,
  Sha256Digest,
} from './types';

type AgentSettingsRow = {
  owner_user_id: string | null;
  model: string | null;
  model_selection: unknown;
  provider_model_preferences: unknown;
  network_config: unknown;
  egress_config: unknown;
  nix_config: unknown;
  mcp_servers: unknown;
  soul_md: string | null;
  user_md: string | null;
  identity_md: string | null;
  skills_config: unknown;
  tools_config: unknown;
  plugins_config: unknown;
  installed_providers: unknown;
  verbose_logging: boolean | null;
  pre_approved_tools: unknown;
  guardrails: unknown;
};

export type LegacyManagedSettingsProjection = Pick<
  AgentSettings,
  'identityMd' | 'soulMd' | 'userMd' | 'modelSelection' | 'toolsConfig'
>;

export type LegacyManagedSettingsRow = Pick<
  AgentSettingsRow,
  'owner_user_id' | 'identity_md' | 'soul_md' | 'user_md' | 'model_selection' | 'tools_config'
>;

type ControlRow = {
  management_mode: ConfigurationManagementMode;
  configuration_revision: string;
  last_mutation_kind?:
    | 'bootstrap'
    | 'native_patch'
    | 'managed_release'
    | 'managed_enrollment'
    | null;
  last_command_id?: string | null;
  last_command_digest?: Sha256Digest | null;
};

type CommandRow = {
  command_digest: Sha256Digest;
  mutation_kind: 'bootstrap' | 'native_patch' | 'managed_release' | 'managed_enrollment';
  resulting_revision: string;
  resulting_mode: ConfigurationManagementMode;
  resulting_settings_digest: Sha256Digest;
  result_status: 'applied' | 'no_change';
  applied_at: Date | string;
};

type EnrollmentReceiptRow = ReleaseCapabilityReceiptRow & {
  personal_baseline_effective_settings_digest: string | null;
};

export interface LockedConfigurationControl {
  managementMode: ConfigurationManagementMode;
  configurationRevision: string;
  lastMutationKind: 'bootstrap' | 'native_patch' | 'managed_release' | 'managed_enrollment' | null;
  lastCommandId: string | null;
  lastCommandDigest: Sha256Digest | null;
  lastAppliedAt: string | null;
}

export interface ConfigurationCommandReplay {
  commandDigest: Sha256Digest;
  mutationKind: 'bootstrap' | 'native_patch' | 'managed_release' | 'managed_enrollment';
  resultingRevision: string;
  resultingMode: ConfigurationManagementMode;
  resultingSettingsDigest: Sha256Digest;
  resultStatus: 'applied' | 'no_change';
  appliedAt: string;
}

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const LEGACY_RELEASE_OWNED_SETTINGS = new Set<string>(LEGACY_MANAGED_RELEASE_SETTING_KEYS);
const PERSONAL_BASELINE_LOBU_OWNED_SETTINGS = new Set<string>(
  PERSONAL_BASELINE_RELEASE_SETTING_KEYS,
);

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.hasOwn(value, key);
}

function sha256Canonical(value: unknown): Sha256Digest {
  return `sha256:${createHash('sha256').update(canonicalize(value)).digest('hex')}`;
}

function commandAppliedAt(rows: Array<{ applied_at: Date | string }>): string {
  const appliedAt = rows[0]?.applied_at;
  if (!appliedAt) throw new Error('Agent configuration command insert returned no receipt');
  return new Date(appliedAt).toISOString();
}

function settingsProjection(row: AgentSettingsRow): Record<string, unknown> {
  return projectAgentConfigurationSettings({
    model: row.model ?? undefined,
    modelSelection: row.model_selection as AgentSettings['modelSelection'],
    providerModelPreferences:
      row.provider_model_preferences as AgentSettings['providerModelPreferences'],
    networkConfig: row.network_config as AgentSettings['networkConfig'],
    egressConfig: row.egress_config as AgentSettings['egressConfig'],
    nixConfig: row.nix_config as AgentSettings['nixConfig'],
    mcpServers: row.mcp_servers as AgentSettings['mcpServers'],
    soulMd: row.soul_md ?? undefined,
    userMd: row.user_md ?? undefined,
    identityMd: row.identity_md ?? undefined,
    skillsConfig: row.skills_config as AgentSettings['skillsConfig'],
    toolsConfig: row.tools_config as AgentSettings['toolsConfig'],
    pluginsConfig: row.plugins_config as AgentSettings['pluginsConfig'],
    installedProviders:
      row.installed_providers as AgentSettings['installedProviders'],
    verboseLogging: row.verbose_logging ?? undefined,
    preApprovedTools:
      row.pre_approved_tools as AgentSettings['preApprovedTools'],
    guardrails: row.guardrails as AgentSettings['guardrails'],
  });
}

export async function replaceAgentConfigurationSettingsInTransaction(
  tx: DbClient,
  organizationId: string,
  agentId: string,
  settings: Omit<AgentSettings, 'updatedAt'>,
  expectedConfigurationRevision: string,
): Promise<void> {
  const updated = await tx`
    UPDATE agents SET
      model = ${settings.model ?? null},
      model_selection = ${tx.json(settings.modelSelection ?? {})},
      provider_model_preferences = ${tx.json(settings.providerModelPreferences ?? {})},
      network_config = ${tx.json(settings.networkConfig ?? {})},
      egress_config = ${tx.json(settings.egressConfig ?? {})},
      nix_config = ${tx.json(settings.nixConfig ?? {})},
      mcp_servers = ${tx.json(settings.mcpServers ?? {})},
      soul_md = ${settings.soulMd ?? ''},
      user_md = ${settings.userMd ?? ''},
      identity_md = ${settings.identityMd ?? ''},
      skills_config = ${tx.json(settings.skillsConfig ?? { skills: [] })},
      tools_config = ${tx.json(settings.toolsConfig ?? {})},
      plugins_config = ${tx.json(settings.pluginsConfig ?? {})},
      installed_providers = ${tx.json(settings.installedProviders ?? [])},
      verbose_logging = ${settings.verboseLogging ?? false},
      pre_approved_tools = ${tx.json(settings.preApprovedTools ?? [])},
      guardrails = ${tx.json(settings.guardrails ?? [])},
      updated_at = NOW()
    WHERE organization_id = ${organizationId} AND id = ${agentId}
      AND EXISTS (
        SELECT 1 FROM agent_configuration_controls control
        WHERE control.organization_id = ${organizationId}
          AND control.agent_id = ${agentId}
          AND control.configuration_revision = ${expectedConfigurationRevision}::bigint
      )
    RETURNING 1
  `;
  if (updated.length === 0) {
    throw new AgentConfigurationError(
      'agent_configuration_revision_mismatch',
      expectedConfigurationRevision,
    );
  }
}

/** Replace only release-owned fields, preserving Lobu-owned model and verboseLogging. */
export async function replaceReleaseOwnedAgentConfigurationSettingsInTransaction(
  tx: DbClient,
  organizationId: string,
  agentId: string,
  settings: Omit<AgentSettings, 'updatedAt'>,
  expectedConfigurationRevision: string,
): Promise<void> {
  const updated = await tx`
    UPDATE agents SET
      model_selection = ${tx.json(settings.modelSelection ?? {})},
      provider_model_preferences = ${tx.json(settings.providerModelPreferences ?? {})},
      network_config = ${tx.json(settings.networkConfig ?? {})},
      egress_config = ${tx.json(settings.egressConfig ?? {})},
      nix_config = ${tx.json(settings.nixConfig ?? {})},
      mcp_servers = ${tx.json(settings.mcpServers ?? {})},
      soul_md = ${settings.soulMd ?? ''},
      user_md = ${settings.userMd ?? ''},
      identity_md = ${settings.identityMd ?? ''},
      skills_config = ${tx.json(settings.skillsConfig ?? { skills: [] })},
      tools_config = ${tx.json(settings.toolsConfig ?? {})},
      plugins_config = ${tx.json(settings.pluginsConfig ?? {})},
      installed_providers = ${tx.json(settings.installedProviders ?? [])},
      pre_approved_tools = ${tx.json(settings.preApprovedTools ?? [])},
      guardrails = ${tx.json(settings.guardrails ?? [])},
      updated_at = NOW()
    WHERE organization_id = ${organizationId} AND id = ${agentId}
      AND EXISTS (
        SELECT 1 FROM agent_configuration_controls control
        WHERE control.organization_id = ${organizationId}
          AND control.agent_id = ${agentId}
          AND control.configuration_revision = ${expectedConfigurationRevision}::bigint
      )
    RETURNING 1
  `;
  if (updated.length === 0) {
    throw new AgentConfigurationError(
      'agent_configuration_revision_mismatch',
      expectedConfigurationRevision,
    );
  }
}

export async function applyLegacyManagedSettingsInTransaction(
  tx: DbClient,
  organizationId: string,
  agentId: string,
  settings: Partial<LegacyManagedSettingsProjection>,
  expectedConfigurationRevision: string,
): Promise<LegacyManagedSettingsRow | null> {
  const updatedRows = await tx<LegacyManagedSettingsRow>`
    UPDATE agents SET
      identity_md = CASE
        WHEN ${hasOwn(settings, 'identityMd')} THEN ${settings.identityMd ?? ''}
        ELSE identity_md
      END,
      soul_md = CASE
        WHEN ${hasOwn(settings, 'soulMd')} THEN ${settings.soulMd ?? ''}
        ELSE soul_md
      END,
      user_md = CASE
        WHEN ${hasOwn(settings, 'userMd')} THEN ${settings.userMd ?? ''}
        ELSE user_md
      END,
      model_selection = CASE
        WHEN ${hasOwn(settings, 'modelSelection')}
          THEN ${tx.json(settings.modelSelection ?? {})}
        ELSE model_selection
      END,
      tools_config = CASE
        WHEN ${hasOwn(settings, 'toolsConfig')}
          THEN ${tx.json(settings.toolsConfig ?? {})}
        ELSE tools_config
      END,
      updated_at = NOW()
    WHERE organization_id = ${organizationId} AND id = ${agentId}
      AND EXISTS (
        SELECT 1 FROM agent_configuration_controls control
        WHERE control.organization_id = ${organizationId}
          AND control.agent_id = ${agentId}
          AND control.configuration_revision = ${expectedConfigurationRevision}::bigint
      )
    RETURNING owner_user_id, identity_md, soul_md, user_md,
              model_selection, tools_config
  `;
  if (!updatedRows[0]) {
    throw new AgentConfigurationError(
      'agent_configuration_revision_mismatch',
      expectedConfigurationRevision,
    );
  }
  return updatedRows[0];
}

export async function syncProvisioningGrantsInTransaction(
  tx: DbClient,
  organizationId: string,
  agentId: string,
  settings: Omit<AgentSettings, 'updatedAt'>,
): Promise<void> {
  const desired = new Map<string, { kind: string; pattern: string }>();
  for (const rawPattern of [
    ...(settings.networkConfig?.allowedDomains ?? []),
    ...(settings.preApprovedTools ?? []),
  ]) {
    const pattern = normalizeDomainPattern(rawPattern);
    const kind = inferGrantKind(pattern);
    desired.set(`${kind}\u0000${pattern}`, { kind, pattern });
  }
  const owned = await tx<{ kind: string; pattern: string }>`
    SELECT owned.kind, owned.pattern
    FROM agent_fenced_provisioning_grants owned
    JOIN grants grant_row
      ON grant_row.organization_id = owned.organization_id
     AND grant_row.agent_id = owned.agent_id
     AND grant_row.kind = owned.kind
     AND grant_row.pattern = owned.pattern
    WHERE owned.organization_id = ${organizationId} AND owned.agent_id = ${agentId}
    FOR UPDATE OF owned, grant_row
  `;
  const ownedKeys = new Set(owned.map((row) => `${row.kind}\u0000${row.pattern}`));
  for (const row of owned) {
    if (desired.has(`${row.kind}\u0000${row.pattern}`)) continue;
    await tx`
      DELETE FROM grants
      WHERE organization_id = ${organizationId} AND agent_id = ${agentId}
        AND kind = ${row.kind} AND pattern = ${row.pattern}
        AND EXISTS (
          SELECT 1 FROM agent_fenced_provisioning_grants owned
          WHERE owned.organization_id = ${organizationId} AND owned.agent_id = ${agentId}
            AND owned.kind = ${row.kind} AND owned.pattern = ${row.pattern}
        )
    `;
  }
  for (const [key, grant] of desired) {
    if (ownedKeys.has(key)) {
      const reactivated = await tx`
        UPDATE grants SET expires_at = NULL, granted_at = NOW(), denied = false
        WHERE organization_id = ${organizationId} AND agent_id = ${agentId}
          AND kind = ${grant.kind} AND pattern = ${grant.pattern}
        RETURNING 1
      `;
      if (reactivated.length === 0) {
        throw new Error('Required unowned grant changed during fenced apply');
      }
      continue;
    }
    const inserted = await tx`
      INSERT INTO grants (organization_id, agent_id, kind, pattern, expires_at, granted_at, denied)
      VALUES (${organizationId}, ${agentId}, ${grant.kind}, ${grant.pattern}, NULL, NOW(), false)
      ON CONFLICT (organization_id, agent_id, kind, pattern) DO NOTHING
      RETURNING 1
    `;
    if (inserted.length === 0) {
      await tx`
        UPDATE grants SET expires_at = NULL, granted_at = NOW(), denied = false
        WHERE organization_id = ${organizationId} AND agent_id = ${agentId}
          AND kind = ${grant.kind} AND pattern = ${grant.pattern}
      `;
      continue;
    }
    await tx`
      INSERT INTO agent_fenced_provisioning_grants (organization_id, agent_id, kind, pattern)
      VALUES (${organizationId}, ${agentId}, ${grant.kind}, ${grant.pattern})
    `;
  }
}

export async function addProvisioningGrantsInTransaction(
  tx: DbClient,
  organizationId: string,
  agentId: string,
  settings: Omit<AgentSettings, 'updatedAt'>,
): Promise<void> {
  for (const rawPattern of [
    ...(settings.networkConfig?.allowedDomains ?? []),
    ...(settings.preApprovedTools ?? []),
  ]) {
    const pattern = normalizeDomainPattern(rawPattern);
    const kind = inferGrantKind(pattern);
    await tx`
      INSERT INTO grants (organization_id, agent_id, kind, pattern, expires_at, granted_at, denied)
      VALUES (${organizationId}, ${agentId}, ${kind}, ${pattern}, NULL, NOW(), false)
      ON CONFLICT (organization_id, agent_id, kind, pattern) DO UPDATE SET
        expires_at = NULL, granted_at = NOW(), denied = false
    `;
  }
}

function stateFromCommandRow(
  command: Pick<NativePatchCommand | ManagedEnrollmentCommand, 'organizationId' | 'agentId' | 'commandId'>,
  row: CommandRow,
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
      appliedAt: new Date(row.applied_at).toISOString(),
    },
    managedRelease: null,
  };
}

const MANAGED_ENROLLMENT_CAPABILITY_ID = 'agent_configuration_authority.v1';

function rejectedEnrollment(
  reason:
    | 'invalid_release'
    | 'stale_release'
    | 'environment_mismatch'
    | 'capability_inactive'
    | 'enrollment_drifted'
): AgentConfigurationEnrollmentResult {
  return { status: 'rejected', reason };
}

export async function enrollToolboxManagedInTransaction(
  tx: DbClient,
  command: ManagedEnrollmentCommand,
): Promise<AgentConfigurationEnrollmentResult> {
  const agents = await tx<AgentSettingsRow>`
    SELECT owner_user_id, model, model_selection, provider_model_preferences,
           network_config, egress_config, nix_config, mcp_servers,
           soul_md, user_md, identity_md, skills_config, tools_config,
           plugins_config, installed_providers, verbose_logging,
           pre_approved_tools, guardrails
    FROM agents
    WHERE organization_id = ${command.organizationId} AND id = ${command.agentId}
    FOR UPDATE
  `;
  const agent = agents[0];
  if (!agent) throw new AgentConfigurationError('agent_configuration_not_found');

  await tx`
    INSERT INTO agent_configuration_controls (organization_id, agent_id)
    VALUES (${command.organizationId}, ${command.agentId})
    ON CONFLICT (organization_id, agent_id) DO NOTHING
  `;
  const controls = await tx<ControlRow>`
    SELECT management_mode, configuration_revision::text AS configuration_revision,
           last_mutation_kind, last_command_id, last_command_digest
    FROM agent_configuration_controls
    WHERE organization_id = ${command.organizationId} AND agent_id = ${command.agentId}
    FOR UPDATE
  `;
  const control = controls[0];
  if (!control) throw new AgentConfigurationError('agent_configuration_not_found');
  const currentRevision = String(control.configuration_revision);

  const priorCommands = await tx<CommandRow>`
    SELECT command_digest, mutation_kind, applied_at,
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

  if (control.management_mode === 'toolbox_managed') {
    return {
      status: 'already_managed',
      managementMode: 'toolbox_managed',
      configurationRevision: currentRevision,
    };
  }
  if (command.expectedConfigurationRevision !== currentRevision) {
    return {
      status: 'conflict',
      conflict: 'revision_mismatch',
      currentRevision,
    };
  }
  if (command.environment !== command.runtimeEnvironment) {
    return rejectedEnrollment('environment_mismatch');
  }
  if (agent.owner_user_id !== command.toolboxUserId) {
    return rejectedEnrollment('invalid_release');
  }
  if (command.snapshot.environment !== command.environment) {
    return rejectedEnrollment('environment_mismatch');
  }
  if (
    command.snapshot.toolboxUserId !== command.toolboxUserId ||
    command.snapshot.agentId !== command.agentId
  ) {
    return rejectedEnrollment('invalid_release');
  }
  const expiresAt = Date.parse(command.snapshot.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    return rejectedEnrollment('stale_release');
  }
  try {
    validateRuntimeCapabilitySnapshot(
      command.snapshot,
      {
        environment: command.snapshot.environment,
        toolboxUserId: command.snapshot.toolboxUserId,
        agentId: command.snapshot.agentId,
      },
      new Date(),
    );
  } catch {
    return rejectedEnrollment('invalid_release');
  }

  const receipts = await tx<EnrollmentReceiptRow>`
    SELECT environment, desired_release_id, desired_release_sequence,
           desired_feed_sequence, applied_release_id, applied_release_sequence,
           applied_feed_sequence, status, settings_hash, personal_baseline_settings,
           personal_baseline_effective_settings_digest
    FROM agent_release_applies
    WHERE organization_id = ${command.organizationId} AND agent_id = ${command.agentId}
    LIMIT 1
    FOR SHARE
  `;
  const receipt = receipts[0];
  if (!receipt) return rejectedEnrollment('invalid_release');
  if (receipt.environment !== command.environment) {
    return rejectedEnrollment('environment_mismatch');
  }
  if (
    receipt.status !== 'applied' ||
    receipt.desired_release_id !== receipt.applied_release_id ||
    receipt.desired_release_sequence !== receipt.applied_release_sequence ||
    receipt.desired_feed_sequence !== receipt.applied_feed_sequence
  ) {
    return rejectedEnrollment('stale_release');
  }
  if (
    command.snapshot.appliedReleaseId !== receipt.applied_release_id ||
    command.snapshot.appliedReleaseSequence !== Number(receipt.applied_release_sequence)
  ) {
    return rejectedEnrollment('stale_release');
  }
  if (!command.snapshot.capabilities.includes(MANAGED_ENROLLMENT_CAPABILITY_ID)) {
    return rejectedEnrollment('capability_inactive');
  }
  if (
    receipt.personal_baseline_effective_settings_digest !== null &&
    receipt.personal_baseline_effective_settings_digest !== receipt.settings_hash
  ) {
    return rejectedEnrollment('enrollment_drifted');
  }
  const capabilityState = classifyAgentReleaseCapabilityState({
    agent: {
      ...agent,
      owner_user_id: command.toolboxUserId,
      verbose_logging: agent.verbose_logging ?? false,
    },
    receipt,
    agentId: command.agentId,
    environment: command.environment,
    snapshot: command.snapshot,
  });
  if (capabilityState.status !== 'active') {
    return rejectedEnrollment('enrollment_drifted');
  }

  const updated = await tx<{ configuration_revision: string }>`
    UPDATE agent_configuration_controls
    SET management_mode = 'toolbox_managed',
        configuration_revision = configuration_revision + 1,
        last_mutation_kind = 'managed_enrollment',
        last_command_id = ${command.commandId},
        last_command_digest = ${command.commandDigest},
        updated_at = NOW()
    WHERE organization_id = ${command.organizationId}
      AND agent_id = ${command.agentId}
      AND management_mode = 'native'
      AND configuration_revision = ${command.expectedConfigurationRevision}::bigint
    RETURNING configuration_revision::text AS configuration_revision
  `;
  const resultingRevision = updated[0]?.configuration_revision;
  if (!resultingRevision) {
    return {
      status: 'conflict',
      conflict: 'revision_mismatch',
      currentRevision,
    };
  }
  const settingsDigest = await readAgentConfigurationSettingsDigest(tx, command);
  const commandRows = await tx<{ applied_at: Date | string }>`
    INSERT INTO agent_configuration_commands (
      organization_id, agent_id, command_id, command_digest, mutation_kind,
      resulting_revision, resulting_mode, resulting_settings_digest, result_status
    ) VALUES (
      ${command.organizationId}, ${command.agentId}, ${command.commandId},
      ${command.commandDigest}, 'managed_enrollment', ${resultingRevision}::bigint,
      'toolbox_managed', ${settingsDigest}, 'applied'
    ) RETURNING applied_at
  `;
  return {
    status: 'applied',
    state: {
      organizationId: command.organizationId,
      agentId: command.agentId,
      managementMode: 'toolbox_managed',
      configurationRevision: String(resultingRevision),
      settingsDigest,
      lastMutation: {
        kind: 'managed_enrollment',
        commandId: command.commandId,
        appliedAt: commandAppliedAt(commandRows),
      },
      managedRelease: null,
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
  patch: NativePatchCommand['patch'],
): Record<string, unknown> {
  const projected = settingsProjection(agent);
  for (const [key, value] of Object.entries(normalizeNativeSettingsPatchForPersistence(patch))) {
    projected[key] = value;
  }
  return projected;
}

async function legacyReleasePredicateRejectedFields(
  tx: DbClient,
  command: NativePatchCommand,
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
  command: NativePatchCommand,
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
    SELECT command_digest, mutation_kind, applied_at,
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

  if (
    control.management_mode === 'toolbox_managed' &&
    command.expectedConfigurationRevision === null
  ) {
    throw new AgentConfigurationError(
      'agent_configuration_revision_required',
      currentRevision,
    );
  }

  const expectedConfigurationRevision = command.expectedConfigurationRevision ?? currentRevision;
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
      'shadow_decision_mismatch',
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
    const updatedAgents = await tx`
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
        AND EXISTS (
          SELECT 1 FROM agent_configuration_controls control
          WHERE control.organization_id = ${command.organizationId}
            AND control.agent_id = ${command.agentId}
            AND control.configuration_revision = ${expectedConfigurationRevision}::bigint
        )
      RETURNING 1
    `;
    if (updatedAgents.length === 0) {
      return {
        status: 'conflict',
        conflict: 'revision_mismatch',
        currentRevision,
      };
    }
  }

  const resultingSettingsDigest = sha256Canonical(resultingSettings);
  const updatedControls = await tx`
    UPDATE agent_configuration_controls
    SET configuration_revision = ${resultingRevision}::bigint,
        last_mutation_kind = 'native_patch',
        last_command_id = ${command.commandId},
        last_command_digest = ${command.commandDigest},
        updated_at = NOW()
    WHERE organization_id = ${command.organizationId} AND agent_id = ${command.agentId}
      AND configuration_revision = ${expectedConfigurationRevision}::bigint
    RETURNING 1
  `;
  if (updatedControls.length === 0) {
    throw new AgentConfigurationError(
      'agent_configuration_revision_mismatch',
      currentRevision,
    );
  }
  const commandRows = await tx<{ applied_at: Date | string }>`
    INSERT INTO agent_configuration_commands (
      organization_id, agent_id, command_id, command_digest, mutation_kind,
      resulting_revision, resulting_mode, resulting_settings_digest, result_status
    ) VALUES (
      ${command.organizationId}, ${command.agentId}, ${command.commandId},
      ${command.commandDigest}, 'native_patch', ${resultingRevision}::bigint,
      ${control.management_mode}, ${resultingSettingsDigest}, ${resultStatus}
    ) RETURNING applied_at
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
        appliedAt: commandAppliedAt(commandRows),
      },
      managedRelease: null,
    },
  };
}

export async function lockAgentAndConfigurationControl(
  tx: DbClient,
  input: { organizationId: string; agentId: string },
): Promise<LockedConfigurationControl> {
  const agents = await tx`
    SELECT id
    FROM agents
    WHERE organization_id = ${input.organizationId} AND id = ${input.agentId}
    FOR UPDATE
  `;
  if (!agents[0]) throw new AgentConfigurationError('agent_configuration_not_found');
  await tx`
    INSERT INTO agent_configuration_controls (organization_id, agent_id)
    VALUES (${input.organizationId}, ${input.agentId})
    ON CONFLICT (organization_id, agent_id) DO NOTHING
  `;
  const controls = await tx<ControlRow & { last_applied_at: Date | string | null }>`
    SELECT control.management_mode,
           control.configuration_revision::text AS configuration_revision,
           control.last_mutation_kind, control.last_command_id, control.last_command_digest,
           command_row.applied_at AS last_applied_at
    FROM agent_configuration_controls control
    LEFT JOIN agent_configuration_commands command_row
      ON command_row.organization_id = control.organization_id
     AND command_row.agent_id = control.agent_id
     AND command_row.command_id = control.last_command_id
    WHERE control.organization_id = ${input.organizationId}
      AND control.agent_id = ${input.agentId}
    FOR UPDATE OF control
  `;
  const control = controls[0];
  if (!control) throw new AgentConfigurationError('agent_configuration_not_found');
  return {
    managementMode: control.management_mode,
    configurationRevision: String(control.configuration_revision),
    lastMutationKind: control.last_mutation_kind ?? null,
    lastCommandId: control.last_command_id ?? null,
    lastCommandDigest: control.last_command_digest ?? null,
    lastAppliedAt: control.last_applied_at
      ? new Date(control.last_applied_at).toISOString()
      : null,
  };
}

export async function findConfigurationCommand(
  tx: DbClient,
  input: { organizationId: string; agentId: string; commandId: string },
): Promise<ConfigurationCommandReplay | null> {
  const rows = await tx<CommandRow>`
    SELECT command_digest, mutation_kind, applied_at,
           resulting_revision::text AS resulting_revision, resulting_mode,
           resulting_settings_digest, result_status
    FROM agent_configuration_commands
    WHERE organization_id = ${input.organizationId}
      AND agent_id = ${input.agentId}
      AND command_id = ${input.commandId}
  `;
  const row = rows[0];
  return row
    ? {
        commandDigest: row.command_digest,
        mutationKind: row.mutation_kind,
        resultingRevision: String(row.resulting_revision),
        resultingMode: row.resulting_mode,
        resultingSettingsDigest: row.resulting_settings_digest,
        resultStatus: row.result_status,
        appliedAt: new Date(row.applied_at).toISOString(),
      }
    : null;
}

export async function readAgentConfigurationSettingsDigest(
  tx: DbClient,
  input: { organizationId: string; agentId: string }
): Promise<Sha256Digest> {
  const rows = await tx<AgentSettingsRow>`
    SELECT model, model_selection, provider_model_preferences,
           network_config, egress_config, nix_config, mcp_servers,
           soul_md, user_md, identity_md, skills_config, tools_config,
           plugins_config, installed_providers, verbose_logging,
           pre_approved_tools, guardrails
    FROM agents
    WHERE organization_id = ${input.organizationId} AND id = ${input.agentId}
  `;
  const row = rows[0];
  if (!row) throw new AgentConfigurationError('agent_configuration_not_found');
  return sha256Canonical(settingsProjection(row));
}

export async function recordManagedReleaseConfigurationMutation(
  tx: DbClient,
  input: {
    organizationId: string;
    agentId: string;
    commandId: string;
    commandDigest: Sha256Digest;
    currentRevision: string;
    managementMode: ConfigurationManagementMode;
    settingsDigest: Sha256Digest;
  },
): Promise<AppliedAgentConfigurationState> {
  const resultingRevision = (BigInt(input.currentRevision) + 1n).toString();
  const updated = await tx`
    UPDATE agent_configuration_controls
    SET configuration_revision = ${resultingRevision}::bigint,
        last_mutation_kind = 'managed_release',
        last_command_id = ${input.commandId},
        last_command_digest = ${input.commandDigest},
        updated_at = NOW()
    WHERE organization_id = ${input.organizationId} AND agent_id = ${input.agentId}
      AND configuration_revision = ${input.currentRevision}::bigint
    RETURNING 1
  `;
  if (updated.length === 0) {
    throw new AgentConfigurationError(
      'agent_configuration_revision_mismatch',
      input.currentRevision,
    );
  }
  const commandRows = await tx<{ applied_at: Date | string }>`
    INSERT INTO agent_configuration_commands (
      organization_id, agent_id, command_id, command_digest, mutation_kind,
      resulting_revision, resulting_mode, resulting_settings_digest, result_status
    ) VALUES (
      ${input.organizationId}, ${input.agentId}, ${input.commandId},
      ${input.commandDigest}, 'managed_release', ${resultingRevision}::bigint,
      ${input.managementMode}, ${input.settingsDigest}, 'applied'
    ) RETURNING applied_at
  `;
  return {
    organizationId: input.organizationId,
    agentId: input.agentId,
    managementMode: input.managementMode,
    configurationRevision: resultingRevision,
    settingsDigest: input.settingsDigest,
    lastMutation: {
      kind: 'managed_release',
      commandId: input.commandId,
      appliedAt: commandAppliedAt(commandRows),
    },
    managedRelease: null,
  };
}

export async function recordBootstrapConfigurationMutation(
  tx: DbClient,
  input: {
    organizationId: string;
    agentId: string;
    commandId: string;
    commandDigest: Sha256Digest;
    currentRevision: string;
    settingsDigest: Sha256Digest;
  },
): Promise<AppliedAgentConfigurationState> {
  const resultingRevision = (BigInt(input.currentRevision) + 1n).toString();
  const updated = await tx`
    UPDATE agent_configuration_controls
    SET configuration_revision = ${resultingRevision}::bigint,
        last_mutation_kind = 'bootstrap',
        last_command_id = ${input.commandId},
        last_command_digest = ${input.commandDigest},
        updated_at = NOW()
    WHERE organization_id = ${input.organizationId} AND agent_id = ${input.agentId}
      AND configuration_revision = ${input.currentRevision}::bigint
    RETURNING 1
  `;
  if (updated.length === 0) {
    throw new AgentConfigurationError(
      'agent_configuration_revision_mismatch',
      input.currentRevision,
    );
  }
  const commandRows = await tx<{ applied_at: Date | string }>`
    INSERT INTO agent_configuration_commands (
      organization_id, agent_id, command_id, command_digest, mutation_kind,
      resulting_revision, resulting_mode, resulting_settings_digest, result_status
    ) VALUES (
      ${input.organizationId}, ${input.agentId}, ${input.commandId},
      ${input.commandDigest}, 'bootstrap', ${resultingRevision}::bigint,
      'native', ${input.settingsDigest}, 'applied'
    ) RETURNING applied_at
  `;
  return {
    organizationId: input.organizationId,
    agentId: input.agentId,
    managementMode: 'native',
    configurationRevision: resultingRevision,
    settingsDigest: input.settingsDigest,
    lastMutation: {
      kind: 'bootstrap',
      commandId: input.commandId,
      appliedAt: commandAppliedAt(commandRows),
    },
    managedRelease: null,
  };
}
