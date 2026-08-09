import { createHash } from 'node:crypto';
import { canonicalize } from 'json-canonicalize';
import type { DbClient } from '../../db/client';
import { getDb } from '../../db/client';
import { AgentConfigurationError } from './errors';
import { parseNativeSettingsPatch } from './field-ownership';
import { applyNativePatchInTransaction } from './postgres-repository';
import type {
  AgentConfigurationMutationResult,
  NativePatchCommand,
  NativePatchCommandInput,
  NativeSettingsPatch,
  Sha256Digest,
} from './types';

const DECIMAL_REVISION_PATTERN = /^(0|[1-9][0-9]*)$/;

export interface AgentConfigurationAuthority {
  apply(input: NativePatchCommandInput): Promise<AgentConfigurationMutationResult>;
}

function materializeNativePatchCommand(input: NativePatchCommandInput): NativePatchCommand {
  if (
    input.expectedConfigurationRevision !== null &&
    !DECIMAL_REVISION_PATTERN.test(input.expectedConfigurationRevision)
  ) {
    throw new AgentConfigurationError('invalid_revision_precondition');
  }
  const parsedPatch = parseNativeSettingsPatch(input.patch);
  const patch = JSON.parse(canonicalize(parsedPatch)) as NativeSettingsPatch;
  const canonicalCommand = {
    kind: 'native_patch',
    agentId: input.agentId,
    expectedRevision: input.expectedConfigurationRevision,
    patch,
  };
  const commandDigest = `sha256:${createHash('sha256')
    .update(canonicalize(canonicalCommand))
    .digest('hex')}` as Sha256Digest;
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

export function createAgentConfigurationAuthority(sql?: DbClient): AgentConfigurationAuthority {
  return {
    apply(input) {
      const command = materializeNativePatchCommand(input);
      return (sql ?? getDb()).begin((tx) => applyNativePatchInTransaction(tx, command));
    },
  };
}
