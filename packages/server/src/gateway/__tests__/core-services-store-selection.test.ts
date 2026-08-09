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

    await metadata.createAgent(
      embeddedSubject.agentId,
      "Embedded Lifecycle",
      "external",
      "owner-1"
    );
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
