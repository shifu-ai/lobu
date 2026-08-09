import { expect, test } from "bun:test";
import {
  InMemoryAgentAggregateNotFoundError,
  InMemoryAgentStore,
} from "../in-memory-agent-store.js";

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
