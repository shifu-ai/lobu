import { describe, expect, test } from "bun:test";
import { moduleRegistry, type AgentSettings } from "@lobu/core";
import type {
  AgentConfigurationMutationResult,
  AppliedAgentConfigurationState,
  NativePatchCommandInput,
} from "../../../lobu/agent-configuration/index.js";
import {
  AgentConfigurationMutationConflictError,
  AgentConfigurationMutationInvalidRevisionError,
  AgentConfigurationMutationRejectedError,
  EmbeddedInMemoryAgentConfigurationMutationAdapter,
  createAgentConfigurationMutationPort,
} from "../agent-configuration-mutation-port.js";
import { ProviderCatalogService } from "../provider-catalog.js";

interface AgentConfigurationMutationPort {
  readAppliedState(input: typeof subject): Promise<AppliedAgentConfigurationState | null>;
  updateNativeConfiguration(
    input: NativePatchCommandInput
  ): Promise<AgentConfigurationMutationResult>;
}

const subject = { organizationId: "org-provider-test", agentId: "agent-1" };
const installedAt = 1_700_000_000_000;

moduleRegistry.register({
  name: "provider-catalog-authority-test",
  providerId: "authority-test",
  providerDisplayName: "Authority Test",
  isEnabled: () => true,
  init: async () => undefined,
  registerEndpoints: () => undefined,
  buildEnvVars: async (_agentId: string, env: Record<string, string>) => env,
  getSecretEnvVarNames: () => [],
  getCredentialEnvVarName: () => "AUTHORITY_TEST_KEY",
  hasCredentials: async () => false,
  hasSystemKey: () => false,
  getProxyBaseUrlMappings: () => ({}),
  injectSystemKeyFallback: (env: Record<string, string>) => env,
});

function appliedState(revision: string) {
  return {
    organizationId: subject.organizationId,
    agentId: subject.agentId,
    managementMode: "native" as const,
    configurationRevision: revision,
    settingsDigest: `sha256:${"a".repeat(64)}` as const,
    lastMutation: {
      kind: "native_patch" as const,
      commandId: "previous-command",
      commandDigest: `sha256:${"b".repeat(64)}` as const,
    },
  };
}

function createCatalog(options: {
  settings: Partial<AgentSettings>;
  result?: Awaited<ReturnType<AgentConfigurationMutationPort["updateNativeConfiguration"]>>;
}) {
  const reads: typeof subject[] = [];
  const writes: Parameters<AgentConfigurationMutationPort["updateNativeConfiguration"]>[0][] = [];
  let rawWrites = 0;
  let authDeletes = 0;
  const mutationPort: AgentConfigurationMutationPort = {
    async readAppliedState(input) {
      reads.push(input);
      return appliedState("7");
    },
    async updateNativeConfiguration(input) {
      writes.push(input);
      return options.result ?? { status: "applied", state: appliedState("8") };
    },
  };
  const settingsStore = {
    async getSettings(agentId: string) {
      expect(agentId).toBe(subject.agentId);
      return { ...options.settings, updatedAt: 1 } as AgentSettings;
    },
    async saveSettings() {
      rawWrites += 1;
    },
    async updateSettings() {
      rawWrites += 1;
    },
  };
  const catalog = new ProviderCatalogService(
    settingsStore as never,
    {
      async deleteProviderProfiles(agentId: string, providerId: string) {
        expect([agentId, providerId]).toEqual([subject.agentId, "authority-test"]);
        authDeletes += 1;
      },
    } as never,
    { has: () => false } as never,
    mutationPort,
    () => "00000000-0000-4000-8000-000000000001",
    () => installedAt
  );
  return {
    catalog,
    reads,
    writes,
    getRawWrites: () => rawWrites,
    getAuthDeletes: () => authDeletes,
  };
}

describe("ProviderCatalogService configuration authority mutations", () => {
  test("install sends one revisioned native patch for the explicit subject", async () => {
    const fixture = createCatalog({
      settings: {
        model: "other/model-old",
        modelSelection: { mode: "pinned", pinnedModel: "other/model-old" },
        providerModelPreferences: {
          other: "other/model-old",
          removed: "removed/model",
        },
        installedProviders: [{ providerId: "other", installedAt: 10 }],
      },
    });

    await fixture.catalog.installProvider(subject, "authority-test", { region: "tw" });

    expect(fixture.reads).toEqual([subject]);
    expect(fixture.writes).toEqual([
      {
        organizationId: subject.organizationId,
        agentId: subject.agentId,
        commandId: "00000000-0000-4000-8000-000000000001",
        expectedConfigurationRevision: "7",
        actor: { kind: "provider_catalog" },
        patch: {
          installedProviders: [
            { providerId: "other", installedAt: 10 },
            { providerId: "authority-test", installedAt, config: { region: "tw" } },
          ],
          model: "other/model-old",
          modelSelection: { mode: "pinned", pinnedModel: "other/model-old" },
          providerModelPreferences: { other: "other/model-old" },
        },
      },
    ]);
    expect(fixture.getRawWrites()).toBe(0);
  });

  test("uninstall and reorder each send exactly one reconciled CAS patch", async () => {
    const settings = {
      model: "authority-test/model",
      modelSelection: { mode: "pinned" as const, pinnedModel: "authority-test/model" },
      providerModelPreferences: {
        "authority-test": "authority-test/model",
        other: "other/model",
      },
      installedProviders: [
        { providerId: "authority-test", installedAt: 10 },
        { providerId: "other", installedAt: 20 },
      ],
    };
    const uninstall = createCatalog({ settings });
    await uninstall.catalog.uninstallProvider(subject, "authority-test");
    expect(uninstall.writes).toHaveLength(1);
    expect(uninstall.writes[0]).toMatchObject({
      organizationId: subject.organizationId,
      agentId: subject.agentId,
      expectedConfigurationRevision: "7",
      patch: {
        installedProviders: [{ providerId: "other", installedAt: 20 }],
        model: null,
        modelSelection: { mode: "auto" },
        providerModelPreferences: { other: "other/model" },
      },
    });
    expect(uninstall.getAuthDeletes()).toBe(1);

    const reorder = createCatalog({ settings });
    await reorder.catalog.reorderProviders(subject, ["other", "authority-test"]);
    expect(reorder.writes).toHaveLength(1);
    expect(reorder.writes[0]?.patch).toEqual({
      installedProviders: [
        { providerId: "other", installedAt: 20 },
        { providerId: "authority-test", installedAt: 10 },
      ],
      model: "authority-test/model",
      modelSelection: { mode: "pinned", pinnedModel: "authority-test/model" },
      providerModelPreferences: {
        "authority-test": "authority-test/model",
        other: "other/model",
      },
    });
  });

  test("managed-field rejection becomes a stable typed error without retry or raw write", async () => {
    const fixture = createCatalog({
      settings: { installedProviders: [] },
      result: { status: "rejected", reason: "field_owned_by_managed_release" },
    });

    const error = await fixture.catalog
      .installProvider(subject, "authority-test")
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(AgentConfigurationMutationRejectedError);
    expect(error.reason).toBe("field_owned_by_managed_release");
    expect(fixture.reads).toHaveLength(1);
    expect(fixture.writes).toHaveLength(1);
    expect(fixture.getRawWrites()).toBe(0);
  });

  test("revision conflict surfaces without re-read, retry, or last-write-wins", async () => {
    const fixture = createCatalog({
      settings: { installedProviders: [] },
      result: {
        status: "conflict",
        conflict: "revision_mismatch",
        currentRevision: "8",
      },
    });

    const error = await fixture.catalog
      .installProvider(subject, "authority-test")
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(AgentConfigurationMutationConflictError);
    expect(error.currentRevision).toBe("8");
    expect(fixture.reads).toHaveLength(1);
    expect(fixture.writes).toHaveLength(1);
    expect(fixture.getRawWrites()).toBe(0);
  });

  test("reads authority state before settings so an intervening mutation conflicts", async () => {
    const events: string[] = [];
    let currentRevision = "7";
    const writes: NativePatchCommandInput[] = [];
    const catalog = new ProviderCatalogService(
      {
        async getSettings() {
          events.push("settings");
          currentRevision = "8";
          return { installedProviders: [], updatedAt: 1 };
        },
      } as never,
      {} as never,
      { has: () => false } as never,
      {
        async readAppliedState() {
          events.push("state");
          return appliedState(currentRevision);
        },
        async updateNativeConfiguration(input) {
          events.push("update");
          writes.push(input);
          return input.expectedConfigurationRevision === currentRevision
            ? { status: "applied", state: appliedState("9") }
            : {
                status: "conflict",
                conflict: "revision_mismatch",
                currentRevision,
              };
        },
      },
      () => "00000000-0000-4000-8000-000000000002",
      () => installedAt
    );

    await expect(
      catalog.installProvider(subject, "authority-test")
    ).rejects.toBeInstanceOf(AgentConfigurationMutationConflictError);
    expect(events).toEqual(["state", "settings", "update"]);
    expect(writes[0]?.expectedConfigurationRevision).toBe("7");
  });
});

test("embedded adapter serializes concurrent CAS and cleans up its subject lock", async () => {
  let settings = {
    installedProviders: [],
    updatedAt: 1,
  } as AgentSettings;
  let updateCalls = 0;
  let reportFirstWriteStarted!: () => void;
  let releaseFirstWrite!: () => void;
  const firstWriteStarted = new Promise<void>((resolve) => {
    reportFirstWriteStarted = resolve;
  });
  const firstWriteReleased = new Promise<void>((resolve) => {
    releaseFirstWrite = resolve;
  });
  const adapter = new EmbeddedInMemoryAgentConfigurationMutationAdapter({
    async getSettings() {
      return settings;
    },
    async updateSettings(_agentId: string, patch: Partial<AgentSettings>) {
      updateCalls += 1;
      if (updateCalls === 1) {
        reportFirstWriteStarted();
        await firstWriteReleased;
      }
      settings = { ...settings, ...patch, updatedAt: settings.updatedAt + 1 };
    },
  } as never);

  expect((await adapter.readAppliedState(subject))?.configurationRevision).toBe("0");
  const first = adapter.updateNativeConfiguration({
    ...subject,
    commandId: "embedded-provider-command-1",
    expectedConfigurationRevision: "0",
    actor: { kind: "provider_catalog" },
    patch: {
      installedProviders: [{ providerId: "authority-test", installedAt: 1 }],
    },
  });
  await firstWriteStarted;
  const second = adapter.updateNativeConfiguration({
    ...subject,
    commandId: "embedded-provider-command-2",
    expectedConfigurationRevision: "0",
    actor: { kind: "provider_catalog" },
    patch: {
      installedProviders: [{ providerId: "other", installedAt: 2 }],
    },
  });
  await Promise.resolve();
  releaseFirstWrite();
  const results = await Promise.all([first, second]);

  expect(results.map((result) => result.status).sort()).toEqual([
    "applied",
    "conflict",
  ]);
  expect(results.filter((result) => result.status === "conflict")).toEqual([
    {
      status: "conflict",
      conflict: "revision_mismatch",
      currentRevision: "1",
    },
  ]);
  expect((await adapter.readAppliedState(subject))?.configurationRevision).toBe("1");
  expect(settings.installedProviders).toEqual([
    { providerId: "authority-test", installedAt: 1 },
  ]);
  expect((adapter as any).subjectMutationQueues.size).toBe(0);
});

test("embedded adapter does not let a delayed initial read overwrite committed state", async () => {
  let settings = {
    installedProviders: [],
    updatedAt: 1,
  } as AgentSettings;
  let getCalls = 0;
  let releaseDelayedRead!: () => void;
  const delayedRead = new Promise<void>((resolve) => {
    releaseDelayedRead = resolve;
  });
  const adapter = new EmbeddedInMemoryAgentConfigurationMutationAdapter({
    async getSettings() {
      getCalls += 1;
      if (getCalls === 1) {
        await delayedRead;
      }
      return settings;
    },
    async updateSettings(_agentId: string, patch: Partial<AgentSettings>) {
      settings = { ...settings, ...patch, updatedAt: settings.updatedAt + 1 };
    },
  } as never);

  const staleRead = adapter.readAppliedState(subject);
  await Promise.resolve();
  const mutation = adapter.updateNativeConfiguration({
    ...subject,
    commandId: "embedded-provider-command-after-delayed-read",
    expectedConfigurationRevision: "0",
    actor: { kind: "provider_catalog" },
    patch: {
      installedProviders: [{ providerId: "authority-test", installedAt: 1 }],
    },
  });
  expect((await mutation).status).toBe("applied");
  releaseDelayedRead();

  expect((await staleRead)?.configurationRevision).toBe("1");
  expect((await adapter.readAppliedState(subject))?.configurationRevision).toBe("1");
});

test("authority port rejects null revisions before delegating", async () => {
  let applyCalls = 0;
  const port = createAgentConfigurationMutationPort({
    async readAppliedState() {
      return appliedState("0");
    },
    async apply() {
      applyCalls += 1;
      return { status: "applied", state: appliedState("1") };
    },
  });

  await expect(
    port.updateNativeConfiguration({
      ...subject,
      commandId: "invalid-null-revision",
      expectedConfigurationRevision: null,
      actor: { kind: "provider_catalog" },
      patch: { installedProviders: [] },
    } as never)
  ).rejects.toBeInstanceOf(AgentConfigurationMutationInvalidRevisionError);
  expect(applyCalls).toBe(0);
});
