import type { AgentSettings } from '@lobu/core';

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
  expectedConfigurationRevision: string;
  actor: ConfigurationActor;
}

export type NativeSettingsPatch = Partial<
  Omit<AgentSettings, 'updatedAt' | 'authProfiles' | 'mcpInstallNotified'>
>;

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
      reason: string;
    };

export type NativePatchCommandInput = Omit<NativePatchCommand, 'kind' | 'commandDigest'>;
