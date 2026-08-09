import { createHash } from "node:crypto";
import type { AgentConfigStore, AgentSettings } from "@lobu/core";
import type {
  AgentConfigurationMutationResult as ConfigurationMutationResult,
  AgentConfigurationRejectionReason,
  AppliedAgentConfigurationState,
  NativePatchCommandInput as UndigestedNativePatchInput,
  Sha256Digest,
} from "../../lobu/agent-configuration/types.js";

export type {
  AppliedAgentConfigurationState,
  ConfigurationMutationResult,
  UndigestedNativePatchInput,
};

export type ProviderMutationSubject = {
  organizationId: string;
  agentId: string;
};

export interface AgentConfigurationMutationPort {
  readAppliedState(
    subject: ProviderMutationSubject
  ): Promise<AppliedAgentConfigurationState | null>;
  updateNativeConfiguration(
    input: UndigestedNativePatchInput
  ): Promise<ConfigurationMutationResult>;
}

export class AgentConfigurationMutationRejectedError extends Error {
  constructor(readonly reason: AgentConfigurationRejectionReason) {
    super(`Agent configuration mutation rejected: ${reason}`);
    this.name = "AgentConfigurationMutationRejectedError";
  }
}

export class AgentConfigurationMutationConflictError extends Error {
  constructor(
    readonly conflict: "revision_mismatch" | "command_conflict",
    readonly currentRevision: string
  ) {
    super(`Agent configuration mutation conflict: ${conflict}`);
    this.name = "AgentConfigurationMutationConflictError";
  }
}

type AuthorityAdapterTarget = {
  readAppliedState(
    subject: ProviderMutationSubject
  ): Promise<AppliedAgentConfigurationState | null>;
  apply(
    input: UndigestedNativePatchInput
  ): Promise<ConfigurationMutationResult>;
};

export function createAgentConfigurationMutationPort(
  authority: AuthorityAdapterTarget
): AgentConfigurationMutationPort {
  return {
    readAppliedState: (subject) => authority.readAppliedState(subject),
    updateNativeConfiguration: (input) => authority.apply(input),
  };
}

/**
 * Explicit SDK/embedded-process adapter. Its CAS state is intentionally local
 * to the process that owns the in-memory AgentConfigStore. Lobu's Postgres
 * composition always injects the persistent authority port instead.
 */
export class EmbeddedInMemoryAgentConfigurationMutationAdapter
  implements AgentConfigurationMutationPort
{
  private readonly states = new Map<string, AppliedAgentConfigurationState>();
  private readonly commands = new Map<
    string,
    { digest: Sha256Digest; state: AppliedAgentConfigurationState }
  >();

  constructor(private readonly store: AgentConfigStore) {}

  async readAppliedState(
    subject: ProviderMutationSubject
  ): Promise<AppliedAgentConfigurationState | null> {
    const key = this.subjectKey(subject);
    const current = this.states.get(key);
    if (current) return current;
    const settings = await this.store.getSettings(subject.agentId);
    if (!settings) return null;
    const initial = this.createState(subject, "0", settings, {
      commandId: "embedded-initial-state",
      commandDigest: this.digest({ subject, settings }),
    });
    this.states.set(key, initial);
    return initial;
  }

  async updateNativeConfiguration(
    input: UndigestedNativePatchInput
  ): Promise<ConfigurationMutationResult> {
    const subject = {
      organizationId: input.organizationId,
      agentId: input.agentId,
    };
    const current = await this.readAppliedState(subject);
    const currentRevision = current?.configurationRevision ?? "0";
    const commandKey = `${this.subjectKey(subject)}\0${input.commandId}`;
    const commandDigest = this.digest(input);
    const prior = this.commands.get(commandKey);
    if (prior) {
      return prior.digest === commandDigest
        ? { status: "already_applied", state: prior.state }
        : {
            status: "conflict",
            conflict: "command_conflict",
            currentRevision,
          };
    }
    if (
      input.expectedConfigurationRevision !== null &&
      input.expectedConfigurationRevision !== currentRevision
    ) {
      return {
        status: "conflict",
        conflict: "revision_mismatch",
        currentRevision,
      };
    }

    const updates = Object.fromEntries(
      Object.entries(input.patch).map(([key, value]) => [
        key,
        value === null ? undefined : value,
      ])
    ) as Partial<AgentSettings>;
    await this.store.updateSettings(input.agentId, updates);
    const settings = await this.store.getSettings(input.agentId);
    if (!settings) {
      throw new Error("Embedded agent configuration target was not found");
    }
    const nextRevision = (BigInt(currentRevision) + 1n).toString();
    const state = this.createState(subject, nextRevision, settings, {
      commandId: input.commandId,
      commandDigest,
    });
    this.states.set(this.subjectKey(subject), state);
    this.commands.set(commandKey, { digest: commandDigest, state });
    return { status: "applied", state };
  }

  private subjectKey(subject: ProviderMutationSubject): string {
    return `${subject.organizationId}\0${subject.agentId}`;
  }

  private digest(value: unknown): Sha256Digest {
    return `sha256:${createHash("sha256")
      .update(JSON.stringify(value))
      .digest("hex")}`;
  }

  private createState(
    subject: ProviderMutationSubject,
    configurationRevision: string,
    settings: AgentSettings,
    command: { commandId: string; commandDigest: Sha256Digest }
  ): AppliedAgentConfigurationState {
    return {
      ...subject,
      managementMode: "native",
      configurationRevision,
      settingsDigest: this.digest(settings),
      lastMutation: { kind: "native_patch", ...command },
    };
  }
}
