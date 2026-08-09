import type { AgentConfigStore, AgentSettings } from "@lobu/core";
import { canonicalize } from "json-canonicalize";
import {
  digestAgentConfigurationSettings,
  materializeNativePatchCommand,
  projectAgentConfigurationSettings,
  projectAgentConfigurationSettingsAfterPatch,
} from "../../lobu/agent-configuration/native-patch.js";
import { normalizeNativeSettingsPatchForPersistence } from "../../lobu/agent-configuration/field-ownership.js";
import type {
  AgentConfigurationMutationResult as ConfigurationMutationResult,
  AgentConfigurationRejectionReason,
  AppliedAgentConfigurationState,
  BootstrapAgentConfigurationState,
  NativePatchCommandInput,
  Sha256Digest,
} from "../../lobu/agent-configuration/types.js";

export type UndigestedNativePatchInput = Omit<
  NativePatchCommandInput,
  "expectedConfigurationRevision"
> & {
  expectedConfigurationRevision: string;
};

export type {
  BootstrapAgentConfigurationState as AgentConfigurationReadState,
  ConfigurationMutationResult,
};

export type ProviderMutationSubject = {
  organizationId: string;
  agentId: string;
};

export interface AgentConfigurationMutationPort {
  readAppliedState(
    subject: ProviderMutationSubject
  ): Promise<BootstrapAgentConfigurationState | null>;
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

export class AgentConfigurationMutationTargetNotFoundError extends Error {
  constructor() {
    super("Agent configuration mutation target was not found");
    this.name = "AgentConfigurationMutationTargetNotFoundError";
  }
}

export class AgentConfigurationMutationInvalidRevisionError extends Error {
  constructor() {
    super("Agent configuration mutation revision must be a decimal string");
    this.name = "AgentConfigurationMutationInvalidRevisionError";
  }
}

export class AgentConfigurationMutationTenantMismatchError extends Error {
  constructor() {
    super("Embedded agent configuration tenant does not match its bound tenant");
    this.name = "AgentConfigurationMutationTenantMismatchError";
  }
}

function assertDecimalRevision(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new AgentConfigurationMutationInvalidRevisionError();
  }
}

type AuthorityAdapterTarget = {
  readAppliedState(
    subject: ProviderMutationSubject
  ): Promise<BootstrapAgentConfigurationState | null>;
  apply(
    input: UndigestedNativePatchInput
  ): Promise<ConfigurationMutationResult>;
};

export function createAgentConfigurationMutationPort(
  authority: AuthorityAdapterTarget
): AgentConfigurationMutationPort {
  return {
    readAppliedState: (subject) => authority.readAppliedState(subject),
    async updateNativeConfiguration(input) {
      assertDecimalRevision(input.expectedConfigurationRevision);
      return authority.apply(input);
    },
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
  private readonly states = new Map<string, BootstrapAgentConfigurationState>();
  /**
   * Embedded compatibility keeps only the 256 newest receipts per agent
   * subject. Recent command conflicts/replays remain exact; older receipts are
   * explicitly outside the non-durable embedded replay window. Production
   * authority persists an unbounded durable ledger in Postgres instead.
   */
  private static readonly MAX_RECEIPTS_PER_SUBJECT = 256;
  private readonly commands = new Map<
    string,
    Map<string, { digest: Sha256Digest; state: AppliedAgentConfigurationState }>
  >();
  private readonly subjectMutationQueues = new Map<string, Promise<void>>();
  private readonly organizationsByAgent = new Map<string, string>();

  constructor(private readonly store: AgentConfigStore) {}

  async deleteAgent(
    agentId: string,
    deleteAggregate: () => Promise<void>
  ): Promise<void> {
    const organizationId = this.organizationsByAgent.get(agentId);
    if (organizationId) {
      const subjectKey = this.subjectKey({ organizationId, agentId });
      await this.withSubjectMutationLock(subjectKey, async () => {
        await deleteAggregate();
        this.clearAgentState(agentId);
      });
      return;
    }
    await deleteAggregate();
    this.clearAgentState(agentId);
  }

  private clearAgentState(agentId: string): void {
    this.organizationsByAgent.delete(agentId);
    for (const key of this.states.keys()) {
      if (key.split("\0")[1] === agentId) this.states.delete(key);
    }
    for (const key of this.commands.keys()) {
      if (key.split("\0")[1] === agentId) this.commands.delete(key);
    }
  }

  async readAppliedState(
    subject: ProviderMutationSubject
  ): Promise<BootstrapAgentConfigurationState | null> {
    this.assertMatchingOrganization(subject);
    const key = this.subjectKey(subject);
    const current = this.states.get(key);
    if (current) return current;
    const settings = await this.store.getSettings(subject.agentId);
    if (!settings) return null;
    this.bindOrganization(subject);
    const stateCreatedWhileReading = this.states.get(key);
    if (stateCreatedWhileReading) return stateCreatedWhileReading;
    const initial: BootstrapAgentConfigurationState = {
      ...subject,
      managementMode: "native",
      configurationRevision: "0",
      settingsDigest: digestAgentConfigurationSettings(settings),
      lastMutation: null,
    };
    this.states.set(key, initial);
    return initial;
  }

  async updateNativeConfiguration(
    input: UndigestedNativePatchInput
  ): Promise<ConfigurationMutationResult> {
    assertDecimalRevision(input.expectedConfigurationRevision);
    const key = this.subjectKey(input);
    return this.withSubjectMutationLock(key, () =>
      this.updateNativeConfigurationLocked(input)
    );
  }

  private async updateNativeConfigurationLocked(
    input: UndigestedNativePatchInput
  ): Promise<ConfigurationMutationResult> {
    const subject = {
      organizationId: input.organizationId,
      agentId: input.agentId,
    };
    const current = await this.readAppliedState(subject);
    if (!current) {
      throw new AgentConfigurationMutationTargetNotFoundError();
    }
    const currentRevision = current.configurationRevision;
    const subjectKey = this.subjectKey(subject);
    const command = materializeNativePatchCommand(input);
    const commandDigest = command.commandDigest;
    const prior = this.commands.get(subjectKey)?.get(input.commandId);
    if (prior) {
      return prior.digest === commandDigest
        ? { status: "already_applied", state: prior.state }
        : {
            status: "conflict",
            conflict: "command_conflict",
            currentRevision,
          };
    }
    if (input.expectedConfigurationRevision !== currentRevision) {
      return {
        status: "conflict",
        conflict: "revision_mismatch",
        currentRevision,
      };
    }

    const settings = await this.store.getSettings(input.agentId);
    if (!settings) throw new AgentConfigurationMutationTargetNotFoundError();
    const currentProjection = projectAgentConfigurationSettings(settings);
    const resultingProjection = projectAgentConfigurationSettingsAfterPatch(
      settings,
      command.patch
    );
    const changed = canonicalize(currentProjection) !== canonicalize(resultingProjection);
    if (changed) {
      await this.store.updateSettings(
        input.agentId,
        normalizeNativeSettingsPatchForPersistence(command.patch) as Partial<AgentSettings>
      );
    }
    const nextRevision = changed
      ? (BigInt(currentRevision) + 1n).toString()
      : currentRevision;
    const state = this.createState(subject, nextRevision, resultingProjection, {
      commandId: input.commandId,
      commandDigest,
    });
    this.states.set(subjectKey, state);
    this.recordCommandReceipt(subjectKey, input.commandId, {
      digest: commandDigest,
      state,
    });
    return { status: changed ? "applied" : "no_change", state };
  }

  private async withSubjectMutationLock<T>(
    key: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const previous = this.subjectMutationQueues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.subjectMutationQueues.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.subjectMutationQueues.get(key) === tail) {
        this.subjectMutationQueues.delete(key);
      }
    }
  }

  private subjectKey(subject: ProviderMutationSubject): string {
    return `${subject.organizationId}\0${subject.agentId}`;
  }

  private recordCommandReceipt(
    subjectKey: string,
    commandId: string,
    receipt: { digest: Sha256Digest; state: AppliedAgentConfigurationState }
  ): void {
    let receipts = this.commands.get(subjectKey);
    if (!receipts) {
      receipts = new Map();
      this.commands.set(subjectKey, receipts);
    }
    if (
      receipts.size >=
        EmbeddedInMemoryAgentConfigurationMutationAdapter.MAX_RECEIPTS_PER_SUBJECT &&
      !receipts.has(commandId)
    ) {
      const oldestCommandId = receipts.keys().next().value;
      if (oldestCommandId !== undefined) receipts.delete(oldestCommandId);
    }
    receipts.set(commandId, receipt);
  }

  private assertMatchingOrganization(subject: ProviderMutationSubject): void {
    const organizationId = this.organizationsByAgent.get(subject.agentId);
    if (organizationId && organizationId !== subject.organizationId) {
      throw new AgentConfigurationMutationTenantMismatchError();
    }
  }

  private bindOrganization(subject: ProviderMutationSubject): void {
    this.assertMatchingOrganization(subject);
    this.organizationsByAgent.set(subject.agentId, subject.organizationId);
  }

  private createState(
    subject: ProviderMutationSubject,
    configurationRevision: string,
    settings: Partial<AgentSettings>,
    command: { commandId: string; commandDigest: Sha256Digest }
  ): AppliedAgentConfigurationState {
    return {
      ...subject,
      managementMode: "native",
      configurationRevision,
      settingsDigest: digestAgentConfigurationSettings(settings),
      lastMutation: { kind: "native_patch", ...command },
    };
  }
}
