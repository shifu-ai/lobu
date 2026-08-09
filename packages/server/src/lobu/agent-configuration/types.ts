import type { AgentSettings } from '@lobu/core';
import type {
  AgentReleaseApplyResult,
  AgentReleasePostApplyEvidence,
} from '../agent-release-service';

export type ConfigurationManagementMode = 'native' | 'toolbox_managed';

export type ConfigurationMutationKind =
  | 'bootstrap'
  | 'native_patch'
  | 'managed_release'
  | 'managed_enrollment';

export type ConfigurationActorKind =
  | 'session'
  | 'admin_pat'
  | 'provider_catalog'
  | 'provisioning'
  | 'release';

export type Sha256Digest = `sha256:${string}`;

export interface ConfigurationActor {
  kind: ConfigurationActorKind;
}

export interface AgentConfigurationCommandEnvelope {
  organizationId: string;
  agentId: string;
  commandId: string;
  commandDigest: Sha256Digest;
  expectedConfigurationRevision: string | null;
  actor: ConfigurationActor;
}

type NativeWritableAgentSettingKey = Exclude<
  keyof AgentSettings,
  'updatedAt' | 'authProfiles' | 'mcpInstallNotified'
>;

export type NativeSettingsPatch = {
  [Key in NativeWritableAgentSettingKey]?: AgentSettings[Key] | null;
};

export interface NativePatchCommand extends AgentConfigurationCommandEnvelope {
  kind: 'native_patch';
  patch: NativeSettingsPatch;
}

export interface AppliedAgentConfigurationState {
  organizationId: string;
  agentId: string;
  managementMode: ConfigurationManagementMode;
  configurationRevision: string;
  settingsDigest: Sha256Digest;
  lastMutation: {
    kind: ConfigurationMutationKind;
    commandId: string;
    commandDigest: Sha256Digest;
  };
}

export type AgentConfigurationRejectionReason =
  | 'field_owned_by_managed_release'
  | 'unknown_configuration_field'
  | 'runtime_field_requires_runtime_api'
  | 'credential_field_requires_credential_api'
  | 'managed_configuration_sealed'
  | 'invalid_release'
  | 'stale_release'
  | 'environment_mismatch'
  | 'capability_inactive'
  | 'enrollment_drifted';

export type AgentConfigurationMutationResult =
  | {
      status: 'applied' | 'already_applied' | 'no_change';
      state: AppliedAgentConfigurationState;
    }
  | {
      status: 'conflict';
      conflict: 'revision_mismatch' | 'command_conflict';
      currentRevision: string;
    }
  | {
      status: 'rejected';
      reason: AgentConfigurationRejectionReason;
    };

export type NativePatchCommandInput = Omit<NativePatchCommand, 'kind' | 'commandDigest'>;

export interface ManagedReleaseCommandInput {
  organizationId: string;
  agentId: string;
  command: unknown;
  actor: ConfigurationActor;
}

export interface ManagedReleaseConfigurationResult {
  evidence: AgentReleaseApplyResult | AgentReleasePostApplyEvidence;
  state: AppliedAgentConfigurationState;
}
