import { createHash } from 'node:crypto';
import type { AgentSettings } from '@lobu/core';
import { canonicalize } from 'json-canonicalize';
import { AgentConfigurationError } from './errors';
import {
  normalizeNativeSettingsPatchForPersistence,
  parseNativeSettingsPatch,
} from './field-ownership';
import type {
  NativePatchCommand,
  NativePatchCommandInput,
  NativeSettingsPatch,
  Sha256Digest,
} from './types';

const DECIMAL_REVISION_PATTERN = /^(0|[1-9][0-9]*)$/;

export function sha256Canonical(value: unknown): Sha256Digest {
  return `sha256:${createHash('sha256').update(canonicalize(value)).digest('hex')}`;
}

/** The exact 17-field durable settings projection owned by configuration authority. */
export function projectAgentConfigurationSettings(
  settings: Partial<AgentSettings>,
): Record<string, unknown> {
  return {
    model: settings.model ?? null,
    modelSelection: settings.modelSelection ?? {},
    providerModelPreferences: settings.providerModelPreferences ?? {},
    networkConfig: settings.networkConfig ?? {},
    egressConfig: settings.egressConfig ?? {},
    nixConfig: settings.nixConfig ?? {},
    mcpServers: settings.mcpServers ?? {},
    soulMd: settings.soulMd ?? '',
    userMd: settings.userMd ?? '',
    identityMd: settings.identityMd ?? '',
    skillsConfig: settings.skillsConfig ?? { skills: [] },
    toolsConfig: settings.toolsConfig ?? {},
    pluginsConfig: settings.pluginsConfig ?? {},
    installedProviders: settings.installedProviders ?? [],
    verboseLogging: settings.verboseLogging ?? false,
    preApprovedTools: settings.preApprovedTools ?? [],
    guardrails: settings.guardrails ?? [],
  };
}

export function projectAgentConfigurationSettingsAfterPatch(
  settings: Partial<AgentSettings>,
  patch: NativeSettingsPatch,
): Record<string, unknown> {
  return {
    ...projectAgentConfigurationSettings(settings),
    ...normalizeNativeSettingsPatchForPersistence(patch),
  };
}

export function digestAgentConfigurationSettings(
  settings: Partial<AgentSettings>,
): Sha256Digest {
  return sha256Canonical(projectAgentConfigurationSettings(settings));
}

export function materializeNativePatchCommand(
  input: NativePatchCommandInput,
): NativePatchCommand {
  if (
    input.expectedConfigurationRevision !== null &&
    !DECIMAL_REVISION_PATTERN.test(input.expectedConfigurationRevision)
  ) {
    throw new AgentConfigurationError('invalid_revision_precondition');
  }
  const parsedPatch = parseNativeSettingsPatch(input.patch);
  const patch = parseNativeSettingsPatch(JSON.parse(canonicalize(parsedPatch)));
  const commandDigest = sha256Canonical({
    kind: 'native_patch',
    agentId: input.agentId,
    expectedRevision: input.expectedConfigurationRevision,
    patch: normalizeNativeSettingsPatchForPersistence(patch),
  });
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
