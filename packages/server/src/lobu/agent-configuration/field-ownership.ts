import type { AgentSettings } from '@lobu/core';
import type {
  AgentConfigurationRejectionReason,
  ConfigurationManagementMode,
  NativeSettingsPatch,
} from './types';

export type AgentSettingKey = Exclude<keyof AgentSettings, 'updatedAt'>;
export type AgentSettingOwner =
  | 'release'
  | 'release_legacy'
  | 'lobu_operator'
  | 'runtime'
  | 'credential';

export const AGENT_SETTING_OWNERS = {
  model: 'release_legacy',
  modelSelection: 'release',
  providerModelPreferences: 'release',
  networkConfig: 'release',
  egressConfig: 'release',
  nixConfig: 'release',
  mcpServers: 'release',
  mcpInstallNotified: 'runtime',
  soulMd: 'release',
  userMd: 'release',
  identityMd: 'release',
  skillsConfig: 'release',
  toolsConfig: 'release',
  guardrails: 'release',
  pluginsConfig: 'release',
  authProfiles: 'credential',
  installedProviders: 'release',
  verboseLogging: 'lobu_operator',
  preApprovedTools: 'release',
} as const satisfies Record<AgentSettingKey, AgentSettingOwner>;

export type NativeSettingsPatchPolicyDecision = {
  allowedFields: AgentSettingKey[];
  rejectedFields: AgentSettingKey[];
  reason: AgentConfigurationRejectionReason | null;
};

export class AgentConfigurationFieldError extends Error {
  constructor(readonly reason: AgentConfigurationRejectionReason) {
    super(reason);
    this.name = 'AgentConfigurationFieldError';
  }
}

export function ownerOfAgentSetting(key: AgentSettingKey): AgentSettingOwner {
  return AGENT_SETTING_OWNERS[key];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function parseNativeSettingsPatch(value: unknown): NativeSettingsPatch {
  if (!isPlainObject(value)) {
    throw new AgentConfigurationFieldError('unknown_configuration_field');
  }

  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(AGENT_SETTING_OWNERS, key)) {
      throw new AgentConfigurationFieldError('unknown_configuration_field');
    }
    const owner = AGENT_SETTING_OWNERS[key as AgentSettingKey];
    if (owner === 'runtime') {
      throw new AgentConfigurationFieldError('runtime_field_requires_runtime_api');
    }
    if (owner === 'credential') {
      throw new AgentConfigurationFieldError('credential_field_requires_credential_api');
    }
  }

  return value as NativeSettingsPatch;
}

export function decideNativeSettingsPatch(
  managementMode: ConfigurationManagementMode,
  patch: NativeSettingsPatch
): NativeSettingsPatchPolicyDecision {
  const fields = Object.keys(patch) as AgentSettingKey[];
  if (managementMode === 'native') {
    return { allowedFields: fields, rejectedFields: [], reason: null };
  }

  const rejectedFields = fields.filter((field) => {
    const owner = ownerOfAgentSetting(field);
    return owner === 'release' || owner === 'release_legacy';
  });
  return {
    allowedFields: fields.filter((field) => !rejectedFields.includes(field)),
    rejectedFields,
    reason: rejectedFields.length > 0 ? 'field_owned_by_managed_release' : null,
  };
}
