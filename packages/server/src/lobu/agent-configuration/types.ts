import type { AgentSettings } from '@lobu/core';
import type { RuntimeCapabilitySnapshot } from '../../gateway/services/runtime-capability-snapshot';
import type {
  AgentReleaseApplyResult,
  AgentReleasePostApplyEvidence,
} from '../agent-release-service';

export type ConfigurationManagementMode = 'native' | 'toolbox_managed';

export const AGENT_CONFIGURATION_VERSION_HEADER =
  'Lobu-Agent-Configuration-Version';
export const AGENT_CONFIGURATION_RESPONSE_VERSION = '1';
export type AgentConfigurationResponseVersion =
  typeof AGENT_CONFIGURATION_RESPONSE_VERSION;

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

export interface ManagedEnrollmentCommand extends AgentConfigurationCommandEnvelope {
  kind: 'managed_enrollment';
  expectedConfigurationRevision: string;
  toolboxUserId: string;
  environment: 'staging' | 'production';
  runtimeEnvironment: 'staging' | 'production';
  snapshot: RuntimeCapabilitySnapshot;
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

export type EnrollToolboxManagedInput = Omit<
  ManagedEnrollmentCommand,
  'kind' | 'commandDigest'
>;

export type AgentConfigurationEnrollmentResult =
  | Extract<AgentConfigurationMutationResult, { status: 'conflict' | 'rejected' }>
  | {
      status: 'applied' | 'already_applied';
      state: AppliedAgentConfigurationState;
    }
  | {
      status: 'already_managed';
      managementMode: 'toolbox_managed';
      configurationRevision: string;
    };

export interface ManagedReleaseCommandInput {
  organizationId: string;
  agentId: string;
  command: unknown;
  actor: ConfigurationActor;
  responseVersion?: AgentConfigurationResponseVersion;
}

export interface ManagedReleaseConfigurationResult {
  evidence: AgentReleaseApplyResult | AgentReleasePostApplyEvidence;
  state: AppliedAgentConfigurationState;
}

export type ProvisioningFence = {
  targetId: string;
  claimGeneration: number;
  claimToken: string;
  baselineVersionId: string;
  effectiveSettingsDigest: string;
};

export type ToolboxBootstrap = {
  profile: 'toolbox_personal';
  ownerUserId: string;
  patUserId: string;
  membershipId: string;
  ownerEmail: string;
  fence?: ProvisioningFence;
};

export type NativeBootstrap = {
  profile: 'native';
  ownerPlatform: string;
  ownerUserId: string | null;
};

export type ApplyBootstrapConfigurationInput = {
  kind: 'bootstrap';
  organizationId: string;
  agentId: string;
  commandId: string;
  /**
   * Compatibility provisioning endpoints predate revision preconditions and
   * omit this field. When supplied, the authority enforces it under the lock.
   */
  expectedConfigurationRevision?: string;
  actor: ConfigurationActor;
  name: string;
  description?: string;
  settings: Record<string, unknown>;
  requestDigest: Sha256Digest;
} & (ToolboxBootstrap | NativeBootstrap);

export type AgentConfigurationBootstrapResult =
  | {
      status: 'applied' | 'already_applied';
      created: boolean;
      replayed: boolean;
      membership?: { ensured: true; role: string };
      state: AppliedAgentConfigurationState;
      metadata: { name: string; description?: string };
    }
  | { status: 'rejected'; reason: 'managed_configuration_sealed' };
