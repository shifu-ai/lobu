import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { SecretPutOptions, SecretRef } from "@lobu/core";
import type { GatewayConfig } from "../config/index.js";
import { EmbeddedInMemoryAgentConfigurationMutationAdapter } from "../auth/agent-configuration-mutation-port.js";
import { CoreServices } from "../services/core-services.js";
import { InMemoryAgentStore } from "../stores/in-memory-agent-store.js";
import {
  type SecretListEntry,
  SecretStoreRegistry,
  type WritableSecretStore,
} from "../secrets/index.js";
import { InMemoryStateAdapter } from "./fixtures/in-memory-state-adapter.js";
import {
  ensureEncryptionKey,
  ensureDbForGatewayTests,
  resetTestDatabase,
} from "./helpers/db-setup.js";
import { MockMessageQueue } from "./setup.js";

function createGatewayConfig(
  overrides?: Partial<GatewayConfig>
): GatewayConfig {
  return {
    agentDefaults: {},
    sessionTimeoutMinutes: 5,
    logLevel: "INFO",
    queues: {
      connectionString: "postgres://test",
      directMessage: "direct_message",
      messageQueue: "message_queue",
      retryLimit: 3,
      retryDelay: 1,
      expireInHours: 24,
    },
    anthropicProxy: {
      enabled: true,
    },
    orchestration: {
      queues: {
        connectionString: "postgres://test",
        retryLimit: 3,
        retryDelay: 1,
        expireInSeconds: 3600,
      },
      worker: {
        startupTimeoutSeconds: 90,
        idleCleanupMinutes: 60,
        maxDeployments: 100,
      },
      cleanup: {
        initialDelayMs: 1000,
        intervalMs: 60000,
        veryOldDays: 7,
      },
    },
    mcp: {
      publicGatewayUrl: "http://localhost:8080",
    },
    auth: {},
    lobuMemory: {},
    secrets: {
      aws: {},
    },
    ...overrides,
  };
}

class InMemoryWritableStore implements WritableSecretStore {
  private readonly entries = new Map<
    string,
    { value: string; updatedAt: number }
  >();

  constructor(private readonly scheme: string = "host") {}

  async get(ref: SecretRef): Promise<string | null> {
    if (!ref.startsWith(`${this.scheme}://`)) {
      return null;
    }

    const name = decodeURIComponent(ref.slice(`${this.scheme}://`.length));
    return this.entries.get(name)?.value ?? null;
  }

  async put(
    name: string,
    value: string,
    _options?: SecretPutOptions
  ): Promise<SecretRef> {
    this.entries.set(name, { value, updatedAt: Date.now() });
    return `${this.scheme}://${encodeURIComponent(name)}` as SecretRef;
  }

  async delete(nameOrRef: string): Promise<void> {
    const name = nameOrRef.startsWith(`${this.scheme}://`)
      ? decodeURIComponent(nameOrRef.slice(`${this.scheme}://`.length))
      : nameOrRef;
    this.entries.delete(name);
  }

  async list(prefix?: string): Promise<SecretListEntry[]> {
    const entries: SecretListEntry[] = [];
    for (const [name, entry] of this.entries) {
      if (prefix && !name.startsWith(prefix)) {
        continue;
      }

      entries.push({
        ref: `${this.scheme}://${encodeURIComponent(name)}` as SecretRef,
        backend: this.scheme,
        name,
        updatedAt: entry.updatedAt,
      });
    }
    return entries;
  }
}

beforeAll(async () => {
  await ensureDbForGatewayTests();
});

afterEach(() => {
  delete process.env.LOBU_WORKSPACE_ROOT;
});

describe("CoreServices store selection", () => {
  test("fails fast when no host-provided stores or file-first config is present", async () => {
    ensureEncryptionKey();
    await resetTestDatabase();
    const coreServices = new CoreServices(createGatewayConfig(), {
      stateAdapter: new InMemoryStateAdapter(),
    });
    (coreServices as any).queue = new MockMessageQueue();

    // There is no default sub-store; if the host doesn't provide
    // config/connection/access stores AND no lobu.config.ts is present,
    // initializeSessionServices throws.
    await expect(
      (coreServices as any).initializeSessionServices()
    ).rejects.toThrow(/No agent sub-stores configured/);
  });

  test("fails closed when host-provided stores omit a configuration mutation authority", async () => {
    ensureEncryptionKey();
    await resetTestDatabase();
    const coreServices = new CoreServices(createGatewayConfig(), {
      stateAdapter: new InMemoryStateAdapter(),
      configStore: {
        getSettings: async () => null,
        saveSettings: async () => {},
        updateSettings: async () => {},
        deleteSettings: async () => {},
        hasSettings: async () => false,
        getMetadata: async () => null,
        saveMetadata: async () => {},
        updateMetadata: async () => {},
        deleteMetadata: async () => {},
        hasAgent: async () => false,
        listAgents: async () => [],
      } as any,
      connectionStore: {} as any,
      accessStore: {} as any,
    });
    (coreServices as any).queue = new MockMessageQueue();

    await expect(
      (coreServices as any).initializeSessionServices()
    ).rejects.toThrow(/configuration mutation port.*host-provided/i);
  });

  test("production Lobu composition injects one authority into Gateway and provisioning", async () => {
    const source = await Bun.file(
      new URL("../../lobu/gateway.ts", import.meta.url)
    ).text();

    expect(source).toMatch(
      /agentConfigurationMutationPort:\s*createAgentConfigurationMutationPort\(\s*agentConfigurationAuthority\s*\)/
    );
    expect(source).toMatch(
      /createProvisioningRoutes\([\s\S]*?agentConfigurationAuthority,/
    );
    expect(source).toMatch(
      /agentConfigurationAuthority\s*=\s*createRuntimeAgentConfigurationAuthority\(\)/
    );
    expect(source).not.toContain("createAgentReleaseService({})");
  });

  test("selects the embedded adapter only for the built-in in-memory store", async () => {
    ensureEncryptionKey();
    await resetTestDatabase();
    const store = new InMemoryAgentStore();
    const coreServices = new CoreServices(createGatewayConfig(), {
      stateAdapter: new InMemoryStateAdapter(),
      configStore: store,
      connectionStore: store,
      accessStore: store,
    });
    (coreServices as any).queue = new MockMessageQueue();

    await (coreServices as any).initializeSessionServices();

    expect(
      (coreServices as any).agentConfigurationMutationPort
    ).toBeInstanceOf(EmbeddedInMemoryAgentConfigurationMutationAdapter);
  });

  test("rejects an InMemoryAgentStore subclass without an injected authority", async () => {
    ensureEncryptionKey();
    await resetTestDatabase();
    class HostInMemoryStore extends InMemoryAgentStore {}
    const store = new HostInMemoryStore();
    const coreServices = new CoreServices(createGatewayConfig(), {
      stateAdapter: new InMemoryStateAdapter(),
      configStore: store,
      connectionStore: store,
      accessStore: store,
    });
    (coreServices as any).queue = new MockMessageQueue();

    await expect(
      (coreServices as any).initializeSessionServices()
    ).rejects.toThrow(/configuration mutation port.*host-provided/i);
  });

  test("embedded agent deletion clears the aggregate before recreation", async () => {
    ensureEncryptionKey();
    await resetTestDatabase();
    const store = new InMemoryAgentStore();
    const coreServices = new CoreServices(createGatewayConfig(), {
      stateAdapter: new InMemoryStateAdapter(),
      configStore: store,
      connectionStore: store,
      accessStore: store,
    });
    (coreServices as any).queue = new MockMessageQueue();
    await (coreServices as any).initializeSessionServices();
    const metadata = coreServices.getAgentMetadataStore();
    const settings = coreServices.getAgentSettingsStore();
    const mutations = coreServices.getAgentConfigurationMutationPort();
    const embeddedSubject = {
      organizationId: "embedded-org",
      agentId: "embedded-lifecycle-agent",
    };
    const unrelatedAgentId = "embedded-unrelated-agent";

    await metadata.createAgent(
      embeddedSubject.agentId,
      "Embedded Lifecycle",
      "external",
      "owner-1"
    );
    await metadata.createAgent(
      unrelatedAgentId,
      "Unrelated Embedded Agent",
      "external",
      "other-owner"
    );
    await store.saveSettings(unrelatedAgentId, {
      identityMd: "keep me",
      updatedAt: 1,
    });
    await store.updateSettings(embeddedSubject.agentId, {
      authProfiles: [
        {
          id: "durable-credential",
          provider: "authority-test",
          credential: "durable-secret",
          authType: "api-key",
          label: "durable",
          model: "*",
          createdAt: 1,
        },
      ],
    });
    await store.saveConnection({
      id: "embedded-lifecycle-connection",
      platform: "slack",
      agentId: embeddedSubject.agentId,
      organizationId: embeddedSubject.organizationId,
      config: { token: "aggregate-secret" },
      settings: {},
      metadata: {},
      status: "active",
      createdAt: 1,
      updatedAt: 1,
    });
    await store.saveConnection({
      id: "embedded-unrelated-connection",
      platform: "slack",
      agentId: unrelatedAgentId,
      organizationId: "unrelated-org",
      config: {},
      settings: {},
      metadata: {},
      status: "active",
      createdAt: 1,
      updatedAt: 1,
    });
    await store.saveConnection({
      id: "embedded-reassigned-connection",
      platform: "slack",
      agentId: embeddedSubject.agentId,
      config: {},
      settings: {},
      metadata: {},
      status: "active",
      createdAt: 1,
      updatedAt: 1,
    });
    await store.saveConnection({
      id: "embedded-reassigned-connection",
      platform: "slack",
      agentId: unrelatedAgentId,
      config: {},
      settings: {},
      metadata: {},
      status: "active",
      createdAt: 1,
      updatedAt: 2,
    });
    await store.createChannelBinding({
      agentId: embeddedSubject.agentId,
      platform: "slack",
      channelId: "embedded-channel",
      createdAt: 1,
    });
    await store.createChannelBinding({
      agentId: unrelatedAgentId,
      platform: "slack",
      channelId: "unrelated-channel",
      createdAt: 1,
    });
    await store.createChannelBinding({
      agentId: embeddedSubject.agentId,
      platform: "discord",
      channelId: "reassigned-channel",
      createdAt: 1,
    });
    await store.createChannelBinding({
      agentId: unrelatedAgentId,
      platform: "discord",
      channelId: "reassigned-channel",
      createdAt: 2,
    });
    await store.grant(embeddedSubject.agentId, "/mcp/test/tools/*", null);
    await store.grant(unrelatedAgentId, "/mcp/test/tools/*", null);
    await store.addUserAgent("external", "owner-1", embeddedSubject.agentId);
    await store.addUserAgent("external", "other-owner", unrelatedAgentId);
    expect(await settings.getSettings(embeddedSubject.agentId)).toMatchObject({
      updatedAt: expect.any(Number),
    });
    expect(
      (await mutations.readAppliedState(embeddedSubject))?.configurationRevision
    ).toBe("0");
    settings.getEphemeralAuthProfiles().set(embeddedSubject.agentId, [
      {
        id: "ephemeral-credential",
        provider: "authority-test",
        credential: "embedded-secret",
        authType: "api-key",
        label: "ephemeral",
        model: "*",
        createdAt: 1,
      },
    ]);
    let reportMutationWrite!: () => void;
    let releaseMutationWrite!: () => void;
    const mutationWriteStarted = new Promise<void>((resolve) => {
      reportMutationWrite = resolve;
    });
    const mutationWriteReleased = new Promise<void>((resolve) => {
      releaseMutationWrite = resolve;
    });
    const updateSettings = store.updateSettings.bind(store);
    store.updateSettings = async (agentId, patch) => {
      reportMutationWrite();
      await mutationWriteReleased;
      await updateSettings(agentId, patch);
    };
    const mutation = mutations.updateNativeConfiguration({
      ...embeddedSubject,
      commandId: "embedded-lifecycle-command",
      expectedConfigurationRevision: "0",
      actor: { kind: "provider_catalog" },
      patch: { identityMd: "before delete" },
    });
    await mutationWriteStarted;
    const deletion = metadata.deleteAgent(embeddedSubject.agentId);
    await Promise.resolve();
    expect(await settings.getSettings(embeddedSubject.agentId)).not.toBeNull();
    releaseMutationWrite();
    expect((await mutation).status).toBe("applied");
    await deletion;
    expect(await settings.getSettings(embeddedSubject.agentId)).toBeNull();
    expect(
      settings.getEphemeralAuthProfiles().get(embeddedSubject.agentId)
    ).toBeUndefined();
    expect(await mutations.readAppliedState(embeddedSubject)).toBeNull();
    expect(
      await store.getConnection("embedded-lifecycle-connection")
    ).toBeNull();
    expect(
      await store.listConnections({ agentId: embeddedSubject.agentId })
    ).toEqual([]);
    expect(await store.listChannelBindings(embeddedSubject.agentId)).toEqual([]);
    expect(
      await store.getChannelBinding("slack", "embedded-channel")
    ).toBeNull();
    expect(await store.listGrants(embeddedSubject.agentId)).toEqual([]);
    expect(
      await store.hasGrant(embeddedSubject.agentId, "/mcp/test/tools/send")
    ).toBeFalse();
    expect(await store.listUserAgents("external", "owner-1")).toEqual([]);
    expect(
      await store.ownsAgent("external", "owner-1", embeddedSubject.agentId)
    ).toBeFalse();

    expect((await store.getSettings(unrelatedAgentId))?.identityMd).toBe(
      "keep me"
    );
    expect(
      await store.getConnection("embedded-unrelated-connection")
    ).not.toBeNull();
    expect(
      await store.getConnection("embedded-reassigned-connection")
    ).not.toBeNull();
    expect(await store.listChannelBindings(unrelatedAgentId)).toHaveLength(2);
    expect(
      await store.getChannelBinding("discord", "reassigned-channel")
    ).toMatchObject({ agentId: unrelatedAgentId });
    expect(await store.listGrants(unrelatedAgentId)).toHaveLength(1);
    expect(
      await store.ownsAgent("external", "other-owner", unrelatedAgentId)
    ).toBeTrue();

    await metadata.createAgent(
      embeddedSubject.agentId,
      "Embedded Lifecycle Recreated",
      "external",
      "owner-2"
    );
    expect(
      (await mutations.readAppliedState(embeddedSubject))?.configurationRevision
    ).toBe("0");
    expect(
      (await settings.getSettings(embeddedSubject.agentId))?.identityMd
    ).toBeUndefined();
    expect(
      (await settings.getSettings(embeddedSubject.agentId))?.authProfiles
    ).toBeUndefined();
    expect(
      await store.listConnections({ agentId: embeddedSubject.agentId })
    ).toEqual([]);
    expect(await store.listChannelBindings(embeddedSubject.agentId)).toEqual([]);
    expect(await store.listGrants(embeddedSubject.agentId)).toEqual([]);
    expect(await store.listUserAgents("external", "owner-1")).toEqual([]);
    expect(
      (
        await mutations.updateNativeConfiguration({
          ...embeddedSubject,
          commandId: "embedded-lifecycle-command",
          expectedConfigurationRevision: "0",
          actor: { kind: "provider_catalog" },
          patch: { identityMd: "after recreate" },
        })
      ).status
    ).toBe("applied");
  });

  test("embedded first read and deletion serialize for the full agent lifecycle", async () => {
    ensureEncryptionKey();
    await resetTestDatabase();
    const store = new InMemoryAgentStore();
    const coreServices = new CoreServices(createGatewayConfig(), {
      stateAdapter: new InMemoryStateAdapter(),
      configStore: store,
      connectionStore: store,
      accessStore: store,
    });
    (coreServices as any).queue = new MockMessageQueue();
    await (coreServices as any).initializeSessionServices();
    const metadata = coreServices.getAgentMetadataStore();
    const mutations = coreServices.getAgentConfigurationMutationPort();
    const oldSubject = {
      organizationId: "embedded-old-org",
      agentId: "embedded-first-read-delete-agent",
    };
    const recreatedSubject = {
      organizationId: "embedded-new-org",
      agentId: oldSubject.agentId,
    };

    await metadata.createAgent(
      oldSubject.agentId,
      "Old",
      "external",
      "old-owner"
    );
    await store.updateSettings(oldSubject.agentId, { identityMd: "old identity" });
    const originalGetSettings = store.getSettings.bind(store);
    let reportReadStarted!: () => void;
    let releaseRead!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      reportReadStarted = resolve;
    });
    const readReleased = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let delayFirstRead = true;
    store.getSettings = async (agentId) => {
      const snapshot = await originalGetSettings(agentId);
      if (agentId === oldSubject.agentId && delayFirstRead) {
        delayFirstRead = false;
        reportReadStarted();
        await readReleased;
      }
      return snapshot;
    };

    const staleRead = mutations.readAppliedState(oldSubject);
    await readStarted;
    const deletion = metadata.deleteAgent(oldSubject.agentId);
    await Promise.resolve();
    expect(await originalGetSettings(oldSubject.agentId)).not.toBeNull();
    releaseRead();
    const oldState = await staleRead;
    await deletion;

    expect(await originalGetSettings(oldSubject.agentId)).toBeNull();
    await metadata.createAgent(
      recreatedSubject.agentId,
      "Recreated",
      "external",
      "new-owner"
    );
    const recreatedState = await mutations.readAppliedState(recreatedSubject);
    expect(recreatedState?.configurationRevision).toBe("0");
    expect(recreatedState?.settingsDigest).not.toBe(oldState?.settingsDigest);
    expect((mutations as any).agentLifecycleQueues.size).toBe(0);
  });

  test("uses the host-provided secret store for persisted auth profiles", async () => {
    ensureEncryptionKey();
    await resetTestDatabase();
    const hostStore = new InMemoryWritableStore();
    const hostRegistry = new SecretStoreRegistry(hostStore, {
      host: hostStore,
    });
    const coreServices = new CoreServices(createGatewayConfig(), {
      secretStore: hostRegistry,
      stateAdapter: new InMemoryStateAdapter(),
      agentConfigurationMutationPort: {
        readAppliedState: async () => null,
        updateNativeConfiguration: async () => {
          throw new Error("not used by this test");
        },
      },
      configStore: {
        // Minimal stub — sessionServices only checks for presence.
        getSettings: async () => null,
        saveSettings: async () => {},
        updateSettings: async () => {},
        deleteSettings: async () => {},
        hasSettings: async () => false,
        getMetadata: async () => null,
        saveMetadata: async () => {},
        updateMetadata: async () => {},
        deleteMetadata: async () => {},
        hasAgent: async () => false,
        listAgents: async () => [],
      } as any,
      connectionStore: {
        getConnection: async () => null,
        listConnections: async () => [],
        saveConnection: async () => {},
        updateConnection: async () => {},
        deleteConnection: async () => {},
        getChannelBinding: async () => null,
        createChannelBinding: async () => {},
        deleteChannelBinding: async () => {},
        listChannelBindings: async () => [],
        deleteAllChannelBindings: async () => 0,
      } as any,
      accessStore: {
        grant: async () => {},
        hasGrant: async () => true,
        isDenied: async () => false,
        listGrants: async () => [],
        revokeGrant: async () => {},
        addUserAgent: async () => {},
        removeUserAgent: async () => {},
        listUserAgents: async () => [],
        ownsAgent: async () => true,
      } as any,
    });
    (coreServices as any).queue = new MockMessageQueue();

    await (coreServices as any).initializeSessionServices();
    await (coreServices as any).initializeClaudeServices();

    const authProfilesManager = coreServices.getAuthProfilesManager();
    expect(authProfilesManager).toBeDefined();
    await authProfilesManager!.upsertProfile({
      agentId: "agent-1",
      userId: "user-1",
      provider: "openai",
      credential: "sk-host-store-only",
      label: "host-backed",
      authType: "api-key",
    });

    const hostEntries = await hostStore.list(
      "users/user-1/agents/agent-1/auth-profiles/"
    );
    expect(hostEntries).toHaveLength(1);
    expect(await hostStore.get(hostEntries[0]!.ref)).toBe("sk-host-store-only");
  });
});
