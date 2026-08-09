import { createHash } from 'node:crypto';
import type { AgentSettings } from '@lobu/core';
import { canonicalize } from 'json-canonicalize';
import type { DbClient } from '../../db/client';
import { getDb } from '../../db/client';
import { recordLifecycleEvent } from '../../utils/insert-event';
import { AgentConfigurationError, ProvisioningFenceError } from './errors';
import {
  normalizeNativeSettingsPatchForPersistence,
  parseNativeSettingsPatch,
} from './field-ownership';
import {
  addProvisioningGrantsInTransaction,
  findConfigurationCommand,
  lockAgentAndConfigurationControl,
  readAgentConfigurationSettingsDigest,
  recordBootstrapConfigurationMutation,
  replaceAgentConfigurationSettingsInTransaction,
  syncProvisioningGrantsInTransaction,
} from './postgres-repository';
import type {
  AgentConfigurationBootstrapResult,
  ApplyBootstrapConfigurationInput,
  AppliedAgentConfigurationState,
  ProvisioningFence,
  Sha256Digest,
} from './types';

const DECIMAL_REVISION_PATTERN = /^(0|[1-9][0-9]*)$/;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

type MaterializedBootstrap = DistributiveOmit<
  ApplyBootstrapConfigurationInput,
  'settings'
> & {
  settings: Omit<AgentSettings, 'updatedAt'>;
  commandDigest: Sha256Digest;
};

type FenceRow = {
  target_id: string;
  claim_generation: number;
  claim_token: string;
  baseline_version_id: string;
  effective_settings_digest: string;
  request_digest: string;
};

export class AgentProvisioningModeError extends Error {
  constructor(readonly code: 'agent_settings_managed_by_fenced_provisioning') {
    super('Agent settings must be changed through fenced provisioning');
    this.name = 'AgentProvisioningModeError';
  }
}

function sha256Canonical(value: unknown): Sha256Digest {
  return `sha256:${createHash('sha256').update(canonicalize(value)).digest('hex')}`;
}

function materialize(
  input: ApplyBootstrapConfigurationInput
): MaterializedBootstrap {
  if (
    !input.commandId.trim() ||
    (input.expectedConfigurationRevision !== undefined &&
      !DECIMAL_REVISION_PATTERN.test(input.expectedConfigurationRevision))
  ) {
    throw new AgentConfigurationError('invalid_revision_precondition');
  }
  if (!SHA256_PATTERN.test(input.requestDigest)) {
    throw new AgentConfigurationError('invalid_native_settings_patch');
  }
  const parsed = parseNativeSettingsPatch(input.settings);
  const settings = normalizeNativeSettingsPatchForPersistence(parsed) as Omit<
    AgentSettings,
    'updatedAt'
  >;
  const snapshot = JSON.parse(canonicalize(settings)) as typeof settings;
  const durableEffects = {
    kind: 'bootstrap',
    organizationId: input.organizationId,
    agentId: input.agentId,
    commandId: input.commandId,
    ...(input.expectedConfigurationRevision === undefined
      ? {}
      : {
          expectedConfigurationRevision:
            input.expectedConfigurationRevision,
        }),
    actor: input.actor,
    profile: input.profile,
    name: input.name,
    description: input.description ?? null,
    settings: snapshot,
    requestDigest: input.requestDigest,
    ...(input.profile === 'toolbox_personal'
      ? {
          ownerUserId: input.ownerUserId,
          patUserId: input.patUserId,
          membershipId: input.membershipId,
          ownerEmail: input.ownerEmail,
          fence: input.fence ?? null,
        }
      : { ownerPlatform: input.ownerPlatform, ownerUserId: input.ownerUserId }),
  };
  return {
    ...input,
    settings: snapshot,
    commandDigest: sha256Canonical(durableEffects),
  };
}

function exactFenceReplay(
  current: FenceRow,
  fence: ProvisioningFence,
  requestDigest: string
): boolean {
  return (
    fence.targetId === current.target_id &&
    fence.claimGeneration === current.claim_generation &&
    fence.claimToken === current.claim_token &&
    fence.baselineVersionId === current.baseline_version_id &&
    fence.effectiveSettingsDigest === current.effective_settings_digest &&
    requestDigest === current.request_digest
  );
}

function stateFromReplay(
  command: MaterializedBootstrap,
  replay: NonNullable<Awaited<ReturnType<typeof findConfigurationCommand>>>
): AppliedAgentConfigurationState {
  return {
    organizationId: command.organizationId,
    agentId: command.agentId,
    managementMode: replay.resultingMode,
    configurationRevision: replay.resultingRevision,
    settingsDigest: replay.resultingSettingsDigest,
    lastMutation: {
      kind: replay.mutationKind,
      commandId: command.commandId,
      commandDigest: replay.commandDigest,
    },
  };
}

function metadataWithDescription(
  name: string,
  description: string | null | undefined
): { name: string; description?: string } {
  return description == null ? { name } : { name, description };
}

export function createAgentConfigurationBootstrap(
  sql?: DbClient,
  options: { transactionHooks?: { afterAgentLock?: () => Promise<void> } } = {}
): {
  apply(
    input: ApplyBootstrapConfigurationInput
  ): Promise<AgentConfigurationBootstrapResult>;
} {
  return {
    async apply(input) {
      const command = materialize(input);
      const result = await (sql ?? getDb()).begin(async (tx) => {
        const inserted = await tx`
          INSERT INTO agents (
            id, organization_id, name, description, owner_platform, owner_user_id,
            is_workspace_agent, workspace_id, created_at, updated_at
          ) VALUES (
            ${command.agentId}, ${command.organizationId}, ${command.name},
            ${command.description ?? null},
            ${command.profile === 'toolbox_personal' ? 'toolbox' : command.ownerPlatform},
            ${command.ownerUserId}, false, NULL, NOW(), NOW()
          )
          ON CONFLICT (organization_id, id) DO NOTHING
          RETURNING 1
        `;
        const created = inserted.length > 0;
        const control = await lockAgentAndConfigurationControl(tx, command);
        await options.transactionHooks?.afterAgentLock?.();

        if (control.managementMode === 'toolbox_managed') {
          return {
            status: 'rejected',
            reason: 'managed_configuration_sealed',
          } as const;
        }

        const existingMetadata = await tx<{
          name: string;
          description: string | null;
        }>`
          SELECT name, description FROM agents
          WHERE organization_id = ${command.organizationId} AND id = ${command.agentId}
        `;
        const replay = await findConfigurationCommand(tx, command);

        if (command.profile === 'native' && !created) {
          if (replay) {
            if (replay.commandDigest !== command.commandDigest) {
              throw new AgentConfigurationError(
                'agent_configuration_command_conflict',
                control.configurationRevision
              );
            }
            return {
              status: 'already_applied' as const,
              created: false,
              replayed: true,
              state: stateFromReplay(command, replay),
              metadata: metadataWithDescription(
                existingMetadata[0]?.name ?? command.name,
                existingMetadata[0]?.description
              ),
            };
          }
          const settingsDigest = await readAgentConfigurationSettingsDigest(
            tx,
            command
          );
          return {
            status: 'already_applied' as const,
            created: false,
            replayed: true,
            state: {
              organizationId: command.organizationId,
              agentId: command.agentId,
              managementMode: control.managementMode,
              configurationRevision: control.configurationRevision,
              settingsDigest,
              lastMutation: {
                kind: control.lastMutationKind ?? 'bootstrap',
                commandId: control.lastCommandId ?? command.commandId,
                commandDigest:
                  control.lastCommandDigest ?? command.commandDigest,
              },
            },
            metadata: metadataWithDescription(
              existingMetadata[0]?.name ?? command.name,
              existingMetadata[0]?.description
            ),
          };
        }

        let currentFence: FenceRow | undefined;
        if (command.profile === 'toolbox_personal') {
          const receipts = await tx`
            SELECT 1 FROM agent_release_applies
            WHERE organization_id = ${command.organizationId} AND agent_id = ${command.agentId}
              AND status = 'applied' AND applied_at IS NOT NULL
            LIMIT 1
          `;
          if (receipts.length > 0) {
            return {
              status: 'rejected',
              reason: 'managed_configuration_sealed',
            } as const;
          }
          const fences = await tx<FenceRow>`
            SELECT target_id, claim_generation, claim_token, baseline_version_id,
                   effective_settings_digest, request_digest
            FROM agent_provisioning_fences
            WHERE organization_id = ${command.organizationId} AND agent_id = ${command.agentId}
          `;
          currentFence = fences[0];
          if (!command.fence && currentFence) {
            throw new AgentProvisioningModeError(
              'agent_settings_managed_by_fenced_provisioning'
            );
          }
          if (command.fence && currentFence) {
            if (command.fence.claimGeneration < currentFence.claim_generation) {
              throw new ProvisioningFenceError('provisioning_fence_stale');
            }
            if (
              command.fence.claimGeneration === currentFence.claim_generation
            ) {
              if (
                !exactFenceReplay(
                  currentFence,
                  command.fence,
                  command.requestDigest
                )
              ) {
                throw new ProvisioningFenceError('provisioning_fence_conflict');
              }
              if (replay && replay.commandDigest !== command.commandDigest) {
                throw new AgentConfigurationError(
                  'agent_configuration_command_conflict',
                  control.configurationRevision
                );
              }
              const memberships = await tx<{ role: string }>`
                SELECT role FROM "member"
                WHERE "organizationId" = ${command.organizationId}
                  AND "userId" = ${command.ownerUserId}
                LIMIT 1
              `;
              const prior = replay;
              const settingsDigest =
                prior?.resultingSettingsDigest ??
                (await readAgentConfigurationSettingsDigest(tx, command));
              return {
                status: 'already_applied' as const,
                created: false,
                replayed: true,
                membership: {
                  ensured: true as const,
                  role: String(memberships[0]?.role ?? 'member'),
                },
                state: prior
                  ? stateFromReplay(command, prior)
                  : {
                      organizationId: command.organizationId,
                      agentId: command.agentId,
                      managementMode: control.managementMode,
                      configurationRevision: control.configurationRevision,
                      settingsDigest,
                      lastMutation: {
                        kind: control.lastMutationKind ?? 'bootstrap',
                        commandId: control.lastCommandId ?? command.commandId,
                        commandDigest:
                          control.lastCommandDigest ?? command.commandDigest,
                      },
                    },
                metadata: metadataWithDescription(
                  existingMetadata[0]?.name ?? command.name,
                  existingMetadata[0]?.description
                ),
              };
            }
          }
          if (replay && replay.commandDigest !== command.commandDigest) {
            throw new AgentConfigurationError(
              'agent_configuration_command_conflict',
              control.configurationRevision
            );
          }
          if (replay) {
            const memberships = await tx<{ role: string }>`
              SELECT role FROM "member"
              WHERE "organizationId" = ${command.organizationId}
                AND "userId" = ${command.ownerUserId}
              LIMIT 1
            `;
            return {
              status: 'already_applied' as const,
              created: false,
              replayed: true,
              membership: {
                ensured: true as const,
                role: String(memberships[0]?.role ?? 'member'),
              },
              state: stateFromReplay(command, replay),
              metadata: metadataWithDescription(
                existingMetadata[0]?.name ?? command.name,
                existingMetadata[0]?.description
              ),
            };
          }

          if (
            command.expectedConfigurationRevision !== undefined &&
            command.expectedConfigurationRevision !== control.configurationRevision
          ) {
            throw new AgentConfigurationError(
              'agent_configuration_revision_mismatch',
              control.configurationRevision
            );
          }

          await tx`
            INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
            VALUES (${command.ownerUserId}, ${command.ownerUserId}, ${command.ownerEmail}, true, NOW(), NOW())
            ON CONFLICT (id) DO NOTHING
          `;
          await tx`
            INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt")
            VALUES (${command.membershipId}, ${command.organizationId}, ${command.ownerUserId}, 'member', NOW())
            ON CONFLICT ("organizationId", "userId") DO NOTHING
          `;
          await tx`
            UPDATE agents SET name = ${command.name}, description = ${command.description ?? null},
              owner_platform = 'toolbox', owner_user_id = ${command.ownerUserId},
              is_workspace_agent = false, workspace_id = NULL, updated_at = NOW()
            WHERE organization_id = ${command.organizationId} AND id = ${command.agentId}
          `;
          await tx`
            DELETE FROM agent_users
            WHERE organization_id = ${command.organizationId} AND agent_id = ${command.agentId}
              AND platform = 'toolbox' AND user_id <> ${command.ownerUserId}
          `;
          await tx`
            INSERT INTO agent_users (organization_id, agent_id, platform, user_id, created_at)
            VALUES
              (${command.organizationId}, ${command.agentId}, 'toolbox', ${command.ownerUserId}, NOW()),
              (${command.organizationId}, ${command.agentId}, 'external', ${command.patUserId}, NOW())
            ON CONFLICT (organization_id, agent_id, platform, user_id) DO NOTHING
          `;
          await replaceAgentConfigurationSettingsInTransaction(
            tx,
            command.organizationId,
            command.agentId,
            command.settings
          );
          if (command.fence) {
            await syncProvisioningGrantsInTransaction(
              tx,
              command.organizationId,
              command.agentId,
              command.settings
            );
            await tx`
              INSERT INTO agent_provisioning_fences (
                organization_id, agent_id, target_id, claim_generation, claim_token,
                baseline_version_id, effective_settings_digest, request_digest, created_at, updated_at
              ) VALUES (
                ${command.organizationId}, ${command.agentId}, ${command.fence.targetId},
                ${command.fence.claimGeneration}, ${command.fence.claimToken},
                ${command.fence.baselineVersionId}, ${command.fence.effectiveSettingsDigest},
                ${command.requestDigest}, NOW(), NOW()
              )
              ON CONFLICT (organization_id, agent_id) DO UPDATE SET
                target_id = EXCLUDED.target_id, claim_generation = EXCLUDED.claim_generation,
                claim_token = EXCLUDED.claim_token, baseline_version_id = EXCLUDED.baseline_version_id,
                effective_settings_digest = EXCLUDED.effective_settings_digest,
                request_digest = EXCLUDED.request_digest, updated_at = NOW()
            `;
          } else {
            await addProvisioningGrantsInTransaction(
              tx,
              command.organizationId,
              command.agentId,
              command.settings
            );
          }
          const memberships = await tx<{ role: string }>`
            SELECT role FROM "member"
            WHERE "organizationId" = ${command.organizationId} AND "userId" = ${command.ownerUserId}
            LIMIT 1
          `;
          const settingsDigest = await readAgentConfigurationSettingsDigest(
            tx,
            command
          );
          const state = await recordBootstrapConfigurationMutation(tx, {
            ...command,
            currentRevision: control.configurationRevision,
            settingsDigest,
          });
          return {
            status: 'applied' as const,
            created,
            replayed: false,
            membership: {
              ensured: true as const,
              role: String(memberships[0]?.role ?? 'member'),
            },
            state,
            metadata: metadataWithDescription(command.name, command.description),
          };
        }

        if (
          command.expectedConfigurationRevision !== undefined &&
          command.expectedConfigurationRevision !== control.configurationRevision
        ) {
          throw new AgentConfigurationError(
            'agent_configuration_revision_mismatch',
            control.configurationRevision
          );
        }

        await replaceAgentConfigurationSettingsInTransaction(
          tx,
          command.organizationId,
          command.agentId,
          command.settings
        );
        if (command.ownerUserId) {
          await tx`
            INSERT INTO agent_users (organization_id, agent_id, platform, user_id, created_at)
            VALUES (${command.organizationId}, ${command.agentId}, ${command.ownerPlatform}, ${command.ownerUserId}, NOW())
            ON CONFLICT (organization_id, agent_id, platform, user_id) DO NOTHING
          `;
        }
        const settingsDigest = await readAgentConfigurationSettingsDigest(
          tx,
          command
        );
        const state = await recordBootstrapConfigurationMutation(tx, {
          ...command,
          currentRevision: control.configurationRevision,
          settingsDigest,
        });
        return {
          status: 'applied' as const,
          created: true,
          replayed: false,
          state,
          metadata: metadataWithDescription(command.name, command.description),
        };
      });

      if (result.status === 'applied' && input.profile === 'toolbox_personal') {
        recordLifecycleEvent({
          organizationId: input.organizationId,
          entityType: 'agent',
          op: result.created ? 'created' : 'updated',
          entityId: input.agentId,
          summary: result.created
            ? `Agent "${input.name}" created`
            : `Agent "${input.name}" updated`,
        });
      }
      return result;
    },
  };
}
