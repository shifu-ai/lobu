export type AgentConfigurationErrorCode =
  | 'agent_configuration_not_found'
  | 'invalid_revision_precondition'
  | 'missing_idempotency_key'
  | 'invalid_native_settings_patch';

const ERROR_MESSAGES: Record<AgentConfigurationErrorCode, string> = {
  agent_configuration_not_found: 'Agent configuration target was not found',
  invalid_revision_precondition: 'Agent configuration revision precondition is invalid',
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
