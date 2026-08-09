import type { DbClient } from '../../db/client';
import { createAgentReleaseService } from '../agent-release-service';
import {
  type AgentConfigurationAuthority,
  createAgentConfigurationAuthority,
} from './authority';

export interface RuntimeAgentConfigurationAuthorityOptions {
  agentReleaseTrustedPublicKeysJson?: string;
  agentReleaseEvidenceSigningPrivateKeysJson?: string;
  agentReleaseEnvironment?: string;
  agentReleaseTransactionHooks?: {
    afterAgentLock?: () => Promise<void>;
  };
  agentConfigurationReadHooks?: {
    afterEvidenceRead?: () => Promise<void>;
  };
  agentConfigurationTransactionHooks?: {
    beforeAgentLock?: () => Promise<void>;
  };
  legacyProvisioningHooks?: {
    afterAgentLock?: () => Promise<void>;
  };
  sql?: DbClient;
}

/**
 * Single production composition for release-backed configuration authority.
 * Callers may inject explicit values in tests; runtime callers resolve the
 * same three environment variables and fail closed inside the release service
 * when trust, evidence signing, or environment configuration is unavailable.
 */
export function createRuntimeAgentConfigurationAuthority(
  options: RuntimeAgentConfigurationAuthorityOptions = {},
): AgentConfigurationAuthority {
  const agentReleaseService = createAgentReleaseService({
    trustedPublicKeysJson:
      options.agentReleaseTrustedPublicKeysJson ??
      process.env.AGENT_RELEASE_TRUSTED_PUBLIC_KEYS_JSON,
    evidenceSigningPrivateKeysJson:
      options.agentReleaseEvidenceSigningPrivateKeysJson ??
      process.env.AGENT_RELEASE_EVIDENCE_SIGNING_PRIVATE_KEYS_JSON,
    expectedEnvironment:
      options.agentReleaseEnvironment ?? process.env.AGENT_RELEASE_ENVIRONMENT,
    transactionHooks: options.agentReleaseTransactionHooks,
  });

  return createAgentConfigurationAuthority(options.sql, {
    agentReleaseService,
    readHooks: options.agentConfigurationReadHooks,
    transactionHooks: options.agentConfigurationTransactionHooks,
    bootstrapTransactionHooks: options.legacyProvisioningHooks,
  });
}
