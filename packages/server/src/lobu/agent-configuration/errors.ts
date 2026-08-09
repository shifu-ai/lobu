export type AgentConfigurationErrorCode =
  | 'agent_configuration_not_found'
  | 'invalid_revision_precondition'
  | 'agent_configuration_revision_required'
  | 'agent_configuration_revision_mismatch'
  | 'agent_configuration_command_conflict'
  | 'missing_idempotency_key'
  | 'invalid_native_settings_patch';

const ERROR_MESSAGES: Record<AgentConfigurationErrorCode, string> = {
  agent_configuration_not_found: 'Agent configuration target was not found',
  invalid_revision_precondition: 'Agent configuration revision precondition is invalid',
  agent_configuration_revision_required: 'Managed configuration requires a revision precondition',
  agent_configuration_revision_mismatch: 'Agent configuration revision precondition does not match',
  agent_configuration_command_conflict: 'Agent configuration command identity was reused',
  missing_idempotency_key: 'A non-empty Idempotency-Key is required',
  invalid_native_settings_patch: 'Native settings patch is not supported',
};

export class AgentConfigurationError extends Error {
  readonly code: AgentConfigurationErrorCode;
  readonly currentRevision?: string;

  constructor(code: AgentConfigurationErrorCode, currentRevision?: string) {
    super(ERROR_MESSAGES[code]);
    this.name = 'AgentConfigurationError';
    this.code = code;
    this.currentRevision = currentRevision;
  }
}

export class ProvisioningFenceError extends Error {
  constructor(readonly code: 'provisioning_fence_stale' | 'provisioning_fence_conflict') {
    super(code);
    this.name = 'ProvisioningFenceError';
  }
}
