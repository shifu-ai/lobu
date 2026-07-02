process.env.ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { describe, expect, test } from "bun:test";
import {
  __resetEncryptionKeyCacheForTests,
  type MessagePayload,
  verifyWorkerToken,
} from "@lobu/core";
import { mintRunJobToken } from "../orchestration/message-consumer.js";

describe("mintRunJobToken", () => {
  test("preserves connectionId from platform metadata", () => {
    __resetEncryptionKeyCacheForTests();
    const token = mintRunJobToken(
      {
        userId: "user-1",
        agentId: "agent-1",
        organizationId: "org-1",
        platform: "line",
        channelId: "line-user-1",
        conversationId: "conv-1",
        messageId: "msg-1",
        messageText: "hello",
        platformMetadata: {
          connectionId: "line-connection-1",
          teamId: "team-from-metadata",
        },
        runId: 123,
      } as MessagePayload,
      "conv-1",
      "deploy-1"
    );

    expect(token).toBeDefined();
    const decoded = verifyWorkerToken(token!);
    expect(decoded?.connectionId).toBe("line-connection-1");
    expect(decoded?.teamId).toBe("team-from-metadata");
    expect(decoded?.runId).toBe(123);
    expect(decoded?.messageId).toBe("msg-1");
    expect(decoded?.processedMessageIds).toEqual(["msg-1"]);
    expect(decoded?.tokenKind).toBe("run");
  });

  test("does not mint a token for legacy payloads without runId", () => {
    const token = mintRunJobToken(
      {
        userId: "user-1",
        agentId: "agent-1",
        platform: "line",
        channelId: "line-user-1",
        conversationId: "conv-1",
        messageId: "msg-1",
        messageText: "hello",
        platformMetadata: { connectionId: "line-connection-1" },
      } as MessagePayload,
      "conv-1",
      "deploy-1"
    );

    expect(token).toBeUndefined();
  });

  test("defaults connectionId to the conversationId for api-platform payloads", () => {
    __resetEncryptionKeyCacheForTests();
    const token = mintRunJobToken(
      {
        userId: "user-1",
        agentId: "agent-1",
        organizationId: "org-1",
        platform: "api",
        channelId: "api_user-1",
        conversationId: "conv-api-1",
        messageId: "msg-1",
        messageText: "hello",
        runId: 7,
      } as MessagePayload,
      "conv-api-1",
      "deploy-1"
    );

    expect(token).toBeDefined();
    const decoded = verifyWorkerToken(token!);
    expect(decoded?.connectionId).toBe("conv-api-1");
  });

  test("does not default connectionId for non-api platforms", () => {
    __resetEncryptionKeyCacheForTests();
    const token = mintRunJobToken(
      {
        userId: "user-1",
        agentId: "agent-1",
        organizationId: "org-1",
        platform: "slack",
        channelId: "channel-1",
        conversationId: "conv-slack-1",
        messageId: "msg-1",
        messageText: "hello",
        runId: 8,
      } as MessagePayload,
      "conv-slack-1",
      "deploy-1"
    );

    expect(token).toBeDefined();
    const decoded = verifyWorkerToken(token!);
    expect(decoded?.connectionId).toBeUndefined();
  });

  test("api-platform payloads still honor an explicit platformMetadata connectionId", () => {
    __resetEncryptionKeyCacheForTests();
    const token = mintRunJobToken(
      {
        userId: "user-1",
        agentId: "agent-1",
        organizationId: "org-1",
        platform: "api",
        channelId: "api_user-1",
        conversationId: "conv-api-2",
        messageId: "msg-1",
        messageText: "hello",
        platformMetadata: { connectionId: "explicit-conn" },
        runId: 9,
      } as MessagePayload,
      "conv-api-2",
      "deploy-1"
    );

    expect(token).toBeDefined();
    const decoded = verifyWorkerToken(token!);
    expect(decoded?.connectionId).toBe("explicit-conn");
  });
});
