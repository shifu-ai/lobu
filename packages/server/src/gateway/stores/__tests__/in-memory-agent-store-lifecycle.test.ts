import { expect, test } from "bun:test";
import {
  InMemoryAgentAggregateNotFoundError,
  InMemoryAgentStore,
} from "../in-memory-agent-store.js";
import {
  EmbeddedInMemoryAgentConfigurationMutationAdapter,
} from "../../auth/agent-configuration-mutation-port.js";

function metadata(agentId: string) {
  return {
    agentId,
    name: agentId,
    owner: { platform: "test", userId: `${agentId}-owner` },
    createdAt: 1,
  };
}

function connection(id: string, agentId: string) {
  return {
    id,
    platform: "slack",
    agentId,
    config: {},
    settings: {},
    metadata: {},
    status: "active" as const,
    createdAt: 1,
    updatedAt: 1,
  };
}

test("aggregate deletion rejects orphan child writes and preserves reassignment", async () => {
  const store = new InMemoryAgentStore();
  const deletingAgentId = "deleting-agent";
  const survivingAgentId = "surviving-agent";
  await store.saveMetadata(deletingAgentId, metadata(deletingAgentId));
  await store.saveMetadata(survivingAgentId, metadata(survivingAgentId));
  await store.saveConnection(
    connection("reassigned-connection", deletingAgentId)
  );
  await store.createChannelBinding({
    agentId: deletingAgentId,
    platform: "slack",
    channelId: "reassigned-channel",
    createdAt: 1,
  });

  const deletion = store.deleteMetadata(deletingAgentId);
  const reassignment = Promise.all([
    store.saveConnection(connection("reassigned-connection", survivingAgentId)),
    store.createChannelBinding({
      agentId: survivingAgentId,
      platform: "slack",
      channelId: "reassigned-channel",
      createdAt: 2,
    }),
  ]);
  const writesToDeletingAgent = await Promise.allSettled([
    store.saveConnection(connection("orphan-connection", deletingAgentId)),
    store.createChannelBinding({
      agentId: deletingAgentId,
      platform: "discord",
      channelId: "orphan-channel",
      createdAt: 2,
    }),
    store.grant(deletingAgentId, "/mcp/test/tools/*", null),
    store.addUserAgent("test", "late-owner", deletingAgentId),
    store.updateSettings(deletingAgentId, {
      authProfiles: [
        {
          id: "late-credential",
          provider: "test",
          credential: "late-secret",
          authType: "api-key",
          label: "late",
          model: "*",
          createdAt: 2,
        },
      ],
    }),
  ]);
  await Promise.all([deletion, reassignment]);

  expect(writesToDeletingAgent.map((result) => result.status)).toEqual([
    "rejected",
    "rejected",
    "rejected",
    "rejected",
    "rejected",
  ]);
  for (const result of writesToDeletingAgent) {
    expect(result.status === "rejected" ? result.reason : null).toBeInstanceOf(
      InMemoryAgentAggregateNotFoundError
    );
  }
  expect(await store.getSettings(deletingAgentId)).toBeNull();
  expect(await store.getConnection("orphan-connection")).toBeNull();
  expect(await store.listChannelBindings(deletingAgentId)).toEqual([]);
  expect(await store.listGrants(deletingAgentId)).toEqual([]);
  expect(await store.listUserAgents("test", "late-owner")).toEqual([]);

  expect(await store.getConnection("reassigned-connection")).toMatchObject({
    agentId: survivingAgentId,
  });
  expect(
    await store.getChannelBinding("slack", "reassigned-channel")
  ).toMatchObject({
    agentId: survivingAgentId,
  });
});

test("settings update started in an old incarnation cannot write into recreation", async () => {
  let delayNextRead = false;
  let reportReadStarted!: () => void;
  let releaseRead!: () => void;
  const readStarted = new Promise<void>((resolve) => {
    reportReadStarted = resolve;
  });
  const readReleased = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  class DelayedSettingsReadStore extends InMemoryAgentStore {
    protected override async readSettings(agentId: string) {
      const snapshot = await super.readSettings(agentId);
      if (delayNextRead) {
        delayNextRead = false;
        reportReadStarted();
        await readReleased;
      }
      return snapshot;
    }
  }

  const store = new DelayedSettingsReadStore();
  const agentId = "settings-incarnation-agent";
  await store.saveMetadata(agentId, metadata(agentId));
  await store.updateSettings(agentId, { identityMd: "old identity" });
  delayNextRead = true;
  const staleUpdate = store.updateSettings(agentId, {
    identityMd: "stale write",
  });
  await readStarted;

  await store.deleteMetadata(agentId);
  await store.saveMetadata(agentId, {
    ...metadata(agentId),
    name: "recreated settings agent",
    createdAt: 2,
  });
  releaseRead();

  await expect(staleUpdate).rejects.toMatchObject({
    code: "embedded_agent_incarnation_mismatch",
  });
  expect((await store.getSettings(agentId))?.identityMd).toBeUndefined();
});

test("connection update started in an old incarnation cannot write into recreation", async () => {
  let delayNextRead = false;
  let reportReadStarted!: () => void;
  let releaseRead!: () => void;
  const readStarted = new Promise<void>((resolve) => {
    reportReadStarted = resolve;
  });
  const readReleased = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  class DelayedConnectionReadStore extends InMemoryAgentStore {
    protected override async readConnection(connectionId: string) {
      const snapshot = await super.readConnection(connectionId);
      if (delayNextRead) {
        delayNextRead = false;
        reportReadStarted();
        await readReleased;
      }
      return snapshot;
    }
  }

  const store = new DelayedConnectionReadStore();
  const agentId = "connection-incarnation-agent";
  await store.saveMetadata(agentId, metadata(agentId));
  await store.saveConnection(connection("stale-connection", agentId));
  delayNextRead = true;
  const staleUpdate = store.updateConnection("stale-connection", {
    config: { stale: true },
  });
  await readStarted;

  await store.deleteMetadata(agentId);
  await store.saveMetadata(agentId, {
    ...metadata(agentId),
    name: "recreated connection agent",
    createdAt: 2,
  });
  await store.saveConnection({
    ...connection("stale-connection", agentId),
    config: { fresh: true },
    createdAt: 2,
    updatedAt: 2,
  });
  releaseRead();

  await expect(staleUpdate).rejects.toMatchObject({
    code: "embedded_agent_incarnation_mismatch",
  });
  expect(await store.getConnection("stale-connection")).toMatchObject({
    agentId,
    config: { fresh: true },
  });
});

test("connection reassignment cannot attach to a recreated destination", async () => {
  let delayNextRead = false;
  let reportReadStarted!: () => void;
  let releaseRead!: () => void;
  const readStarted = new Promise<void>((resolve) => {
    reportReadStarted = resolve;
  });
  const readReleased = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  class DelayedReassignmentStore extends InMemoryAgentStore {
    protected override async readConnection(connectionId: string) {
      const snapshot = await super.readConnection(connectionId);
      if (delayNextRead) {
        delayNextRead = false;
        reportReadStarted();
        await readReleased;
      }
      return snapshot;
    }
  }

  const store = new DelayedReassignmentStore();
  const sourceAgentId = "reassignment-source-agent";
  const destinationAgentId = "reassignment-destination-agent";
  await store.saveMetadata(sourceAgentId, metadata(sourceAgentId));
  await store.saveMetadata(destinationAgentId, metadata(destinationAgentId));
  await store.saveConnection(
    connection("delayed-reassignment", sourceAgentId)
  );
  delayNextRead = true;
  const staleReassignment = store.updateConnection("delayed-reassignment", {
    agentId: destinationAgentId,
  });
  await readStarted;

  await store.deleteMetadata(destinationAgentId);
  await store.saveMetadata(destinationAgentId, {
    ...metadata(destinationAgentId),
    name: "recreated destination",
    createdAt: 2,
  });
  releaseRead();

  await expect(staleReassignment).rejects.toMatchObject({
    code: "embedded_agent_incarnation_mismatch",
  });
  expect(await store.getConnection("delayed-reassignment")).toMatchObject({
    agentId: sourceAgentId,
  });
  expect(
    await store.listConnections({ agentId: destinationAgentId })
  ).toEqual([]);
});

test("connection reassignment rejects a missing destination before reading", async () => {
  let connectionReads = 0;
  class ObservedConnectionReadStore extends InMemoryAgentStore {
    protected override async readConnection(connectionId: string) {
      connectionReads += 1;
      return super.readConnection(connectionId);
    }
  }

  const store = new ObservedConnectionReadStore();
  const sourceAgentId = "missing-target-source-agent";
  await store.saveMetadata(sourceAgentId, metadata(sourceAgentId));
  await store.saveConnection(connection("missing-target", sourceAgentId));

  await expect(
    store.updateConnection("missing-target", {
      agentId: "absent-destination-agent",
    })
  ).rejects.toMatchObject({
    code: "embedded_agent_aggregate_not_found",
  });
  expect(connectionReads).toBe(0);
  expect(await store.getConnection("missing-target")).toMatchObject({
    agentId: sourceAgentId,
  });
});

test("adapter deletion invoked before direct creation preserves the recreation", async () => {
  const store = new InMemoryAgentStore();
  const agentId = "delete-first-recreation-agent";
  await store.saveMetadata(agentId, metadata(agentId));
  const adapter = new EmbeddedInMemoryAgentConfigurationMutationAdapter(store);

  const deletion = adapter.deleteAgent(agentId, () =>
    store.deleteMetadata(agentId)
  );
  const recreation = store.saveMetadata(agentId, {
    ...metadata(agentId),
    name: "new incarnation",
    createdAt: 2,
  });
  await Promise.all([deletion, recreation]);

  expect(await store.getMetadata(agentId)).toMatchObject({
    name: "new incarnation",
    createdAt: 2,
  });
  expect(await store.getSettings(agentId)).not.toBeNull();
});
