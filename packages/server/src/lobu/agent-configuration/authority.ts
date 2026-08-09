import { createHash } from 'node:crypto';
import { canonicalize } from 'json-canonicalize';
import type { DbClient } from '../../db/client';
import { getDb } from '../../db/client';
import { AgentConfigurationError } from './errors';
import { applyNativePatchInTransaction } from './postgres-repository';
import type {
  AgentConfigurationMutationResult,
  NativePatchCommand,
  NativePatchCommandInput,
  Sha256Digest,
} from './types';

const DECIMAL_REVISION_PATTERN = /^(0|[1-9][0-9]*)$/;

export interface AgentConfigurationAuthority {
  apply(command: NativePatchCommand): Promise<AgentConfigurationMutationResult>;
}

export function createNativePatchCommand(input: NativePatchCommandInput): NativePatchCommand {
  if (!DECIMAL_REVISION_PATTERN.test(input.expectedConfigurationRevision)) {
    throw new AgentConfigurationError('invalid_revision_precondition');
  }
  const canonicalCommand = {
    kind: 'native_patch',
    agentId: input.agentId,
    expectedRevision: input.expectedConfigurationRevision,
    patch: input.patch,
  };
  const commandDigest = `sha256:${createHash('sha256')
    .update(canonicalize(canonicalCommand))
    .digest('hex')}` as Sha256Digest;
  return {
    ...input,
    kind: 'native_patch',
    commandDigest,
  };
}

export function createAgentConfigurationAuthority(sql?: DbClient): AgentConfigurationAuthority {
  return {
    apply(command) {
      return (sql ?? getDb()).begin((tx) => applyNativePatchInTransaction(tx, command));
    },
  };
}
